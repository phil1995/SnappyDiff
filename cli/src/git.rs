use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use serde::Serialize;

#[derive(Serialize)]
pub(crate) struct CommitObservation {
    pub(crate) sha: String,
    pub(crate) parent_shas: Vec<String>,
    pub(crate) complete: bool,
}

pub(crate) fn value(directory: &Path, arguments: &[&str]) -> Option<String> {
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

pub(crate) fn deepen_shallow_checkout(directory: &Path) -> Result<()> {
    if value(directory, &["rev-parse", "--is-shallow-repository"]).as_deref() != Some("true") {
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

pub(crate) fn discover_base_head(directory: &Path) -> Option<String> {
    let base = std::env::var("GITHUB_BASE_REF")
        .ok()
        .filter(|value| !value.is_empty())?;
    value(directory, &["rev-parse", &format!("origin/{base}")])
}

pub(crate) fn shallow_commits(directory: &Path) -> HashSet<String> {
    let Some(path) = value(directory, &["rev-parse", "--git-path", "shallow"]) else {
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

pub(crate) fn graph(
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
    Ok(stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let sha = parts.next()?;
            Some(CommitObservation {
                sha: sha.to_owned(),
                parent_shas: parts.map(ToOwned::to_owned).collect(),
                complete: !shallow.contains(sha),
            })
        })
        .collect())
}

pub(crate) fn parents(directory: &Path, commit: &str) -> Option<Vec<String>> {
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

pub(crate) fn discover_repository(directory: &Path, configured: Option<&str>) -> Result<String> {
    if let Some(repository) = configured {
        return normalize_repository(repository);
    }
    if let Ok(repository) = std::env::var("GITHUB_REPOSITORY") {
        return normalize_repository(&repository);
    }
    let remote = value(directory, &["remote", "get-url", "origin"])
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

pub(crate) fn discover_default_branch(directory: &Path) -> Option<String> {
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
    value(
        directory,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .and_then(|reference| reference.strip_prefix("origin/").map(ToOwned::to_owned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_repository_identity() {
        assert_eq!(
            normalize_repository("pointfreeco/swift-snapshot-testing").unwrap(),
            "pointfreeco/swift-snapshot-testing"
        );
        assert!(normalize_repository("pointfreeco/swift-snapshot-testing/extra").is_err());
        assert!(normalize_repository("missing-owner").is_err());
    }
}
