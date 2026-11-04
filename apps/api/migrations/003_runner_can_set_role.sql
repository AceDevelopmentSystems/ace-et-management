-- The API connects as the schema owner and switches to ace_app per request (SET LOCAL ROLE).
-- On PostgreSQL 16+ a role that creates another role only gets ADMIN OPTION on it, not the right to
-- SET ROLE to it, so grant that explicitly. Superusers are unaffected, so skip them.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT ace_app TO %I', current_user);
  END IF;
END $$;
