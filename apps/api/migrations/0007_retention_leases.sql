ALTER TABLE runs ADD COLUMN artifact_expiry_owner TEXT;
ALTER TABLE runs ADD COLUMN artifact_expiry_claimed_at INTEGER;
ALTER TABLE runs ADD COLUMN metadata_deletion_owner TEXT;
ALTER TABLE runs ADD COLUMN metadata_deletion_claimed_at INTEGER;
ALTER TABLE images ADD COLUMN deletion_owner TEXT;
ALTER TABLE pull_requests ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX runs_artifact_expiry_claim
  ON runs(artifact_expiry_owner, artifact_expiry_claimed_at);
CREATE INDEX runs_metadata_deletion_claim
  ON runs(metadata_deletion_owner, metadata_deletion_claimed_at);
CREATE INDEX images_deletion_owner
  ON images(deletion_owner, deletion_claimed_at);
