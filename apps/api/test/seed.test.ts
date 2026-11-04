import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app';
import { Database } from '../src/db';
import { DEMO_CLIENT, DEMO_EMAIL, DEMO_ORG, loadTransmitters, seedDemo } from '../src/seed/demo';
import { createTestDb } from './helpers';

const PASSWORD = 'seed-test-password-1';
const AS_OF = '2026-01-15';
const fixture = loadTransmitters();
const count = (codes: string[]) => fixture.states.filter((s) => codes.includes(s.code)).reduce((n, s) => n + s.sites.length, 0);

let db: Database;
let cleanup: () => Promise<void>;
let app: INestApplication;
let orgId: string;
const http = () => request(app.getHttpServer());

/** Stable fingerprint of everything generated, to compare runs. */
const fingerprint = () => db.withTenant({ orgId }, async (q) => (await q.query<{ f: string }>(
  `SELECT md5(string_agg(s.code || ':' || a.name || ':' || a.quantity || ':' || a.install_date || ':' || x.conditions::text || x.quality_confidence,
                        '|' ORDER BY s.code, a.name)) AS f
     FROM asset a JOIN site s ON s.id = a.site_id JOIN assessment x ON x.asset_id = a.id`)).rows[0]!.f);
const scalar = (sql: string, params: unknown[] = []) => db.withTenant({ orgId }, async (q) => Number((await q.query<{ n: string }>(sql, params)).rows[0]!.n));

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const mod = await Test.createTestingModule({ imports: [AppModule.register(db, { jwtSecret: 'x'.repeat(40) })] }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
});
afterAll(async () => { await app.close(); await cleanup(); });

describe('demo seed', () => {
  const subset = ['ACT', 'TAS'];

  it('creates Demo Consulting with state regions and transmitter sites', async () => {
    const r = await seedDemo(db, { states: subset, password: PASSWORD, asOf: AS_OF });
    orgId = r.organisationId;
    expect(r.regions).toBe(2);
    expect(r.sites).toBe(count(subset));
    expect(r.assetTypes).toBe(8);
    expect(r.assets).toBeGreaterThan(r.sites * 4);
    expect(r.inspections).toBe(r.sites);
    expect(r.demoUser).toEqual({ email: DEMO_EMAIL, password: PASSWORD });

    const regions = await db.withTenant({ orgId }, async (q) => (await q.query<{ code: string; name: string }>('SELECT code, name FROM region ORDER BY code')).rows);
    expect(regions).toEqual([{ code: 'ACT', name: 'Australian Capital Territory' }, { code: 'TAS', name: 'Tasmania' }]);

    const site = await db.withTenant({ orgId }, async (q) => (await q.query<any>(
      `SELECT s.code, s.name, s.site_class, s.address, s.attributes, r.code AS region FROM site s JOIN region r ON r.id = s.region_id WHERE s.code = 'ACT-3'`)).rows[0]);
    expect(site).toMatchObject({ code: 'ACT-3', name: 'Black Mountain', site_class: 'Transmitter', region: 'ACT' });
    expect(site.attributes).toMatchObject({ powerStars: 5, coverageAreas: ['Canberra'] });
    expect(site.attributes.source).toBe('https://ozdigitaltv.com/transmitters/ACT/3-Black-Mountain');

    const client = await db.withTenant({ orgId }, async (q) => (await q.query<any>('SELECT name, code, currency FROM client')).rows);
    expect(client).toEqual([DEMO_CLIENT]);
    const org = await db.admin(async (q) => (await q.query<any>('SELECT name, kind FROM organisation WHERE id = $1', [orgId])).rows[0]);
    expect(org).toEqual({ name: DEMO_ORG, kind: 'CONSULTANCY' });
  });

  it('every site belongs to exactly one region and all assets use a type', async () => {
    expect(await scalar('SELECT count(*) AS n FROM site WHERE region_id IS NULL')).toBe(0);
    expect(await scalar('SELECT count(*) AS n FROM asset WHERE asset_type_id IS NULL')).toBe(0);
    // every assessment's percentages total 100
    const bad = await db.withTenant({ orgId }, async (q) => (await q.query<{ n: string }>(
      `SELECT count(*) AS n FROM assessment a WHERE (SELECT sum((v->>'percent')::numeric) FROM jsonb_each(a.conditions) AS e(k, v)) <> 100`)).rows[0]!.n);
    expect(Number(bad)).toBe(0);
  });

  it('is idempotent: a second run changes nothing and keeps the existing password', async () => {
    const before = { sites: await scalar('SELECT count(*) AS n FROM site'), assets: await scalar('SELECT count(*) AS n FROM asset'), inspections: await scalar('SELECT count(*) AS n FROM inspection') };
    const f1 = await fingerprint();
    const r = await seedDemo(db, { states: subset, asOf: AS_OF });
    expect({ sites: r.sites, assets: r.assets, inspections: r.inspections }).toEqual(before);
    expect(r.organisationId).toBe(orgId);
    expect(r.demoUser.password).toBeUndefined();
    expect(await fingerprint()).toBe(f1);
    expect(await scalar('SELECT count(*) AS n FROM region')).toBe(2);
  });

  it('updates names on re-run and tops up a site that lost its assets', async () => {
    await db.withTenant({ orgId }, (q) => q.query(`UPDATE site SET name = 'Renamed' WHERE code = 'ACT-3'`));
    // The app role cannot hard-delete (soft delete only), so remove the fixture rows as the database owner.
    await db.admin((q) => q.query(`DELETE FROM asset WHERE site_id = (SELECT id FROM site WHERE code = 'ACT-3' AND organisation_id = $1)`, [orgId]));
    const assetsBefore = await scalar('SELECT count(*) AS n FROM asset');
    const f1 = await fingerprint();
    await seedDemo(db, { states: subset, asOf: AS_OF });
    expect(await scalar(`SELECT count(*) AS n FROM site WHERE code = 'ACT-3' AND name = 'Black Mountain'`)).toBe(1);
    expect(await scalar('SELECT count(*) AS n FROM asset')).toBeGreaterThan(assetsBefore);
    expect(await fingerprint()).not.toBe(f1);
    // regenerated assets for that site are the same ones as before
    await seedDemo(db, { states: subset, asOf: AS_OF, reset: true });
    const f2 = await fingerprint();
    await seedDemo(db, { states: subset, asOf: AS_OF, reset: true });
    expect(await fingerprint()).toBe(f2); // deterministic across full rebuilds
  });

  it('reset rebuilds only the demo client and --no-assets skips assets', async () => {
    await seedDemo(db, { states: ['NT'], asOf: AS_OF, reset: true, assets: false });
    expect(await scalar('SELECT count(*) AS n FROM site')).toBe(count(['NT']));
    expect(await scalar('SELECT count(*) AS n FROM asset')).toBe(0);
    expect(await scalar('SELECT count(*) AS n FROM client')).toBe(1);
    // Without reset a run only adds to what exists, so an extra state stays; reset rebuilds exactly the subset.
    await seedDemo(db, { states: subset, asOf: AS_OF });
    expect(await scalar('SELECT count(*) AS n FROM region')).toBe(3);
    await seedDemo(db, { states: subset, asOf: AS_OF, reset: true }); // restore for the API tests below
    expect(await scalar('SELECT count(*) AS n FROM region')).toBe(2);
  });

  it('resets the demo password only when asked, and refuses to do so without one', async () => {
    const login = (password: string) => http().post('/api/auth/login').send({ email: DEMO_EMAIL, password });
    await seedDemo(db, { states: subset, asOf: AS_OF, password: 'another-password-2' }); // exists: ignored
    expect((await login(PASSWORD)).status).toBe(201);
    expect((await login('another-password-2')).status).toBe(401);
    await seedDemo(db, { states: subset, asOf: AS_OF, password: 'another-password-2', resetPassword: true });
    expect((await login('another-password-2')).status).toBe(201);
    expect((await login(PASSWORD)).status).toBe(401);
    await seedDemo(db, { states: subset, asOf: AS_OF, password: PASSWORD, resetPassword: true }); // back for later tests
    await expect(seedDemo(db, { states: subset, resetPassword: true })).rejects.toThrow(/needs a password/);
  });

  it('rejects an unknown state code', async () => {
    await expect(seedDemo(db, { states: ['XX'] })).rejects.toThrow(/Unknown state code/);
  });
});

describe('seeded data through the API', () => {
  let token: string;
  let clientId: string;

  it('the demo user can sign in and sees the demo client, regions and sites', async () => {
    const login = await http().post('/api/auth/login').send({ email: DEMO_EMAIL, password: PASSWORD });
    expect(login.status).toBe(201);
    token = login.body.token;
    const auth = { Authorization: `Bearer ${token}` };

    const clients = (await http().get('/api/clients').set(auth)).body;
    expect(clients).toHaveLength(1);
    clientId = clients[0].id;

    const regions = (await http().get(`/api/clients/${clientId}/regions`).set(auth)).body;
    expect(regions.map((r: any) => [r.code, r.name, r.site_count])).toEqual([
      ['ACT', 'Australian Capital Territory', count(['ACT'])], ['TAS', 'Tasmania', count(['TAS'])],
    ]);

    const all = (await http().get(`/api/clients/${clientId}/sites`).set(auth)).body;
    expect(all).toHaveLength(count(['ACT', 'TAS']));
    expect(all.find((s: any) => s.code === 'ACT-3')).toMatchObject({ region_code: 'ACT', region_name: 'Australian Capital Territory' });

    const tas = regions.find((r: any) => r.code === 'TAS');
    const filtered = (await http().get(`/api/clients/${clientId}/sites?regionId=${tas.id}`).set(auth)).body;
    expect(filtered).toHaveLength(count(['TAS']));
    expect(filtered.every((s: any) => s.region_code === 'TAS')).toBe(true);
  });

  it('a forecast over the seeded estate produces a budget with nothing skipped', async () => {
    const f = await http().post(`/api/clients/${clientId}/forecast`).set({ Authorization: `Bearer ${token}` }).send({ startYear: 2026, horizonYears: 20, inflation: 0.03, discountRate: 0.06 });
    expect(f.status).toBe(201);
    expect(f.body.skipped).toEqual([]);
    expect(f.body.assetsAssessed).toBeGreaterThan(count(['ACT', 'TAS']) * 4);
    expect(f.body.totals.nominal).toBeGreaterThan(f.body.totals.presentValue);
    expect(f.body.totals.real).toBeGreaterThan(0);
    expect(Object.keys(f.body.bySite)).toHaveLength(count(['ACT', 'TAS']));
  });

  it('another organisation sees none of the demo data', async () => {
    const r = await http().post('/api/auth/register').send({ organisationName: 'Other', kind: 'OWNER', email: 'other-seed@example.com', displayName: 'O', password: 'correct-horse-battery' });
    const other = { Authorization: `Bearer ${r.body.token}` };
    expect((await http().get(`/api/clients/${clientId}/regions`).set(other)).body).toEqual([]);
    expect((await http().get(`/api/clients/${clientId}/sites`).set(other)).body).toEqual([]);
  });
});

describe('full seed', () => {
  it('seeds every state and all transmitter sites in a fresh database', async () => {
    const { db: db2, cleanup: cleanup2 } = await createTestDb();
    try {
      const all = fixture.states.reduce((n, s) => n + s.sites.length, 0);
      const t0 = Date.now();
      const r = await seedDemo(db2, { password: PASSWORD, asOf: AS_OF });
      expect(r.regions).toBe(fixture.states.length);
      expect(r.sites).toBe(all);
      expect(r.inspections).toBe(all);
      expect(r.assets).toBeGreaterThan(all * 4);
      expect(Date.now() - t0).toBeLessThan(60_000);
    } finally {
      await cleanup2();
    }
  }, 120_000);
});
