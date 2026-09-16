import { randomId } from "./crypto.ts";
import type { Env } from "./platform.ts";

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

export async function recordAudit(env: Env, event: AuditEvent): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO audit_events
      (id, organization_id, actor_user_id, actor_token_id, action, target_type, target_id, request_id, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    randomId("aud"), event.organizationId, event.actorUserId ?? null, event.actorTokenId ?? null,
    event.action, event.targetType, event.targetId ?? null, event.requestId, JSON.stringify(event.metadata ?? {}),
  ).run();
}

