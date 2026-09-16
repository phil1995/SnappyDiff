import { beginLogin, finishLogin, logout, requireSession } from "./auth.ts";
import { randomId, sha256 } from "./crypto.ts";
import { errorResponse, HttpError, json, withRequestId, type RequestContext } from "./http.ts";
import { drainJobs, enqueueSystemJob } from "./jobs.ts";
import type { Env, ExecutionContext, ScheduledController } from "./platform.ts";
import { createProject, getProject, listProjects } from "./projects.ts";
import { enforceRateLimit } from "./rate-limit.ts";
import { handleWorkOSWebhook } from "./workos-webhook.ts";

const API_PREFIX = "/api/v1";

async function handle(request: Request, env: Env, context: RequestContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    return json({ status: "ok", environment: env.APP_ENV });
  }
  if (url.pathname === "/auth/login" && request.method === "GET") {
    const ipKey = await requestRateKey(request, "auth");
    await enforceRateLimit(env, ipKey, 20, 60);
    return beginLogin(request, env);
  }
  if (url.pathname === "/auth/callback" && request.method === "GET") return finishLogin(request, env);
  if (url.pathname === "/auth/logout" && request.method === "POST") return logout(env);
  if (url.pathname === "/webhooks/workos" && request.method === "POST") {
    const ipKey = await requestRateKey(request, "workos-webhook");
    await enforceRateLimit(env, ipKey, 120, 60);
    return handleWorkOSWebhook(request, env, context.requestId);
  }

  if (url.pathname.startsWith(API_PREFIX)) {
    const session = await requireSession(request, env);
    await enforceRateLimit(env, `api:${session.organizationId}:${session.userId}`, 300, 60);
    if (url.pathname === `${API_PREFIX}/me` && request.method === "GET") {
      return json({ user: { id: session.userId, email: session.email, role: session.role }, organizationId: session.organizationId });
    }
    if (url.pathname === `${API_PREFIX}/projects`) {
      if (request.method === "GET") return listProjects(env, session);
      if (request.method === "POST") return createProject(request, env, session, context);
    }
    const projectMatch = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_]+)$/);
    if (projectMatch?.[1] && request.method === "GET") return getProject(env, session, projectMatch[1]);
    throw new HttpError(404, "route_not_found", "API route was not found");
  }

  if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/webhooks/")) {
    throw new HttpError(404, "route_not_found", "Route was not found");
  }
  return env.ASSETS.fetch(request);
}

async function requestRateKey(request: Request, namespace: string): Promise<string> {
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  return `${namespace}:${await sha256(address)}`;
}

function secure(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", "default-src 'self'; img-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://api.workos.com");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (env.APP_ENV !== "local") headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
    const context: RequestContext = { requestId: request.headers.get("x-request-id") ?? randomId("req"), startedAt: Date.now() };
    let response: Response;
    try {
      response = await handle(request, env, context);
    } catch (error) {
      response = errorResponse(error, context.requestId);
    }
    console.log(JSON.stringify({
      level: "info", requestId: context.requestId, method: request.method,
      path: new URL(request.url).pathname, status: response.status, durationMs: Date.now() - context.startedAt,
    }));
    execution.waitUntil(Promise.resolve());
    return secure(withRequestId(response, context), env);
  },

  async scheduled(_controller: ScheduledController, env: Env, execution: ExecutionContext): Promise<void> {
    await enqueueSystemJob(env, "reconcile", `system:reconcile:${Math.floor(Date.now() / 300000)}`);
    await enqueueSystemJob(env, "cleanup", `system:cleanup:${Math.floor(Date.now() / 3600000)}`);
    execution.waitUntil(drainJobs(env, 50));
  },
};
