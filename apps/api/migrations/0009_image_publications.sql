CREATE TABLE image_publications (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  image_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL DEFAULT 'image/png',
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organization_id, sha256),
  UNIQUE (image_id, organization_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX image_publications_created
  ON image_publications(created_at);
