import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app';
import { Database, createPgliteDatabase, migrate } from '../src/db';

let app: INestApplication;
let db: Database;
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function register(kind: 'OWNER' | 'CONSULTANCY', email: string) {
  const r = await http().post('/api/auth/register').send({ organisationName: email, kind, email, displayName: 'T', password: 'correct-horse-battery' });
  expect(r.status).toBe(201);
  return r.body.token as string;
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  await migrate(db);
  const mod = await Test.createTestingModule({ imports: [AppModule.register(db, { jwtSecret: 'x'.repeat(40) })] }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
});
afterAll(async () => { await app.close(); await db.close(); });

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
