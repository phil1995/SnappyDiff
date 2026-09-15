const requiredVariables = [
  "APP_ENV",
  "APP_ORIGIN",
  "WORKOS_CLIENT_ID",
  "WORKOS_REDIRECT_URI",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
];

const requiredSecrets = [
  "WORKOS_API_KEY",
  "WORKOS_COOKIE_PASSWORD",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "TOKEN_PEPPER",
];

const missing = requiredVariables.filter((name) => !process.env[name]);
const placeholderSecrets = requiredSecrets.filter((name) => process.env[name]?.includes("replace_me"));

if (missing.length > 0 || placeholderSecrets.length > 0) {
  if (missing.length > 0) console.error(`Missing variables: ${missing.join(", ")}`);
  if (placeholderSecrets.length > 0) console.error(`Placeholder secrets: ${placeholderSecrets.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("Configuration shape is valid. Secret values were not printed.");
}

