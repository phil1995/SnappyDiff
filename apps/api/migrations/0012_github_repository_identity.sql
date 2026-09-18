ALTER TABLE projects ADD COLUMN github_repository_id INTEGER;

CREATE UNIQUE INDEX projects_tenant_github_repository
  ON projects(organization_id, github_repository_id)
  WHERE github_repository_id IS NOT NULL;

CREATE TABLE github_installation_owners (
  installation_id INTEGER PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_login TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

INSERT INTO github_installation_owners (installation_id, organization_id, account_login)
SELECT installation_id, organization_id, MIN(account_login)
  FROM github_installations candidate
 WHERE organization_id = (
   SELECT MIN(owner_candidate.organization_id) FROM github_installations owner_candidate
    WHERE owner_candidate.installation_id = candidate.installation_id
 )
 GROUP BY installation_id, organization_id;

CREATE TABLE github_installation_migration_conflicts (
  installation_id INTEGER NOT NULL,
  displaced_organization_id TEXT NOT NULL,
  selected_organization_id TEXT NOT NULL,
  repository_owner TEXT,
  repository_name TEXT,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

INSERT INTO github_installation_migration_conflicts
  (installation_id, displaced_organization_id, selected_organization_id, repository_owner, repository_name)
SELECT mapping.installation_id, mapping.organization_id, owner.organization_id,
       mapping.repository_owner, mapping.repository_name
  FROM github_installations mapping
  JOIN github_installation_owners owner ON owner.installation_id = mapping.installation_id
 WHERE mapping.organization_id != owner.organization_id;

DELETE FROM github_installations
 WHERE organization_id != (
   SELECT owner.organization_id FROM github_installation_owners owner
    WHERE owner.installation_id = github_installations.installation_id
 );

CREATE TRIGGER github_installation_owner_is_immutable
BEFORE UPDATE OF organization_id ON github_installation_owners
WHEN OLD.organization_id != NEW.organization_id
BEGIN
  SELECT RAISE(ABORT, 'github_installation_already_linked');
END;
