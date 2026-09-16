import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyGitHubOidc } from "./github-oidc.ts";

describe("GitHub OIDC validation", () => {
  it("rejects malformed tokens before requesting signing keys", async () => {
    await assert.rejects(verifyGitHubOidc("not-a-jwt", "snappydiff"), /malformed/);
  });
});
