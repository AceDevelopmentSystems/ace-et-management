import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { TokenClaims } from './auth';
import { Claims, DB, Roles, WRITERS, audit, auditUpdate, guarded, parse, patchRow, tenant } from './common';
import { Database, Queryable } from './db';
import { today } from './generate';
import { invoiceCreate, invoicePatch, invoiceQuery, invoiceStatusChange, taxCodeCreate, taxCodePatch } from './schemas';

/**
 * Invoices are RECORDED here, never paid: `paid` mirrors what the accounting system says.
 *
 * Writes that replace lines run with includeDeleted (old lines are soft-deleted, and PostgreSQL checks the new row of an
 * UPDATE against the read policy, see trash.ts), so every query in this file filters `deleted_at IS NULL` explicitly.
 */
/** How far over a work order's estimate (all invoices together) before approval warns. A fixed 10% until it is configurable. */
export const OVER_ESTIMATE_TOLERANCE = 0.10;

// ---------------------------------------------------------------- money (integer cents, so sums never drift)
const toCents = (n: number) => Math.round(Number(n.toFixed(6)) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);

interface PricedLine {
  description: string; quantity: number; unitPrice: number; netC: number; taxC: number;
  taxCodeId: string | null; workOrderId: string | null; accountCode: string | null;
}

/** Net is quantity x unit price. Tax is the stated amount, else the tax code's rate applied to the net, else nothing. */
async function priceLines(q: Queryable, clientId: string, lines: ReturnType<typeof invoiceCreate.parse>['lines']): Promise<PricedLine[]> {
  const taxIds = [...new Set(lines.map((l) => l.taxCodeId).filter((x): x is string => !!x))];
  const rates = new Map<string, number>();
  if (taxIds.length) {
    for (const r of (await q.query<{ id: string; rate: string }>('SELECT id, rate FROM tax_code WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [taxIds])).rows) rates.set(r.id, Number(r.rate));
    const missing = taxIds.find((id) => !rates.has(id));
    if (missing) throw new BadRequestException('taxCodeId does not exist');
  }
  const woIds = [...new Set(lines.map((l) => l.workOrderId).filter((x): x is string => !!x))];
  if (woIds.length) {
    const found = (await q.query<{ id: string }>('SELECT id FROM work_order WHERE id = ANY($1::uuid[]) AND client_id = $2 AND deleted_at IS NULL', [woIds, clientId])).rows.map((r) => r.id);
    if (woIds.some((id) => !found.includes(id))) throw new BadRequestException('workOrderId does not exist for this client');
  }
  return lines.map((l) => {
    const netC = toCents(l.quantity * l.unitPrice);
    const taxC = l.taxAmount != null ? toCents(l.taxAmount) : l.taxCodeId ? Math.round(netC * rates.get(l.taxCodeId)! / 100) : 0;
    return {
      description: l.description.trim(), quantity: l.quantity, unitPrice: l.unitPrice, netC, taxC,
      taxCodeId: l.taxCodeId ?? null, workOrderId: l.workOrderId ?? null, accountCode: l.accountCode?.trim() || null,
    };
  });
}

async function insertLines(q: Queryable, c: TokenClaims, clientId: string, invoiceId: string, lines: PricedLine[]) {
  let pos = 1;
  for (const l of lines) {
    await q.query(
      `INSERT INTO invoice_line (organisation_id, client_id, invoice_id, position, description, quantity, unit_price, net, tax_code_id, tax_amount, work_order_id, account_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [c.org, clientId, invoiceId, pos++, l.description, l.quantity, l.unitPrice, fromCents(l.netC), l.taxCodeId, fromCents(l.taxC), l.workOrderId, l.accountCode]);
  }
}

const totals = (lines: PricedLine[]) => {
  const net = lines.reduce((s, l) => s + l.netC, 0), tax = lines.reduce((s, l) => s + l.taxC, 0);
  return { net: fromCents(net), tax: fromCents(tax), gross: fromCents(net + tax) };
};

/** Contractor and contract must be live, belong to the right place, and agree with each other. */
async function checkParties(q: Queryable, clientId: string, contractorId: string, contractId: string | null | undefined) {
  if (!(await q.query('SELECT 1 FROM contractor WHERE id = $1 AND deleted_at IS NULL', [contractorId])).rows.length) throw new BadRequestException('contractorId does not exist');
  if (contractId) {
    const k = (await q.query<{ contractor_id: string }>('SELECT contractor_id FROM contract WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL', [contractId, clientId])).rows[0];
    if (!k) throw new BadRequestException('contractId does not exist for this client');
    if (k.contractor_id !== contractorId) throw new BadRequestException('That contract belongs to a different contractor');
  }
}

// ---------------------------------------------------------------- matching against work orders
export interface Warning { code: string; message: string; lineId?: string; workOrderId?: string }

/** What an approver should look at before approving. Warnings never block by themselves; approving past them needs a reason. */
export async function matchWarnings(q: Queryable, invoiceId: string): Promise<Warning[]> {
  const inv = (await q.query<{ contractor_id: string; contract_id: string | null }>('SELECT contractor_id, contract_id FROM invoice WHERE id = $1 AND deleted_at IS NULL', [invoiceId])).rows[0];
  if (!inv) throw new NotFoundException('Invoice not found');
  const rows = (await q.query<{
    line_id: string; wo_id: string; code: string; status: string; contractor_id: string | null; contract_id: string | null; estimated: string | null; net: string;
  }>(
    `SELECT l.id AS line_id, w.id AS wo_id, COALESCE(k.code || '-' || lpad(w.number::text, 4, '0'), 'WO-' || lpad(w.number::text, 4, '0')) AS code,
            w.status, w.contractor_id, w.contract_id, w.estimated_cost AS estimated, l.net
       FROM invoice_line l JOIN work_order w ON w.id = l.work_order_id AND w.deleted_at IS NULL LEFT JOIN contract k ON k.id = w.contract_id
      WHERE l.invoice_id = $1 AND l.deleted_at IS NULL ORDER BY l.position`, [invoiceId])).rows;
  if (!rows.length) return [];
  const woIds = [...new Set(rows.map((r) => r.wo_id))];
  const others = (await q.query<{ wo_id: string; ref: string; net: string }>(
    `SELECT l.work_order_id AS wo_id, i.supplier_ref AS ref, l.net
       FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id
      WHERE l.work_order_id = ANY($1::uuid[]) AND l.deleted_at IS NULL AND i.deleted_at IS NULL AND i.id <> $2 AND i.status <> 'rejected'`, [woIds, invoiceId])).rows;

  const warnings: Warning[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const w = (code: string, message: string) => warnings.push({ code, message, lineId: r.line_id, workOrderId: r.wo_id });
    if (r.contractor_id && r.contractor_id !== inv.contractor_id) w('wo_contractor', `${r.code} is assigned to a different contractor.`);
    if (inv.contract_id && r.contract_id && r.contract_id !== inv.contract_id) w('wo_contract', `${r.code} is on a different contract from this invoice.`);
    if (r.status !== 'complete') w('wo_not_complete', `${r.code} is ${r.status.replace('_', ' ')}, not complete.`);
    if (seen.has(r.wo_id)) continue; // totals below are per work order, so say them once
    seen.add(r.wo_id);
    const mine = rows.filter((x) => x.wo_id === r.wo_id).reduce((s, x) => s + toCents(Number(x.net)), 0);
    const elsewhere = others.filter((o) => o.wo_id === r.wo_id);
    if (elsewhere.length) w('wo_already_invoiced', `${r.code} is also on invoice ${[...new Set(elsewhere.map((o) => o.ref))].join(', ')}.`);
    if (r.estimated != null) {
      const total = mine + elsewhere.reduce((s, o) => s + toCents(Number(o.net)), 0);
      if (total > toCents(Number(r.estimated)) * (1 + OVER_ESTIMATE_TOLERANCE)) {
        w('wo_over_estimate', `${r.code} is invoiced at ${fromCents(total)} against an estimate of ${Number(r.estimated).toFixed(2)}.`);
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------- status flow
// "exported" is set by an accounting export batch, never by hand. "paid" only records what the accounting system reports.
const STATUS_FLOW: Record<string, string[]> = {
  received: ['approved', 'disputed', 'rejected'],
  disputed: ['received', 'rejected'],
  rejected: ['received'],
  approved: ['received', 'paid'],
  exported: ['paid'],
  paid: ['approved'],   // undo a mistaken "paid"; once exports exist this will go back to exported for exported invoices
};
const EDITABLE = ['received', 'disputed'];

const INVOICE_COLS = `i.id, i.client_id, i.contractor_id, r.name AS contractor_name, i.contract_id, k.code AS contract_code, i.supplier_ref,
  i.issue_date::text AS issue_date, i.due_date::text AS due_date, i.currency, i.net, i.tax, i.gross, i.status, i.source, i.notes,
  i.approved_at, i.override_reason, i.paid_on::text AS paid_on, i.created_at`;
const INVOICE_FROM = 'FROM invoice i JOIN contractor r ON r.id = i.contractor_id LEFT JOIN contract k ON k.id = i.contract_id';

// ---------------------------------------------------------------- controllers
@Controller()
export class TaxCodesController {
  constructor(@Inject(DB) private db: Database) {}

  @Get('tax-codes')
  list(@Claims() c: TokenClaims) {
    return this.db.withTenant(tenant(c), async (q) => (await q.query(
      `SELECT id, code, name, rate, external_codes FROM tax_code ORDER BY lower(code)`)).rows);
  }

  @Post('tax-codes') @Roles(...WRITERS)
  create(@Claims() c: TokenClaims, @Body() body: unknown) {
    const b = parse(taxCodeCreate, body);
    for (const f of ['code', 'name', 'rate'] as const) if (b[f] === undefined) throw new BadRequestException(`${f} is required`);
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      const row = (await q.query<{ id: string }>(
        'INSERT INTO tax_code (organisation_id, code, name, rate, external_codes) VALUES ($1,$2,$3,$4,$5) RETURNING id, code, name, rate, external_codes',
        [c.org, b.code!.trim(), b.name!.trim(), b.rate, b.externalCodes ?? {}])).rows[0]!;
      await audit(q, c, 'create', 'tax_code', row.id, null);
      return row;
    }, { unique: 'A tax code with this code already exists' }));
  }

  /** Changing a rate does not rewrite invoices already recorded: their tax amounts are stored. */
  @Patch('tax-codes/:id') @Roles(...WRITERS)
  patch(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(taxCodePatch, body);
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      const { row, changes } = await patchRow(q, 'tax_code', id, {
        code: b.code?.trim(), name: b.name?.trim(), rate: b.rate, external_codes: b.externalCodes,
      }, 'id, code, name, rate, external_codes');
      await auditUpdate(q, c, 'tax_code', id, null, changes);
      return row;
    }, { unique: 'A tax code with this code already exists' }));
  }
}

@Controller()
export class InvoicesController {
  constructor(@Inject(DB) private db: Database) {}

  @Get('clients/:clientId/invoices')
  list(@Claims() c: TokenClaims, @Param('clientId') clientId: string, @Query() query: unknown) {
    const f = parse(invoiceQuery, query);
    const where = ['i.client_id = $1'];
    const params: unknown[] = [clientId];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (f.status) add('i.status = ?', f.status);
    if (f.contractorId) add('i.contractor_id = ?', f.contractorId);
    if (f.contractId) add('i.contract_id = ?', f.contractId);
    if (f.from) add('i.issue_date >= ?::date', f.from);
    if (f.to) add('i.issue_date <= ?::date', f.to);
    return this.db.withTenant(tenant(c), async (q) => {
      const sum = (await q.query<{ n: string; gross: string | null }>(`SELECT count(*) AS n, sum(i.gross) AS gross FROM invoice i WHERE ${where.join(' AND ')}`, params)).rows[0]!;
      const items = (await q.query(
        `SELECT ${INVOICE_COLS}, (SELECT count(*)::int FROM invoice_line l WHERE l.invoice_id = i.id) AS line_count
           ${INVOICE_FROM} WHERE ${where.join(' AND ')} ORDER BY i.issue_date DESC, i.supplier_ref LIMIT ${f.limit} OFFSET ${f.offset}`, params)).rows;
      return { items, total: Number(sum.n), grossTotal: sum.gross ?? '0.00' };
    });
  }

  @Post('clients/:clientId/invoices') @Roles(...WRITERS)
  create(@Claims() c: TokenClaims, @Param('clientId') clientId: string, @Body() body: unknown) {
    const b = parse(invoiceCreate, body);
    for (const f of ['contractorId', 'supplierRef', 'issueDate', 'lines'] as const) if (!b[f]) throw new BadRequestException(`${f} is required`);
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      const client = (await q.query<{ currency: string }>('SELECT currency FROM client WHERE id = $1', [clientId])).rows[0];
      if (!client) throw new NotFoundException('Client not found');
      await checkParties(q, clientId, b.contractorId!, b.contractId);
      const lines = await priceLines(q, clientId, b.lines!);
      const row = (await q.query<{ id: string }>(
        `INSERT INTO invoice (organisation_id, client_id, contractor_id, contract_id, supplier_ref, issue_date, due_date, currency, net, tax, gross, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, supplier_ref, status, net, tax, gross`,
        [c.org, clientId, b.contractorId, b.contractId ?? null, b.supplierRef!.trim(), b.issueDate, b.dueDate ?? null, (b.currency ?? client.currency).toUpperCase(),
          totals(lines).net, totals(lines).tax, totals(lines).gross, b.notes ?? null])).rows[0]!;
      await insertLines(q, c, clientId, row.id, lines);
      await audit(q, c, 'create', 'invoice', row.id, clientId, { source: 'keyed', lines: lines.length });
      return row;
    }, { unique: 'This contractor already has an invoice with that number', fk: 'A referenced record does not exist' }));
  }

  @Get('invoices/:id')
  get(@Claims() c: TokenClaims, @Param('id') id: string) {
    return this.db.withTenant(tenant(c), async (q) => {
      const invoice = (await q.query(`SELECT ${INVOICE_COLS} ${INVOICE_FROM} WHERE i.id = $1`, [id])).rows[0];
      if (!invoice) throw new NotFoundException('Invoice not found');
      const lines = (await q.query(
        `SELECT l.id, l.position, l.description, l.quantity, l.unit_price, l.net, l.tax_code_id, t.code AS tax_code, l.tax_amount, l.work_order_id, l.account_code,
                COALESCE(k.code || '-' || lpad(w.number::text, 4, '0'), 'WO-' || lpad(w.number::text, 4, '0')) AS work_order_code
           FROM invoice_line l LEFT JOIN tax_code t ON t.id = l.tax_code_id LEFT JOIN work_order w ON w.id = l.work_order_id LEFT JOIN contract k ON k.id = w.contract_id
          WHERE l.invoice_id = $1 ORDER BY l.position`, [id])).rows;
      return { ...invoice, lines, warnings: await matchWarnings(q, id) };
    });
  }

  /** Header fields and/or the whole set of lines. Only a received or disputed invoice can be edited. */
  @Patch('invoices/:id') @Roles(...WRITERS)
  patch(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(invoicePatch, body);
    return this.db.withTenant({ ...tenant(c), includeDeleted: true }, (q) => guarded(async () => {
      const cur = (await q.query<{ client_id: string; status: string; contractor_id: string; contract_id: string | null }>(
        'SELECT client_id, status, contractor_id, contract_id FROM invoice WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!cur) throw new NotFoundException('Invoice not found');
      if (!EDITABLE.includes(cur.status)) throw new ConflictException(`${/^[aeiou]/.test(cur.status) ? 'An' : 'A'} ${cur.status} invoice cannot be edited. Reopen it first.`);
      const contractorId = b.contractorId ?? cur.contractor_id;
      const contractId = b.contractId === undefined ? cur.contract_id : b.contractId;
      await checkParties(q, cur.client_id, contractorId, contractId);

      let money: Record<string, string> = {};
      if (b.lines) {
        const lines = await priceLines(q, cur.client_id, b.lines);
        await q.query('UPDATE invoice_line SET deleted_at = now(), deleted_by = $2 WHERE invoice_id = $1 AND deleted_at IS NULL', [id, c.sub]);
        await insertLines(q, c, cur.client_id, id, lines);
        money = totals(lines);
      }
      const { row, changes } = await patchRow(q, 'invoice', id, {
        contractor_id: b.contractorId, contract_id: b.contractId, supplier_ref: b.supplierRef?.trim(), issue_date: b.issueDate, due_date: b.dueDate,
        currency: b.currency?.toUpperCase(), notes: b.notes, ...money,
      }, 'id, supplier_ref, status, net, tax, gross');
      await auditUpdate(q, c, 'invoice', id, cur.client_id, b.lines ? { ...changes, lines: { from: 'previous', to: `${b.lines.length} lines` } } : changes);
      return row;
    }, { unique: 'This contractor already has an invoice with that number', fk: 'A referenced record does not exist' }));
  }

  /**
   * Approve, dispute, reject, reopen, or record it as paid. Approving checks the invoice against its work orders: any
   * warnings must be acknowledged with `override: true` and a `reason`, which is kept on the invoice.
   * Marking paid records what the accounting system reports. It moves no money.
   */
  @Post('invoices/:id/status') @Roles(...WRITERS)
  setStatus(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(invoiceStatusChange, body);
    if (b.status === 'exported') throw new BadRequestException('An invoice is marked exported by an accounting export, not by hand.');
    if (b.paidOn && b.paidOn > today()) throw new BadRequestException('paidOn cannot be in the future');
    return this.db.withTenant({ ...tenant(c), includeDeleted: true }, async (q) => {
      const cur = (await q.query<{ client_id: string; status: string; issue_date: string }>(
        'SELECT client_id, status, issue_date::text AS issue_date FROM invoice WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!cur) throw new NotFoundException('Invoice not found');
      if (cur.status === b.status) throw new ConflictException(`Invoice is already ${b.status}`);
      if (!STATUS_FLOW[cur.status]!.includes(b.status)) throw new ConflictException(`A ${cur.status} invoice cannot be changed to ${b.status}`);
      if (b.status === 'paid' && (b.paidOn ?? today()) < cur.issue_date) throw new BadRequestException('paidOn cannot be before the invoice date');

      const set: Record<string, unknown> = { status: b.status };
      let extra: Record<string, unknown> = {};
      if (b.status === 'approved') {
        const warnings = await matchWarnings(q, id);
        if (warnings.length && !(b.override && b.reason)) {
          throw new ConflictException({ statusCode: 409, message: 'This invoice does not cleanly match its work orders. Approve anyway with override and a reason.', warnings });
        }
        set.approved_by = c.sub; set.approved_at = new Date().toISOString();
        set.override_reason = warnings.length ? b.reason : null;
        // The first approved invoice fixes a work order's actual cost if nobody has recorded one.
        const filled = await q.query(
          `UPDATE work_order w SET actual_cost = s.total
             FROM (SELECT work_order_id, sum(net) AS total FROM invoice_line WHERE invoice_id = $1 AND deleted_at IS NULL AND work_order_id IS NOT NULL GROUP BY 1) s
            WHERE w.id = s.work_order_id AND w.actual_cost IS NULL AND w.deleted_at IS NULL RETURNING w.id`, [id]);
        if (filled.rows.length) extra = { workOrderActualCostsSet: filled.rows.length };
        if (warnings.length) extra = { ...extra, overrodeWarnings: warnings.map((w) => w.code), reason: b.reason };
      } else if (b.status === 'paid') {
        set.paid_on = b.paidOn ?? today();
      } else if (b.status === 'rejected' || b.status === 'disputed') {
        if (!b.reason) throw new BadRequestException(`A reason is required to mark an invoice ${b.status}`);
        extra = { reason: b.reason };
      }
      if (b.status !== 'approved') { set.approved_by = null; set.approved_at = null; set.override_reason = null; }
      if (b.status !== 'paid') set.paid_on = null;
      if (b.status === 'received' && cur.status === 'approved') extra = { reopened: true };

      const { row, changes } = await patchRow(q, 'invoice', id, set, 'id, status, paid_on::text AS paid_on');
      await audit(q, c, 'update', 'invoice', id, cur.client_id, { changes, ...extra });
      return row;
    });
  }
}
