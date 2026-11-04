-- Core schema: tenancy, register, assessments, forecast scenarios.
-- Tenancy: organisation -> client -> everything else. Every tenant table carries
-- organisation_id and client_id; composite foreign keys stop cross-tenant references
-- (FK checks bypass RLS), and row level security enforces isolation on read/write.

-- gen_random_uuid() is built in from PostgreSQL 13.

CREATE TABLE organisation (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('OWNER', 'CONSULTANCY')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE membership (
  user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('org_admin','asset_manager','assessor','client_viewer','contractor')),
  PRIMARY KEY (user_id, organisation_id)
);

CREATE TABLE client (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  name            text NOT NULL,
  code            text,
  currency        text NOT NULL DEFAULT 'NZD',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, code)
);

-- Restricts a membership to specific clients (e.g. a client_viewer). No rows = all clients in the org.
CREATE TABLE client_grant (
  user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL,
  client_id       uuid NOT NULL,
  PRIMARY KEY (user_id, client_id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES client (organisation_id, id) ON DELETE CASCADE
);

CREATE TABLE region (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  client_id       uuid NOT NULL,
  name            text NOT NULL,
  UNIQUE (organisation_id, client_id, id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES client (organisation_id, id) ON DELETE CASCADE
);

CREATE TABLE site (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  client_id       uuid NOT NULL,
  region_id       uuid,
  code            text NOT NULL,
  name            text NOT NULL,
  site_class      text,
  address         text,
  latitude        numeric(9,6),
  longitude       numeric(9,6),
  hazards         text,
  attributes      jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, client_id, id),
  UNIQUE (organisation_id, client_id, code),
  FOREIGN KEY (organisation_id, client_id) REFERENCES client (organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, client_id, region_id) REFERENCES region (organisation_id, client_id, id)
);

CREATE TABLE asset_type (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL,
  client_id           uuid NOT NULL,
  parent_id           uuid,                 -- sub-types point at their type
  name                text NOT NULL,
  expected_life_years int  CHECK (expected_life_years > 0),
  unit                text,
  unit_rate           numeric(14,2) CHECK (unit_rate >= 0),
  UNIQUE (organisation_id, client_id, id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES client (organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, client_id, parent_id) REFERENCES asset_type (organisation_id, client_id, id)
);

CREATE TABLE asset (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL,
  client_id           uuid NOT NULL,
  site_id             uuid NOT NULL,
  parent_id           uuid,
  asset_type_id       uuid,
  name                text NOT NULL,
  manufacturer        text,
  serial_number       text,
  install_date        date,
  quantity            numeric(14,3) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit                text,
  unit_rate           numeric(14,2) CHECK (unit_rate >= 0),
  expected_life_years int CHECK (expected_life_years > 0),
  criticality         int CHECK (criticality BETWEEN 1 AND 5),
  attributes          jsonb NOT NULL DEFAULT '{}',   -- replaces the legacy EAV tables
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, client_id, id),
  FOREIGN KEY (organisation_id, client_id, site_id) REFERENCES site (organisation_id, client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, client_id, parent_id) REFERENCES asset (organisation_id, client_id, id),
  FOREIGN KEY (organisation_id, client_id, asset_type_id) REFERENCES asset_type (organisation_id, client_id, id)
);
CREATE INDEX asset_site_idx ON asset (site_id);
CREATE INDEX asset_parent_idx ON asset (parent_id);

CREATE TABLE inspection (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  client_id       uuid NOT NULL,
  site_id         uuid NOT NULL,
  inspected_on    date NOT NULL,
  inspector       text,
  notes           text,
  UNIQUE (organisation_id, client_id, id),
  FOREIGN KEY (organisation_id, client_id, site_id) REFERENCES site (organisation_id, client_id, id) ON DELETE CASCADE
);

-- One row per asset per inspection. Condition is a split across grades (percent sums to 100 or 0 = unassessed),
-- each grade with its own remaining life, as in the legacy asset_assessment table.
CREATE TABLE assessment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL,
  client_id           uuid NOT NULL,
  inspection_id       uuid NOT NULL,
  asset_id            uuid NOT NULL,
  conditions          jsonb NOT NULL,      -- {"good":{"percent":70,"remainingLife":5}, ...}
  quality_confidence  char(1) NOT NULL DEFAULT 'A' CHECK (quality_confidence IN ('A','B','C')),
  quantity_confidence char(1) NOT NULL DEFAULT 'A' CHECK (quantity_confidence IN ('A','B','C')),
  assessed_quantity   numeric(14,3),
  maintenance_cost    numeric(14,2),
  comments            text,
  UNIQUE (inspection_id, asset_id),
  FOREIGN KEY (organisation_id, client_id, inspection_id) REFERENCES inspection (organisation_id, client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, client_id, asset_id) REFERENCES asset (organisation_id, client_id, id) ON DELETE CASCADE
);

CREATE TABLE forecast_scenario (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  client_id       uuid NOT NULL,
  name            text NOT NULL,
  params          jsonb NOT NULL,           -- Scenario from @ace/forecast
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organisation_id, client_id) REFERENCES client (organisation_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  organisation_id uuid NOT NULL,
  client_id       uuid,
  user_id         uuid,
  action          text NOT NULL,
  entity          text NOT NULL,
  entity_id       uuid,
  at              timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- row level security
-- The API connects as ace_app (no BYPASSRLS, not table owner) and sets, per transaction:
--   app.org_id      = organisation uuid (required)
--   app.client_ids  = comma separated client uuids the user may see (empty = all in org)
CREATE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION app_client_ok(cid uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT COALESCE(NULLIF(current_setting('app.client_ids', true), ''), '') = ''
        OR cid::text = ANY (string_to_array(current_setting('app.client_ids', true), ',')) $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['region','site','asset_type','asset','inspection','assessment','forecast_scenario','client_grant']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant ON %I USING (organisation_id = app_org() AND app_client_ok(client_id))
         WITH CHECK (organisation_id = app_org() AND app_client_ok(client_id))', t);
  END LOOP;
END $$;
-- client_grant has client_id too, so the loop above covers it.

ALTER TABLE client ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON client USING (organisation_id = app_org() AND app_client_ok(id))
  WITH CHECK (organisation_id = app_org());

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON audit_log USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
