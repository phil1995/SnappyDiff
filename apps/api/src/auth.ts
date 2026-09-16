import { randomId, signJson, verifyJson } from "./crypto.ts";
import { HttpError } from "./http.ts";
import type { Env } from "./platform.ts";

const SESSION_COOKIE = "snappydiff_session";
const OAUTH_STATE_COOKIE = "snappydiff_oauth_state";
const SESSION_SECONDS = 15 * 60;

export type HumanRole = "viewer" | "reviewer" | "admin";

export interface Session {
  userId: string;
  externalUserId: string;
  organizationId: string;
  externalOrganizationId: string;
  role: HumanRole;
  email: string;
  exp: number;
}

interface OAuthState {
  nonce: string;
  returnTo: string;
  exp: number;
}

interface WorkOSAuthentication {
  user: { id: string; email: string; first_name?: string; last_name?: string };
  organization_id?: string;
}

function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) result.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()));
  }
  return result;
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function sessionSecret(env: Env): string {
  if (!env.WORKOS_COOKIE_PASSWORD || env.WORKOS_COOKIE_PASSWORD.length < 32) {
    throw new HttpError(503, "authentication_not_configured", "Authentication is not configured");
  }
  return env.WORKOS_COOKIE_PASSWORD;
}

export async function beginLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestedReturn = url.searchParams.get("return_to") ?? "/";
  const returnTo = safeReturnPath(requestedReturn, env.APP_ORIGIN);
  const state: OAuthState = { nonce: randomId("state"), returnTo, exp: Math.floor(Date.now() / 1000) + 600 };
  const encodedState = await signJson(state, sessionSecret(env));
  const authorize = new URL("https://api.workos.com/user_management/authorize");
  authorize.searchParams.set("client_id", env.WORKOS_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", env.WORKOS_REDIRECT_URI);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("provider", "authkit");
  authorize.searchParams.set("state", state.nonce);
  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      "set-cookie": cookie(OAUTH_STATE_COOKIE, encodedState, 600, env.APP_ENV !== "local"),
      "cache-control": "no-store",
    },
  });
}

export async function finishLogin(request: Request, env: Env): Promise<Response> {
  if (!env.WORKOS_API_KEY) throw new HttpError(503, "authentication_not_configured", "Authentication is not configured");
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const signedState = cookies(request).get(OAUTH_STATE_COOKIE);
  if (!code || !returnedState || !signedState) throw new HttpError(400, "invalid_oauth_callback", "OAuth callback is incomplete");
  const state = await verifyJson<OAuthState>(signedState, sessionSecret(env));
  if (!state || state.exp < Date.now() / 1000 || state.nonce !== returnedState) {
    throw new HttpError(400, "invalid_oauth_state", "OAuth state is invalid or expired");
  }

  const providerResponse = await fetch("https://api.workos.com/user_management/authenticate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.WORKOS_CLIENT_ID, client_secret: env.WORKOS_API_KEY, code, grant_type: "authorization_code" }),
  });
  if (!providerResponse.ok) throw new HttpError(401, "authentication_failed", "Authentication provider rejected the callback");
  const authentication = (await providerResponse.json()) as WorkOSAuthentication;
  if (!authentication.organization_id) throw new HttpError(403, "organization_required", "An organization membership is required");
  const session = await provisionSession(env, authentication);
  const signedSession = await signJson(session, sessionSecret(env));
  const headers = new Headers({ location: new URL(state.returnTo, env.APP_ORIGIN).toString(), "cache-control": "no-store" });
  headers.append("set-cookie", cookie(SESSION_COOKIE, signedSession, SESSION_SECONDS, env.APP_ENV !== "local"));
  headers.append("set-cookie", cookie(OAUTH_STATE_COOKIE, "", 0, env.APP_ENV !== "local"));
  return new Response(null, {
    status: 302,
    headers,
  });
}

export function safeReturnPath(value: string, origin: string): string {
  try {
    if (value.includes("\\")) return "/";
    const base = new URL(origin);
    const resolved = new URL(value, base);
    if (resolved.origin !== base.origin || !value.startsWith("/") || value.startsWith("//")) return "/";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}

async function provisionSession(env: Env, authentication: WorkOSAuthentication): Promise<Session> {
  const externalOrganizationId = authentication.organization_id!;
  const organization = await env.DB.prepare("SELECT id FROM organizations WHERE workos_organization_id = ?")
    .bind(externalOrganizationId).first<{ id: string }>();
  if (!organization) throw new HttpError(403, "organization_not_provisioned", "This organization has not been provisioned");
  const externalUserId = authentication.user.id;
  let user = await env.DB.prepare("SELECT id FROM users WHERE workos_user_id = ?").bind(externalUserId).first<{ id: string }>();
  if (!user) {
    const userId = randomId("usr");
    await env.DB.prepare("INSERT INTO users (id, workos_user_id, email, display_name) VALUES (?, ?, ?, ?)")
      .bind(userId, externalUserId, authentication.user.email, [authentication.user.first_name, authentication.user.last_name].filter(Boolean).join(" ") || authentication.user.email).run();
    user = { id: userId };
  }
  const membership = await env.DB.prepare("SELECT role FROM memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'")
    .bind(organization.id, user.id).first<{ role: HumanRole }>();
  if (!membership) throw new HttpError(403, "membership_required", "An active SnappyDiff membership is required");
  return {
    userId: user.id,
    externalUserId,
    organizationId: organization.id,
    externalOrganizationId,
    role: membership.role,
    email: authentication.user.email,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  };
}

export async function requireSession(request: Request, env: Env): Promise<Session> {
  const value = cookies(request).get(SESSION_COOKIE);
  if (!value) throw new HttpError(401, "authentication_required", "Authentication is required");
  const session = await verifyJson<Session>(value, sessionSecret(env));
  if (!session || session.exp < Date.now() / 1000) throw new HttpError(401, "session_expired", "Session is invalid or expired");
  const membership = await env.DB.prepare(`
    SELECT m.role FROM memberships m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'
      AND o.workos_organization_id = ? AND o.deletion_requested_at IS NULL
  `).bind(session.organizationId, session.userId, session.externalOrganizationId).first<{ role: HumanRole }>();
  if (!membership) throw new HttpError(403, "membership_required", "An active organization membership is required");
  return { ...session, role: membership.role };
}

export function logout(env: Env): Response {
  return new Response(null, { status: 204, headers: { "set-cookie": cookie(SESSION_COOKIE, "", 0, env.APP_ENV !== "local") } });
}
