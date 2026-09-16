import { randomId } from "./crypto.ts";
import type { Env } from "./platform.ts";
import { completeRunJob, verifyUploadJob } from "./verification.ts";
import { processBaselineJob } from "./baselines.ts";
import { deliverGitHubCheckJob, refreshGitHubStateJob } from "./github.ts";
import { processRetentionCleanup, reconcilePullRequestPins } from "./retention.ts";
import { processOrganizationDeletions } from "./privacy.ts";

export type JobKind = "verify_upload" | "complete_run" | "select_baseline" | "deliver_github_check" | "refresh_github_state" | "reconcile" | "cleanup";

export interface PendingJob {
  id: string;
  organization_id: string | null;
  kind: JobKind;
  payload_json: string;
  attempts: number;
  max_attempts: number;
}

export async function enqueueSystemJob(
  env: Env,
  kind: "reconcile" | "cleanup",
  deduplicationKey: string,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO jobs (id, organization_id, kind, deduplication_key, payload_json)
    VALUES (?, NULL, ?, ?, '{}') ON CONFLICT DO NOTHING
  `).bind(randomId("job"), kind, deduplicationKey).run();
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
  let completed = 0;
  let attempted = 0;
  while (attempted < maximum) {
    const candidate = await env.DB.prepare(`
      SELECT id FROM jobs
       WHERE status = 'pending' AND next_attempt_at <= unixepoch()
         AND (lease_expires_at IS NULL OR lease_expires_at < unixepoch())
       ORDER BY next_attempt_at, created_at LIMIT 1
    `).first<{ id: string }>();
    if (!candidate) break;
    const id = candidate.id;
    attempted++;
    const leaseUntil = Math.floor(Date.now() / 1000) + 300;
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
  if (job.organization_id) {
    const deletion = await env.DB.prepare(`SELECT 1 AS found FROM organization_deletion_requests
      WHERE organization_id = ?`).bind(job.organization_id).first();
    if (deletion) return;
  }
  if (job.kind === "verify_upload") return verifyUploadJob(env, job);
  if (job.kind === "complete_run") return completeRunJob(env, job);
  if (job.kind === "select_baseline") return processBaselineJob(env, job);
  if (job.kind === "deliver_github_check") return deliverGitHubCheckJob(env, job);
  if (job.kind === "refresh_github_state") return refreshGitHubStateJob(env, job);
  if (job.kind === "reconcile") {
    await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < unixepoch()").run();
    await env.DB.prepare("UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL WHERE status = 'running' AND lease_expires_at < unixepoch()") .run();
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE run_shards SET state = 'failed', updated_at = unixepoch()
         WHERE state IN ('open', 'sealed', 'verifying') AND run_id IN (
           SELECT id FROM runs WHERE state IN ('open', 'verifying') AND deadline_at < unixepoch()
         )
      `),
      env.DB.prepare("UPDATE runs SET state = 'timed_out', updated_at = unixepoch() WHERE state IN ('open', 'verifying') AND deadline_at < unixepoch()"),
    ]);
    return;
  }
  if (job.kind === "cleanup") {
    await processOrganizationDeletions(env);
    await reconcilePullRequestPins(env);
    const removable = await env.DB.prepare(`
      SELECT id, temporary_key FROM upload_sessions
       WHERE temporary_deleted_at IS NULL AND expires_at < unixepoch() LIMIT 500
    `).all<{ id: string; temporary_key: string }>();
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE organization_usage
           SET reserved_upload_bytes = MAX(0, reserved_upload_bytes - COALESCE((
             SELECT SUM(reserved_bytes) FROM upload_sessions
              WHERE upload_sessions.organization_id = organization_usage.organization_id
                AND state IN ('pending', 'uploaded', 'verifying') AND expires_at < unixepoch()
                AND reservation_released_at IS NULL
           ), 0)), updated_at = unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM upload_sessions
            WHERE upload_sessions.organization_id = organization_usage.organization_id
              AND state IN ('pending', 'uploaded', 'verifying') AND expires_at < unixepoch()
              AND reservation_released_at IS NULL
         )
      `),
      env.DB.prepare(`UPDATE upload_sessions SET state = 'expired', reservation_released_at = unixepoch(), updated_at = unixepoch()
        WHERE state IN ('pending', 'uploaded', 'verifying') AND expires_at < unixepoch()
          AND reservation_released_at IS NULL`),
    ]);
    const rows = removable.results ?? [];
    if (rows.length > 0) {
      await env.IMAGES.delete(rows.map(({ temporary_key }) => temporary_key));
      for (const row of rows) {
        await env.DB.prepare("UPDATE upload_sessions SET temporary_deleted_at = unixepoch(), updated_at = unixepoch() WHERE id = ?")
          .bind(row.id).run();
      }
    }
    await processRetentionCleanup(env);
    return;
  }
  throw new Error(`Job handler not implemented for ${job.kind}`);
}
