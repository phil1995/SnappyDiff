import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "./auth.ts";
import { createToken, updateMember } from "./management.ts";

const admin: Session = {
  userId: "usr_1", externalUserId: "external", organizationId: "org_1",
  externalOrganizationId: "external_org", role: "admin", email: "admin@example.com", exp: Number.MAX_SAFE_INTEGER,
};
const context = { requestId: "req_1", startedAt: 0 };

describe("project management", () => {
  it("never persists the raw value of a newly issued token", async () => {
    const bindings: unknown[][] = [];
    const statement = {
      bind: (...values: unknown[]) => { bindings.push(values); return statement; },
      first: async () => ({ found: 1 }),
      run: async () => ({ success: true, meta: { changes: 1 } }),
    };
    const environment = { TOKEN_PEPPER: "p".repeat(32), DB: { prepare: () => statement } } as never;
    const request = new Request("https://example.test/api/v1/projects/prj_1/tokens", {
      method: "POST", body: JSON.stringify({ name: "CI", scopes: ["runs:create"], expiresInDays: 30 }),
    });
    const response = await createToken(request, environment, admin, "prj_1", context);
    const payload = await response.json() as { token: string };
    assert.match(payload.token, /^sd_pat_/);
    assert.equal(bindings.flat().includes(payload.token), false);
  });

  it("requires an administrator before membership storage access", async () => {
    const request = new Request("https://example.test/api/v1/members/usr_2", { method: "PATCH", body: "{}" });
    await assert.rejects(updateMember(request, {} as never, { ...admin, role: "reviewer" }, "usr_2", context), /Permission/);
  });
});
