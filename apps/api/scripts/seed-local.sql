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
VALUES ('run_local_baseline', 'org_local', 'prj_local_demo', 'ste_local_demo', 'github_actions',
  'local-demo-baseline', 1, 'local-demo-baseline', '0000000000abcdef1234567890abcdef12345678', 'main',
  'first_party', '["default"]', 'complete', 122880, 2, unixepoch() + 86400, unixepoch() - 3600,
  unixepoch() - 3900, unixepoch() - 3600);

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

INSERT OR IGNORE INTO run_shards
  (id, organization_id, run_id, shard_key, expected_pages, received_pages, state, finalized_at)
VALUES ('shd_local_baseline', 'org_local', 'run_local_baseline', 'default', 1, 1, 'verified', unixepoch() - 3600);

INSERT OR IGNORE INTO images
  (id, organization_id, sha256, r2_key, content_type, byte_size, width, height)
VALUES
  ('img_local_baseline_detail', 'org_local', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'local-fixture/detail-baseline.png', 'image/png', 1, 960, 640),
  ('img_local_current_detail', 'org_local', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'local-fixture/detail-current.png', 'image/png', 1, 960, 640),
  ('img_local_baseline_home', 'org_local', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'local-fixture/home-baseline.png', 'image/png', 1, 960, 640),
  ('img_local_current_home', 'org_local', 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 'local-fixture/home-current.png', 'image/png', 1, 960, 640),
  ('img_local_current_new', 'org_local', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'local-fixture/new-current.png', 'image/png', 1, 960, 640);

INSERT OR IGNORE INTO screenshots (organization_id, run_id, shard_id, name, image_id)
VALUES
  ('org_local', 'run_local_baseline', 'shd_local_baseline', 'Examples/DetailScreen.png', 'img_local_baseline_detail'),
  ('org_local', 'run_local_baseline', 'shd_local_baseline', 'Examples/HomeScreen.png', 'img_local_baseline_home'),
  ('org_local', 'run_local_demo', 'shd_local_demo', 'Examples/DetailScreen.png', 'img_local_current_detail'),
  ('org_local', 'run_local_demo', 'shd_local_demo', 'Examples/HomeScreen.png', 'img_local_current_home'),
  ('org_local', 'run_local_demo', 'shd_local_demo', 'Examples/NewScreen.png', 'img_local_current_new');

INSERT OR IGNORE INTO comparisons
  (id, organization_id, project_id, suite_id, current_run_id, added_count, removed_count,
   changed_count, unchanged_count, status)
VALUES ('cmp_local_demo', 'org_local', 'prj_local_demo', 'ste_local_demo', 'run_local_demo',
  1, 0, 2, 0, 'action_required');

UPDATE comparisons SET baseline_run_id = 'run_local_baseline'
WHERE id = 'cmp_local_demo' AND organization_id = 'org_local';

INSERT INTO comparison_entries
  (organization_id, comparison_id, name, kind, baseline_image_id, current_image_id)
VALUES
  ('org_local', 'cmp_local_demo', 'Examples/DetailScreen.png', 'changed', 'img_local_baseline_detail', 'img_local_current_detail'),
  ('org_local', 'cmp_local_demo', 'Examples/HomeScreen.png', 'changed', 'img_local_baseline_home', 'img_local_current_home'),
  ('org_local', 'cmp_local_demo', 'Examples/NewScreen.png', 'added', NULL, 'img_local_current_new')
ON CONFLICT (organization_id, comparison_id, name) DO UPDATE SET
  kind = excluded.kind,
  baseline_image_id = excluded.baseline_image_id,
  current_image_id = excluded.current_image_id;

-- Localized variants for the Screens view. Names follow the <screen>.<locale>-<device>.png convention.
WITH
  screens(slug, screen) AS (VALUES ('welcome', 'Onboarding/Welcome'), ('account', 'Settings/Account'), ('summary', 'Checkout/Summary')),
  locales(locale) AS (VALUES ('en'), ('de'), ('fr'), ('ja')),
  devices(device, width, height) AS (VALUES ('iPhone15', 393, 852), ('iPadPro11', 834, 1194))
INSERT OR IGNORE INTO images (id, organization_id, sha256, r2_key, content_type, byte_size, width, height)
SELECT 'img_local_l10n_' || slug || '_' || locale || '_' || device, 'org_local',
  substr(lower(hex(slug || '|' || locale || '|' || device)) || '0000000000000000000000000000000000000000000000000000000000000000', 1, 64),
  'local-fixture/l10n/' || slug || '/' || locale || '/' || device || '.png', 'image/png', 1, width, height
  FROM screens, locales, devices;

WITH
  screens(slug, screen) AS (VALUES ('welcome', 'Onboarding/Welcome'), ('account', 'Settings/Account'), ('summary', 'Checkout/Summary')),
  locales(locale) AS (VALUES ('en'), ('de'), ('fr'), ('ja')),
  devices(device) AS (VALUES ('iPhone15'), ('iPadPro11'))
INSERT OR IGNORE INTO screenshots (organization_id, run_id, shard_id, name, image_id)
SELECT 'org_local', 'run_local_baseline', 'shd_local_baseline', screen || '.' || locale || '-' || device || '.png',
  'img_local_l10n_' || slug || '_' || locale || '_' || device
  FROM screens, locales, devices;

UPDATE runs SET screenshot_count = (
  SELECT COUNT(*) FROM screenshots WHERE organization_id = 'org_local' AND run_id = 'run_local_baseline'
) WHERE id = 'run_local_baseline' AND organization_id = 'org_local';

-- The feature branch shortens the German and French welcome copy, so the demo comparison has localized variants.
WITH
  locales(locale) AS (VALUES ('de'), ('fr')),
  devices(device, width, height) AS (VALUES ('iPhone15', 393, 852), ('iPadPro11', 834, 1194))
INSERT OR IGNORE INTO images (id, organization_id, sha256, r2_key, content_type, byte_size, width, height)
SELECT 'img_local_l10n_welcome_' || locale || '_' || device || '_shortened', 'org_local',
  substr(lower(hex('short|' || locale || '|' || device)) || '0000000000000000000000000000000000000000000000000000000000000000', 1, 64),
  'local-fixture/l10n/welcome/' || locale || '/' || device || '-shortened.png', 'image/png', 1, width, height
  FROM locales, devices;

WITH
  locales(locale) AS (VALUES ('en'), ('de'), ('fr'), ('ja')),
  devices(device) AS (VALUES ('iPhone15'), ('iPadPro11'))
INSERT OR IGNORE INTO screenshots (organization_id, run_id, shard_id, name, image_id)
SELECT 'org_local', 'run_local_demo', 'shd_local_demo', 'Onboarding/Welcome.' || locale || '-' || device || '.png',
  'img_local_l10n_welcome_' || locale || '_' || device || CASE WHEN locale IN ('de', 'fr') THEN '_shortened' ELSE '' END
  FROM locales, devices;

WITH
  locales(locale) AS (VALUES ('de'), ('fr')),
  devices(device) AS (VALUES ('iPhone15'), ('iPadPro11'))
INSERT INTO comparison_entries (organization_id, comparison_id, name, kind, baseline_image_id, current_image_id)
SELECT 'org_local', 'cmp_local_demo', 'Onboarding/Welcome.' || locale || '-' || device || '.png', 'changed',
  'img_local_l10n_welcome_' || locale || '_' || device, 'img_local_l10n_welcome_' || locale || '_' || device || '_shortened'
  FROM locales, devices
 WHERE true
ON CONFLICT (organization_id, comparison_id, name) DO UPDATE SET
  kind = excluded.kind,
  baseline_image_id = excluded.baseline_image_id,
  current_image_id = excluded.current_image_id;

UPDATE runs SET screenshot_count = (
  SELECT COUNT(*) FROM screenshots WHERE organization_id = 'org_local' AND run_id = 'run_local_demo'
) WHERE id = 'run_local_demo' AND organization_id = 'org_local';

UPDATE comparisons SET changed_count = (
  SELECT COUNT(*) FROM comparison_entries WHERE organization_id = 'org_local' AND comparison_id = 'cmp_local_demo' AND kind = 'changed'
), unchanged_count = 4
WHERE id = 'cmp_local_demo' AND organization_id = 'org_local';
