# Upload protocol

The upload protocol is designed for retries and matrix jobs. Every request uses a scoped project token with `runs:create`; the token determines organization and project, so neither can be selected from a request body.

1. Register an immutable run attempt with provider/build ID, attempt number, commit metadata, and the complete expected shard set. Repeating the same identity returns the existing run; changing any immutable field is a conflict.
2. Submit each shard manifest in deterministic pages of at most 100 entries and 4 MiB. Each page has an idempotency key and content digest. Screenshot names are normalized relative paths and are unique across the full run.
3. Finalize the shard. The service atomically claims finalization, attaches existing tenant-local images, reserves the missing logical bytes against the organization budget, and creates one temporary upload session per missing hash.
4. Fetch upload sessions in pages. Staging and production return 15-minute AWS Signature V4 URLs for service-generated temporary R2 keys. Local development returns equivalently scoped Worker relay URLs. Neither form can write a canonical key.
5. PUT each PNG and notify the completion endpoint. A leased durable job reads the exact uploaded object version, checks byte size, SHA-256, content type, PNG header, dimensions, and decoded-pixel ceiling, then conditionally publishes to the immutable tenant-local canonical key.
6. Once all expected shards are verified, the service atomically materializes screenshots and completes the run. The CLI polls status independently from upload completion.

Abandoned sessions expire after 24 hours. Cleanup releases reserved bytes and deletes temporary objects. A corrupt upload fails its shard and run, releases its reservation, and removes its temporary object. Concurrent equal uploads may both reach temporary storage, but canonical R2 publication and image metadata converge on one organization/hash record.

## CLI configuration

Copy `.snappydiff.example.json` to `.snappydiff.json` and commit the non-secret endpoint, project ID, and desired concurrency. Supply `SNAPPYDIFF_TOKEN` only through the CI secret store. Command flags and environment variables override file defaults.

The `login` command is intentionally gated until the WorkOS device-authorization spike in `docs/provider-validation.md` has passed. Project tokens are the implemented authentication path for this milestone; GitHub Actions OIDC is enabled only after its claim/repository-binding gate passes.

## Limits

- 32 MiB compressed bytes per PNG
- 16,384 pixels per axis and 40 million decoded pixels
- 10,000 screenshot names and 2 GiB logical image bytes per run
- 100 entries and 4 MiB per manifest page
- 256 declared shards per run attempt
- upload concurrency from 1 to 32 (default 4)

