use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use walkdir::WalkDir;

use crate::{MAX_AXIS, MAX_IMAGE_BYTES, MAX_PIXELS, MAX_RUN_BYTES, MAX_SCREENSHOTS, ManifestEntry};

#[derive(Debug, Clone)]
struct CollectedPng {
    name: String,
    path: PathBuf,
}

pub(crate) struct XcresultExport {
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

pub(crate) async fn scan(
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

pub(crate) fn export_xcresult_attachments(bundle: &Path) -> Result<XcresultExport> {
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
