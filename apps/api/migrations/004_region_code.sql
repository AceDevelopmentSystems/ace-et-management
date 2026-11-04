-- A region gets a code (e.g. the state code NSW) that is unique per client.
-- Nothing exposed regions before this migration, so no rows exist in practice; the backfill keeps NOT NULL safe.
ALTER TABLE region ADD COLUMN code text;
UPDATE region SET code = left(id::text, 8) WHERE code IS NULL;
ALTER TABLE region ALTER COLUMN code SET NOT NULL;
ALTER TABLE region ADD CONSTRAINT region_code_key UNIQUE (organisation_id, client_id, code);

CREATE INDEX site_region_idx ON site (region_id);
