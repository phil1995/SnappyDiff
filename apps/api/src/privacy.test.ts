import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "./auth.ts";
import { exportOrganization, scheduleOrganizationDeletion } from "./privacy.ts";

const admin: Session = {
  userId: "usr_1", externalUserId: "external", organizationId: "org_1",
  externalOrganizationId: "external_org", role: "admin", email: "admin@example.com", exp: Number.MAX_SAFE_INTEGER,
};

describe("organization privacy operations", () => {
  it("requires exact organization confirmation before any deletion write", async () => {
    const request = new Request("https://example.test/api/v1/organization/deletion", {
      method: "POST", body: JSON.stringify({ confirmOrganizationId: "org_2" }),
    });
    await assert.rejects(scheduleOrganizationDeletion(request, {} as never, admin,
      { requestId: "req_1", startedAt: 0 }), /Confirm the exact organization ID/);
  });

  it("scopes every export query to the session organization", async () => {
    const bindings: unknown[][] = [];
    const statement = {
      bind: (...values: unknown[]) => { bindings.push(values); return statement; },
      first: async () => ({ id: "org_1" }), all: async () => ({ success: true, results: [] }),
    };
    const response = await exportOrganization({ DB: { prepare: () => statement } } as never, admin);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(bindings.length, 7);
    assert.ok(bindings.every((values) => values.length === 1 && values[0] === admin.organizationId));
  });

  it("rejects exports for non-admin members before storage access", async () => {
    await assert.rejects(exportOrganization({} as never, { ...admin, role: "reviewer" }), /Permission/);
  });
});
