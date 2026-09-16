import type { Session } from "./auth.ts";
import { requirePermission } from "./authorization.ts";
import { randomId } from "./crypto.ts";
import { HttpError, json, readJson, type RequestContext } from "./http.ts";
import type { Env } from "./platform.ts";

export async function getComparison(env: Env, session: Session, comparisonId: string, after: string | null): Promise<Response> {
  requirePermission(session, "runs:view");
  const comparison = await env.DB.prepare(`
    SELECT c.id, c.current_run_id AS currentRunId, c.baseline_run_id AS baselineRunId,
      c.added_count AS addedCount, c.removed_count AS removedCount, c.changed_count AS changedCount,
      c.unchanged_count AS unchangedCount, c.status, c.baseline_warning AS baselineWarning,
      c.baseline_distance AS baselineDistance, c.reviewed_at AS reviewedAt,
      r.commit_sha AS commitSha, r.branch, p.id AS projectId, p.name AS projectName
      FROM comparisons c JOIN runs r ON r.id = c.current_run_id AND r.organization_id = c.organization_id
      JOIN projects p ON p.id = c.project_id AND p.organization_id = c.organization_id
     WHERE c.id = ? AND c.organization_id = ?
  `).bind(comparisonId, session.organizationId).first();
  if (!comparison) throw new HttpError(404, "comparison_not_found", "Comparison was not found");
  const result = await env.DB.prepare(`
    SELECT name, kind, baseline_image_id AS baselineImageId, current_image_id AS currentImageId
      FROM comparison_entries WHERE organization_id = ? AND comparison_id = ? AND name > ?
      ORDER BY name LIMIT 101
  `).bind(session.organizationId, comparisonId, after ?? "").all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const entries = rows.slice(0, 100);
  return json({ comparison, entries, nextCursor: rows.length > 100 ? entries.at(-1)?.["name"] : null });
}

export async function decideComparison(
  request: Request,
  env: Env,
  session: Session,
  comparisonId: string,
  context: RequestContext,
): Promise<Response> {
  requirePermission(session, "reports:accept");
  const body = await readJson<{ decision?: unknown; note?: unknown }>(request);
  if (body.decision !== "accepted" && body.decision !== "rejected") throw new HttpError(400, "invalid_decision", "Decision must be accepted or rejected");
  const note = body.note === undefined ? null : typeof body.note === "string" && body.note.length <= 2000 ? body.note : null;
  if (body.note !== undefined && note === null) throw new HttpError(400, "invalid_note", "Decision note must be at most 2000 characters");
  const comparison = await env.DB.prepare("SELECT id, status, current_run_id FROM comparisons WHERE id = ? AND organization_id = ?")
    .bind(comparisonId, session.organizationId).first<{ id: string; status: string; current_run_id: string }>();
  if (!comparison) throw new HttpError(404, "comparison_not_found", "Comparison was not found");
  if (comparison.status === body.decision) return json({ decision: comparison.status, repeated: true });
  if (comparison.status !== "action_required") throw new HttpError(409, "comparison_not_reviewable", "Comparison is not awaiting review");
  const check = await env.DB.prepare("SELECT id, desired_version FROM github_checks WHERE organization_id = ? AND run_id = ?")
    .bind(session.organizationId, comparison.current_run_id).first<{ id: string; desired_version: number }>();
  const statements = [
    env.DB.prepare(`
      INSERT INTO comparison_decisions (organization_id, comparison_id, decision, user_id, note)
      VALUES (?, ?, ?, ?, ?)
    `).bind(session.organizationId, comparisonId, body.decision, session.userId, note),
    env.DB.prepare(`
      UPDATE comparisons SET status = ?, decision_note = ?, reviewed_by_user_id = ?, reviewed_at = unixepoch()
       WHERE id = ? AND organization_id = ? AND status = 'action_required'
    `).bind(body.decision, note, session.userId, comparisonId, session.organizationId),
    env.DB.prepare(`
      INSERT INTO audit_events (id, organization_id, actor_user_id, action, target_type, target_id, request_id, metadata_json)
      VALUES (?, ?, ?, ?, 'comparison', ?, ?, ?)
    `).bind(randomId("aud"), session.organizationId, session.userId, `report.${body.decision}`, comparisonId, context.requestId, JSON.stringify({ note })),
  ];
  if (check) {
    const version = check.desired_version + 1;
    statements.push(
      env.DB.prepare("UPDATE github_checks SET desired_version = ?, state = 'pending', updated_at = unixepoch() WHERE id = ? AND organization_id = ?")
        .bind(version, check.id, session.organizationId),
      env.DB.prepare(`
        INSERT INTO jobs (id, organization_id, kind, deduplication_key, payload_json)
        VALUES (?, ?, 'deliver_github_check', ?, ?) ON CONFLICT (organization_id, deduplication_key) DO NOTHING
      `).bind(randomId("job"), session.organizationId, `github:${check.id}:${version}`, JSON.stringify({ checkId: check.id, comparisonId })),
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      const winner = await env.DB.prepare("SELECT decision FROM comparison_decisions WHERE organization_id = ? AND comparison_id = ?")
        .bind(session.organizationId, comparisonId).first<{ decision: string }>();
      if (winner?.decision === body.decision) return json({ decision: winner.decision, repeated: true });
      throw new HttpError(409, "comparison_already_reviewed", `Comparison was already ${winner?.decision ?? "reviewed"}`);
    }
    throw error;
  }
  return json({ decision: body.decision, repeated: false });
}
