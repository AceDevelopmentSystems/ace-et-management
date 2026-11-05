import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MAX_OCCURRENCES, addInterval, occurrences } from '@ace/schedule';
import { TokenClaims } from './auth';
import { audit } from './common';
import { Queryable } from './db';
import { inChunks, values } from './sql';

export interface ContractRow { id: string; client_id: string; contractor_id: string; status: string; start_date: string; end_date: string }
export const CONTRACT_COLS = `id, client_id, contractor_id, status, start_date::text AS start_date, end_date::text AS end_date`;

export const today = () => new Date().toISOString().slice(0, 10);

export interface GenerateWindow { from?: string; through: string; dryRun?: boolean }

/**
 * Create the work orders due in a window for one contract. Safe to repeat: an occurrence (line + due date) can exist only
 * once, deleted or not, so running it again, or two runs at once, never duplicates.
 *
 * `q` must be a tenant transaction with includeDeleted, so deleted work orders still count as existing (they are not
 * recreated). Every other query here filters `deleted_at IS NULL` explicitly. Locking the contract row serialises
 * generation per contract, so numbering cannot race.
 */
export async function generateWorkOrders(q: Queryable, c: TokenClaims, contractId: string, w: GenerateWindow) {
  const dryRun = w.dryRun ?? false;
  if (w.through > addInterval(today(), 5, 'year')) throw new BadRequestException('through is more than 5 years ahead');
  if (w.from && w.from > w.through) throw new BadRequestException('from is after through');

  const contract = (await q.query<ContractRow>(`SELECT ${CONTRACT_COLS} FROM contract WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [contractId])).rows[0];
  if (!contract) throw new NotFoundException('Contract not found');
  if (contract.status !== 'active') throw new ConflictException('Only an active contract can generate work orders. Set its status to active first.');

  const lines = (await q.query<{
    id: string; description: string; frequency_interval: number; frequency_unit: 'day' | 'week' | 'month' | 'year';
    first_due: string; cost: string; asset_id: string | null; site_id: string; site_code: string; asset_name: string | null;
  }>(
    `SELECT l.id, l.description, l.frequency_interval, l.frequency_unit, l.first_due_date::text AS first_due, l.cost_per_occurrence AS cost, l.asset_id,
            COALESCE(l.site_id, a.site_id) AS site_id, ls.code AS site_code, a.name AS asset_name
       FROM contract_line l LEFT JOIN asset a ON a.id = l.asset_id AND a.deleted_at IS NULL
       LEFT JOIN site ls ON ls.id = COALESCE(l.site_id, a.site_id)
      WHERE l.contract_id = $1 AND l.deleted_at IS NULL ORDER BY l.created_at, l.id`, [contractId])).rows;

  // Everything already generated for this contract, including deleted ones.
  const existing = new Map<string, boolean>();
  for (const r of (await q.query<{ line: string; due: string; deleted: boolean }>(
    'SELECT contract_line_id AS line, due_date::text AS due, deleted_at IS NOT NULL AS deleted FROM work_order WHERE contract_id = $1', [contractId])).rows) {
    existing.set(`${r.line}|${r.due}`, r.deleted);
  }

  const wanted: { line: (typeof lines)[number]; due: string }[] = [];
  let existingLive = 0, existingDeleted = 0;
  for (const line of lines) {
    let dues: string[];
    try {
      dues = occurrences({ firstDue: line.first_due, interval: line.frequency_interval, unit: line.frequency_unit }, { from: w.from, through: w.through, until: contract.end_date });
    } catch (e) {
      if (e instanceof RangeError) throw new BadRequestException(`${line.description}: ${e.message}`);
      throw e;
    }
    for (const due of dues) {
      if (due < contract.start_date) continue;
      const key = `${line.id}|${due}`;
      if (existing.has(key)) existing.get(key) ? existingDeleted++ : existingLive++;
      else wanted.push({ line, due });
    }
  }
  if (wanted.length > MAX_OCCURRENCES) throw new BadRequestException(`That would create ${wanted.length} work orders (limit ${MAX_OCCURRENCES}). Use a shorter window.`);
  // Number in due-date order. Ties are broken by what the work is (site, description, asset) and only then by id, so the same
  // contract always numbers the same way, however and whenever it was built.
  wanted.sort((x, y) => x.due.localeCompare(y.due) || x.line.site_code.localeCompare(y.line.site_code) || x.line.description.localeCompare(y.line.description)
    || (x.line.asset_name ?? '').localeCompare(y.line.asset_name ?? '') || x.line.id.localeCompare(y.line.id));

  const sample = wanted.slice(0, 20).map((x) => ({ lineId: x.line.id, description: x.line.description, dueDate: x.due }));
  const base = { dryRun, from: w.from ?? null, through: w.through, existing: existingLive, deletedSkipped: existingDeleted, wouldCreate: wanted.length, sample };
  if (dryRun || wanted.length === 0) return { ...base, created: 0 };

  const start = Number((await q.query<{ first: number }>(
    'UPDATE contract SET next_wo_number = next_wo_number + $2 WHERE id = $1 RETURNING next_wo_number - $2 AS first', [contractId, wanted.length])).rows[0]!.first);
  let created = 0;
  const rows = wanted.map((x, i) => [x.line.id, start + i, x.line.site_id, x.line.asset_id, x.line.description, x.due, x.line.cost]);
  await inChunks(rows, 200, async (chunk) => {
    const v = values(chunk, 4);
    const res = await q.query(
      `INSERT INTO work_order (organisation_id, client_id, contract_id, contractor_id, contract_line_id, number, site_id, asset_id, title, due_date, estimated_cost)
       SELECT $1, $2, $3, $4, x.line_id::uuid, x.num::int, x.site_id::uuid, x.asset_id::uuid, x.title, x.due::date, x.cost::numeric
         FROM (VALUES ${v.sql}) AS x(line_id, num, site_id, asset_id, title, due, cost)
       ON CONFLICT (contract_line_id, due_date) DO NOTHING RETURNING id`,
      [c.org, contract.client_id, contractId, contract.contractor_id, ...v.params]);
    created += res.rows.length;
  });
  await audit(q, c, 'create', 'work_order', null, contract.client_id, { generated: created, contractId, from: w.from ?? null, through: w.through });
  return { ...base, created };
}
