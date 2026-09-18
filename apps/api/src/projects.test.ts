import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";
import { resolveOrCreateRepositoryProject } from "./projects.ts";

describe("upload-first projects", () => {
  it("creates one project and reuses it for later uploads", async () => {
    let project: { id: string; organization_id: string; repository_owner: string; repository_name: string } | null = null;
    let suiteWrites = 0;
    let updateValues: unknown[] = [];
    const database = {
      prepare(query: string) {
        const statement = {
          values: [] as SQLInputValue[],
          bind(...values: SQLInputValue[]) { statement.values = values; return statement; },
          async first<T>() { return (query.includes("SELECT id, organization_id") ? project : null) as T | null; },
          async run() {
            if (query.includes("INSERT INTO projects")) {
              project = { id: String(statement.values[0]), organization_id: String(statement.values[1]),
                repository_owner: String(statement.values[4]), repository_name: String(statement.values[5]) };
              return { success: true, meta: { changes: 1 } };
            }
            if (query.includes("INSERT INTO suites")) suiteWrites++;
            if (query.includes("UPDATE projects SET")) updateValues = statement.values;
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
      repositoryOwner: "pointfreeco", repositoryName: "swift-snapshot-testing",
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);
    assert.equal(suiteWrites, 2, "suite creation stays idempotent at the database constraint");
    assert.deepEqual(updateValues.slice(3, 5), [null, null], "an upload without branch metadata preserves project settings");
  });

  it("rejects malformed repository identities before storage access", async () => {
    await assert.rejects(resolveOrCreateRepositoryProject({} as never, "org_1", {
      repositoryOwner: "bad/owner", repositoryName: "repo", defaultBranch: "main",
    }), /invalid/i);
  });

  it("does not replace an established GitHub repository identity", async () => {
    const stored = { id: "prj_1", organization_id: "org_1", repository_owner: "owner",
      repository_name: "original", github_repository_id: 101 };
    const database = {
      prepare(query: string) {
        const statement = {
          values: [] as SQLInputValue[],
          bind(...values: SQLInputValue[]) { statement.values = values; return statement; },
          async first<T>() {
            if (query.includes("github_repository_id = ?")) return (stored.github_repository_id === statement.values[1] ? stored : null) as T | null;
            if (query.includes("lower(repository_owner)")) {
              return (stored.repository_owner.toLowerCase() === String(statement.values[1]).toLowerCase()
                && stored.repository_name.toLowerCase() === String(statement.values[2]).toLowerCase() ? stored : null) as T | null;
            }
            return null;
          },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
        return statement;
      },
    };
    await assert.rejects(resolveOrCreateRepositoryProject({ DB: database } as never, "org_1", {
      repositoryOwner: "owner", repositoryName: "original", githubRepositoryId: 202, defaultBranch: "main",
    }), (error: unknown) => typeof error === "object" && error !== null && "code" in error
      && error.code === "repository_identity_conflict");
  });

  it("enforces case-insensitive repository uniqueness in the schema", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, repository_owner TEXT NOT NULL, repository_name TEXT NOT NULL
    ) STRICT;`);
    database.exec(readFileSync(new URL("../migrations/0013_normalized_repository_identity.sql", import.meta.url), "utf8"));
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)").run("prj_1", "org_1", "Owner", "Repo");
    assert.throws(() => database.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)")
      .run("prj_2", "org_1", "owner", "repo"), /UNIQUE/);
  });

  it("keeps renamed and name-reused GitHub repositories distinct against the real schema", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
    database.exec(readFileSync(new URL("../migrations/0012_github_repository_identity.sql", import.meta.url), "utf8"));
    database.exec(readFileSync(new URL("../migrations/0013_normalized_repository_identity.sql", import.meta.url), "utf8"));
    database.prepare("INSERT INTO organizations (id, workos_organization_id, name, slug) VALUES (?, ?, ?, ?)")
      .run("org_1", "workos_1", "Test", "test");
    const d1 = {
      prepare(query: string) {
        const statement = {
          values: [] as SQLInputValue[],
          bind(...values: SQLInputValue[]) { statement.values = values; return statement; },
          async first<T>() { return (database.prepare(query).get(...statement.values) ?? null) as T | null; },
          async run() {
            const result = database.prepare(query).run(...statement.values);
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        };
        return statement;
      },
    };
    const environment = { DB: d1 } as never;
    const original = await resolveOrCreateRepositoryProject(environment, "org_1", {
      repositoryOwner: "owner", repositoryName: "original", githubRepositoryId: 101, defaultBranch: "main",
    });
    const renamed = await resolveOrCreateRepositoryProject(environment, "org_1", {
      repositoryOwner: "owner", repositoryName: "renamed", githubRepositoryId: 101, defaultBranch: "main",
    });
    const replacement = await resolveOrCreateRepositoryProject(environment, "org_1", {
      repositoryOwner: "owner", repositoryName: "original", githubRepositoryId: 202, defaultBranch: "main",
    });
    assert.equal(renamed.id, original.id);
    assert.notEqual(replacement.id, original.id);
    const rows = database.prepare("SELECT github_repository_id, repository_name FROM projects ORDER BY github_repository_id")
      .all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { github_repository_id: 101, repository_name: "renamed" },
      { github_repository_id: 202, repository_name: "original" },
    ]);
  });
});
