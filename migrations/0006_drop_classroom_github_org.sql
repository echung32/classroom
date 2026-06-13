-- Single-org deployment: the org is resolved from the GitHub App installation,
-- never stored. Drop the unused, never-validated per-classroom column.
ALTER TABLE classrooms DROP COLUMN github_org;
