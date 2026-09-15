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
cp .env.example apps/api/.dev.vars
npm run validate:config
npm run check
npm test
```

Local D1 and R2 emulation use Wrangler and do not require cloud credentials. See `docs/deployment.md` before creating remote resources or secrets.

## Delivery status

Implementation follows the milestones in `PLAN.md`. External-provider validation remains an explicit release gate until disposable WorkOS, GitHub, and Cloudflare resources are supplied; see `docs/provider-validation.md`.

