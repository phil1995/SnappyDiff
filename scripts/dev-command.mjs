import { join } from "node:path";

export function wranglerInvocation(root, args, nodeExecutable = process.execPath) {
  return {
    command: nodeExecutable,
    args: [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), ...args],
  };
}
