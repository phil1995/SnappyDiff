# Provider validation gates

These gates correspond to Milestone 0. They must be run against disposable resources before enabling a staging or production capability. A checkbox is evidence-backed only when the linked record includes date, environment, request identifiers, measured limits, and sanitized output.

## WorkOS

- [ ] Web authorization code flow completes through the Worker callback and produces a secure, same-site session.
- [ ] Device authorization flow can be polled within Worker time limits, including denial and expiry.
- [ ] Organization membership and role changes invalidate or constrain subsequent requests.

## GitHub

- [ ] Actions OIDC `sub`, repository, ref, workflow, actor, and audience claims are validated and bound to one project.
- [ ] A restricted fork token can create only an isolated run and cannot read baseline images or promote.
- [ ] GitHub App permissions are sufficient for Checks writes, repository/default-branch refresh, PR lifecycle reads, and webhook delivery.
- [ ] Check creation, retry, reconciliation, and authenticated dashboard deep links work.
- [ ] A shallow checkout can backfill required parent edges or returns an actionable error.

## Cloudflare storage and limits

- [ ] Direct upload targets a unique temporary R2 key and expires after 15 minutes.
- [ ] Verification reads actual bytes, checks SHA-256/PNG dimensions, and publishes an immutable canonical object.
- [ ] Interrupted and concurrent identical uploads converge on one organization-local canonical image.
- [ ] The Worker safely enforces 32 MiB compressed, 16,384 pixels per axis, 40 million pixels, 10,000 screenshots, 2 GiB logical bytes, and a 4 MiB manifest page.
- [ ] Organization reservations include outstanding uploads and are released on expiry.

## CLI and browser

- [ ] macOS and Linux release binaries meet the agreed size and startup targets.
- [ ] Matrix shards, workflow reruns, resumable finalization, and no-op deduplicated uploads behave as specified.
- [ ] Representative iPhone and iPad PNG pairs remain responsive in overlay, swipe, blink, and highlighted-pixel views with bounded decoding.

## Evidence record template

Create `docs/validation/YYYY-MM-DD-<gate>.md` with:

1. provider account/environment (non-secret identifiers only),
2. exact build commit and configuration profile,
3. procedure and expected result,
4. sanitized observations and request IDs,
5. measured latency, memory, payload, or permission bounds,
6. decision, follow-up owner, and expiry/revalidation date.

