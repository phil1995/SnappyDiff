import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "./auth.ts";
import { getPrivateImage } from "./dashboard.ts";

const viewer: Session = {
  userId: "usr_1", externalUserId: "external", organizationId: "org_1",
  externalOrganizationId: "external_org", role: "viewer", email: "viewer@example.com", exp: Number.MAX_SAFE_INTEGER,
};

describe("private dashboard images", () => {
  it("scopes image lookup to the session organization", async () => {
    const bindings: unknown[][] = [];
    const statement = {
      bind: (...values: unknown[]) => { bindings.push(values); return statement; },
      first: async () => null,
    };
    const environment = { DB: { prepare: () => statement }, IMAGES: { get: () => assert.fail("R2 must not be read") } } as never;
    await assert.rejects(getPrivateImage(environment, viewer, "img_1"), /not found/);
    assert.deepEqual(bindings, [["img_1", "org_1"]]);
  });

  it("returns verified PNG bytes without public caching", async () => {
    const statement = { bind: () => statement, first: async () => ({ storageKey: "org/org_1/sha", byteSize: 3 }) };
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
    const environment = {
      DB: { prepare: () => statement },
      IMAGES: { get: async () => ({ body, size: 3 }) },
    } as never;
    const response = await getPrivateImage(environment, viewer, "img_1");
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
  });

  it("renders authorized demo fixtures only in the local environment", async () => {
    const statement = { bind: () => statement, first: async () => ({ storageKey: "local-fixture/detail-current.png", byteSize: 1 }) };
    const environment = {
      APP_ENV: "local", DB: { prepare: () => statement },
      IMAGES: { get: () => assert.fail("local fixtures must not read R2") },
    } as never;
    const response = await getPrivateImage(environment, viewer, "img_local_current_detail");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(bytes.slice(0, 8), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const dimensions = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(dimensions.getUint32(16), 960);
    assert.equal(dimensions.getUint32(20), 640);
  });
});
