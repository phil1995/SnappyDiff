ALTER TABLE commits ADD COLUMN parents_complete INTEGER NOT NULL DEFAULT 0 CHECK (parents_complete IN (0, 1));
ALTER TABLE comparisons ADD COLUMN baseline_distance INTEGER;
ALTER TABLE comparisons ADD COLUMN decision_note TEXT;
ALTER TABLE github_checks ADD COLUMN scope_key TEXT;
CREATE UNIQUE INDEX github_repository_installation_owner
  ON github_installations(installation_id, repository_owner, repository_name)
  WHERE repository_owner IS NOT NULL AND repository_name IS NOT NULL;

CREATE TRIGGER commit_edges_reject_completed_graph_changes
BEFORE INSERT ON commit_edges
BEGIN
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM commits c WHERE c.organization_id = NEW.organization_id AND c.project_id = NEW.project_id
      AND c.sha = NEW.child_sha AND c.parents_complete = 1
  ) AND NOT EXISTS (
    SELECT 1 FROM commit_edges e WHERE e.organization_id = NEW.organization_id AND e.project_id = NEW.project_id
      AND e.child_sha = NEW.child_sha AND e.parent_sha = NEW.parent_sha
  ) THEN RAISE(ABORT, 'commit_graph_immutable') END);
END;

CREATE TABLE comparison_entries (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  comparison_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'removed', 'changed', 'unchanged')),
  baseline_image_id TEXT,
  current_image_id TEXT,
  PRIMARY KEY (organization_id, comparison_id, name),
  FOREIGN KEY (comparison_id, organization_id) REFERENCES comparisons(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (baseline_image_id, organization_id) REFERENCES images(id, organization_id),
  FOREIGN KEY (current_image_id, organization_id) REFERENCES images(id, organization_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX comparison_entries_changed ON comparison_entries(organization_id, comparison_id, kind, name);

CREATE TABLE github_check_owners (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organization_id, project_id, scope_key),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, organization_id) REFERENCES runs(id, organization_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

CREATE TABLE github_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  processed_at INTEGER
) STRICT;

CREATE TABLE pull_requests (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'unknown')),
  head_sha TEXT,
  base_sha TEXT,
  installation_id INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organization_id, project_id, number),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

CREATE TABLE comparison_decisions (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  comparison_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  user_id TEXT NOT NULL REFERENCES users(id),
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organization_id, comparison_id),
  FOREIGN KEY (comparison_id, organization_id) REFERENCES comparisons(id, organization_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
