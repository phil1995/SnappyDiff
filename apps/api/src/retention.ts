import { classifyPullRequestFork } from "./github.ts";
import type { Env } from "./platform.ts";

export async function reconcilePullRequestPins(env: Env): Promise<void> {
  const result = await env.DB.prepare(`
    SELECT pr.organization_id, pr.project_id, pr.number, pr.installation_id,
      p.repository_owner, p.repository_name
      FROM pull_requests pr JOIN projects p ON p.id = pr.project_id AND p.organization_id = pr.organization_id
     WHERE pr.state IN ('open', 'unknown')
       AND (pr.last_reconciled_at IS NULL OR pr.last_reconciled_at < unixepoch() - 3600)
     ORDER BY COALESCE(pr.last_reconciled_at, 0) LIMIT 100
  `).all<{
    organization_id: string; project_id: string; number: number; installation_id: number | null;
    repository_owner: string; repository_name: string;
  }>();
  for (const pullRequest of result.results ?? []) {
    if (!pullRequest.installation_id) {
      await markUnresolved(env, pullRequest, "GitHub installation is unavailable");
      continue;
    }
    try {
      const current = await classifyPullRequestFork(env, pullRequest.installation_id, pullRequest.repository_owner,
        pullRequest.repository_name, pullRequest.number);
      await env.DB.prepare(`
        UPDATE pull_requests SET state = ?, head_sha = ?, base_sha = ?, github_updated_at = ?,
          retention_state = 'current', last_reconciled_at = unixepoch(), reconciliation_error = NULL, updated_at = unixepoch()
         WHERE organization_id = ? AND project_id = ? AND number = ?
      `).bind(current.state, current.headSha, current.baseSha, current.updatedAt,
        pullRequest.organization_id, pullRequest.project_id, pullRequest.number).run();
      if (current.state === "closed") {
        await env.DB.prepare(`
          UPDATE retention_pins SET released_at = unixepoch()
           WHERE organization_id = ? AND owner_type = 'open_pull_request' AND owner_id = ? AND released_at IS NULL
        `).bind(pullRequest.organization_id, `${pullRequest.project_id}:pr:${pullRequest.number}`).run();
      }
    } catch (error) {
      await markUnresolved(env, pullRequest, String(error).slice(0, 1000));
    }
  }
}

async function markUnresolved(env: Env, pullRequest: { organization_id: string; project_id: string; number: number }, error: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE pull_requests SET retention_state = 'unresolved', last_reconciled_at = unixepoch(),
      reconciliation_error = ?, updated_at = unixepoch()
     WHERE organization_id = ? AND project_id = ? AND number = ?
  `).bind(error, pullRequest.organization_id, pullRequest.project_id, pullRequest.number).run();
}

export async function processRetentionCleanup(env: Env): Promise<void> {
  const expired = await env.DB.prepare(`
    SELECT r.id, r.organization_id FROM runs r JOIN projects p
      ON p.id = r.project_id AND p.organization_id = r.organization_id
     WHERE r.state = 'complete' AND r.artifacts_expired_at IS NULL
       AND r.completed_at < unixepoch() - 86400 * CASE WHEN EXISTS (
         SELECT 1 FROM baselines b WHERE b.organization_id = r.organization_id AND b.run_id = r.id
       ) THEN p.promoted_retention_days ELSE p.retention_days END
       AND NOT EXISTS (SELECT 1 FROM retention_pins pin WHERE pin.organization_id = r.organization_id
         AND pin.run_id = r.id AND pin.released_at IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM retention_pins pin JOIN comparisons c
           ON c.id = pin.comparison_id AND c.organization_id = pin.organization_id
          WHERE pin.organization_id = r.organization_id AND pin.released_at IS NULL
            AND (c.current_run_id = r.id OR c.baseline_run_id = r.id)
       )
     ORDER BY r.completed_at LIMIT 100
  `).all<{ id: string; organization_id: string }>();
  for (const run of expired.results ?? []) {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE comparison_entries SET baseline_image_id = NULL
         WHERE organization_id = ? AND comparison_id IN (
           SELECT id FROM comparisons WHERE organization_id = ? AND baseline_run_id = ?
         )
      `).bind(run.organization_id, run.organization_id, run.id),
      env.DB.prepare(`
        UPDATE comparison_entries SET current_image_id = NULL
         WHERE organization_id = ? AND comparison_id IN (
           SELECT id FROM comparisons WHERE organization_id = ? AND current_run_id = ?
         )
      `).bind(run.organization_id, run.organization_id, run.id),
      env.DB.prepare("DELETE FROM screenshots WHERE organization_id = ? AND run_id = ?")
        .bind(run.organization_id, run.id),
      env.DB.prepare("UPDATE manifest_entries SET image_id = NULL WHERE organization_id = ? AND run_id = ?")
        .bind(run.organization_id, run.id),
      env.DB.prepare("UPDATE runs SET artifacts_expired_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND artifacts_expired_at IS NULL")
        .bind(run.id, run.organization_id),
    ]);
  }

  await env.DB.prepare(`
    UPDATE images SET reference_state = 'deleting', deletion_claimed_at = unixepoch()
     WHERE id IN (
       SELECT i.id FROM images i WHERE i.reference_state = 'active'
         AND NOT EXISTS (SELECT 1 FROM screenshots s WHERE s.organization_id = i.organization_id AND s.image_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM manifest_entries me WHERE me.organization_id = i.organization_id AND me.image_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM comparison_entries ce WHERE ce.organization_id = i.organization_id
           AND (ce.baseline_image_id = i.id OR ce.current_image_id = i.id))
       LIMIT 100
     )
  `).run();
  const deleting = await env.DB.prepare(`
    SELECT id, organization_id, r2_key, byte_size FROM images
     WHERE reference_state = 'deleting' ORDER BY deletion_claimed_at LIMIT 100
  `).all<{ id: string; organization_id: string; r2_key: string; byte_size: number }>();
  for (const image of deleting.results ?? []) {
    await env.IMAGES.delete(image.r2_key);
    await env.DB.batch([
      env.DB.prepare(`
        DELETE FROM images WHERE id = ? AND organization_id = ? AND reference_state = 'deleting'
          AND NOT EXISTS (SELECT 1 FROM screenshots WHERE organization_id = ? AND image_id = ?)
          AND NOT EXISTS (SELECT 1 FROM manifest_entries WHERE organization_id = ? AND image_id = ?)
          AND NOT EXISTS (SELECT 1 FROM comparison_entries WHERE organization_id = ?
            AND (baseline_image_id = ? OR current_image_id = ?))
      `).bind(image.id, image.organization_id, image.organization_id, image.id,
        image.organization_id, image.id, image.organization_id, image.id, image.id),
      env.DB.prepare(`
        UPDATE organization_usage SET stored_bytes = MAX(0, stored_bytes - ?), updated_at = unixepoch()
         WHERE organization_id = ? AND NOT EXISTS (SELECT 1 FROM images WHERE id = ? AND organization_id = ?)
      `).bind(image.byte_size, image.organization_id, image.id, image.organization_id),
    ]);
  }

  const oldRuns = await env.DB.prepare(`
    SELECT r.id, r.organization_id FROM runs r
     WHERE r.created_at < unixepoch() - 31536000 AND r.artifacts_expired_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM retention_pins pin WHERE pin.organization_id = r.organization_id
         AND pin.run_id = r.id AND pin.released_at IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM retention_pins pin JOIN comparisons c
           ON c.id = pin.comparison_id AND c.organization_id = pin.organization_id
          WHERE pin.organization_id = r.organization_id AND pin.released_at IS NULL
            AND (c.current_run_id = r.id OR c.baseline_run_id = r.id)
       )
     ORDER BY r.created_at LIMIT 50
  `).all<{ id: string; organization_id: string }>();
  for (const run of oldRuns.results ?? []) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM retention_pins WHERE organization_id = ? AND run_id = ? AND released_at IS NOT NULL").bind(run.organization_id, run.id),
      env.DB.prepare("DELETE FROM comparisons WHERE organization_id = ? AND (current_run_id = ? OR baseline_run_id = ?)").bind(run.organization_id, run.id, run.id),
      env.DB.prepare("UPDATE baselines SET previous_run_id = NULL WHERE organization_id = ? AND previous_run_id = ?").bind(run.organization_id, run.id),
      env.DB.prepare("DELETE FROM baselines WHERE organization_id = ? AND run_id = ?").bind(run.organization_id, run.id),
      env.DB.prepare("DELETE FROM commit_runs WHERE organization_id = ? AND run_id = ?").bind(run.organization_id, run.id),
      env.DB.prepare("DELETE FROM runs WHERE organization_id = ? AND id = ?").bind(run.organization_id, run.id),
    ]);
  }
}
