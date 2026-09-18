import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "./auth.ts";
import { beginGitHubOnboarding, completeGitHubOnboarding, githubProjectSlug, verifyGitHubWebhook } from "./github.ts";
import type { Env } from "./platform.ts";

const encoder = new TextEncoder();

async function signature(body: Uint8Array<ArrayBuffer>, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("GitHub webhook signatures", () => {
  it("accepts the exact signed bytes and rejects modification", async () => {
    const body = encoder.encode('{"action":"opened"}');
    const value = await signature(body, "github-webhook-secret");
    await assert.doesNotReject(verifyGitHubWebhook(body, value, "github-webhook-secret"));
    await assert.rejects(verifyGitHubWebhook(encoder.encode('{"action":"closed"}'), value, "github-webhook-secret"));
  });
});

const admin: Session = {
  userId: "usr_1", externalUserId: "external", organizationId: "org_1",
  externalOrganizationId: "external_org", role: "admin", email: "admin@example.com", exp: Number.MAX_SAFE_INTEGER,
};

const githubEnvironment = {
  GITHUB_APP_SLUG: "snappydiff-staging",
  GITHUB_OAUTH_CLIENT_ID: "client_id",
  GITHUB_OAUTH_CLIENT_SECRET: "client_secret",
  WORKOS_COOKIE_PASSWORD: "a-secure-cookie-password-at-least-32-characters",
  APP_ORIGIN: "https://staging.example.test",
} as Env;

describe("GitHub-first onboarding", () => {
  it("builds a signed installation URL and carries the installation into OAuth", async () => {
    const start = await beginGitHubOnboarding(githubEnvironment, admin);
    const installationUrl = new URL((await start.json() as { installationUrl: string }).installationUrl);
    assert.equal(installationUrl.pathname, "/apps/snappydiff-staging/installations/new");
    const state = installationUrl.searchParams.get("state");
    assert.ok(state);

    const continuation = await completeGitHubOnboarding(new Request("https://example.test/api/v1/github/installations", {
      method: "POST", body: JSON.stringify({ state, installationId: 4983740 }),
    }), githubEnvironment, admin, { requestId: "req_1", startedAt: 0 });
    const authorizationUrl = new URL((await continuation.json() as { authorizationUrl: string }).authorizationUrl);
    assert.equal(authorizationUrl.pathname, "/login/oauth/authorize");
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://staging.example.test/github/callback");
    assert.ok(authorizationUrl.searchParams.get("state"));
  });

  it("creates API-safe, stable slugs from GitHub repository identities", () => {
    assert.equal(githubProjectSlug("Snappy Diff!", 12345), "snappy-diff-9ix");
    const long = githubProjectSlug("A".repeat(100), 12345);
    assert.match(long, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
    assert.ok(long.length <= 63);
  });
});
