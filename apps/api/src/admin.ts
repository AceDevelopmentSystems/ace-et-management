import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, Patch, Post, Query,
} from '@nestjs/common';
import { Scenario } from '@ace/forecast';
import { TokenClaims } from './auth';
import { ADMINS, Claims, DB, Roles, WRITERS, audit, deleteRow, parse, patchRow, tenant } from './common';
import { Database, Queryable } from './db';
import { runClientForecast } from './forecast-run';
import { assetPatch, clientPatch, regionPatch, namedScenarioSchema, scenarioSchema, sitePatch, typePatch } from './schemas';

/** Translate known Postgres errors raised by an update into 4xx responses. */
async function guarded<T>(fn: () => Promise<T>, messages: { unique?: string; fk?: string }): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code === '23505') throw new ConflictException(messages.unique ?? 'Duplicate value');
    if (e?.code === '23503') throw new BadRequestException(messages.fk ?? 'Referenced record does not exist');
    if (e?.code === '23514') throw new BadRequestException('Value violates a constraint');
    throw e;
  }
}

/** Client a row belongs to, for the audit trail. */
async function clientOf(q: Queryable, table: string, id: string): Promise<string | null> {
  const col = table === 'client' ? 'id' : 'client_id';
  return (await q.query<{ c: string }>(`SELECT ${col} AS c FROM ${table} WHERE id = $1`, [id])).rows[0]?.c ?? null;
}

@Controller()
export class AdminController {
  constructor(@Inject(DB) private db: Database) {}

  // ---------------------------------------------------------------- updates
  @Patch('clients/:id') @Roles(...WRITERS)
  patchClient(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(clientPatch, body);
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      const row = await patchRow(q, 'client', id, { name: b.name, code: b.code, currency: b.currency }, 'id, name, code, currency');
      await audit(q, c, 'update', 'client', id, id);
      return row;
    }, { unique: 'Client code already in use' }));
  }

  @Patch('sites/:id') @Roles(...WRITERS)
  patchSite(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(sitePatch, body);
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      const row = await patchRow(q, 'site', id, {
        code: b.code, name: b.name, site_class: b.siteClass, address: b.address, latitude: b.latitude, longitude: b.longitude,
        hazards: b.hazards, attributes: b.attributes, region_id: b.regionId,
      }, 'id, code, name');
      await audit(q, c, 'update', 'site', id, await clientOf(q, 'site', id));
      return row;
    }, { unique: 'Site code already exists for this client', fk: 'regionId does not exist for this client' }));
  }

  @Patch('regions/:id') @Roles(...WRITERS)
  patchRegion(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(regionPatch, body);
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      const row = await patchRow(q, 'region', id, { code: b.code, name: b.name }, 'id, code, name');
      await audit(q, c, 'update', 'region', id, await clientOf(q, 'region', id));
      return row;
    }, { unique: 'Region code already exists for this client' }));
  }

  @Patch('asset-types/:id') @Roles(...WRITERS)
  patchType(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(typePatch, body);
    if (b.parentId === id) throw new BadRequestException('A type cannot be its own parent');
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      const row = await patchRow(q, 'asset_type', id, {
        name: b.name, parent_id: b.parentId, expected_life_years: b.expectedLifeYears, unit: b.unit, unit_rate: b.unitRate,
      }, 'id, name');
      await audit(q, c, 'update', 'asset_type', id, await clientOf(q, 'asset_type', id));
      return row;
    }, { fk: 'parentId does not exist for this client' }));
  }

  @Patch('assets/:id') @Roles(...WRITERS)
  patchAsset(@Claims() c: TokenClaims, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(assetPatch, body);
    if (b.parentId === id) throw new BadRequestException('An asset cannot be its own parent');
    return this.db.withTenant(tenant(c), (q) => guarded(async () => {
      const row = await patchRow(q, 'asset', id, {
        name: b.name, parent_id: b.parentId, asset_type_id: b.assetTypeId, manufacturer: b.manufacturer, serial_number: b.serialNumber,
        install_date: b.installDate, quantity: b.quantity, unit: b.unit, unit_rate: b.unitRate,
        expected_life_years: b.expectedLifeYears, criticality: b.criticality, attributes: b.attributes,
      }, 'id, name');
      await audit(q, c, 'update', 'asset', id, await clientOf(q, 'asset', id));
      return row;
    }, { fk: 'parentId or assetTypeId does not exist for this client' }));
  }

  // ---------------------------------------------------------------- deletes (org_admin only)
  @Delete('assets/:id') @Roles(...ADMINS)
  deleteAsset(@Claims() c: TokenClaims, @Param('id') id: string) { return this.remove(c, 'asset', 'asset', id); }

  @Delete('sites/:id') @Roles(...ADMINS)
  deleteSite(@Claims() c: TokenClaims, @Param('id') id: string) { return this.remove(c, 'site', 'site', id); }

  @Delete('regions/:id') @Roles(...ADMINS)
  deleteRegion(@Claims() c: TokenClaims, @Param('id') id: string) { return this.remove(c, 'region', 'region', id); }

  @Delete('asset-types/:id') @Roles(...ADMINS)
  deleteType(@Claims() c: TokenClaims, @Param('id') id: string) { return this.remove(c, 'asset_type', 'asset_type', id); }

  @Delete('clients/:id') @Roles(...ADMINS)
  deleteClient(@Claims() c: TokenClaims, @Param('id') id: string) { return this.remove(c, 'client', 'client', id); }

  private remove(c: TokenClaims, table: string, entity: string, id: string) {
    return this.db.withTenant(tenant(c), async (q) => {
      const clientId = await clientOf(q, table, id);
      await deleteRow(q, table, id);
      // Audit rows reference the client only by id (no FK), so they survive the deletion.
      await audit(q, c, 'delete', entity, id, clientId);
      return { deleted: id };
    });
  }

  // ---------------------------------------------------------------- saved forecast scenarios
  @Get('clients/:clientId/scenarios')
  listScenarios(@Claims() c: TokenClaims, @Param('clientId') clientId: string) {
    return this.db.withTenant(tenant(c), async (q) =>
      (await q.query('SELECT id, name, params, created_at FROM forecast_scenario WHERE client_id = $1 ORDER BY lower(name)', [clientId])).rows);
  }

  @Post('clients/:clientId/scenarios') @Roles(...WRITERS)
  createScenario(@Claims() c: TokenClaims, @Param('clientId') clientId: string, @Body() body: unknown) {
    const b = parse(namedScenarioSchema, body);
    return this.db.withTenant(tenant(c), async (q) => {
      if (!(await q.query('SELECT 1 FROM client WHERE id = $1', [clientId])).rows.length) throw new NotFoundException('Client not found');
      const row = (await q.query<{ id: string }>(
        'INSERT INTO forecast_scenario (organisation_id, client_id, name, params) VALUES ($1,$2,$3,$4) RETURNING id, name, params',
        [c.org, clientId, b.name, b.params])).rows[0]!;
      await audit(q, c, 'create', 'forecast_scenario', row.id, clientId);
      return row;
    });
  }

  @Delete('scenarios/:id') @Roles(...WRITERS)
  deleteScenario(@Claims() c: TokenClaims, @Param('id') id: string) { return this.remove(c, 'forecast_scenario', 'forecast_scenario', id); }

  /** Run a saved scenario. Optional ?siteId= narrows to one site. */
  @Post('scenarios/:id/run')
  async runScenario(@Claims() c: TokenClaims, @Param('id') id: string, @Query('siteId') siteId?: string) {
    const saved = await this.db.withTenant(tenant(c), async (q) =>
      (await q.query<{ client_id: string; params: unknown }>('SELECT client_id, params FROM forecast_scenario WHERE id = $1', [id])).rows[0]);
    if (!saved) throw new NotFoundException('Scenario not found');
    // Re-validate: stored params may predate a schema change.
    return runClientForecast(this.db, c, saved.client_id, parse(scenarioSchema, saved.params) as Scenario, siteId);
  }
}
