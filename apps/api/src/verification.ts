import { randomId, sha256 } from "./crypto.ts";
import { enqueueJob, type PendingJob } from "./jobs.ts";
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
  if (!upload || upload.state === "published" || upload.state === "failed") return;
  if (upload.object_version !== payload.objectVersion) return;
  const object = await env.IMAGES.get(upload.temporary_key);
  if (!object || object.version !== payload.objectVersion || object.size !== upload.expected_bytes) throw new Error("Uploaded object is missing or changed");
  const bytes = await object.arrayBuffer();
  const actualHash = await sha256(bytes);
  if (object.httpMetadata?.contentType !== "image/png" || actualHash !== upload.expected_sha256) {
    await failUpload(env, upload, "Uploaded object content type or SHA-256 does not match manifest");
    return;
  }
  let dimensions: { width: number; height: number };
  try {
    dimensions = parsePngDimensions(new Uint8Array(bytes));
  } catch (error) {
    await failUpload(env, upload, String(error));
    return;
  }
  if (dimensions.width !== upload.width || dimensions.height !== upload.height) {
    await failUpload(env, upload, "Uploaded PNG dimensions do not match manifest");
    return;
  }

  const canonicalKey = `org/${upload.organization_id}/sha256/${actualHash.slice(0, 2)}/${actualHash}.png`;
  await env.IMAGES.put(canonicalKey, bytes, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { sha256: actualHash },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  const imageId = `img_${(await sha256(`${upload.organization_id}:${actualHash}`)).slice(0, 32)}`;
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE organization_usage SET stored_bytes = stored_bytes + ?, updated_at = unixepoch()
       WHERE organization_id = ? AND NOT EXISTS (
         SELECT 1 FROM images WHERE organization_id = ? AND sha256 = ?
       )
    `).bind(upload.expected_bytes, upload.organization_id, upload.organization_id, actualHash),
    env.DB.prepare(`
      INSERT INTO images (id, organization_id, sha256, r2_key, content_type, byte_size, width, height)
      VALUES (?, ?, ?, ?, 'image/png', ?, ?, ?) ON CONFLICT (organization_id, sha256) DO NOTHING
    `).bind(imageId, upload.organization_id, actualHash, canonicalKey, upload.expected_bytes, dimensions.width, dimensions.height),
  ]);
  const image = await env.DB.prepare("SELECT id FROM images WHERE organization_id = ? AND sha256 = ? AND reference_state = 'active'")
    .bind(upload.organization_id, actualHash).first<{ id: string }>();
  if (!image) throw new Error("Canonical image metadata could not be published");
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE organization_usage SET reserved_upload_bytes = MAX(0, reserved_upload_bytes - ?),
        updated_at = unixepoch() WHERE organization_id = ?
    `).bind(upload.reserved_bytes, upload.organization_id),
    env.DB.prepare(`
      UPDATE manifest_entries SET image_id = ?
       WHERE organization_id = ? AND run_id = ? AND shard_id = ? AND sha256 = ? AND image_id IS NULL
    `).bind(image.id, upload.organization_id, upload.run_id, upload.shard_id, actualHash),
    env.DB.prepare("UPDATE upload_sessions SET state = 'published', updated_at = unixepoch() WHERE id = ? AND organization_id = ?")
      .bind(upload.id, upload.organization_id),
  ]);
  await env.IMAGES.delete(upload.temporary_key);
  await env.DB.prepare("UPDATE upload_sessions SET temporary_deleted_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND organization_id = ?")
    .bind(upload.id, upload.organization_id).run();
  const pending = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM manifest_entries
     WHERE organization_id = ? AND run_id = ? AND shard_id = ? AND image_id IS NULL
  `).bind(upload.organization_id, upload.run_id, upload.shard_id).first<{ count: number }>();
  if (pending?.count === 0) {
    await env.DB.prepare("UPDATE run_shards SET state = 'verified', updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND state = 'verifying'")
      .bind(upload.shard_id, upload.organization_id).run();
    await enqueueJob(env, upload.organization_id, "complete_run", `complete:${upload.run_id}:${upload.shard_id}`, { runId: upload.run_id });
  }
}

async function failUpload(
  env: Env,
  upload: { id: string; organization_id: string; run_id: string; shard_id: string; reserved_bytes: number; temporary_key: string },
  reason: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE organization_usage SET reserved_upload_bytes = MAX(0, reserved_upload_bytes - ?), updated_at = unixepoch() WHERE organization_id = ?")
      .bind(upload.reserved_bytes, upload.organization_id),
    env.DB.prepare("UPDATE upload_sessions SET state = 'failed', updated_at = unixepoch() WHERE id = ? AND organization_id = ?")
      .bind(upload.id, upload.organization_id),
    env.DB.prepare("UPDATE run_shards SET state = 'failed', updated_at = unixepoch() WHERE id = ? AND organization_id = ?")
      .bind(upload.shard_id, upload.organization_id),
    env.DB.prepare("UPDATE runs SET state = 'failed', updated_at = unixepoch() WHERE id = ? AND organization_id = ?")
      .bind(upload.run_id, upload.organization_id),
  ]);
  console.warn(JSON.stringify({ level: "warn", event: "upload_verification_failed", uploadId: upload.id, reason }));
  await env.IMAGES.delete(upload.temporary_key);
  await env.DB.prepare("UPDATE upload_sessions SET temporary_deleted_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND organization_id = ?")
    .bind(upload.id, upload.organization_id).run();
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
