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

