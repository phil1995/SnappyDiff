# WorkOS setup

Create separate WorkOS applications for staging and production. Configure `<APP_ORIGIN>/auth/callback` as the exact HTTPS callback. AuthKit must return an organization membership, which SnappyDiff maps to a tenant.

Set `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI`, and `APP_ORIGIN` through environment configuration. Set `WORKOS_API_KEY`, `WORKOS_WEBHOOK_SECRET`, and a random `WORKOS_COOKIE_PASSWORD` of at least 32 characters with `wrangler secret put`. Never place their values in files, shell history, CI output, or issue trackers.

Subscribe the webhook to organization, user, and membership lifecycle events at `<APP_ORIGIN>/webhooks/workos`. Verify login, role update, suspension, and replay handling in staging before production.
