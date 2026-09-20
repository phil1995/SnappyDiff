use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use futures::{StreamExt, TryStreamExt, stream};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use tokio::time::sleep;
use tokio_util::io::ReaderStream;

mod git;
mod images;
use git::CommitObservation;
use images::{export_xcresult_attachments, scan};

include!(concat!(env!("OUT_DIR"), "/limits.rs"));

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[arg(long, env = "SNAPPYDIFF_ENDPOINT")]
    endpoint: Option<String>,
    #[arg(long, default_value = ".snappydiff.json", global = true)]
    config: PathBuf,
    #[arg(long, env = "SNAPPYDIFF_TOKEN", hide_env_values = true, global = true)]
    token: Option<String>,
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Login,
    Upload(Box<UploadArgs>),
}

#[derive(Args)]
struct UploadArgs {
    #[arg(default_value = ".")]
    directory: PathBuf,
    /// Find PNGs only below Point-Free-style __Snapshots__ directories.
    #[arg(long)]
    discover: bool,
    /// Overlay newly rendered failure images written through SNAPSHOT_ARTIFACTS.
    #[arg(long, env = "SNAPSHOT_ARTIFACTS", value_delimiter = ',')]
    artifacts: Vec<PathBuf>,
    /// Read matching PNG attachments from an Xcode result bundle.
    #[arg(long)]
    xcresult: Option<PathBuf>,
    #[arg(long, env = "SNAPPYDIFF_REPOSITORY")]
    repository: Option<String>,
    #[arg(long, env = "SNAPPYDIFF_DEFAULT_BRANCH")]
    default_branch: Option<String>,
    #[arg(long, env = "GITHUB_RUN_ID")]
    provider_run_id: Option<String>,
    #[arg(long, env = "GITHUB_RUN_ATTEMPT", default_value_t = 1)]
    attempt: u32,
    #[arg(long, env = "GITHUB_SHA")]
    commit: String,
    #[arg(long, env = "GITHUB_REF_NAME")]
    branch: String,
    #[arg(long)]
    run_key: Option<String>,
    #[arg(long, default_value = "default")]
    shard: String,
    #[arg(long = "expected-shard")]
    expected_shards: Vec<String>,
    #[arg(long)]
    merge_base: Option<String>,
    #[arg(long)]
    default_head: Option<String>,
    #[arg(long)]
    pull_request: Option<u64>,
    #[arg(long)]
    pull_request_head: Option<String>,
    #[arg(long = "parent")]
    parents: Vec<String>,
    #[arg(long)]
    graph_incomplete: bool,
    #[arg(long)]
    fork: bool,
    #[arg(long)]
    allow_empty: bool,
    #[arg(long)]
    concurrency: Option<usize>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileConfig {
    endpoint: Option<String>,
    repository: Option<String>,
    default_branch: Option<String>,
    upload_concurrency: Option<usize>,
    oidc_audience: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OidcExchange {
    token: String,
    project_id: String,
    trust_class: String,
    run_constraints: OidcRunConstraints,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceExchange {
    token: String,
    project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OidcRunConstraints {
    provider_run_id: String,
    attempt_number: u32,
    commit_sha: String,
    branch: String,
    pull_request_number: Option<u64>,
    pull_request_head_sha: Option<String>,
}

#[derive(Clone)]
struct Api {
    client: Client,
    endpoint: String,
    token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    name: String,
    sha256: String,
    byte_size: u64,
    width: u32,
    height: u32,
    #[serde(skip)]
    path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunIdentity {
    provider: &'static str,
    provider_run_id: String,
    attempt_number: u32,
    run_key: String,
    commit_sha: String,
    branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    merge_base_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    observed_default_head_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pull_request_number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pull_request_head_sha: Option<String>,
    expected_shards: Vec<String>,
    trust_class: &'static str,
    parent_shas: Vec<String>,
    graph_complete: bool,
    commit_graph: Vec<CommitObservation>,
}

#[derive(Deserialize)]
struct RegisterResponse {
    run: ResourceId,
    shard: ResourceId,
}

#[derive(Deserialize)]
struct ResourceId {
    id: String,
    #[serde(default)]
    state: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadPage {
    uploads: Vec<UploadSession>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadSession {
    id: String,
    sha256: String,
    state: String,
    target: Option<UploadTarget>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadTarget {
    url: String,
    method: String,
    headers: HashMap<String, String>,
}

#[derive(Deserialize, Serialize)]
struct StatusResponse {
    run: serde_json::Value,
    shards: Vec<serde_json::Value>,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let json_output = cli.json;
    if let Err(error) = run(cli).await {
        if json_output {
            eprintln!(
                "{}",
                serde_json::json!({ "error": { "code": "cli_error", "message": error.to_string() } })
            );
        } else {
            eprintln!("error: {error:#}");
        }
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<()> {
    let file_config = load_config(&cli.config)?;
    if matches!(cli.command, Command::Login) {
        bail!(
            "interactive WorkOS device authorization is disabled until the provider validation gate is completed; use a scoped SNAPPYDIFF_TOKEN for CI"
        );
    }
    let endpoint = cli
        .endpoint
        .or(file_config.endpoint)
        .unwrap_or_else(|| "http://localhost:8787".to_owned());
    let client = Client::builder().timeout(Duration::from_secs(60)).build()?;
    match cli.command {
        Command::Upload(args) => {
            let mut args = *args;
            args.repository = args.repository.or(file_config.repository);
            args.default_branch = args.default_branch.or(file_config.default_branch);
            args.concurrency = args.concurrency.or(file_config.upload_concurrency);
            let (token, project) = if let Some(token) = cli.token {
                let repository =
                    git::discover_repository(&args.directory, args.repository.as_deref())?;
                let default_branch = args
                    .default_branch
                    .clone()
                    .or_else(|| git::discover_default_branch(&args.directory));
                let exchange = workspace_token(
                    &client,
                    &endpoint,
                    &token,
                    &repository,
                    default_branch.as_deref(),
                )
                .await?;
                (exchange.token, exchange.project_id)
            } else {
                let exchange = github_oidc_token(
                    &client,
                    &endpoint,
                    args.pull_request,
                    file_config.oidc_audience.as_deref(),
                )
                .await?;
                args.fork = exchange.trust_class == "fork_isolated";
                args.provider_run_id = Some(exchange.run_constraints.provider_run_id);
                args.attempt = exchange.run_constraints.attempt_number;
                args.commit = exchange.run_constraints.commit_sha;
                args.branch = exchange.run_constraints.branch;
                args.pull_request = exchange.run_constraints.pull_request_number;
                args.pull_request_head = exchange.run_constraints.pull_request_head_sha;
                (exchange.token, exchange.project_id)
            };
            if !token.starts_with("sd_") {
                bail!("machine credential has an invalid format");
            }
            let api = Api {
                client,
                endpoint: endpoint.trim_end_matches('/').to_owned(),
                token,
            };
            upload(&api, args, &project, cli.json).await
        }
        Command::Login => unreachable!(),
    }
}

async fn github_oidc_token(
    client: &Client,
    endpoint: &str,
    pull_request: Option<u64>,
    configured_audience: Option<&str>,
) -> Result<OidcExchange> {
    let request_url = std::env::var("ACTIONS_ID_TOKEN_REQUEST_URL")
        .context("SNAPPYDIFF_TOKEN is unset and GitHub OIDC is unavailable")?;
    let request_token = std::env::var("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
        .context("GitHub OIDC request token is missing")?;
    let audience = std::env::var("SNAPPYDIFF_OIDC_AUDIENCE")
        .ok()
        .or_else(|| configured_audience.map(ToOwned::to_owned))
        .unwrap_or_else(|| "snappydiff".to_owned());
    let response = client
        .get(request_url)
        .bearer_auth(request_token)
        .query(&[("audience", audience)])
        .send()
        .await?;
    if !response.status().is_success() {
        bail!(
            "GitHub OIDC token request failed with {}",
            response.status()
        );
    }
    let oidc = response
        .json::<serde_json::Value>()
        .await?
        .get("value")
        .and_then(|value| value.as_str())
        .context("GitHub OIDC response omitted token")?
        .to_owned();
    let response = client
        .post(format!(
            "{}/api/v1/auth/github-oidc/exchange",
            endpoint.trim_end_matches('/')
        ))
        .bearer_auth(oidc)
        .json(&serde_json::json!({ "pullRequestNumber": pull_request }))
        .send()
        .await?;
    let status = response.status();
    let bytes = response.bytes().await?;
    if !status.is_success() {
        bail!(
            "SnappyDiff OIDC exchange failed with {status}: {}",
            String::from_utf8_lossy(&bytes)
        );
    }
    serde_json::from_slice(&bytes).context("SnappyDiff returned an invalid OIDC exchange response")
}

async fn workspace_token(
    client: &Client,
    endpoint: &str,
    token: &str,
    repository: &str,
    default_branch: Option<&str>,
) -> Result<WorkspaceExchange> {
    let (repository_owner, repository_name) = repository
        .split_once('/')
        .context("repository must use owner/name format")?;
    let mut body = serde_json::json!({
        "repositoryOwner": repository_owner,
        "repositoryName": repository_name,
    });
    if let Some(default_branch) = default_branch {
        body["defaultBranch"] = serde_json::Value::String(default_branch.to_owned());
    }
    let response = client
        .post(format!(
            "{}/api/v1/auth/workspace/exchange",
            endpoint.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let bytes = response.bytes().await?;
    if !status.is_success() {
        bail!(
            "SnappyDiff workspace exchange failed with {status}: {}",
            String::from_utf8_lossy(&bytes)
        );
    }
    serde_json::from_slice(&bytes)
        .context("SnappyDiff returned an invalid workspace exchange response")
}

async fn upload(api: &Api, args: UploadArgs, project: &str, json_output: bool) -> Result<()> {
    let concurrency = args.concurrency.unwrap_or(4);
    if concurrency == 0 || concurrency > 32 {
        bail!("concurrency must be between 1 and 32");
    }
    let exported_attachments = args
        .xcresult
        .as_deref()
        .map(export_xcresult_attachments)
        .transpose()?;
    let entries = scan(
        &args.directory,
        args.discover,
        &args.artifacts,
        exported_attachments.as_ref(),
    )
    .await?;
    if entries.is_empty() && !args.allow_empty {
        bail!("no PNG screenshots found; pass --allow-empty only for an intentional full removal");
    }
    let provider_run_id = args
        .provider_run_id
        .unwrap_or_else(|| format!("manual-{}", epoch_millis()));
    let expected_shards = if args.expected_shards.is_empty() {
        vec![args.shard.clone()]
    } else {
        args.expected_shards.clone()
    };
    git::deepen_shallow_checkout(&args.directory)?;
    let default_head = args
        .default_head
        .or_else(|| git::discover_base_head(&args.directory));
    let merge_base = match args.merge_base {
        Some(value) => Some(value),
        None => default_head
            .as_deref()
            .and_then(|base| git::value(&args.directory, &["merge-base", &args.commit, base])),
    };
    if args.pull_request.is_some() && merge_base.is_none() {
        bail!(
            "pull request merge base is unavailable; fetch the base branch history or pass --merge-base"
        );
    }
    let explicit_parents = !args.parents.is_empty();
    let discovered_parents = if explicit_parents {
        None
    } else {
        git::parents(&args.directory, &args.commit)
    };
    let parent_shas = discovered_parents.clone().unwrap_or(args.parents);
    let graph_complete = !args.graph_incomplete
        && (explicit_parents || discovered_parents.is_some())
        && !git::shallow_commits(&args.directory).contains(&args.commit);
    let commit_graph = git::graph(&args.directory, &args.commit, merge_base.as_deref())?;
    let identity = RunIdentity {
        provider: if std::env::var_os("GITHUB_ACTIONS").is_some() {
            "github_actions"
        } else {
            "manual"
        },
        run_key: args.run_key.unwrap_or_else(|| provider_run_id.clone()),
        provider_run_id,
        attempt_number: args.attempt,
        commit_sha: args.commit,
        branch: args.branch,
        merge_base_sha: merge_base,
        observed_default_head_sha: default_head,
        pull_request_number: args.pull_request,
        pull_request_head_sha: args.pull_request_head,
        expected_shards,
        trust_class: if args.fork {
            "fork_isolated"
        } else {
            "first_party"
        },
        parent_shas,
        graph_complete,
        commit_graph,
    };
    let registration: RegisterResponse = api
        .post(
            &format!("/api/v1/projects/{project}/runs"),
            &serde_json::json!({
                "identity": identity, "shardId": args.shard, "allowEmpty": args.allow_empty,
            }),
        )
        .await?;
    let total_pages = entries.len().div_ceil(PAGE_ENTRIES).max(1);
    if registration.shard.state.as_deref() == Some("open") {
        for (page, chunk) in entries.chunks(PAGE_ENTRIES).enumerate() {
            let digest = hex::encode(Sha256::digest(serde_json::to_vec(chunk)?));
            let _: serde_json::Value = api.post(
                &format!("/api/v1/runs/{}/shards/{}/manifest-pages", registration.run.id, registration.shard.id),
                &serde_json::json!({ "page": page, "totalPages": total_pages, "idempotencyKey": format!("page-{page}-{digest}"), "entries": chunk }),
            ).await?;
        }
        if entries.is_empty() {
            let _: serde_json::Value = api.post(
                &format!("/api/v1/runs/{}/shards/{}/manifest-pages", registration.run.id, registration.shard.id),
                &serde_json::json!({ "page": 0, "totalPages": 1, "idempotencyKey": "empty-page", "entries": [] }),
            ).await?;
        }
        let _: serde_json::Value = api
            .post_empty(&format!(
                "/api/v1/runs/{}/shards/{}/finalize",
                registration.run.id, registration.shard.id
            ))
            .await?;
    }
    let paths: Arc<HashMap<String, PathBuf>> = Arc::new(
        entries
            .iter()
            .map(|entry| (entry.sha256.clone(), entry.path.clone()))
            .collect(),
    );
    let mut after: Option<String> = None;
    loop {
        let suffix = after
            .as_ref()
            .map(|cursor| format!("?after={cursor}"))
            .unwrap_or_default();
        let page: UploadPage = api
            .get(&format!(
                "/api/v1/runs/{}/shards/{}/uploads{suffix}",
                registration.run.id, registration.shard.id
            ))
            .await?;
        let api_copy = api.clone();
        let paths_copy = paths.clone();
        stream::iter(
            page.uploads
                .into_iter()
                .filter(|upload| matches!(upload.state.as_str(), "pending" | "uploaded")),
        )
        .map(Ok::<_, anyhow::Error>)
        .try_for_each_concurrent(concurrency, move |upload| {
            let api = api_copy.clone();
            let paths = paths_copy.clone();
            async move {
                let target = upload.target.context("server omitted upload target")?;
                let path = paths
                    .get(&upload.sha256)
                    .context("server requested an unknown hash")?;
                api.upload_file(&target, path).await?;
                let _: serde_json::Value = api
                    .post_empty(&format!("/api/v1/upload-sessions/{}/complete", upload.id))
                    .await?;
                Ok(())
            }
        })
        .await?;
        after = page.next_cursor;
        if after.is_none() {
            break;
        }
    }
    let mut status: StatusResponse;
    for _ in 0..120 {
        status = api
            .get(&format!("/api/v1/runs/{}", registration.run.id))
            .await?;
        let state = status
            .run
            .get("state")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        if matches!(state, "complete" | "failed" | "canceled" | "timed_out") {
            print_value(json_output, &status)?;
            if state == "complete" {
                return Ok(());
            }
            bail!("run ended with state {state}");
        }
        sleep(Duration::from_secs(1)).await;
    }
    bail!(
        "run verification is still pending; inspect it at {}/runs/{}",
        api.endpoint,
        registration.run.id
    )
}

impl Api {
    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<T> {
        for attempt in 0..4 {
            let mut request = self
                .client
                .request(method.clone(), format!("{}{path}", self.endpoint))
                .bearer_auth(&self.token);
            if let Some(body) = body {
                request = request.json(body);
            }
            match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    let bytes = response.bytes().await?;
                    if status.is_success() {
                        return serde_json::from_slice(&bytes)
                            .context("SnappyDiff returned an invalid response");
                    }
                    if attempt < 3
                        && (status.as_u16() == 408
                            || status.as_u16() == 429
                            || status.is_server_error())
                    {
                        sleep(Duration::from_millis(250 * (1 << attempt))).await;
                        continue;
                    }
                    bail!(
                        "SnappyDiff returned {status}: {}",
                        String::from_utf8_lossy(&bytes)
                    );
                }
                Err(error) if attempt < 3 && (error.is_timeout() || error.is_connect()) => {
                    sleep(Duration::from_millis(250 * (1 << attempt))).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
        unreachable!()
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.request(Method::GET, path, None).await
    }
    async fn post<T: DeserializeOwned>(&self, path: &str, body: &serde_json::Value) -> Result<T> {
        self.request(Method::POST, path, Some(body)).await
    }
    async fn post_empty<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.request(Method::POST, path, Some(&serde_json::json!({})))
            .await
    }

    async fn upload_file(&self, target: &UploadTarget, path: &Path) -> Result<()> {
        if !target.method.eq_ignore_ascii_case("PUT") {
            bail!("server requested unsupported upload method");
        }
        for attempt in 0..4 {
            let file = tokio::fs::File::open(path).await?;
            let stream = ReaderStream::new(file);
            let mut request = self
                .client
                .put(&target.url)
                .body(reqwest::Body::wrap_stream(stream));
            for (name, value) in &target.headers {
                request = request.header(name, value);
            }
            match request.send().await {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) if attempt < 3 && response.status().is_server_error() => {}
                Ok(response) => bail!("image upload failed with {}", response.status()),
                Err(error) if attempt < 3 && (error.is_timeout() || error.is_connect()) => {}
                Err(error) => return Err(error.into()),
            }
            sleep(Duration::from_millis(250 * (1 << attempt))).await;
        }
        unreachable!()
    }
}

fn print_value<T: Serialize>(json_output: bool, value: &T) -> Result<()> {
    if json_output {
        println!("{}", serde_json::to_string(value)?);
    } else {
        println!("{}", serde_json::to_string_pretty(value)?);
    }
    Ok(())
}

fn epoch_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn load_config(path: &Path) -> Result<FileConfig> {
    if !path.exists() {
        return Ok(FileConfig::default());
    }
    let contents =
        std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    serde_json::from_str(&contents)
        .with_context(|| format!("invalid configuration in {}", path.display()))
}
