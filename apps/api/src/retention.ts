import { randomId } from "./crypto.ts";
import { classifyPullRequestFork } from "./github.ts";
import type { Env } from "./platform.ts";

interface ReconciledPullRequest {
  organization_id: string; project_id: string; number: number; installation_id: number | null;
  repository_owner: string; repository_name: string; state_version: number;
}

export async function reconcilePullRequestPins(env: Env): Promise<void> {
  const result = await env.DB.prepare(`
    SELECT pr.organization_id, pr.project_id, pr.number, pr.installation_id, pr.state_version,
      p.repository_owner, p.repository_name
      FROM pull_requests pr JOIN projects p ON p.id = pr.project_id AND p.organization_id = pr.organization_id
     WHERE (pr.state IN ('open', 'unknown') OR (pr.state = 'closed' AND EXISTS (
       SELECT 1 FROM runs r JOIN comparisons c ON c.organization_id = r.organization_id AND c.current_run_id = r.id
        WHERE r.organization_id = pr.organization_id AND r.project_id = pr.project_id
          AND r.pull_request_number = pr.number AND c.created_at >= unixepoch() - 31536000
     )))
       AND (pr.last_reconciled_at IS NULL OR pr.last_reconciled_at < unixepoch() - 3600)
     ORDER BY COALESCE(pr.last_reconciled_at, 0) LIMIT 100
  `).all<ReconciledPullRequest>();
  for (const pullRequest of result.results ?? []) {
    if (!pullRequest.installation_id) {
      await markUnresolved(env, pullRequest, "GitHub installation is unavailable");
      continue;
    }
    try {
      const current = await classifyPullRequestFork(env, pullRequest.installation_id, pullRequest.repository_owner,
        pullRequest.repository_name, pullRequest.number);
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE pull_requests SET state = ?, head_sha = ?, base_sha = ?, github_updated_at = ?,
            retention_state = 'current', last_reconciled_at = unixepoch(), reconciliation_error = NULL,
            state_version = state_version + 1, updated_at = unixepoch()
           WHERE organization_id = ? AND project_id = ? AND number = ? AND state_version = ?
        `).bind(current.state, current.headSha, current.baseSha, current.updatedAt,
          pullRequest.organization_id, pullRequest.project_id, pullRequest.number, pullRequest.state_version),
        env.DB.prepare(`
          UPDATE retention_pins SET released_at = unixepoch()
           WHERE organization_id = ? AND owner_type = 'open_pull_request' AND owner_id = ? AND released_at IS NULL
             AND EXISTS (SELECT 1 FROM pull_requests WHERE organization_id = ? AND project_id = ? AND number = ?
               AND state = 'closed' AND state_version = ?)
        `).bind(pullRequest.organization_id, `${pullRequest.project_id}:pr:${pullRequest.number}`,
          pullRequest.organization_id, pullRequest.project_id, pullRequest.number, pullRequest.state_version + 1),
        env.DB.prepare(`
          INSERT INTO retention_pins (id, organization_id, owner_type, owner_id, run_id, comparison_id)
          SELECT 'pin_' || lower(hex(randomblob(16))), ?, 'open_pull_request', ?, candidate.run_id, candidate.comparison_id
            FROM (SELECT c.current_run_id AS run_id, c.id AS comparison_id FROM comparisons c JOIN runs current
                    ON current.id = c.current_run_id AND current.organization_id = c.organization_id
                   WHERE c.organization_id = ? AND c.project_id = ? AND current.pull_request_number = ?
                  UNION SELECT c.baseline_run_id, c.id FROM comparisons c JOIN runs current
                    ON current.id = c.current_run_id AND current.organization_id = c.organization_id
                   WHERE c.organization_id = ? AND c.project_id = ? AND current.pull_request_number = ?
                     AND c.baseline_run_id IS NOT NULL) candidate
            JOIN runs r ON r.id = candidate.run_id AND r.organization_id = ?
           WHERE r.artifacts_expired_at IS NULL AND r.artifact_expiry_owner IS NULL AND r.metadata_deletion_owner IS NULL
             AND EXISTS (SELECT 1 FROM pull_requests WHERE organization_id = ? AND project_id = ? AND number = ?
               AND state IN ('open', 'unknown') AND state_version = ?)
          ON CONFLICT DO UPDATE SET released_at = NULL
        `).bind(pullRequest.organization_id, `${pullRequest.project_id}:pr:${pullRequest.number}`,
          pullRequest.organization_id, pullRequest.project_id, pullRequest.number,
          pullRequest.organization_id, pullRequest.project_id, pullRequest.number, pullRequest.organization_id,
          pullRequest.organization_id, pullRequest.project_id, pullRequest.number, pullRequest.state_version + 1),
      ]);
    } catch (error) {
      await markUnresolved(env, pullRequest, String(error).slice(0, 1000));
    }
  }
}

async function markUnresolved(env: Env, pullRequest: Pick<ReconciledPullRequest,
  "organization_id" | "project_id" | "number" | "state_version">, error: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE pull_requests SET retention_state = 'unresolved', last_reconciled_at = unixepoch(),
      reconciliation_error = ?, updated_at = unixepoch()
     WHERE organization_id = ? AND project_id = ? AND number = ? AND state_version = ?
  `).bind(error, pullRequest.organization_id, pullRequest.project_id, pullRequest.number,
    pullRequest.state_version).run();
}

export async function processRetentionCleanup(env: Env): Promise<void> {
  const owner = randomId("ret");
  await env.DB.prepare(`
    UPDATE runs SET artifact_expiry_owner = ?, artifact_expiry_claimed_at = unixepoch()
     WHERE id IN (
       SELECT r.id FROM runs r JOIN projects p ON p.id = r.project_id AND p.organization_id = r.organization_id
        WHERE r.artifacts_expired_at IS NULL
          AND (r.artifact_expiry_owner IS NULL OR r.artifact_expiry_claimed_at < unixepoch() - 600)
          AND ((r.state = 'complete' AND r.completed_at < unixepoch() - 86400 * CASE WHEN EXISTS (
            SELECT 1 FROM baselines b WHERE b.organization_id = r.organization_id AND b.run_id = r.id
          ) THEN p.promoted_retention_days ELSE p.retention_days END)
          OR (r.state IN ('failed', 'canceled', 'timed_out') AND r.created_at < unixepoch() - 86400 * p.retention_days))
          AND NOT EXISTS (SELECT 1 FROM retention_pins pin WHERE pin.organization_id = r.organization_id
            AND pin.run_id = r.id AND pin.released_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM retention_pins pin JOIN comparisons c
            ON c.id = pin.comparison_id AND c.organization_id = pin.organization_id
            WHERE pin.organization_id = r.organization_id AND pin.released_at IS NULL
              AND (c.current_run_id = r.id OR c.baseline_run_id = r.id))
        ORDER BY COALESCE(r.completed_at, r.created_at) LIMIT 100
     )
  `).bind(owner).run();
  const expired = await env.DB.prepare("SELECT id, organization_id FROM runs WHERE artifact_expiry_owner = ?")
    .bind(owner).all<{ id: string; organization_id: string }>();
  for (const run of expired.results ?? []) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE comparison_entries SET baseline_image_id = NULL WHERE organization_id = ?
        AND comparison_id IN (SELECT id FROM comparisons WHERE organization_id = ? AND baseline_run_id = ?)
        AND EXISTS (SELECT 1 FROM runs WHERE organization_id = ? AND id = ? AND artifact_expiry_owner = ?)`)
        .bind(run.organization_id, run.organization_id, run.id, run.organization_id, run.id, owner),
      env.DB.prepare(`UPDATE comparison_entries SET current_image_id = NULL WHERE organization_id = ?
        AND comparison_id IN (SELECT id FROM comparisons WHERE organization_id = ? AND current_run_id = ?)
        AND EXISTS (SELECT 1 FROM runs WHERE organization_id = ? AND id = ? AND artifact_expiry_owner = ?)`)
        .bind(run.organization_id, run.organization_id, run.id, run.organization_id, run.id, owner),
      env.DB.prepare(`DELETE FROM screenshots WHERE organization_id = ? AND run_id = ?
        AND EXISTS (SELECT 1 FROM runs WHERE organization_id = ? AND id = ? AND artifact_expiry_owner = ?)`)
        .bind(run.organization_id, run.id, run.organization_id, run.id, owner),
      env.DB.prepare(`UPDATE manifest_entries SET image_id = NULL WHERE organization_id = ? AND run_id = ?
        AND EXISTS (SELECT 1 FROM runs WHERE organization_id = ? AND id = ? AND artifact_expiry_owner = ?)`)
        .bind(run.organization_id, run.id, run.organization_id, run.id, owner),
      env.DB.prepare(`UPDATE runs SET artifacts_expired_at = unixepoch(), artifact_expiry_owner = NULL,
        artifact_expiry_claimed_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND organization_id = ? AND artifact_expiry_owner = ?`).bind(run.id, run.organization_id, owner),
    ]);
  }
  await collectImages(env);
  await collectAbandonedPublications(env);
  await deleteMetadata(env);
}

async function collectAbandonedPublications(env: Env): Promise<void> {
  const owner = randomId("pubgc");
  await env.DB.prepare(`UPDATE image_publications SET deletion_owner = ?, deletion_claimed_at = unixepoch()
    WHERE (organization_id, sha256) IN (SELECT p.organization_id, p.sha256 FROM image_publications p
      WHERE (p.deletion_owner IS NULL OR p.deletion_claimed_at < unixepoch() - 600)
        AND p.created_at < unixepoch() - 86400
        AND NOT EXISTS (SELECT 1 FROM images i WHERE i.organization_id = p.organization_id
          AND i.sha256 = p.sha256 AND i.reference_state = 'active')
        AND NOT EXISTS (SELECT 1 FROM upload_sessions u WHERE u.organization_id = p.organization_id
          AND u.expected_sha256 = p.sha256 AND u.state IN ('pending', 'uploaded', 'verifying')
          AND u.expires_at >= unixepoch())
      LIMIT 100)`).bind(owner).run();
  const publications = await env.DB.prepare(`
    SELECT p.organization_id, p.sha256, p.image_id, p.r2_key FROM image_publications p
     WHERE p.deletion_owner = ? LIMIT 100
  `).bind(owner).all<{ organization_id: string; sha256: string; image_id: string; r2_key: string }>();
  for (const publication of publications.results ?? []) {
    await env.IMAGES.delete(publication.r2_key);
    await env.DB.prepare(`DELETE FROM image_publications WHERE organization_id = ? AND sha256 = ?
      AND image_id = ? AND r2_key = ? AND deletion_owner = ?`)
      .bind(publication.organization_id, publication.sha256, publication.image_id, publication.r2_key, owner).run();
  }
}

async function collectImages(env: Env): Promise<void> {
  const owner = randomId("gc");
  await env.DB.prepare(`
    UPDATE images SET reference_state = 'deleting', deletion_owner = ?, deletion_claimed_at = unixepoch()
     WHERE id IN (SELECT i.id FROM images i
       WHERE (i.reference_state = 'active' OR (i.reference_state = 'deleting' AND i.deletion_claimed_at < unixepoch() - 600))
         AND NOT EXISTS (SELECT 1 FROM screenshots s WHERE s.organization_id = i.organization_id AND s.image_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM manifest_entries m WHERE m.organization_id = i.organization_id AND m.image_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM comparison_entries c WHERE c.organization_id = i.organization_id
           AND (c.baseline_image_id = i.id OR c.current_image_id = i.id)) LIMIT 100)
  `).bind(owner).run();
  const images = await env.DB.prepare(`SELECT id, organization_id, r2_key, byte_size FROM images WHERE deletion_owner = ?`)
    .bind(owner).all<{ id: string; organization_id: string; r2_key: string; byte_size: number }>();
  for (const image of images.results ?? []) {
    await env.IMAGES.delete(image.r2_key);
    await env.DB.batch([
      env.DB.prepare(`UPDATE organization_usage SET stored_bytes = MAX(0, stored_bytes - ?), updated_at = unixepoch()
        WHERE organization_id = ? AND EXISTS (SELECT 1 FROM images i WHERE i.id = ? AND i.organization_id = ?
          AND i.deletion_owner = ?
          AND NOT EXISTS (SELECT 1 FROM screenshots WHERE organization_id = i.organization_id AND image_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM manifest_entries WHERE organization_id = i.organization_id AND image_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM comparison_entries WHERE organization_id = i.organization_id
            AND (baseline_image_id = i.id OR current_image_id = i.id)))`)
        .bind(image.byte_size, image.organization_id, image.id, image.organization_id, owner),
      env.DB.prepare(`DELETE FROM images WHERE id = ? AND organization_id = ? AND deletion_owner = ?
        AND NOT EXISTS (SELECT 1 FROM screenshots WHERE organization_id = ? AND image_id = ?)
        AND NOT EXISTS (SELECT 1 FROM manifest_entries WHERE organization_id = ? AND image_id = ?)
        AND NOT EXISTS (SELECT 1 FROM comparison_entries WHERE organization_id = ?
          AND (baseline_image_id = ? OR current_image_id = ?))`)
        .bind(image.id, image.organization_id, owner, image.organization_id, image.id,
          image.organization_id, image.id, image.organization_id, image.id, image.id),
    ]);
  }
}

async function deleteMetadata(env: Env): Promise<void> {
  const owner = randomId("meta");
  await env.DB.prepare(`
    UPDATE runs SET metadata_deletion_owner = ?, metadata_deletion_claimed_at = unixepoch()
     WHERE id IN (SELECT r.id FROM runs r
       WHERE r.created_at < unixepoch() - 31536000 AND r.artifacts_expired_at IS NOT NULL
         AND (r.metadata_deletion_owner IS NULL OR r.metadata_deletion_claimed_at < unixepoch() - 600)
         AND NOT EXISTS (SELECT 1 FROM retention_pins p WHERE p.organization_id = r.organization_id
           AND p.run_id = r.id AND p.released_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM retention_pins p JOIN comparisons c
           ON c.id = p.comparison_id AND c.organization_id = p.organization_id
           WHERE p.organization_id = r.organization_id AND p.released_at IS NULL
             AND (c.current_run_id = r.id OR c.baseline_run_id = r.id))
         AND NOT EXISTS (SELECT 1 FROM comparisons c WHERE c.organization_id = r.organization_id
           AND (c.current_run_id = r.id OR c.baseline_run_id = r.id) AND c.created_at >= unixepoch() - 31536000)
       ORDER BY r.created_at LIMIT 50)
  `).bind(owner).run();
  const runs = await env.DB.prepare("SELECT id, organization_id FROM runs WHERE metadata_deletion_owner = ?")
    .bind(owner).all<{ id: string; organization_id: string }>();
  for (const run of runs.results ?? []) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM retention_pins WHERE organization_id = ? AND released_at IS NOT NULL
        AND (run_id = ? OR comparison_id IN (SELECT id FROM comparisons WHERE organization_id = ?
          AND (current_run_id = ? OR baseline_run_id = ?)))
        AND EXISTS (SELECT 1 FROM runs WHERE organization_id = ? AND id = ? AND metadata_deletion_owner = ?)`)
        .bind(run.organization_id, run.id, run.organization_id, run.id, run.id, run.organization_id, run.id, owner),
      env.DB.prepare(`DELETE FROM comparisons WHERE organization_id = ? AND (current_run_id = ? OR baseline_run_id = ?)
        AND EXISTS (SELECT 1 FROM runs WHERE organization_id = ? AND id = ? AND metadata_deletion_owner = ?)`)
        .bind(run.organization_id, run.id, run.id, run.organization_id, run.id, owner),
      env.DB.prepare(`UPDATE baselines SET previous_run_id = NULL WHERE organization_id = ? AND previous_run_id = ?
        AND EXISTS (SELECT 1 FROM runs WHERE organization_id = ? AND id = ? AND metadata_deletion_owner = ?)`)
        .bind(run.organization_id, run.id, run.organization_id, run.id, owner),
      env.DB.prepare(`DELETE FROM baselines WHERE organization_id = ? AND run_id = ?
        AND EXISTS (SELECT 1 FROM runs WHERE organization_id = ? AND id = ? AND metadata_deletion_owner = ?)`)
        .bind(run.organization_id, run.id, run.organization_id, run.id, owner),
      env.DB.prepare(`DELETE FROM commit_runs WHERE organization_id = ? AND run_id = ?
        AND EXISTS (SELECT 1 FROM runs WHERE organization_id = ? AND id = ? AND metadata_deletion_owner = ?)`)
        .bind(run.organization_id, run.id, run.organization_id, run.id, owner),
      env.DB.prepare("DELETE FROM runs WHERE organization_id = ? AND id = ? AND metadata_deletion_owner = ?")
        .bind(run.organization_id, run.id, owner),
    ]);
  }
}
