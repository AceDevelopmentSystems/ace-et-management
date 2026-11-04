import {
  BadRequestException, CanActivate, ConflictException, Controller, ExecutionContext, ForbiddenException, Get,
  DynamicModule, Inject, Injectable, Module, NotFoundException, Param, Post, Body, Query, SetMetadata, UnauthorizedException,
  UseGuards, createParamDecorator,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { CONDITIONS, Scenario, runForecast } from '@ace/forecast';
import { z, ZodTypeAny } from 'zod';
import { Role, TokenClaims, hashPassword, signToken, verifyPassword, verifyToken } from './auth';
import { Database, TenantContext } from './db';
import { ForecastRow, toAssessedAsset } from './forecast-map';

export const DB = 'DB';
export const CONFIG = 'CONFIG';
export interface AppConfig { jwtSecret: string }

// ------------------------------------------------------------------ helpers
const ROLES_KEY = 'roles';
const PUBLIC_KEY = 'public';
const Public = () => SetMetadata(PUBLIC_KEY, true);
const Roles = (...r: Role[]) => SetMetadata(ROLES_KEY, r);
const WRITERS: Role[] = ['org_admin', 'asset_manager'];

const Claims = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().claims as TokenClaims);
const tenant = (c: TokenClaims): TenantContext => ({ orgId: c.org, clientIds: c.clients });

function parse<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  return r.data;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(CONFIG) private cfg: AppConfig, @Inject(Reflector) private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers.authorization ?? '';
    const claims = header.startsWith('Bearer ') ? verifyToken(header.slice(7), this.cfg.jwtSecret) : null;
    if (!claims) throw new UnauthorizedException();
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(claims.role)) throw new ForbiddenException('Insufficient role');
    req.claims = claims;
    return true;
  }
}

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
const clientSchema = z.object({ name: z.string().min(1), code: z.string().min(1).optional(), currency: z.string().length(3).default('NZD') });
const siteSchema = z.object({
  code: z.string().min(1), name: z.string().min(1), siteClass: z.string().optional(), address: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
  hazards: z.string().optional(), attributes: z.record(z.string(), z.unknown()).default({}),
});
const typeSchema = z.object({
  name: z.string().min(1), parentId: z.string().uuid().optional(), expectedLifeYears: z.number().int().positive().optional(),
  unit: z.string().optional(), unitRate: z.number().nonnegative().optional(),
});
const assetSchema = z.object({
  name: z.string().min(1), parentId: z.string().uuid().optional(), assetTypeId: z.string().uuid().optional(),
  manufacturer: z.string().optional(), serialNumber: z.string().optional(), installDate: z.string().date().optional(),
  quantity: z.number().nonnegative().default(1), unit: z.string().optional(), unitRate: z.number().nonnegative().optional(),
  expectedLifeYears: z.number().int().positive().optional(), criticality: z.number().int().min(1).max(5).optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
});

@Controller()
export class RegisterController {
  constructor(@Inject(DB) private db: Database) {}

  @Get('clients')
  clients(@Claims() c: TokenClaims) {
    return this.db.withTenant(tenant(c), async (q) => (await q.query('SELECT id, name, code, currency FROM client ORDER BY lower(name)')).rows);
  }

  @Post('clients') @Roles(...WRITERS)
  createClient(@Claims() c: TokenClaims, @Body() body: unknown) {
    const b = parse(clientSchema, body);
    return this.db.withTenant(tenant(c), async (q) =>
      (await q.query('INSERT INTO client (organisation_id, name, code, currency) VALUES ($1,$2,$3,$4) RETURNING id, name, code, currency', [c.org, b.name, b.code ?? null, b.currency])).rows[0]);
  }

  @Get('clients/:clientId/sites')
  sites(@Claims() c: TokenClaims, @Param('clientId') clientId: string) {
    return this.db.withTenant(tenant(c), async (q) =>
      (await q.query('SELECT id, code, name, site_class, address FROM site WHERE client_id = $1 ORDER BY code', [clientId])).rows);
  }

  @Post('clients/:clientId/sites') @Roles(...WRITERS)
  createSite(@Claims() c: TokenClaims, @Param('clientId') clientId: string, @Body() body: unknown) {
    const b = parse(siteSchema, body);
    return this.db.withTenant(tenant(c), async (q) => {
      await this.requireClient(q, clientId);
      try {
        return (await q.query(
          `INSERT INTO site (organisation_id, client_id, code, name, site_class, address, latitude, longitude, hazards, attributes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, code, name`,
          [c.org, clientId, b.code, b.name, b.siteClass ?? null, b.address ?? null, b.latitude ?? null, b.longitude ?? null, b.hazards ?? null, b.attributes])).rows[0];
      } catch (e: any) {
        if (e?.code === '23505') throw new ConflictException('Site code already exists for this client');
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
    const b = parse(typeSchema, body);
    return this.db.withTenant(tenant(c), async (q) => {
      await this.requireClient(q, clientId);
      return (await q.query(
        'INSERT INTO asset_type (organisation_id, client_id, parent_id, name, expected_life_years, unit, unit_rate) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name',
        [c.org, clientId, b.parentId ?? null, b.name, b.expectedLifeYears ?? null, b.unit ?? null, b.unitRate ?? null])).rows[0];
    });
  }

  @Get('sites/:siteId/assets')
  assets(@Claims() c: TokenClaims, @Param('siteId') siteId: string) {
    return this.db.withTenant(tenant(c), async (q) =>
      (await q.query('SELECT id, parent_id, asset_type_id, name, install_date, quantity, unit, unit_rate, expected_life_years, criticality FROM asset WHERE site_id = $1 ORDER BY name', [siteId])).rows);
  }

  @Post('sites/:siteId/assets') @Roles(...WRITERS)
  createAsset(@Claims() c: TokenClaims, @Param('siteId') siteId: string, @Body() body: unknown) {
    const b = parse(assetSchema, body);
    return this.db.withTenant(tenant(c), async (q) => {
      const site = (await q.query<{ client_id: string }>('SELECT client_id FROM site WHERE id = $1', [siteId])).rows[0];
      if (!site) throw new NotFoundException('Site not found');
      try {
        return (await q.query(
          `INSERT INTO asset (organisation_id, client_id, site_id, parent_id, asset_type_id, name, manufacturer, serial_number, install_date,
             quantity, unit, unit_rate, expected_life_years, criticality, attributes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, name`,
          [c.org, site.client_id, siteId, b.parentId ?? null, b.assetTypeId ?? null, b.name, b.manufacturer ?? null, b.serialNumber ?? null,
            b.installDate ?? null, b.quantity, b.unit ?? null, b.unitRate ?? null, b.expectedLifeYears ?? null, b.criticality ?? null, b.attributes])).rows[0];
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
        await q.query(
          `INSERT INTO assessment (organisation_id, client_id, inspection_id, asset_id, conditions, quality_confidence, quantity_confidence,
             assessed_quantity, maintenance_cost, comments) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [c.org, site.client_id, insp.id, a.assetId, a.conditions, a.qualityConfidence, a.quantityConfidence, a.assessedQuantity ?? null, a.maintenanceCost ?? null, a.comments ?? null]);
      }
      return { id: insp.id, assessments: b.assessments.length };
    });
  }

  @Get('assets/:assetId/assessments')
  history(@Claims() c: TokenClaims, @Param('assetId') assetId: string) {
    return this.db.withTenant(tenant(c), async (q) => (await q.query(
      `SELECT i.inspected_on, a.conditions, a.quality_confidence, a.quantity_confidence, a.assessed_quantity, a.maintenance_cost, a.comments
         FROM assessment a JOIN inspection i ON i.id = a.inspection_id WHERE a.asset_id = $1 ORDER BY i.inspected_on DESC`, [assetId])).rows);
  }
}

// ------------------------------------------------------------------ forecast
const scenarioSchema = z.object({
  startYear: z.number().int().min(2000).max(2200),
  horizonYears: z.number().int().min(1).max(50),
  inflation: z.number().min(0).max(1).default(0),
  discountRate: z.number().min(0).max(1).default(0),
  overdue: z.enum(['year1', 'spread', 'ignore']).default('year1'),
  overdueSpreadYears: z.number().int().min(1).max(20).default(3),
  annualCap: z.number().nonnegative().optional(),
});

@Controller()
export class ForecastController {
  constructor(@Inject(DB) private db: Database) {}

  /** Latest assessment per asset, joined with type defaults. */
  @Post('clients/:clientId/forecast')
  async run(@Claims() c: TokenClaims, @Param('clientId') clientId: string, @Body() body: unknown, @Query('siteId') siteId?: string) {
    const scenario: Scenario = parse(scenarioSchema, body);
    const rows = await this.db.withTenant(tenant(c), async (q) => {
      if (!(await q.query('SELECT 1 FROM client WHERE id = $1', [clientId])).rows.length) throw new NotFoundException('Client not found');
      return (await q.query<ForecastRow>(
        `SELECT DISTINCT ON (a.id)
                a.id AS asset_id, a.site_id, a.quantity AS asset_quantity, a.unit_rate AS asset_unit_rate, a.expected_life_years AS asset_life,
                t.unit_rate AS type_unit_rate, t.expected_life_years AS type_life,
                i.inspected_on, s.conditions, s.quality_confidence, s.quantity_confidence, s.assessed_quantity
           FROM asset a
           JOIN assessment s ON s.asset_id = a.id
           JOIN inspection i ON i.id = s.inspection_id
           LEFT JOIN asset_type t ON t.id = a.asset_type_id
          WHERE a.client_id = $1 AND ($2::uuid IS NULL OR a.site_id = $2::uuid)
          ORDER BY a.id, i.inspected_on DESC`, [clientId, siteId ?? null])).rows;
    });
    const result = runForecast(rows.map(toAssessedAsset), scenario);
    const siteOf = new Map(rows.map((r) => [r.asset_id, r.site_id]));
    const bySite: Record<string, Record<number, number>> = {};
    for (const l of result.lines) {
      const s = siteOf.get(l.assetId)!;
      const row = (bySite[s] ??= {});
      row[l.year] = (row[l.year] ?? 0) + l.nominal;
    }
    return {
      scenario,
      assetsAssessed: rows.length - result.skipped.length,
      skipped: result.skipped,
      byYear: result.byYear,
      leveled: result.leveled,
      bySite,
      totals: {
        real: result.byYear.reduce((n, y) => n + y.real, 0),
        nominal: result.byYear.reduce((n, y) => n + y.nominal, 0),
        presentValue: result.byYear.reduce((n, y) => n + y.presentValue, 0),
      },
    };
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
      controllers: [HealthController, AuthController, RegisterController, InspectionController, ForecastController],
      providers: [
        { provide: DB, useValue: db },
        { provide: CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
