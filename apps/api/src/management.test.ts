import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "./auth.ts";
import { createWorkspaceToken, updateMember } from "./management.ts";

const admin: Session = {
  userId: "usr_1", externalUserId: "external", organizationId: "org_1",
  externalOrganizationId: "external_org", role: "admin", email: "admin@example.com", exp: Number.MAX_SAFE_INTEGER,
};
const context = { requestId: "req_1", startedAt: 0 };

describe("project management", () => {
  it("issues workspace keys without binding them to a project", async () => {
    const bindings: unknown[][] = [];
    const statement = {
      bind: (...values: unknown[]) => { bindings.push(values); return statement; },
      run: async () => ({ success: true, meta: { changes: 1 } }),
    };
    const environment = { TOKEN_PEPPER: "p".repeat(32), DB: { prepare: () => statement } } as never;
    const request = new Request("https://example.test/api/v1/workspace-tokens", {
      method: "POST", body: JSON.stringify({ name: "All CI", expiresInDays: 365 }),
    });
    const response = await createWorkspaceToken(request, environment, admin, context);
    const payload = await response.json() as { token: string; record: { scopes: string[] } };
    assert.match(payload.token, /^sd_pat_/);
    assert.deepEqual(payload.record.scopes, ["runs:create", "projects:bootstrap"]);
    assert.equal(bindings.some((values) => values[2] === null && values.includes("All CI")), true);
    assert.equal(bindings.flat().includes(payload.token), false);
  });

  it("requires an administrator before membership storage access", async () => {
    const request = new Request("https://example.test/api/v1/members/usr_2", { method: "PATCH", body: "{}" });
    await assert.rejects(updateMember(request, {} as never, { ...admin, role: "reviewer" }, "usr_2", context), /Permission/);
  });
});
