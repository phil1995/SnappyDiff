-- Feedback on screenshots. Comments follow a screen across builds through screenshot_name;
-- image_id and run_id record the build the comment was written against and intentionally carry
-- no foreign key, so retention can still collect those artifacts.
CREATE TABLE screen_comments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  screenshot_name TEXT NOT NULL CHECK (length(screenshot_name) BETWEEN 1 AND 1024),
  run_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  region_x REAL CHECK (region_x BETWEEN 0 AND 1),
  region_y REAL CHECK (region_y BETWEEN 0 AND 1),
  region_width REAL CHECK (region_width > 0 AND region_width <= 1),
  region_height REAL CHECK (region_height > 0 AND region_height <= 1),
  category TEXT NOT NULL CHECK (category IN ('translation', 'truncation', 'layout', 'other')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  suggested_text TEXT CHECK (suggested_text IS NULL OR length(suggested_text) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'wont_fix')),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  status_changed_by_user_id TEXT REFERENCES users(id),
  status_changed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (id, organization_id),
  CHECK ((region_x IS NULL) = (region_y IS NULL) AND (region_x IS NULL) = (region_width IS NULL) AND (region_x IS NULL) = (region_height IS NULL)),
  CHECK (region_x IS NULL OR (region_x + region_width <= 1.000001 AND region_y + region_height <= 1.000001)),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX screen_comments_project_status ON screen_comments(organization_id, project_id, status, created_at DESC, id DESC);
CREATE INDEX screen_comments_project_screen ON screen_comments(organization_id, project_id, screenshot_name);

CREATE TABLE screen_comment_replies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (comment_id, organization_id) REFERENCES screen_comments(id, organization_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX screen_comment_replies_comment ON screen_comment_replies(organization_id, comment_id, created_at);
