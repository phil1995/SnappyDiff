const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

export function pointfreeArtifactEnvironment() {
  return `env:
  SNAPSHOT_ARTIFACTS: \${{ runner.temp }}/snappydiff-artifacts`;
}

export function prepareArtifactsWorkflow() {
  return `- name: Prepare snapshot artifacts
  run: mkdir -p "\$SNAPSHOT_ARTIFACTS"
  env:
    SNAPSHOT_ARTIFACTS: \${{ runner.temp }}/snappydiff-artifacts`;
}

export function uploadWorkflow(endpoint) {
  return `- name: Upload snapshots
  if: always()
  uses: phil1995/SnappyDiff@v0.1.0
  with:
    token: \${{ secrets.SNAPPYDIFF_TOKEN }}
    endpoint: ${endpoint}
    artifacts: \${{ runner.temp }}/snappydiff-artifacts`;
}

export function oidcUploadWorkflow(endpoint, audience) {
  return `- name: Upload snapshots
  env:
    SNAPPYDIFF_ENDPOINT: ${endpoint}
    SNAPPYDIFF_OIDC_AUDIENCE: ${audience}
  run: snappydiff upload ./Snapshots --concurrency 4`;
}

export function findNewProject(projects, initialProjectIds) {
  return projects.find((project) => !initialProjectIds.has(project.id));
}

export function createKeyStep(activeTokenCount) {
  return `<section class="setup-wizard"><span class="step-label">Step 1 of 3</span><h1>Create an upload key</h1><form data-workspace-token-create><label>Key name<input name="name" maxlength="100" value="CI uploads" required></label><label>Expiry days<input name="expiresInDays" type="number" min="1" max="365" value="365"></label><button class="button primary">Create key</button></form>${activeTokenCount ? `<p class="muted compact">This workspace already has ${activeTokenCount} active ${activeTokenCount === 1 ? "key" : "keys"}.</p>` : ""}</section>`;
}

export function configureUploadStep(token, endpoint) {
  return `<section class="setup-wizard setup-wizard-wide"><span class="step-label">Step 2 of 3</span><h1>Add SnappyDiff to CI</h1><label>Repository secret · SNAPPYDIFF_TOKEN</label><div class="secret secret-copy"><code data-workspace-token>${escapeHtml(token)}</code><button class="button" type="button" data-copy-token>Copy</button></div><p class="muted compact">Save this as a GitHub Actions repository secret. The key is only shown once.</p><label>1 · Add to your existing snapshot test step</label><pre><code>${escapeHtml(pointfreeArtifactEnvironment())}</code></pre><label>2 · Add immediately before the snapshot test step</label><pre><code>${escapeHtml(prepareArtifactsWorkflow())}</code></pre><label>3 · Add immediately after the snapshot test step</label><pre><code>${escapeHtml(uploadWorkflow(endpoint))}</code></pre><div class="form-actions"><button class="button primary" type="button" data-setup-done>Done</button></div></section>`;
}

export function waitForUploadStep(message = "") {
  return `<section class="setup-wizard"><span class="step-label">Step 3 of 3</span><h1>Waiting for the first upload</h1>${message ? `<p class="setup-status" role="status">${escapeHtml(message)}</p>` : ""}<button class="button primary" type="button" data-refresh-projects>Refresh</button></section>`;
}
