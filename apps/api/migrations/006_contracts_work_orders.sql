-- Contractors, contracts (with scheduled lines) and work orders.
-- Same conventions as the rest of the schema: organisation_id (and client_id) on every row, composite foreign keys so a
-- row can never point into another tenant, row level security, soft delete (deleted_at/deleted_by), and no DELETE for the
-- app role.

-- A contractor belongs to the organisation (a consultancy shares its contractors across its clients), not to one client.
CREATE TABLE contractor (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  name            text NOT NULL,
  contact_name    text,
  email           text,
  phone           text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  UNIQUE (organisation_id, id)
);
CREATE UNIQUE INDEX contractor_name_live ON contractor (organisation_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE contract (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  client_id       uuid NOT NULL,
  contractor_id   uuid NOT NULL,
  code            text NOT NULL,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  notes           text,
  -- Next work order number for this contract. Generation locks the contract row, so numbers are never reused or raced.
  next_wo_number  int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  CHECK (end_date >= start_date),
  UNIQUE (organisation_id, client_id, id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES client (organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, contractor_id) REFERENCES contractor (organisation_id, id)
);
CREATE UNIQUE INDEX contract_code_live ON contract (organisation_id, client_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX contract_client_idx ON contract (client_id);

-- One scheduled job on a contract: a site or an asset, how often, from when, and what each visit costs.
CREATE TABLE contract_line (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL,
  client_id           uuid NOT NULL,
  contract_id         uuid NOT NULL,
  site_id             uuid,
  asset_id            uuid,
  description         text NOT NULL,
  frequency_interval  int  NOT NULL CHECK (frequency_interval BETWEEN 1 AND 120),
  frequency_unit      text NOT NULL CHECK (frequency_unit IN ('day', 'week', 'month', 'year')),
  first_due_date      date NOT NULL,
  cost_per_occurrence numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost_per_occurrence >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  deleted_by          uuid,
  CHECK (num_nonnulls(site_id, asset_id) = 1),
  UNIQUE (organisation_id, client_id, id),
  FOREIGN KEY (organisation_id, client_id, contract_id) REFERENCES contract (organisation_id, client_id, id) ON DELETE CASCADE,
  -- Cascade on the targets: the application only soft-deletes, so this matters only for the owner-run hard delete of a
  -- whole client (the demo seed's --reset), where PostgreSQL would otherwise try to remove a site before its lines.
  FOREIGN KEY (organisation_id, client_id, site_id) REFERENCES site (organisation_id, client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, client_id, asset_id) REFERENCES asset (organisation_id, client_id, id) ON DELETE CASCADE
);
CREATE INDEX contract_line_contract_idx ON contract_line (contract_id);

CREATE TABLE work_order (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL,
  client_id        uuid NOT NULL,
  contract_id      uuid,                 -- null for ad hoc work orders (not built yet)
  contract_line_id uuid,
  contractor_id    uuid,
  number           int  NOT NULL,        -- per contract; shown as <contract code>-0001
  site_id          uuid NOT NULL,
  asset_id         uuid,
  title            text NOT NULL,
  due_date         date NOT NULL,
  status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'complete', 'cancelled')),
  estimated_cost   numeric(14,2) CHECK (estimated_cost >= 0),
  actual_cost      numeric(14,2) CHECK (actual_cost >= 0),
  completed_on     date,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  deleted_by       uuid,
  CHECK (status <> 'complete' OR completed_on IS NOT NULL),
  UNIQUE (organisation_id, client_id, id),
  -- Generation is idempotent because an occurrence (line + due date) can exist only once, deleted or not: a work order
  -- someone deleted is not silently recreated by the next run.
  UNIQUE (contract_line_id, due_date),
  UNIQUE (contract_id, number),
  FOREIGN KEY (organisation_id, client_id) REFERENCES client (organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, client_id, contract_id) REFERENCES contract (organisation_id, client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, client_id, contract_line_id) REFERENCES contract_line (organisation_id, client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, contractor_id) REFERENCES contractor (organisation_id, id),
  FOREIGN KEY (organisation_id, client_id, site_id) REFERENCES site (organisation_id, client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, client_id, asset_id) REFERENCES asset (organisation_id, client_id, id) ON DELETE CASCADE
);
CREATE INDEX work_order_client_due_idx ON work_order (client_id, due_date);
CREATE INDEX work_order_site_idx ON work_order (site_id);
CREATE INDEX work_order_contract_idx ON work_order (contract_id);

-- Row level security. Deleted rows are hidden unless the request opts in (see 005); USING covers reads and the old row,
-- WITH CHECK the new row.
ALTER TABLE contractor ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON contractor
  USING (organisation_id = app_org() AND (deleted_at IS NULL OR app_include_deleted()))
  WITH CHECK (organisation_id = app_org());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract', 'contract_line', 'work_order']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant ON %I
         USING (organisation_id = app_org() AND app_client_ok(client_id) AND (deleted_at IS NULL OR app_include_deleted()))
         WITH CHECK (organisation_id = app_org() AND app_client_ok(client_id))', t);
  END LOOP;
END $$;

-- Default privileges (see 002) grant DELETE on new tables; take it back. The application never hard-deletes.
REVOKE DELETE ON contractor, contract, contract_line, work_order FROM ace_app;
