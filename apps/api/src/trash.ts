import { ConflictException, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { TokenClaims } from './auth';
import { ADMINS, Claims, DB, Roles, audit, tenant } from './common';
import { Database, Queryable } from './db';

/**
 * Soft delete. Run deletes and restores in a tenant context with includeDeleted: PostgreSQL also checks the NEW row of an
 * UPDATE against the read policy, so the row being marked deleted must still be visible to the statement. Inside
 * softDelete every query therefore filters `deleted_at IS NULL` explicitly. All other code paths rely on the policy.
 *
 * Nothing is ever removed by the application (the app role has no DELETE privilege on these tables): a delete sets
 * deleted_at/deleted_by, and row level security hides such rows from every normal query.
 * Deleting a parent also marks its children with the SAME deleted_at (one transaction, one now()), so a restore
 * brings back exactly what went with it and nothing that was deleted earlier on its own.
 */
export type Entity = 'client' | 'region' | 'site' | 'asset-type' | 'asset' | 'scenario' | 'contractor' | 'contract' | 'contract-line' | 'work-order';
const TABLE: Record<Entity, string> = {
  client: 'client', region: 'region', site: 'site', 'asset-type': 'asset_type', asset: 'asset', scenario: 'forecast_scenario',
  contractor: 'contractor', contract: 'contract', 'contract-line': 'contract_line', 'work-order': 'work_order',
};
export const isEntity = (s: string): s is Entity => Object.prototype.hasOwnProperty.call(TABLE, s);
const LABEL: Record<Entity, string> = {
  client: 'Client', region: 'Region', site: 'Site', 'asset-type': 'Asset type', asset: 'Asset', scenario: 'Scenario',
  contractor: 'Contractor', contract: 'Contract', 'contract-line': 'Contract line', 'work-order': 'Work order',
};

/** A contractor belongs to the organisation, so it has no client. */
const clientColumn = (entity: Entity) => (entity === 'client' ? 'id' : entity === 'contractor' ? 'NULL::uuid' : 'client_id');

const n = async (q: Queryable, sql: string, params: unknown[]) => Number((await q.query<{ n: string }>(sql, params)).rows[0]!.n);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Mark rows deleted (same timestamp as the parent) and return how many were affected. */
async function cascadeDelete(q: Queryable, table: string, where: string, params: unknown[], user: string): Promise<number> {
  return Number((await q.query<{ n: string }>(
    `WITH u AS (UPDATE ${table} SET deleted_at = now(), deleted_by = $${params.length + 1} WHERE ${where} AND deleted_at IS NULL RETURNING 1) SELECT count(*) AS n FROM u`,
    [...params, user])).rows[0]!.n);
}

/** Things that must not be left pointing at a deleted row. */
async function assertNoLiveDependants(q: Queryable, entity: Entity, id: string) {
  const refuse = (message: string) => { throw new ConflictException(message); };
  if (entity === 'region') {
    const sites = await n(q, 'SELECT count(*) AS n FROM site WHERE region_id = $1 AND deleted_at IS NULL', [id]);
    if (sites) refuse(`This region still has ${plural(sites, 'site')}. Move or delete them first.`);
  } else if (entity === 'asset-type') {
    const assets = await n(q, 'SELECT count(*) AS n FROM asset WHERE asset_type_id = $1 AND deleted_at IS NULL', [id]);
    if (assets) refuse(`${assets} asset${assets === 1 ? ' uses' : 's use'} this type. Change their type or delete them first.`);
    const subs = await n(q, 'SELECT count(*) AS n FROM asset_type WHERE parent_id = $1 AND deleted_at IS NULL', [id]);
    if (subs) refuse(`This type has ${plural(subs, 'sub-type')}. Delete or move them first.`);
  } else if (entity === 'asset') {
    const kids = await n(q, 'SELECT count(*) AS n FROM asset WHERE parent_id = $1 AND deleted_at IS NULL', [id]);
    if (kids) refuse(`This asset has ${plural(kids, 'component')}. Delete or move them first.`);
    const lines = await n(q, 'SELECT count(*) AS n FROM contract_line WHERE asset_id = $1 AND deleted_at IS NULL', [id]);
    if (lines) refuse(`This asset is on ${plural(lines, 'contract line')}. Remove those lines from their contracts first.`);
  } else if (entity === 'site') {
    const lines = await n(q,
      `SELECT count(*) AS n FROM contract_line l WHERE l.deleted_at IS NULL
          AND (l.site_id = $1 OR l.asset_id IN (SELECT id FROM asset WHERE site_id = $1 AND deleted_at IS NULL))`, [id]);
    if (lines) refuse(`This site, or an asset at it, is on ${plural(lines, 'contract line')}. Remove those lines from their contracts first.`);
  } else if (entity === 'contractor') {
    const contracts = await n(q, 'SELECT count(*) AS n FROM contract WHERE contractor_id = $1 AND deleted_at IS NULL', [id]);
    if (contracts) refuse(`${contracts} contract${contracts === 1 ? ' uses' : 's use'} this contractor. Change or delete them first.`);
  }
}

export async function softDelete(q: Queryable, c: TokenClaims, entity: Entity, id: string) {
  const table = TABLE[entity];
  const row = (await q.query<{ client_id: string | null }>(`SELECT ${clientColumn(entity)} AS client_id FROM ${table} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
  if (!row) throw new NotFoundException(`${LABEL[entity]} not found`);
  await assertNoLiveDependants(q, entity, id);

  await q.query(`UPDATE ${table} SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, c.sub]);

  const cascaded: Record<string, number> = {};
  const down = async (key: string, table: string, where: string) => { cascaded[key] = await cascadeDelete(q, table, where, [id], c.sub); };
  if (entity === 'site') {
    await down('workOrders', 'work_order', 'site_id = $1');
    await down('assets', 'asset', 'site_id = $1');
  } else if (entity === 'asset') {
    await down('workOrders', 'work_order', 'asset_id = $1');
  } else if (entity === 'contract') {
    await down('workOrders', 'work_order', 'contract_id = $1');
    await down('contractLines', 'contract_line', 'contract_id = $1');
  } else if (entity === 'client') {
    await down('workOrders', 'work_order', 'client_id = $1');
    await down('contractLines', 'contract_line', 'client_id = $1');
    await down('contracts', 'contract', 'client_id = $1');
    await down('assets', 'asset', 'client_id = $1');
    await down('sites', 'site', 'client_id = $1');
    await down('regions', 'region', 'client_id = $1');
    await down('assetTypes', 'asset_type', 'client_id = $1');
    await down('scenarios', 'forecast_scenario', 'client_id = $1');
  }
  // Drop zero counts so the audit trail only says what actually went with it.
  for (const k of Object.keys(cascaded)) if (cascaded[k] === 0) delete cascaded[k];
  await audit(q, c, 'delete', entity, id, row.client_id, Object.keys(cascaded).length ? { cascaded } : undefined);
  return { deleted: id, cascaded };
}

/** After a restore nothing live may refer to something still deleted. Throws 409 naming the first problem. */
async function assertConsistent(q: Queryable, clientId: string) {
  const first = async (sql: string) => (await q.query<{ label: string }>(sql + ' LIMIT 1', [clientId])).rows[0]?.label;
  const checks: [string, (label: string) => string][] = [
    [`SELECT r.code || ' ' || r.name AS label FROM site s JOIN region r ON r.id = s.region_id WHERE s.client_id = $1 AND s.deleted_at IS NULL AND r.deleted_at IS NOT NULL`,
      (l) => `a site belongs to the deleted region "${l}". Restore that region first.`],
    [`SELECT s.code || ' ' || s.name AS label FROM asset a JOIN site s ON s.id = a.site_id WHERE a.client_id = $1 AND a.deleted_at IS NULL AND s.deleted_at IS NOT NULL`,
      (l) => `an asset belongs to the deleted site "${l}". Restore that site first.`],
    [`SELECT t.name AS label FROM asset a JOIN asset_type t ON t.id = a.asset_type_id WHERE a.client_id = $1 AND a.deleted_at IS NULL AND t.deleted_at IS NOT NULL`,
      (l) => `an asset uses the deleted asset type "${l}". Restore that type first.`],
    [`SELECT p.name AS label FROM asset a JOIN asset p ON p.id = a.parent_id WHERE a.client_id = $1 AND a.deleted_at IS NULL AND p.deleted_at IS NOT NULL`,
      (l) => `an asset is part of the deleted asset "${l}". Restore that asset first.`],
    [`SELECT p.name AS label FROM asset_type t JOIN asset_type p ON p.id = t.parent_id WHERE t.client_id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NOT NULL`,
      (l) => `a sub-type belongs to the deleted asset type "${l}". Restore that type first.`],
    [`SELECT r.name AS label FROM contract k JOIN contractor r ON r.id = k.contractor_id WHERE k.client_id = $1 AND k.deleted_at IS NULL AND r.deleted_at IS NOT NULL`,
      (l) => `a contract uses the deleted contractor "${l}". Restore that contractor first.`],
    [`SELECT k.code AS label FROM contract_line l JOIN contract k ON k.id = l.contract_id WHERE l.client_id = $1 AND l.deleted_at IS NULL AND k.deleted_at IS NOT NULL`,
      (l) => `a contract line belongs to the deleted contract "${l}". Restore that contract first.`],
    [`SELECT s.code || ' ' || s.name AS label FROM contract_line l JOIN site s ON s.id = l.site_id WHERE l.client_id = $1 AND l.deleted_at IS NULL AND s.deleted_at IS NOT NULL`,
      (l) => `a contract line is for the deleted site "${l}". Restore that site first.`],
    [`SELECT a.name AS label FROM contract_line l JOIN asset a ON a.id = l.asset_id WHERE l.client_id = $1 AND l.deleted_at IS NULL AND a.deleted_at IS NOT NULL`,
      (l) => `a contract line is for the deleted asset "${l}". Restore that asset first.`],
    [`SELECT k.code AS label FROM work_order w JOIN contract k ON k.id = w.contract_id WHERE w.client_id = $1 AND w.deleted_at IS NULL AND k.deleted_at IS NOT NULL`,
      (l) => `a work order belongs to the deleted contract "${l}". Restore that contract first.`],
    [`SELECT s.code || ' ' || s.name AS label FROM work_order w JOIN site s ON s.id = w.site_id WHERE w.client_id = $1 AND w.deleted_at IS NULL AND s.deleted_at IS NOT NULL`,
      (l) => `a work order is for the deleted site "${l}". Restore that site first.`],
    [`SELECT a.name AS label FROM work_order w JOIN asset a ON a.id = w.asset_id WHERE w.client_id = $1 AND w.deleted_at IS NULL AND a.deleted_at IS NOT NULL`,
      (l) => `a work order is for the deleted asset "${l}". Restore that asset first.`],
  ];
  for (const [sql, message] of checks) {
    const label = await first(sql);
    if (label) throw new ConflictException(`Cannot restore: ${message(label)}`);
  }
}

export async function restore(q: Queryable, c: TokenClaims, entity: Entity, id: string) {
  const table = TABLE[entity];
  const row = (await q.query<{ client_id: string | null; deleted: boolean }>(
    `SELECT ${clientColumn(entity)} AS client_id, deleted_at IS NOT NULL AS deleted FROM ${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!row) throw new NotFoundException(`${LABEL[entity]} not found`);
  if (!row.deleted) throw new ConflictException(`${LABEL[entity]} is not deleted`);
  if (row.client_id && entity !== 'client' && !(await n(q, 'SELECT count(*) AS n FROM client WHERE id = $1 AND deleted_at IS NULL', [row.client_id]))) {
    throw new ConflictException('Restore the client first');
  }

  try {
    // Children first, matched to the parent's exact deleted_at in SQL (a JS Date would lose microseconds).
    const restored: Record<string, number> = {};
    const back = async (key: string, child: string, where: string) => {
      restored[key] = Number((await q.query<{ n: string }>(
        `WITH u AS (UPDATE ${child} SET deleted_at = NULL, deleted_by = NULL WHERE ${where} AND deleted_at = (SELECT deleted_at FROM ${table} WHERE id = $1) RETURNING 1) SELECT count(*) AS n FROM u`, [id])).rows[0]!.n);
    };
    if (entity === 'site') {
      await back('assets', 'asset', 'site_id = $1');
      await back('workOrders', 'work_order', 'site_id = $1');
    } else if (entity === 'asset') {
      await back('workOrders', 'work_order', 'asset_id = $1');
    } else if (entity === 'contract') {
      await back('contractLines', 'contract_line', 'contract_id = $1');
      await back('workOrders', 'work_order', 'contract_id = $1');
    } else if (entity === 'client') {
      await back('regions', 'region', 'client_id = $1');
      await back('assetTypes', 'asset_type', 'client_id = $1');
      await back('sites', 'site', 'client_id = $1');
      await back('assets', 'asset', 'client_id = $1');
      await back('scenarios', 'forecast_scenario', 'client_id = $1');
      await back('contracts', 'contract', 'client_id = $1');
      await back('contractLines', 'contract_line', 'client_id = $1');
      await back('workOrders', 'work_order', 'client_id = $1');
    }
    await q.query(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`, [id]);
    if (row.client_id) await assertConsistent(q, row.client_id);
    for (const k of Object.keys(restored)) if (restored[k] === 0) delete restored[k];
    await audit(q, c, 'restore', entity, id, row.client_id, Object.keys(restored).length ? { restored } : undefined);
    return { restored: id, alsoRestored: restored };
  } catch (e: any) {
    if (e?.code === '23505') throw new ConflictException(`Another live ${LABEL[entity].toLowerCase()} already uses this code or name. Rename that one first.`);
    throw e;
  }
}

export interface TrashItem {
  entity: Entity; id: string; label: string; clientId: string | null; clientName: string | null;
  deletedAt: string; deletedBy: string | null; includes: number;
}

/** Deleted items that were deleted on their own (not as part of a parent), newest first. */
export async function listTrash(q: Queryable): Promise<TrashItem[]> {
  const notWith = (a: string, parent: string, key: string) => `AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.id = ${a}.${key} AND p.deleted_at = ${a}.deleted_at)`;
  const notWithClient = (a: string) => notWith(a, 'client', 'client_id');
  const base = (entity: string, label: string, from: string, a: string, extra = '', includes = '0') =>
    `SELECT '${entity}' AS entity, ${a}.id, ${label} AS label, ${a}.client_id, cl.name AS client_name, ${a}.deleted_at, u.display_name AS deleted_by, (${includes})::int AS includes
       FROM ${from} JOIN client cl ON cl.id = ${a}.client_id LEFT JOIN app_user u ON u.id = ${a}.deleted_by
      WHERE ${a}.deleted_at IS NOT NULL ${extra}`;
  const sameTs = (child: string, key: string, parentAlias: string) => `SELECT count(*) FROM ${child} x WHERE x.${key} = ${parentAlias}.id AND x.deleted_at = ${parentAlias}.deleted_at`;
  const sql = [
    `SELECT 'client' AS entity, c.id, c.name AS label, c.id AS client_id, c.name AS client_name, c.deleted_at, u.display_name AS deleted_by,
            ((SELECT count(*) FROM site s WHERE s.client_id = c.id AND s.deleted_at = c.deleted_at)
             + (SELECT count(*) FROM asset a WHERE a.client_id = c.id AND a.deleted_at = c.deleted_at)
             + (SELECT count(*) FROM contract k WHERE k.client_id = c.id AND k.deleted_at = c.deleted_at)
             + (SELECT count(*) FROM work_order w WHERE w.client_id = c.id AND w.deleted_at = c.deleted_at))::int AS includes
       FROM client c LEFT JOIN app_user u ON u.id = c.deleted_by WHERE c.deleted_at IS NOT NULL`,
    `SELECT 'contractor' AS entity, k.id, k.name AS label, NULL::uuid AS client_id, NULL::text AS client_name, k.deleted_at, u.display_name AS deleted_by, 0 AS includes
       FROM contractor k LEFT JOIN app_user u ON u.id = k.deleted_by WHERE k.deleted_at IS NOT NULL`,
    base('region', `r.code || ' · ' || r.name`, 'region r', 'r', notWithClient('r')),
    base('site', `s.code || ' · ' || s.name`, 'site s', 's', notWithClient('s'), `(${sameTs('asset', 'site_id', 's')}) + (${sameTs('work_order', 'site_id', 's')})`),
    base('asset-type', 't.name', 'asset_type t', 't', notWithClient('t')),
    base('asset', `a.name || ' (' || st.code || ')'`, 'asset a JOIN site st ON st.id = a.site_id', 'a',
      `${notWithClient('a')} ${notWith('a', 'site', 'site_id')}`, sameTs('work_order', 'asset_id', 'a')),
    base('scenario', 'f.name', 'forecast_scenario f', 'f', notWithClient('f')),
    base('contract', `k.code || ' · ' || k.name`, 'contract k', 'k', notWithClient('k'), `(${sameTs('contract_line', 'contract_id', 'k')}) + (${sameTs('work_order', 'contract_id', 'k')})`),
    base('contract-line', 'l.description', 'contract_line l', 'l', `${notWithClient('l')} ${notWith('l', 'contract', 'contract_id')}`),
    base('work-order', `COALESCE(kk.code || '-' || lpad(w.number::text, 4, '0'), 'WO-' || lpad(w.number::text, 4, '0')) || ' · ' || w.title`,
      'work_order w LEFT JOIN contract kk ON kk.id = w.contract_id', 'w',
      `${notWithClient('w')} ${notWith('w', 'contract', 'contract_id')} ${notWith('w', 'site', 'site_id')} ${notWith('w', 'asset', 'asset_id')}`),
  ].join(' UNION ALL ');
  const rows = (await q.query<any>(`SELECT * FROM (${sql}) t ORDER BY deleted_at DESC LIMIT 500`)).rows;
  return rows.map((r) => ({
    entity: r.entity, id: r.id, label: r.label, clientId: r.client_id, clientName: r.client_name,
    deletedAt: new Date(r.deleted_at).toISOString(), deletedBy: r.deleted_by, includes: r.includes,
  }));
}

@Controller('trash')
export class TrashController {
  constructor(@Inject(DB) private db: Database) {}

  @Get() @Roles(...ADMINS)
  list(@Claims() c: TokenClaims) {
    return this.db.withTenant({ ...tenant(c), includeDeleted: true }, (q) => listTrash(q));
  }

  @Post(':entity/:id/restore') @Roles(...ADMINS)
  restore(@Claims() c: TokenClaims, @Param('entity') entity: string, @Param('id') id: string) {
    if (!isEntity(entity)) throw new NotFoundException('Unknown item type');
    return this.db.withTenant({ ...tenant(c), includeDeleted: true }, (q) => restore(q, c, entity, id));
  }
}
