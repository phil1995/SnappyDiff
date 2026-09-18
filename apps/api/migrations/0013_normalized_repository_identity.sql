CREATE UNIQUE INDEX projects_tenant_repository_normalized
  ON projects(organization_id, lower(repository_owner), lower(repository_name));
