import assert from "node:assert/strict";
import { test } from "node:test";
import { configureUploadStep, findNewProject, oidcUploadWorkflow, uploadWorkflow, waitForUploadStep } from "../src/upload-setup.js";

test("workflow is self-contained without a configuration file", () => {
  const workflow = uploadWorkflow("https://snapshots.example.test");
  assert.match(workflow, /SNAPPYDIFF_TOKEN: \$\{\{ secrets\.SNAPPYDIFF_TOKEN \}\}/);
  assert.match(workflow, /SNAPPYDIFF_ENDPOINT: https:\/\/snapshots\.example\.test/);
  assert.match(workflow, /--concurrency 4/);
  assert.doesNotMatch(workflow, /\.snappydiff\.json/);
});

test("OIDC workflow includes a nondefault audience", () => {
  const workflow = oidcUploadWorkflow("https://snapshots.example.test", "snappydiff-staging");
  assert.match(workflow, /SNAPPYDIFF_OIDC_AUDIENCE: snappydiff-staging/);
  assert.doesNotMatch(workflow, /SNAPPYDIFF_TOKEN/);
});

test("refresh identifies only a project created after setup began", () => {
  const initial = new Set(["existing"]);
  assert.equal(findNewProject([{ id: "existing" }], initial), undefined);
  assert.deepEqual(findNewProject([{ id: "existing" }, { id: "new" }], initial), { id: "new" });
});

test("configuration step keeps the one-time key copyable beside the workflow", () => {
  const html = configureUploadStep("sd_secret&value", "https://snapshots.example.test");
  assert.match(html, /data-copy-token/);
  assert.match(html, /sd_secret&amp;value/);
  assert.match(html, /GitHub Actions repository secret/);
  assert.match(html, /data-setup-done/);
});

test("waiting step offers an explicit refresh", () => {
  const html = waitForUploadStep("No upload received yet.");
  assert.match(html, /Waiting for the first upload/);
  assert.match(html, /data-refresh-projects/);
  assert.match(html, /No upload received yet/);
});
