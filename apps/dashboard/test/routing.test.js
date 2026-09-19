import assert from "node:assert/strict";
import { test } from "node:test";

async function renderUploadSetup(role, workspaceResponse) {
  const root = { innerHTML: "", querySelector: () => ({ addEventListener() {} }) };
  globalThis.document = { querySelector: () => root, addEventListener() {} };
  globalThis.location = { pathname: "/projects/new", search: "", origin: "https://example.test" };
  globalThis.addEventListener = () => {};
  globalThis.fetch = async (path) => {
    if (path === "/api/v1/me") return Response.json({
      user: { email: "user@example.test", role }, configuration: { appOrigin: "https://example.test", oidcAudience: "snappydiff" },
    });
    if (path === "/api/v1/projects") return Response.json({ projects: [] });
    return workspaceResponse;
  };
  await import(`../src/app.js?test=${crypto.randomUUID()}`);
  await new Promise((resolve) => setImmediate(resolve));
  return root.innerHTML;
}

test("upload setup starts with key creation only", async () => {
  const html = await renderUploadSetup("admin", Response.json({ tokens: [] }));
  assert.match(html, /Create an upload key/);
  assert.doesNotMatch(html, /\.snappydiff\.json|Connect.*GitHub|GitHub Actions/);
});

test("upload setup renders an error for non-administrators", async () => {
  const html = await renderUploadSetup("viewer", Response.json({ tokens: [] }));
  assert.match(html, /Only workspace administrators/);
});

test("upload setup renders API failures instead of leaving a loading screen", async () => {
  const html = await renderUploadSetup("admin", Response.json({ error: { message: "Token storage unavailable" } }, { status: 503 }));
  assert.match(html, /Token storage unavailable/);
  assert.doesNotMatch(html, /aria-label="Loading"/);
});
