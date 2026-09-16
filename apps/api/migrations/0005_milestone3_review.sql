ALTER TABLE runs ADD COLUMN pull_request_head_sha TEXT;
ALTER TABLE github_check_owners ADD COLUMN head_sha TEXT;
ALTER TABLE github_check_owners ADD COLUMN provider_run_id TEXT;
ALTER TABLE github_checks ADD COLUMN delivery_lease_owner TEXT;
ALTER TABLE github_checks ADD COLUMN delivery_lease_expires_at INTEGER;
ALTER TABLE pull_requests ADD COLUMN github_updated_at INTEGER NOT NULL DEFAULT 0;

UPDATE retention_pins
   SET owner_id = COALESCE((
     SELECT r.project_id FROM runs r
      WHERE r.organization_id = retention_pins.organization_id AND r.id = retention_pins.run_id
   ), 'unknown') || ':' || owner_id
 WHERE owner_type = 'open_pull_request' AND owner_id LIKE 'pr:%';

CREATE INDEX github_checks_delivery_lease
  ON github_checks(state, delivery_lease_expires_at);
