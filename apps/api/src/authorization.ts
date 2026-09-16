import type { HumanRole, Session } from "./auth.ts";
import { HttpError } from "./http.ts";

export type Permission = "runs:view" | "runs:create" | "reports:accept" | "baselines:manage" | "projects:admin";

const rolePermissions: Record<HumanRole, ReadonlySet<Permission>> = {
  viewer: new Set(["runs:view"]),
  reviewer: new Set(["runs:view", "reports:accept"]),
  admin: new Set(["runs:view", "runs:create", "reports:accept", "baselines:manage", "projects:admin"]),
};

export function requirePermission(session: Session, permission: Permission): void {
  if (!rolePermissions[session.role].has(permission)) {
    throw new HttpError(403, "permission_denied", `Permission ${permission} is required`);
  }
}

