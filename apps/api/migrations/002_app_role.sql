-- Runtime role. Created NOLOGIN here; deployment enables login with a secret from the environment:
--   ALTER ROLE ace_app LOGIN PASSWORD '...';   (see deploy/scripts)
-- It is neither superuser, table owner nor BYPASSRLS, so the row level security policies always apply.
--
-- Roles are cluster-wide, so two databases migrating at the same moment (parallel test workers, or several app
-- instances starting together) can both try to create it. "Check, then create" is racy; create and tolerate the loser.
DO $$
BEGIN
  CREATE ROLE ace_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL; -- already exists, or another migration created it a moment ago
END $$;

GRANT USAGE ON SCHEMA public TO ace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ace_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ace_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ace_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ace_app;
