-- Contractor invoices (bills received) and the tax codes they use.
-- This records invoices only. Nothing here pays anyone: `paid` is a status that mirrors the accounting system.
-- Same conventions as 006: organisation_id (and client_id) on every row, composite foreign keys, row level security,
-- soft delete, and no DELETE for the app role.

-- Tax is data, not code: a rate and the names accounting systems know it by (for example {"xero": "INPUT2"}).
CREATE TABLE tax_code (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  rate            numeric(7,4) NOT NULL CHECK (rate >= 0 AND rate <= 100),   -- percent, e.g. 15
  external_codes  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  UNIQUE (organisation_id, id)
);
CREATE UNIQUE INDEX tax_code_live ON tax_code (organisation_id, lower(code)) WHERE deleted_at IS NULL;

CREATE TABLE invoice (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  client_id       uuid NOT NULL,
  contractor_id   uuid NOT NULL,
  contract_id     uuid,
  supplier_ref    text NOT NULL,                   -- the contractor's own invoice number
  issue_date      date NOT NULL,
  due_date        date,
  currency        char(3) NOT NULL,
  net             numeric(14,2) NOT NULL DEFAULT 0,
  tax             numeric(14,2) NOT NULL DEFAULT 0,
  gross           numeric(14,2) NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'approved', 'exported', 'paid', 'disputed', 'rejected')),
  source          text NOT NULL DEFAULT 'keyed' CHECK (source IN ('keyed', 'upload', 'import', 'api')),
  external_id     text,                            -- idempotency key for imports and the API (used from step 4)
  notes           text,
  approved_by     uuid,
  approved_at     timestamptz,
  override_reason text,                            -- why it was approved despite matching warnings
  paid_on         date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  CHECK (gross = net + tax),
  CHECK (due_date IS NULL OR due_date >= issue_date),
  CHECK (status <> 'paid' OR paid_on IS NOT NULL),
  UNIQUE (organisation_id, client_id, id),
  FOREIGN KEY (organisation_id, client_id) REFERENCES client (organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, contractor_id) REFERENCES contractor (organisation_id, id),
  FOREIGN KEY (organisation_id, client_id, contract_id) REFERENCES contract (organisation_id, client_id, id) ON DELETE CASCADE
);
-- The same invoice cannot be recorded twice for a contractor (live rows only, so a deleted one can be re-entered).
CREATE UNIQUE INDEX invoice_supplier_ref_live ON invoice (organisation_id, contractor_id, lower(supplier_ref)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX invoice_external_id_live ON invoice (organisation_id, contractor_id, external_id) WHERE deleted_at IS NULL AND external_id IS NOT NULL;
CREATE INDEX invoice_client_idx ON invoice (client_id, issue_date);

CREATE TABLE invoice_line (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  client_id       uuid NOT NULL,
  invoice_id      uuid NOT NULL,
  position        int  NOT NULL,
  description     text NOT NULL,
  quantity        numeric(14,4) NOT NULL CHECK (quantity > 0),
  unit_price      numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  net             numeric(14,2) NOT NULL,
  tax_code_id     uuid,
  tax_amount      numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  work_order_id   uuid,
  account_code    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  UNIQUE (organisation_id, client_id, id),
  FOREIGN KEY (organisation_id, client_id, invoice_id) REFERENCES invoice (organisation_id, client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, tax_code_id) REFERENCES tax_code (organisation_id, id),
  -- Cascade only matters for the owner-run hard delete of a whole client (the demo seed's --reset); the application never deletes.
  FOREIGN KEY (organisation_id, client_id, work_order_id) REFERENCES work_order (organisation_id, client_id, id) ON DELETE CASCADE
);
CREATE INDEX invoice_line_invoice_idx ON invoice_line (invoice_id);
CREATE INDEX invoice_line_work_order_idx ON invoice_line (work_order_id);

ALTER TABLE tax_code ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON tax_code
  USING (organisation_id = app_org() AND (deleted_at IS NULL OR app_include_deleted()))
  WITH CHECK (organisation_id = app_org());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice', 'invoice_line']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant ON %I
         USING (organisation_id = app_org() AND app_client_ok(client_id) AND (deleted_at IS NULL OR app_include_deleted()))
         WITH CHECK (organisation_id = app_org() AND app_client_ok(client_id))', t);
  END LOOP;
END $$;

REVOKE DELETE ON tax_code, invoice, invoice_line FROM ace_app;
