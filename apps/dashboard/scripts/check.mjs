import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const directory of ["src", "scripts"]) {
  for (const file of readdirSync(new URL(`../${directory}/`, import.meta.url)).sort()) {
    if (!/\.m?js$/.test(file)) continue;
    const result = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(`../${directory}/${file}`, import.meta.url))], {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
