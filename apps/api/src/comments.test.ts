import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "./auth.ts";
import { canChangeStatus, createComment, deleteComment, parseRegion, updateComment } from "./comments.ts";

const session = (role: Session["role"], userId = "usr_viewer"): Session => ({
  userId, externalUserId: "external", organizationId: "org_1",
  externalOrganizationId: "external_org", role, email: `${userId}@example.com`, exp: Number.MAX_SAFE_INTEGER,
});
const context = { requestId: "req_1", startedAt: 0 };
const comment = { id: "cmt_1", projectId: "prj_1", authorUserId: "usr_author", status: "open" as const };
const storedComment = {
  id: "cmt_1", projectId: "prj_1", screenshotName: "Welcome.de-iPhone.png", runId: "run_1", imageId: "img_1",
  regionX: .1, regionY: .2, regionWidth: .3, regionHeight: .4, category: "truncation", body: "Too long", suggestedText: null,
  status: "open", authorUserId: "usr_author", authorName: "Author", replyCount: 0,
};

function database(options: { comment?: typeof comment | null; screenshot?: { imageId: string } | null } = {}) {
  const writes: { sql: string; values: unknown[] }[] = [];
  const reads: { sql: string; values: unknown[] }[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const statement = {
          sql, values: [] as unknown[],
          bind(...values: unknown[]) { statement.values = values; return statement; },
          async first() {
            reads.push({ sql, values: statement.values });
            if (sql.includes("FROM screenshots")) return options.screenshot === undefined ? { imageId: "img_1" } : options.screenshot;
            if (sql.includes("replyCount")) return storedComment;
            if (sql.includes("FROM screen_comments")) return options.comment === undefined ? comment : options.comment;
            return null;
          },
          async all() { return { results: [] }; },
        };
        return statement;
      },
      async batch(statements: { sql: string; values: unknown[] }[]) {
        writes.push(...statements.map(({ sql, values }) => ({ sql, values })));
        return [];
      },
    },
  } as never;
  return { env, writes, reads };
}

const request = (body: unknown) => new Request("https://example.test/api", { method: "POST", body: JSON.stringify(body) });

describe("screen comment regions", () => {
  it("accepts normalized regions and whole-screen comments", () => {
    assert.deepEqual(parseRegion({ x: .1, y: .2, width: .5, height: .25 }), { x: .1, y: .2, width: .5, height: .25 });
    assert.equal(parseRegion(undefined), null);
  });

  it("rejects regions outside the screenshot", () => {
    assert.throws(() => parseRegion({ x: .8, y: 0, width: .5, height: .1 }), /within the screenshot/);
    assert.throws(() => parseRegion({ x: 0, y: 0, width: 0, height: .1 }), /within the screenshot/);
    assert.throws(() => parseRegion({ x: "0", y: 0, width: .1, height: .1 }), /numeric/);
  });
});

describe("screen comment status permissions", () => {
  it("lets anyone reopen, authors resolve their own feedback, and triagers do everything", () => {
    assert.equal(canChangeStatus(session("viewer"), comment, "open"), true);
    assert.equal(canChangeStatus(session("viewer"), comment, "resolved"), false);
    assert.equal(canChangeStatus(session("viewer", "usr_author"), comment, "resolved"), true);
    assert.equal(canChangeStatus(session("viewer", "usr_author"), comment, "wont_fix"), false);
    assert.equal(canChangeStatus(session("reviewer"), comment, "wont_fix"), true);
    assert.equal(canChangeStatus(session("admin"), comment, "resolved"), true);
  });

  it("rejects won't fix from a viewer before writing", async () => {
    const { env, writes } = database();
    await assert.rejects(updateComment(request({ status: "wont_fix" }), env, session("viewer", "usr_author"), "cmt_1", context), /won't fix/);
    assert.equal(writes.length, 0);
  });

  it("only lets the author edit the comment text", async () => {
    const { env, writes } = database();
    await assert.rejects(updateComment(request({ body: "Changed" }), env, session("admin"), "cmt_1", context), /Only the author/);
    await updateComment(request({ body: "  Changed  " }), env, session("viewer", "usr_author"), "cmt_1", context);
    assert.match(writes[0]?.sql ?? "", /SET body = \?/);
    assert.deepEqual(writes[0]?.values, ["Changed", "cmt_1", "org_1"]);
  });

  it("records who changed the status", async () => {
    const { env, writes } = database();
    await updateComment(request({ status: "resolved" }), env, session("admin", "usr_admin"), "cmt_1", context);
    assert.match(writes[0]?.sql ?? "", /status_changed_by_user_id = \?/);
    assert.deepEqual(writes[0]?.values, ["resolved", "usr_admin", "cmt_1", "org_1"]);
    assert.equal(writes[1]?.values.includes("comment.resolved"), true);
  });
});

describe("creating and deleting screen comments", () => {
  it("anchors a comment to a screenshot of a run in the same project", async () => {
    const { env, writes, reads } = database();
    const response = await createComment(request({
      screenshotName: "Welcome.de-iPhone.png", runId: "run_1", category: "truncation", body: " Too long ",
      region: { x: .1, y: .2, width: .3, height: .4 },
    }), env, session("viewer"), "prj_1", context);
    assert.equal(response.status, 201);
    assert.deepEqual(reads[0]?.values, ["org_1", "run_1", "Welcome.de-iPhone.png", "prj_1"]);
    assert.deepEqual(writes[0]?.values.slice(2), ["prj_1", "Welcome.de-iPhone.png", "run_1", "img_1", .1, .2, .3, .4, "truncation", "Too long", null, "usr_viewer"]);
  });

  it("rejects screenshots that are not part of the project run", async () => {
    const { env, writes } = database({ screenshot: null });
    await assert.rejects(createComment(request({ screenshotName: "Other.png", runId: "run_2", category: "other", body: "Hi" }),
      env, session("viewer"), "prj_1", context), /not found/);
    assert.equal(writes.length, 0);
  });

  it("validates the category", async () => {
    const { env } = database();
    await assert.rejects(createComment(request({ screenshotName: "A.png", runId: "run_1", category: "spam", body: "Hi" }),
      env, session("viewer"), "prj_1", context), /Category/);
  });

  it("lets authors and administrators delete comments", async () => {
    await assert.rejects(deleteComment(database().env, session("reviewer"), "cmt_1", context), /author or an administrator/);
    const author = database();
    assert.equal((await deleteComment(author.env, session("viewer", "usr_author"), "cmt_1", context)).status, 204);
    const admin = database();
    assert.equal((await deleteComment(admin.env, session("admin"), "cmt_1", context)).status, 204);
    assert.match(admin.writes[0]?.sql ?? "", /DELETE FROM screen_comments/);
  });

  it("scopes comment lookups to the session organization", async () => {
    const { env, reads } = database({ comment: null });
    await assert.rejects(deleteComment(env, session("admin"), "cmt_other", context), /Comment was not found/);
    assert.deepEqual(reads[0]?.values, ["cmt_other", "org_1"]);
  });
});
