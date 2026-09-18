CREATE TABLE repository_identity_migration_conflicts (
  displaced_project_id TEXT PRIMARY KEY,
  selected_project_id TEXT NOT NULL,
  original_repository_owner TEXT NOT NULL,
  original_repository_name TEXT NOT NULL,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (displaced_project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (selected_project_id) REFERENCES projects(id) ON DELETE CASCADE
) STRICT;

INSERT INTO repository_identity_migration_conflicts
  (displaced_project_id, selected_project_id, original_repository_owner, original_repository_name)
SELECT candidate.id,
       (SELECT selected.id FROM projects selected
         WHERE selected.organization_id = candidate.organization_id
           AND lower(selected.repository_owner) = lower(candidate.repository_owner)
           AND lower(selected.repository_name) = lower(candidate.repository_name)
         ORDER BY (selected.github_repository_id IS NOT NULL) DESC, selected.created_at, selected.id LIMIT 1),
       candidate.repository_owner, candidate.repository_name
  FROM projects candidate
 WHERE candidate.id != (
   SELECT selected.id FROM projects selected
    WHERE selected.organization_id = candidate.organization_id
      AND lower(selected.repository_owner) = lower(candidate.repository_owner)
      AND lower(selected.repository_name) = lower(candidate.repository_name)
    ORDER BY (selected.github_repository_id IS NOT NULL) DESC, selected.created_at, selected.id LIMIT 1
 );

UPDATE projects
   SET repository_name = 'legacy-' || lower(id),
       updated_at = unixepoch()
 WHERE id IN (SELECT displaced_project_id FROM repository_identity_migration_conflicts);

CREATE UNIQUE INDEX projects_tenant_repository_normalized
  ON projects(organization_id, lower(repository_owner), lower(repository_name));
