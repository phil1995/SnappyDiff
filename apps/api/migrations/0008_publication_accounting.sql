ALTER TABLE upload_sessions ADD COLUMN reservation_released_at INTEGER;
ALTER TABLE comparisons ADD COLUMN selection_error TEXT;

CREATE INDEX upload_sessions_reservation_release
  ON upload_sessions(organization_id, state, reservation_released_at);
