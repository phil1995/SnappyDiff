import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyGitHubWebhook } from "./github.ts";

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
