import { LIMITS, isSha256, normalizeScreenshotName, type RunIdentity, type ScreenshotManifestEntry } from "@snappydiff/contracts";
import { randomId, sha256 } from "./crypto.ts";
import { HttpError, json, readJson, type RequestContext } from "./http.ts";
import { enqueueJob } from "./jobs.ts";
import type { MachinePrincipal } from "./machine-auth.ts";
import type { D1PreparedStatement, Env } from "./platform.ts";
import { createUploadTarget } from "./upload-urls.ts";

interface RegisterRunBody {
  identity?: RunIdentity;
  shardId?: unknown;
  allowEmpty?: unknown;
}

interface ManifestPageBody {
  page?: unknown;
  totalPages?: unknown;
  idempotencyKey?: unknown;
  entries?: ScreenshotManifestEntry[];
}

function assertProject(principal: MachinePrincipal, projectId: string): void {
  if (principal.projectId !== projectId) throw new HttpError(403, "project_scope_violation", "Token is not valid for this project");
}

export async function registerRun(
  request: Request,
  env: Env,
  principal: MachinePrincipal,
  projectId: string,
): Promise<Response> {
  assertProject(principal, projectId);
  const body = await readJson<RegisterRunBody>(request);
  const identity = validateIdentity(body.identity);
  const shardKey = requiredIdentifier(body.shardId, "shardId");
  if (!identity.expectedShards.includes(shardKey)) throw new HttpError(400, "unexpected_shard", "Shard is not in the immutable expected set");
  const project = await env.DB.prepare(`
    SELECT p.id, s.id AS suite_id FROM projects p JOIN suites s
      ON s.project_id = p.id AND s.organization_id = p.organization_id AND s.is_system_default = 1
     WHERE p.id = ? AND p.organization_id = ? AND p.deleted_at IS NULL
  `).bind(projectId, principal.organizationId).first<{ id: string; suite_id: string }>();
  if (!project) throw new HttpError(404, "project_not_found", "Project was not found");
  const proposedRunId = randomId("run");
  const deadline = Math.floor(Date.now() / 1000) + LIMITS.unfinishedRunSeconds;
  const inserted = await env.DB.prepare(`
    INSERT INTO runs
      (id, organization_id, project_id, suite_id, provider, provider_run_id, attempt_number, run_key,
       commit_sha, branch, merge_base_sha, observed_default_head_sha, pull_request_number, trust_class,
       expected_shards_json, allow_empty, deadline_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (organization_id, project_id, provider, provider_run_id, attempt_number) DO NOTHING
  `).bind(
    proposedRunId, principal.organizationId, projectId, project.suite_id, identity.provider, identity.providerRunId,
    identity.attemptNumber, identity.runKey, identity.commitSha, identity.branch, identity.mergeBaseSha ?? null,
    identity.observedDefaultHeadSha ?? null, identity.pullRequestNumber ?? null, identity.trustClass,
    JSON.stringify(identity.expectedShards), body.allowEmpty === true ? 1 : 0, deadline,
  ).run();
  const existing = await env.DB.prepare(`
    SELECT id, expected_shards_json, run_key, commit_sha, branch, merge_base_sha,
      observed_default_head_sha, pull_request_number, trust_class, allow_empty, state, deadline_at
      FROM runs
     WHERE organization_id = ? AND project_id = ? AND provider = ? AND provider_run_id = ? AND attempt_number = ?
  `).bind(principal.organizationId, projectId, identity.provider, identity.providerRunId, identity.attemptNumber)
    .first<{
      id: string; expected_shards_json: string; run_key: string; commit_sha: string; branch: string;
      merge_base_sha: string | null; observed_default_head_sha: string | null; pull_request_number: number | null;
      trust_class: string; allow_empty: number; state: string; deadline_at: number;
    }>();
  if (!existing) throw new Error("Run registration could not be persisted");
  const runId = existing.id;
  const matches = existing.expected_shards_json === JSON.stringify(identity.expectedShards)
      && existing.run_key === identity.runKey && existing.commit_sha === identity.commitSha
      && existing.branch === identity.branch && existing.merge_base_sha === (identity.mergeBaseSha ?? null)
      && existing.observed_default_head_sha === (identity.observedDefaultHeadSha ?? null)
      && existing.pull_request_number === (identity.pullRequestNumber ?? null)
      && existing.trust_class === identity.trustClass && existing.allow_empty === (body.allowEmpty === true ? 1 : 0);
  if (!matches) throw new HttpError(409, "run_identity_conflict", "Run attempt already exists with different immutable metadata");
  const proposedShardId = randomId("shd");
  await env.DB.prepare(`
    INSERT INTO run_shards (id, organization_id, run_id, shard_key)
    SELECT ?, ?, ?, ? FROM runs WHERE id = ? AND organization_id = ? AND state = 'open' AND deadline_at > unixepoch()
    ON CONFLICT (organization_id, run_id, shard_key) DO NOTHING
  `).bind(proposedShardId, principal.organizationId, runId, shardKey, runId, principal.organizationId).run();
  const shard = await env.DB.prepare("SELECT id, shard_key, state FROM run_shards WHERE organization_id = ? AND run_id = ? AND shard_key = ?")
    .bind(principal.organizationId, runId, shardKey).first<{ id: string; shard_key: string; state: string }>();
  if (!shard) throw new HttpError(409, "run_closed", "Run attempt is no longer open");
  return json({ run: { id: runId, state: existing.state }, shard: { id: shard.id, key: shard.shard_key, state: shard.state } },
    { status: Number(inserted.meta?.["changes"] ?? 0) === 1 ? 201 : 200 });
}

export async function submitManifestPage(
  request: Request,
  env: Env,
  principal: MachinePrincipal,
  runId: string,
  shardId: string,
): Promise<Response> {
  const body = await readJson<ManifestPageBody>(request, LIMITS.manifestPageBytes);
  const page = integer(body.page, "page", 0, 2499);
  const totalPages = integer(body.totalPages, "totalPages", 1, 2500);
  if (page >= totalPages) throw new HttpError(400, "invalid_page", "Page number must be less than totalPages");
  const idempotencyKey = requiredIdentifier(body.idempotencyKey, "idempotencyKey", 200);
  if (!Array.isArray(body.entries) || body.entries.length > 100) throw new HttpError(400, "invalid_manifest", "A manifest page must contain at most 100 entries");
  const entries = body.entries.map(validateEntry);
  const canonical = JSON.stringify(entries);
  const digest = await sha256(canonical);
  await requireOwnedRun(env, principal, runId);
  const existing = await env.DB.prepare(`
    SELECT page_number, content_digest FROM manifest_pages
     WHERE organization_id = ? AND shard_id = ? AND (page_number = ? OR idempotency_key = ?)
  `).bind(principal.organizationId, shardId, page, idempotencyKey).first<{ page_number: number; content_digest: string }>();
  if (existing) {
    if (existing.page_number !== page || existing.content_digest !== digest) throw new HttpError(409, "manifest_page_conflict", "Idempotency key or page number was reused with different content");
    return json({ page, digest, repeated: true });
  }
  await requireOpenShard(env, principal, runId, shardId);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO manifest_pages
      (id, organization_id, run_id, shard_id, page_number, total_pages, content_digest, idempotency_key, entries_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(randomId("mpg"), principal.organizationId, runId, shardId, page, totalPages, digest, idempotencyKey, canonical),
  ];
  for (const entry of entries) {
    statements.push(env.DB.prepare(`INSERT INTO manifest_entries
      (id, organization_id, run_id, shard_id, name, sha256, byte_size, width, height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(randomId("ment"), principal.organizationId, runId, shardId, entry.name, entry.sha256, entry.byteSize, entry.width, entry.height));
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "duplicate_screenshot_name", "Screenshot names must be unique across all run shards");
    if (String(error).includes("shard_not_open")) throw new HttpError(409, "shard_sealed", "Run shard is no longer open for manifest pages");
    throw error;
  }
  return json({ page, digest, repeated: false }, { status: 201 });
}

export async function finalizeShard(
  env: Env,
  principal: MachinePrincipal,
  runId: string,
  shardId: string,
): Promise<Response> {
  await requireOwnedRun(env, principal, runId);
  const shard = await env.DB.prepare("SELECT id, state FROM run_shards WHERE id = ? AND organization_id = ? AND run_id = ?")
    .bind(shardId, principal.organizationId, runId).first<{ id: string; state: string }>();
  if (!shard) throw new HttpError(404, "shard_not_found", "Run shard was not found");
  if (shard.state !== "open") return json({ shard, repeated: true });
  const preflight = await env.DB.prepare(`
    SELECT COUNT(*) AS count, MIN(total_pages) AS min_pages, MAX(total_pages) AS max_pages
      FROM manifest_pages WHERE organization_id = ? AND run_id = ? AND shard_id = ?
  `).bind(principal.organizationId, runId, shardId).first<{ count: number; min_pages: number | null; max_pages: number | null }>();
  if (!preflight || preflight.count === 0 || preflight.min_pages !== preflight.max_pages || preflight.count !== preflight.max_pages) {
    throw new HttpError(409, "manifest_incomplete", "All manifest pages must be present with one consistent total");
  }
  await env.DB.prepare("INSERT INTO shard_finalizations (organization_id, shard_id) VALUES (?, ?) ON CONFLICT DO NOTHING")
    .bind(principal.organizationId, shardId).run();
  const leaseOwner = randomId("seal");
  const claim = await env.DB.prepare(`
    UPDATE shard_finalizations SET lease_owner = ?, lease_expires_at = unixepoch() + 300
     WHERE organization_id = ? AND shard_id = ? AND (lease_owner IS NULL OR lease_expires_at < unixepoch())
  `).bind(leaseOwner, principal.organizationId, shardId).run();
  if (Number(claim.meta?.["changes"] ?? 0) !== 1) return json({ shard: { ...shard, state: "sealing" }, repeated: true }, { status: 202 });
  const pages = await env.DB.prepare(`
    SELECT COUNT(*) AS count, MIN(total_pages) AS min_pages, MAX(total_pages) AS max_pages
      FROM manifest_pages WHERE organization_id = ? AND run_id = ? AND shard_id = ?
  `).bind(principal.organizationId, runId, shardId).first<{ count: number; min_pages: number | null; max_pages: number | null }>();
  if (!pages || pages.count === 0 || pages.min_pages !== pages.max_pages || pages.count !== pages.max_pages) {
    await releaseFinalizationLease(env, principal.organizationId, shardId, leaseOwner);
    throw new HttpError(409, "manifest_incomplete", "Manifest changed before it could be sealed");
  }
  const totals = await env.DB.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes
      FROM manifest_entries WHERE organization_id = ? AND run_id = ?
  `).bind(principal.organizationId, runId).first<{ count: number; bytes: number }>();
  if (!totals || totals.count > LIMITS.screenshotsPerRun || totals.bytes > LIMITS.logicalRunBytes) {
    await failFinalization(env, principal.organizationId, runId, shardId);
    throw new HttpError(413, "run_limit_exceeded", "Run exceeds screenshot count or logical byte limits");
  }
  const inconsistent = await env.DB.prepare(`
    SELECT sha256 FROM manifest_entries WHERE organization_id = ? AND run_id = ?
     GROUP BY sha256 HAVING MIN(byte_size) != MAX(byte_size) OR MIN(width) != MAX(width) OR MIN(height) != MAX(height)
     LIMIT 1
  `).bind(principal.organizationId, runId).first();
  if (inconsistent) {
    await failFinalization(env, principal.organizationId, runId, shardId);
    throw new HttpError(409, "hash_metadata_conflict", "The same hash was declared with inconsistent metadata");
  }
  const canonicalMismatch = await env.DB.prepare(`
    SELECT m.sha256 FROM manifest_entries m JOIN images i
      ON i.organization_id = m.organization_id AND i.sha256 = m.sha256 AND i.reference_state = 'active'
     WHERE m.organization_id = ? AND m.run_id = ?
       AND (m.byte_size != i.byte_size OR m.width != i.width OR m.height != i.height) LIMIT 1
  `).bind(principal.organizationId, runId).first();
  if (canonicalMismatch) {
    await failFinalization(env, principal.organizationId, runId, shardId);
    throw new HttpError(409, "canonical_metadata_conflict", "Manifest metadata does not match the verified canonical image");
  }
  await env.DB.prepare(`
    UPDATE manifest_entries SET image_id = (
      SELECT id FROM images WHERE images.organization_id = manifest_entries.organization_id
        AND images.sha256 = manifest_entries.sha256 AND images.reference_state = 'active'
    ) WHERE organization_id = ? AND run_id = ? AND shard_id = ? AND image_id IS NULL
      AND EXISTS (SELECT 1 FROM images WHERE images.organization_id = manifest_entries.organization_id
        AND images.sha256 = manifest_entries.sha256 AND images.reference_state = 'active')
  `).bind(principal.organizationId, runId, shardId).run();
  const missing = await env.DB.prepare(`
    SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM (
      SELECT sha256, MAX(byte_size) AS byte_size FROM manifest_entries
       WHERE organization_id = ? AND run_id = ? AND shard_id = ? AND image_id IS NULL GROUP BY sha256
    )
  `).bind(principal.organizationId, runId, shardId).first<{ bytes: number }>();
  const missingBytes = missing?.bytes ?? 0;
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [];
  if (missingBytes > 0) {
    statements.push(env.DB.prepare(`
      UPDATE organization_usage SET reserved_upload_bytes = reserved_upload_bytes + ?, updated_at = unixepoch()
       WHERE organization_id = ?
    `).bind(missingBytes, principal.organizationId));
    statements.push(env.DB.prepare(`
      INSERT INTO upload_sessions
        (id, organization_id, project_id, run_id, shard_id, expected_sha256, expected_bytes, temporary_key, reserved_bytes, expires_at)
      SELECT 'upl_' || lower(hex(randomblob(16))), m.organization_id, r.project_id, m.run_id, m.shard_id,
        m.sha256, MAX(m.byte_size), 'tmp/' || m.organization_id || '/' || m.run_id || '/' || m.sha256 || '/' || lower(hex(randomblob(16))),
        MAX(m.byte_size), ?
      FROM manifest_entries m JOIN runs r ON r.id = m.run_id AND r.organization_id = m.organization_id
      WHERE m.organization_id = ? AND m.run_id = ? AND m.shard_id = ? AND m.image_id IS NULL
      GROUP BY m.organization_id, r.project_id, m.run_id, m.shard_id, m.sha256
      ON CONFLICT (organization_id, run_id, shard_id, expected_sha256) DO NOTHING
    `).bind(now + LIMITS.temporaryObjectSeconds, principal.organizationId, runId, shardId));
  }
  statements.push(env.DB.prepare(`
    UPDATE run_shards SET state = ?, expected_pages = ?, received_pages = ?, finalized_at = unixepoch(), updated_at = unixepoch()
     WHERE organization_id = ? AND id = ? AND state = 'open'
       AND EXISTS (SELECT 1 FROM shard_finalizations WHERE organization_id = ? AND shard_id = ? AND lease_owner = ?)
  `).bind(missingBytes === 0 ? "verified" : "verifying", pages.max_pages, pages.count,
    principal.organizationId, shardId, principal.organizationId, shardId, leaseOwner));
  if (missingBytes === 0) {
    statements.push(env.DB.prepare(`
      INSERT INTO jobs (id, organization_id, kind, deduplication_key, payload_json)
      VALUES (?, ?, 'complete_run', ?, ?) ON CONFLICT (organization_id, deduplication_key) DO NOTHING
    `).bind(randomId("job"), principal.organizationId, `complete:${runId}:${shardId}`, JSON.stringify({ runId })));
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    await releaseFinalizationLease(env, principal.organizationId, shardId, leaseOwner);
    if (String(error).includes("CHECK constraint failed")) throw new HttpError(429, "upload_budget_exceeded", "Organization upload budget is exhausted");
    throw error;
  }
  return json({ shard: { id: shard.id, state: missingBytes === 0 ? "verified" : "verifying" }, missingBytes });
}

async function releaseFinalizationLease(env: Env, organizationId: string, shardId: string, leaseOwner: string): Promise<void> {
  await env.DB.prepare("UPDATE shard_finalizations SET lease_owner = NULL, lease_expires_at = NULL WHERE organization_id = ? AND shard_id = ? AND lease_owner = ?")
    .bind(organizationId, shardId, leaseOwner).run();
}

async function failFinalization(env: Env, organizationId: string, runId: string, shardId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE run_shards SET state = 'failed', updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND state = 'open'")
      .bind(shardId, organizationId),
    env.DB.prepare("UPDATE runs SET state = 'failed', updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND state = 'open'")
      .bind(runId, organizationId),
  ]);
}

export async function listShardUploads(
  env: Env,
  principal: MachinePrincipal,
  runId: string,
  shardId: string,
  after: string | null,
): Promise<Response> {
  await requireOwnedRun(env, principal, runId);
  const result = await env.DB.prepare(`
    SELECT id, temporary_key, expected_bytes, expected_sha256, state
      FROM upload_sessions WHERE organization_id = ? AND run_id = ? AND shard_id = ? AND id > ?
      ORDER BY id LIMIT 101
  `).bind(principal.organizationId, runId, shardId, after ?? "").all<{
    id: string; temporary_key: string; expected_bytes: number; expected_sha256: string; state: string;
  }>();
  const rows = result.results ?? [];
  const page = rows.slice(0, 100);
  const uploads = [];
  for (const row of page) {
    const target = row.state === "pending" || row.state === "uploaded"
      ? await createUploadTarget(env, { id: row.id, organizationId: principal.organizationId, temporaryKey: row.temporary_key, expectedBytes: row.expected_bytes })
      : null;
    uploads.push({ id: row.id, sha256: row.expected_sha256, byteSize: row.expected_bytes, state: row.state, target });
  }
  return json({ uploads, nextCursor: rows.length > 100 ? page.at(-1)?.id : null });
}

export async function completeUpload(
  env: Env,
  principal: MachinePrincipal,
  uploadId: string,
): Promise<Response> {
  const upload = await env.DB.prepare(`
    SELECT id, run_id, temporary_key, expected_bytes, state FROM upload_sessions
     WHERE id = ? AND organization_id = ? AND project_id = ? AND expires_at > unixepoch()
  `).bind(uploadId, principal.organizationId, principal.projectId).first<{
    id: string; run_id: string; temporary_key: string; expected_bytes: number; state: string;
  }>();
  if (!upload) throw new HttpError(404, "upload_not_found", "Upload session was not found");
  if (upload.state === "published") return json({ accepted: true, repeated: true });
  const object = await env.IMAGES.head(upload.temporary_key);
  if (!object || object.size !== upload.expected_bytes) throw new HttpError(409, "upload_incomplete", "Uploaded object is missing or has the wrong byte size");
  await env.DB.prepare("UPDATE upload_sessions SET state = 'uploaded', object_version = ?, upload_completed_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND state IN ('pending', 'uploaded')")
    .bind(object.version, uploadId, principal.organizationId).run();
  await enqueueJob(env, principal.organizationId, "verify_upload", `verify:${uploadId}:${object.version}`, { uploadId, objectVersion: object.version });
  return json({ accepted: true, repeated: upload.state === "uploaded" }, { status: 202 });
}

export async function getRunStatus(env: Env, principal: MachinePrincipal, runId: string): Promise<Response> {
  const run = await requireOwnedRun(env, principal, runId);
  const shards = await env.DB.prepare("SELECT id, shard_key AS key, state FROM run_shards WHERE organization_id = ? AND run_id = ? ORDER BY shard_key")
    .bind(principal.organizationId, runId).all();
  return json({ run, shards: shards.results ?? [] });
}

async function requireOwnedRun(env: Env, principal: MachinePrincipal, runId: string): Promise<Record<string, unknown>> {
  const run = await env.DB.prepare(`
    SELECT id, state, commit_sha AS commitSha, branch, screenshot_count AS screenshotCount,
      logical_bytes AS logicalBytes, created_at AS createdAt, completed_at AS completedAt
      FROM runs WHERE id = ? AND organization_id = ? AND project_id = ?
  `).bind(runId, principal.organizationId, principal.projectId).first<Record<string, unknown>>();
  if (!run) throw new HttpError(404, "run_not_found", "Run was not found");
  return run;
}

async function requireOpenShard(
  env: Env,
  principal: MachinePrincipal,
  runId: string,
  shardId: string,
): Promise<{ id: string; state: string }> {
  await requireOwnedRun(env, principal, runId);
  const shard = await env.DB.prepare(`
    SELECT s.id, s.state FROM run_shards s JOIN runs r ON r.id = s.run_id AND r.organization_id = s.organization_id
     WHERE s.id = ? AND s.organization_id = ? AND s.run_id = ? AND s.state = 'open'
       AND r.state = 'open' AND r.deadline_at > unixepoch()
  `)
    .bind(shardId, principal.organizationId, runId).first<{ id: string; state: string }>();
  if (!shard) throw new HttpError(404, "shard_not_found", "Run shard was not found");
  return shard;
}

function validateIdentity(value: RunIdentity | undefined): RunIdentity {
  if (!value || !["github_actions", "manual", "other"].includes(value.provider)) throw new HttpError(400, "invalid_run_identity", "Run provider is invalid");
  const fields = [value.providerRunId, value.runKey, value.commitSha, value.branch];
  if (fields.some((field) => typeof field !== "string" || field.length < 1 || field.length > 255)) throw new HttpError(400, "invalid_run_identity", "Run identity contains invalid strings");
  if (!Number.isSafeInteger(value.attemptNumber) || value.attemptNumber < 1) throw new HttpError(400, "invalid_run_identity", "Attempt number must be positive");
  if (!Array.isArray(value.expectedShards) || value.expectedShards.length < 1 || value.expectedShards.length > 256) throw new HttpError(400, "invalid_run_identity", "Expected shards must contain 1 to 256 items");
  const shards = value.expectedShards.map((item) => requiredIdentifier(item, "expectedShards"));
  if (new Set(shards).size !== shards.length) throw new HttpError(400, "invalid_run_identity", "Expected shard IDs must be unique");
  if (value.trustClass !== "first_party" && value.trustClass !== "fork_isolated") throw new HttpError(400, "invalid_run_identity", "Trust class is invalid");
  return { ...value, expectedShards: [...shards].sort() };
}

function validateEntry(entry: ScreenshotManifestEntry, index: number): ScreenshotManifestEntry {
  if (!entry || typeof entry !== "object") throw new HttpError(400, "invalid_manifest", `Entry ${index} is invalid`);
  let name: string;
  try { name = normalizeScreenshotName(entry.name); } catch { throw new HttpError(400, "invalid_manifest", `Entry ${index} has an unsafe name`); }
  if (!name.toLowerCase().endsWith(".png") || !isSha256(entry.sha256)) throw new HttpError(400, "invalid_manifest", `Entry ${index} must be a PNG with a SHA-256 hash`);
  const byteSize = integer(entry.byteSize, `entries[${index}].byteSize`, 1, LIMITS.compressedImageBytes);
  const width = integer(entry.width, `entries[${index}].width`, 1, LIMITS.imageAxisPixels);
  const height = integer(entry.height, `entries[${index}].height`, 1, LIMITS.imageAxisPixels);
  if (width * height > LIMITS.decodedImagePixels) throw new HttpError(400, "invalid_manifest", `Entry ${index} exceeds decoded pixel limits`);
  return { name, sha256: entry.sha256, byteSize, width, height };
}

function requiredIdentifier(value: unknown, field: string, maximum = 100): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(value) || value.length > maximum) throw new HttpError(400, "invalid_request", `${field} is invalid`);
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new HttpError(400, "invalid_request", `${field} must be an integer between ${minimum} and ${maximum}`);
  return value as number;
}
