# Upload protocol

The upload protocol is designed for retries and matrix jobs. A workspace upload key is exchanged for a short-lived, project-scoped credential after the CLI detects the repository. The service resolves or creates one project per repository inside that workspace.

1. Register an immutable run attempt with provider/build ID, attempt number, commit metadata, and the complete expected shard set. Repeating the same identity returns the existing run; changing any immutable field is a conflict.
2. Submit each shard manifest in deterministic pages of at most 100 entries and 4 MiB. Each page has an idempotency key and content digest. Screenshot names are normalized relative paths and are unique across the full run.
3. Finalize the shard. The service atomically claims finalization, attaches existing tenant-local images, reserves the missing logical bytes against the organization budget, and creates one temporary upload session per missing hash.
4. Fetch upload sessions in pages. Staging and production return 15-minute AWS Signature V4 URLs for service-generated temporary R2 keys. Local development returns equivalently scoped Worker relay URLs. Neither form can write a canonical key.
5. PUT each PNG and notify the completion endpoint. A leased durable job reads the exact uploaded object version, checks byte size, SHA-256, content type, PNG header, dimensions, and decoded-pixel ceiling, then conditionally publishes to the immutable tenant-local canonical key.
6. Once all expected shards are verified, the service atomically materializes screenshots and completes the run. The CLI polls status independently from upload completion.

Abandoned sessions expire after 24 hours. Cleanup releases reserved bytes and deletes temporary objects. A corrupt upload fails its shard and run, releases its reservation, and removes its temporary object. Concurrent equal uploads may both reach temporary storage, but canonical R2 publication and image metadata converge on one organization/hash record.

## CLI configuration

Create a workspace upload key in the dashboard and supply it as `SNAPPYDIFF_TOKEN` through the CI secret store. Set `SNAPPYDIFF_ENDPOINT` in the workflow and pass optional settings such as `--concurrency` on the upload command; no checked-in configuration file is required. The CLI detects `GITHUB_REPOSITORY` in GitHub Actions and otherwise reads the `origin` Git remote. `SNAPPYDIFF_REPOSITORY=owner/name` is available as an explicit override.

For Point-Free Swift SnapshotTesting, set `SNAPSHOT_ARTIFACTS` on the snapshot test step and create that directory before testing. Run the uploader afterward with `if: always()`, `--discover`, and `--artifacts "$SNAPSHOT_ARTIFACTS"`. Discovery includes PNGs only below `__Snapshots__`; current failure artifacts replace their matching references by full test-directory-relative identity. Ambiguous mappings fail instead of uploading the wrong image. `--xcresult <bundle>` is a fallback for a single unambiguous Point-Free failure attachment per test; multi-snapshot tests must use `SNAPSHOT_ARTIFACTS` because Xcode's attachment manifest does not expose assertion-level identity.

The repository-root composite action installs a checksum-verified CLI release and invokes this flow. Release tags build native macOS Apple Silicon, macOS Intel, and Linux x86_64 archives. The action and installer are usable from other repositories once this repository and the corresponding release are publicly accessible.

The `login` command is intentionally gated until the WorkOS device-authorization spike in `docs/provider-validation.md` has passed. Workspace keys support other CI systems and automatically group uploads by repository. In GitHub Actions, the CLI automatically uses OIDC when `SNAPPYDIFF_TOKEN` is absent and the GitHub App is connected.

## Limits

- 32 MiB compressed bytes per PNG
- 16,384 pixels per axis and 40 million decoded pixels
- 10,000 screenshot names and 2 GiB logical image bytes per run
- 100 entries and 4 MiB per manifest page
- 256 declared shards per run attempt
- upload concurrency from 1 to 32 (default 4)
