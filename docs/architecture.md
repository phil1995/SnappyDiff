# Architecture decisions

## Runtime boundaries

The API is a stateless Cloudflare Worker. D1 transactions are the consistency boundary for tenant-owned metadata, state transitions, and job outbox records. R2 is private and stores temporary uploads plus immutable canonical PNG objects. Scheduled Worker invocations lease and execute durable jobs; request handlers may opportunistically drain the same queue.

The dashboard is a static single-page application served by the Worker asset binding. It requests metadata from same-origin `/api` routes and obtains short-lived, object-specific image responses after server-side authorization. It never receives R2 credentials.

The CLI is a Rust binary. It performs local PNG validation, hashing, manifest construction, Git metadata collection, and bounded parallel upload. Provider authentication is exchanged for a narrow SnappyDiff session; cloud provider secrets never reach the CLI.

## Tenant isolation

Every tenant-owned table contains `organization_id`. Repository queries are shaped from authenticated context and include that identifier. IDs supplied in URLs locate candidates but never establish authorization. Content-addressed object keys include a service-generated organization namespace, so equal bytes in two organizations remain separate objects.

## External integration ports

WorkOS, GitHub, and object signing live behind small interfaces. Production adapters read Worker bindings; tests use deterministic in-memory fakes. This permits complete domain testing without credentials and keeps provider changes outside core run and baseline logic.

## Consistency rules

- Finalized manifests, comparisons, and run attempts are immutable.
- State changes and jobs are written in one D1 transaction.
- Every retryable mutation carries an idempotency or deduplication key.
- Temporary uploads are verified from bytes before canonical publication.
- GitHub delivery persists desired and delivered versions and rejects stale attempt updates.
- Promotion uses compare-and-swap against the suite baseline version and known branch head.

## Deployability

Each environment receives distinct D1, R2, GitHub App, and WorkOS configuration. Wrangler configuration contains binding names and placeholders only. Deployment is intentionally a separate operator action; CI runs checks and can prepare artifacts without possessing production secrets.

