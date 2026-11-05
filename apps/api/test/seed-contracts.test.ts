import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app';
import { Database } from '../src/db';
import { DEMO_EMAIL, seedDemo } from '../src/seed/demo';
import { createTestDb } from './helpers';

const PASSWORD = 'seed-test-password-1';
const AS_OF = '2026-01-15';
const subset = ['ACT', 'TAS'];

let db: Database;
let cleanup: () => Promise<void>;
let app: INestApplication;
let orgId: string;
const http = () => request(app.getHttpServer());

const scalar = (sql: string) => db.withTenant({ orgId }, async (q) => Number((await q.query<{ n: string }>(sql)).rows[0]!.n));
const countContractors = () => db.admin(async (q) => Number((await q.query<{ n: string }>('SELECT count(*) AS n FROM contractor')).rows[0]!.n));
const byCode = (sql: string) => db.withTenant({ orgId }, async (q) => Object.fromEntries((await q.query<{ k: string; n: string }>(sql)).rows.map((r) => [r.k, Number(r.n)])));
/** Stable fingerprint of the work orders (ids are random, so use what they mean). */
const woFingerprint = () => db.withTenant({ orgId }, async (q) => (await q.query<{ f: string }>(
  `SELECT md5(string_agg(k.code || ':' || w.number || ':' || w.due_date || ':' || w.status || ':' || COALESCE(w.actual_cost::text, 'none') || ':' || COALESCE(w.completed_on::text, 'none'),
                        '|' ORDER BY k.code, w.number)) AS f FROM work_order w JOIN contract k ON k.id = w.contract_id`)).rows[0]!.f);

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const mod = await Test.createTestingModule({ imports: [AppModule.register(db, { jwtSecret: 'x'.repeat(40) })] }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
});
afterAll(async () => { await app.close(); await cleanup(); });

describe('demo contracts and work orders', () => {
  it('creates three contractors and three contracts with lines, and generated work orders for the active ones', async () => {
    const r = await seedDemo(db, { states: subset, password: PASSWORD, asOf: AS_OF });
    orgId = r.organisationId;
    expect(r).toMatchObject({ contractors: 3, contracts: 3 });
    expect(r.contractLines).toBeGreaterThan(0);
    expect(r.workOrders).toBeGreaterThan(0);

    const contracts = await db.withTenant({ orgId }, async (q) => (await q.query<any>(
      `SELECT k.code, k.status, k.start_date::text AS start_date, k.end_date::text AS end_date, r.name AS contractor FROM contract k JOIN contractor r ON r.id = k.contractor_id ORDER BY k.code`)).rows);
    expect(contracts.map((c) => [c.code, c.status, c.contractor])).toEqual([
      ['AIR', 'active', 'CoolTech Air Services'], ['GRD', 'active', 'Greenline Grounds Ltd'], ['SEC', 'draft', 'SecureFence & Access'],
    ]);
    expect(contracts.every((c) => c.start_date === '2026-01-01' && c.end_date === '2027-12-31')).toBe(true);

    const lines = await byCode(`SELECT k.code AS k, count(*) AS n FROM contract_line l JOIN contract k ON k.id = l.contract_id GROUP BY k.code`);
    expect(lines.GRD).toBeGreaterThan(0);
    expect(lines.AIR).toBeGreaterThan(0);
    const wos = await byCode(`SELECT k.code AS k, count(*) AS n FROM work_order w JOIN contract k ON k.id = w.contract_id GROUP BY k.code`);
    expect(wos.GRD).toBeGreaterThan(0);
    expect(wos.SEC).toBeUndefined(); // a draft contract generates nothing
    expect(await scalar(`SELECT count(*) AS n FROM work_order w JOIN contract_line l ON l.id = w.contract_line_id WHERE l.contract_id <> w.contract_id`)).toBe(0);
    expect(await scalar(`SELECT count(*) AS n FROM work_order w JOIN asset a ON a.id = w.asset_id WHERE a.site_id <> w.site_id`)).toBe(0); // asset work happens at the asset's site
  });

  it('is idempotent: a second run changes nothing, and contractors and tax codes are not duplicated', async () => {
    const fp = await woFingerprint();
    expect(await db.admin(async (q) => Number((await q.query<{ n: string }>('SELECT count(*) AS n FROM tax_code')).rows[0]!.n))).toBe(2);
    const contractors = await countContractors();
    const r = await seedDemo(db, { states: subset, asOf: AS_OF });
    expect(r).toMatchObject({ contractors: 3, contracts: 3 });
    expect(await woFingerprint()).toBe(fp);
    expect(await countContractors()).toBe(contractors);
    expect(await db.admin(async (q) => Number((await q.query<{ n: string }>('SELECT count(*) AS n FROM tax_code')).rows[0]!.n))).toBe(2);
  });

  it('is deterministic across a full rebuild, and reuses the contractors a reset leaves behind', async () => {
    const fp = await woFingerprint();
    const r = await seedDemo(db, { states: subset, asOf: AS_OF, reset: true });
    expect(r.contractors).toBe(3); // organisation-wide, so a client reset keeps them and they are found again
    expect(await countContractors()).toBe(3);
    expect(await woFingerprint()).toBe(fp);
  });

  it('later runs top up the window without touching existing work orders', async () => {
    const before = await scalar('SELECT count(*) AS n FROM work_order');
    await db.withTenant({ orgId }, (q) => q.query(`UPDATE work_order SET status = 'cancelled' WHERE id = (SELECT id FROM work_order WHERE status = 'new' ORDER BY due_date LIMIT 1)`));
    const cancelled = await scalar(`SELECT count(*) AS n FROM work_order WHERE status = 'cancelled'`);
    await seedDemo(db, { states: subset, asOf: AS_OF }); // same window: nothing new, and the status I changed stays
    expect(await scalar('SELECT count(*) AS n FROM work_order')).toBe(before);
    expect(await scalar(`SELECT count(*) AS n FROM work_order WHERE status = 'cancelled'`)).toBe(cancelled);
    await seedDemo(db, { states: subset, asOf: '2026-02-20' }); // a later "today" extends the window by about five weeks
    expect(await scalar('SELECT count(*) AS n FROM work_order')).toBeGreaterThan(before);
    expect(await scalar(`SELECT count(*) AS n FROM work_order WHERE status = 'cancelled'`)).toBe(cancelled);
    await seedDemo(db, { states: subset, asOf: AS_OF, reset: true }); // back to a known state
  });

  it('skips contracts when asked, and has no asset lines without assets', async () => {
    const none = await seedDemo(db, { states: ['NT'], asOf: AS_OF, reset: true, contracts: false });
    expect(none).toMatchObject({ contractors: 0, contracts: 0, contractLines: 0, workOrders: 0 });
    const noAssets = await seedDemo(db, { states: ['NT'], asOf: AS_OF, reset: true, assets: false });
    expect(noAssets.contracts).toBe(3);
    expect(await scalar(`SELECT count(*) AS n FROM contract_line l JOIN contract k ON k.id = l.contract_id WHERE k.code = 'AIR'`)).toBe(0);
    expect(await scalar(`SELECT count(*) AS n FROM contract_line l JOIN contract k ON k.id = l.contract_id WHERE k.code = 'GRD'`)).toBeGreaterThan(0);
    await seedDemo(db, { states: subset, asOf: AS_OF, reset: true });
  });

  it('shows up through the API for the demo user, and not for anyone else', async () => {
    const login = await http().post('/api/auth/login').send({ email: DEMO_EMAIL, password: PASSWORD });
    expect(login.status).toBe(201);
    const auth = { Authorization: `Bearer ${login.body.token}` };
    const clientId = (await http().get('/api/clients').set(auth)).body[0].id;
    const contracts = (await http().get(`/api/clients/${clientId}/contracts`).set(auth)).body;
    expect(contracts.map((c: any) => c.code).sort()).toEqual(['AIR', 'GRD', 'SEC']);
    expect(contracts.find((c: any) => c.code === 'GRD')).toMatchObject({ status: 'active', contractor_name: 'Greenline Grounds Ltd' });
    const wos = (await http().get(`/api/clients/${clientId}/work-orders?limit=500`).set(auth)).body;
    expect(wos.total).toBe(await scalar('SELECT count(*) AS n FROM work_order'));
    expect(wos.items[0]).toMatchObject({ contractor_name: expect.any(String), site_code: expect.any(String) });
    const contractors = (await http().get('/api/contractors').set(auth)).body;
    expect(contractors.map((c: any) => c.name)).toEqual(['CoolTech Air Services', 'Greenline Grounds Ltd', 'SecureFence & Access']);
    expect(contractors.find((c: any) => c.name === 'Greenline Grounds Ltd').contract_count).toBe(1);
    expect((await http().post(`/api/clients/${clientId}/forecast`).set(auth).send({ startYear: 2026, horizonYears: 10 })).body.assetsAssessed).toBeGreaterThan(0); // still forecasts

    const other = await http().post('/api/auth/register').send({ organisationName: 'Other 2', kind: 'OWNER', email: 'other-seed2@example.com', displayName: 'O', password: 'correct-horse-battery' });
    const o = { Authorization: `Bearer ${other.body.token}` };
    expect((await http().get('/api/contractors').set(o)).body).toEqual([]);
    expect((await http().get(`/api/clients/${clientId}/work-orders`).set(o)).body.total).toBe(0);
  });

  it('a full seed has a lived-in history: mostly done, some in progress, a few overdue and cancelled', async () => {
    const { db: db2, cleanup: cleanup2 } = await createTestDb();
    try {
      const r = await seedDemo(db2, { password: PASSWORD, asOf: '2026-10-15' });
      expect(r).toMatchObject({ contractors: 3, contracts: 3 });
      expect(r.contractLines).toBeGreaterThan(100);
      expect(r.workOrders).toBeGreaterThan(500);
      const q2 = <T = { n: string }>(sql: string) => db2.withTenant({ orgId: r.organisationId }, async (q) => (await q.query<T>(sql)).rows);
      const counts = Object.fromEntries((await q2<{ status: string; n: string }>('SELECT status, count(*) AS n FROM work_order GROUP BY status')).map((x) => [x.status, Number(x.n)]));
      expect(counts.complete).toBeGreaterThan(counts.new ?? 0);
      expect(counts.in_progress).toBeGreaterThan(0);
      expect(counts.cancelled).toBeGreaterThan(0);
      expect(Number((await q2(`SELECT count(*) AS n FROM work_order WHERE status IN ('new', 'in_progress') AND due_date < '2026-10-15'`))[0]!.n)).toBeGreaterThan(0); // overdue
      // completed work always has a completion date on or after it was due, and an actual cost
      expect(Number((await q2(`SELECT count(*) AS n FROM work_order WHERE status = 'complete' AND (completed_on IS NULL OR completed_on < due_date OR actual_cost IS NULL)`))[0]!.n)).toBe(0);
      expect(Number((await q2(`SELECT count(*) AS n FROM work_order WHERE completed_on > '2026-10-15'`))[0]!.n)).toBe(0); // nothing completed after the reference date
    } finally {
      await cleanup2();
    }
  }, 120_000);
});
