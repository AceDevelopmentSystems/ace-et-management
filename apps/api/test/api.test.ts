import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app';
import { hashPassword } from '../src/auth';
import { Database } from '../src/db';
import { createTestDb } from './helpers';

let app: INestApplication;
let db: Database;
let cleanup: () => Promise<void>;
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function register(kind: 'OWNER' | 'CONSULTANCY', email: string) {
  const r = await http().post('/api/auth/register').send({ organisationName: email, kind, email, displayName: 'T', password: 'correct-horse-battery' });
  expect(r.status).toBe(201);
  return r.body.token as string;
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const mod = await Test.createTestingModule({ imports: [AppModule.register(db, { jwtSecret: 'x'.repeat(40) })] }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
});
afterAll(async () => { await app.close(); await cleanup(); });

/** Add a user with a given role to the org of an existing token's owner, and return their token. */
async function addUser(ownerToken: string, role: string, email: string, clientIds: string[] = []) {
  const org = JSON.parse(Buffer.from(ownerToken.split('.')[1]!, 'base64url').toString()).org as string;
  const hash = await hashPassword('correct-horse-battery');
  await db.admin(async (q) => {
    const u = (await q.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ($1,'U',$2) RETURNING id`, [email, hash])).rows[0]!;
    await q.query('INSERT INTO membership (user_id, organisation_id, role) VALUES ($1,$2,$3)', [u.id, org, role]);
    for (const cid of clientIds) await q.query('INSERT INTO client_grant (user_id, organisation_id, client_id) VALUES ($1,$2,$3)', [u.id, org, cid]);
  });
  const r = await http().post('/api/auth/login').send({ email, password: 'correct-horse-battery' });
  expect(r.status).toBe(201);
  return r.body.token as string;
}

describe('auth', () => {
  it('requires a token', async () => {
    expect((await http().get('/api/clients')).status).toBe(401);
    expect((await http().get('/api/health')).status).toBe(200);
  });
  it('registers, logs in, rejects bad password and duplicates', async () => {
    await register('OWNER', 'dup@example.com');
    const dup = await http().post('/api/auth/register').send({ organisationName: 'x', kind: 'OWNER', email: 'dup@example.com', displayName: 'T', password: 'correct-horse-battery' });
    expect(dup.status).toBe(409);
    expect((await http().post('/api/auth/login').send({ email: 'dup@example.com', password: 'correct-horse-battery' })).status).toBe(201);
    expect((await http().post('/api/auth/login').send({ email: 'dup@example.com', password: 'wrong' })).status).toBe(401);
    expect((await http().post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong' })).status).toBe(401);
  });
  it('rejects a tampered token', async () => {
    const t = await register('OWNER', 'tamper@example.com');
    const bad = t.slice(0, -2) + (t.endsWith('aa') ? 'bb' : 'aa');
    expect((await http().get('/api/clients').set(auth(bad))).status).toBe(401);
  });
});

describe('register, assessment and forecast flow', () => {
  it('owner org end to end, isolated from another org', async () => {
    const t = await register('OWNER', 'owner@example.com');
    const clients = (await http().get('/api/clients').set(auth(t))).body;
    expect(clients).toHaveLength(1); // implicit client
    const clientId = clients[0].id;

    const site = (await http().post(`/api/clients/${clientId}/sites`).set(auth(t)).send({ code: 'TV1', name: 'Repeater 1' })).body;
    expect(site.id).toBeTruthy();
    expect((await http().post(`/api/clients/${clientId}/sites`).set(auth(t)).send({ code: 'TV1', name: 'dup' })).status).toBe(409);

    const type = (await http().post(`/api/clients/${clientId}/asset-types`).set(auth(t)).send({ name: 'Aircon', expectedLifeYears: 15, unit: 'ea', unitRate: 8000 })).body;
    const asset = (await http().post(`/api/sites/${site.id}/assets`).set(auth(t)).send({ name: 'Split system', assetTypeId: type.id, quantity: 2 })).body;

    const bad = await http().post(`/api/sites/${site.id}/inspections`).set(auth(t))
      .send({ inspectedOn: '2024-03-01', assessments: [{ assetId: asset.id, conditions: { good: { percent: 50, remainingLife: 5 } } }] });
    expect(bad.status).toBe(400); // percentages must total 100

    const ok = await http().post(`/api/sites/${site.id}/inspections`).set(auth(t))
      .send({ inspectedOn: '2024-03-01', assessments: [{ assetId: asset.id, conditions: { average: { percent: 100, remainingLife: 6 } } }] });
    expect(ok.status).toBe(201);

    // Replacement 2024+6 = 2030, quantity 2 x 8000 (type default rate), no inflation.
    const f = await http().post(`/api/clients/${clientId}/forecast`).set(auth(t)).send({ startYear: 2025, horizonYears: 10 });
    expect(f.status).toBe(201);
    expect(f.body.assetsAssessed).toBe(1);
    expect(f.body.byYear.find((y: any) => y.year === 2030).real).toBe(16000);
    expect(f.body.bySite[site.id][2030]).toBe(16000);
    expect(f.body.totals.real).toBe(16000);

    const capped = await http().post(`/api/clients/${clientId}/forecast`).set(auth(t)).send({ startYear: 2025, horizonYears: 10, annualCap: 10000 });
    expect(capped.body.leveled.find((y: any) => y.year === 2031).spend).toBe(6000);

    // another organisation sees none of it
    const other = await register('CONSULTANCY', 'other@example.com');
    expect((await http().get('/api/clients').set(auth(other))).body).toHaveLength(0);
    expect((await http().get(`/api/clients/${clientId}/sites`).set(auth(other))).body).toHaveLength(0);
    expect((await http().get(`/api/sites/${site.id}/assets`).set(auth(other))).body).toHaveLength(0);
    expect((await http().post(`/api/clients/${clientId}/forecast`).set(auth(other)).send({ startYear: 2025, horizonYears: 5 })).status).toBe(404);
    expect((await http().post(`/api/sites/${site.id}/assets`).set(auth(other)).send({ name: 'x' })).status).toBe(404);
  });

  it('consultancy manages several clients and validates input', async () => {
    const t = await register('CONSULTANCY', 'consult@example.com');
    await http().post('/api/clients').set(auth(t)).send({ name: 'TVNZ' });
    await http().post('/api/clients').set(auth(t)).send({ name: 'Transpower' });
    expect((await http().get('/api/clients').set(auth(t))).body.map((c: any) => c.name)).toEqual(['Transpower', 'TVNZ']);
    expect((await http().post('/api/clients').set(auth(t)).send({})).status).toBe(400);
  });
});

describe('roles', () => {
  it('contractor has no access to the register; viewer is read-only; client grants limit visibility', async () => {
    const t = await register('CONSULTANCY', 'roles-owner@example.com');
    const a = (await http().post('/api/clients').set(auth(t)).send({ name: 'Client A' })).body;
    const b = (await http().post('/api/clients').set(auth(t)).send({ name: 'Client B' })).body;

    const contractor = await addUser(t, 'contractor', 'contractor@example.com');
    expect((await http().get('/api/clients').set(auth(contractor))).status).toBe(403);
    expect((await http().post(`/api/clients/${a.id}/forecast`).set(auth(contractor)).send({ startYear: 2025, horizonYears: 5 })).status).toBe(403);

    const viewer = await addUser(t, 'client_viewer', 'viewer@example.com', [a.id]);
    const visible = (await http().get('/api/clients').set(auth(viewer))).body;
    expect(visible.map((c: any) => c.name)).toEqual(['Client A']);
    expect((await http().post('/api/clients').set(auth(viewer)).send({ name: 'nope' })).status).toBe(403);
    expect((await http().patch(`/api/clients/${a.id}`).set(auth(viewer)).send({ name: 'x' })).status).toBe(403);
    expect((await http().get(`/api/clients/${b.id}/sites`).set(auth(viewer))).body).toEqual([]);

    const assessor = await addUser(t, 'assessor', 'assessor@example.com');
    expect((await http().post(`/api/clients/${a.id}/sites`).set(auth(assessor)).send({ code: 'X', name: 'x' })).status).toBe(403);
    const manager = await addUser(t, 'asset_manager', 'am@example.com');
    expect((await http().delete(`/api/clients/${a.id}`).set(auth(manager))).status).toBe(403);
  });
});

describe('update, delete, audit and saved scenarios', () => {
  it('patches without clobbering unsent fields, deletes safely, and records an audit trail', async () => {
    const t = await register('OWNER', 'crud@example.com');
    const clientId = (await http().get('/api/clients').set(auth(t))).body[0].id;
    const site = (await http().post(`/api/clients/${clientId}/sites`).set(auth(t)).send({ code: 'S1', name: 'Site', attributes: { mast: 'A' } })).body;
    const parent = (await http().post(`/api/sites/${site.id}/assets`).set(auth(t)).send({ name: 'Cabinet', quantity: 4 })).body;
    const child = (await http().post(`/api/sites/${site.id}/assets`).set(auth(t)).send({ name: 'Battery', parentId: parent.id })).body;

    // PATCH changes only what was sent: quantity stays 4, attributes stay
    expect((await http().patch(`/api/assets/${parent.id}`).set(auth(t)).send({ name: 'Cabinet 2' })).status).toBe(200);
    const assets = (await http().get(`/api/sites/${site.id}/assets`).set(auth(t))).body;
    const cab = assets.find((x: any) => x.id === parent.id);
    expect(cab.name).toBe('Cabinet 2');
    expect(Number(cab.quantity)).toBe(4);
    expect((await http().patch(`/api/sites/${site.id}`).set(auth(t)).send({ name: 'Renamed' })).status).toBe(200);
    expect((await http().patch(`/api/assets/${parent.id}`).set(auth(t)).send({})).status).toBe(400);
    expect((await http().patch(`/api/assets/${parent.id}`).set(auth(t)).send({ parentId: parent.id })).status).toBe(400);
    expect((await http().patch(`/api/assets/${parent.id}`).set(auth(t)).send({ quantity: -1 })).status).toBe(400);
    expect((await http().patch('/api/assets/00000000-0000-0000-0000-000000000000').set(auth(t)).send({ name: 'x' })).status).toBe(404);

    // cannot delete a parent while a child references it; deleting the child first works
    expect((await http().delete(`/api/assets/${parent.id}`).set(auth(t))).status).toBe(409);
    expect((await http().delete(`/api/assets/${child.id}`).set(auth(t))).status).toBe(200);
    expect((await http().delete(`/api/assets/${parent.id}`).set(auth(t))).status).toBe(200);
    expect((await http().delete(`/api/assets/${parent.id}`).set(auth(t))).status).toBe(404);

    // another org cannot touch it
    const other = await register('OWNER', 'crud-other@example.com');
    expect((await http().patch(`/api/sites/${site.id}`).set(auth(other)).send({ name: 'hijack' })).status).toBe(404);
    expect((await http().delete(`/api/sites/${site.id}`).set(auth(other))).status).toBe(404);

    // audit trail: creates, updates and deletes were recorded for this org only
    const org = JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()).org as string;
    const rows = await db.withTenant({ orgId: org }, async (q) => (await q.query<{ action: string; entity: string }>('SELECT action, entity FROM audit_log')).rows);
    const has = (action: string, entity: string) => rows.some((r) => r.action === action && r.entity === entity);
    expect(has('create', 'site') && has('create', 'asset') && has('update', 'asset') && has('update', 'site') && has('delete', 'asset')).toBe(true);
    const otherOrg = JSON.parse(Buffer.from(other.split('.')[1]!, 'base64url').toString()).org as string;
    const otherRows = await db.withTenant({ orgId: otherOrg }, async (q) => (await q.query('SELECT 1 FROM audit_log')).rows);
    expect(otherRows).toHaveLength(0);
  });

  it('saves, lists, runs and deletes forecast scenarios', async () => {
    const t = await register('OWNER', 'scenarios@example.com');
    const clientId = (await http().get('/api/clients').set(auth(t))).body[0].id;
    const site = (await http().post(`/api/clients/${clientId}/sites`).set(auth(t)).send({ code: 'S1', name: 'Site' })).body;
    const asset = (await http().post(`/api/sites/${site.id}/assets`).set(auth(t)).send({ name: 'Unit', quantity: 1, unitRate: 1000, expectedLifeYears: 10 })).body;
    await http().post(`/api/sites/${site.id}/inspections`).set(auth(t))
      .send({ inspectedOn: '2024-01-01', assessments: [{ assetId: asset.id, conditions: { good: { percent: 100, remainingLife: 3 } } }] });

    expect((await http().post(`/api/clients/${clientId}/scenarios`).set(auth(t)).send({ name: 'bad', params: { startYear: 1 } })).status).toBe(400);
    const sc = await http().post(`/api/clients/${clientId}/scenarios`).set(auth(t)).send({ name: '10 year', params: { startYear: 2025, horizonYears: 10, inflation: 0 } });
    expect(sc.status).toBe(201);
    expect((await http().get(`/api/clients/${clientId}/scenarios`).set(auth(t))).body).toHaveLength(1);

    const run = await http().post(`/api/scenarios/${sc.body.id}/run`).set(auth(t));
    expect(run.status).toBe(201);
    expect(run.body.byYear.find((y: any) => y.year === 2027).real).toBe(1000);
    expect(run.body.totals.real).toBe(1000);

    const other = await register('OWNER', 'scenarios-other@example.com');
    expect((await http().post(`/api/scenarios/${sc.body.id}/run`).set(auth(other))).status).toBe(404);
    expect((await http().delete(`/api/scenarios/${sc.body.id}`).set(auth(other))).status).toBe(404);
    expect((await http().delete(`/api/scenarios/${sc.body.id}`).set(auth(t))).status).toBe(200);
    expect((await http().get(`/api/clients/${clientId}/scenarios`).set(auth(t))).body).toHaveLength(0);
  });
});
