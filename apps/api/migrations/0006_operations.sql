ALTER TABLE runs ADD COLUMN artifacts_expired_at INTEGER;
ALTER TABLE images ADD COLUMN deletion_claimed_at INTEGER;
ALTER TABLE pull_requests ADD COLUMN retention_state TEXT NOT NULL DEFAULT 'current'
  CHECK (retention_state IN ('current', 'unresolved'));
ALTER TABLE pull_requests ADD COLUMN last_reconciled_at INTEGER;
ALTER TABLE pull_requests ADD COLUMN reconciliation_error TEXT;

CREATE INDEX runs_artifact_retention
  ON runs(organization_id, project_id, completed_at, artifacts_expired_at)
  WHERE state = 'complete';
CREATE INDEX images_deletion_claim
  ON images(reference_state, deletion_claimed_at);
CREATE INDEX pull_requests_reconciliation
  ON pull_requests(state, retention_state, last_reconciled_at);
