ALTER TABLE image_publications ADD COLUMN deletion_owner TEXT;
ALTER TABLE image_publications ADD COLUMN deletion_claimed_at INTEGER;

CREATE INDEX image_publications_deletion_owner
  ON image_publications(deletion_owner, deletion_claimed_at);
