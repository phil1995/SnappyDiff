PRAGMA foreign_keys = ON;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  workos_organization_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deletion_requested_at INTEGER
) STRICT;

CREATE TABLE organization_usage (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
  reserved_upload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_upload_bytes >= 0),
  upload_budget_bytes INTEGER NOT NULL DEFAULT 2147483648 CHECK (upload_budget_bytes > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  workos_user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'reviewer', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organization_id, user_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  retention_days INTEGER NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  promoted_retention_days INTEGER NOT NULL DEFAULT 365 CHECK (promoted_retention_days BETWEEN 1 AND 3650),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  UNIQUE (organization_id, slug),
  UNIQUE (organization_id, repository_owner, repository_name)
) STRICT;
CREATE INDEX projects_tenant_active ON projects(organization_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE suites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name = 'default'),
  is_system_default INTEGER NOT NULL DEFAULT 1 CHECK (is_system_default = 1),
  baseline_version INTEGER NOT NULL DEFAULT 0 CHECK (baseline_version >= 0),
  promotion_mode TEXT NOT NULL DEFAULT 'automatic' CHECK (promotion_mode IN ('automatic', 'paused')),
  active_baseline_run_id TEXT,
  rollback_run_id TEXT,
  known_default_head_sha TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organization_id, project_id, name)
) STRICT;
CREATE INDEX suites_tenant_project ON suites(organization_id, project_id);

CREATE TABLE commits (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha TEXT NOT NULL CHECK (length(sha) BETWEEN 7 AND 64),
  committed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organization_id, project_id, sha)
) WITHOUT ROWID, STRICT;

CREATE TABLE commit_edges (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  child_sha TEXT NOT NULL,
  parent_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organization_id, project_id, child_sha, parent_sha),
  FOREIGN KEY (organization_id, project_id, child_sha) REFERENCES commits(organization_id, project_id, sha) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id, parent_sha) REFERENCES commits(organization_id, project_id, sha) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
CREATE INDEX commit_edges_tenant_parent ON commit_edges(organization_id, project_id, parent_sha);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github_actions', 'manual', 'other')),
  provider_run_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  run_key TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  merge_base_sha TEXT,
  observed_default_head_sha TEXT,
  pull_request_number INTEGER,
  trust_class TEXT NOT NULL CHECK (trust_class IN ('first_party', 'fork_isolated')),
  expected_shards_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'verifying', 'complete', 'failed', 'canceled', 'timed_out')),
  allow_empty INTEGER NOT NULL DEFAULT 0 CHECK (allow_empty IN (0, 1)),
  logical_bytes INTEGER NOT NULL DEFAULT 0 CHECK (logical_bytes >= 0),
  screenshot_count INTEGER NOT NULL DEFAULT 0 CHECK (screenshot_count >= 0),
  deadline_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organization_id, project_id, provider, provider_run_id, attempt_number)
) STRICT;
CREATE INDEX runs_tenant_project_created ON runs(organization_id, project_id, created_at DESC);
CREATE INDEX runs_tenant_state_deadline ON runs(organization_id, state, deadline_at);

CREATE TABLE run_shards (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  shard_key TEXT NOT NULL,
  manifest_digest TEXT,
  expected_pages INTEGER,
  received_pages INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'sealed', 'verifying', 'verified', 'failed')),
  idempotency_key TEXT,
  finalized_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organization_id, run_id, shard_key),
  UNIQUE (organization_id, run_id, idempotency_key)
) STRICT;
CREATE INDEX run_shards_tenant_run ON run_shards(organization_id, run_id);

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type = 'image/png'),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 33554432),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 16384),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 16384),
  reference_state TEXT NOT NULL DEFAULT 'active' CHECK (reference_state IN ('active', 'deleting')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  UNIQUE (organization_id, sha256)
) STRICT;
CREATE INDEX images_tenant_state ON images(organization_id, reference_state);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  shard_id TEXT NOT NULL REFERENCES run_shards(id) ON DELETE CASCADE,
  expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64),
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes BETWEEN 1 AND 33554432),
  temporary_key TEXT NOT NULL UNIQUE,
  object_version TEXT,
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes > 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'uploaded', 'verifying', 'published', 'failed', 'expired')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organization_id, run_id, shard_id, expected_sha256)
) STRICT;
CREATE INDEX upload_sessions_tenant_expiry ON upload_sessions(organization_id, state, expires_at);

CREATE TABLE screenshots (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  shard_id TEXT NOT NULL REFERENCES run_shards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  image_id TEXT NOT NULL REFERENCES images(id),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organization_id, run_id, name)
) WITHOUT ROWID, STRICT;
CREATE INDEX screenshots_tenant_image ON screenshots(organization_id, image_id);

CREATE TABLE comparisons (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  baseline_run_id TEXT REFERENCES runs(id),
  current_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  added_count INTEGER NOT NULL DEFAULT 0 CHECK (added_count >= 0),
  removed_count INTEGER NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
  changed_count INTEGER NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'passed', 'action_required', 'accepted', 'rejected', 'error')),
  baseline_warning TEXT,
  config_json TEXT NOT NULL DEFAULT '{"algorithm":"sha256"}',
  reviewed_by_user_id TEXT REFERENCES users(id),
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organization_id, current_run_id)
) STRICT;
CREATE INDEX comparisons_tenant_project ON comparisons(organization_id, project_id, created_at DESC);

CREATE TABLE baselines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  suite_id TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id),
  segment INTEGER NOT NULL DEFAULT 1,
  action TEXT NOT NULL CHECK (action IN ('seed', 'promote', 'rollback', 'resume', 'history_reset')),
  actor_user_id TEXT REFERENCES users(id),
  previous_run_id TEXT REFERENCES runs(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organization_id, suite_id, run_id, action, segment)
) STRICT;
CREATE INDEX baselines_tenant_suite ON baselines(organization_id, suite_id, created_at DESC);

CREATE TABLE commit_runs (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  suite_id TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organization_id, suite_id, commit_sha)
) WITHOUT ROWID, STRICT;

CREATE TABLE retention_pins (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('active_baseline', 'rollback', 'open_pull_request')),
  owner_id TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
  comparison_id TEXT REFERENCES comparisons(id),
  released_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organization_id, owner_type, owner_id, run_id, comparison_id)
) STRICT;
CREATE INDEX retention_pins_tenant_active ON retention_pins(organization_id, run_id, comparison_id) WHERE released_at IS NULL;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  deduplication_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 10 CHECK (max_attempts > 0),
  next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER,
  UNIQUE (organization_id, deduplication_key)
) STRICT;
CREATE INDEX jobs_ready ON jobs(status, next_attempt_at, lease_expires_at);

CREATE TABLE github_checks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  github_check_id INTEGER,
  desired_version INTEGER NOT NULL DEFAULT 1,
  delivered_version INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivering', 'delivered', 'failed')),
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organization_id, run_id)
) STRICT;

CREATE TABLE github_installations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  repository_owner TEXT,
  repository_name TEXT,
  suspended_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organization_id, installation_id, repository_owner, repository_name)
) STRICT;

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_by_user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX api_tokens_tenant_active ON api_tokens(organization_id, project_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id),
  actor_token_id TEXT REFERENCES api_tokens(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX audit_events_tenant_created ON audit_events(organization_id, created_at DESC);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
) WITHOUT ROWID, STRICT;

