import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveOrCreateRepositoryProject } from "./projects.ts";

describe("upload-first projects", () => {
  it("creates one project and reuses it for later uploads", async () => {
    let project: { id: string; organization_id: string; repository_owner: string; repository_name: string } | null = null;
    let suiteWrites = 0;
    const database = {
      prepare(query: string) {
        const statement = {
          values: [] as unknown[],
          bind(...values: unknown[]) { statement.values = values; return statement; },
          async first<T>() { return (query.includes("SELECT id, organization_id") ? project : null) as T | null; },
          async run() {
            if (query.includes("INSERT INTO projects")) {
              project = { id: String(statement.values[0]), organization_id: String(statement.values[1]),
                repository_owner: String(statement.values[4]), repository_name: String(statement.values[5]) };
              return { success: true, meta: { changes: 1 } };
            }
            if (query.includes("INSERT INTO suites")) suiteWrites++;
            return { success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
    };
    const environment = { DB: database } as never;
    const first = await resolveOrCreateRepositoryProject(environment, "org_1", {
      repositoryOwner: "pointfreeco", repositoryName: "swift-snapshot-testing", defaultBranch: "main",
    });
    const second = await resolveOrCreateRepositoryProject(environment, "org_1", {
      repositoryOwner: "pointfreeco", repositoryName: "swift-snapshot-testing", defaultBranch: "main",
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);
    assert.equal(suiteWrites, 2, "suite creation stays idempotent at the database constraint");
  });

  it("rejects malformed repository identities before storage access", async () => {
    await assert.rejects(resolveOrCreateRepositoryProject({} as never, "org_1", {
      repositoryOwner: "bad/owner", repositoryName: "repo", defaultBranch: "main",
    }), /invalid/i);
  });
});
