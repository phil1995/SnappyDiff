CREATE TABLE organization_deletion_requests (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  execute_after INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'deleting')),
  deleting_started_at INTEGER,
  requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) WITHOUT ROWID, STRICT;

CREATE TABLE organization_deletion_objects (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organization_id, r2_key)
) WITHOUT ROWID, STRICT;

CREATE INDEX organization_deletions_due
  ON organization_deletion_requests(state, execute_after);
CREATE INDEX organization_deletion_objects_pending
  ON organization_deletion_objects(organization_id, deleted_at);
