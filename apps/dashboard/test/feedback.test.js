import assert from "node:assert/strict";
import { test } from "node:test";
import { commentActions, commentLocation, commentsCsv, filterComments, isOutdated, normalizedRegion, orderComments } from "../src/feedback.js";

const comment = (overrides = {}) => ({
  id: "cmt_1", screenshotName: "Onboarding/Welcome.de-iPhone15.png", imageId: "img_1", category: "truncation",
  body: "Too long", suggestedText: null, status: "open", authorUserId: "usr_author", authorName: "Camille", createdAt: 100, replyCount: 0,
  ...overrides,
});

test("mirrors the server permissions for comment actions", () => {
  assert.deepEqual(commentActions({ id: "usr_other", role: "viewer" }, comment()), { edit: false, remove: false, resolve: false, wontFix: false, reopen: false });
  assert.deepEqual(commentActions({ id: "usr_author", role: "viewer" }, comment()), { edit: true, remove: true, resolve: true, wontFix: false, reopen: false });
  assert.deepEqual(commentActions({ id: "usr_other", role: "viewer" }, comment({ status: "resolved" })).reopen, true);
  assert.deepEqual(commentActions({ id: "usr_admin", role: "admin" }, comment()), { edit: false, remove: true, resolve: true, wontFix: true, reopen: false });
});

test("normalizes a dragged area and ignores accidental clicks", () => {
  const bounds = { left: 100, top: 50, width: 400, height: 800 };
  assert.deepEqual(normalizedRegion({ x: 300, y: 450 }, { x: 140, y: 90 }, bounds), { x: .1, y: .05, width: .4, height: .45 });
  assert.deepEqual(normalizedRegion({ x: 50, y: 0 }, { x: 900, y: 1000 }, bounds), { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(normalizedRegion({ x: 200, y: 200 }, { x: 203, y: 260 }, bounds), null);
});

test("lists open feedback first, oldest first", () => {
  const ordered = orderComments([
    comment({ id: "c", status: "resolved", createdAt: 1 }), comment({ id: "b", createdAt: 3 }), comment({ id: "a", createdAt: 2 }),
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ["a", "b", "c"]);
});

test("detects feedback written on an earlier build", () => {
  assert.equal(isOutdated(comment(), "img_1"), false);
  assert.equal(isOutdated(comment(), "img_2"), true);
  assert.equal(isOutdated(comment(), null), false);
});

test("filters feedback by language, category, and text", () => {
  const comments = [comment(), comment({ id: "cmt_2", screenshotName: "Settings/Account.fr-iPadPro11.png", category: "translation", body: "Informal" })];
  assert.deepEqual(commentLocation(comments[1]), { screen: "Settings/Account.png", locale: "fr", device: "iPadPro11" });
  assert.deepEqual(filterComments(comments, { locale: "fr" }).map((item) => item.id), ["cmt_2"]);
  assert.deepEqual(filterComments(comments, { category: "truncation" }).map((item) => item.id), ["cmt_1"]);
  assert.deepEqual(filterComments(comments, { query: "camille informal" }).length, 0);
  assert.deepEqual(filterComments(comments, { query: "INFORMAL" }).map((item) => item.id), ["cmt_2"]);
});

test("exports CSV safely for spreadsheets", () => {
  const csv = commentsCsv([comment({ body: '=HYPERLINK("x")', suggestedText: "Los, \"jetzt\"" })], () => "https://example.test/c");
  const [header, row] = csv.split("\r\n");
  assert.match(header, /^Screen,Language,Device,Category,Status,Comment/);
  assert.match(row, /^Onboarding\/Welcome\.png,de,iPhone15,Truncation,Open,"'=HYPERLINK\(""x""\)","Los, ""jetzt""",Camille,/);
  assert.match(row, /,0,https:\/\/example\.test\/c$/);
});
