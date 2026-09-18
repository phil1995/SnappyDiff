import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Session } from "./auth.ts";
import {
  beginGitHubOnboarding, completeGitHubOnboarding, githubProjectSlug, handleGitHubWebhook, verifyGitHubWebhook,
} from "./github.ts";
import type { Env } from "./platform.ts";

const encoder = new TextEncoder();
const testPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" }).toString();

async function signature(body: Uint8Array<ArrayBuffer>, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("GitHub webhook signatures", () => {
  it("accepts the exact signed bytes and rejects modification", async () => {
    const body = encoder.encode('{"action":"opened"}');
    const value = await signature(body, "github-webhook-secret");
    await assert.doesNotReject(verifyGitHubWebhook(body, value, "github-webhook-secret"));
    await assert.rejects(verifyGitHubWebhook(encoder.encode('{"action":"closed"}'), value, "github-webhook-secret"));
  });
});

const admin: Session = {
  userId: "usr_1", externalUserId: "external", organizationId: "org_1",
  externalOrganizationId: "external_org", role: "admin", email: "admin@example.com", exp: Number.MAX_SAFE_INTEGER,
};

const githubEnvironment = {
  GITHUB_APP_ID: "4983740",
  GITHUB_APP_SLUG: "snappydiff-staging",
  GITHUB_OAUTH_CLIENT_ID: "client_id",
  GITHUB_OAUTH_CLIENT_SECRET: "client_secret",
  WORKOS_COOKIE_PASSWORD: "a-secure-cookie-password-at-least-32-characters",
  APP_ORIGIN: "https://staging.example.test",
  GITHUB_APP_PRIVATE_KEY: testPrivateKey,
} as Env;

class FakeStatement {
  values: unknown[] = [];
  readonly query: string;
  private readonly database: FakeDatabase;
  constructor(query: string, database: FakeDatabase) { this.query = query; this.database = database; }
  bind(...values: unknown[]): this { this.values = values; return this; }
  async first<T>(): Promise<T | null> {
    if (this.query.includes("FROM github_installation_owners")) return this.database.installationOwner as T | null;
    return null;
  }
  async all<T>(): Promise<{ success: boolean; results: T[] }> {
    if (this.query.includes("FROM projects WHERE organization_id")) return { success: true, results: this.database.projects as T[] };
    if (this.query.includes("FROM github_installations")) return { success: true, results: this.database.mappings as T[] };
    return { success: true, results: [] };
  }
  async run<T>(): Promise<{ success: boolean; results: T[]; meta: { changes: number } }> {
    return { success: true, results: [], meta: { changes: 1 } };
  }
  async raw<T>(): Promise<T[]> { return []; }
}

class FakeDatabase {
  readonly statements: FakeStatement[] = [];
  batchStatements: FakeStatement[] = [];
  batchError: Error | null = null;
  projects: unknown[] = [];
  mappings: unknown[] = [];
  installationOwner: unknown = null;
  prepare(query: string): FakeStatement { const statement = new FakeStatement(query, this); this.statements.push(statement); return statement; }
  async batch<T>(statements: FakeStatement[]): Promise<Array<{ success: boolean; results: T[] }>> {
    this.batchStatements = statements;
    if (this.batchError) throw this.batchError;
    return statements.map(() => ({ success: true, results: [] }));
  }
  async exec(): Promise<{ count: number; duration: number }> { return { count: 0, duration: 0 }; }
}

function githubFetchFixture(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "user-token" });
    if (url.includes("/user/installations/77/repositories")) return Response.json({ repositories: [
      { id: 303, name: "original", owner: { login: "owner" }, default_branch: "main", permissions: { admin: true } },
      { id: 101, name: "renamed", owner: { login: "owner" }, default_branch: "main", permissions: { admin: true } },
    ] });
    if (url.includes("/app/installations/77/access_tokens")) return Response.json({ token: "installation-token" });
    if (url.includes("/installation/repositories")) return Response.json({ repositories: [
      { id: 303, name: "original", owner: { login: "owner" }, default_branch: "main" },
      { id: 101, name: "renamed", owner: { login: "owner" }, default_branch: "main" },
      { id: 202, name: "shared", owner: { login: "owner" }, default_branch: "main" },
    ] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("GitHub-first onboarding", () => {
  it("builds a signed installation URL and carries the installation into OAuth", async () => {
    const start = await beginGitHubOnboarding(githubEnvironment, admin);
    const installationUrl = new URL((await start.json() as { installationUrl: string }).installationUrl);
    assert.equal(installationUrl.pathname, "/apps/snappydiff-staging/installations/new");
    const state = installationUrl.searchParams.get("state");
    assert.ok(state);

    const continuation = await completeGitHubOnboarding(new Request("https://example.test/api/v1/github/installations", {
      method: "POST", body: JSON.stringify({ state, installationId: 4983740 }),
    }), githubEnvironment, admin, { requestId: "req_1", startedAt: 0 });
    const authorizationUrl = new URL((await continuation.json() as { authorizationUrl: string }).authorizationUrl);
    assert.equal(authorizationUrl.pathname, "/login/oauth/authorize");
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://staging.example.test/github/callback");
    assert.ok(authorizationUrl.searchParams.get("state"));
  });

  it("creates API-safe, stable slugs from GitHub repository identities", () => {
    assert.equal(githubProjectSlug("Snappy Diff!", 12345), "snappy-diff-9ix");
    const long = githubProjectSlug("A".repeat(100), 12345);
    assert.match(long, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
    assert.ok(long.length <= 63);
  });

  it("preserves inaccessible installed mappings and matches renamed repositories by GitHub ID", async () => {
    const database = new FakeDatabase();
    database.projects = [
      { id: "prj_renamed", name: "Custom name", slug: "original", repository_owner: "owner", repository_name: "original", github_repository_id: 101 },
      { id: "prj_shared", name: "Shared", slug: "shared", repository_owner: "owner", repository_name: "shared", github_repository_id: 202 },
    ];
    database.mappings = [
      { repository_owner: "owner", repository_name: "original" },
      { repository_owner: "owner", repository_name: "shared" },
    ];
    const environment = { ...githubEnvironment, DB: database } as unknown as Env;
    const start = await beginGitHubOnboarding(environment, admin);
    const state = new URL((await start.json() as { installationUrl: string }).installationUrl).searchParams.get("state");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = githubFetchFixture();
    try {
      const response = await completeGitHubOnboarding(new Request("https://example.test/api/v1/github/installations", {
        method: "POST", body: JSON.stringify({ state, installationId: 77, code: "oauth-code" }),
      }), environment, admin, { requestId: "req_sync", startedAt: 0 });
      const payload = await response.json() as { projects: Array<{ id: string }> };
      assert.equal(payload.projects.find((project) => project.id === "prj_renamed")?.id, "prj_renamed");
      assert.equal(payload.projects.some((project) => project.id !== "prj_renamed"), true);
      const rename = database.batchStatements.find((statement) => statement.query.includes("UPDATE projects SET repository_owner"));
      assert.deepEqual(rename?.values.slice(0, 6), ["owner", "renamed", 101, "main", "prj_renamed", "org_1"]);
      const sharedMapping = database.batchStatements.find((statement) => statement.values.at(-1) === "shared"
        && statement.query.includes("UPDATE github_installations"));
      assert.match(sharedMapping?.query ?? "", /suspended_at = NULL/);
      assert.ok(database.batchStatements[0]?.query.includes("github_installation_owners"));
      const firstProjectWrite = database.batchStatements.findIndex((statement) => statement.query.includes("UPDATE projects SET"));
      const firstProjectInsert = database.batchStatements.findIndex((statement) => statement.query.includes("INSERT INTO projects"));
      assert.ok(firstProjectWrite >= 0 && firstProjectWrite < firstProjectInsert, "renames must happen before reused names are inserted");
    } finally { globalThis.fetch = originalFetch; }
  });

  it("rejects a competing workspace installation claim atomically", async () => {
    const database = new FakeDatabase();
    database.batchError = new Error("github_installation_already_linked");
    const environment = { ...githubEnvironment, DB: database } as unknown as Env;
    const start = await beginGitHubOnboarding(environment, admin);
    const state = new URL((await start.json() as { installationUrl: string }).installationUrl).searchParams.get("state");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = githubFetchFixture();
    try {
      await assert.rejects(completeGitHubOnboarding(new Request("https://example.test/api/v1/github/installations", {
        method: "POST", body: JSON.stringify({ state, installationId: 77, code: "oauth-code" }),
      }), environment, admin, { requestId: "req_race", startedAt: 0 }), (error: unknown) => {
        return typeof error === "object" && error !== null && "code" in error && error.code === "installation_already_linked";
      });
    } finally { globalThis.fetch = originalFetch; }
  });

  it("provisions newly selected repositories from the signed GitHub webhook", async () => {
    const database = new FakeDatabase();
    database.installationOwner = { organization_id: "org_1" };
    database.projects = [
      { id: "prj_existing", name: "Renamed", slug: "renamed", repository_owner: "owner", repository_name: "renamed", github_repository_id: 101 },
    ];
    const environment = { ...githubEnvironment, DB: database, GITHUB_WEBHOOK_SECRET: "webhook-secret" } as unknown as Env;
    const payload = encoder.encode(JSON.stringify({
      action: "added",
      installation: { id: 77 },
      repositories_added: [{ id: 202, name: "shared", owner: { login: "owner" } }],
      repositories_removed: [],
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = githubFetchFixture();
    try {
      const response = await handleGitHubWebhook(new Request("https://example.test/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-delivery": "delivery_repo_added",
          "x-github-event": "installation_repositories",
          "x-hub-signature-256": await signature(payload, "webhook-secret"),
        },
        body: payload,
      }), environment);
      assert.equal(response.status, 200);
      assert.equal(database.batchStatements.filter((statement) => statement.query.includes("INSERT INTO projects")).length, 2);
      assert.equal(database.batchStatements.filter((statement) => statement.query.includes("INSERT INTO github_installations")).length, 3);
      assert.ok(database.batchStatements.some((statement) => statement.query.includes("github.installation_webhook_synced")));
    } finally { globalThis.fetch = originalFetch; }
  });
});

describe("GitHub identity migration", () => {
  it("records and removes displaced mappings before enforcing one installation owner", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE organizations (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE projects (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL) STRICT;
      CREATE TABLE github_installations (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, installation_id INTEGER NOT NULL,
        account_login TEXT NOT NULL, repository_owner TEXT, repository_name TEXT,
        suspended_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      ) STRICT;
      CREATE UNIQUE INDEX github_repository_installation_owner
        ON github_installations(installation_id, repository_owner, repository_name)
        WHERE repository_owner IS NOT NULL AND repository_name IS NOT NULL;
      INSERT INTO organizations VALUES ('org_a'), ('org_b');
      INSERT INTO github_installations (id, organization_id, installation_id, account_login, repository_owner, repository_name)
        VALUES ('ghi_a', 'org_a', 77, 'owner', 'owner', 'one'),
               ('ghi_b', 'org_b', 77, 'owner', 'owner', 'two');
    `);
    database.exec(readFileSync(new URL("../migrations/0012_github_repository_identity.sql", import.meta.url), "utf8"));
    const owner = database.prepare("SELECT installation_id, organization_id FROM github_installation_owners").get();
    assert.equal(owner?.installation_id, 77);
    assert.equal(owner?.organization_id, "org_a");
    const conflict = database.prepare("SELECT displaced_organization_id, selected_organization_id FROM github_installation_migration_conflicts").get();
    assert.equal(conflict?.displaced_organization_id, "org_b");
    assert.equal(conflict?.selected_organization_id, "org_a");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM github_installations WHERE organization_id = 'org_b'").get()?.count, 0);
    assert.doesNotThrow(() => database.exec(`
      INSERT INTO github_installations (id, organization_id, installation_id, account_login, repository_owner, repository_name)
      VALUES ('ghi_reclaimed', 'org_a', 77, 'owner', 'owner', 'two');
    `));
    assert.throws(() => database.exec("UPDATE github_installation_owners SET organization_id = 'org_b' WHERE installation_id = 77"),
      /github_installation_already_linked/);
    database.close();
  });
});
