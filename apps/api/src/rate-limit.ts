import { HttpError } from "./http.ts";
import type { Env } from "./platform.ts";

export async function enforceRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<void> {
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds;
  await env.DB.prepare(`
    INSERT INTO rate_limits (key, window_start, count, expires_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
  `).bind(key, windowStart, windowStart + windowSeconds * 2).run();
  const result = await env.DB.prepare("SELECT count FROM rate_limits WHERE key = ? AND window_start = ?")
    .bind(key, windowStart).first<{ count: number }>();
  if (!result || result.count > limit) {
    throw new HttpError(429, "rate_limit_exceeded", "Too many requests", { retryAfterSeconds: windowStart + windowSeconds - Math.floor(now / 1000) });
  }
}

export async function reserveUploadBytes(env: Env, organizationId: string, bytes: number): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new HttpError(400, "invalid_reservation", "Reservation bytes must be a positive integer");
  const result = await env.DB.prepare(`
    UPDATE organization_usage
       SET reserved_upload_bytes = reserved_upload_bytes + ?, updated_at = unixepoch()
     WHERE organization_id = ?
       AND stored_bytes + reserved_upload_bytes + ? <= upload_budget_bytes
  `).bind(bytes, organizationId, bytes).run();
  const changed = Number(result.meta?.["changes"] ?? 0);
  if (changed !== 1) throw new HttpError(429, "upload_budget_exceeded", "Organization upload budget is exhausted");
}

