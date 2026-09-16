import { AwsClient } from "aws4fetch";
import { signJson, verifyJson } from "./crypto.ts";
import { HttpError, json, readBytes } from "./http.ts";
import type { Env } from "./platform.ts";

const FIFTEEN_MINUTES = 15 * 60;

interface LocalUploadGrant {
  sessionId: string;
  organizationId: string;
  temporaryKey: string;
  expectedBytes: number;
  exp: number;
}

export interface UploadTarget {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: number;
}

export async function createUploadTarget(
  env: Env,
  session: { id: string; organizationId: string; temporaryKey: string; expectedBytes: number },
): Promise<UploadTarget> {
  const expiresAt = Math.floor(Date.now() / 1000) + FIFTEEN_MINUTES;
  if (env.APP_ENV === "local") {
    if (!env.TOKEN_PEPPER || env.TOKEN_PEPPER.length < 32) throw new HttpError(503, "uploads_not_configured", "Local upload signing is not configured");
    const token = await signJson<LocalUploadGrant>({
      sessionId: session.id, organizationId: session.organizationId, temporaryKey: session.temporaryKey,
      expectedBytes: session.expectedBytes, exp: expiresAt,
    }, env.TOKEN_PEPPER);
    return {
      url: `${env.APP_ORIGIN}/api/v1/uploads/${session.id}/content?token=${encodeURIComponent(token)}`,
      method: "PUT",
      headers: { "content-type": "image/png", "content-length": String(session.expectedBytes) },
      expiresAt,
    };
  }
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CLOUDFLARE_ACCOUNT_ID) {
    throw new HttpError(503, "uploads_not_configured", "Direct R2 upload signing is not configured");
  }
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const objectUrl = new URL(`https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${session.temporaryKey}`);
  objectUrl.searchParams.set("X-Amz-Expires", String(FIFTEEN_MINUTES));
  const signed = await client.sign(objectUrl, {
    method: "PUT",
    headers: { "content-type": "image/png" },
    aws: { signQuery: true },
  });
  return { url: signed.url, method: "PUT", headers: { "content-type": "image/png" }, expiresAt };
}

export async function handleLocalUpload(request: Request, env: Env, sessionId: string): Promise<Response> {
  if (env.APP_ENV !== "local" || !env.TOKEN_PEPPER) throw new HttpError(404, "route_not_found", "Route was not found");
  const token = new URL(request.url).searchParams.get("token");
  const grant = token ? await verifyJson<LocalUploadGrant>(token, env.TOKEN_PEPPER) : null;
  if (!grant || grant.exp < Date.now() / 1000 || grant.sessionId !== sessionId) {
    throw new HttpError(401, "invalid_upload_grant", "Upload grant is invalid or expired");
  }
  const session = await env.DB.prepare(`
    SELECT id FROM upload_sessions
     WHERE id = ? AND organization_id = ? AND temporary_key = ? AND expected_bytes = ?
       AND state = 'pending' AND expires_at > unixepoch()
  `).bind(sessionId, grant.organizationId, grant.temporaryKey, grant.expectedBytes).first();
  if (!session) throw new HttpError(409, "upload_session_unavailable", "Upload session is no longer available");
  const bytes = await readBytes(request, grant.expectedBytes);
  if (bytes.byteLength !== grant.expectedBytes) throw new HttpError(400, "upload_size_mismatch", "Uploaded byte count does not match the manifest");
  await env.IMAGES.put(grant.temporaryKey, bytes.buffer, { httpMetadata: { contentType: "image/png" } });
  await env.DB.prepare("UPDATE upload_sessions SET state = 'uploaded', upload_completed_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND state = 'pending'")
    .bind(sessionId, grant.organizationId).run();
  return json({ uploaded: true });
}

