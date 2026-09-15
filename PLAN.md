# SnappyDiff — Plan and Milestones

## Vision

SnappyDiff is a lightweight hosted screenshot-review service for CI. It accepts screenshot runs from a CLI, detects changes against an appropriate baseline, reports the result to GitHub, and provides an authenticated dashboard for inspecting before/after images and visual diffs.

The service should have no permanently running application server, a very small operational footprint, and strict tenant isolation.

## Product goals

- Only authorized users and CI jobs can access a project's screenshots.
- Integrate naturally with GitHub pull requests and checks.
- Upload screenshots from a small command-line client.
- Avoid uploading duplicate image data.
- Show added, removed, and changed screenshots in a web dashboard.
- Generate visual diffs in the browser only when someone views a change.
- Keep infrastructure and storage costs predictable at roughly 100,000 uploads per month.
- Support retention policies and deletion of old runs.

## Initial non-goals

- Capturing screenshots itself; existing test frameworks remain responsible for capture.
- Server-side computer vision or perceptual comparison.
- Inline private images inside GitHub checks.
- Supporting every source-control provider in the first release.
- Providing a self-hosted edition in the first release.
- Automatically accepting or rejecting UI changes using AI.
- Named suites or multiple independent baseline streams within one project.

## Core decisions

### Comparison

- The CLI calculates a SHA-256 hash for every screenshot.
- The cloud service is authoritative for run and baseline comparison.
- Equal file hashes are unchanged; different hashes are changed.
- Added and removed screenshot names are reported separately.
- Visual diffs are presentation artifacts generated on demand in the browser.
- Pixel tolerance and threshold-based pass/fail behavior are deferred until there is a demonstrated need.
- The initial release has no comparison configuration or per-run overrides: strict PNG SHA-256 equality is the only rule.
- Future comparison settings belong to a project; every run records the effective configuration used.

This makes the normal comparison path a metadata operation rather than an image-processing job.

### Image format

- Accept PNG screenshots initially.
- Store the uploaded PNG bytes without transcoding to HEIF, AVIF, or WebP.
- Use the PNG's SHA-256 for integrity, deduplication, and strict equality comparison.
- Enforce initial configurable ceilings of 32 MiB compressed bytes per image, 16,384 pixels per axis, 40 million decoded pixels per image, 10,000 screenshots per run, and 2 GiB of logical image bytes per run (including deduplicated images).
- Limit each manifest request to 4 MiB and paginate larger manifests. Reserve an organization's configured upload budget before issuing upload URLs, including outstanding uploads.
- These are provisional ceilings to validate in Milestone 0, not performance promises. The browser bounds concurrent decoding and releases off-screen image buffers.

### GitHub presentation

GitHub checks contain a result summary and authenticated deep links into the SnappyDiff dashboard. Images are not embedded by default because GitHub image requests do not carry the viewer's SnappyDiff authentication context.

Example result:

```text
Snapshot changes detected

7 changed · 2 added · 1 removed

View visual report →
```

### Authentication

Use WorkOS AuthKit for the customer-facing product:

- A WorkOS organization maps to a SnappyDiff tenant.
- SnappyDiff is multi-tenant from the first database migration, even if the initial launch has only one organization.
- Initial human roles are `viewer`, `reviewer`, and `admin`.
- Suggested permissions: `runs:view`, `runs:create`, `reports:accept`, `baselines:manage`, and `projects:admin`.
- Interactive CLI login uses OAuth device authorization.
- GitHub Actions authenticates with GitHub OIDC and does not require a stored upload secret.
- Other CI systems use scoped, expiring, revocable project tokens.
- Machine credentials receive `runs:create`; uploader is a token scope rather than a human role.
- Forked pull requests may upload only to an isolated run and never receive baseline-image credentials or management access.
- An organization may connect multiple GitHub App installations; the initial UI can connect them one at a time.

Cloudflare Access with Okta remains a simpler alternative if SnappyDiff is kept as an internal-only tool.

### Trust assumptions

- Authorized first-party CI uploaders are trusted to report screenshots, commits, parent edges, and branch metadata honestly, just as they are trusted to report unit-test results. SnappyDiff does not attest to test execution or prove that screenshots came from a particular build.
- Authorization still binds credentials to an organization, project, and repository. Claimed repository metadata cannot expand credential permissions.
- Fork-origin runs are outside this trusted-CI assumption. Their credentials permit only isolated PR uploads, never promotion or baseline-image access; a claimed branch name cannot change that classification. Milestone 0 must prove this restricted authentication flow before fork support is enabled.
- Integrity checks protect against corruption, interrupted uploads, and inconsistent retries. Immutable artifacts, resource ceilings, and access boundaries apply even to trusted CI.

## Proposed architecture

```text
Test framework
      │ creates screenshots
      ▼
SnappyDiff CLI ───── GitHub Actions OIDC / project token
      │
      │ manifest, hashes, direct uploads
      ▼
Cloudflare Worker API ───── GitHub App / Checks API
      │
      ├── D1: tenants, projects, runs, screenshots, baselines
      │
      └── R2: private original screenshot objects

Authenticated dashboard
      │
      ├── Worker API for metadata and authorization
      ├── short-lived access to private R2 objects
      └── Web Worker/Canvas for on-demand visual diffs
```

### Components

- **Worker API:** authentication, authorization, manifests, comparison, baseline selection, signed upload/download access, GitHub webhooks, and checks.
- **D1:** relational metadata. No image bytes are stored in D1.
- **R2:** private, content-addressed PNG storage with deduplication scoped to a single organization.
- **Dashboard:** static frontend deployed with the Worker or Cloudflare Pages.
- **CLI:** scans directories, hashes files, submits run manifests, and uploads missing objects.
- **GitHub App:** validates repository installations, receives webhooks, and creates or updates check runs.
- **Background processing:** D1-backed durable jobs, executed by scheduled Workers, handle verification, baseline waits, GitHub delivery, and cleanup. Request handlers may trigger immediate processing; scheduled reconciliation recovers unfinished work without a permanently running server.

## Main workflows

### Upload a run

1. The test suite generates PNG screenshots.
2. The CLI scans the configured directory and creates a manifest containing screenshot names, hashes, sizes, and dimensions.
3. The API authenticates the caller and verifies access to the project and repository.
4. The API returns upload URLs for missing verified hashes, targeting unique temporary keys rather than canonical image keys.
5. The CLI uploads missing objects directly to private R2. URLs expire after 15 minutes; unfinished sessions and temporary objects expire after 24 hours.
6. The CLI requests finalization. The API seals the manifest and records durable verification work; the CLI can poll until completion.
7. The service verifies actual uploaded bytes against SHA-256 and size, validates the PNG header and dimensions, and enforces limits. Client-written hash metadata alone is insufficient. Verification and publication must use the same object version; an intervening retry restarts verification. Milestone 0 proves this path within Worker resource limits.
8. Only the service publishes verified bytes to immutable canonical storage and records the tenant-local hash mapping. Concurrent uploads converge on one canonical image; temporary duplicates are cleaned up. Upload credentials cannot modify canonical objects.
9. Once every expected shard is verified, the service completes the run, selects a baseline, and compares screenshot names and hashes.
10. Durable delivery updates the GitHub Check with counts and a dashboard deep link.

### Run identity and completion

- Identify a run by organization, project, CI provider, workflow/build ID, and attempt number; manual uploads use a generated UUID. Commit SHA is metadata, not a run identity. Separate reruns never merge their manifests or inherit acceptance.
- Before uploading, register an immutable expected set of shard IDs. The ordinary upload command registers one shard automatically; matrix jobs share a run key and declared shard set through configuration or CLI options.
- Each shard seals a deterministic manifest. Repeating a request with the same idempotency key and content returns the existing result; different content is a conflict. Manifest pages cannot be added after sealing.
- Screenshot names are normalized relative paths and unique across the entire run. Reject duplicate names across shards rather than allowing the last upload to win.
- A run completes only after all expected shards and their image references are verified. Missing shards time out after 24 hours; failed, canceled, and timed-out runs cannot promote or produce a passing check.
- Reject empty manifests by default; an explicit allow-empty option supports intentional removal of every screenshot.
- Finalized runs and comparisons are immutable. Acceptance binds to one comparison and its run attempt; new attempts require their own result. Persist which attempt owns the current GitHub Check so late completion or acceptance of an older attempt cannot overwrite it.

### Durable work and concurrency

- Write state transitions and their pending jobs atomically in D1. Jobs have stable deduplication keys, retry counts, next-attempt times, and expiring leases for crash recovery.
- Retry transient failures with bounded exponential backoff; expose exhausted jobs and permit replay. Scheduled reconciliation repairs missing GitHub updates and resumes baseline waits and cleanup.
- External effects must be idempotent or reconciled before retrying. Persist GitHub check IDs and desired result versions; serialize updates per check and reconcile remote state after ambiguous failures.
- Promote with an atomic conditional update against the suite's baseline version, promotion mode, and observed branch-head version. If another operation wins, re-evaluate ancestry before retrying.
- Successful upload finalization remains durable even when GitHub is unavailable. The dashboard and CLI distinguish run completion from pending check delivery.

### Select a baseline

- Every project has exactly one system-created `default` suite in the initial release.
- The suite is an internal baseline stream and is not exposed in setup, dashboard, configuration, or CLI commands.
- All run attempts for a project belong to its default suite; shards combine only within the same run attempt.
- Keeping the internal suite relationship allows named suites to be added later without migrating existing runs or baselines.
- In normal operation, pull-request runs compare against the canonical complete first-party default-branch run associated with their merge base. Select the first valid completed run per commit atomically; later reruns remain inspectable but never silently replace that choice. PR runs are not baseline candidates.
- Baseline eligibility requires an available manifest and image artifacts. Expired historical candidates are skipped with a visible explanation; preserve the canonical-run identity while that commit remains tracked so expiration cannot silently make an ordinary rerun its replacement.
- If no eligible run exists for the exact merge base, wait up to two minutes through durable jobs, then choose the eligible ancestor with the shortest parent-edge distance. Break ties by commit SHA. Pin the selected baseline to the comparison permanently; a later baseline arrival does not alter an accepted report.
- Distinguish a known absence of baseline runs from missing graph history. Request graph backfill when history is incomplete; leave the comparison pending with an actionable error instead of guessing an ancestor or reporting all screenshots as added.
- The report must clearly warn when it uses an older ancestor as its baseline.
- Pull-request runs never promote themselves or change the baseline seen by other pull requests.
- A suite maintains an ordered chain of promoted default-branch runs for history and rollback.
- The first completed default-branch run automatically seeds a suite's baseline.
- A pull-request run with no baseline reports every screenshot as added and requires review.

### Review and promote changes

Pull-request acceptance and default-branch promotion are separate operations:

1. A pull-request run is compared with its pinned baseline, selected by the normal merge-base rules or an explicit rollback override.
2. If screenshots changed, the GitHub Check becomes `action_required` and links to the report.
3. A user with `reports:accept` reviews and accepts or rejects that specific report.
4. Acceptance records the reviewer and turns the pull-request check green. It does not change any suite baseline.
5. After the pull request is merged, CI produces a new run on the configured default branch.
6. When promotion is not paused, a complete, valid default-branch run is promoted automatically according to the ancestry rules and becomes that suite's active baseline.

A run is complete when all declared uploads or shards have finalized successfully. Visual equality is not required for promotion: intentional changes would otherwise be unable to become the next baseline.

Promotion must remain correct when CI jobs finish out of order:

- During ordinary promotion, never replace an active baseline with a run whose commit is an ancestor of the active run. Explicit rollback and confirmed history-reset recovery are separate operations.
- Do not promote a second run for the same commit during ordinary reruns.
- Promote a newer descendant even if intermediate commit runs have not finished.
- Ignore late intermediate runs after a newer descendant has been promoted.
- Require the candidate commit to be reachable from the latest known default-branch head.
- Record and visibly warn about a legitimate non-fast-forward promotion after a force push.

The service stores enough of the commit graph to compute merge bases and ancestry without reading repository file contents. Trusted CI submits parent edges, the captured PR head/base SHAs, the tested SHA (which may be a synthetic merge commit), and the observed default-branch head. The CLI backfills missing ancestry from Git, fetching history when its checkout is shallow; if it cannot, it reports an actionable error. OIDC/repository authorization establishes who may submit this information, not proof that tests ran honestly. GitHub events supplement branch and PR state. An out-of-order observation must not rewind the known branch head; ambiguous divergence requires refreshing branch state before automatic promotion. Milestone 0 must validate the necessary API endpoints, webhook events, and GitHub App permissions for branch refresh and PR lifecycle tracking.

Default-branch promotion creates the baseline history automatically. Users with `baselines:manage` may roll a suite back to an earlier promoted run, but routine operation does not require manual baseline approval.

### Rollback and recovery

- Rollback is an explicit temporary baseline override: atomically pin an earlier promoted run with available artifacts and pause automatic promotion. Keep the prior promotion history and canonical per-commit run choices intact.
- New PR comparisons use the pinned override instead of merge-base selection and display a rollback warning. Existing comparisons and acceptances remain unchanged; an explicit new comparison requires a fresh review when changes exist.
- An authorized resume operation clears the override and restores normal merge-base selection for new comparisons. Before resuming promotion, resolve the latest branch head and show which complete run will become active; if ancestry is incomplete, remain paused.
- A default-branch reset to an ancestor is treated as an explicit history-reset recovery, rather than an ordinary late CI result. A confirmed non-fast-forward head change starts a new promotion history segment with an audit event and visible warning.

### Review changes

1. A user follows the deep link from the GitHub Check.
2. WorkOS authenticates the user.
3. The API verifies organization and project membership.
4. The dashboard lists changed, added, and removed screenshots.
5. Opening a changed screenshot fetches the baseline and current image.
6. A browser Web Worker creates the visual diff with `OffscreenCanvas` where supported.
7. The UI offers before/after, overlay, swipe, blink, and highlighted-pixel views.

The browser-generated diff is not persisted initially.

## Security model

- R2 buckets remain private and have no public development URL.
- Tenant and project IDs are derived from authenticated context, never trusted from request bodies alone.
- Object keys are generated by the service and are not user-selected filesystem-like paths.
- Image access uses short-lived, object-specific authorization.
- Dashboard routes use opaque run and comparison IDs, followed by server-side authorization checks.
- Uploads accept an allowlist of formats, initially PNG only.
- Validate the PNG signature and content type, and record dimensions and compressed size.
- Reject SVG and active content.
- Verify GitHub webhook signatures and installation ownership.
- Give the GitHub App only permissions required by the endpoint/event inventory proven in Milestone 0: Checks writes plus repository, branch-state, and PR-lifecycle reads as needed. Do not assume metadata and Checks alone cover recovery and retention workflows.
- Store secrets in Cloudflare secrets, never in D1 or source control.
- Keep an audit trail for project membership, token changes, baseline promotion, and deletion.
- Rate-limit authentication, manifest, upload-initialization, and image-access endpoints.
- Apply retention and deletion consistently to metadata and objects.

### Retention

- Keep completed run summaries, GitHub associations, comparison counts, and audit metadata for one year from run creation.
- Keep images from unpromoted and pull-request runs for 90 days by default.
- Keep promoted-run images for the same one-year period as their run metadata.
- Never expire the active or rollback-pinned baseline, including its run metadata, manifest, image references, and images, even when older than one year.
- Pin both sides of comparisons associated with an open pull request, including the run metadata, manifests, comparison records, and images needed to render them. Retain these beyond ordinary periods until the PR closes; after closure ordinary age-based eligibility applies.
- Track PR lifecycle through webhooks and periodic reconciliation. If installation access is lost or PR state is uncertain, preserve pins and surface the unresolved retention state rather than guessing that a PR closed.
- Delete a shared image only when every run reference and retention pin across the organization has expired. Garbage collection atomically marks an unreferenced image as deleting; new attachments must wait or re-upload instead of referencing an object being removed. Reconcile interrupted deletions and orphaned temporary objects.
- When images expire before run metadata, the dashboard retains the historical result and clearly marks its image artifacts as expired.
- Deleting an organization removes its metadata and image objects after the documented recovery window, regardless of ordinary retention periods.

## Initial data model

- `organizations`: WorkOS organization mapping and policy.
- `users`: external identity mapping and display metadata.
- `memberships`: organization membership and role.
- `projects`: repository association, default branch, and retention policy.
- `suites`: one system-created default suite per project, baseline version, promotion mode, and optional rollback override; named suites are deferred.
- `commits`: repository-scoped commit identifiers and timestamps.
- `commit_edges`: parent-child relationships used for merge-base and ancestry queries.
- `runs`: immutable attempt identity, commit, branch, merge base, CI metadata, expected shard set, state, deadline, and timestamps.
- `run_shards`: shard identity, manifest digest, upload/verification state, and finalization timestamp.
- `upload_sessions`: temporary keys, expected hashes/sizes, reserved bytes, expiry, and verification state.
- `images`: SHA-256, R2 key, content type, byte size, dimensions, and reference state.
- `screenshots`: run, stable screenshot name, image reference, and optional metadata.
- `comparisons`: baseline/current run pair and added/removed/changed counts.
- `baselines`: promoted run per project/suite and promotion audit data.
- `commit_runs`: unique canonical baseline-eligible run per suite and commit.
- `retention_pins`: owning baseline or PR, pinned runs/comparisons, and release state.
- `jobs`: durable work, deduplication key, payload/version, lease, retries, and next attempt.
- `github_checks`: remote check ID, owning run attempt, desired/delivered version, and delivery state.
- `github_installations`: tenant and repository installation mapping.
- `api_tokens`: hashed token identifiers, scopes, expiry, and revocation state.
- `audit_events`: security- and baseline-related events.

All tenant-owned tables must include an organization identifier, with indexes designed so normal queries always include that identifier.

## CLI shape

Tentative commands:

```bash
snappydiff login
snappydiff projects list
snappydiff upload ./Snapshots \
  --project padeltick-ios
snappydiff status <run-id>
```

The CLI should support:

- macOS and Linux initially.
- Human-friendly and JSON output.
- Automatic GitHub Actions metadata detection.
- Upload of commit-parent edges and the observed default-branch head.
- Explicit overrides for repository, commit, branch, and merge base.
- Bounded upload concurrency and retries.
- Resumable/idempotent finalization.
- Explicit shared run keys, attempt numbers, expected shards, and shard IDs for matrix jobs.
- Upload-limit preflight checks and actionable errors for incomplete Git history or missing shards.
- Configuration through a checked-in file plus environment variables for secrets.

The CLI will be implemented as a small Rust binary.

## Milestones

### Milestone 0 — Technical spikes and decisions

- Validate WorkOS web and CLI device flows from a Worker.
- Validate GitHub Actions OIDC claims and repository binding.
- Prove private R2 temporary uploads, actual-byte verification, immutable publication, interrupted retries, and concurrent deduplication within Worker limits.
- Validate the provisional image/run ceilings and record enforced organization upload budgets.
- Prove shard registration and run-attempt separation with a matrix workflow and rerun.
- Inventory GitHub permissions and prove branch refresh, PR lifecycle reconciliation, shallow-history backfill, and restricted fork authentication before enabling forks.
- Confirm browser diff performance with representative iPhone and iPad PNGs.
- Confirm GitHub Check creation and dashboard deep links.
- Validate the Rust CLI's binary size, cross-compilation, authentication, and upload behavior.

**Exit criteria:** all external integrations are proven with disposable prototypes and their initial constraints are documented.

### Milestone 1 — Platform foundation

- Create Worker, D1, R2, and static dashboard projects.
- Add local, staging, and production environments.
- Define and migrate the initial D1 schema.
- Integrate WorkOS authentication and organization membership.
- Implement shared authorization checks and audit-event recording.
- Establish structured logs, request IDs, and basic error reporting.
- Add durable jobs, atomic state/outbox writes, leases, and scheduled reconciliation.
- Establish endpoint rate limits and organization upload budgets before enabling uploads.

**Exit criteria:** an authenticated user can create and view an organization-scoped project without crossing tenant boundaries.

### Milestone 2 — CLI upload and content deduplication

- Implement CLI authentication.
- Scan screenshot directories and build deterministic manifests.
- Calculate SHA-256 hashes while streaming files.
- Implement batch lookup of existing image hashes.
- Issue short-lived direct-upload URLs for missing images.
- Verify actual bytes, publish immutable images, and finalize runs idempotently only after all expected shards succeed.
- Enforce upload reservations, manifest/image/run ceilings, and expiration of abandoned uploads.
- Add retry, timeout, concurrency, and machine-readable output behavior.

**Exit criteria:** repeated upload of the same run transfers no duplicate image bytes and produces one consistent run.

### Milestone 3 — Baselines and GitHub Checks

- Create the GitHub App and installation flow.
- Map installations and repositories to projects.
- Verify GitHub webhooks.
- Create one internal default suite per project and implement its promoted-run semantics.
- Store commit-parent edges and compute merge bases and ancestry.
- Compare run manifests by screenshot name and SHA-256.
- Report changed, added, and removed counts.
- Implement report acceptance and rejection without mutating baselines.
- Automatically promote complete default-branch runs in ancestry order.
- Prevent same-commit reruns and late ancestor runs from replacing the active baseline.
- Publish an in-progress and final GitHub Check with a dashboard deep link.
- Handle reruns and duplicate webhooks safely.
- Pin canonical per-commit runs and comparison baselines; implement bounded baseline waiting and explicit incomplete-history errors.
- Make promotion atomic and reconcile GitHub delivery after failures without allowing stale attempts to overwrite newer results.

**Exit criteria:** a pull request receives a correct pass/fail check and links to the corresponding authenticated report.

### Milestone 4 — Visual review dashboard

- Build run history and comparison summary pages.
- Add lazy-loaded before and after images.
- Implement overlay, swipe, blink, and zoom controls.
- Implement highlighted-pixel visual diff in a browser Web Worker.
- Add keyboard navigation through changed screenshots.
- Handle dimension mismatches and decoding errors clearly.
- Verify Canvas/R2 access without exposing permanent public image URLs.

**Exit criteria:** an authorized reviewer can inspect a large changed run without server-side image processing or excessive initial downloads.

### Milestone 5 — Promotion, retention, and project management

- Add baseline-history inspection, authorized rollback overrides, paused promotion, and explicit resume behavior.
- Add warnings and recovery tooling for non-fast-forward default-branch history.
- Add configurable retention policies, metadata/artifact pins, PR-state reconciliation, and race-safe cleanup of shared R2 images.
- Add project settings and member management.
- Add scoped token creation, rotation, expiry, and revocation.
- Improve merge-base and nearest-ancestor baseline selection.

**Exit criteria:** teams can operate projects over time without manual database or object-store maintenance.

### Milestone 6 — Hardening and private beta

- Perform tenant-isolation and authorization tests.
- Test malformed images, decompression bombs, oversized manifests, and replayed requests.
- Validate and tune the existing rate limits, quotas, upload ceilings, and cost safeguards under load.
- Add backup and recovery procedures for metadata.
- Add deletion/export flows and privacy documentation.
- Load-test expected upload bursts and dashboard access.
- Document setup for GitHub, WorkOS, and the CLI.
- Onboard a small set of real repositories and collect usability data.

**Exit criteria:** the service meets the security checklist, survives expected load, and has an operational recovery path.

### Milestone 7 — Optional advanced comparison

Build only after usage demonstrates the need:

- Configurable per-pixel tolerance and changed-pixel percentage thresholds.
- Masks for dynamic regions.
- An authoritative asynchronous comparison worker.
- Cached comparison results keyed by both image hashes and comparison configuration.
- Optional sanitized inline previews in GitHub for projects that explicitly accept capability-URL access.

**Exit criteria:** tolerant comparison remains deterministic, auditable, and isolated from the upload request path.

## Testing strategy

- Unit tests for manifest comparison, baseline selection, authorization, and token scopes.
- Integration tests against local D1/R2 equivalents and staging services.
- Contract tests for WorkOS and GitHub webhook payloads.
- End-to-end test: CLI upload → comparison → GitHub Check → authenticated dashboard.
- Browser fixtures for exact matches, subtle changes, alpha, different dimensions, large images, and corrupt PNGs.
- Security regression tests proving that users, tokens, and signed URLs cannot cross organizations.
- Failure tests for corrupt/interrupted uploads, expired URLs, concurrent duplicate publication, conflicting retries, missing shards, and separate workflow attempts.
- Concurrency tests for simultaneous promotions, rollback/resume, history resets, late run completion, and stale GitHub updates.
- Recovery tests for a crash after finalization, GitHub outages, expired job leases, incomplete ancestry, and delayed baseline arrival without mutating accepted comparisons.
- Retention tests for baselines older than one year, both sides of long-lived PR reports, shared images across projects, attachment/deletion races, and lost installation access.

## Cost model and safeguards

The working hypothesis is that storage and retention dominate costs at 100,000 screenshot uploads per month. Validate this with measured image sizes, deduplication rates, verification CPU, temporary-object operations, job polling, and D1 query costs before beta; upload count alone is not a sufficient cost estimate.

Cost controls:

- Deduplicate image objects by hash.
- Keep deduplication tenant-local: projects in one organization may share an object, but organizations never do.
- Generate visual diffs only in the browser.
- Do not store derived diff images initially.
- Set project-level retention limits.
- Track stored bytes per organization and project.
- Alert on abnormal upload or download volume.

## Success metrics

- Median unchanged-run finalization under 10 seconds after uploads complete.
- One canonical stored object per tenant and image hash; temporary duplicates from concurrent uploads are reclaimed.
- GitHub Check updated within 10 seconds of comparison completion under normal operation; separately track baseline-wait time and delivery lag during external outages.
- Dashboard metadata loads before full-resolution images.
- Zero cross-tenant image or metadata access.
- Browser diff remains responsive for representative phone and tablet screenshots.
- Predictable monthly storage growth consistent with configured retention.
