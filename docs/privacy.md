# Privacy and data lifecycle

SnappyDiff stores identity and membership data, repository coordinates, commit and CI metadata, screenshot PNGs, comparison decisions, and security audit events. It does not need repository file contents.

All tenant-owned records are keyed by organization. Screenshot objects are private and organization-scoped. Dashboard image responses require an authenticated membership and use `no-store` caching.

Organization administrators can download a JSON metadata export at `GET /api/v1/organization/export`. It excludes credential hashes, secrets, image bytes, and internal job leases. Collections are capped at 10,000 rows during the beta; larger exports require an administrator-assisted offline export.

Administrators schedule deletion at `POST /api/v1/organization/deletion` by confirming the exact organization ID. A seven-day recovery window freezes writes. `DELETE /api/v1/organization/deletion` cancels a pending request. After the window, cleanup enumerates canonical, staged, and temporary R2 keys, deletes them, and only then removes metadata. Cancellation is unavailable once object deletion starts.

Ordinary retention is documented in [operations.md](./operations.md). Organization deletion overrides it after the recovery window. Before external onboarding, operators must document the selected Cloudflare region, subprocessors, support contact, and legal retention exceptions.
