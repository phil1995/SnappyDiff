import { randomId } from "./crypto.ts";
import type { PendingJob } from "./jobs.ts";
import type { D1PreparedStatement, Env } from "./platform.ts";
import { ensureInProgressGitHubCheck } from "./github.ts";

interface RunRecord {
  id: string;
  organization_id: string;
  project_id: string;
  suite_id: string;
  commit_sha: string;
  branch: string;
  merge_base_sha: string | null;
  observed_default_head_sha: string | null;
  pull_request_number: number | null;
  attempt_number: number;
  provider_run_id: string;
  pull_request_head_sha: string | null;
  trust_class: string;
  default_branch: string;
  repository_owner: string;
  repository_name: string;
  completed_at: number;
}

export async function processBaselineJob(env: Env, job: PendingJob): Promise<void> {
  const { runId } = JSON.parse(job.payload_json) as { runId: string };
  const run = await env.DB.prepare(`
    SELECT r.id, r.organization_id, r.project_id, r.suite_id, r.commit_sha, r.branch, r.merge_base_sha,
      r.observed_default_head_sha, r.pull_request_number, r.attempt_number, r.provider_run_id,
      r.pull_request_head_sha, r.trust_class,
      p.default_branch, p.repository_owner, p.repository_name, r.completed_at
      FROM runs r JOIN projects p ON p.id = r.project_id AND p.organization_id = r.organization_id
     WHERE r.id = ? AND r.organization_id = ? AND r.state = 'complete'
       AND r.artifacts_expired_at IS NULL AND r.artifact_expiry_owner IS NULL AND r.metadata_deletion_owner IS NULL
  `).bind(runId, job.organization_id).first<RunRecord>();
  if (!run) return;
  const suite = await env.DB.prepare("SELECT active_baseline_run_id, rollback_run_id, promotion_mode FROM suites WHERE id = ? AND organization_id = ?")
    .bind(run.suite_id, run.organization_id).first<{ active_baseline_run_id: string | null; rollback_run_id: string | null; promotion_mode: string }>();
  if (!suite) throw new Error("Default suite is missing");
  const isDefaultBranch = run.pull_request_number === null && run.branch === run.default_branch && run.trust_class === "first_party";
  const existing = await env.DB.prepare("SELECT id FROM comparisons WHERE organization_id = ? AND current_run_id = ?")
    .bind(run.organization_id, run.id).first();
  if (!existing) {
    const selection = await selectBaseline(env, run, suite.rollback_run_id, isDefaultBranch ? suite.active_baseline_run_id : null);
    await createComparison(env, run, selection.runId, selection.distance, selection.warning, selection.error, isDefaultBranch);
  }
  if (isDefaultBranch && suite.promotion_mode === "automatic") await promoteDefaultRun(env, run);
}

async function selectBaseline(
  env: Env,
  run: RunRecord,
  rollbackRunId: string | null,
  defaultBaselineId: string | null,
): Promise<{ runId: string | null; distance: number | null; warning: string | null; error: string | null }> {
  if (rollbackRunId) return { runId: rollbackRunId, distance: null, warning: "Project baseline is temporarily rolled back", error: null };
  if (defaultBaselineId) return { runId: defaultBaselineId, distance: null, warning: null, error: null };
  if (!run.merge_base_sha) return run.pull_request_number === null
    ? { runId: null, distance: null, warning: null, error: null }
    : { runId: null, distance: null, warning: null, error: "Pull request merge-base history was not supplied" };
  const exact = await env.DB.prepare(`
    SELECT cr.run_id FROM commit_runs cr JOIN runs r
      ON r.id = cr.run_id AND r.organization_id = cr.organization_id AND r.state = 'complete'
     WHERE cr.organization_id = ? AND cr.suite_id = ? AND cr.commit_sha = ?
       AND r.artifacts_expired_at IS NULL AND r.artifact_expiry_owner IS NULL AND r.metadata_deletion_owner IS NULL
  `).bind(run.organization_id, run.suite_id, run.merge_base_sha).first<{ run_id: string }>();
  if (exact) return { runId: exact.run_id, distance: 0, warning: null, error: null };
  const graph = await env.DB.prepare("SELECT parents_complete FROM commits WHERE organization_id = ? AND project_id = ? AND sha = ?")
    .bind(run.organization_id, run.project_id, run.merge_base_sha).first<{ parents_complete: number }>();
  if (!graph || graph.parents_complete !== 1) {
    return { runId: null, distance: null, warning: null, error: "Commit history is incomplete; backfill merge-base ancestry and retry" };
  }
  if (Math.floor(Date.now() / 1000) - run.completed_at < 120) throw new Error("Waiting for the exact merge-base baseline run");
  const candidate = await env.DB.prepare(`
    WITH RECURSIVE ancestors(sha, distance, path) AS (
      SELECT ?, 0, ',' || ? || ','
      UNION ALL
      SELECT e.parent_sha, a.distance + 1, a.path || e.parent_sha || ','
        FROM ancestors a JOIN commit_edges e
          ON e.organization_id = ? AND e.project_id = ? AND e.child_sha = a.sha
       WHERE a.distance < 10000 AND instr(a.path, ',' || e.parent_sha || ',') = 0
    )
    SELECT cr.run_id, a.distance FROM ancestors a JOIN commit_runs cr
      ON cr.organization_id = ? AND cr.suite_id = ? AND cr.commit_sha = a.sha
      JOIN runs r ON r.id = cr.run_id AND r.organization_id = cr.organization_id AND r.state = 'complete'
       AND r.artifacts_expired_at IS NULL AND r.artifact_expiry_owner IS NULL AND r.metadata_deletion_owner IS NULL
     ORDER BY a.distance, a.sha LIMIT 1
  `).bind(run.merge_base_sha, run.merge_base_sha, run.organization_id, run.project_id, run.organization_id, run.suite_id)
    .first<{ run_id: string; distance: number }>();
  const incomplete = await env.DB.prepare(`
    WITH RECURSIVE ancestors(sha, distance, path) AS (
      SELECT ?, 0, ',' || ? || ','
      UNION ALL
      SELECT e.parent_sha, a.distance + 1, a.path || e.parent_sha || ','
        FROM ancestors a JOIN commit_edges e
          ON e.organization_id = ? AND e.project_id = ? AND e.child_sha = a.sha
       WHERE a.distance < 10000 AND instr(a.path, ',' || e.parent_sha || ',') = 0
    )
    SELECT MIN(a.distance) AS distance FROM ancestors a JOIN commits c
      ON c.organization_id = ? AND c.project_id = ? AND c.sha = a.sha
     WHERE c.parents_complete = 0
  `).bind(run.merge_base_sha, run.merge_base_sha, run.organization_id, run.project_id,
    run.organization_id, run.project_id).first<{ distance: number | null }>();
  if (incomplete?.distance !== null && incomplete?.distance !== undefined
    && (!candidate || incomplete.distance <= candidate.distance)) {
    return { runId: null, distance: null, warning: null, error: "Commit history is incomplete before the nearest eligible baseline" };
  }
  if (candidate) return {
    runId: candidate.run_id,
    distance: candidate.distance,
    warning: candidate.distance > 0 ? `Using an older ancestor baseline (${candidate.distance} commit edges)` : null,
    error: null,
  };
  return { runId: null, distance: null, warning: "No eligible baseline run exists in known history", error: null };
}

async function createComparison(
  env: Env,
  run: RunRecord,
  baselineRunId: string | null,
  distance: number | null,
  warning: string | null,
  selectionError: string | null,
  isDefaultBranch: boolean,
): Promise<void> {
  const comparisonId = randomId("cmp");
  const counts = baselineRunId
    ? await env.DB.prepare(`
        SELECT
          SUM(CASE WHEN b.name IS NULL THEN 1 ELSE 0 END) AS added,
          SUM(CASE WHEN c.name IS NULL THEN 1 ELSE 0 END) AS removed,
          SUM(CASE WHEN c.name IS NOT NULL AND b.name IS NOT NULL AND c.image_id != b.image_id THEN 1 ELSE 0 END) AS changed,
          SUM(CASE WHEN c.name IS NOT NULL AND b.name IS NOT NULL AND c.image_id = b.image_id THEN 1 ELSE 0 END) AS unchanged
        FROM (SELECT name, image_id FROM screenshots WHERE organization_id = ? AND run_id = ?) c
        LEFT JOIN (SELECT name, image_id FROM screenshots WHERE organization_id = ? AND run_id = ?) b ON b.name = c.name
      `).bind(run.organization_id, run.id, run.organization_id, baselineRunId).first<Record<string, number | null>>()
    : await env.DB.prepare("SELECT COUNT(*) AS added, 0 AS removed, 0 AS changed, 0 AS unchanged FROM screenshots WHERE organization_id = ? AND run_id = ?")
        .bind(run.organization_id, run.id).first<Record<string, number | null>>();
  let added = Number(counts?.["added"] ?? 0);
  let removed = Number(counts?.["removed"] ?? 0);
  let changed = Number(counts?.["changed"] ?? 0);
  const unchanged = Number(counts?.["unchanged"] ?? 0);
  if (baselineRunId) {
    const removedRow = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM screenshots b
       WHERE b.organization_id = ? AND b.run_id = ? AND NOT EXISTS (
         SELECT 1 FROM screenshots c WHERE c.organization_id = ? AND c.run_id = ? AND c.name = b.name
       )
    `).bind(run.organization_id, baselineRunId, run.organization_id, run.id).first<{ count: number }>();
    removed = removedRow?.count ?? 0;
  }
  if (selectionError) { added = 0; removed = 0; changed = 0; }
  const hasChanges = added + removed + changed > 0;
  const status = selectionError ? "error" : isDefaultBranch || !hasChanges ? "passed" : "action_required";
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      INSERT INTO comparisons
        (id, organization_id, project_id, suite_id, baseline_run_id, current_run_id, added_count,
         removed_count, changed_count, unchanged_count, status, baseline_warning, baseline_distance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(comparisonId, run.organization_id, run.project_id, run.suite_id, baselineRunId, run.id,
      added, removed, changed, unchanged, status, selectionError ?? warning, distance),
  ];
  if (!selectionError) statements.push(env.DB.prepare(`
      INSERT INTO comparison_entries (organization_id, comparison_id, name, kind, current_image_id)
      SELECT ?, ?, c.name, 'added', c.image_id FROM screenshots c
       WHERE c.organization_id = ? AND c.run_id = ? AND NOT EXISTS (
         SELECT 1 FROM screenshots b WHERE b.organization_id = ? AND b.run_id = ? AND b.name = c.name
       )
    `).bind(run.organization_id, comparisonId, run.organization_id, run.id, run.organization_id, baselineRunId ?? ""));
  if (baselineRunId && !selectionError) {
    statements.push(
      env.DB.prepare(`
        INSERT INTO comparison_entries (organization_id, comparison_id, name, kind, baseline_image_id)
        SELECT ?, ?, b.name, 'removed', b.image_id FROM screenshots b
         WHERE b.organization_id = ? AND b.run_id = ? AND NOT EXISTS (
           SELECT 1 FROM screenshots c WHERE c.organization_id = ? AND c.run_id = ? AND c.name = b.name
         )
      `).bind(run.organization_id, comparisonId, run.organization_id, baselineRunId, run.organization_id, run.id),
      env.DB.prepare(`
        INSERT INTO comparison_entries (organization_id, comparison_id, name, kind, baseline_image_id, current_image_id)
        SELECT ?, ?, c.name, CASE WHEN c.image_id = b.image_id THEN 'unchanged' ELSE 'changed' END, b.image_id, c.image_id
          FROM screenshots c JOIN screenshots b ON b.organization_id = c.organization_id AND b.name = c.name
         WHERE c.organization_id = ? AND c.run_id = ? AND b.run_id = ?
      `).bind(run.organization_id, comparisonId, run.organization_id, run.id, baselineRunId),
    );
  }
  if (run.pull_request_number !== null) {
    const retentionOwner = `${run.project_id}:pr:${run.pull_request_number}`;
    const checkScope = `pr:${run.pull_request_number}`;
    statements.push(env.DB.prepare(`
      INSERT INTO retention_pins (id, organization_id, owner_type, owner_id, run_id, comparison_id)
      SELECT ?, ?, 'open_pull_request', ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM runs WHERE id = ? AND organization_id = ? AND artifacts_expired_at IS NULL
          AND artifact_expiry_owner IS NULL AND metadata_deletion_owner IS NULL
      ) AND EXISTS (SELECT 1 FROM comparisons WHERE id = ? AND organization_id = ?)
      ON CONFLICT (organization_id, owner_type, owner_id, run_id, comparison_id) DO NOTHING
    `).bind(randomId("pin"), run.organization_id, retentionOwner, run.id, comparisonId,
      run.id, run.organization_id, comparisonId, run.organization_id));
    if (baselineRunId) {
      statements.push(env.DB.prepare(`
        INSERT INTO retention_pins (id, organization_id, owner_type, owner_id, run_id, comparison_id)
        SELECT ?, ?, 'open_pull_request', ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM runs WHERE id = ? AND organization_id = ? AND artifacts_expired_at IS NULL
            AND artifact_expiry_owner IS NULL AND metadata_deletion_owner IS NULL
        ) AND EXISTS (SELECT 1 FROM comparisons WHERE id = ? AND organization_id = ?)
        ON CONFLICT (organization_id, owner_type, owner_id, run_id, comparison_id) DO NOTHING
      `).bind(randomId("pin"), run.organization_id, retentionOwner, baselineRunId, comparisonId,
        baselineRunId, run.organization_id, comparisonId, run.organization_id));
    }
    const installation = await env.DB.prepare(`
      SELECT installation_id FROM github_installations WHERE organization_id = ?
       AND repository_owner = ? AND repository_name = ? AND suspended_at IS NULL LIMIT 1
    `).bind(run.organization_id, run.repository_owner, run.repository_name).first<{ installation_id: number }>();
    if (installation) {
      await ensureInProgressGitHubCheck(env, run.organization_id, run.project_id, run.id,
        run.pull_request_number, run.pull_request_head_sha ?? run.commit_sha, run.provider_run_id, run.attempt_number);
      const existingCheck = await env.DB.prepare("SELECT id, desired_version FROM github_checks WHERE organization_id = ? AND run_id = ?")
        .bind(run.organization_id, run.id).first<{ id: string; desired_version: number }>();
      addGitHubCheckStatements(statements, env, run, comparisonId, installation.installation_id, checkScope, existingCheck ?? undefined);
    }
  }
  await env.DB.batch(statements);
}

function addGitHubCheckStatements(
  statements: D1PreparedStatement[],
  env: Env,
  run: RunRecord,
  comparisonId: string,
  installationId: number,
  scopeKey: string,
  existingCheck?: { id: string; desired_version: number },
): void {
  const checkId = existingCheck?.id ?? randomId("ghc");
  const desiredVersion = (existingCheck?.desired_version ?? 0) + 1;
  statements.push(
    existingCheck
      ? env.DB.prepare(`
          UPDATE github_checks SET desired_version = ?, state = 'pending', installation_id = ?, scope_key = ?, updated_at = unixepoch()
           WHERE id = ? AND organization_id = ?
        `).bind(desiredVersion, String(installationId), scopeKey, checkId, run.organization_id)
      : env.DB.prepare(`
          INSERT INTO github_checks (id, organization_id, project_id, run_id, installation_id, scope_key)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(checkId, run.organization_id, run.project_id, run.id, String(installationId), scopeKey),
    env.DB.prepare(`
      INSERT INTO jobs (id, organization_id, kind, deduplication_key, payload_json)
      VALUES (?, ?, 'deliver_github_check', ?, ?)
      ON CONFLICT (organization_id, deduplication_key) DO NOTHING
    `).bind(randomId("job"), run.organization_id, `github:${checkId}:${desiredVersion}`, JSON.stringify({ checkId, comparisonId })),
  );
}

async function promoteDefaultRun(env: Env, run: RunRecord): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO commit_runs (organization_id, suite_id, commit_sha, run_id) VALUES (?, ?, ?, ?)
    ON CONFLICT (organization_id, suite_id, commit_sha) DO NOTHING
  `).bind(run.organization_id, run.suite_id, run.commit_sha, run.id).run();
  const canonical = await env.DB.prepare("SELECT run_id FROM commit_runs WHERE organization_id = ? AND suite_id = ? AND commit_sha = ?")
    .bind(run.organization_id, run.suite_id, run.commit_sha).first<{ run_id: string }>();
  if (canonical?.run_id !== run.id) return;
  if (run.observed_default_head_sha && !(await isAncestor(env, run.organization_id, run.project_id, run.commit_sha, run.observed_default_head_sha))) {
    if (await hasIncompleteAncestry(env, run.organization_id, run.project_id, run.observed_default_head_sha)) {
      throw new Error("Default-branch ancestry is incomplete; backfill history before promotion");
    }
    await env.DB.prepare("UPDATE suites SET promotion_mode = 'paused', updated_at = unixepoch() WHERE id = ? AND organization_id = ?")
      .bind(run.suite_id, run.organization_id).run();
    return;
  }
  for (let retry = 0; retry < 5; retry++) {
  const currentSuite = await env.DB.prepare("SELECT active_baseline_run_id, promotion_mode FROM suites WHERE id = ? AND organization_id = ?")
    .bind(run.suite_id, run.organization_id).first<{ active_baseline_run_id: string | null; promotion_mode: string }>();
  if (!currentSuite || currentSuite.promotion_mode !== "automatic" || currentSuite.active_baseline_run_id === run.id) return;
  const activeRunId = currentSuite.active_baseline_run_id;
  if (activeRunId) {
    const active = await env.DB.prepare("SELECT commit_sha FROM runs WHERE id = ? AND organization_id = ?")
      .bind(activeRunId, run.organization_id).first<{ commit_sha: string }>();
    if (!active || active.commit_sha === run.commit_sha) return;
    if (!(await isAncestor(env, run.organization_id, run.project_id, active.commit_sha, run.commit_sha))) {
      if (await isAncestor(env, run.organization_id, run.project_id, run.commit_sha, active.commit_sha)) return;
      if (await hasIncompleteAncestry(env, run.organization_id, run.project_id, run.commit_sha)) {
        throw new Error("Run ancestry is incomplete; backfill history before promotion");
      }
      await env.DB.prepare("UPDATE suites SET promotion_mode = 'paused', updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND active_baseline_run_id = ?")
        .bind(run.suite_id, run.organization_id, activeRunId).run();
      return;
    }
  }
  const action = activeRunId ? "promote" : "seed";
  const baselineId = randomId("bsl");
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO baselines (id, organization_id, suite_id, run_id, action, previous_run_id)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM suites WHERE id = ? AND organization_id = ?
          AND ${activeRunId ? "active_baseline_run_id = ?" : "active_baseline_run_id IS NULL"}
          AND promotion_mode = 'automatic'
      ) AND EXISTS (
        SELECT 1 FROM runs WHERE id = ? AND organization_id = ? AND artifacts_expired_at IS NULL
          AND artifact_expiry_owner IS NULL AND metadata_deletion_owner IS NULL
      )
    `).bind(baselineId, run.organization_id, run.suite_id, run.id, action, activeRunId,
      run.suite_id, run.organization_id, ...(activeRunId ? [activeRunId] : []), run.id, run.organization_id),
    env.DB.prepare(`
      UPDATE retention_pins SET released_at = unixepoch()
       WHERE organization_id = ? AND owner_type = 'active_baseline' AND owner_id = ? AND released_at IS NULL
         AND EXISTS (SELECT 1 FROM baselines WHERE id = ?)
    `).bind(run.organization_id, run.suite_id, baselineId),
    env.DB.prepare(`
      INSERT INTO retention_pins (id, organization_id, owner_type, owner_id, run_id)
      SELECT ?, ?, 'active_baseline', ?, ? WHERE EXISTS (SELECT 1 FROM baselines WHERE id = ?)
        AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND organization_id = ?
          AND artifacts_expired_at IS NULL AND artifact_expiry_owner IS NULL AND metadata_deletion_owner IS NULL)
    `).bind(randomId("pin"), run.organization_id, run.suite_id, run.id, baselineId, run.id, run.organization_id),
    env.DB.prepare(`
      UPDATE suites SET active_baseline_run_id = ?, baseline_version = baseline_version + 1,
        known_default_head_sha = ?, updated_at = unixepoch()
       WHERE id = ? AND organization_id = ? AND promotion_mode = 'automatic'
         AND ${activeRunId ? "active_baseline_run_id = ?" : "active_baseline_run_id IS NULL"}
         AND EXISTS (SELECT 1 FROM retention_pins WHERE organization_id = ? AND owner_type = 'active_baseline'
           AND owner_id = ? AND run_id = ? AND released_at IS NULL)
    `).bind(run.id, run.observed_default_head_sha ?? run.commit_sha, run.suite_id, run.organization_id,
      ...(activeRunId ? [activeRunId] : []), run.organization_id, run.suite_id, run.id),
  ]);
  const promoted = await env.DB.prepare("SELECT 1 AS promoted FROM suites WHERE id = ? AND organization_id = ? AND active_baseline_run_id = ?")
    .bind(run.suite_id, run.organization_id, run.id).first();
  if (promoted) return;
  }
  throw new Error("Baseline promotion remained contended after retries");
}

export async function isAncestor(
  env: Env,
  organizationId: string,
  projectId: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  if (ancestor === descendant) return true;
  const result = await env.DB.prepare(`
    WITH RECURSIVE ancestors(sha, path) AS (
      SELECT ?, ',' || ? || ','
      UNION ALL
      SELECT e.parent_sha, a.path || e.parent_sha || ',' FROM ancestors a JOIN commit_edges e
        ON e.organization_id = ? AND e.project_id = ? AND e.child_sha = a.sha
       WHERE instr(a.path, ',' || e.parent_sha || ',') = 0
    ) SELECT 1 AS found FROM ancestors WHERE sha = ? LIMIT 1
  `).bind(descendant, descendant, organizationId, projectId, ancestor).first();
  return result !== null;
}

async function hasIncompleteAncestry(env: Env, organizationId: string, projectId: string, descendant: string): Promise<boolean> {
  const result = await env.DB.prepare(`
    WITH RECURSIVE ancestors(sha, path) AS (
      SELECT ?, ',' || ? || ','
      UNION ALL
      SELECT e.parent_sha, a.path || e.parent_sha || ',' FROM ancestors a JOIN commit_edges e
        ON e.organization_id = ? AND e.project_id = ? AND e.child_sha = a.sha
       WHERE instr(a.path, ',' || e.parent_sha || ',') = 0
    )
    SELECT 1 AS found FROM ancestors a LEFT JOIN commits c
      ON c.organization_id = ? AND c.project_id = ? AND c.sha = a.sha
     WHERE c.sha IS NULL OR c.parents_complete = 0 LIMIT 1
  `).bind(descendant, descendant, organizationId, projectId, organizationId, projectId).first();
  return result !== null;
}
