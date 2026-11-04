import { ConflictException, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { TokenClaims } from './auth';
import { ADMINS, Claims, DB, Roles, audit, tenant } from './common';
import { Database, Queryable } from './db';

/**
 * Soft delete. Run deletes and restores in a tenant context with includeDeleted: PostgreSQL also checks the NEW row of an
 * UPDATE against the read policy, so the row being marked deleted must still be visible to the statement. Inside
 * softDelete every query therefore filters `deleted_at IS NULL` explicitly. All other code paths rely on the policy.
 *
 * Nothing is ever removed by the application (the app role has no DELETE privilege on these tables):
 * a delete sets deleted_at/deleted_by, and row level security hides such rows from every normal query.
 * Deleting a site or client also marks its children with the SAME deleted_at (one transaction, one now()), so a restore
 * brings back exactly what went with it and nothing that was deleted earlier on its own.
 */
export type Entity = 'client' | 'region' | 'site' | 'asset-type' | 'asset' | 'scenario';
const TABLE: Record<Entity, string> = {
  client: 'client', region: 'region', site: 'site', 'asset-type': 'asset_type', asset: 'asset', scenario: 'forecast_scenario',
};
export const isEntity = (s: string): s is Entity => Object.prototype.hasOwnProperty.call(TABLE, s);
const LABEL: Record<Entity, string> = { client: 'Client', region: 'Region', site: 'Site', 'asset-type': 'Asset type', asset: 'Asset', scenario: 'Scenario' };

const n = async (q: Queryable, sql: string, params: unknown[]) => Number((await q.query<{ n: string }>(sql, params)).rows[0]!.n);

/** Mark rows deleted (same timestamp as the parent) and return how many were affected. */
async function cascadeDelete(q: Queryable, table: string, where: string, params: unknown[], user: string): Promise<number> {
  return Number((await q.query<{ n: string }>(
    `WITH u AS (UPDATE ${table} SET deleted_at = now(), deleted_by = $${params.length + 1} WHERE ${where} AND deleted_at IS NULL RETURNING 1) SELECT count(*) AS n FROM u`,
    [...params, user])).rows[0]!.n);
}

/** Things that must not be left pointing at a deleted row. */
async function assertNoLiveDependants(q: Queryable, entity: Entity, id: string) {
  if (entity === 'region') {
    const sites = await n(q, 'SELECT count(*) AS n FROM site WHERE region_id = $1 AND deleted_at IS NULL', [id]);
    if (sites) throw new ConflictException(`This region still has ${sites} site${sites === 1 ? '' : 's'}. Move or delete them first.`);
  } else if (entity === 'asset-type') {
    const assets = await n(q, 'SELECT count(*) AS n FROM asset WHERE asset_type_id = $1 AND deleted_at IS NULL', [id]);
    if (assets) throw new ConflictException(`${assets} asset${assets === 1 ? ' uses' : 's use'} this type. Change their type or delete them first.`);
    const subs = await n(q, 'SELECT count(*) AS n FROM asset_type WHERE parent_id = $1 AND deleted_at IS NULL', [id]);
    if (subs) throw new ConflictException(`This type has ${subs} sub-type${subs === 1 ? '' : 's'}. Delete or move them first.`);
  } else if (entity === 'asset') {
    const kids = await n(q, 'SELECT count(*) AS n FROM asset WHERE parent_id = $1 AND deleted_at IS NULL', [id]);
    if (kids) throw new ConflictException(`This asset has ${kids} component${kids === 1 ? '' : 's'}. Delete or move them first.`);
  }
}

export async function softDelete(q: Queryable, c: TokenClaims, entity: Entity, id: string) {
  const table = TABLE[entity];
  const col = entity === 'client' ? 'id' : 'client_id';
  const row = (await q.query<{ client_id: string }>(`SELECT ${col} AS client_id FROM ${table} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
  if (!row) throw new NotFoundException(`${LABEL[entity]} not found`);
  await assertNoLiveDependants(q, entity, id);

  await q.query(`UPDATE ${table} SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, c.sub]);

  const cascaded: Record<string, number> = {};
  if (entity === 'site') {
    cascaded.assets = await cascadeDelete(q, 'asset', 'site_id = $1', [id], c.sub);
  } else if (entity === 'client') {
    cascaded.assets = await cascadeDelete(q, 'asset', 'client_id = $1', [id], c.sub);
    cascaded.sites = await cascadeDelete(q, 'site', 'client_id = $1', [id], c.sub);
    cascaded.regions = await cascadeDelete(q, 'region', 'client_id = $1', [id], c.sub);
    cascaded.assetTypes = await cascadeDelete(q, 'asset_type', 'client_id = $1', [id], c.sub);
    cascaded.scenarios = await cascadeDelete(q, 'forecast_scenario', 'client_id = $1', [id], c.sub);
  }
  await audit(q, c, 'delete', entity, id, row.client_id, Object.keys(cascaded).length ? { cascaded } : undefined);
  return { deleted: id, cascaded };
}

/** After a restore nothing live may refer to something still deleted. Throws 409 naming the first problem. */
async function assertConsistent(q: Queryable, clientId: string) {
  const first = async (sql: string) => (await q.query<{ label: string }>(sql + ' LIMIT 1', [clientId])).rows[0]?.label;
  const region = await first(`SELECT r.code || ' ' || r.name AS label FROM site s JOIN region r ON r.id = s.region_id WHERE s.client_id = $1 AND s.deleted_at IS NULL AND r.deleted_at IS NOT NULL`);
  if (region) throw new ConflictException(`Cannot restore: a site belongs to the deleted region "${region}". Restore that region first.`);
  const site = await first(`SELECT s.code || ' ' || s.name AS label FROM asset a JOIN site s ON s.id = a.site_id WHERE a.client_id = $1 AND a.deleted_at IS NULL AND s.deleted_at IS NOT NULL`);
  if (site) throw new ConflictException(`Cannot restore: an asset belongs to the deleted site "${site}". Restore that site first.`);
  const type = await first(`SELECT t.name AS label FROM asset a JOIN asset_type t ON t.id = a.asset_type_id WHERE a.client_id = $1 AND a.deleted_at IS NULL AND t.deleted_at IS NOT NULL`);
  if (type) throw new ConflictException(`Cannot restore: an asset uses the deleted asset type "${type}". Restore that type first.`);
  const parent = await first(`SELECT p.name AS label FROM asset a JOIN asset p ON p.id = a.parent_id WHERE a.client_id = $1 AND a.deleted_at IS NULL AND p.deleted_at IS NOT NULL`);
  if (parent) throw new ConflictException(`Cannot restore: an asset is part of the deleted asset "${parent}". Restore that asset first.`);
  const superType = await first(`SELECT p.name AS label FROM asset_type t JOIN asset_type p ON p.id = t.parent_id WHERE t.client_id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NOT NULL`);
  if (superType) throw new ConflictException(`Cannot restore: a sub-type belongs to the deleted asset type "${superType}". Restore that type first.`);
}

export async function restore(q: Queryable, c: TokenClaims, entity: Entity, id: string) {
  const table = TABLE[entity];
  const col = entity === 'client' ? 'id' : 'client_id';
  const row = (await q.query<{ client_id: string; deleted: boolean }>(`SELECT ${col} AS client_id, deleted_at IS NOT NULL AS deleted FROM ${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!row) throw new NotFoundException(`${LABEL[entity]} not found`);
  if (!row.deleted) throw new ConflictException(`${LABEL[entity]} is not deleted`);
  if (entity !== 'client' && !(await n(q, 'SELECT count(*) AS n FROM client WHERE id = $1 AND deleted_at IS NULL', [row.client_id]))) {
    throw new ConflictException('Restore the client first');
  }

  try {
    // Children first, matched to the parent's exact deleted_at in SQL (a JS Date would lose microseconds).
    const restored: Record<string, number> = {};
    const back = async (child: string, where: string, parentTable: string) => Number((await q.query<{ n: string }>(
      `WITH u AS (UPDATE ${child} SET deleted_at = NULL, deleted_by = NULL WHERE ${where} AND deleted_at = (SELECT deleted_at FROM ${parentTable} WHERE id = $1) RETURNING 1) SELECT count(*) AS n FROM u`, [id])).rows[0]!.n);
    if (entity === 'site') {
      restored.assets = await back('asset', 'site_id = $1', 'site');
    } else if (entity === 'client') {
      restored.regions = await back('region', 'client_id = $1', 'client');
      restored.assetTypes = await back('asset_type', 'client_id = $1', 'client');
      restored.sites = await back('site', 'client_id = $1', 'client');
      restored.assets = await back('asset', 'client_id = $1', 'client');
      restored.scenarios = await back('forecast_scenario', 'client_id = $1', 'client');
    }
    await q.query(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`, [id]);
    await assertConsistent(q, row.client_id);
    await audit(q, c, 'restore', entity, id, row.client_id, Object.keys(restored).length ? { restored } : undefined);
    return { restored: id, alsoRestored: restored };
  } catch (e: any) {
    if (e?.code === '23505') throw new ConflictException(`Another live ${LABEL[entity].toLowerCase()} already uses this code. Rename that one first.`);
    throw e;
  }
}

export interface TrashItem {
  entity: Entity; id: string; label: string; clientId: string; clientName: string;
  deletedAt: string; deletedBy: string | null; includes: number;
}

/** Deleted items that were deleted on their own (not as part of a parent), newest first. */
export async function listTrash(q: Queryable): Promise<TrashItem[]> {
  const notWithClient = (a: string) => `AND NOT EXISTS (SELECT 1 FROM client pc WHERE pc.id = ${a}.client_id AND pc.deleted_at = ${a}.deleted_at)`;
  const base = (entity: string, label: string, from: string, a: string, extra = '', includes = '0') =>
    `SELECT '${entity}' AS entity, ${a}.id, ${label} AS label, ${a}.client_id, cl.name AS client_name, ${a}.deleted_at, u.display_name AS deleted_by, (${includes})::int AS includes
       FROM ${from} JOIN client cl ON cl.id = ${a}.client_id LEFT JOIN app_user u ON u.id = ${a}.deleted_by
      WHERE ${a}.deleted_at IS NOT NULL ${extra}`;
  const sql = [
    `SELECT 'client' AS entity, c.id, c.name AS label, c.id AS client_id, c.name AS client_name, c.deleted_at, u.display_name AS deleted_by,
            ((SELECT count(*) FROM site s WHERE s.client_id = c.id AND s.deleted_at = c.deleted_at) + (SELECT count(*) FROM asset a WHERE a.client_id = c.id AND a.deleted_at = c.deleted_at))::int AS includes
       FROM client c LEFT JOIN app_user u ON u.id = c.deleted_by WHERE c.deleted_at IS NOT NULL`,
    base('region', `r.code || ' · ' || r.name`, 'region r', 'r', notWithClient('r')),
    base('site', `s.code || ' · ' || s.name`, 'site s', 's', notWithClient('s'), `SELECT count(*) FROM asset a WHERE a.site_id = s.id AND a.deleted_at = s.deleted_at`),
    base('asset-type', 't.name', 'asset_type t', 't', notWithClient('t')),
    base('asset', `a.name || ' (' || st.code || ')'`, 'asset a JOIN site st ON st.id = a.site_id', 'a',
      `${notWithClient('a')} AND NOT EXISTS (SELECT 1 FROM site ps WHERE ps.id = a.site_id AND ps.deleted_at = a.deleted_at)`),
    base('scenario', 'f.name', 'forecast_scenario f', 'f', notWithClient('f')),
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
