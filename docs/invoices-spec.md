# Contractor invoices and accounting export (design)

Status: proposed. Nothing here is built yet.

## Scope in one paragraph
The system **records** invoices (bills) that contractors send for work, lets a person check and approve them against
work orders, and **exports** approved invoices to the organisation's accounting system. **It never moves money.** There
is no payment processing, no bank or card integration, and no payment instructions. "Paid" is a status that records what
the accounting system says; it is set by hand or by importing a payment/remittance file, and it changes nothing outside
this system. This must be stated in the UI wherever "Paid" appears.

## How invoices come in
All routes end in the same `invoice` record in status `received`, tagged with how it arrived (`source`).
1. **Keyed in** by a user, optionally linked to work orders.
2. **File attached**: PDF, Word, Excel or image uploaded against a contractor/contract. Word and PDF are stored as
   attachments only and flagged "needs data entry" (they cannot be read reliably); a person keys the figures in.
3. **Spreadsheet import**: CSV or Excel with a documented column layout (one row per invoice line). Rows are validated
   and previewed before anything is created, and re-importing the same file creates nothing new (see Idempotency).
4. **API**: `POST /api/inbound/invoices` for a contractor's own system (including a Xero/MYOB export or a script), using
   a per-contractor API key with a deliberately narrow scope: it can submit invoices for that contractor's own
   contracts and read the status of its own submissions, nothing else. Same JSON shape as the neutral model below.

Direct pull from a contractor's Xero/MYOB (OAuth) is out of scope for now; those users export a file or call the API.

## Model
- **invoice**: organisation, client, contractor, optional contract, `supplier_ref` (the contractor's invoice number),
  issue date, due date, currency, `net`, `tax`, `gross`, status, `source`, `external_id` (idempotency key), notes.
  Unique per (contractor, supplier_ref) among live rows, so the same invoice cannot be recorded twice.
- **invoice_line**: description, quantity, unit price, net, tax code, tax amount, optional `work_order_id`,
  optional account code override.
- **invoice_attachment**: file name, content type, size, storage key, checksum. Files live in object storage / a
  configured directory, never in the database. Size and type limits; virus scanning is a deployment concern.
- **tax_code** (per organisation): code, name, rate, and the code each accounting system expects. Tax is data, not
  hard-coded GST: NZ 15%, AU 10%, zero-rated and exempt are rows, so other regimes work without code changes.
- **account_mapping** (per client or organisation): what each work-order category / contract maps to in the chart of
  accounts, plus a default account and tracking category/cost centre. This is what makes an export usable.
- **export_batch** and **export_batch_invoice**: every export is recorded (who, when, system, format, file checksum,
  which invoices). An invoice in a batch is marked `exported` and is not exported again unless the batch is voided.

All new tables follow the existing rules: organisation/client scoping with row level security, composite foreign
keys, soft delete only, no DELETE for the application role, audit entries. Amounts are `numeric`, with line sums
checked against header totals (tolerance of one cent per line for rounding, otherwise rejected).

## Status flow
`received` → `approved` → `exported` → `paid`, and `disputed` / `rejected` branches. Approval needs a role
(`org_admin`, `asset_manager`) and records who and when. Approving requires the invoice to match its work orders
(see below) or an explicit override with a reason. `paid` is informational. Reopening and un-exporting are allowed
and audited; nothing is deleted.

## Matching to work orders
An invoice line can reference a work order. Checks, shown to the approver as warnings with a clear override:
- the work order belongs to the same contractor and client;
- the work order is `complete` (or the invoice is flagged as a progress claim);
- total invoiced against a work order does not exceed its estimated cost by more than a configurable tolerance;
- the same work order is not invoiced twice.
Work-order actual cost is set from the approved invoice if it was empty.

## Export
One neutral internal representation (`ExportInvoice`: header, lines, resolved tax code and account per line), and one
small **adapter** per target that turns a list of them into a file. Adapters are pure functions with golden-file tests.
First adapters:
| Adapter | Output |
|---|---|
| `generic-csv` | One row per line, every field, documented headers. The fallback for anything else. |
| `xero-bills` | Xero's "Bills" import CSV (ContactName, InvoiceNumber, InvoiceDate, DueDate, Description, Quantity, UnitAmount, AccountCode, TaxType, TrackingName/Option, Currency). |
| `myob` | MYOB AccountRight purchase-bill import (text file, tab delimited, item/service layout). |
| `sap-csv` | A flat file for SAP FI vendor-invoice posting (company code, vendor, document date, posting date, reference, GL account, tax code, amount, cost centre). SAP sites differ, so field order and constants come from a per-organisation template. |
Each adapter declares the mappings it needs (for example Xero tax type names), and export refuses with a list of what
is missing rather than producing a file the accounting system will reject. The exact column layouts must be checked
against each vendor's current import documentation before the adapter is considered done.
New systems are added by implementing the adapter interface and registering it. No other code changes.

## Idempotency and safety
- Inbound API and import: `external_id` or (contractor, supplier_ref) makes repeats a no-op that returns the existing
  invoice. Concurrent duplicates are resolved by the unique index, not by application checks.
- Exports are batches: generating one locks the selected invoices and marks them in the same transaction, so two people
  clicking Export cannot export the same invoice twice.
- API keys are stored hashed, shown once, revocable, rate limited, and every call is audited.
- Uploaded files are untrusted: content type is checked by sniffing, names are never used as paths, and files are served
  with `Content-Disposition: attachment`.

## Open questions
1. Does a consultancy ever need to invoice its **clients** (accounts receivable)? Assumed no for this slice.
2. Which accounting systems do the first real users run? That sets adapter order; the four above are the proposal.
3. Tax: is the contractor's stated tax trusted, or recalculated from tax codes and flagged on mismatch? Proposed: trust
   the stated figures, flag mismatches over a tolerance.
4. Contractor portal (login) versus API-key only for the first release. Proposed: API key only; portal later.

## Build order
1. Migration, model, tax codes, account mappings, keyed-in invoices with approval and work-order matching, UI.
2. Attachments.
3. Export batches with `generic-csv` and `xero-bills`; then `myob` and `sap-csv`.
4. Spreadsheet import with preview.
5. Inbound API with per-contractor keys.
