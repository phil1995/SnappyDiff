import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { finishLogin, safeReturnPath } from "./auth.ts";

describe("authentication", () => {
  it("keeps return paths on the configured origin", () => {
    assert.equal(safeReturnPath("/projects?tab=recent", "https://app.example"), "/projects?tab=recent");
    assert.equal(safeReturnPath("/\\evil.example", "https://app.example"), "/");
    assert.equal(safeReturnPath("//evil.example", "https://app.example"), "/");
    assert.equal(safeReturnPath("https://evil.example", "https://app.example"), "/");
  });

  it("serializes the WorkOS API key as client_secret", async () => {
    const originalFetch = globalThis.fetch;
    let providerBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ user: { id: "user_external", email: "person@example.com" }, organization_id: "org_external" });
    };
    const statement = {
      bind: () => statement,
      first: async () => ({ id: "org_1", role: "admin" }),
      run: async () => ({ success: true }),
    };
    const environment = {
      APP_ENV: "local", APP_ORIGIN: "http://localhost:8787", WORKOS_CLIENT_ID: "client_1",
      WORKOS_REDIRECT_URI: "http://localhost:8787/auth/callback", WORKOS_API_KEY: "secret-key",
      WORKOS_COOKIE_PASSWORD: "a-local-cookie-password-with-32-bytes",
      DB: { prepare: () => statement },
    } as never;
    const { signJson } = await import("./crypto.ts");
    const state = await signJson({ nonce: "nonce", returnTo: "/", exp: Math.floor(Date.now() / 1000) + 60 }, "a-local-cookie-password-with-32-bytes");
    const request = new Request("http://localhost:8787/auth/callback?code=code_1&state=nonce", {
      headers: { cookie: `snappydiff_oauth_state=${encodeURIComponent(state)}` },
    });
    try {
      await finishLogin(request, environment);
      assert.equal(providerBody?.["client_secret"], "secret-key");
      assert.equal(providerBody?.["grant_type"], "authorization_code");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

