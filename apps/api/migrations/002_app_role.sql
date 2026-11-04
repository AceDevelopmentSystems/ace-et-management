-- Runtime role. Created NOLOGIN here; deployment enables login with a secret from the environment:
--   ALTER ROLE ace_app LOGIN PASSWORD '...';   (see deploy/scripts)
-- It is neither superuser, table owner nor BYPASSRLS, so the row level security policies always apply.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ace_app') THEN
    CREATE ROLE ace_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO ace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ace_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ace_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ace_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ace_app;
