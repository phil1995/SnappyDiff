import limits from "../../../shared/limits.json" with { type: "json" };

export const LIMITS = Object.freeze(limits);

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
  requestId: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  repositoryOwner: string;
  repositoryName: string;
  defaultBranch: string;
}

export interface ScreenshotManifestEntry {
  name: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
}

export interface ManifestPage {
  page: number;
  entries: ScreenshotManifestEntry[];
}

export interface RunIdentity {
  provider: "github_actions" | "manual" | "other";
  providerRunId: string;
  attemptNumber: number;
  runKey: string;
  commitSha: string;
  branch: string;
  mergeBaseSha?: string;
  observedDefaultHeadSha?: string;
  pullRequestNumber?: number;
  pullRequestHeadSha?: string;
  expectedShards: string[];
  trustClass: "first_party" | "fork_isolated";
  parentShas: string[];
  graphComplete: boolean;
  commitGraph: Array<{ sha: string; parentShas: string[]; complete: boolean }>;
}

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function normalizeScreenshotName(value: string): string {
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) throw new Error("Screenshot name must be a safe relative path");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Screenshot name contains an invalid path component");
  return parts.join("/");
}
