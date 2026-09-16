import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "./auth.ts";
import { requirePermission } from "./authorization.ts";

const session = (role: Session["role"]): Session => ({
  userId: "usr_1", externalUserId: "user_1", organizationId: "org_1",
  externalOrganizationId: "org_external", role, email: "person@example.com", exp: Number.MAX_SAFE_INTEGER,
});

describe("role permissions", () => {
  it("allows viewers to inspect runs only", () => {
    assert.doesNotThrow(() => requirePermission(session("viewer"), "runs:view"));
    assert.throws(() => requirePermission(session("viewer"), "reports:accept"));
  });

  it("reserves project administration for admins", () => {
    assert.throws(() => requirePermission(session("reviewer"), "projects:admin"));
    assert.doesNotThrow(() => requirePermission(session("admin"), "projects:admin"));
  });
});

