import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "./auth.ts";
import { listProjectScreens } from "./screens.ts";

const viewer: Session = {
  userId: "usr_1", externalUserId: "external", organizationId: "org_1",
  externalOrganizationId: "external_org", role: "viewer", email: "viewer@example.com", exp: Number.MAX_SAFE_INTEGER,
};

const project = {
  id: "prj_1", name: "App", repositoryOwner: "acme", repositoryName: "app", defaultBranch: "main",
  activeBaselineRunId: null as string | null, rollbackRunId: null as string | null,
};
const run = (id: string) => ({ id, commitSha: "abc", branch: "main", pullRequestNumber: null, createdAt: 1, completedAt: 2 });

function database(options: { project?: typeof project | null; runs?: Record<string, ReturnType<typeof run>>; latest?: ReturnType<typeof run> | null; screenshots?: unknown[] }) {
  const queries: { sql: string; values: unknown[] }[] = [];
  return {
    queries,
    env: {
      DB: {
        prepare(sql: string) {
          const statement = {
            values: [] as unknown[],
            bind(...values: unknown[]) { statement.values = values; queries.push({ sql, values }); return statement; },
            async first() {
              if (sql.includes("FROM projects")) return options.project === undefined ? project : options.project;
              if (sql.includes("r.id = ?")) return options.runs?.[String(statement.values[0])] ?? null;
              if (sql.includes("FROM runs")) return options.latest ?? null;
              return null;
            },
            async all() { return { results: options.screenshots ?? [] }; },
          };
          return statement;
        },
      },
    } as never,
  };
}

describe("project screens", () => {
  it("scopes the project lookup to the session organization", async () => {
    const { env, queries } = database({ project: null });
    await assert.rejects(listProjectScreens(env, viewer, "prj_other", null, null), /Project was not found/);
    assert.deepEqual(queries[0]?.values, ["prj_other", "org_1"]);
  });

  it("prefers a rollback over the active baseline", async () => {
    const { env } = database({
      project: { ...project, rollbackRunId: "run_rollback", activeBaselineRunId: "run_active" },
      runs: { run_rollback: run("run_rollback"), run_active: run("run_active") },
    });
    const body = await (await listProjectScreens(env, viewer, "prj_1", null, null)).json() as { source: { kind: string; id: string } };
    assert.equal(body.source.kind, "rollback");
    assert.equal(body.source.id, "run_rollback");
  });

  it("falls back to the latest default-branch run and hides suite internals", async () => {
    const { env, queries } = database({ latest: run("run_latest"), screenshots: [{ name: "A.en-iPhone.png", imageId: "img_1", width: 1, height: 1 }] });
    const body = await (await listProjectScreens(env, viewer, "prj_1", null, null)).json() as Record<string, any>;
    assert.equal(body["source"].kind, "default_branch");
    assert.equal(body["project"].activeBaselineRunId, undefined);
    assert.deepEqual(queries.find((query) => query.sql.includes("r.branch = ?"))?.values, ["org_1", "prj_1", "main"]);
    assert.deepEqual(queries.at(-1)?.values, ["org_1", "run_latest", "", 501]);
    assert.equal(body["nextCursor"], null);
  });

  it("returns an empty listing before the first default-branch run", async () => {
    const { env } = database({});
    const body = await (await listProjectScreens(env, viewer, "prj_1", null, null)).json() as Record<string, unknown>;
    assert.equal(body["source"], null);
    assert.deepEqual(body["screenshots"], []);
  });

  it("only serves an explicitly requested run from the same project", async () => {
    const { env, queries } = database({ runs: {} });
    await assert.rejects(listProjectScreens(env, viewer, "prj_1", "run_foreign", null), /Run was not found/);
    assert.deepEqual(queries.at(-1)?.values, ["run_foreign", "org_1", "prj_1"]);
  });

  it("pages screenshots by name", async () => {
    const screenshots = Array.from({ length: 501 }, (_, index) => ({ name: `S${String(index).padStart(3, "0")}.png`, imageId: `img_${index}` }));
    const { env, queries } = database({ runs: { run_1: run("run_1") }, screenshots });
    const body = await (await listProjectScreens(env, viewer, "prj_1", "run_1", "R.png")).json() as Record<string, any>;
    assert.equal(body["screenshots"].length, 500);
    assert.equal(body["nextCursor"], "S499.png");
    assert.equal(body["source"].kind, "run");
    assert.deepEqual(queries.at(-1)?.values, ["org_1", "run_1", "R.png", 501]);
  });
});
