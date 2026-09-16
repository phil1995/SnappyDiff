import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readJson } from "./http.ts";

describe("bounded request reading", () => {
  it("rejects a streamed body after the configured byte limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40));
        controller.enqueue(new Uint8Array(40));
        controller.close();
      },
    });
    const request = new Request("https://example.test", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await assert.rejects(readJson(request, 64), /too large/);
  });
});

