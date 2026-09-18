-- Apply manually with Wrangler's local D1 execute command. Never apply this file remotely.
INSERT OR IGNORE INTO organizations (id, workos_organization_id, name, slug)
VALUES ('org_local', 'org_local_workos', 'Local Organization', 'local');

INSERT OR IGNORE INTO organization_usage (organization_id, upload_budget_bytes)
VALUES ('org_local', 2147483648);

INSERT OR IGNORE INTO users (id, workos_user_id, email, display_name)
VALUES ('usr_local', 'usr_local_workos', 'local@snappydiff.dev', 'Local Admin');

INSERT OR IGNORE INTO memberships (organization_id, user_id, role, status)
VALUES ('org_local', 'usr_local', 'admin', 'active');

INSERT OR IGNORE INTO projects
  (id, organization_id, name, slug, repository_owner, repository_name, default_branch)
VALUES ('prj_local_demo', 'org_local', 'Snapshot Testing Demo', 'snapshot-testing-demo',
  'pointfreeco', 'swift-snapshot-testing', 'main');

INSERT OR IGNORE INTO suites (id, organization_id, project_id, name, is_system_default)
VALUES ('ste_local_demo', 'org_local', 'prj_local_demo', 'default', 1);

INSERT OR IGNORE INTO runs
  (id, organization_id, project_id, suite_id, provider, provider_run_id, attempt_number, run_key,
   commit_sha, branch, trust_class, expected_shards_json, state, logical_bytes, screenshot_count,
   deadline_at, completed_at, created_at, updated_at)
VALUES ('run_local_demo', 'org_local', 'prj_local_demo', 'ste_local_demo', 'github_actions',
  'local-demo-1', 1, 'local-demo-1', '1234567890abcdef1234567890abcdef12345678', 'feature/local-preview',
  'first_party', '["default"]', 'complete', 184320, 3, unixepoch() + 86400, unixepoch(),
  unixepoch() - 300, unixepoch());

INSERT OR IGNORE INTO run_shards
  (id, organization_id, run_id, shard_key, expected_pages, received_pages, state, finalized_at)
VALUES ('shd_local_demo', 'org_local', 'run_local_demo', 'default', 1, 1, 'verified', unixepoch());

INSERT OR IGNORE INTO comparisons
  (id, organization_id, project_id, suite_id, current_run_id, added_count, removed_count,
   changed_count, unchanged_count, status)
VALUES ('cmp_local_demo', 'org_local', 'prj_local_demo', 'ste_local_demo', 'run_local_demo',
  1, 0, 2, 0, 'action_required');

INSERT OR IGNORE INTO comparison_entries
  (organization_id, comparison_id, name, kind)
VALUES
  ('org_local', 'cmp_local_demo', 'Examples/DetailScreen.png', 'changed'),
  ('org_local', 'cmp_local_demo', 'Examples/HomeScreen.png', 'changed'),
  ('org_local', 'cmp_local_demo', 'Examples/NewScreen.png', 'added');
