import { beginLogin, finishLogin, logout, requireSession } from "./auth.ts";
import { randomId, sha256 } from "./crypto.ts";
import { errorResponse, HttpError, json, withRequestId, type RequestContext } from "./http.ts";
import { drainJobs, enqueueSystemJob } from "./jobs.ts";
import type { Env, ExecutionContext, ScheduledController } from "./platform.ts";
import { createProject, getProject, listProjects } from "./projects.ts";
import { enforceRateLimit } from "./rate-limit.ts";
import { handleWorkOSWebhook } from "./workos-webhook.ts";
import { requireMachinePrincipal } from "./machine-auth.ts";
import { handleLocalUpload } from "./upload-urls.ts";
import { completeUpload, finalizeShard, getRunStatus, listShardUploads, registerRun, submitManifestPage } from "./uploads.ts";
import { beginGitHubInstallationLink, handleGitHubWebhook, linkGitHubInstallation } from "./github.ts";
import { decideComparison, getComparison } from "./reports.ts";
import { exchangeGitHubOidc } from "./github-oidc.ts";
import { getDashboardRun, getPrivateImage, listProjectRuns } from "./dashboard.ts";
import {
  controlBaseline, createToken, getProjectOperations, listMembers, listTokens,
  revokeToken, rotateToken, updateMember, updateProjectSettings,
} from "./management.ts";
import {
  cancelOrganizationDeletion, exportOrganization, requireOrganizationWritable, scheduleOrganizationDeletion,
} from "./privacy.ts";

const API_PREFIX = "/api/v1";

async function handle(request: Request, env: Env, context: RequestContext, execution: ExecutionContext): Promise<Response> {
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
  if (url.pathname === "/webhooks/github" && request.method === "POST") {
    const ipKey = await requestRateKey(request, "github-webhook");
    await enforceRateLimit(env, ipKey, 300, 60);
    const response = await handleGitHubWebhook(request, env);
    execution.waitUntil(drainJobs(env, 10));
    return response;
  }
  if (url.pathname === `${API_PREFIX}/auth/github-oidc/exchange` && request.method === "POST") {
    const ipKey = await requestRateKey(request, "github-oidc");
    await enforceRateLimit(env, ipKey, 60, 60);
    return exchangeGitHubOidc(request, env);
  }

  const localUploadMatch = url.pathname.match(/^\/api\/v1\/uploads\/([A-Za-z0-9_]+)\/content$/);
  if (localUploadMatch?.[1] && request.method === "PUT") return handleLocalUpload(request, env, localUploadMatch[1]);

  const registerMatch = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_]+)\/runs$/);
  const manifestMatch = url.pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9_]+)\/shards\/([A-Za-z0-9_]+)\/manifest-pages$/);
  const finalizeMatch = url.pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9_]+)\/shards\/([A-Za-z0-9_]+)\/finalize$/);
  const uploadsMatch = url.pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9_]+)\/shards\/([A-Za-z0-9_]+)\/uploads$/);
  const completeUploadMatch = url.pathname.match(/^\/api\/v1\/upload-sessions\/([A-Za-z0-9_]+)\/complete$/);
  const statusMatch = url.pathname.match(/^\/api\/v1\/runs\/([A-Za-z0-9_]+)$/);
  if (registerMatch || manifestMatch || finalizeMatch || uploadsMatch || completeUploadMatch || statusMatch) {
    const principal = await requireMachinePrincipal(request, env);
    await enforceRateLimit(env, `machine:${principal.organizationId}:${principal.tokenId}`, 600, 60);
    if (request.method !== "GET") await requireOrganizationWritable(env, principal.organizationId);
    if (registerMatch?.[1] && request.method === "POST") return registerRun(request, env, principal, registerMatch[1]);
    if (manifestMatch?.[1] && manifestMatch[2] && request.method === "POST") return submitManifestPage(request, env, principal, manifestMatch[1], manifestMatch[2]);
    if (finalizeMatch?.[1] && finalizeMatch[2] && request.method === "POST") {
      const response = await finalizeShard(env, principal, finalizeMatch[1], finalizeMatch[2]);
      execution.waitUntil(drainJobs(env, 10));
      return response;
    }
    if (uploadsMatch?.[1] && uploadsMatch[2] && request.method === "GET") return listShardUploads(env, principal, uploadsMatch[1], uploadsMatch[2], url.searchParams.get("after"));
    if (completeUploadMatch?.[1] && request.method === "POST") {
      const response = await completeUpload(env, principal, completeUploadMatch[1]);
      execution.waitUntil(drainJobs(env, 10));
      return response;
    }
    if (statusMatch?.[1] && request.method === "GET") return getRunStatus(env, principal, statusMatch[1]);
    throw new HttpError(405, "method_not_allowed", "Method is not allowed for this route");
  }

  if (url.pathname.startsWith(API_PREFIX)) {
    const session = await requireSession(request, env);
    await enforceRateLimit(env, `api:${session.organizationId}:${session.userId}`, 300, 60);
    if (url.pathname === `${API_PREFIX}/organization/export` && request.method === "GET") {
      return exportOrganization(env, session);
    }
    if (url.pathname === `${API_PREFIX}/organization/deletion`) {
      if (request.method === "POST") return scheduleOrganizationDeletion(request, env, session, context);
      if (request.method === "DELETE") return cancelOrganizationDeletion(env, session, context);
    }
    if (request.method !== "GET") await requireOrganizationWritable(env, session.organizationId);
    if (url.pathname === `${API_PREFIX}/me` && request.method === "GET") {
      return json({ user: { id: session.userId, email: session.email, role: session.role }, organizationId: session.organizationId });
    }
    if (url.pathname === `${API_PREFIX}/projects`) {
      if (request.method === "GET") return listProjects(env, session);
      if (request.method === "POST") return createProject(request, env, session, context);
    }
    const installationLink = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_]+)\/github-installation$/);
    const installationAuthorize = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_]+)\/github-installation\/authorize$/);
    if (installationAuthorize?.[1] && request.method === "POST") return beginGitHubInstallationLink(request, env, session, installationAuthorize[1]);
    if (installationLink?.[1] && request.method === "POST") return linkGitHubInstallation(request, env, session, installationLink[1], context);
    const comparisonMatch = url.pathname.match(/^\/api\/v1\/comparisons\/([A-Za-z0-9_]+)$/);
    if (comparisonMatch?.[1] && request.method === "GET") return getComparison(env, session, comparisonMatch[1], url.searchParams.get("after"));
    const decisionMatch = url.pathname.match(/^\/api\/v1\/comparisons\/([A-Za-z0-9_]+)\/decision$/);
    if (decisionMatch?.[1] && request.method === "POST") {
      const response = await decideComparison(request, env, session, decisionMatch[1], context);
      execution.waitUntil(drainJobs(env, 10));
      return response;
    }
    const runHistoryMatch = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_]+)\/run-history$/);
    if (runHistoryMatch?.[1] && request.method === "GET") return listProjectRuns(env, session, runHistoryMatch[1], url.searchParams.get("before"));
    const dashboardRunMatch = url.pathname.match(/^\/api\/v1\/dashboard\/runs\/([A-Za-z0-9_]+)$/);
    if (dashboardRunMatch?.[1] && request.method === "GET") return getDashboardRun(env, session, dashboardRunMatch[1]);
    const imageMatch = url.pathname.match(/^\/api\/v1\/images\/([A-Za-z0-9_]+)\/content$/);
    if (imageMatch?.[1] && request.method === "GET") return getPrivateImage(env, session, imageMatch[1]);
    const settingsMatch = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_]+)\/settings$/);
    if (settingsMatch?.[1]) {
      if (request.method === "GET") return getProjectOperations(env, session, settingsMatch[1]);
      if (request.method === "PATCH") return updateProjectSettings(request, env, session, settingsMatch[1], context);
    }
    const baselineControlMatch = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_]+)\/baseline-control$/);
    if (baselineControlMatch?.[1] && request.method === "POST") return controlBaseline(request, env, session, baselineControlMatch[1], context);
    if (url.pathname === `${API_PREFIX}/members` && request.method === "GET") return listMembers(env, session);
    const memberMatch = url.pathname.match(/^\/api\/v1\/members\/([A-Za-z0-9_]+)$/);
    if (memberMatch?.[1] && request.method === "PATCH") return updateMember(request, env, session, memberMatch[1], context);
    const projectTokensMatch = url.pathname.match(/^\/api\/v1\/projects\/([A-Za-z0-9_]+)\/tokens$/);
    if (projectTokensMatch?.[1]) {
      if (request.method === "GET") return listTokens(env, session, projectTokensMatch[1]);
      if (request.method === "POST") return createToken(request, env, session, projectTokensMatch[1], context);
    }
    const tokenMatch = url.pathname.match(/^\/api\/v1\/tokens\/([A-Za-z0-9_]+)$/);
    if (tokenMatch?.[1] && request.method === "DELETE") return revokeToken(env, session, tokenMatch[1], context);
    const tokenRotationMatch = url.pathname.match(/^\/api\/v1\/tokens\/([A-Za-z0-9_]+)\/rotate$/);
    if (tokenRotationMatch?.[1] && request.method === "POST") return rotateToken(request, env, session, tokenRotationMatch[1], context);
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
      response = await handle(request, env, context, execution);
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
