import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256, signJson, timingSafeEqual, verifyJson } from "./crypto.ts";

describe("cryptographic helpers", () => {
  it("hashes bytes deterministically", async () => {
    assert.equal(await sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("signs and verifies JSON without accepting modification", async () => {
    const token = await signJson({ subject: "user" }, "a sufficiently long test-only secret value");
    assert.deepEqual(await verifyJson(token, "a sufficiently long test-only secret value"), { subject: "user" });
    assert.equal(await verifyJson(`${token}x`, "a sufficiently long test-only secret value"), null);
  });

  it("compares equal strings", () => {
    assert.equal(timingSafeEqual("same", "same"), true);
    assert.equal(timingSafeEqual("same", "other"), false);
  });
});

