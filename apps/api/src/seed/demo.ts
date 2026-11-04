import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../auth';
import { Database, Queryable } from '../db';
import { inChunks, values } from '../sql';
import { TransmitterFixture } from './parse-transmitters';
import { seedContracts } from './contracts';
import { isoDaysBefore, pick, rng } from './random';

/**
 * Demo / test data for the "Demo Consulting" consultancy: one client (TVNZ) whose regions are the Australian
 * states and whose sites are the digital TV transmitter sites listed on ozdigitaltv.com (src/seed/transmitters.json),
 * plus illustrative asset types, assets and inspections so forecasts have something to project.
 *
 * Idempotent: running it again updates names/regions and tops up sites that have no assets yet; it never
 * duplicates. Deterministic: generated assets depend only on the site code and `asOf`, so two runs agree.
 * Asset prices and lives below are illustrative placeholders, not real figures.
 */

export const DEMO_ORG = 'Demo Consulting';
export const DEMO_CLIENT = { name: 'TVNZ', code: 'TVNZ', currency: 'AUD' };
export const DEMO_EMAIL = 'demo@example.com';
const GENERATOR_VERSION = 'demo-v1';

const here = dirname(fileURLToPath(import.meta.url));
export const loadTransmitters = (): TransmitterFixture => JSON.parse(readFileSync(join(here, 'transmitters.json'), 'utf8'));

export interface SeedOptions {
  /** Password for the demo user if it has to be created. Default: a random one, returned in the result. */
  password?: string;
  /** Generate assets and inspections (default true). */
  assets?: boolean;
  /** Delete the demo client (and everything under it) first. */
  reset?: boolean;
  /** Set the demo user's password to `password` even if the user already exists (requires `password`). */
  resetPassword?: boolean;
  /** Only these state codes, e.g. ['ACT', 'TAS'] (default all). */
  states?: string[];
  /** Reference date YYYY-MM-DD for install dates and inspections (default today). */
  asOf?: string;
  /** Generate contractors, contracts and work orders (default true). */
  contracts?: boolean;
}

export interface SeedResult {
  organisationId: string;
  clientId: string;
  regions: number;
  sites: number;
  assetTypes: number;
  assets: number;
  inspections: number;
  contractors: number;
  contracts: number;
  contractLines: number;
  workOrders: number;
  demoUser: { email: string; /** Only set when the user was created by this run. */ password?: string };
}

const ASSET_TYPES = [
  { name: 'Equipment shelter', life: 40, unit: 'ea', rate: 85000 },
  { name: 'Mast / tower', life: 50, unit: 'ea', rate: 120000 },
  { name: 'UPS / battery bank', life: 8, unit: 'ea', rate: 12000 },
  { name: 'Air conditioning', life: 15, unit: 'ea', rate: 9000 },
  { name: 'Standby generator', life: 25, unit: 'ea', rate: 45000 },
  { name: 'Perimeter fence', life: 30, unit: 'm', rate: 180 },
  { name: 'Access door', life: 25, unit: 'ea', rate: 2500 },
  { name: 'Access road', life: 30, unit: 'm', rate: 220 },
] as const;

type Grade = 'excellent' | 'good' | 'average' | 'poor' | 'veryPoor' | 'urgent';
const GRADES: Grade[] = ['excellent', 'good', 'average', 'poor', 'veryPoor', 'urgent'];

// ------------------------------------------------------------------ the seed
export async function seedDemo(db: Database, opts: SeedOptions = {}): Promise<SeedResult> {
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const fixture = loadTransmitters();
  if (opts.resetPassword && !opts.password) throw new Error('resetPassword needs a password (set DEMO_PASSWORD)');
  const wanted = opts.states?.map((s) => s.toUpperCase());
  const states = fixture.states.filter((s) => !wanted || wanted.includes(s.code));
  if (wanted && states.length !== new Set(wanted).size) {
    throw new Error(`Unknown state code in ${wanted.join(',')}; valid: ${fixture.states.map((s) => s.code).join(', ')}`);
  }

  // 1. organisation, demo user, membership (outside any tenant)
  const { organisationId, userId, demoUser } = await db.admin(async (q) => {
    let org = (await q.query<{ id: string }>(`SELECT id FROM organisation WHERE name = $1 AND kind = 'CONSULTANCY' ORDER BY created_at LIMIT 1`, [DEMO_ORG])).rows[0];
    if (!org) org = (await q.query<{ id: string }>(`INSERT INTO organisation (name, kind) VALUES ($1,'CONSULTANCY') RETURNING id`, [DEMO_ORG])).rows[0]!;
    // The one hard delete in the system: an operator tool, run as the database owner (the app role cannot delete),
    // that wipes the demo client including anything of it already in the Trash. Demo data only.
    if (opts.reset) await q.query('DELETE FROM client WHERE organisation_id = $1 AND code = $2', [org.id, DEMO_CLIENT.code]);
    let user = (await q.query<{ id: string }>('SELECT id FROM app_user WHERE email = $1', [DEMO_EMAIL])).rows[0];
    let createdPassword: string | undefined;
    if (!user) {
      createdPassword = opts.password ?? randomBytes(12).toString('base64url');
      user = (await q.query<{ id: string }>(
        'INSERT INTO app_user (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [DEMO_EMAIL, 'Demo User', await hashPassword(createdPassword)])).rows[0]!;
    }
    if (opts.resetPassword && !createdPassword) {
      await q.query('UPDATE app_user SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(opts.password!)]);
    }
    await q.query(`INSERT INTO membership (user_id, organisation_id, role) VALUES ($1,$2,'org_admin') ON CONFLICT DO NOTHING`, [user.id, org.id]);
    return { organisationId: org.id, userId: user.id, demoUser: { email: DEMO_EMAIL, ...(createdPassword ? { password: createdPassword } : {}) } };
  });

  // 2. everything else as the restricted role, scoped to the organisation (same path the API uses)
  const counts = await db.withTenant({ orgId: organisationId }, async (q) => {

    let client = (await q.query<{ id: string }>('SELECT id FROM client WHERE code = $1', [DEMO_CLIENT.code])).rows[0];
    if (!client) {
      client = (await q.query<{ id: string }>(
        'INSERT INTO client (organisation_id, name, code, currency) VALUES ($1,$2,$3,$4) RETURNING id', [organisationId, DEMO_CLIENT.name, DEMO_CLIENT.code, DEMO_CLIENT.currency])).rows[0]!;
    }
    const clientId = client.id;

    // regions = states
    const regionId = new Map<string, string>();
    for (const st of states) {
      const row = (await q.query<{ id: string }>(
        `INSERT INTO region (organisation_id, client_id, code, name) VALUES ($1,$2,$3,$4)
         ON CONFLICT (organisation_id, client_id, code) WHERE deleted_at IS NULL DO UPDATE SET name = EXCLUDED.name RETURNING id`, [organisationId, clientId, st.code, st.name])).rows[0]!;
      regionId.set(st.code, row.id);
    }

    // sites = transmitters, code "<STATE>-<id>"
    const siteRows = states.flatMap((st) => st.sites.map((s) => ({
      code: `${st.code}-${s.id}`, row: [
        regionId.get(st.code), `${st.code}-${s.id}`, s.name, 'Transmitter', s.description || s.detail || null,
        { coverageAreas: s.coverageAreas, powerStars: s.powerStars, detail: s.detail, source: `https://ozdigitaltv.com/${s.path}` },
      ] as unknown[],
    })));
    const siteIdByCode = new Map<string, string>();
    await inChunks(siteRows, 150, async (chunk) => {
      const v = values(chunk.map((c) => c.row), 2);
      const res = await q.query<{ id: string; code: string }>(
        `INSERT INTO site (organisation_id, client_id, region_id, code, name, site_class, address, attributes)
         SELECT $1, $2, x.region_id::uuid, x.code, x.name, x.site_class, x.address, x.attributes::jsonb FROM (VALUES ${v.sql})
           AS x(region_id, code, name, site_class, address, attributes)
         ON CONFLICT (organisation_id, client_id, code) WHERE deleted_at IS NULL
         DO UPDATE SET region_id = EXCLUDED.region_id, name = EXCLUDED.name, site_class = EXCLUDED.site_class, address = EXCLUDED.address, attributes = EXCLUDED.attributes
         RETURNING id, code`, [organisationId, clientId, ...v.params.map((p) => (p !== null && typeof p === 'object' ? JSON.stringify(p) : p))]);
      for (const r of res.rows) siteIdByCode.set(r.code, r.id);
    });

    // asset types
    const typeId = new Map<string, string>();
    for (const t of ASSET_TYPES) {
      const found = (await q.query<{ id: string }>('SELECT id FROM asset_type WHERE client_id = $1 AND name = $2', [clientId, t.name])).rows[0];
      typeId.set(t.name, found?.id ?? (await q.query<{ id: string }>(
        'INSERT INTO asset_type (organisation_id, client_id, name, expected_life_years, unit, unit_rate) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [organisationId, clientId, t.name, t.life, t.unit, t.rate])).rows[0]!.id);
    }

    // assets + one inspection per site, only for sites that have no assets yet
    if (opts.assets !== false) await seedAssets(q, { organisationId, clientId, asOf, states, siteIdByCode, typeId });

    const n = async (sql: string) => Number((await q.query<{ n: string }>(sql, [clientId])).rows[0]!.n);
    return {
      clientId,
      regions: await n('SELECT count(*) AS n FROM region WHERE client_id = $1'),
      sites: await n('SELECT count(*) AS n FROM site WHERE client_id = $1'),
      assetTypes: await n('SELECT count(*) AS n FROM asset_type WHERE client_id = $1'),
      assets: await n('SELECT count(*) AS n FROM asset WHERE client_id = $1'),
      inspections: await n('SELECT count(*) AS n FROM inspection WHERE client_id = $1'),
    };
  });

  // Contracts and work orders, through the real generator, in their own transaction (it needs include-deleted visibility).
  const contractCounts = opts.contracts === false
    ? { contractors: 0, contracts: 0, contractLines: 0, workOrders: 0 }
    : await seedContracts(db, { organisationId, userId, clientId: counts.clientId, asOf, withAssets: opts.assets !== false });

  return { organisationId, demoUser, ...counts, ...contractCounts };
}

interface AssetCtx {
  organisationId: string; clientId: string; asOf: string; states: TransmitterFixture['states'];
  siteIdByCode: Map<string, string>; typeId: Map<string, string>;
}

async function seedAssets(q: Queryable, c: AssetCtx) {
  const hasAssets = new Set((await q.query<{ site_id: string }>('SELECT DISTINCT site_id FROM asset WHERE client_id = $1', [c.clientId])).rows.map((r) => r.site_id));
  const types = new Map<string, (typeof ASSET_TYPES)[number]>(ASSET_TYPES.map((t) => [t.name, t]));

  const assets: unknown[][] = [];
  const inspections: unknown[][] = [];
  const assessments: unknown[][] = [];

  for (const st of c.states) {
    for (const s of st.sites) {
      const code = `${st.code}-${s.id}`;
      const siteId = c.siteIdByCode.get(code)!;
      if (hasAssets.has(siteId)) continue;
      const r = rng(`${GENERATOR_VERSION}:${code}`);
      const stars = s.powerStars;

      const plan: { type: string; qty: number }[] = [
        { type: 'Equipment shelter', qty: 1 },
        { type: 'Mast / tower', qty: 1 },
        { type: 'UPS / battery bank', qty: stars >= 4 ? 2 : 1 },
        { type: 'Air conditioning', qty: 1 + (stars >= 3 ? 1 : 0) + (stars >= 5 ? 1 : 0) },
        { type: 'Perimeter fence', qty: Math.round(40 + stars * 20 + r() * 40) },
        { type: 'Access door', qty: 1 + Math.round(r()) },
      ];
      if (stars >= 3 && r() < 0.8) plan.push({ type: 'Standby generator', qty: 1 });
      if (r() < 0.4) plan.push({ type: 'Access road', qty: Math.round(100 + r() * 700) });

      const inspectionId = randomUUID();
      inspections.push([inspectionId, siteId, isoDaysBefore(c.asOf, Math.floor(r() * 540)), 'Demo inspector']);

      for (const p of plan) {
        const t = types.get(p.type)!;
        const ageYears = 2 + r() * (t.life * 1.1 - 2); // can run past end of life, giving some overdue work
        const left = t.life - ageYears;
        const ratio = left / t.life;
        const grade: Grade = ratio > 0.7 ? 'excellent' : ratio > 0.5 ? 'good' : ratio > 0.3 ? 'average' : ratio > 0.15 ? 'poor' : ratio > 0 ? 'veryPoor' : 'urgent';
        const life = Math.max(0, Math.round(left));
        // ~10% of assets are part one grade, part the next worse
        const conditions: Record<string, { percent: number; remainingLife: number }> = {};
        const worse = GRADES[GRADES.indexOf(grade) + 1];
        if (worse && r() < 0.1) {
          conditions[grade] = { percent: 70, remainingLife: life };
          conditions[worse] = { percent: 30, remainingLife: Math.max(0, Math.round(life * 0.5)) };
        } else {
          conditions[grade] = { percent: 100, remainingLife: life };
        }
        const conf = (): 'A' | 'B' | 'C' => pick(r, [['A', 6], ['B', 3], ['C', 1]]);
        const assetId = randomUUID();
        assets.push([assetId, siteId, c.typeId.get(p.type), p.type, p.qty, isoDaysBefore(c.asOf, Math.round(ageYears * 365.25))]);
        assessments.push([inspectionId, assetId, conditions, conf(), conf()]);
      }
    }
  }

  const json = (row: unknown[]) => row.map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
  await inChunks(inspections, 200, async (chunk) => {
    const v = values(chunk, 2);
    await q.query(
      `INSERT INTO inspection (organisation_id, client_id, id, site_id, inspected_on, inspector)
       SELECT $1, $2, x.id::uuid, x.site_id::uuid, x.d::date, x.inspector FROM (VALUES ${v.sql}) AS x(id, site_id, d, inspector)`, [c.organisationId, c.clientId, ...v.params]);
  });
  await inChunks(assets, 200, async (chunk) => {
    const v = values(chunk, 2);
    await q.query(
      `INSERT INTO asset (organisation_id, client_id, id, site_id, asset_type_id, name, quantity, install_date)
       SELECT $1, $2, x.id::uuid, x.site_id::uuid, x.type_id::uuid, x.name, x.qty::numeric, x.installed::date FROM (VALUES ${v.sql}) AS x(id, site_id, type_id, name, qty, installed)`,
      [c.organisationId, c.clientId, ...v.params]);
  });
  await inChunks(assessments, 200, async (chunk) => {
    const v = values(chunk.map(json), 2);
    await q.query(
      `INSERT INTO assessment (organisation_id, client_id, inspection_id, asset_id, conditions, quality_confidence, quantity_confidence)
       SELECT $1, $2, x.inspection_id::uuid, x.asset_id::uuid, x.conditions::jsonb, x.q, x.n FROM (VALUES ${v.sql}) AS x(inspection_id, asset_id, conditions, q, n)`,
      [c.organisationId, c.clientId, ...v.params]);
  });
}
