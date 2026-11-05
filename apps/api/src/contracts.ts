import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { TokenClaims } from './auth';
import { Claims, DB, Roles, WRITERS, audit, auditUpdate, clientOf, guarded, parse, patchRow, requireLive, requireLiveContractor, tenant } from './common';
import { Database, Queryable } from './db';
import {
  contractCreate, contractPatch, contractorCreate, contractorPatch, generateSchema, lineCreate, linePatch, statusChange, workOrderPatch, workOrderQuery,
} from './schemas';
import { CONTRACT_COLS, ContractRow, generateWorkOrders, today } from './generate';

// ------------------------------------------------------------------ contractors (organisation-wide)
@Controller()
export class ContractorsController {
  constructor(@Inject(DB) private db: Database) {}

  @Get('contractors')
  list(@Claims() c: TokenClaims) {
    return this.db.withTenant(tenant(c), async (q) => (await q.query(
      `SELECT k.id, k.name, k.contact_name, k.email, k.phone, k.notes,
              (SELECT count(*)::int FROM contract x WHERE x.contractor_id = k.id) AS contract_count
         FROM contractor k ORDER BY lower(k.name)`)).rows);
  }

  @Post('contractors') @Roles(...WRITERS)
  create(@Claims() c: TokenClaims, @Body() body: unknown) {
    const b = parse(contractorCreate, body);
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      const row = (await q.query<{ id: string }>(
        'INSERT INTO contractor (organisation_id, name, contact_name, email, phone, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name',
        [c.org, b.name.trim(), b.contactName ?? null, b.email ?? null, b.phone ?? null, b.notes ?? null])).rows[0]!;
      await audit(q, c, 'create', 'contractor', row.id, null);
      return row;
    }, { unique: 'A contractor with this name already exists' }));
  }

  @Patch('contractors/:id') @Roles(...WRITERS)
  patch(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(contractorPatch, body);
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      const { row, changes } = await patchRow(q, 'contractor', id, {
        name: b.name?.trim(), contact_name: b.contactName, email: b.email, phone: b.phone, notes: b.notes,
      }, 'id, name');
      await auditUpdate(q, c, 'contractor', id, null, changes);
      return row;
    }, { unique: 'A contractor with this name already exists' }));
  }
}

// ------------------------------------------------------------------ contracts and their lines
async function liveContract(q: Queryable, id: string): Promise<ContractRow> {
  const r = (await q.query<ContractRow>(`SELECT ${CONTRACT_COLS} FROM contract WHERE id = $1`, [id])).rows[0];
  if (!r) throw new NotFoundException('Contract not found');
  return r;
}

function firstDueInside(first: string | undefined, c: Pick<ContractRow, 'start_date' | 'end_date'>) {
  if (first && (first < c.start_date || first > c.end_date)) {
    throw new BadRequestException(`firstDueDate must be within the contract (${c.start_date} to ${c.end_date})`);
  }
}

@Controller()
export class ContractsController {
  constructor(@Inject(DB) private db: Database) {}

  @Get('clients/:clientId/contracts')
  list(@Claims() c: TokenClaims, @Param('clientId') clientId: string) {
    return this.db.withTenant(tenant(c), async (q) => (await q.query(
      `SELECT k.id, k.code, k.name, k.status, k.start_date::text AS start_date, k.end_date::text AS end_date, k.contractor_id, r.name AS contractor_name,
              (SELECT count(*)::int FROM contract_line l WHERE l.contract_id = k.id) AS line_count,
              (SELECT count(*)::int FROM work_order w WHERE w.contract_id = k.id AND w.status IN ('new', 'in_progress')) AS open_work_orders
         FROM contract k LEFT JOIN contractor r ON r.id = k.contractor_id
        WHERE k.client_id = $1 ORDER BY lower(k.code)`, [clientId])).rows);
  }

  @Post('clients/:clientId/contracts') @Roles(...WRITERS)
  create(@Claims() c: TokenClaims, @Param('clientId') clientId: string, @Body() body: unknown) {
    const b = parse(contractCreate, body);
    for (const f of ['contractorId', 'code', 'name', 'startDate', 'endDate'] as const) if (!b[f]) throw new BadRequestException(`${f} is required`);
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      if (!(await q.query('SELECT 1 FROM client WHERE id = $1', [clientId])).rows.length) throw new NotFoundException('Client not found');
      await requireLiveContractor(q, b.contractorId);
      const row = (await q.query<{ id: string }>(
        `INSERT INTO contract (organisation_id, client_id, contractor_id, code, name, status, start_date, end_date, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, code, name, status`,
        [c.org, clientId, b.contractorId, b.code!.trim(), b.name!.trim(), b.status ?? 'draft', b.startDate, b.endDate, b.notes ?? null])).rows[0]!;
      await audit(q, c, 'create', 'contract', row.id, clientId);
      return row;
    }, { unique: 'Contract code already in use for this client' }));
  }

  @Get('contracts/:id')
  get(@Claims() c: TokenClaims, @Param('id') id: string) {
    return this.db.withTenant(tenant(c), async (q) => {
      const contract = (await q.query(
        `SELECT k.id, k.client_id, k.code, k.name, k.status, k.start_date::text AS start_date, k.end_date::text AS end_date, k.notes, k.contractor_id, r.name AS contractor_name
           FROM contract k LEFT JOIN contractor r ON r.id = k.contractor_id WHERE k.id = $1`, [id])).rows[0];
      if (!contract) throw new NotFoundException('Contract not found');
      const lines = (await q.query(
        `SELECT l.id, l.description, l.frequency_interval, l.frequency_unit, l.first_due_date::text AS first_due_date, l.cost_per_occurrence,
                l.site_id, l.asset_id, s.code AS site_code, s.name AS site_name, a.name AS asset_name, asite.code AS asset_site_code
           FROM contract_line l LEFT JOIN site s ON s.id = l.site_id LEFT JOIN asset a ON a.id = l.asset_id LEFT JOIN site asite ON asite.id = a.site_id
          WHERE l.contract_id = $1 ORDER BY l.created_at, l.id`, [id])).rows;
      const counts = (await q.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM work_order WHERE contract_id = $1 GROUP BY status', [id])).rows;
      return { ...contract, lines, workOrderCounts: Object.fromEntries(counts.map((r) => [r.status, r.n])) };
    });
  }

  @Patch('contracts/:id') @Roles(...WRITERS)
  patch(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(contractPatch, body);
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      const cur = await liveContract(q, id);
      await requireLiveContractor(q, b.contractorId);
      const start = b.startDate ?? cur.start_date, end = b.endDate ?? cur.end_date;
      if (end < start) throw new BadRequestException('endDate must not be before startDate');
      if (b.startDate || b.endDate) {
        const outside = Number((await q.query<{ n: string }>(
          'SELECT count(*) AS n FROM contract_line WHERE contract_id = $1 AND (first_due_date < $2::date OR first_due_date > $3::date)', [id, start, end])).rows[0]!.n);
        if (outside) throw new BadRequestException(`${outside} line${outside === 1 ? ' starts' : 's start'} outside the new dates. Adjust those lines first.`);
      }
      const { row, changes } = await patchRow(q, 'contract', id, {
        contractor_id: b.contractorId, code: b.code?.trim(), name: b.name?.trim(), status: b.status, start_date: b.startDate, end_date: b.endDate, notes: b.notes,
      }, 'id, code, name, status');
      await auditUpdate(q, c, 'contract', id, cur.client_id, changes);
      return row;
    }, { unique: 'Contract code already in use for this client', fk: 'contractorId does not exist' }));
  }

  @Post('contracts/:id/lines') @Roles(...WRITERS)
  addLine(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(lineCreate, body);
    for (const f of ['description', 'frequencyUnit', 'firstDueDate'] as const) if (!b[f]) throw new BadRequestException(`${f} is required`);
    return this.db.withTenant(tenant(c), async (q) => {
      const contract = await liveContract(q, id);
      firstDueInside(b.firstDueDate, contract);
      await requireLive(q, 'site', b.siteId, contract.client_id, 'siteId');
      await requireLive(q, 'asset', b.assetId, contract.client_id, 'assetId');
      const row = (await q.query<{ id: string }>(
        `INSERT INTO contract_line (organisation_id, client_id, contract_id, site_id, asset_id, description, frequency_interval, frequency_unit, first_due_date, cost_per_occurrence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, description`,
        [c.org, contract.client_id, id, b.siteId ?? null, b.assetId ?? null, b.description!.trim(), b.frequencyInterval ?? 1, b.frequencyUnit, b.firstDueDate, b.costPerOccurrence ?? 0])).rows[0]!;
      await audit(q, c, 'create', 'contract_line', row.id, contract.client_id);
      return row;
    });
  }

  /** Editing a line affects work orders generated from now on; ones already generated are left alone. */
  @Patch('contract-lines/:id') @Roles(...WRITERS)
  patchLine(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(linePatch, body);
    return this.db.withTenant(tenant(c), async (q) => {
      const cur = (await q.query<ContractRow & { client_id: string }>(
        `SELECT k.id, k.client_id, k.contractor_id, k.status, k.start_date::text AS start_date, k.end_date::text AS end_date
           FROM contract_line l JOIN contract k ON k.id = l.contract_id WHERE l.id = $1`, [id])).rows[0];
      if (!cur) throw new NotFoundException('Contract line not found');
      firstDueInside(b.firstDueDate, cur);
      const { row, changes } = await patchRow(q, 'contract_line', id, {
        description: b.description?.trim(), frequency_interval: b.frequencyInterval, frequency_unit: b.frequencyUnit,
        first_due_date: b.firstDueDate, cost_per_occurrence: b.costPerOccurrence,
      }, 'id, description');
      await auditUpdate(q, c, 'contract_line', id, cur.client_id, changes);
      return row;
    });
  }

  /** Create the work orders due in a window; see generateWorkOrders for the guarantees (repeatable, never duplicates). */
  @Post('contracts/:id/generate') @Roles(...WRITERS)
  generate(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(generateSchema, body);
    // includeDeleted so deleted work orders still count as existing and are not recreated (see generate.ts).
    return this.db.withTenant({ ...tenant(c), includeDeleted: true }, (q) => generateWorkOrders(q, c, id, b));
  }
}

// ------------------------------------------------------------------ work orders
const STATUS_FLOW: Record<string, string[]> = {
  new: ['in_progress', 'complete', 'cancelled'],
  in_progress: ['new', 'complete', 'cancelled'],
  complete: ['in_progress'],
  cancelled: ['new'],
};

const WO_SELECT = `
  SELECT w.id, COALESCE(k.code || '-' || lpad(w.number::text, 4, '0'), 'WO-' || lpad(w.number::text, 4, '0')) AS code,
         w.title, w.status, w.due_date::text AS due_date, w.estimated_cost, w.actual_cost, w.completed_on::text AS completed_on, w.notes,
         w.client_id, w.site_id, s.code AS site_code, s.name AS site_name, w.asset_id, a.name AS asset_name,
         w.contract_id, k.code AS contract_code, w.contract_line_id, w.contractor_id, r.name AS contractor_name
    FROM work_order w JOIN site s ON s.id = w.site_id
    LEFT JOIN asset a ON a.id = w.asset_id LEFT JOIN contract k ON k.id = w.contract_id LEFT JOIN contractor r ON r.id = w.contractor_id`;

@Controller()
export class WorkOrdersController {
  constructor(@Inject(DB) private db: Database) {}

  @Get('clients/:clientId/work-orders')
  list(@Claims() c: TokenClaims, @Param('clientId') clientId: string, @Query() query: unknown) {
    const f = parse(workOrderQuery, query);
    const where = ['w.client_id = $1'];
    const params: unknown[] = [clientId];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (f.status) add('w.status = ?', f.status);
    if (f.siteId) add('w.site_id = ?', f.siteId);
    if (f.contractId) add('w.contract_id = ?', f.contractId);
    if (f.from) add('w.due_date >= ?::date', f.from);
    if (f.to) add('w.due_date <= ?::date', f.to);
    if (f.overdue === 'true') { add('w.due_date < ?::date', today()); where.push(`w.status IN ('new', 'in_progress')`); }
    return this.db.withTenant(tenant(c), async (q) => {
      const total = Number((await q.query<{ n: string }>(`SELECT count(*) AS n FROM work_order w JOIN site s ON s.id = w.site_id WHERE ${where.join(' AND ')}`, params)).rows[0]!.n);
      const items = (await q.query(
        `${WO_SELECT} WHERE ${where.join(' AND ')} ORDER BY w.due_date, k.code, w.number LIMIT ${f.limit} OFFSET ${f.offset}`, params)).rows;
      return { items, total };
    });
  }

  @Get('work-orders/:id')
  get(@Claims() c: TokenClaims, @Param('id') id: string) {
    return this.db.withTenant(tenant(c), async (q) => {
      const row = (await q.query(`${WO_SELECT} WHERE w.id = $1`, [id])).rows[0];
      if (!row) throw new NotFoundException('Work order not found');
      return row;
    });
  }

  @Patch('work-orders/:id') @Roles(...WRITERS)
  patch(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(workOrderPatch, body);
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      const { row, changes } = await patchRow(q, 'work_order', id, {
        title: b.title?.trim(), due_date: b.dueDate, estimated_cost: b.estimatedCost, notes: b.notes,
      }, 'id, title, due_date::text AS due_date');
      await auditUpdate(q, c, 'work_order', id, await clientOf(q, 'work_order', id), changes);
      return row;
    }, { unique: 'Another work order for this contract line is already due on that date' }));
  }

  @Post('work-orders/:id/status') @Roles(...WRITERS)
  setStatus(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(statusChange, body);
    if (b.completedOn && b.completedOn > today()) throw new BadRequestException('completedOn cannot be in the future');
    return this.db.withTenant(tenant(c), async (q) => {
      const cur = (await q.query<{ status: string; client_id: string }>('SELECT status, client_id FROM work_order WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new NotFoundException('Work order not found');
      if (cur.status === b.status) throw new ConflictException(`Work order is already ${b.status.replace('_', ' ')}`);
      if (!STATUS_FLOW[cur.status]!.includes(b.status)) throw new ConflictException(`A ${cur.status.replace('_', ' ')} work order cannot be changed to ${b.status.replace('_', ' ')}`);
      const { row, changes } = await patchRow(q, 'work_order', id, {
        status: b.status,
        completed_on: b.status === 'complete' ? (b.completedOn ?? today()) : null, // leaving "complete" clears the date
        actual_cost: b.actualCost, notes: b.notes,
      }, 'id, status, completed_on::text AS completed_on');
      await auditUpdate(q, c, 'work_order', id, cur.client_id, changes);
      return row;
    });
  }
}
