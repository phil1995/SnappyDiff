import type { HumanRole, Session } from "./auth.ts";
import { HttpError } from "./http.ts";

export type Permission =
  | "runs:view" | "runs:create" | "reports:accept" | "baselines:manage" | "projects:admin"
  | "feedback:write" | "feedback:triage";

const rolePermissions: Record<HumanRole, ReadonlySet<Permission>> = {
  viewer: new Set(["runs:view", "feedback:write"]),
  reviewer: new Set(["runs:view", "reports:accept", "feedback:write", "feedback:triage"]),
  admin: new Set(["runs:view", "runs:create", "reports:accept", "baselines:manage", "projects:admin", "feedback:write", "feedback:triage"]),
};

export function hasPermission(session: Session, permission: Permission): boolean {
  return rolePermissions[session.role].has(permission);
}

export function requirePermission(session: Session, permission: Permission): void {
  if (!hasPermission(session, permission)) {
    throw new HttpError(403, "permission_denied", `Permission ${permission} is required`);
  }
}
