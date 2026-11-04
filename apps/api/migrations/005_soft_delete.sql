-- Soft delete: rows are never removed by the application, so history is retained.
--  * deleted_at / deleted_by mark a deleted row. Deleting a parent also marks its children with the SAME
--    deleted_at (one transaction, one now()), so a restore can bring back exactly what was deleted with it.
--  * Row level security hides deleted rows unless the request sets app.include_deleted = 'on' (the admin Trash/restore).
--  * The app role loses DELETE on the data tables (and UPDATE/DELETE on audit_log), so even a bug cannot hard-delete.
--  * Codes can be reused after a delete: uniqueness now applies to live rows only.

ALTER TABLE client            ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid;
ALTER TABLE region            ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid;
ALTER TABLE site              ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid;
ALTER TABLE asset_type        ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid;
ALTER TABLE asset             ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid;
ALTER TABLE forecast_scenario ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid;

-- What changed on an update (old -> new) or what a delete/restore touched.
ALTER TABLE audit_log ADD COLUMN details jsonb;

-- Replace the unique constraints on code (found by columns, not by guessed names) with live-row-only unique indexes.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conrelid::regclass AS tbl, conname
      FROM pg_constraint c
     WHERE contype = 'u'
       AND conrelid IN ('client'::regclass, 'site'::regclass, 'region'::regclass)
       AND (SELECT array_agg(attname::text) FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = ANY (c.conkey)) @> ARRAY['code']
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX client_code_live ON client (organisation_id, code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX site_code_live   ON site   (organisation_id, client_id, code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX region_code_live ON region (organisation_id, client_id, code) WHERE deleted_at IS NULL;

CREATE FUNCTION app_include_deleted() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT COALESCE(current_setting('app.include_deleted', true), '') = 'on' $$;

-- Hide deleted rows. USING (old row / reads) hides them; WITH CHECK (new row) does not, otherwise the UPDATE
-- that sets deleted_at would be rejected.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['region', 'site', 'asset_type', 'asset', 'forecast_scenario']
  LOOP
    EXECUTE format('DROP POLICY tenant ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant ON %I
         USING (organisation_id = app_org() AND app_client_ok(client_id) AND (deleted_at IS NULL OR app_include_deleted()))
         WITH CHECK (organisation_id = app_org() AND app_client_ok(client_id))', t);
  END LOOP;
END $$;

DROP POLICY tenant ON client;
CREATE POLICY tenant ON client
  USING (organisation_id = app_org() AND app_client_ok(id) AND (deleted_at IS NULL OR app_include_deleted()))
  WITH CHECK (organisation_id = app_org());

-- No hard deletes from the application role.
REVOKE DELETE ON client, region, site, asset_type, asset, inspection, assessment, forecast_scenario FROM ace_app;
REVOKE UPDATE, DELETE ON audit_log FROM ace_app;
