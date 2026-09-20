# SnappyDiff

SnappyDiff is a tenant-isolated screenshot review service for CI. A Cloudflare Worker owns metadata and authorization, D1 stores relational state, private R2 stores content-addressed PNGs, and a Rust CLI uploads deterministic manifests. Visual diffs are rendered only in the browser.

The repository is deliberately safe to clone without credentials. Provider integrations are configured through Worker bindings and secrets; no account identifier, private key, access token, or bucket credential belongs in source control.

## Repository layout

- `apps/api`: Cloudflare Worker API, migrations, durable job runner, and static asset host.
- `apps/dashboard`: authenticated review frontend.
- `cli`: Rust command-line client.
- `packages/contracts`: shared HTTP schemas and limits.
- `shared/limits.json`: upload limits consumed by the API and compiled into the CLI.
- `docs`: architecture, security, operations, and provider validation records.
- `infra`: checked-in deployment templates with placeholder resource identifiers.

## Local development

Prerequisites are Node.js 22+, npm 11+, Rust 1.85+, and Wrangler 4+. Rust is only needed for the CLI.

For dashboard and Worker development, install dependencies and run:

```bash
npm ci
npm run dev
```

This applies local D1 migrations, seeds a local administrator plus representative dashboard data,
creates ignored local-only signing secrets, watches dashboard assets, and serves the complete app at
`http://localhost:8787`. Selecting **Sign in** creates a local admin session without contacting WorkOS.
The local shortcut is gated by `APP_ENV=local` and is unavailable in staging and production.
If an older checkout left incompatible emulator data behind, `npm run dev:reset` rebuilds only the
ignored local Wrangler state and then starts the same development server.

Run the local configuration shape check and code checks separately:

```bash
npm run validate:config -- .env.example
npm run check
npm test
```

`npm run dev` creates `apps/api/.dev.vars` with local signing secrets when it does not exist.
Keep that file private and preserve its generated values when adding local overrides.

Local D1 and R2 emulation use Wrangler and do not require cloud credentials. See `docs/deployment.md` before creating remote resources or secrets.

The dashboard generates a self-contained Point-Free SnapshotTesting workflow using the repository-root GitHub Action, `SNAPPYDIFF_ENDPOINT`, and a workspace upload key stored as the `SNAPPYDIFF_TOKEN` repository secret. The action installs a checksum-verified CLI release, discovers `__Snapshots__` directories, and overlays current images written through `SNAPSHOT_ARTIFACTS`. No checked-in SnappyDiff configuration file is required. The first upload detects the repository and creates its project automatically.

The complete retry, sharding, deduplication, and verification contract is documented in `docs/upload-protocol.md`.
Baseline recovery, scoped-token rotation, PR pin reconciliation, and retention cleanup are documented in `docs/operations.md`.

Production-readiness references: [WorkOS setup](docs/workos-setup.md), [GitHub App setup](docs/github-setup.md), [backup and recovery](docs/backup-recovery.md), [privacy and deletion](docs/privacy.md), [load testing](docs/load-testing.md), and the [private beta checklist](docs/private-beta.md).

The local shape check reports provider secrets as disabled. Before staging or production deployment, run `npm run validate:config -- <environment-file> --require-secrets` in a protected environment or verify the equivalent Wrangler secret bindings without printing their values.

Apply the local schema and optional development tenant with:

```bash
npx wrangler d1 migrations apply snappydiff-local --local --config apps/api/wrangler.jsonc
npx wrangler d1 execute snappydiff-local --local --config apps/api/wrangler.jsonc --file apps/api/scripts/seed-local.sql
```

## Delivery status

Implementation follows the milestones in `PLAN.md`. External-provider validation remains an explicit release gate until disposable WorkOS, GitHub, and Cloudflare resources are supplied; see `docs/provider-validation.md`.

## License

SnappyDiff is released under the MIT License. See `LICENSE` for the full text.
