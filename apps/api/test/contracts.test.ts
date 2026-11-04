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
const orgOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()).org as string;
const todayStr = () => new Date().toISOString().slice(0, 10);
const plusDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
let seq = 0;

async function register() {
  const email = `ct${++seq}@example.com`;
  const r = await http().post('/api/auth/register').send({ organisationName: email, kind: 'CONSULTANCY', email, displayName: `User ${seq}`, password: 'correct-horse-battery' });
  expect(r.status).toBe(201);
  return r.body.token as string;
}
async function addUser(ownerToken: string, role: string) {
  const email = `ct-u${++seq}@example.com`;
  const hash = await hashPassword('correct-horse-battery');
  await db.admin(async (q) => {
    const u = (await q.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ($1,'U',$2) RETURNING id`, [email, hash])).rows[0]!;
    await q.query('INSERT INTO membership (user_id, organisation_id, role) VALUES ($1,$2,$3)', [u.id, orgOf(ownerToken), role]);
  });
  return (await http().post('/api/auth/login').send({ email, password: 'correct-horse-battery' })).body.token as string;
}

/** A client with two sites (one asset at the first), a contractor and an active 2026 contract with no lines yet. */
async function setup(t: string, over: { contractStatus?: string; end?: string } = {}) {
  const client = (await http().post('/api/clients').set(auth(t)).send({ name: `Client ${++seq}` })).body;
  const mkSite = async (code: string) => (await http().post(`/api/clients/${client.id}/sites`).set(auth(t)).send({ code, name: `Site ${code}` })).body;
  const s1 = await mkSite('S1');
  const s2 = await mkSite('S2');
  const asset = (await http().post(`/api/sites/${s1.id}/assets`).set(auth(t)).send({ name: 'Split system' })).body;
  const contractor = (await http().post('/api/contractors').set(auth(t)).send({ name: `Mowers ${++seq}`, email: 'mow@example.com' })).body;
  const contract = (await http().post(`/api/clients/${client.id}/contracts`).set(auth(t)).send({
    contractorId: contractor.id, code: `C${seq}`, name: 'Grounds', status: over.contractStatus ?? 'active', startDate: '2026-01-01', endDate: over.end ?? '2026-12-31',
  })).body;
  return { client, s1, s2, asset, contractor, contract };
}
const addLine = (t: string, contractId: string, body: object) => http().post(`/api/contracts/${contractId}/lines`).set(auth(t)).send({
  description: 'Mow grounds', frequencyInterval: 1, frequencyUnit: 'month', firstDueDate: '2026-01-15', costPerOccurrence: 250, ...body,
});
const generate = (t: string, contractId: string, body: object) => http().post(`/api/contracts/${contractId}/generate`).set(auth(t)).send(body);
const listWo = async (t: string, clientId: string, query = '') => (await http().get(`/api/clients/${clientId}/work-orders${query}`).set(auth(t))).body as { items: any[]; total: number };
const del = (t: string, path: string) => http().delete(`/api/${path}`.replace('/api//', '/api/')).set(auth(t));
const restore = (t: string, entity: string, id: string) => http().post(`/api/trash/${entity}/${id}/restore`).set(auth(t));
const trash = async (t: string) => (await http().get('/api/trash').set(auth(t))).body as any[];

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const mod = await Test.createTestingModule({ imports: [AppModule.register(db, { jwtSecret: 'x'.repeat(40) })] }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
});
afterAll(async () => { await app.close(); await cleanup(); });

describe('contractors', () => {
  it('are created, listed with their contract count, updated, and unique by name per organisation', async () => {
    const t = await register();
    const k = (await http().post('/api/contractors').set(auth(t)).send({ name: 'Acme Mowing', contactName: 'Pat', email: 'pat@acme.test', phone: '021 555' })).body;
    expect(k.id).toBeTruthy();
    expect((await http().post('/api/contractors').set(auth(t)).send({ name: 'acme mowing' })).status).toBe(409); // case-insensitive
    expect((await http().post('/api/contractors').set(auth(t)).send({ name: '' })).status).toBe(400);
    expect((await http().post('/api/contractors').set(auth(t)).send({ name: 'Bad email', email: 'nope' })).status).toBe(400);
    expect((await http().patch(`/api/contractors/${k.id}`).set(auth(t)).send({ phone: null, notes: 'Preferred' })).status).toBe(200);
    expect((await http().patch(`/api/contractors/${k.id}`).set(auth(t)).send({})).status).toBe(400);
    const list = (await http().get('/api/contractors').set(auth(t))).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Acme Mowing', phone: null, notes: 'Preferred', contract_count: 0 });

    // another organisation can use the same name and sees none of ours
    const other = await register();
    expect((await http().post('/api/contractors').set(auth(other)).send({ name: 'Acme Mowing' })).status).toBe(201);
    expect((await http().get('/api/contractors').set(auth(other))).body).toHaveLength(1);
    expect((await http().patch(`/api/contractors/${k.id}`).set(auth(other)).send({ name: 'hijack' })).status).toBe(404);
  });

  it('can be read by a viewer but only changed by managers and administrators', async () => {
    const t = await register();
    await http().post('/api/contractors').set(auth(t)).send({ name: 'Visible' });
    const viewer = await addUser(t, 'client_viewer');
    const assessor = await addUser(t, 'assessor');
    const contractor = await addUser(t, 'contractor');
    expect((await http().get('/api/contractors').set(auth(viewer))).status).toBe(200);
    expect((await http().post('/api/contractors').set(auth(viewer)).send({ name: 'x' })).status).toBe(403);
    expect((await http().post('/api/contractors').set(auth(assessor)).send({ name: 'x' })).status).toBe(403);
    expect((await http().get('/api/contractors').set(auth(contractor))).status).toBe(403); // no portal yet
  });
});

describe('contracts and lines', () => {
  it('validates, lists with counts, shows detail with lines, and updates', async () => {
    const t = await register();
    const e = await setup(t, { contractStatus: 'draft' });
    const body = { contractorId: e.contractor.id, code: 'NEW', name: 'New', startDate: '2026-01-01', endDate: '2026-12-31' };
    const post = (b: object) => http().post(`/api/clients/${e.client.id}/contracts`).set(auth(t)).send(b);
    expect((await post({ ...body, endDate: '2025-12-31' })).status).toBe(400);
    expect((await post({ ...body, code: undefined })).status).toBe(400);
    expect((await post({ ...body, contractorId: '00000000-0000-0000-0000-000000000000' })).status).toBe(400);
    expect((await post({ ...body, startDate: '2026-02-30' })).status).toBe(400);
    expect((await post(body)).status).toBe(201);
    expect((await post({ ...body, code: 'new' })).status).toBe(409); // code unique per client, case-insensitive

    const l1 = await addLine(t, e.contract.id, { siteId: e.s1.id });
    const l2 = await addLine(t, e.contract.id, { assetId: e.asset.id, description: 'Annual aircon service', frequencyUnit: 'year', firstDueDate: '2026-03-01', costPerOccurrence: 480 });
    expect([l1.status, l2.status]).toEqual([201, 201]);

    const list = (await http().get(`/api/clients/${e.client.id}/contracts`).set(auth(t))).body;
    expect(list.find((c: any) => c.id === e.contract.id)).toMatchObject({ status: 'draft', line_count: 2, open_work_orders: 0, contractor_name: e.contractor.name });
    const detail = (await http().get(`/api/contracts/${e.contract.id}`).set(auth(t))).body;
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines.find((l: any) => l.asset_id)).toMatchObject({ asset_name: 'Split system', asset_site_code: 'S1', frequency_unit: 'year', first_due_date: '2026-03-01' });
    expect(detail.lines.find((l: any) => l.site_id)).toMatchObject({ site_code: 'S1', description: 'Mow grounds' });
    expect(detail).toMatchObject({ start_date: '2026-01-01', end_date: '2026-12-31', workOrderCounts: {} });

    expect((await http().patch(`/api/contracts/${e.contract.id}`).set(auth(t)).send({ status: 'active', name: 'Grounds 2026' })).status).toBe(200);
    expect((await http().patch(`/api/contracts/${e.contract.id}`).set(auth(t)).send({ endDate: '2025-01-01' })).status).toBe(400);
    expect((await http().patch(`/api/contracts/${e.contract.id}`).set(auth(t)).send({ startDate: '2026-06-01' })).status).toBe(400); // lines start earlier
    expect((await http().patch(`/api/contracts/${e.contract.id}`).set(auth(t)).send({ code: 'new' })).status).toBe(409);
  });

  it('a line targets exactly one live site or asset of the same client, inside the contract dates', async () => {
    const t = await register();
    const e = await setup(t);
    expect((await addLine(t, e.contract.id, {})).status).toBe(400); // no target
    expect((await addLine(t, e.contract.id, { siteId: e.s1.id, assetId: e.asset.id })).status).toBe(400); // both
    expect((await addLine(t, e.contract.id, { siteId: e.s1.id, firstDueDate: '2025-12-31' })).status).toBe(400);
    expect((await addLine(t, e.contract.id, { siteId: e.s1.id, firstDueDate: '2027-01-01' })).status).toBe(400);
    expect((await addLine(t, e.contract.id, { siteId: e.s1.id, frequencyInterval: 0 })).status).toBe(400);
    expect((await addLine(t, e.contract.id, { siteId: e.s1.id, frequencyUnit: 'fortnight' })).status).toBe(400);
    expect((await addLine(t, e.contract.id, { siteId: e.s1.id, costPerOccurrence: -1 })).status).toBe(400);
    expect((await addLine(t, e.contract.id, { siteId: '00000000-0000-0000-0000-000000000000' })).status).toBe(400);
    const other = await setup(await register());
    expect((await addLine(t, e.contract.id, { siteId: other.s1.id })).status).toBe(400); // someone else's site

    const ok = (await addLine(t, e.contract.id, { siteId: e.s1.id })).body;
    expect((await http().patch(`/api/contract-lines/${ok.id}`).set(auth(t)).send({ frequencyInterval: 2, costPerOccurrence: 300, description: 'Mow (fortnightly-ish)' })).status).toBe(200);
    expect((await http().patch(`/api/contract-lines/${ok.id}`).set(auth(t)).send({ firstDueDate: '2030-01-01' })).status).toBe(400);
    expect((await http().patch(`/api/contract-lines/${ok.id}`).set(auth(t)).send({ siteId: e.s2.id })).status).toBe(400); // target cannot change: nothing left to update
    const line = (await http().get(`/api/contracts/${e.contract.id}`).set(auth(t))).body.lines[0];
    expect(line).toMatchObject({ frequency_interval: 2, description: 'Mow (fortnightly-ish)' });
    expect(Number(line.cost_per_occurrence)).toBe(300);
  });
});

describe('generating work orders', () => {
  it('creates the work orders due in the window with numbers, costs, contractor and the right site', async () => {
    const t = await register();
    const e = await setup(t);
    await addLine(t, e.contract.id, { siteId: e.s1.id }); // monthly from 15 Jan, 250
    await addLine(t, e.contract.id, { assetId: e.asset.id, description: 'Annual aircon service', frequencyUnit: 'year', firstDueDate: '2026-02-01', costPerOccurrence: 480 });

    const r = await generate(t, e.contract.id, { through: '2026-03-31' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: 4, existing: 0, deletedSkipped: 0, dryRun: false });
    const { items, total } = await listWo(t, e.client.id);
    expect(total).toBe(4);
    expect(items.map((w) => [w.due_date, w.title])).toEqual([
      ['2026-01-15', 'Mow grounds'], ['2026-02-01', 'Annual aircon service'], ['2026-02-15', 'Mow grounds'], ['2026-03-15', 'Mow grounds'],
    ]);
    expect(items.map((w) => w.code)).toEqual([`${e.contract.code}-0001`, `${e.contract.code}-0002`, `${e.contract.code}-0003`, `${e.contract.code}-0004`]);
    const aircon = items.find((w) => w.title.startsWith('Annual'))!;
    expect(aircon).toMatchObject({ site_code: 'S1', asset_name: 'Split system', contractor_name: e.contractor.name, contract_code: e.contract.code, status: 'new' });
    expect(Number(aircon.estimated_cost)).toBe(480);
    expect(aircon.actual_cost).toBeNull();
  });

  it('numbers work orders due on the same day by site, not by the order the lines were added', async () => {
    const t = await register();
    const e = await setup(t);
    await addLine(t, e.contract.id, { siteId: e.s2.id, description: 'Same job' }); // added first, but S2 sorts after S1
    await addLine(t, e.contract.id, { siteId: e.s1.id, description: 'Same job' });
    await generate(t, e.contract.id, { through: '2026-01-31' });
    const { items } = await listWo(t, e.client.id);
    expect(items.map((w) => [w.code.slice(-4), w.site_code])).toEqual([['0001', 'S1'], ['0002', 'S2']]);
  });

  it('is safe to repeat: the same window again changes nothing, a longer one adds only the new ones and carries on numbering', async () => {
    const t = await register();
    const e = await setup(t);
    await addLine(t, e.contract.id, { siteId: e.s1.id });
    expect((await generate(t, e.contract.id, { through: '2026-03-31' })).body.created).toBe(3);
    const again = await generate(t, e.contract.id, { through: '2026-03-31' });
    expect(again.body).toMatchObject({ created: 0, existing: 3, wouldCreate: 0 });
    const more = await generate(t, e.contract.id, { through: '2026-06-30' });
    expect(more.body).toMatchObject({ created: 3, existing: 3 });
    const { items } = await listWo(t, e.client.id);
    expect(items.map((w) => w.due_date)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15']);
    expect(items.map((w) => w.code.slice(-4))).toEqual(['0001', '0002', '0003', '0004', '0005', '0006']); // no gaps, no reuse
  });

  it('two generations at the same moment never create duplicates', async () => {
    const t = await register();
    const e = await setup(t);
    await addLine(t, e.contract.id, { siteId: e.s1.id });
    await addLine(t, e.contract.id, { siteId: e.s2.id, description: 'Weekly check', frequencyUnit: 'week', firstDueDate: '2026-01-05' });
    const results = await Promise.all([1, 2, 3, 4].map(() => generate(t, e.contract.id, { through: '2026-06-30' })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const { items, total } = await listWo(t, e.client.id, '?limit=500');
    const expected = 6 + 26; // 6 monthly + 26 weekly (5 Jan .. 29 Jun)
    expect(total).toBe(expected);
    expect(new Set(items.map((w) => `${w.contract_line_id}|${w.due_date}`)).size).toBe(expected);
    expect(new Set(items.map((w) => w.code)).size).toBe(expected);
    expect(results.reduce((n, r) => n + r.body.created, 0)).toBe(expected);
  });

  it('a dry run reports what would happen and creates nothing; from skips earlier dates', async () => {
    const t = await register();
    const e = await setup(t);
    await addLine(t, e.contract.id, { siteId: e.s1.id });
    const dry = await generate(t, e.contract.id, { through: '2026-04-30', dryRun: true });
    expect(dry.body).toMatchObject({ dryRun: true, created: 0, wouldCreate: 4 });
    expect(dry.body.sample.map((s: any) => s.dueDate)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
    expect((await listWo(t, e.client.id)).total).toBe(0);
    const fromMarch = await generate(t, e.contract.id, { from: '2026-03-01', through: '2026-04-30' });
    expect(fromMarch.body.created).toBe(2);
    expect((await listWo(t, e.client.id)).items.map((w) => w.due_date)).toEqual(['2026-03-15', '2026-04-15']);
  });

  it('never goes past the contract end date, and refuses draft or closed contracts', async () => {
    const t = await register();
    const e = await setup(t, { end: '2026-03-20' });
    await addLine(t, e.contract.id, { siteId: e.s1.id });
    expect((await generate(t, e.contract.id, { through: '2026-12-31' })).body.created).toBe(3); // 15 Jan, Feb, Mar
    for (const status of ['draft', 'closed']) {
      await http().patch(`/api/contracts/${e.contract.id}`).set(auth(t)).send({ status });
      const r = await generate(t, e.contract.id, { through: '2026-12-31' });
      expect(r.status).toBe(409);
      expect(r.body.message).toMatch(/active/);
    }
  });

  it('rejects silly windows and oversized runs', async () => {
    const t = await register();
    const e = await setup(t, { end: '2033-12-31' });
    await addLine(t, e.contract.id, { siteId: e.s1.id });
    expect((await generate(t, e.contract.id, { through: 'soon' })).status).toBe(400);
    expect((await generate(t, e.contract.id, { from: '2026-06-01', through: '2026-01-01' })).status).toBe(400);
    expect((await generate(t, e.contract.id, { through: '2099-01-01' })).status).toBe(400); // more than 5 years ahead
    // three daily lines across five years is more than the 5000 limit
    for (const d of ['A', 'B', 'C']) await addLine(t, e.contract.id, { siteId: e.s2.id, description: `Daily ${d}`, frequencyUnit: 'day', firstDueDate: '2026-01-01' });
    const big = await generate(t, e.contract.id, { through: plusDays(365 * 5) });
    expect(big.status).toBe(400);
    expect(big.body.message).toMatch(/limit/);
    expect((await listWo(t, e.client.id)).total).toBe(0); // nothing half-created
  });

  it('only managers generate; viewers cannot; other organisations cannot see the contract', async () => {
    const t = await register();
    const e = await setup(t);
    await addLine(t, e.contract.id, { siteId: e.s1.id });
    const viewer = await addUser(t, 'client_viewer');
    const stranger = await register();
    const manager = await addUser(t, 'asset_manager');
    expect((await generate(viewer, e.contract.id, { through: '2026-03-31' })).status).toBe(403);
    expect((await generate(stranger, e.contract.id, { through: '2026-03-31' })).status).toBe(404);
    expect((await generate(manager, e.contract.id, { through: '2026-03-31' })).status).toBe(201);
  });
});

describe('work orders', () => {
  async function withOrders(t: string) {
    const e = await setup(t, { end: '2030-12-31' });
    await addLine(t, e.contract.id, { siteId: e.s1.id, firstDueDate: '2030-01-15' });
    await addLine(t, e.contract.id, { siteId: e.s2.id, description: 'Weekly check', frequencyUnit: 'week', firstDueDate: '2030-01-07', costPerOccurrence: 40 });
    await generate(t, e.contract.id, { through: '2030-02-28' });
    return e;
  }

  it('lists with filters and paging', async () => {
    const t = await register();
    const e = await withOrders(t);
    const all = await listWo(t, e.client.id, '?limit=500');
    expect(all.total).toBe(all.items.length);
    expect((await listWo(t, e.client.id, `?siteId=${e.s2.id}&limit=500`)).items.every((w) => w.site_code === 'S2')).toBe(true);
    expect((await listWo(t, e.client.id, `?contractId=${e.contract.id}&limit=500`)).total).toBe(all.total);
    expect((await listWo(t, e.client.id, '?from=2030-02-01&to=2030-02-28&limit=500')).items.every((w) => w.due_date >= '2030-02-01' && w.due_date <= '2030-02-28')).toBe(true);
    expect((await listWo(t, e.client.id, '?status=complete')).total).toBe(0);
    expect((await listWo(t, e.client.id, '?overdue=true')).total).toBe(0); // all due in 2030
    const page = await listWo(t, e.client.id, '?limit=3&offset=2');
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(all.total);
    expect(page.items.map((w) => w.id)).toEqual(all.items.slice(2, 5).map((w) => w.id));
    expect((await http().get(`/api/clients/${e.client.id}/work-orders?status=bogus`).set(auth(t))).status).toBe(400);
    expect((await http().get(`/api/clients/${e.client.id}/work-orders?limit=9999`).set(auth(t))).status).toBe(400);
    // other organisations see none
    expect((await listWo(await register(), e.client.id)).total).toBe(0);
  });

  it('overdue means due before today and still open', async () => {
    const t = await register();
    const e = await setup(t);
    await addLine(t, e.contract.id, { siteId: e.s1.id });
    await generate(t, e.contract.id, { through: '2026-03-31' }); // 15 Jan, Feb, Mar 2026
    const overdue = await listWo(t, e.client.id, '?overdue=true');
    expect(overdue.total).toBe(3);
    await http().post(`/api/work-orders/${overdue.items[0].id}/status`).set(auth(t)).send({ status: 'cancelled' });
    expect((await listWo(t, e.client.id, '?overdue=true')).total).toBe(2);
  });

  it('edits title, due date, estimate and notes; a due date clash with the same line is refused', async () => {
    const t = await register();
    const e = await withOrders(t);
    const [first, second] = (await listWo(t, e.client.id, `?siteId=${e.s1.id}`)).items;
    expect((await http().patch(`/api/work-orders/${first.id}`).set(auth(t)).send({ title: 'Mow (wet week)', estimatedCost: 300, notes: 'Call first', dueDate: '2030-01-17' })).status).toBe(200);
    const got = (await http().get(`/api/work-orders/${first.id}`).set(auth(t))).body;
    expect(got).toMatchObject({ title: 'Mow (wet week)', due_date: '2030-01-17', notes: 'Call first' });
    expect(Number(got.estimated_cost)).toBe(300);
    expect((await http().patch(`/api/work-orders/${first.id}`).set(auth(t)).send({ dueDate: second.due_date })).status).toBe(409);
    expect((await http().patch(`/api/work-orders/${first.id}`).set(auth(t)).send({ estimatedCost: -5 })).status).toBe(400);
    expect((await http().patch(`/api/work-orders/${first.id}`).set(auth(t)).send({})).status).toBe(400);
    expect((await http().get('/api/work-orders/00000000-0000-0000-0000-000000000000').set(auth(t))).status).toBe(404);
  });

  it('follows the status flow, records completion and keeps the actual cost', async () => {
    const t = await register();
    const e = await withOrders(t);
    const wo = (await listWo(t, e.client.id)).items[0];
    const set = (body: object) => http().post(`/api/work-orders/${wo.id}/status`).set(auth(t)).send(body);
    const state = async () => (await http().get(`/api/work-orders/${wo.id}`).set(auth(t))).body;

    expect((await set({ status: 'new' })).status).toBe(409); // already new
    expect((await set({ status: 'in_progress' })).status).toBe(201);
    expect((await state()).status).toBe('in_progress');
    expect((await set({ status: 'complete', completedOn: plusDays(1) })).status).toBe(400); // not in the future
    const done = await set({ status: 'complete', actualCost: 275.5, notes: 'All done' });
    expect(done.status).toBe(201);
    expect(await state()).toMatchObject({ status: 'complete', completed_on: todayStr(), notes: 'All done' });
    expect(Number((await state()).actual_cost)).toBe(275.5);
    expect((await set({ status: 'cancelled' })).status).toBe(409); // complete -> cancelled is not allowed
    expect((await set({ status: 'new' })).status).toBe(409);
    expect((await set({ status: 'in_progress' })).status).toBe(201); // reopen
    const reopened = await state();
    expect(reopened.completed_on).toBeNull();
    expect(Number(reopened.actual_cost)).toBe(275.5); // kept
    expect((await set({ status: 'complete', completedOn: '2026-02-01' })).status).toBe(201);
    expect((await state()).completed_on).toBe('2026-02-01');
    expect((await set({ status: 'bogus' })).status).toBe(400);

    const cancelled = (await listWo(t, e.client.id)).items[1];
    expect((await http().post(`/api/work-orders/${cancelled.id}/status`).set(auth(t)).send({ status: 'cancelled' })).status).toBe(201);
    expect((await http().post(`/api/work-orders/${cancelled.id}/status`).set(auth(t)).send({ status: 'complete' })).status).toBe(409);
    expect((await http().post(`/api/work-orders/${cancelled.id}/status`).set(auth(t)).send({ status: 'new' })).status).toBe(201);

    const viewer = await addUser(t, 'client_viewer');
    const stranger = await register();
    expect((await http().post(`/api/work-orders/${wo.id}/status`).set(auth(viewer)).send({ status: 'in_progress' })).status).toBe(403);
    expect((await http().post(`/api/work-orders/${wo.id}/status`).set(auth(stranger)).send({ status: 'in_progress' })).status).toBe(404);
  });

  it('writes audit entries for generation and for changes', async () => {
    const t = await register();
    const e = await setup(t);
    await addLine(t, e.contract.id, { siteId: e.s1.id });
    await generate(t, e.contract.id, { through: '2026-02-28' });
    const wo = (await listWo(t, e.client.id)).items[0];
    await http().post(`/api/work-orders/${wo.id}/status`).set(auth(t)).send({ status: 'in_progress' });
    const rows = await db.withTenant({ orgId: orgOf(t) }, async (q) => (await q.query<any>(`SELECT action, entity, details FROM audit_log WHERE entity = 'work_order' ORDER BY id`)).rows);
    expect(rows.find((r) => r.action === 'create')!.details).toMatchObject({ generated: 2, contractId: e.contract.id, through: '2026-02-28' });
    expect(rows.find((r) => r.action === 'update')!.details.changes.status).toEqual({ from: 'new', to: 'in_progress' });
  });
});

describe('deleting and restoring (soft)', () => {
  it('a contractor in use cannot be deleted; once free it can, and be restored', async () => {
    const t = await register();
    const e = await setup(t);
    const blocked = await del(t, `contractors/${e.contractor.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/1 contract uses this contractor/);
    expect((await del(t, `contracts/${e.contract.id}`)).status).toBe(200);
    expect((await del(t, `contractors/${e.contractor.id}`)).status).toBe(200);
    expect((await http().get('/api/contractors').set(auth(t))).body).toEqual([]);
    expect((await trash(t)).map((i) => [i.entity, i.label, i.clientId])).toEqual(expect.arrayContaining([['contractor', e.contractor.name, null], ['contract', `${e.contract.code} · Grounds`, e.client.id]]));
    // the contract cannot come back while its contractor is deleted
    const r = await restore(t, 'contract', e.contract.id);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/deleted contractor/);
    expect((await restore(t, 'contractor', e.contractor.id)).status).toBe(201);
    expect((await restore(t, 'contract', e.contract.id)).status).toBe(201);
    expect((await http().get(`/api/clients/${e.client.id}/contracts`).set(auth(t))).body).toHaveLength(1);
    // the name can be reused while deleted
    await del(t, `contracts/${e.contract.id}`);
    await del(t, `contractors/${e.contractor.id}`);
    expect((await http().post('/api/contractors').set(auth(t)).send({ name: e.contractor.name })).status).toBe(201);
    const clash = await restore(t, 'contractor', e.contractor.id);
    expect(clash.status).toBe(409);
    expect(clash.body.message).toMatch(/Another live contractor/);
  });

  it('a site or asset on a contract line cannot be deleted until the line is removed', async () => {
    const t = await register();
    const e = await setup(t);
    const siteLine = (await addLine(t, e.contract.id, { siteId: e.s2.id })).body;
    const assetLine = (await addLine(t, e.contract.id, { assetId: e.asset.id, description: 'Service' })).body;
    const bySite = await del(t, `sites/${e.s1.id}`); // the asset at S1 is on a line
    expect(bySite.status).toBe(409);
    expect(bySite.body.message).toMatch(/contract line/);
    expect((await del(t, `assets/${e.asset.id}`)).status).toBe(409);
    expect((await del(t, `sites/${e.s2.id}`)).status).toBe(409);
    expect((await del(t, `contract-lines/${assetLine.id}`)).status).toBe(200);
    expect((await del(t, `contract-lines/${siteLine.id}`)).status).toBe(200);
    expect((await del(t, `assets/${e.asset.id}`)).status).toBe(200);
    expect((await del(t, `sites/${e.s2.id}`)).status).toBe(200);
  });

  it('deleting a contract takes its lines and work orders; restoring brings back those, not ones deleted earlier', async () => {
    const t = await register();
    const e = await setup(t, { end: '2030-12-31' });
    await addLine(t, e.contract.id, { siteId: e.s1.id, firstDueDate: '2030-01-15' });
    await generate(t, e.contract.id, { through: '2030-04-30' }); // Jan..Apr 2030
    const wos = (await listWo(t, e.client.id)).items;
    expect(wos).toHaveLength(4);
    expect((await del(t, `work-orders/${wos[3].id}`)).status).toBe(200); // one deleted on its own first

    const res = await del(t, `contracts/${e.contract.id}`);
    expect(res.status).toBe(200);
    expect(res.body.cascaded).toEqual({ workOrders: 3, contractLines: 1 });
    expect((await listWo(t, e.client.id)).total).toBe(0);
    expect((await http().get(`/api/contracts/${e.contract.id}`).set(auth(t))).status).toBe(404);
    const items = await trash(t);
    expect(items.map((i) => i.entity).sort()).toEqual(['contract', 'work-order']);
    expect(items.find((i) => i.entity === 'contract')!.includes).toBe(4); // 1 line + 3 work orders

    const back = await restore(t, 'contract', e.contract.id);
    expect(back.body.alsoRestored).toEqual({ contractLines: 1, workOrders: 3 });
    expect((await listWo(t, e.client.id)).items.map((w) => w.due_date)).toEqual(['2030-01-15', '2030-02-15', '2030-03-15']);

    // generating again does not resurrect the one that was deleted, and numbering carries on
    const again = await generate(t, e.contract.id, { through: '2030-06-30' });
    expect(again.body).toMatchObject({ created: 2, existing: 3, deletedSkipped: 1 });
    expect((await listWo(t, e.client.id)).items.map((w) => [w.due_date, w.code.slice(-4)])).toEqual([
      ['2030-01-15', '0001'], ['2030-02-15', '0002'], ['2030-03-15', '0003'], ['2030-05-15', '0005'], ['2030-06-15', '0006'],
    ]);
    // a deleted work order can still be restored by an administrator
    expect((await restore(t, 'work-order', wos[3].id)).status).toBe(201);
    expect((await listWo(t, e.client.id)).total).toBe(6);
  });

  it('deleting a site (once off its lines) takes its work orders; restoring brings them back', async () => {
    const t = await register();
    const e = await setup(t, { end: '2030-12-31' });
    const line = (await addLine(t, e.contract.id, { siteId: e.s2.id, firstDueDate: '2030-01-10' })).body;
    await generate(t, e.contract.id, { through: '2030-03-31' });
    expect((await listWo(t, e.client.id)).total).toBe(3);
    await del(t, `contract-lines/${line.id}`);
    const res = await del(t, `sites/${e.s2.id}`);
    expect(res.status).toBe(200);
    expect(res.body.cascaded.workOrders).toBe(3);
    expect((await listWo(t, e.client.id)).total).toBe(0);
    const back = await restore(t, 'site', e.s2.id);
    expect(back.body.alsoRestored.workOrders).toBe(3);
    expect((await listWo(t, e.client.id)).total).toBe(3);
  });

  it('deleting a client takes contracts, lines and work orders; a restore refuses to leave a work order pointing at a deleted site', async () => {
    const t = await register();
    const e = await setup(t, { end: '2030-12-31' });
    await addLine(t, e.contract.id, { siteId: e.s1.id, firstDueDate: '2030-01-10' });
    await generate(t, e.contract.id, { through: '2030-02-28' });
    const res = await del(t, `clients/${e.client.id}`);
    expect(res.body.cascaded).toMatchObject({ workOrders: 2, contractLines: 1, contracts: 1 });
    expect((await listWo(t, e.client.id)).total).toBe(0);
    const back = await restore(t, 'client', e.client.id);
    expect(back.body.alsoRestored).toMatchObject({ workOrders: 2, contractLines: 1, contracts: 1 });
    expect((await listWo(t, e.client.id)).total).toBe(2);
    expect((await http().get(`/api/clients/${e.client.id}/contracts`).set(auth(t))).body).toHaveLength(1);
  });

  it('only administrators delete or restore these', async () => {
    const t = await register();
    const e = await setup(t);
    const manager = await addUser(t, 'asset_manager');
    for (const path of [`contractors/${e.contractor.id}`, `contracts/${e.contract.id}`]) expect((await del(manager, path)).status).toBe(403);
    const stranger = await register();
    expect((await del(stranger, `contracts/${e.contract.id}`)).status).toBe(404);
  });
});

describe('the database forbids hard deletes of these tables too', () => {
  it('the app role cannot DELETE contractors, contracts, lines or work orders', async () => {
    const t = await register();
    const e = await setup(t);
    await addLine(t, e.contract.id, { siteId: e.s1.id });
    await generate(t, e.contract.id, { through: '2026-02-28' });
    const asTenant = (sql: string) => db.withTenant({ orgId: orgOf(t) }, (q) => q.query(sql));
    for (const table of ['contractor', 'contract', 'contract_line', 'work_order']) await expect(asTenant(`DELETE FROM ${table}`), table).rejects.toThrow(/permission denied/);
    expect(await db.admin(async (q) => Number((await q.query<{ n: string }>('SELECT count(*) AS n FROM work_order')).rows[0]!.n))).toBeGreaterThan(0);
  });
});
