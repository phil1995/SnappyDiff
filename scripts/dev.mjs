import { randomBytes } from "node:crypto";
import { existsSync, rmSync, watch, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { wranglerInvocation } from "./dev-command.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const api = join(root, "apps", "api");
const dashboard = join(root, "apps", "dashboard");
const wrangler = wranglerInvocation(root, []);

if (process.argv.includes("--reset")) {
  const localState = join(api, ".wrangler", "state");
  rmSync(localState, { recursive: true, force: true });
  console.log("Reset local Wrangler state.");
}

if (!existsSync(wrangler.args[0])) {
  console.error("Install dependencies with npm install before running npm run dev.");
  process.exit(1);
}

const varsPath = join(api, ".dev.vars");
if (!existsSync(varsPath)) {
  writeFileSync(varsPath, [
    `WORKOS_COOKIE_PASSWORD=${randomBytes(32).toString("base64url")}`,
    `TOKEN_PEPPER=${randomBytes(32).toString("base64url")}`,
    "",
  ].join("\n"), { mode: 0o600 });
  console.log("Created ignored local secrets in apps/api/.dev.vars.");
}

function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function buildDashboard() {
  run(process.execPath, ["scripts/build.mjs"], dashboard);
  console.log("Dashboard assets rebuilt.");
}

run(wrangler.command, [...wrangler.args, "d1", "migrations", "apply", "snappydiff-local", "--local", "--config", "apps/api/wrangler.jsonc"], root,
  { ...process.env, CI: "true" });
run(wrangler.command, [...wrangler.args, "d1", "execute", "snappydiff-local", "--local", "--config", "apps/api/wrangler.jsonc", "--file", "apps/api/scripts/seed-local.sql"]);
buildDashboard();

let rebuildTimer;
const dashboardWatcher = watch(join(dashboard, "src"), { recursive: true }, () => {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(buildDashboard, 75);
});

const worker = spawn(wrangler.command, [...wrangler.args, "dev", "--config", "apps/api/wrangler.jsonc"], { cwd: root, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => worker.kill(signal));
}
worker.on("exit", (code, signal) => {
  clearTimeout(rebuildTimer);
  dashboardWatcher.close();
  process.exit(signal ? 0 : code ?? 1);
});
