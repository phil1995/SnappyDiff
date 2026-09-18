import assert from "node:assert/strict";
import test from "node:test";

import { parseGitHubRepository, projectSetupPath, projectSlug } from "../src/project-form.js";

test("parses repository shorthand and common GitHub URLs", () => {
  assert.deepEqual(parseGitHubRepository("phil1995/SnappyDiff"), {
    repositoryOwner: "phil1995",
    repositoryName: "SnappyDiff",
  });
  assert.deepEqual(parseGitHubRepository("https://github.com/phil1995/SnappyDiff/"), {
    repositoryOwner: "phil1995",
    repositoryName: "SnappyDiff",
  });
  assert.deepEqual(parseGitHubRepository("git@github.com:phil1995/SnappyDiff.git"), {
    repositoryOwner: "phil1995",
    repositoryName: "SnappyDiff",
  });
});

test("rejects non-GitHub and malformed repositories", () => {
  assert.throws(() => parseGitHubRepository("https://example.com/owner/repo"), /github\.com/);
  assert.throws(() => parseGitHubRepository("owner"), /owner\/repository/);
  assert.throws(() => parseGitHubRepository("owner/repo/extra"), /owner\/repository/);
});

test("creates API-safe project slugs", () => {
  assert.equal(projectSlug("My iOS App"), "my-ios-app");
  assert.equal(projectSlug("  Über View!!!  "), "uber-view");
  assert.equal(projectSlug("!!!", "Snapshot Repo"), "snapshot-repo");
  assert.equal(projectSlug("a".repeat(80)).length, 63);
  assert.equal(projectSlug("日本語", `${"a".repeat(62)}-repo`), "a".repeat(62));
});

test("does not route a stale project creation response", () => {
  assert.equal(projectSetupPath("prj_1", 4, 4), "/projects/prj_1/setup");
  assert.equal(projectSetupPath("prj_1", 4, 5), null);
});
