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
SELECT installation_id, MIN(organization_id), MIN(account_login)
  FROM github_installations
 GROUP BY installation_id;

UPDATE github_installations
   SET suspended_at = COALESCE(suspended_at, unixepoch()), updated_at = unixepoch()
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
