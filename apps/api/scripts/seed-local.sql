-- Apply manually with Wrangler's local D1 execute command. Never apply this file remotely.
INSERT OR IGNORE INTO organizations (id, workos_organization_id, name, slug)
VALUES ('org_local', 'org_local_workos', 'Local Organization', 'local');

INSERT OR IGNORE INTO organization_usage (organization_id, upload_budget_bytes)
VALUES ('org_local', 2147483648);

