import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "./auth.ts";
import { createProject, getProject } from "./projects.ts";

const admin: Session = {
  userId: "usr_1", externalUserId: "external", organizationId: "org_1",
  externalOrganizationId: "external_org", role: "admin", email: "admin@example.com", exp: Number.MAX_SAFE_INTEGER,
};

describe("project creation", () => {
  it("rejects unsafe slugs before accessing storage", async () => {
    const request = new Request("https://example.test/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Project", slug: "../unsafe", repositoryOwner: "owner", repositoryName: "repo", defaultBranch: "main" }),
    });
    const environment = { DB: { batch: () => assert.fail("storage must not be called") } } as never;
    await assert.rejects(createProject(request, environment, admin, { requestId: "req_1", startedAt: 0 }), /Slug/);
  });

  it("requires project administration permission", async () => {
    const request = new Request("https://example.test/api/v1/projects", { method: "POST", body: "{}" });
    await assert.rejects(createProject(request, {} as never, { ...admin, role: "viewer" }, { requestId: "req_1", startedAt: 0 }), /Permission/);
  });

  it("scopes project lookup to the authenticated organization", async () => {
    const calls: unknown[][] = [];
    const statement = {
      bind: (...values: unknown[]) => { calls.push(values); return statement; },
      first: async () => ({ id: "prj_1" }),
    };
    const environment = { DB: { prepare: () => statement } } as never;
    await getProject(environment, admin, "prj_1");
    assert.deepEqual(calls, [["org_1", "prj_1"]]);
  });
});
