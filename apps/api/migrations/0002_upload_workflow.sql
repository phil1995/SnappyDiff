CREATE TABLE manifest_pages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  page_number INTEGER NOT NULL CHECK (page_number >= 0),
  total_pages INTEGER NOT NULL CHECK (total_pages BETWEEN 1 AND 2500),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  idempotency_key TEXT NOT NULL,
  entries_json TEXT NOT NULL CHECK (length(entries_json) <= 4194304),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organization_id, shard_id, page_number),
  UNIQUE (organization_id, shard_id, idempotency_key),
  FOREIGN KEY (run_id, organization_id) REFERENCES runs(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (shard_id, organization_id) REFERENCES run_shards(id, organization_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX manifest_pages_tenant_shard ON manifest_pages(organization_id, shard_id, page_number);

CREATE TABLE manifest_entries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 33554432),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 16384),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 16384),
  image_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (organization_id, run_id, name),
  FOREIGN KEY (run_id, organization_id) REFERENCES runs(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (shard_id, organization_id) REFERENCES run_shards(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (image_id, organization_id) REFERENCES images(id, organization_id)
) STRICT;
CREATE INDEX manifest_entries_tenant_hash ON manifest_entries(organization_id, run_id, sha256);

ALTER TABLE upload_sessions ADD COLUMN upload_completed_at INTEGER;
ALTER TABLE upload_sessions ADD COLUMN temporary_deleted_at INTEGER;

CREATE TABLE shard_finalizations (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shard_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organization_id, shard_id),
  FOREIGN KEY (shard_id, organization_id) REFERENCES run_shards(id, organization_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
