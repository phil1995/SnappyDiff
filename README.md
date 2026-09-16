# SnappyDiff

SnappyDiff is a tenant-isolated screenshot review service for CI. A Cloudflare Worker owns metadata and authorization, D1 stores relational state, private R2 stores content-addressed PNGs, and a Rust CLI uploads deterministic manifests. Visual diffs are rendered only in the browser.

The repository is deliberately safe to clone without credentials. Provider integrations are configured through Worker bindings and secrets; no account identifier, private key, access token, or bucket credential belongs in source control.

## Repository layout

- `apps/api`: Cloudflare Worker API, migrations, durable job runner, and static asset host.
- `apps/dashboard`: authenticated review frontend.
- `cli`: Rust command-line client.
- `packages/contracts`: shared HTTP schemas and limits.
- `docs`: architecture, security, operations, and provider validation records.
- `infra`: checked-in deployment templates with placeholder resource identifiers.

## Local development

Prerequisites are Node.js 22+, npm 11+, Rust 1.85+, and Wrangler 4+. Rust is only needed for the CLI.

```bash
npm install
mkdir -p apps/api
cp .env.example apps/api/.dev.vars
npm run validate:config -- apps/api/.dev.vars
npm run check
npm test
```

Local D1 and R2 emulation use Wrangler and do not require cloud credentials. See `docs/deployment.md` before creating remote resources or secrets.

The CLI reads non-secret defaults from a checked-in `.snappydiff.json` (start from `.snappydiff.example.json`). Supply project tokens only through `SNAPPYDIFF_TOKEN`; never place them in the configuration file or command history.

The complete retry, sharding, deduplication, and verification contract is documented in `docs/upload-protocol.md`.
Baseline recovery, scoped-token rotation, PR pin reconciliation, and retention cleanup are documented in `docs/operations.md`.

The local shape check reports provider secrets as disabled. Before staging or production deployment, run `npm run validate:config -- <environment-file> --require-secrets` in a protected environment or verify the equivalent Wrangler secret bindings without printing their values.

Apply the local schema and optional development tenant with:

```bash
npx wrangler d1 migrations apply snappydiff-local --local --config apps/api/wrangler.jsonc
npx wrangler d1 execute snappydiff-local --local --config apps/api/wrangler.jsonc --file apps/api/scripts/seed-local.sql
```

## Delivery status

Implementation follows the milestones in `PLAN.md`. External-provider validation remains an explicit release gate until disposable WorkOS, GitHub, and Cloudflare resources are supplied; see `docs/provider-validation.md`.
