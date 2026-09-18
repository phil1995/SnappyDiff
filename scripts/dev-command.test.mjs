import assert from "node:assert/strict";
import { test } from "node:test";
import { win32 } from "node:path";
import { wranglerInvocation } from "./dev-command.mjs";

test("launches Wrangler through Node on Windows", () => {
  const root = "C:\\src\\SnappyDiff";
  const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";
  const invocation = wranglerInvocation(root, ["dev"], nodeExecutable);

  assert.equal(invocation.command, nodeExecutable);
  assert.equal(invocation.args.at(-1), "dev");
  assert.equal(
    win32.normalize(invocation.args[0]),
    win32.join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
  );
  assert.equal(invocation.command.endsWith(".cmd"), false);
});
