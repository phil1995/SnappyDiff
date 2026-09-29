import type { Session } from "./auth.ts";
import { auditStatement } from "./audit.ts";
import { hasPermission, requirePermission } from "./authorization.ts";
import { randomId } from "./crypto.ts";
import { HttpError, json, readJson, type RequestContext } from "./http.ts";
import type { Env } from "./platform.ts";

const PAGE_SIZE = 200;
const categories = new Set(["translation", "truncation", "layout", "other"]);
const statuses = new Set(["open", "resolved", "wont_fix"]);

type CommentStatus = "open" | "resolved" | "wont_fix";

interface CommentRecord {
  id: string;
  projectId: string;
  authorUserId: string;
  status: CommentStatus;
}

const commentColumns = `
  c.id, c.project_id AS projectId, c.screenshot_name AS screenshotName, c.run_id AS runId, c.image_id AS imageId,
  c.region_x AS regionX, c.region_y AS regionY, c.region_width AS regionWidth, c.region_height AS regionHeight,
  c.category, c.body, c.suggested_text AS suggestedText, c.status,
  c.author_user_id AS authorUserId, author.display_name AS authorName,
  c.status_changed_at AS statusChangedAt, changer.display_name AS statusChangedByName,
  c.created_at AS createdAt, c.updated_at AS updatedAt,
  (SELECT COUNT(*) FROM screen_comment_replies r WHERE r.organization_id = c.organization_id AND r.comment_id = c.id) AS replyCount`;
const commentJoins = `
  JOIN users author ON author.id = c.author_user_id
  LEFT JOIN users changer ON changer.id = c.status_changed_by_user_id`;

function presentComment(row: Record<string, unknown>) {
  const { regionX, regionY, regionWidth, regionHeight, ...rest } = row;
  const region = regionX === null || regionX === undefined ? null
    : { x: Number(regionX), y: Number(regionY), width: Number(regionWidth), height: Number(regionHeight) };
  return { ...rest, region };
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "invalid_comment", `${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, "invalid_comment", `${field} must be at most ${max} characters`);
  return trimmed;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return null;
  return text(value, field, max);
}

function category(value: unknown): string {
  if (typeof value !== "string" || !categories.has(value)) throw new HttpError(400, "invalid_comment", "Category must be translation, truncation, layout, or other");
  return value;
}

export function parseRegion(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (value === undefined || value === null) return null;
  const region = value as Record<string, unknown>;
  const numbers = ["x", "y", "width", "height"].map((key) => region?.[key]);
  if (!numbers.every((number) => typeof number === "number" && Number.isFinite(number))) {
    throw new HttpError(400, "invalid_region", "Region must contain numeric x, y, width, and height");
  }
  const [x, y, width, height] = (numbers as number[]).map((number) => Math.round(number * 1e6) / 1e6) as [number, number, number, number];
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
    throw new HttpError(400, "invalid_region", "Region must lie within the screenshot");
  }
  return { x, y, width, height };
}

async function requireProject(env: Env, session: Session, projectId: string): Promise<void> {
  const project = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ? AND deleted_at IS NULL")
    .bind(projectId, session.organizationId).first();
  if (!project) throw new HttpError(404, "project_not_found", "Project was not found");
}

async function requireComment(env: Env, session: Session, commentId: string): Promise<CommentRecord> {
  const comment = await env.DB.prepare(`
    SELECT c.id, c.project_id AS projectId, c.author_user_id AS authorUserId, c.status
      FROM screen_comments c JOIN projects p ON p.id = c.project_id AND p.organization_id = c.organization_id
     WHERE c.id = ? AND c.organization_id = ? AND p.deleted_at IS NULL
  `).bind(commentId, session.organizationId).first<CommentRecord>();
  if (!comment) throw new HttpError(404, "comment_not_found", "Comment was not found");
  return comment;
}

async function loadComment(env: Env, session: Session, commentId: string) {
  const row = await env.DB.prepare(`SELECT ${commentColumns} FROM screen_comments c ${commentJoins} WHERE c.id = ? AND c.organization_id = ?`)
    .bind(commentId, session.organizationId).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "comment_not_found", "Comment was not found");
  const replies = await env.DB.prepare(`
    SELECT r.id, r.body, r.author_user_id AS authorUserId, u.display_name AS authorName, r.created_at AS createdAt
      FROM screen_comment_replies r JOIN users u ON u.id = r.author_user_id
     WHERE r.organization_id = ? AND r.comment_id = ? ORDER BY r.created_at, r.id
  `).bind(session.organizationId, commentId).all<Record<string, unknown>>();
  return { ...presentComment(row), replies: replies.results ?? [] };
}

export async function listComments(env: Env, session: Session, projectId: string, parameters: URLSearchParams): Promise<Response> {
  requirePermission(session, "runs:view");
  await requireProject(env, session, projectId);
  const status = parameters.get("status");
  if (status && !statuses.has(status)) throw new HttpError(400, "invalid_status", "Status filter is invalid");
  const screenshot = parameters.get("screenshot");
  const cursor = parameters.get("before")?.match(/^(\d+):([A-Za-z0-9_]+)$/);
  if (parameters.get("before") && !cursor) throw new HttpError(400, "invalid_cursor", "Comment cursor is invalid");
  const beforeCreatedAt = cursor?.[1] ? Number(cursor[1]) : Number.MAX_SAFE_INTEGER;
  const beforeId = cursor?.[2] ?? "~";
  const result = await env.DB.prepare(`
    SELECT ${commentColumns} FROM screen_comments c ${commentJoins}
     WHERE c.organization_id = ? AND c.project_id = ?
       AND (? IS NULL OR c.status = ?) AND (? IS NULL OR c.screenshot_name = ?)
       AND (c.created_at < ? OR (c.created_at = ? AND c.id < ?))
     ORDER BY c.created_at DESC, c.id DESC LIMIT ?
  `).bind(session.organizationId, projectId, status, status, screenshot, screenshot, beforeCreatedAt, beforeCreatedAt, beforeId, PAGE_SIZE + 1)
    .all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return json({
    comments: page.map(presentComment),
    nextCursor: rows.length > PAGE_SIZE && last ? `${last["createdAt"]}:${last["id"]}` : null,
  });
}

export async function getComment(env: Env, session: Session, commentId: string): Promise<Response> {
  requirePermission(session, "runs:view");
  await requireComment(env, session, commentId);
  return json({ comment: await loadComment(env, session, commentId) });
}

export async function summarizeComments(env: Env, session: Session, projectId: string): Promise<Response> {
  requirePermission(session, "runs:view");
  await requireProject(env, session, projectId);
  const result = await env.DB.prepare(`
    SELECT screenshot_name AS screenshotName, COUNT(*) AS open FROM screen_comments
     WHERE organization_id = ? AND project_id = ? AND status = 'open'
     GROUP BY screenshot_name ORDER BY screenshot_name LIMIT 10000
  `).bind(session.organizationId, projectId).all();
  return json({ screenshots: result.results ?? [] });
}

export async function createComment(request: Request, env: Env, session: Session, projectId: string, context: RequestContext): Promise<Response> {
  requirePermission(session, "feedback:write");
  const body = await readJson<Record<string, unknown>>(request);
  const screenshotName = text(body["screenshotName"], "Screenshot", 1024);
  const runId = text(body["runId"], "Run", 100);
  const values = {
    region: parseRegion(body["region"]),
    category: category(body["category"]),
    body: text(body["body"], "Comment", 4000),
    suggestedText: optionalText(body["suggestedText"], "Suggested text", 2000),
  };
  const screenshot = await env.DB.prepare(`
    SELECT s.image_id AS imageId FROM screenshots s
      JOIN runs r ON r.id = s.run_id AND r.organization_id = s.organization_id
      JOIN projects p ON p.id = r.project_id AND p.organization_id = r.organization_id
     WHERE s.organization_id = ? AND s.run_id = ? AND s.name = ? AND r.project_id = ? AND p.deleted_at IS NULL
  `).bind(session.organizationId, runId, screenshotName, projectId).first<{ imageId: string }>();
  if (!screenshot) throw new HttpError(404, "screenshot_not_found", "Screenshot was not found in this project run");
  const id = randomId("cmt");
  const region = values.region;
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO screen_comments
        (id, organization_id, project_id, screenshot_name, run_id, image_id, region_x, region_y, region_width, region_height,
         category, body, suggested_text, author_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, session.organizationId, projectId, screenshotName, runId, screenshot.imageId,
      region?.x ?? null, region?.y ?? null, region?.width ?? null, region?.height ?? null,
      values.category, values.body, values.suggestedText, session.userId),
    auditStatement(env, { organizationId: session.organizationId, actorUserId: session.userId, action: "comment.created",
      targetType: "screen_comment", targetId: id, requestId: context.requestId, metadata: { projectId, screenshotName } }),
  ]);
  return json({ comment: await loadComment(env, session, id) }, { status: 201 });
}

export function canChangeStatus(session: Session, comment: CommentRecord, next: CommentStatus): boolean {
  if (!hasPermission(session, "feedback:write")) return false;
  if (hasPermission(session, "feedback:triage") || next === "open") return true;
  return next === "resolved" && comment.authorUserId === session.userId;
}

export async function updateComment(request: Request, env: Env, session: Session, commentId: string, context: RequestContext): Promise<Response> {
  requirePermission(session, "feedback:write");
  const comment = await requireComment(env, session, commentId);
  const body = await readJson<Record<string, unknown>>(request);
  const edits: Record<string, string | null> = {};
  if (body["body"] !== undefined) edits["body"] = text(body["body"], "Comment", 4000);
  if (body["category"] !== undefined) edits["category"] = category(body["category"]);
  if (body["suggestedText"] !== undefined) edits["suggested_text"] = optionalText(body["suggestedText"], "Suggested text", 2000);
  const status = body["status"];
  if (status !== undefined && (typeof status !== "string" || !statuses.has(status))) throw new HttpError(400, "invalid_status", "Status is invalid");
  if (!Object.keys(edits).length && status === undefined) throw new HttpError(400, "empty_update", "Nothing to update");
  if (Object.keys(edits).length && comment.authorUserId !== session.userId) {
    throw new HttpError(403, "permission_denied", "Only the author can edit this comment");
  }
  const nextStatus = status as CommentStatus | undefined;
  if (nextStatus && nextStatus !== comment.status && !canChangeStatus(session, comment, nextStatus)) {
    throw new HttpError(403, "permission_denied", nextStatus === "wont_fix"
      ? "Only reviewers and administrators can mark feedback as won't fix"
      : "Only the author, reviewers, and administrators can resolve this comment");
  }
  const statusChanged = Boolean(nextStatus && nextStatus !== comment.status);
  const assignments = Object.keys(edits).map((column) => `${column} = ?`);
  const bindings: unknown[] = Object.values(edits);
  if (statusChanged) {
    assignments.push("status = ?", "status_changed_by_user_id = ?", "status_changed_at = unixepoch()");
    bindings.push(nextStatus, session.userId);
  }
  if (assignments.length) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE screen_comments SET ${assignments.join(", ")}, updated_at = unixepoch() WHERE id = ? AND organization_id = ?`)
        .bind(...bindings, commentId, session.organizationId),
      auditStatement(env, { organizationId: session.organizationId, actorUserId: session.userId,
        action: statusChanged ? `comment.${nextStatus === "open" ? "reopened" : nextStatus}` : "comment.edited", targetType: "screen_comment", targetId: commentId,
        requestId: context.requestId, metadata: { fields: Object.keys(edits), previousStatus: comment.status } }),
    ]);
  }
  return json({ comment: await loadComment(env, session, commentId) });
}

export async function deleteComment(env: Env, session: Session, commentId: string, context: RequestContext): Promise<Response> {
  requirePermission(session, "feedback:write");
  const comment = await requireComment(env, session, commentId);
  if (comment.authorUserId !== session.userId && !hasPermission(session, "projects:admin")) {
    throw new HttpError(403, "permission_denied", "Only the author or an administrator can delete this comment");
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM screen_comments WHERE id = ? AND organization_id = ?").bind(commentId, session.organizationId),
    auditStatement(env, { organizationId: session.organizationId, actorUserId: session.userId, action: "comment.deleted",
      targetType: "screen_comment", targetId: commentId, requestId: context.requestId, metadata: { projectId: comment.projectId } }),
  ]);
  return new Response(null, { status: 204 });
}

export async function createReply(request: Request, env: Env, session: Session, commentId: string, context: RequestContext): Promise<Response> {
  requirePermission(session, "feedback:write");
  await requireComment(env, session, commentId);
  const body = await readJson<Record<string, unknown>>(request);
  const replyBody = text(body["body"], "Reply", 4000);
  const id = randomId("rpl");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO screen_comment_replies (id, organization_id, comment_id, body, author_user_id) VALUES (?, ?, ?, ?, ?)")
      .bind(id, session.organizationId, commentId, replyBody, session.userId),
    env.DB.prepare("UPDATE screen_comments SET updated_at = unixepoch() WHERE id = ? AND organization_id = ?").bind(commentId, session.organizationId),
    auditStatement(env, { organizationId: session.organizationId, actorUserId: session.userId, action: "comment.replied",
      targetType: "screen_comment", targetId: commentId, requestId: context.requestId, metadata: { replyId: id } }),
  ]);
  return json({ comment: await loadComment(env, session, commentId) }, { status: 201 });
}

export async function deleteReply(env: Env, session: Session, replyId: string, context: RequestContext): Promise<Response> {
  requirePermission(session, "feedback:write");
  const reply = await env.DB.prepare(`
    SELECT r.comment_id AS commentId, r.author_user_id AS authorUserId FROM screen_comment_replies r
     WHERE r.id = ? AND r.organization_id = ?
  `).bind(replyId, session.organizationId).first<{ commentId: string; authorUserId: string }>();
  if (!reply) throw new HttpError(404, "reply_not_found", "Reply was not found");
  await requireComment(env, session, reply.commentId);
  if (reply.authorUserId !== session.userId && !hasPermission(session, "projects:admin")) {
    throw new HttpError(403, "permission_denied", "Only the author or an administrator can delete this reply");
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM screen_comment_replies WHERE id = ? AND organization_id = ?").bind(replyId, session.organizationId),
    auditStatement(env, { organizationId: session.organizationId, actorUserId: session.userId, action: "comment.reply_deleted",
      targetType: "screen_comment", targetId: reply.commentId, requestId: context.requestId, metadata: { replyId } }),
  ]);
  return json({ comment: await loadComment(env, session, reply.commentId) });
}
