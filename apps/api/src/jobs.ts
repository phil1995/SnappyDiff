import { randomId } from "./crypto.ts";
import type { Env } from "./platform.ts";

export type JobKind = "verify_upload" | "complete_run" | "select_baseline" | "deliver_github_check" | "reconcile" | "cleanup";

export interface PendingJob {
  id: string;
  organization_id: string;
  kind: JobKind;
  payload_json: string;
  attempts: number;
  max_attempts: number;
}

export async function enqueueJob(
  env: Env,
  organizationId: string,
  kind: JobKind,
  deduplicationKey: string,
  payload: Record<string, unknown>,
  delaySeconds = 0,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO jobs (id, organization_id, kind, deduplication_key, payload_json, next_attempt_at)
    VALUES (?, ?, ?, ?, ?, unixepoch() + ?)
    ON CONFLICT (organization_id, deduplication_key) DO NOTHING
  `).bind(randomId("job"), organizationId, kind, deduplicationKey, JSON.stringify(payload), delaySeconds).run();
}

export async function drainJobs(env: Env, maximum = 25): Promise<number> {
  const leaseOwner = randomId("lease");
  const leaseUntil = Math.floor(Date.now() / 1000) + 60;
  const candidates = await env.DB.prepare(`
    SELECT id FROM jobs
     WHERE status = 'pending' AND next_attempt_at <= unixepoch()
       AND (lease_expires_at IS NULL OR lease_expires_at < unixepoch())
     ORDER BY next_attempt_at, created_at LIMIT ?
  `).bind(maximum).all<{ id: string }>();
  const ids = candidates.results?.map(({ id }) => id) ?? [];
  let completed = 0;
  for (const id of ids) {
    const lease = await env.DB.prepare(`
      UPDATE jobs SET lease_owner = ?, lease_expires_at = ?, status = 'running', updated_at = unixepoch()
       WHERE id = ? AND status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at < unixepoch())
    `).bind(leaseOwner, leaseUntil, id).run();
    if (Number(lease.meta?.["changes"] ?? 0) !== 1) continue;
    const job = await env.DB.prepare("SELECT id, organization_id, kind, payload_json, attempts, max_attempts FROM jobs WHERE id = ? AND lease_owner = ?")
      .bind(id, leaseOwner).first<PendingJob>();
    if (!job) continue;
    try {
      await executeJob(env, job);
      await env.DB.prepare("UPDATE jobs SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, completed_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND lease_owner = ?")
        .bind(id, leaseOwner).run();
      completed++;
    } catch (error) {
      const attempts = job.attempts + 1;
      const exhausted = attempts >= job.max_attempts;
      const delay = Math.min(3600, 2 ** Math.min(attempts, 10));
      await env.DB.prepare(`
        UPDATE jobs SET status = ?, attempts = ?, last_error = ?, next_attempt_at = unixepoch() + ?,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND lease_owner = ?
      `).bind(exhausted ? "failed" : "pending", attempts, String(error).slice(0, 2000), delay, id, leaseOwner).run();
    }
  }
  return completed;
}

async function executeJob(env: Env, job: PendingJob): Promise<void> {
  if (job.kind === "reconcile") {
    await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < unixepoch()").run();
    await env.DB.prepare("UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL WHERE status = 'running' AND lease_expires_at < unixepoch()") .run();
    return;
  }
  if (job.kind === "cleanup") {
    await env.DB.prepare("UPDATE upload_sessions SET state = 'expired', updated_at = unixepoch() WHERE state IN ('pending', 'uploaded') AND expires_at < unixepoch()") .run();
    return;
  }
  throw new Error(`Job handler not implemented for ${job.kind}`);
}

