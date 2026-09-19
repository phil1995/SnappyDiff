use std::{
    collections::{HashMap, HashSet},
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
use tokio::{io::AsyncReadExt, time::sleep};
use tokio_util::io::ReaderStream;
use walkdir::WalkDir;

const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_AXIS: u32 = 16_384;
const MAX_PIXELS: u64 = 40_000_000;
const MAX_SCREENSHOTS: usize = 10_000;
const MAX_RUN_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const PAGE_ENTRIES: usize = 100;

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
    merge_base_sha: Option<String>,
    observed_default_head_sha: Option<String>,
    pull_request_number: Option<u64>,
    pull_request_head_sha: Option<String>,
    expected_shards: Vec<String>,
    trust_class: &'static str,
    parent_shas: Vec<String>,
    graph_complete: bool,
    commit_graph: Vec<CommitObservation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitObservation {
    sha: String,
    parent_shas: Vec<String>,
    complete: bool,
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
                let repository = discover_repository(&args.directory, args.repository.as_deref())?;
                let default_branch = args
                    .default_branch
                    .clone()
                    .or_else(|| discover_default_branch(&args.directory));
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

fn discover_repository(directory: &Path, configured: Option<&str>) -> Result<String> {
    if let Some(repository) = configured {
        return normalize_repository(repository);
    }
    if let Ok(repository) = std::env::var("GITHUB_REPOSITORY") {
        return normalize_repository(&repository);
    }
    let remote = git_value(directory, &["remote", "get-url", "origin"])
        .context("repository could not be detected; set SNAPPYDIFF_REPOSITORY explicitly")?;
    let path = remote
        .strip_prefix("git@github.com:")
        .or_else(|| remote.strip_prefix("https://github.com/"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))
        .unwrap_or(&remote);
    normalize_repository(path.trim_end_matches(".git"))
}

fn normalize_repository(value: &str) -> Result<String> {
    let trimmed = value.trim().trim_matches('/');
    let mut parts = trimmed.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if owner.is_empty()
        || name.is_empty()
        || parts.next().is_some()
        || !owner
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || "_.-".contains(value))
        || !name
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || "_.-".contains(value))
    {
        bail!("repository must use owner/name format");
    }
    Ok(format!("{owner}/{name}"))
}

fn discover_default_branch(directory: &Path) -> Option<String> {
    if let Ok(event_path) = std::env::var("GITHUB_EVENT_PATH") {
        if let Ok(contents) = std::fs::read_to_string(event_path) {
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&contents) {
                if let Some(branch) = event
                    .pointer("/repository/default_branch")
                    .and_then(|value| value.as_str())
                {
                    if !branch.is_empty() {
                        return Some(branch.to_owned());
                    }
                }
            }
        }
    }
    git_value(
        directory,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .and_then(|reference| reference.strip_prefix("origin/").map(ToOwned::to_owned))
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
    deepen_shallow_checkout(&args.directory)?;
    let default_head = args
        .default_head
        .or_else(|| discover_base_head(&args.directory));
    let merge_base = match args.merge_base {
        Some(value) => Some(value),
        None => default_head
            .as_deref()
            .and_then(|base| git_value(&args.directory, &["merge-base", &args.commit, base])),
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
        git_parents(&args.directory, &args.commit)
    };
    let parent_shas = discovered_parents.clone().unwrap_or(args.parents);
    let graph_complete = !args.graph_incomplete
        && (explicit_parents || discovered_parents.is_some())
        && !shallow_commits(&args.directory).contains(&args.commit);
    let commit_graph = git_graph(&args.directory, &args.commit, merge_base.as_deref())?;
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
        "run verification is still pending; inspect it with `snappydiff status {}`",
        registration.run.id
    )
}

#[derive(Debug, Clone)]
struct CollectedPng {
    name: String,
    path: PathBuf,
}

struct XcresultExport {
    directory: tempfile::TempDir,
    tests: Vec<XcresultTestAttachments>,
}

#[derive(Deserialize)]
struct XcresultTestAttachments {
    #[serde(rename = "testIdentifier")]
    test_identifier: String,
    attachments: Vec<XcresultAttachment>,
}

#[derive(Deserialize)]
struct XcresultAttachment {
    #[serde(rename = "exportedFileName")]
    exported_file_name: String,
    #[serde(rename = "suggestedHumanReadableName")]
    suggested_name: String,
    #[serde(rename = "isAssociatedWithFailure")]
    associated_with_failure: bool,
}

async fn scan(
    root: &Path,
    discover: bool,
    artifact_roots: &[PathBuf],
    xcresult: Option<&XcresultExport>,
) -> Result<Vec<ManifestEntry>> {
    let canonical_root = root
        .canonicalize()
        .with_context(|| format!("cannot open {}", root.display()))?;
    let mut files = Vec::<CollectedPng>::new();
    for item in WalkDir::new(&canonical_root).follow_links(false) {
        let item = item?;
        if item.file_type().is_file()
            && item
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
        {
            let relative = normalized_relative(item.path(), &canonical_root)?;
            if !discover || relative.split('/').any(|part| part == "__Snapshots__") {
                files.push(CollectedPng {
                    name: relative,
                    path: item.path().to_owned(),
                });
            }
        }
    }
    files.sort_by(|left, right| left.name.cmp(&right.name));
    overlay_artifacts(&mut files, artifact_roots)?;
    if let Some(xcresult) = xcresult {
        overlay_xcresult(&mut files, xcresult)?;
    }
    if files.len() > MAX_SCREENSHOTS {
        bail!("directory contains more than {MAX_SCREENSHOTS} PNG screenshots");
    }
    let mut entries = Vec::with_capacity(files.len());
    let mut logical_bytes = 0_u64;
    for collected in files {
        let path = collected.path;
        let metadata = tokio::fs::metadata(&path).await?;
        if metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES {
            bail!("{} exceeds compressed image limits", path.display());
        }
        logical_bytes = logical_bytes
            .checked_add(metadata.len())
            .context("logical size overflow")?;
        if logical_bytes > MAX_RUN_BYTES {
            bail!("run exceeds the 2 GiB logical byte limit");
        }
        let mut file = tokio::fs::File::open(&path).await?;
        let mut header = [0_u8; 24];
        file.read_exact(&mut header)
            .await
            .with_context(|| format!("invalid PNG: {}", path.display()))?;
        let (width, height) =
            png_dimensions(&header).with_context(|| format!("invalid PNG: {}", path.display()))?;
        let mut hasher = Sha256::new();
        hasher.update(header);
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        entries.push(ManifestEntry {
            name: collected.name,
            sha256: hex::encode(hasher.finalize()),
            byte_size: metadata.len(),
            width,
            height,
            path,
        });
    }
    Ok(entries)
}

fn normalized_relative(path: &Path, root: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(root)?
        .to_string_lossy()
        .replace('\\', "/");
    if relative
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        bail!("unsafe screenshot path: {relative}");
    }
    Ok(relative)
}

fn snapshot_suffix(name: &str) -> Option<&str> {
    name.split_once("/__Snapshots__/")
        .map(|(_, suffix)| suffix)
        .or_else(|| name.strip_prefix("__Snapshots__/"))
}

fn overlay_artifacts(files: &mut Vec<CollectedPng>, roots: &[PathBuf]) -> Result<()> {
    for root in roots {
        if !root.exists() {
            bail!("artifact directory does not exist: {}", root.display());
        }
        let canonical = root
            .canonicalize()
            .with_context(|| format!("cannot open artifact directory {}", root.display()))?;
        for item in WalkDir::new(&canonical).follow_links(false) {
            let item = item?;
            if !item.file_type().is_file()
                || !item
                    .path()
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
            {
                continue;
            }
            let relative = normalized_relative(item.path(), &canonical)?;
            let exact: Vec<usize> = files
                .iter()
                .enumerate()
                .filter_map(|(index, file)| {
                    (snapshot_suffix(&file.name) == Some(relative.as_str())).then_some(index)
                })
                .collect();
            match exact.as_slice() {
                [index] => files[*index].path = item.path().to_owned(),
                [] => files.push(CollectedPng {
                    name: format!("__Snapshots__/{relative}"),
                    path: item.path().to_owned(),
                }),
                _ => bail!(
                    "artifact {} matches multiple snapshots; preserve its __Snapshots__ relative path",
                    item.path().display()
                ),
            }
        }
    }
    files.sort_by(|left, right| left.name.cmp(&right.name));
    let duplicate = files
        .windows(2)
        .find(|pair| pair[0].name == pair[1].name)
        .map(|pair| pair[0].name.clone());
    if let Some(name) = duplicate {
        bail!("multiple images resolve to snapshot name {name}");
    }
    Ok(())
}

fn pointfree_component(value: &str) -> String {
    let mut result = String::new();
    let mut replacing = false;
    for character in value.chars() {
        if character.is_alphanumeric() || character == '_' {
            result.push(character);
            replacing = false;
        } else if !replacing && !result.is_empty() {
            result.push('-');
            replacing = true;
        }
    }
    result.trim_matches('-').to_owned()
}

fn overlay_xcresult(files: &mut [CollectedPng], export: &XcresultExport) -> Result<()> {
    for test in &export.tests {
        let has_snapshot_diff = test.attachments.iter().any(|attachment| {
            attachment.associated_with_failure
                && matches!(
                    attachment.suggested_name.to_ascii_lowercase().as_str(),
                    "reference.png" | "failure.png" | "difference.png"
                )
        });
        let failure_attachments: Vec<&XcresultAttachment> = test
            .attachments
            .iter()
            .filter(|attachment| {
                attachment.associated_with_failure
                    && attachment
                        .suggested_name
                        .eq_ignore_ascii_case("failure.png")
            })
            .collect();
        if failure_attachments.is_empty() {
            if has_snapshot_diff {
                bail!(
                    "xcresult test {} contains a snapshot diff without a current failure.png attachment; set SNAPSHOT_ARTIFACTS on the test step and pass --artifacts",
                    test.test_identifier
                );
            }
            continue;
        }
        let identifier = test.test_identifier.trim_end_matches('/');
        let test_name = identifier
            .rsplit('/')
            .next()
            .unwrap_or(identifier)
            .trim_end_matches("()");
        let test_name = pointfree_component(test_name);
        let suite_name = identifier
            .rsplit('/')
            .nth(1)
            .unwrap_or_default()
            .rsplit('.')
            .next()
            .unwrap_or_default();
        let candidates: Vec<usize> = files
            .iter()
            .enumerate()
            .filter_map(|(index, file)| {
                let suffix = snapshot_suffix(&file.name)?;
                let (directory, name) = suffix.rsplit_once('/')?;
                let parent = directory.rsplit('/').next().unwrap_or(directory);
                ((parent == suite_name || suite_name.is_empty())
                    && (name == format!("{test_name}.png")
                        || name.starts_with(&format!("{test_name}."))))
                .then_some(index)
            })
            .collect();
        if candidates.len() != 1 || failure_attachments.len() != 1 {
            bail!(
                "xcresult test {} does not identify one unambiguous Point-Free snapshot ({} candidates, {} current attachments); set SNAPSHOT_ARTIFACTS on the test step and pass --artifacts",
                test.test_identifier,
                candidates.len(),
                failure_attachments.len()
            );
        }
        let attachment = failure_attachments[0];
        let path = export.directory.path().join(&attachment.exported_file_name);
        if !path.is_file() {
            bail!(
                "xcresult manifest references missing attachment {}",
                attachment.exported_file_name
            );
        }
        files[candidates[0]].path = path;
    }
    Ok(())
}

fn export_xcresult_attachments(bundle: &Path) -> Result<XcresultExport> {
    if !bundle.exists() {
        bail!("Xcode result bundle does not exist: {}", bundle.display());
    }
    let output = tempfile::Builder::new()
        .prefix("snappydiff-xcresult-")
        .tempdir()?;
    let status = std::process::Command::new("xcrun")
        .args(["xcresulttool", "export", "attachments", "--path"])
        .arg(bundle)
        .args(["--output-path"])
        .arg(output.path())
        .args(["--filter", "*.png", "--only-failures"])
        .status()
        .context("failed to run xcrun xcresulttool; --xcresult requires Xcode 16 or newer")?;
    if !status.success() {
        bail!(
            "xcresulttool could not export PNG failure attachments from {}",
            bundle.display()
        );
    }
    let manifest_path = output.path().join("manifest.json");
    let manifest = std::fs::read(&manifest_path)
        .with_context(|| format!("xcresulttool did not create {}", manifest_path.display()))?;
    let tests =
        serde_json::from_slice(&manifest).context("xcresult attachment manifest is invalid")?;
    Ok(XcresultExport {
        directory: output,
        tests,
    })
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    if bytes.len() < 24
        || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
        || &bytes[12..16] != b"IHDR"
    {
        bail!("missing PNG signature or IHDR");
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into()?);
    if width == 0
        || height == 0
        || width > MAX_AXIS
        || height > MAX_AXIS
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        bail!("PNG dimensions exceed limits");
    }
    Ok((width, height))
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

fn git_value(directory: &Path, arguments: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(arguments)
        .current_dir(directory)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn deepen_shallow_checkout(directory: &Path) -> Result<()> {
    if git_value(directory, &["rev-parse", "--is-shallow-repository"]).as_deref() != Some("true") {
        return Ok(());
    }
    let status = std::process::Command::new("git")
        .args(["fetch", "--deepen=512", "--no-tags", "origin"])
        .current_dir(directory)
        .status()
        .context("failed to fetch shallow Git history")?;
    if !status.success() {
        bail!(
            "shallow Git history could not be deepened; configure checkout fetch-depth or provide full history"
        );
    }
    Ok(())
}

fn discover_base_head(directory: &Path) -> Option<String> {
    let base = std::env::var("GITHUB_BASE_REF")
        .ok()
        .filter(|value| !value.is_empty())?;
    git_value(directory, &["rev-parse", &format!("origin/{base}")])
}

fn shallow_commits(directory: &Path) -> HashSet<String> {
    let Some(path) = git_value(directory, &["rev-parse", "--git-path", "shallow"]) else {
        return HashSet::new();
    };
    let path = PathBuf::from(path);
    let resolved = if path.is_absolute() {
        path
    } else {
        directory.join(path)
    };
    std::fs::read_to_string(resolved)
        .unwrap_or_default()
        .lines()
        .map(ToOwned::to_owned)
        .collect()
}

fn git_graph(
    directory: &Path,
    commit: &str,
    merge_base: Option<&str>,
) -> Result<Vec<CommitObservation>> {
    let mut command = std::process::Command::new("git");
    command.args(["rev-list", "--parents", "--max-count=512", commit]);
    if let Some(base) = merge_base {
        command.arg(base);
    }
    let output = command
        .current_dir(directory)
        .output()
        .context("failed to inspect Git history")?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let shallow = shallow_commits(directory);
    let stdout = String::from_utf8(output.stdout).context("Git history was not UTF-8")?;
    let mut observations = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.split_whitespace();
        let Some(sha) = parts.next() else {
            continue;
        };
        observations.push(CommitObservation {
            sha: sha.to_owned(),
            parent_shas: parts.map(ToOwned::to_owned).collect(),
            complete: !shallow.contains(sha),
        });
    }
    Ok(observations)
}

fn git_parents(directory: &Path, commit: &str) -> Option<Vec<String>> {
    let output = std::process::Command::new("git")
        .args(["rev-list", "--parents", "-n", "1", commit])
        .current_dir(directory)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8(output.stdout).ok()?;
    let mut parts = line.split_whitespace();
    if parts.next()? != commit {
        return None;
    }
    Some(parts.map(ToOwned::to_owned).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_png(path: &Path, width: u32, height: u32) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut bytes = vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn parses_png_dimensions() {
        let mut bytes = vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        bytes.extend_from_slice(&390_u32.to_be_bytes());
        bytes.extend_from_slice(&844_u32.to_be_bytes());
        assert_eq!(png_dimensions(&bytes).unwrap(), (390, 844));
    }

    #[test]
    fn rejects_implausible_png_dimensions() {
        let mut bytes = vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        bytes.extend_from_slice(&20_000_u32.to_be_bytes());
        bytes.extend_from_slice(&1_u32.to_be_bytes());
        assert!(png_dimensions(&bytes).is_err());
    }

    #[test]
    fn normalizes_repository_identity() {
        assert_eq!(
            normalize_repository("pointfreeco/swift-snapshot-testing").unwrap(),
            "pointfreeco/swift-snapshot-testing"
        );
        assert!(normalize_repository("pointfreeco/swift-snapshot-testing/extra").is_err());
        assert!(normalize_repository("missing-owner").is_err());
    }

    #[tokio::test]
    async fn discovers_pointfree_snapshots_and_overlays_failure_artifacts() {
        let repository = tempfile::tempdir().unwrap();
        let reference = repository
            .path()
            .join("Tests/Feature/__Snapshots__/FeatureTests/card.png");
        let unrelated = repository.path().join("Assets/logo.png");
        write_test_png(&reference, 10, 10);
        write_test_png(&unrelated, 20, 20);

        let artifacts = tempfile::tempdir().unwrap();
        let failure = artifacts.path().join("FeatureTests/card.png");
        write_test_png(&failure, 12, 12);

        let entries = scan(
            repository.path(),
            true,
            &[artifacts.path().to_owned()],
            None,
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].name,
            "Tests/Feature/__Snapshots__/FeatureTests/card.png"
        );
        assert_eq!(entries[0].width, 12);
        assert_eq!(entries[0].path, failure.canonicalize().unwrap());
    }

    #[tokio::test]
    async fn preserves_artifact_test_directory_identity() {
        let repository = tempfile::tempdir().unwrap();
        let existing = repository
            .path()
            .join("A/__Snapshots__/ExistingTests/card.png");
        write_test_png(&existing, 10, 10);
        let artifacts = tempfile::tempdir().unwrap();
        write_test_png(&artifacts.path().join("NewTests/card.png"), 12, 12);

        let entries = scan(
            repository.path(),
            true,
            &[artifacts.path().to_owned()],
            None,
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "A/__Snapshots__/ExistingTests/card.png");
        assert_eq!(entries[0].width, 10);
        assert_eq!(entries[1].name, "__Snapshots__/NewTests/card.png");
        assert_eq!(entries[1].width, 12);
    }

    #[tokio::test]
    async fn rejects_a_missing_artifact_directory() {
        let repository = tempfile::tempdir().unwrap();
        write_test_png(
            &repository.path().join("Tests/__Snapshots__/Tests/card.png"),
            10,
            10,
        );
        let error = scan(
            repository.path(),
            true,
            &[repository.path().join("missing")],
            None,
        )
        .await
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("artifact directory does not exist")
        );
    }

    #[test]
    fn maps_xcresult_failure_attachments_using_manifest_identity() {
        let repository = tempfile::tempdir().unwrap();
        let reference = repository
            .path()
            .join("Tests/__Snapshots__/FeatureTests/testCard.1.png");
        write_test_png(&reference, 10, 10);
        let export_directory = tempfile::tempdir().unwrap();
        let failure = export_directory.path().join("failure_0_C0FFEE.png");
        write_test_png(&failure, 12, 12);
        let fixture = br#"[{"testIdentifier":"FeatureTests/testCard()","attachments":[{"exportedFileName":"reference_0_C0FFEE.png","suggestedHumanReadableName":"reference.png","isAssociatedWithFailure":true},{"exportedFileName":"failure_0_C0FFEE.png","suggestedHumanReadableName":"failure.png","isAssociatedWithFailure":true},{"exportedFileName":"difference_0_C0FFEE.png","suggestedHumanReadableName":"difference.png","isAssociatedWithFailure":true}]}]"#;
        let tests = serde_json::from_slice(fixture).unwrap();
        let export = XcresultExport {
            directory: export_directory,
            tests,
        };
        let mut files = vec![CollectedPng {
            name: "Tests/__Snapshots__/FeatureTests/testCard.1.png".to_owned(),
            path: reference,
        }];

        overlay_xcresult(&mut files, &export).unwrap();
        assert_eq!(files[0].path, failure);
    }

    #[test]
    fn rejects_positional_mapping_for_multiple_xcresult_attachments() {
        let repository = tempfile::tempdir().unwrap();
        let first = repository
            .path()
            .join("Tests/__Snapshots__/FeatureTests/testCard.1.png");
        let second = repository
            .path()
            .join("Tests/__Snapshots__/FeatureTests/testCard.2.png");
        write_test_png(&first, 10, 10);
        write_test_png(&second, 10, 10);
        let export_directory = tempfile::tempdir().unwrap();
        write_test_png(&export_directory.path().join("failure_1.png"), 12, 12);
        write_test_png(&export_directory.path().join("failure_0.png"), 14, 14);
        let fixture = br#"[{"testIdentifier":"FeatureTests/testCard()","attachments":[{"exportedFileName":"failure_1.png","suggestedHumanReadableName":"failure.png","isAssociatedWithFailure":true},{"exportedFileName":"failure_0.png","suggestedHumanReadableName":"failure.png","isAssociatedWithFailure":true}]}]"#;
        let export = XcresultExport {
            directory: export_directory,
            tests: serde_json::from_slice(fixture).unwrap(),
        };
        let mut files = vec![
            CollectedPng {
                name: "Tests/__Snapshots__/FeatureTests/testCard.1.png".to_owned(),
                path: first,
            },
            CollectedPng {
                name: "Tests/__Snapshots__/FeatureTests/testCard.2.png".to_owned(),
                path: second,
            },
        ];

        let error = overlay_xcresult(&mut files, &export).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("does not identify one unambiguous")
        );
    }

    #[test]
    fn allows_xcresult_without_snapshot_failures() {
        let export = XcresultExport {
            directory: tempfile::tempdir().unwrap(),
            tests: Vec::new(),
        };
        let mut files = Vec::new();
        overlay_xcresult(&mut files, &export).unwrap();
    }
}
