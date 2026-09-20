import { randomId } from "./crypto.ts";
import type { D1PreparedStatement, Env } from "./platform.ts";

export interface AuditEvent {
  organizationId: string;
  actorUserId?: string;
  actorTokenId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  requestId: string;
  metadata?: Record<string, unknown>;
}

export function auditStatement(
  env: Env,
  event: AuditEvent,
  condition?: { sql: string; bindings: unknown[] },
): D1PreparedStatement {
  const values = [
    randomId("aud"), event.organizationId, event.actorUserId ?? null, event.actorTokenId ?? null,
    event.action, event.targetType, event.targetId ?? null, event.requestId, JSON.stringify(event.metadata ?? {}),
  ];
  return env.DB.prepare(`
    INSERT INTO audit_events
      (id, organization_id, actor_user_id, actor_token_id, action, target_type, target_id, request_id, metadata_json)
    ${condition ? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${condition.sql}` : "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"}
  `).bind(...values, ...(condition?.bindings ?? []));
}

export async function recordAudit(env: Env, event: AuditEvent): Promise<void> {
  await auditStatement(env, event).run();
}
