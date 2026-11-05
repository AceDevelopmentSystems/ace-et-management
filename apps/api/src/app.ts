import {
  BadRequestException, ConflictException, Controller, Get, DynamicModule, Inject, Module, NotFoundException,
  Param, Post, Body, Query, UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CONDITIONS, Scenario } from '@ace/forecast';
import { z } from 'zod';
import { TokenClaims, hashPassword, signToken, verifyPassword, Role } from './auth';
import { Database } from './db';
import { AdminController } from './admin';
import { ContractorsController, ContractsController, WorkOrdersController } from './contracts';
import { TrashController } from './trash';
import { runClientForecast } from './forecast-run';
import { assetCreate, clientCreate, regionCreate, scenarioSchema, siteCreate, typeCreate } from './schemas';
import {
  type AppConfig, AuthGuard, CONFIG, Claims, DB, Public, Roles, WRITERS, audit, parse, requireLive, tenant,
} from './common';

export { DB, CONFIG };
export type { AppConfig };

// ------------------------------------------------------------------ auth
const registerSchema = z.object({
  organisationName: z.string().min(1),
  kind: z.enum(['OWNER', 'CONSULTANCY']),
  email: z.string().email(),
  displayName: z.string().min(1),
  password: z.string().min(10),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1), organisationId: z.string().uuid().optional() });

@Controller('auth')
export class AuthController {
  constructor(@Inject(DB) private db: Database, @Inject(CONFIG) private cfg: AppConfig) {}

  @Public() @Post('register')
  async register(@Body() body: unknown) {
    const b = parse(registerSchema, body);
    const hash = await hashPassword(b.password);
    return this.db.admin(async (q) => {
      const dup = await q.query('SELECT 1 FROM app_user WHERE email = $1', [b.email.toLowerCase()]);
      if (dup.rows.length) throw new ConflictException('Email already registered');
      const org = (await q.query<{ id: string }>('INSERT INTO organisation (name, kind) VALUES ($1,$2) RETURNING id', [b.organisationName, b.kind])).rows[0]!;
      const user = (await q.query<{ id: string }>('INSERT INTO app_user (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [b.email.toLowerCase(), b.displayName, hash])).rows[0]!;
      await q.query(`INSERT INTO membership (user_id, organisation_id, role) VALUES ($1,$2,'org_admin')`, [user.id, org.id]);
      // An OWNER organisation manages its own assets: one implicit client.
      if (b.kind === 'OWNER') await q.query('INSERT INTO client (organisation_id, name) VALUES ($1,$2)', [org.id, b.organisationName]);
      const token = signToken({ sub: user.id, org: org.id, role: 'org_admin', clients: [] }, this.cfg.jwtSecret);
      return { token, organisationId: org.id };
    });
  }

  @Public() @Post('login')
  async login(@Body() body: unknown) {
    const b = parse(loginSchema, body);
    const found = await this.db.admin(async (q) => {
      const u = (await q.query<{ id: string; password_hash: string }>('SELECT id, password_hash FROM app_user WHERE email = $1', [b.email.toLowerCase()])).rows[0];
      if (!u) return null;
      const ms = (await q.query<{ organisation_id: string; role: Role }>('SELECT organisation_id, role FROM membership WHERE user_id = $1', [u.id])).rows;
      const m = b.organisationId ? ms.find((x) => x.organisation_id === b.organisationId) : ms[0];
      const clients = m ? (await q.query<{ client_id: string }>('SELECT client_id FROM client_grant WHERE user_id = $1 AND organisation_id = $2', [u.id, m.organisation_id])).rows.map((r) => r.client_id) : [];
      return { u, m, clients };
    });
    // Same error for unknown user / bad password / no membership.
    const ok = found?.m && (await verifyPassword(b.password, found.u.password_hash));
    if (!found || !found.m || !ok) throw new UnauthorizedException('Invalid credentials');
    return { token: signToken({ sub: found.u.id, org: found.m.organisation_id, role: found.m.role, clients: found.clients }, this.cfg.jwtSecret) };
  }
}

// ------------------------------------------------------------------ register: clients, sites, types, assets
@Controller()
export class RegisterController {
  constructor(@Inject(DB) private db: Database) {}

  @Get('clients')
  clients(@Claims() c: TokenClaims) {
    return this.db.withTenant(tenant(c), async (q) => (await q.query('SELECT id, name, code, currency FROM client ORDER BY lower(name)')).rows);
  }

  @Post('clients') @Roles(...WRITERS)
  createClient(@Claims() c: TokenClaims, @Body() body: unknown) {
    const b = parse(clientCreate, body);
    return this.db.withTenant(tenant(c), async (q) => {
      const row = (await q.query<{ id: string }>('INSERT INTO client (organisation_id, name, code, currency) VALUES ($1,$2,$3,$4) RETURNING id, name, code, currency', [c.org, b.name, b.code ?? null, b.currency])).rows[0]!;
      await audit(q, c, 'create', 'client', row.id, row.id);
      return row;
    });
  }

  @Get('sites/:siteId')
  site(@Claims() c: TokenClaims, @Param('siteId') siteId: string) {
    return this.db.withTenant(tenant(c), async (q) => {
      const row = (await q.query(
        `SELECT s.id, s.client_id, s.code, s.name, s.site_class, s.address, s.region_id, d.code AS region_code, d.name AS region_name
           FROM site s LEFT JOIN region d ON d.id = s.region_id WHERE s.id = $1`, [siteId])).rows[0];
      if (!row) throw new NotFoundException('Site not found');
      return row;
    });
  }

  @Get('clients/:clientId/sites')
  sites(@Claims() c: TokenClaims, @Param('clientId') clientId: string, @Query('regionId') regionId?: string) {
    return this.db.withTenant(tenant(c), async (q) =>
      (await q.query(
        `SELECT s.id, s.code, s.name, s.site_class, s.address, s.region_id, d.code AS region_code, d.name AS region_name
           FROM site s LEFT JOIN region d ON d.id = s.region_id
          WHERE s.client_id = $1 AND ($2::uuid IS NULL OR s.region_id = $2::uuid) ORDER BY s.code`, [clientId, regionId ?? null])).rows);
  }

  @Get('clients/:clientId/regions')
  regions(@Claims() c: TokenClaims, @Param('clientId') clientId: string) {
    return this.db.withTenant(tenant(c), async (q) =>
      (await q.query(
        `SELECT d.id, d.code, d.name, (SELECT count(*)::int FROM site s WHERE s.region_id = d.id) AS site_count
           FROM region d WHERE d.client_id = $1 ORDER BY d.code`, [clientId])).rows);
  }

  @Post('clients/:clientId/regions') @Roles(...WRITERS)
  createRegion(@Claims() c: TokenClaims, @Param('clientId') clientId: string, @Body() body: unknown) {
    const b = parse(regionCreate, body);
    return this.db.withTenant(tenant(c), async (q) => {
      await this.requireClient(q, clientId);
      try {
        const row = (await q.query<{ id: string }>(
          'INSERT INTO region (organisation_id, client_id, code, name) VALUES ($1,$2,$3,$4) RETURNING id, code, name', [c.org, clientId, b.code, b.name])).rows[0]!;
        await audit(q, c, 'create', 'region', row.id, clientId);
        return row;
      } catch (e: any) {
        if (e?.code === '23505') throw new ConflictException('Region code already exists for this client');
        throw e;
      }
    });
  }

  @Post('clients/:clientId/sites') @Roles(...WRITERS)
  createSite(@Claims() c: TokenClaims, @Param('clientId') clientId: string, @Body() body: unknown) {
    const b = parse(siteCreate, body);
    return this.db.withTenant(tenant(c), async (q) => {
      await this.requireClient(q, clientId);
      await requireLive(q, 'region', b.regionId, clientId, 'regionId');
      try {
        const row = (await q.query<{ id: string }>(
          `INSERT INTO site (organisation_id, client_id, region_id, code, name, site_class, address, latitude, longitude, hazards, attributes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, code, name`,
          [c.org, clientId, b.regionId ?? null, b.code, b.name, b.siteClass ?? null, b.address ?? null, b.latitude ?? null, b.longitude ?? null, b.hazards ?? null, b.attributes])).rows[0]!;
        await audit(q, c, 'create', 'site', row.id, clientId);
        return row;
      } catch (e: any) {
        if (e?.code === '23505') throw new ConflictException('Site code already exists for this client');
        if (e?.code === '23503') throw new BadRequestException('regionId does not exist for this client');
        throw e;
      }
    });
  }

  @Get('clients/:clientId/asset-types')
  types(@Claims() c: TokenClaims, @Param('clientId') clientId: string) {
    return this.db.withTenant(tenant(c), async (q) =>
      (await q.query('SELECT id, parent_id, name, expected_life_years, unit, unit_rate FROM asset_type WHERE client_id = $1 ORDER BY name', [clientId])).rows);
  }

  @Post('clients/:clientId/asset-types') @Roles(...WRITERS)
  createType(@Claims() c: TokenClaims, @Param('clientId') clientId: string, @Body() body: unknown) {
    const b = parse(typeCreate, body);
    return this.db.withTenant(tenant(c), async (q) => {
      await this.requireClient(q, clientId);
      await requireLive(q, 'asset_type', b.parentId, clientId, 'parentId');
      try {
        const row = (await q.query<{ id: string }>(
          'INSERT INTO asset_type (organisation_id, client_id, parent_id, name, expected_life_years, unit, unit_rate) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name',
          [c.org, clientId, b.parentId ?? null, b.name, b.expectedLifeYears ?? null, b.unit ?? null, b.unitRate ?? null])).rows[0]!;
        await audit(q, c, 'create', 'asset_type', row.id, clientId);
        return row;
      } catch (e: any) {
        if (e?.code === '23503') throw new BadRequestException('parentId does not exist for this client');
        throw e;
      }
    });
  }

  @Get('sites/:siteId/assets')
  assets(@Claims() c: TokenClaims, @Param('siteId') siteId: string) {
    return this.db.withTenant(tenant(c), async (q) =>
      (await q.query('SELECT id, parent_id, asset_type_id, name, install_date, quantity, unit, unit_rate, expected_life_years, criticality FROM asset WHERE site_id = $1 ORDER BY name', [siteId])).rows);
  }

  @Post('sites/:siteId/assets') @Roles(...WRITERS)
  createAsset(@Claims() c: TokenClaims, @Param('siteId') siteId: string, @Body() body: unknown) {
    const b = parse(assetCreate, body);
    return this.db.withTenant(tenant(c), async (q) => {
      const site = (await q.query<{ client_id: string }>('SELECT client_id FROM site WHERE id = $1', [siteId])).rows[0];
      if (!site) throw new NotFoundException('Site not found');
      await requireLive(q, 'asset', b.parentId, site.client_id, 'parentId');
      await requireLive(q, 'asset_type', b.assetTypeId, site.client_id, 'assetTypeId');
      try {
        const row = (await q.query<{ id: string }>(
          `INSERT INTO asset (organisation_id, client_id, site_id, parent_id, asset_type_id, name, manufacturer, serial_number, install_date,
             quantity, unit, unit_rate, expected_life_years, criticality, attributes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, name`,
          [c.org, site.client_id, siteId, b.parentId ?? null, b.assetTypeId ?? null, b.name, b.manufacturer ?? null, b.serialNumber ?? null,
            b.installDate ?? null, b.quantity, b.unit ?? null, b.unitRate ?? null, b.expectedLifeYears ?? null, b.criticality ?? null, b.attributes])).rows[0]!;
        await audit(q, c, 'create', 'asset', row.id, site.client_id);
        return row;
      } catch (e: any) {
        if (e?.code === '23503') throw new BadRequestException('parentId or assetTypeId does not exist for this client');
        throw e;
      }
    });
  }

  private async requireClient(q: { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }, clientId: string) {
    if (!(await q.query('SELECT 1 FROM client WHERE id = $1', [clientId])).rows.length) throw new NotFoundException('Client not found');
  }
}

// ------------------------------------------------------------------ inspections / assessments
const conditionSchema = z.object({ percent: z.number().min(0).max(100), remainingLife: z.number().int().min(0).default(0) });
const assessmentSchema = z.object({
  assetId: z.string().uuid(),
  conditions: z.partialRecord(z.enum(CONDITIONS), conditionSchema),
  qualityConfidence: z.enum(['A', 'B', 'C']).default('A'),
  quantityConfidence: z.enum(['A', 'B', 'C']).default('A'),
  assessedQuantity: z.number().nonnegative().optional(),
  maintenanceCost: z.number().nonnegative().optional(),
  comments: z.string().optional(),
}).refine((a) => {
  const total = Object.values(a.conditions).reduce((n, v) => n + (v?.percent ?? 0), 0);
  return Math.abs(total - 100) < 0.01 || total === 0;
}, { message: 'condition percentages must total 100 (or 0 if unassessed)', path: ['conditions'] });
const inspectionSchema = z.object({
  inspectedOn: z.string().date(), inspector: z.string().optional(), notes: z.string().optional(),
  assessments: z.array(assessmentSchema).min(1),
});

@Controller()
export class InspectionController {
  constructor(@Inject(DB) private db: Database) {}

  @Post('sites/:siteId/inspections') @Roles('org_admin', 'asset_manager', 'assessor')
  create(@Claims() c: TokenClaims, @Param('siteId') siteId: string, @Body() body: unknown) {
    const b = parse(inspectionSchema, body);
    return this.db.withTenant(tenant(c), async (q) => {
      const site = (await q.query<{ client_id: string }>('SELECT client_id FROM site WHERE id = $1', [siteId])).rows[0];
      if (!site) throw new NotFoundException('Site not found');
      const insp = (await q.query<{ id: string }>(
        'INSERT INTO inspection (organisation_id, client_id, site_id, inspected_on, inspector, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [c.org, site.client_id, siteId, b.inspectedOn, b.inspector ?? null, b.notes ?? null])).rows[0]!;
      for (const a of b.assessments) {
        // The asset must belong to this site; RLS already limits visibility to the tenant.
        const owns = await q.query('SELECT 1 FROM asset WHERE id = $1 AND site_id = $2', [a.assetId, siteId]);
        if (!owns.rows.length) throw new BadRequestException(`Asset ${a.assetId} is not at this site`);
        try {
          await q.query(
            `INSERT INTO assessment (organisation_id, client_id, inspection_id, asset_id, conditions, quality_confidence, quantity_confidence,
               assessed_quantity, maintenance_cost, comments) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [c.org, site.client_id, insp.id, a.assetId, a.conditions, a.qualityConfidence, a.quantityConfidence, a.assessedQuantity ?? null, a.maintenanceCost ?? null, a.comments ?? null]);
        } catch (e: any) {
          if (e?.code === '23505') throw new BadRequestException(`Asset ${a.assetId} appears more than once in this inspection`);
          throw e;
        }
      }
      await audit(q, c, 'create', 'inspection', insp.id, site.client_id);
      return { id: insp.id, assessments: b.assessments.length };
    });
  }

  @Get('assets/:assetId/assessments')
  history(@Claims() c: TokenClaims, @Param('assetId') assetId: string) {
    return this.db.withTenant(tenant(c), async (q) => {
      // History of a deleted (or foreign) asset is not served; the asset itself is hidden by row level security.
      if (!(await q.query('SELECT 1 FROM asset WHERE id = $1', [assetId])).rows.length) throw new NotFoundException('Asset not found');
      return (await q.query(
        `SELECT i.inspected_on, a.conditions, a.quality_confidence, a.quantity_confidence, a.assessed_quantity, a.maintenance_cost, a.comments
           FROM assessment a JOIN inspection i ON i.id = a.inspection_id WHERE a.asset_id = $1 ORDER BY i.inspected_on DESC`, [assetId])).rows;
    });
  }
}

// ------------------------------------------------------------------ forecast
@Controller()
export class ForecastController {
  constructor(@Inject(DB) private db: Database) {}

  /** Ad hoc forecast from a scenario in the request body. Saved scenarios live in AdminController. */
  @Post('clients/:clientId/forecast')
  run(@Claims() c: TokenClaims, @Param('clientId') clientId: string, @Body() body: unknown, @Query('siteId') siteId?: string) {
    return runClientForecast(this.db, c, clientId, parse(scenarioSchema, body) as Scenario, siteId);
  }
}

// ------------------------------------------------------------------ module
@Controller('health')
export class HealthController {
  @Public() @Get() ok() { return { status: 'ok' }; }
}

@Module({})
export class AppModule {
  static register(db: Database, config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, RegisterController, InspectionController, ForecastController, AdminController, TrashController,
        ContractorsController, ContractsController, WorkOrdersController],
      providers: [
        { provide: DB, useValue: db },
        { provide: CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
