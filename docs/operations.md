# Operations runbook

## Provision the first organization administrator

Organization creation is an operator-controlled action in the initial release. After creating the organization in WorkOS, insert the SnappyDiff organization and usage row in one D1 batch, then let the administrator attempt one login so the `users` row is created. Add the matching `(organization_id, user_id)` membership with role `admin`. Do not create memberships from email addresses alone; use the verified WorkOS user identifier recorded by the callback.

The local-only `apps/api/scripts/seed-local.sql` creates a development organization and quota. It is outside the migrations directory so it cannot be applied during a remote migration by accident.

## Scheduled work

The Worker runs every five minutes. It creates tenant-scoped reconciliation jobs and leases ready jobs for 60 seconds. Failed jobs use bounded exponential backoff and become `failed` after ten attempts. Operators should alert on failed jobs and replay them only after addressing the stored error; replay tooling is added with the upload workflows that define job-specific safety checks.

## Logs and request IDs

Every request receives an `x-request-id`, which is included in structured logs and audit events. Logs contain identifiers and error classes, never session cookies, bearer tokens, provider payloads, image bytes, or secret values.

## Database rollout

Migrations are forward-only. Apply migrations to staging, exercise the prior and candidate Worker against the upgraded schema, then deploy the candidate Worker. Production schema changes must remain compatible with the previous Worker throughout the rollback window.

## Incident defaults

- Authentication uncertainty: reject the request and preserve data.
- GitHub installation or PR-state uncertainty: preserve retention pins.
- Job lease uncertainty: wait for lease expiry; never manually run the same effect concurrently.
- R2 publication uncertainty: re-verify the exact temporary object version before publishing.
- Tenant-boundary concern: disable the affected route or token class and retain audit data.

