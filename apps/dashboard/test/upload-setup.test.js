import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { configureUploadStep, findNewProject, oidcUploadWorkflow, pointfreeArtifactEnvironment, prepareArtifactsWorkflow, uploadWorkflow, waitForUploadStep } from "../src/upload-setup.js";

const parseStep = (source) => parse(`steps:\n${source.split("\n").map((line) => `  ${line}`).join("\n")}`).steps[0];

test("workflow is self-contained without a configuration file", () => {
  const workflow = uploadWorkflow("https://snapshots.example.test");
  assert.match(workflow, /uses: phil1995\/SnappyDiff@v0\.1\.0/);
  assert.match(workflow, /token: \$\{\{ secrets\.SNAPPYDIFF_TOKEN \}\}/);
  assert.match(workflow, /endpoint: https:\/\/snapshots\.example\.test/);
  assert.match(pointfreeArtifactEnvironment(), /SNAPSHOT_ARTIFACTS: \$\{\{ runner\.temp \}\}\/snappydiff-artifacts/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /\.snappydiff\.json/);
  assert.equal(parseStep(workflow).with.endpoint, "https://snapshots.example.test");
  assert.equal(parseStep(prepareArtifactsWorkflow()).name, "Prepare snapshot artifacts");
  assert.equal(parse(pointfreeArtifactEnvironment()).env.SNAPSHOT_ARTIFACTS, "${{ runner.temp }}/snappydiff-artifacts");
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
