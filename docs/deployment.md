# Deployment guide

No deployment command should be run until the provider gates in `provider-validation.md` that protect the enabled feature are complete.

## Environment model

Use separate `local`, `staging`, and `production` resources. Never reuse a D1 database, R2 bucket, WorkOS environment, GitHub App, cookie password, webhook secret, or token pepper between staging and production.

## One-time Cloudflare setup

1. Create D1 databases and private R2 buckets for staging and production.
2. Merge the staging and production sections from `infra/wrangler.example.jsonc` into `apps/api/wrangler.jsonc` and replace only the documented resource/origin placeholders. Keep the checked-in local bindings unchanged.
3. Create matching WorkOS clients and GitHub Apps with environment-specific callback URLs.
4. Add secrets with `wrangler secret put`; do not write them to a file or CI output.
5. Apply D1 migrations, deploy staging, and complete the provider gates.
6. Promote the same tested commit to production through the CI deployment environment.

## Required secrets

- `WORKOS_API_KEY`
- `WORKOS_WEBHOOK_SECRET`
- `WORKOS_COOKIE_PASSWORD` (at least 32 random bytes)
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `TOKEN_PEPPER` (at least 32 random bytes)
- `R2_ACCESS_KEY_ID` (staging/production direct uploads)
- `R2_SECRET_ACCESS_KEY` (staging/production direct uploads)

Set `CLOUDFLARE_ACCOUNT_ID` and `R2_BUCKET_NAME` as non-secret environment variables. The R2 key pair should be restricted to the environment's single image bucket. Upload URLs address a service-generated temporary key and expire after 15 minutes; callers never receive canonical-object write access.

Rotate secrets independently. Token hashes are peppered; rotating `TOKEN_PEPPER` requires a controlled token reissue window.

## Rollback

Worker code can be rolled back independently. Database migrations are forward-only and must remain compatible with the prior Worker during a rollout. Destructive schema cleanup requires a later migration after the rollback window. R2 canonical objects are immutable and are never removed as part of application rollback.
