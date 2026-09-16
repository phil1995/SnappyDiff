ALTER TABLE organization_usage RENAME TO organization_usage_unguarded;

CREATE TABLE organization_usage (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
  reserved_upload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_upload_bytes >= 0),
  upload_budget_bytes INTEGER NOT NULL DEFAULT 2147483648 CHECK (upload_budget_bytes > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (stored_bytes + reserved_upload_bytes <= upload_budget_bytes)
) STRICT;

INSERT INTO organization_usage (organization_id, stored_bytes, reserved_upload_bytes, upload_budget_bytes, updated_at)
SELECT organization_id, stored_bytes, reserved_upload_bytes,
  MAX(upload_budget_bytes, stored_bytes + reserved_upload_bytes), updated_at
FROM organization_usage_unguarded;

DROP TABLE organization_usage_unguarded;

ALTER TABLE shard_finalizations ADD COLUMN lease_owner TEXT;
ALTER TABLE shard_finalizations ADD COLUMN lease_expires_at INTEGER;

CREATE TRIGGER manifest_pages_require_open_shard
BEFORE INSERT ON manifest_pages
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM run_shards s JOIN runs r ON r.id = s.run_id AND r.organization_id = s.organization_id
     WHERE s.id = NEW.shard_id AND s.organization_id = NEW.organization_id AND s.run_id = NEW.run_id
       AND s.state = 'open' AND r.state = 'open' AND r.deadline_at > unixepoch()
       AND NOT EXISTS (
         SELECT 1 FROM shard_finalizations f
          WHERE f.organization_id = NEW.organization_id AND f.shard_id = NEW.shard_id
       )
  ) THEN RAISE(ABORT, 'shard_not_open') END;
END;

CREATE TRIGGER manifest_entries_require_open_shard
BEFORE INSERT ON manifest_entries
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM run_shards s JOIN runs r ON r.id = s.run_id AND r.organization_id = s.organization_id
     WHERE s.id = NEW.shard_id AND s.organization_id = NEW.organization_id AND s.run_id = NEW.run_id
       AND s.state = 'open' AND r.state = 'open' AND r.deadline_at > unixepoch()
       AND NOT EXISTS (
         SELECT 1 FROM shard_finalizations f
          WHERE f.organization_id = NEW.organization_id AND f.shard_id = NEW.shard_id
       )
  ) THEN RAISE(ABORT, 'shard_not_open') END;
END;
