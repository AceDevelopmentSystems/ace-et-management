import { addInterval } from '@ace/schedule';
import { TokenClaims } from '../auth';
import { Database, Queryable } from '../db';
import { generateWorkOrders } from '../generate';
import { inChunks, values } from '../sql';
import { hash, rng } from './random';

/**
 * Demo contracts for the seeded client: three contractors, three contracts with scheduled lines, and the work orders
 * generated from them by the real generator, with a realistic spread of statuses (mostly done, some in progress, a few
 * overdue). Like the rest of the seed it is idempotent and deterministic: contractors and contracts are found by name or
 * code, lines and the status history are only created with a contract, and later runs just top up the generation window.
 */

const CONTRACTORS = [
  { name: 'Greenline Grounds Ltd', contactName: 'Sam Rivera', email: 'ops@greenline.example.com', phone: '1300 555 010' },
  { name: 'CoolTech Air Services', contactName: 'Priya Nair', email: 'service@cooltech.example.com', phone: '1300 555 020' },
  { name: 'SecureFence & Access', contactName: 'Jo Matthews', email: 'jobs@securefence.example.com', phone: '1300 555 030' },
] as const;

const CONTRACTS = [
  { code: 'GRD', name: 'Grounds maintenance', contractor: CONTRACTORS[0].name, status: 'active' },
  { code: 'AIR', name: 'Annual aircon servicing', contractor: CONTRACTORS[1].name, status: 'active' },
  { code: 'SEC', name: 'Fence and access inspections', contractor: CONTRACTORS[2].name, status: 'draft' },
] as const;

export interface ContractSeedParams { organisationId: string; userId: string; clientId: string; asOf: string; withAssets: boolean }
export interface ContractSeedResult { contractors: number; contracts: number; contractLines: number; workOrders: number }

const pad = (n: number) => String(n).padStart(2, '0');
const GENERATOR_VERSION = 'demo-v1';

export async function seedContracts(db: Database, p: ContractSeedParams): Promise<ContractSeedResult> {
  const claims: TokenClaims = { sub: p.userId, org: p.organisationId, role: 'org_admin', clients: [], exp: 0 };
  // includeDeleted: the generator must see deleted work orders so it never recreates them.
  return db.withTenant({ orgId: p.organisationId, includeDeleted: true }, async (q) => {
    const year = Number(p.asOf.slice(0, 4));
    const start = `${year}-01-01`, end = `${year + 1}-12-31`;

    const contractorId = new Map<string, string>();
    for (const k of CONTRACTORS) {
      const found = (await q.query<{ id: string }>('SELECT id FROM contractor WHERE lower(name) = lower($1) AND deleted_at IS NULL', [k.name])).rows[0];
      contractorId.set(k.name, found?.id ?? (await q.query<{ id: string }>(
        'INSERT INTO contractor (organisation_id, name, contact_name, email, phone) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [p.organisationId, k.name, k.contactName, k.email, k.phone])).rows[0]!.id);
    }

    const sites = (await q.query<{ id: string; code: string; stars: number }>(
      `SELECT id, code, COALESCE((attributes->>'powerStars')::int, 0) AS stars FROM site WHERE client_id = $1 AND deleted_at IS NULL ORDER BY code`, [p.clientId])).rows;

    for (const def of CONTRACTS) {
      let contract = (await q.query<{ id: string }>('SELECT id FROM contract WHERE client_id = $1 AND lower(code) = lower($2) AND deleted_at IS NULL', [p.clientId, def.code])).rows[0];
      const isNew = !contract;
      if (!contract) {
        contract = (await q.query<{ id: string }>(
          `INSERT INTO contract (organisation_id, client_id, contractor_id, code, name, status, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [p.organisationId, p.clientId, contractorId.get(def.contractor), def.code, def.name, def.status, start, end])).rows[0]!;
        await addLines(q, p, contract.id, def.code, year, sites);
      }
      if (def.status !== 'active') continue;

      // New contracts get history from the start of the contract; existing ones are only topped up from today.
      await generateWorkOrders(q, claims, contract.id, { from: isNew ? undefined : p.asOf, through: addInterval(p.asOf, 90, 'day') });
      if (isNew) await simulateHistory(q, contract.id, def.code, p.asOf);
    }

    const n = async (sql: string, params: unknown[] = [p.clientId]) => Number((await q.query<{ n: string }>(sql, params)).rows[0]!.n);
    return {
      contractors: await n('SELECT count(*) AS n FROM contractor WHERE deleted_at IS NULL', []),
      contracts: await n('SELECT count(*) AS n FROM contract WHERE client_id = $1 AND deleted_at IS NULL'),
      contractLines: await n('SELECT count(*) AS n FROM contract_line WHERE client_id = $1 AND deleted_at IS NULL'),
      workOrders: await n('SELECT count(*) AS n FROM work_order WHERE client_id = $1 AND deleted_at IS NULL'),
    };
  });
}

type SiteRow = { id: string; code: string; stars: number };

async function addLines(q: Queryable, p: ContractSeedParams, contractId: string, code: string, year: number, sites: SiteRow[]) {
  // [siteId, assetId, description, interval, unit, firstDue, cost]
  const rows: unknown[][] = [];
  if (code === 'GRD') {
    for (const s of sites.filter((x) => x.stars >= 4)) {
      rows.push([s.id, null, 'Mow and tidy grounds', 1, 'month', `${year}-01-${pad(1 + (hash(s.code) % 28))}`, 180 + s.stars * 40]);
    }
  } else if (code === 'SEC') {
    for (const s of sites.filter((x) => x.stars >= 5)) {
      rows.push([s.id, null, 'Inspect fence and access', 3, 'month', `${year}-02-${pad(1 + (hash(s.code) % 28))}`, 120]);
    }
  } else if (code === 'AIR' && p.withAssets) {
    const aircon = (await q.query<{ id: string; code: string; quantity: string }>(
      `SELECT a.id, s.code, a.quantity FROM asset a JOIN site s ON s.id = a.site_id JOIN asset_type t ON t.id = a.asset_type_id
        WHERE a.client_id = $1 AND a.deleted_at IS NULL AND t.name = 'Air conditioning' ORDER BY s.code`, [p.clientId])).rows;
    for (const a of aircon.filter((x) => hash(x.code) % 4 === 0)) {
      rows.push([null, a.id, 'Annual aircon service', 1, 'year', `${year}-${pad(1 + (hash(a.code) % 12))}-01`, 160 * Number(a.quantity)]);
    }
  }
  await inChunks(rows, 200, async (chunk) => {
    const v = values(chunk, 3);
    await q.query(
      `INSERT INTO contract_line (organisation_id, client_id, contract_id, site_id, asset_id, description, frequency_interval, frequency_unit, first_due_date, cost_per_occurrence)
       SELECT $1, $2, $3, x.site_id::uuid, x.asset_id::uuid, x.description, x.interval::int, x.unit, x.first_due::date, x.cost::numeric
         FROM (VALUES ${v.sql}) AS x(site_id, asset_id, description, interval, unit, first_due, cost)`,
      [p.organisationId, p.clientId, contractId, ...v.params]);
  });
}

/** Make the past look lived in: old work is mostly complete, recent work mixed, and a few jobs are overdue. */
async function simulateHistory(q: Queryable, contractId: string, code: string, asOf: string) {
  const wos = (await q.query<{ id: string; number: number; due: string; estimate: string }>(
    'SELECT id, number, due_date::text AS due, estimated_cost AS estimate FROM work_order WHERE contract_id = $1 AND deleted_at IS NULL AND status = \'new\'', [contractId])).rows;
  const dayMs = 86400000;
  const updates: unknown[][] = [];
  for (const w of wos) {
    const age = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${w.due}T00:00:00Z`)) / dayMs);
    if (age <= 0) continue; // not due yet: stays new
    const r = rng(`${GENERATOR_VERSION}:wo:${code}:${w.number}`);
    const roll = r();
    const complete = age > 30 ? roll < 0.9 : roll < 0.6;
    if (complete) {
      const doneAfter = Math.min(age, Math.floor(r() * 6));
      const done = new Date(Date.parse(`${w.due}T00:00:00Z`) + doneAfter * dayMs).toISOString().slice(0, 10);
      const actual = Math.round(Number(w.estimate) * (0.9 + r() * 0.3) * 100) / 100;
      updates.push([w.id, 'complete', done, actual]);
    } else if (age > 30 && roll < 0.95) {
      updates.push([w.id, 'cancelled', null, null]);
    } else if (age <= 30 && roll < 0.8) {
      updates.push([w.id, 'in_progress', null, null]);
    } // else left new, which makes it overdue
  }
  await inChunks(updates, 200, async (chunk) => {
    const v = values(chunk, 0);
    await q.query(
      `UPDATE work_order w SET status = x.status, completed_on = x.completed_on::date, actual_cost = x.actual::numeric
         FROM (VALUES ${v.sql}) AS x(id, status, completed_on, actual) WHERE w.id = x.id::uuid`, v.params);
  });
}
