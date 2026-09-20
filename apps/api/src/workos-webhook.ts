import { timingSafeEqual } from "./crypto.ts";
import { auditStatement } from "./audit.ts";
import { HttpError, json, readBytes } from "./http.ts";
import type { Env } from "./platform.ts";

interface WorkOSEvent {
  id?: string;
  event?: string;
  data?: {
    user_id?: string;
    organization_id?: string;
    status?: string;
    role?: { slug?: string } | string;
  };
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, value: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, value));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyWorkOSSignature(
  body: Uint8Array<ArrayBuffer>,
  signatureHeader: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  const fields = new Map(signatureHeader.split(",").map((part) => part.trim().split("=", 2) as [string, string]));
  const timestamp = fields.get("t");
  const signature = fields.get("v1");
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > 300) {
    throw new HttpError(401, "invalid_webhook_signature", "Webhook signature is invalid or expired");
  }
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix);
  signed.set(body, prefix.byteLength);
  const expected = await hmacHex(secret, signed);
  if (!timingSafeEqual(expected, signature)) throw new HttpError(401, "invalid_webhook_signature", "Webhook signature is invalid or expired");
}

export async function handleWorkOSWebhook(request: Request, env: Env, requestId: string): Promise<Response> {
  if (!env.WORKOS_WEBHOOK_SECRET) throw new HttpError(503, "webhook_not_configured", "WorkOS webhook handling is not configured");
  const body = await readBytes(request, 1024 * 1024);
  await verifyWorkOSSignature(body, request.headers.get("workos-signature") ?? "", env.WORKOS_WEBHOOK_SECRET);
  let event: WorkOSEvent;
  try {
    event = JSON.parse(new TextDecoder().decode(body)) as WorkOSEvent;
  } catch {
    throw new HttpError(400, "invalid_json", "Webhook body must be valid JSON");
  }
  if (!event.id || !event.event || !event.data?.organization_id || !event.data.user_id) {
    throw new HttpError(400, "invalid_webhook", "Webhook is missing required membership fields");
  }
  const organization = await env.DB.prepare("SELECT id FROM organizations WHERE workos_organization_id = ?")
    .bind(event.data.organization_id).first<{ id: string }>();
  const user = await env.DB.prepare("SELECT id FROM users WHERE workos_user_id = ?")
    .bind(event.data.user_id).first<{ id: string }>();
  if (!organization || !user) return json({ received: true }, { status: 202 });

  const deleted = event.event === "organization_membership.deleted";
  const roleValue = typeof event.data.role === "string" ? event.data.role : event.data.role?.slug;
  const role = roleValue === "viewer" || roleValue === "reviewer" || roleValue === "admin" ? roleValue : null;
  const status = deleted || event.data.status === "inactive" ? "suspended" : "active";
  const statements = [
    env.DB.prepare(`
      UPDATE memberships SET status = ?, role = COALESCE(?, role), updated_at = unixepoch()
      WHERE organization_id = ? AND user_id = ?
    `).bind(status, role, organization.id, user.id),
    auditStatement(env, { organizationId: organization.id, action: "membership.synced",
      targetType: "membership", targetId: user.id, requestId,
      metadata: { workosEventId: event.id, event: event.event, status, role } }),
  ];
  await env.DB.batch(statements);
  return json({ received: true });
}
