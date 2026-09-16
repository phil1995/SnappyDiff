import { randomId, sha256 } from "./crypto.ts";
import type { PendingJob } from "./jobs.ts";
import type { Env } from "./platform.ts";

interface VerificationPayload {
  uploadId: string;
  objectVersion: string;
}

export async function verifyUploadJob(env: Env, job: PendingJob): Promise<void> {
  const payload = JSON.parse(job.payload_json) as VerificationPayload;
  const upload = await env.DB.prepare(`
    SELECT u.id, u.organization_id, u.run_id, u.shard_id, u.expected_sha256, u.expected_bytes,
      u.temporary_key, u.object_version, u.reserved_bytes, u.state,
      MIN(m.width) AS width, MIN(m.height) AS height
    FROM upload_sessions u JOIN manifest_entries m
      ON m.organization_id = u.organization_id AND m.run_id = u.run_id AND m.shard_id = u.shard_id
      AND m.sha256 = u.expected_sha256
    WHERE u.id = ? AND u.organization_id = ?
    GROUP BY u.id
  `).bind(payload.uploadId, job.organization_id).first<{
    id: string; organization_id: string; run_id: string; shard_id: string; expected_sha256: string;
    expected_bytes: number; temporary_key: string; object_version: string; reserved_bytes: number;
    state: string; width: number; height: number;
  }>();
  if (!upload || upload.state === "failed" || upload.state === "expired") return;
  if (upload.object_version !== payload.objectVersion) return;
  if (await organizationDeletionPending(env, upload.organization_id)) return;
  if (upload.state === "published") {
    await ensureCanonicalObject(env, upload, payload.objectVersion);
    await ensureShardCompletionOutbox(env, upload);
    return;
  }
  const claim = await env.DB.prepare(`
    UPDATE upload_sessions SET state = 'verifying', updated_at = unixepoch()
     WHERE id = ? AND organization_id = ? AND object_version = ? AND state IN ('uploaded', 'verifying')
  `).bind(upload.id, upload.organization_id, payload.objectVersion).run();
  if (Number(claim.meta?.["changes"] ?? 0) !== 1) return;
  const object = await env.IMAGES.get(upload.temporary_key);
  if (!object || object.version !== payload.objectVersion || object.size !== upload.expected_bytes) throw new Error("Uploaded object is missing or changed");
  const bytes = await object.arrayBuffer();
  const actualHash = await sha256(bytes);
  if (object.httpMetadata?.contentType !== "image/png" || actualHash !== upload.expected_sha256) {
    await failUpload(env, upload, payload.objectVersion, "Uploaded object content type or SHA-256 does not match manifest");
    return;
  }
  let dimensions: { width: number; height: number };
  try {
    dimensions = parsePngDimensions(new Uint8Array(bytes));
  } catch (error) {
    await failUpload(env, upload, payload.objectVersion, String(error));
    return;
  }
  if (dimensions.width !== upload.width || dimensions.height !== upload.height) {
    await failUpload(env, upload, payload.objectVersion, "Uploaded PNG dimensions do not match manifest");
    return;
  }

  const deleting = await env.DB.prepare("SELECT 1 AS found FROM images WHERE organization_id = ? AND sha256 = ? AND reference_state = 'deleting'")
    .bind(upload.organization_id, actualHash).first();
  if (deleting) throw new Error("Canonical image deletion is in progress; verification will retry");

  const imageId = randomId("img");
  const canonicalKey = `org/${upload.organization_id}/sha256/${actualHash.slice(0, 2)}/${actualHash}-${imageId}.png`;
  await env.DB.prepare(`
    INSERT INTO image_publications (organization_id, sha256, image_id, r2_key, byte_size, width, height)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM images WHERE organization_id = ? AND sha256 = ? AND reference_state = 'active'
    ) ON CONFLICT (organization_id, sha256) DO NOTHING
  `).bind(upload.organization_id, actualHash, imageId, canonicalKey, upload.expected_bytes,
    dimensions.width, dimensions.height, upload.organization_id, actualHash).run();
  const publication = await env.DB.prepare(`
    SELECT image_id, r2_key FROM image_publications
     WHERE organization_id = ? AND sha256 = ? AND deletion_owner IS NULL
       AND NOT EXISTS (SELECT 1 FROM organization_deletion_requests WHERE organization_id = ?)
  `).bind(upload.organization_id, actualHash, upload.organization_id).first<{ image_id: string; r2_key: string }>();
  if (publication) {
    await env.IMAGES.put(publication.r2_key, bytes, {
      httpMetadata: { contentType: "image/png" }, customMetadata: { sha256: actualHash },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (await organizationDeletionPending(env, upload.organization_id)) {
      await env.IMAGES.delete(publication.r2_key);
      throw new Error("Organization deletion began during image publication");
    }
    const stillOwned = await env.DB.prepare(`SELECT 1 AS found FROM image_publications
      WHERE organization_id = ? AND sha256 = ? AND image_id = ? AND r2_key = ? AND deletion_owner IS NULL
        AND NOT EXISTS (SELECT 1 FROM organization_deletion_requests WHERE organization_id = ?)`)
      .bind(upload.organization_id, actualHash, publication.image_id, publication.r2_key, upload.organization_id).first();
    if (!stillOwned) {
      if (await organizationDeletionPending(env, upload.organization_id)) {
        await env.IMAGES.delete(publication.r2_key);
        throw new Error("Organization deletion began during image publication");
      }
      const activated = await env.DB.prepare(`SELECT 1 AS found FROM images
        WHERE organization_id = ? AND sha256 = ? AND r2_key = ? AND reference_state = 'active'`)
        .bind(upload.organization_id, actualHash, publication.r2_key).first();
      if (!activated) {
        await env.IMAGES.delete(publication.r2_key);
        throw new Error("Image publication was retired while uploading; verification will retry");
      }
    }
  }
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE organization_usage SET
        stored_bytes = stored_bytes + CASE WHEN NOT EXISTS (
          SELECT 1 FROM images WHERE organization_id = ? AND sha256 = ?
        ) AND EXISTS (SELECT 1 FROM image_publications
          WHERE organization_id = ? AND sha256 = ? AND deletion_owner IS NULL)
        AND NOT EXISTS (SELECT 1 FROM organization_deletion_requests WHERE organization_id = ?)
        THEN ? ELSE 0 END, updated_at = unixepoch()
       WHERE organization_id = ? AND EXISTS (
         SELECT 1 FROM upload_sessions WHERE id = ? AND organization_id = ?
           AND state = 'verifying' AND object_version = ?
       )
    `).bind(upload.organization_id, actualHash, upload.organization_id, actualHash, upload.organization_id,
      upload.expected_bytes,
      upload.organization_id, upload.id, upload.organization_id, payload.objectVersion),
    env.DB.prepare(`
      INSERT INTO images (id, organization_id, sha256, r2_key, content_type, byte_size, width, height)
      SELECT p.image_id, p.organization_id, p.sha256, p.r2_key, p.content_type, p.byte_size, p.width, p.height
        FROM image_publications p
       WHERE p.organization_id = ? AND p.sha256 = ? AND p.deletion_owner IS NULL
         AND NOT EXISTS (SELECT 1 FROM organization_deletion_requests WHERE organization_id = p.organization_id)
         AND EXISTS (
         SELECT 1 FROM upload_sessions WHERE id = ? AND organization_id = ?
           AND state = 'verifying' AND object_version = ?
       ) ON CONFLICT (organization_id, sha256) DO NOTHING
    `).bind(upload.organization_id, actualHash, upload.id, upload.organization_id, payload.objectVersion),
    env.DB.prepare(`
      UPDATE manifest_entries SET image_id = (
        SELECT id FROM images WHERE organization_id = ? AND sha256 = ? AND reference_state = 'active'
      )
       WHERE organization_id = ? AND run_id = ? AND shard_id = ? AND sha256 = ? AND image_id IS NULL
         AND EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND organization_id = ?
           AND state = 'verifying' AND object_version = ?)
    `).bind(upload.organization_id, actualHash, upload.organization_id, upload.run_id, upload.shard_id, actualHash,
      upload.id, upload.organization_id, payload.objectVersion),
    env.DB.prepare(`
      UPDATE upload_sessions SET state = 'published', updated_at = unixepoch()
       WHERE id = ? AND organization_id = ? AND state = 'verifying' AND object_version = ?
         AND NOT EXISTS (SELECT 1 FROM manifest_entries WHERE organization_id = ? AND run_id = ?
           AND shard_id = ? AND sha256 = ? AND image_id IS NULL)
    `).bind(upload.id, upload.organization_id, payload.objectVersion, upload.organization_id,
      upload.run_id, upload.shard_id, actualHash),
    env.DB.prepare(`
      UPDATE organization_usage SET reserved_upload_bytes = reserved_upload_bytes - ?, updated_at = unixepoch()
       WHERE organization_id = ? AND EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND organization_id = ?
         AND state = 'published' AND object_version = ? AND reservation_released_at IS NULL)
    `).bind(upload.reserved_bytes, upload.organization_id, upload.id, upload.organization_id, payload.objectVersion),
    env.DB.prepare(`UPDATE upload_sessions SET reservation_released_at = unixepoch(), updated_at = unixepoch()
      WHERE id = ? AND organization_id = ? AND state = 'published' AND object_version = ?
        AND reservation_released_at IS NULL`).bind(upload.id, upload.organization_id, payload.objectVersion),
    env.DB.prepare(`DELETE FROM image_publications WHERE organization_id = ? AND sha256 = ?
      AND EXISTS (SELECT 1 FROM images WHERE organization_id = ? AND sha256 = ? AND reference_state = 'active')`)
      .bind(upload.organization_id, actualHash, upload.organization_id, actualHash),
  ]);
  const published = await env.DB.prepare(`SELECT 1 AS found FROM upload_sessions
    WHERE id = ? AND organization_id = ? AND state = 'published' AND object_version = ?`)
    .bind(upload.id, upload.organization_id, payload.objectVersion).first();
  if (!published) throw new Error("Canonical image publication was contended; verification will retry");
  await ensureCanonicalObject(env, upload, payload.objectVersion, bytes);
  await ensureShardCompletionOutbox(env, upload);
}

async function ensureCanonicalObject(
  env: Env,
  upload: { organization_id: string; run_id: string; shard_id: string; expected_sha256: string;
    expected_bytes: number; temporary_key: string },
  objectVersion: string,
  verifiedBytes?: ArrayBuffer,
): Promise<string> {
  const image = await env.DB.prepare(`
    SELECT i.r2_key FROM images i JOIN manifest_entries m
      ON m.organization_id = i.organization_id AND m.image_id = i.id
     WHERE m.organization_id = ? AND m.run_id = ? AND m.shard_id = ? AND m.sha256 = ?
       AND i.reference_state = 'active' LIMIT 1
  `).bind(upload.organization_id, upload.run_id, upload.shard_id, upload.expected_sha256)
    .first<{ r2_key: string }>();
  if (!image) throw new Error("Published upload is not attached to an active canonical image");
  if (await env.IMAGES.head(image.r2_key)) return image.r2_key;
  let bytes = verifiedBytes;
  if (!bytes) {
    const temporary = await env.IMAGES.get(upload.temporary_key);
    if (!temporary || temporary.version !== objectVersion || temporary.size !== upload.expected_bytes) {
      throw new Error("Canonical image is missing and the verified temporary object is unavailable");
    }
    bytes = await temporary.arrayBuffer();
    if (await sha256(bytes) !== upload.expected_sha256) throw new Error("Temporary object changed after verification");
  }
  await env.IMAGES.put(image.r2_key, bytes, {
    httpMetadata: { contentType: "image/png" }, customMetadata: { sha256: upload.expected_sha256 },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (await organizationDeletionPending(env, upload.organization_id)) {
    await env.IMAGES.delete(image.r2_key);
    throw new Error("Organization deletion began while restoring a canonical image");
  }
  return image.r2_key;
}

async function organizationDeletionPending(env: Env, organizationId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT 1 AS found FROM organization_deletion_requests
    WHERE organization_id = ?`).bind(organizationId).first());
}

function completionJobStatement(
  env: Env,
  upload: { organization_id: string; run_id: string; shard_id: string },
) {
  return env.DB.prepare(`
    INSERT INTO jobs (id, organization_id, kind, deduplication_key, payload_json)
    SELECT ?, ?, 'complete_run', ?, ? WHERE EXISTS (
      SELECT 1 FROM run_shards WHERE id = ? AND organization_id = ? AND state = 'verified'
    ) ON CONFLICT (organization_id, deduplication_key) DO NOTHING
  `).bind(randomId("job"), upload.organization_id, `complete:${upload.run_id}:${upload.shard_id}`,
    JSON.stringify({ runId: upload.run_id }), upload.shard_id, upload.organization_id);
}

async function ensureShardCompletionOutbox(
  env: Env,
  upload: { organization_id: string; run_id: string; shard_id: string },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE run_shards SET state = 'verified', updated_at = unixepoch()
       WHERE id = ? AND organization_id = ? AND state = 'verifying'
         AND NOT EXISTS (SELECT 1 FROM manifest_entries WHERE organization_id = ? AND run_id = ? AND shard_id = ? AND image_id IS NULL)
    `).bind(upload.shard_id, upload.organization_id, upload.organization_id, upload.run_id, upload.shard_id),
    completionJobStatement(env, upload),
  ]);
}

async function failUpload(
  env: Env,
  upload: { id: string; organization_id: string; run_id: string; shard_id: string; reserved_bytes: number },
  objectVersion: string,
  reason: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE organization_usage SET reserved_upload_bytes = reserved_upload_bytes - ?, updated_at = unixepoch()
       WHERE organization_id = ? AND EXISTS (SELECT 1 FROM upload_sessions
         WHERE id = ? AND organization_id = ? AND state = 'verifying' AND object_version = ?
           AND reservation_released_at IS NULL)
    `).bind(upload.reserved_bytes, upload.organization_id, upload.id, upload.organization_id, objectVersion),
    env.DB.prepare(`
      UPDATE run_shards SET state = 'failed', updated_at = unixepoch() WHERE id = ? AND organization_id = ?
       AND EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND organization_id = ? AND state = 'verifying' AND object_version = ?)
    `).bind(upload.shard_id, upload.organization_id, upload.id, upload.organization_id, objectVersion),
    env.DB.prepare(`
      UPDATE runs SET state = 'failed', updated_at = unixepoch() WHERE id = ? AND organization_id = ?
       AND EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND organization_id = ? AND state = 'verifying' AND object_version = ?)
    `).bind(upload.run_id, upload.organization_id, upload.id, upload.organization_id, objectVersion),
    env.DB.prepare("UPDATE upload_sessions SET state = 'failed', updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND state = 'verifying' AND object_version = ?")
      .bind(upload.id, upload.organization_id, objectVersion),
    env.DB.prepare(`UPDATE upload_sessions SET reservation_released_at = unixepoch(), updated_at = unixepoch()
      WHERE id = ? AND organization_id = ? AND state = 'failed' AND object_version = ?
        AND reservation_released_at IS NULL`).bind(upload.id, upload.organization_id, objectVersion),
  ]);
  console.warn(JSON.stringify({ level: "warn", event: "upload_verification_failed", uploadId: upload.id, reason }));
}

export async function completeRunJob(env: Env, job: PendingJob): Promise<void> {
  const { runId } = JSON.parse(job.payload_json) as { runId: string };
  const run = await env.DB.prepare(`
    SELECT id, organization_id, expected_shards_json, allow_empty, state FROM runs
     WHERE id = ? AND organization_id = ?
  `).bind(runId, job.organization_id).first<{
    id: string; organization_id: string; expected_shards_json: string; allow_empty: number; state: string;
  }>();
  if (!run || run.state === "complete") return;
  const expected = (JSON.parse(run.expected_shards_json) as string[]).length;
  const shardCounts = await env.DB.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'verified' THEN 1 ELSE 0 END) AS verified
      FROM run_shards WHERE organization_id = ? AND run_id = ?
  `).bind(run.organization_id, runId).first<{ total: number; verified: number }>();
  if (!shardCounts || shardCounts.total !== expected || shardCounts.verified !== expected) return;
  const totals = await env.DB.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM manifest_entries WHERE organization_id = ? AND run_id = ?")
    .bind(run.organization_id, runId).first<{ count: number; bytes: number }>();
  if (!totals || (totals.count === 0 && run.allow_empty !== 1)) {
    await env.DB.prepare("UPDATE runs SET state = 'failed', updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND state IN ('open', 'verifying')")
      .bind(runId, run.organization_id).run();
    return;
  }
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO screenshots (organization_id, run_id, shard_id, name, image_id)
      SELECT organization_id, run_id, shard_id, name, image_id FROM manifest_entries
       WHERE organization_id = ? AND run_id = ? AND image_id IS NOT NULL
      ON CONFLICT (organization_id, run_id, name) DO NOTHING
    `).bind(run.organization_id, runId),
    env.DB.prepare(`
      UPDATE runs SET state = 'complete', screenshot_count = ?, logical_bytes = ?,
        completed_at = unixepoch(), updated_at = unixepoch()
      WHERE id = ? AND organization_id = ? AND state IN ('open', 'verifying')
    `).bind(totals.count, totals.bytes, runId, run.organization_id),
    env.DB.prepare(`
      INSERT INTO jobs (id, organization_id, kind, deduplication_key, payload_json)
      VALUES (?, ?, 'select_baseline', ?, ?) ON CONFLICT (organization_id, deduplication_key) DO NOTHING
    `).bind(randomId("job"), run.organization_id, `baseline:${runId}`, JSON.stringify({ runId })),
  ]);
}

export function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) throw new Error("Uploaded object is not a PNG");
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") throw new Error("PNG is missing its IHDR chunk");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 40_000_000) {
    throw new Error("PNG dimensions exceed configured limits");
  }
  return { width, height };
}
