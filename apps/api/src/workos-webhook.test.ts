import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyWorkOSSignature } from "./workos-webhook.ts";

const encoder = new TextEncoder();

async function signature(body: Uint8Array<ArrayBuffer>, timestamp: number, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("WorkOS webhook signatures", () => {
  it("accepts a current valid signature and rejects stale delivery", async () => {
    const body = encoder.encode('{"event":"organization_membership.deleted"}');
    const now = 1_800_000_000;
    const value = await signature(body, now, "webhook-secret");
    await assert.doesNotReject(verifyWorkOSSignature(body, `t=${now}, v1=${value}`, "webhook-secret", now));
    await assert.rejects(verifyWorkOSSignature(body, `t=${now - 301}, v1=${value}`, "webhook-secret", now));
  });
});

