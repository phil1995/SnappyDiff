# Project operations and retention

Project administrators manage retention, GitHub installation ownership, member roles, scoped upload tokens, and baseline recovery from the authenticated project settings page. Every mutation is tenant-scoped and writes an audit event. Newly created or rotated token values are returned once; only a peppered SHA-256 digest and display prefix are stored.

## Baseline recovery

Automatic promotion follows known default-branch ancestry. A non-fast-forward or incomplete history pauses promotion instead of guessing. Administrators can:

- pause automatic promotion while investigating history;
- apply a temporary rollback override without changing the active baseline;
- clear that override;
- resume only when the active baseline is an ancestor of the refreshed default head; or
- explicitly reset history to a complete, first-party run whose commit matches the known default head.

Baseline mutations use the suite version as a compare-and-swap guard. Active and rollback runs receive separate retention pins, and baseline history records the actor and previous run.

## Retention and cleanup

The scheduled cleanup job expires ordinary image artifacts after the project retention period and historically promoted artifacts after the promoted retention period. Active baselines, rollback overrides, and both sides of open-PR comparisons remain pinned. Pull-request state is reconciled hourly; failed or unavailable GitHub access marks retention as unresolved and preserves pins.

Artifact expiration removes screenshot references while retaining run and comparison summaries. Shared image objects are marked `deleting` only after every screenshot, manifest, comparison, and active pin reference is gone. Upload verification waits while the same hash is deleting. R2 deletion happens before the guarded D1 row removal; retries reconcile interruptions, and stored-byte accounting changes only after the row is gone.

Unpinned run metadata is removed after one year. Temporary uploads continue to use the shorter cleanup policy described in [upload-protocol.md](upload-protocol.md).

## Operational cautions

- Treat history reset as an exceptional recovery operation and verify the refreshed default head first.
- Keep at least one active administrator; the API rejects suspension or demotion of the final active admin.
- Rotate project tokens periodically and immediately after suspected exposure. Rotation atomically revokes the predecessor.
- Do not reduce retention without communicating that the next cleanup pass may expire newly eligible artifacts.
