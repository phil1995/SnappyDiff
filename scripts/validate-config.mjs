import { readFileSync } from "node:fs";

const requiredVariables = [
  "APP_ENV",
  "APP_ORIGIN",
  "WORKOS_CLIENT_ID",
  "WORKOS_REDIRECT_URI",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "R2_BUCKET_NAME",
  "CLOUDFLARE_ACCOUNT_ID",
];

const requiredSecrets = [
  "WORKOS_API_KEY",
  "WORKOS_WEBHOOK_SECRET",
  "WORKOS_COOKIE_PASSWORD",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "TOKEN_PEPPER",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];

function parseEnvironmentFile(path) {
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Invalid environment line in ${path}: ${rawLine}`);
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

const arguments_ = process.argv.slice(2);
const requireSecrets = arguments_.includes("--require-secrets");
const file = arguments_.find((argument) => !argument.startsWith("--"));
const configuration = { ...(file ? parseEnvironmentFile(file) : {}), ...process.env };
const missing = requiredVariables.filter((name) => !configuration[name]);
const missingSecrets = requiredSecrets.filter((name) => !configuration[name]);
const placeholderSecrets = requiredSecrets.filter((name) => configuration[name]?.includes("replace_me"));

if (missing.length > 0 || placeholderSecrets.length > 0 || (requireSecrets && missingSecrets.length > 0)) {
  if (missing.length > 0) console.error(`Missing variables: ${missing.join(", ")}`);
  if (requireSecrets && missingSecrets.length > 0) console.error(`Missing secrets: ${missingSecrets.join(", ")}`);
  if (placeholderSecrets.length > 0) console.error(`Placeholder secrets: ${placeholderSecrets.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("Public configuration shape is valid.");
  if (missingSecrets.length > 0) {
    console.log(`Provider integrations remain disabled; ${missingSecrets.length} required secrets are not set.`);
  } else {
    console.log("Required secret bindings are present. Secret values were not printed.");
  }
}
