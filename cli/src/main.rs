use std::{collections::HashMap, path::{Path, PathBuf}, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use futures::{stream, StreamExt, TryStreamExt};
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
    Status { run_id: String },
}

#[derive(Args)]
struct UploadArgs {
    directory: PathBuf,
    #[arg(long, env = "SNAPPYDIFF_PROJECT")]
    project: Option<String>,
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
    project: Option<String>,
    upload_concurrency: Option<usize>,
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
    expected_shards: Vec<String>,
    trust_class: &'static str,
}

#[derive(Deserialize)]
struct RegisterResponse { run: ResourceId, shard: ResourceId }

#[derive(Deserialize)]
struct ResourceId { id: String, #[serde(default)] state: Option<String> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadPage { uploads: Vec<UploadSession>, next_cursor: Option<String> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadSession { id: String, sha256: String, state: String, target: Option<UploadTarget> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadTarget { url: String, method: String, headers: HashMap<String, String> }

#[derive(Deserialize, Serialize)]
struct StatusResponse { run: serde_json::Value, shards: Vec<serde_json::Value> }

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let json_output = cli.json;
    if let Err(error) = run(cli).await {
        if json_output {
            eprintln!("{}", serde_json::json!({ "error": { "code": "cli_error", "message": error.to_string() } }));
        } else {
            eprintln!("error: {error:#}");
        }
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<()> {
    let file_config = load_config(&cli.config)?;
    if matches!(cli.command, Command::Login) {
        bail!("interactive WorkOS device authorization is disabled until the provider validation gate is completed; use a scoped SNAPPYDIFF_TOKEN for CI");
    }
    let token = cli.token.context("SNAPPYDIFF_TOKEN or --token is required")?;
    if !token.starts_with("sd_") { bail!("project token has an invalid format"); }
    let endpoint = cli.endpoint.or(file_config.endpoint).unwrap_or_else(|| "http://localhost:8787".to_owned());
    let api = Api { client: Client::builder().timeout(Duration::from_secs(60)).build()?, endpoint: endpoint.trim_end_matches('/').to_owned(), token };
    match cli.command {
        Command::Upload(args) => {
            let mut args = *args;
            args.project = args.project.or(file_config.project);
            args.concurrency = args.concurrency.or(file_config.upload_concurrency);
            upload(&api, args, cli.json).await
        }
        Command::Status { run_id } => {
            let status: StatusResponse = api.get(&format!("/api/v1/runs/{run_id}")).await?;
            print_value(cli.json, &status)
        }
        Command::Login => unreachable!(),
    }
}

async fn upload(api: &Api, args: UploadArgs, json_output: bool) -> Result<()> {
    let concurrency = args.concurrency.unwrap_or(4);
    if concurrency == 0 || concurrency > 32 { bail!("concurrency must be between 1 and 32"); }
    let project = args.project.context("project is required via --project, SNAPPYDIFF_PROJECT, or .snappydiff.json")?;
    let entries = scan(&args.directory).await?;
    if entries.is_empty() && !args.allow_empty { bail!("no PNG screenshots found; pass --allow-empty only for an intentional full removal"); }
    let provider_run_id = args.provider_run_id.unwrap_or_else(|| format!("manual-{}", epoch_millis()));
    let expected_shards = if args.expected_shards.is_empty() { vec![args.shard.clone()] } else { args.expected_shards.clone() };
    let identity = RunIdentity {
        provider: if std::env::var_os("GITHUB_ACTIONS").is_some() { "github_actions" } else { "manual" },
        run_key: args.run_key.unwrap_or_else(|| provider_run_id.clone()), provider_run_id,
        attempt_number: args.attempt, commit_sha: args.commit, branch: args.branch,
        merge_base_sha: args.merge_base, observed_default_head_sha: args.default_head,
        pull_request_number: args.pull_request, expected_shards,
        trust_class: if args.fork { "fork_isolated" } else { "first_party" },
    };
    let registration: RegisterResponse = api.post(&format!("/api/v1/projects/{project}/runs"), &serde_json::json!({
        "identity": identity, "shardId": args.shard, "allowEmpty": args.allow_empty,
    })).await?;
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
        let _: serde_json::Value = api.post_empty(&format!("/api/v1/runs/{}/shards/{}/finalize", registration.run.id, registration.shard.id)).await?;
    }
    let paths: Arc<HashMap<String, PathBuf>> = Arc::new(entries.iter().map(|entry| (entry.sha256.clone(), entry.path.clone())).collect());
    let mut after: Option<String> = None;
    loop {
        let suffix = after.as_ref().map(|cursor| format!("?after={cursor}")).unwrap_or_default();
        let page: UploadPage = api.get(&format!("/api/v1/runs/{}/shards/{}/uploads{suffix}", registration.run.id, registration.shard.id)).await?;
        let api_copy = api.clone();
        let paths_copy = paths.clone();
        stream::iter(page.uploads.into_iter().filter(|upload| matches!(upload.state.as_str(), "pending" | "uploaded")))
            .map(Ok::<_, anyhow::Error>)
            .try_for_each_concurrent(concurrency, move |upload| {
                let api = api_copy.clone();
                let paths = paths_copy.clone();
                async move {
                    let target = upload.target.context("server omitted upload target")?;
                    let path = paths.get(&upload.sha256).context("server requested an unknown hash")?;
                    api.upload_file(&target, path).await?;
                    let _: serde_json::Value = api.post_empty(&format!("/api/v1/upload-sessions/{}/complete", upload.id)).await?;
                    Ok(())
                }
            }).await?;
        after = page.next_cursor;
        if after.is_none() { break; }
    }
    let mut status: StatusResponse;
    for _ in 0..120 {
        status = api.get(&format!("/api/v1/runs/{}", registration.run.id)).await?;
        let state = status.run.get("state").and_then(|value| value.as_str()).unwrap_or("unknown");
        if matches!(state, "complete" | "failed" | "canceled" | "timed_out") {
            print_value(json_output, &status)?;
            if state == "complete" { return Ok(()); }
            bail!("run ended with state {state}");
        }
        sleep(Duration::from_secs(1)).await;
    }
    bail!("run verification is still pending; inspect it with `snappydiff status {}`", registration.run.id)
}

async fn scan(root: &Path) -> Result<Vec<ManifestEntry>> {
    let canonical_root = root.canonicalize().with_context(|| format!("cannot open {}", root.display()))?;
    let mut files = Vec::new();
    for item in WalkDir::new(&canonical_root).follow_links(false) {
        let item = item?;
        if item.file_type().is_file() && item.path().extension().is_some_and(|extension| extension.eq_ignore_ascii_case("png")) {
            files.push(item.path().to_owned());
        }
    }
    files.sort();
    if files.len() > MAX_SCREENSHOTS { bail!("directory contains more than {MAX_SCREENSHOTS} PNG screenshots"); }
    let mut entries = Vec::with_capacity(files.len());
    let mut logical_bytes = 0_u64;
    for path in files {
        let metadata = tokio::fs::metadata(&path).await?;
        if metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES { bail!("{} exceeds compressed image limits", path.display()); }
        logical_bytes = logical_bytes.checked_add(metadata.len()).context("logical size overflow")?;
        if logical_bytes > MAX_RUN_BYTES { bail!("run exceeds the 2 GiB logical byte limit"); }
        let mut file = tokio::fs::File::open(&path).await?;
        let mut header = [0_u8; 24];
        file.read_exact(&mut header).await.with_context(|| format!("invalid PNG: {}", path.display()))?;
        let (width, height) = png_dimensions(&header).with_context(|| format!("invalid PNG: {}", path.display()))?;
        let mut hasher = Sha256::new();
        hasher.update(header);
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).await?;
            if count == 0 { break; }
            hasher.update(&buffer[..count]);
        }
        let relative = path.strip_prefix(&canonical_root)?.to_string_lossy().replace('\\', "/");
        if relative.split('/').any(|part| part.is_empty() || part == "." || part == "..") { bail!("unsafe screenshot path: {relative}"); }
        entries.push(ManifestEntry { name: relative, sha256: hex::encode(hasher.finalize()), byte_size: metadata.len(), width, height, path });
    }
    Ok(entries)
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    if bytes.len() < 24 || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10] || &bytes[12..16] != b"IHDR" { bail!("missing PNG signature or IHDR"); }
    let width = u32::from_be_bytes(bytes[16..20].try_into()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into()?);
    if width == 0 || height == 0 || width > MAX_AXIS || height > MAX_AXIS || u64::from(width) * u64::from(height) > MAX_PIXELS { bail!("PNG dimensions exceed limits"); }
    Ok((width, height))
}

impl Api {
    async fn request<T: DeserializeOwned>(&self, method: Method, path: &str, body: Option<&serde_json::Value>) -> Result<T> {
        for attempt in 0..4 {
            let mut request = self.client.request(method.clone(), format!("{}{path}", self.endpoint)).bearer_auth(&self.token);
            if let Some(body) = body { request = request.json(body); }
            match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    let bytes = response.bytes().await?;
                    if status.is_success() { return serde_json::from_slice(&bytes).context("SnappyDiff returned an invalid response"); }
                    if attempt < 3 && (status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error()) {
                        sleep(Duration::from_millis(250 * (1 << attempt))).await;
                        continue;
                    }
                    bail!("SnappyDiff returned {status}: {}", String::from_utf8_lossy(&bytes));
                }
                Err(error) if attempt < 3 && (error.is_timeout() || error.is_connect()) => {
                    sleep(Duration::from_millis(250 * (1 << attempt))).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
        unreachable!()
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> { self.request(Method::GET, path, None).await }
    async fn post<T: DeserializeOwned>(&self, path: &str, body: &serde_json::Value) -> Result<T> { self.request(Method::POST, path, Some(body)).await }
    async fn post_empty<T: DeserializeOwned>(&self, path: &str) -> Result<T> { self.request(Method::POST, path, Some(&serde_json::json!({}))).await }

    async fn upload_file(&self, target: &UploadTarget, path: &Path) -> Result<()> {
        if !target.method.eq_ignore_ascii_case("PUT") { bail!("server requested unsupported upload method"); }
        for attempt in 0..4 {
            let file = tokio::fs::File::open(path).await?;
            let stream = ReaderStream::new(file);
            let mut request = self.client.put(&target.url).body(reqwest::Body::wrap_stream(stream));
            for (name, value) in &target.headers { request = request.header(name, value); }
            match request.send().await {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) if attempt < 3 && response.status().is_server_error() => {},
                Ok(response) => bail!("image upload failed with {}", response.status()),
                Err(error) if attempt < 3 && (error.is_timeout() || error.is_connect()) => {},
                Err(error) => return Err(error.into()),
            }
            sleep(Duration::from_millis(250 * (1 << attempt))).await;
        }
        unreachable!()
    }
}

fn print_value<T: Serialize>(json_output: bool, value: &T) -> Result<()> {
    if json_output { println!("{}", serde_json::to_string(value)?); }
    else { println!("{}", serde_json::to_string_pretty(value)?); }
    Ok(())
}

fn epoch_millis() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn load_config(path: &Path) -> Result<FileConfig> {
    if !path.exists() { return Ok(FileConfig::default()); }
    let contents = std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    serde_json::from_str(&contents).with_context(|| format!("invalid configuration in {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_png_dimensions() {
        let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        bytes.extend_from_slice(&390_u32.to_be_bytes());
        bytes.extend_from_slice(&844_u32.to_be_bytes());
        assert_eq!(png_dimensions(&bytes).unwrap(), (390, 844));
    }

    #[test]
    fn rejects_implausible_png_dimensions() {
        let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        bytes.extend_from_slice(&20_000_u32.to_be_bytes());
        bytes.extend_from_slice(&1_u32.to_be_bytes());
        assert!(png_dimensions(&bytes).is_err());
    }
}
