import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { installedRepository, verifyGitHubOidc } from "./github-oidc.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" }).toString();
const environment = { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: privateKey } as never;

describe("GitHub OIDC validation", () => {
  it("rejects malformed tokens before requesting signing keys", async () => {
    await assert.rejects(verifyGitHubOidc("not-a-jwt", "snappydiff"), /malformed/);
  });

  it("accepts only repositories explicitly present in the installation inventory", async () => {
    const originalFetch = globalThis.fetch;
    let publicLookupCalled = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/app/installations/77/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/installation/repositories")) return Response.json({ repositories: [
        { id: 1, name: "selected", owner: { login: "owner" }, default_branch: "main" },
      ] });
      if (url.includes("/repos/owner/public")) { publicLookupCalled = true; return Response.json({ id: 2 }); }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      const selected = await installedRepository(environment, 77, 1, "owner", "selected");
      assert.equal(selected.id, 1);
      await assert.rejects(installedRepository(environment, 77, 2, "owner", "public"), (error: unknown) => {
        return typeof error === "object" && error !== null && "code" in error && error.code === "repository_binding_failed";
      });
      assert.equal(publicLookupCalled, false, "public repository lookup must not substitute for installation authorization");
    } finally { globalThis.fetch = originalFetch; }
  });
});
