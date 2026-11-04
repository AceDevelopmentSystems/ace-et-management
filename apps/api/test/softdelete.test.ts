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
let seq = 0;

async function register(kind: 'OWNER' | 'CONSULTANCY' = 'CONSULTANCY') {
  const email = `sd${++seq}@example.com`;
  const r = await http().post('/api/auth/register').send({ organisationName: email, kind, email, displayName: `User ${seq}`, password: 'correct-horse-battery' });
  expect(r.status).toBe(201);
  return r.body.token as string;
}
async function addUser(ownerToken: string, role: string) {
  const email = `sd-u${++seq}@example.com`;
  const hash = await hashPassword('correct-horse-battery');
  await db.admin(async (q) => {
    const u = (await q.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ($1,'U',$2) RETURNING id`, [email, hash])).rows[0]!;
    await q.query('INSERT INTO membership (user_id, organisation_id, role) VALUES ($1,$2,$3)', [u.id, orgOf(ownerToken), role]);
  });
  return (await http().post('/api/auth/login').send({ email, password: 'correct-horse-battery' })).body.token as string;
}

/** A client with a region, a type, two sites with assets, a saved scenario. */
async function estate(t: string) {
  const client = (await http().post('/api/clients').set(auth(t)).send({ name: `Client ${++seq}` })).body;
  const region = (await http().post(`/api/clients/${client.id}/regions`).set(auth(t)).send({ code: 'NSW', name: 'New South Wales' })).body;
  const type = (await http().post(`/api/clients/${client.id}/asset-types`).set(auth(t)).send({ name: 'Aircon', expectedLifeYears: 15, unitRate: 9000 })).body;
  const mkSite = async (code: string) => (await http().post(`/api/clients/${client.id}/sites`).set(auth(t)).send({ code, name: `Site ${code}`, regionId: region.id })).body;
  const s1 = await mkSite('S1');
  const s2 = await mkSite('S2');
  const mkAsset = async (siteId: string, name: string, extra: object = {}) =>
    (await http().post(`/api/sites/${siteId}/assets`).set(auth(t)).send({ name, assetTypeId: type.id, ...extra })).body;
  const a1 = await mkAsset(s1.id, 'A1');
  const a2 = await mkAsset(s1.id, 'A2');
  const a3 = await mkAsset(s2.id, 'A3');
  const scenario = (await http().post(`/api/clients/${client.id}/scenarios`).set(auth(t)).send({ name: 'Base', params: { startYear: 2026, horizonYears: 10 } })).body;
  return { client, region, type, s1, s2, a1, a2, a3, scenario };
}
const ids = (rows: any[]) => rows.map((r) => r.id).sort();
const trash = async (t: string) => (await http().get('/api/trash').set(auth(t))).body as any[];
const del = (t: string, path: string) => http().delete(`/api${path}`).set(auth(t));
const restore = (t: string, entity: string, id: string) => http().post(`/api/trash/${entity}/${id}/restore`).set(auth(t));

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const mod = await Test.createTestingModule({ imports: [AppModule.register(db, { jwtSecret: 'x'.repeat(40) })] }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
});
afterAll(async () => { await app.close(); await cleanup(); });

describe('soft delete of a single item', () => {
  it('hides it everywhere, keeps the row, and lists it in the trash', async () => {
    const t = await register();
    const e = await estate(t);
    expect((await del(t, `/assets/${e.a2.id}`)).status).toBe(200);

    expect(ids((await http().get(`/api/sites/${e.s1.id}/assets`).set(auth(t))).body)).toEqual([e.a1.id]);
    expect((await http().get(`/api/assets/${e.a2.id}/assessments`).set(auth(t))).status).toBe(404);
    expect((await http().patch(`/api/assets/${e.a2.id}`).set(auth(t)).send({ name: 'ghost' })).status).toBe(404);
    expect((await del(t, `/assets/${e.a2.id}`)).status).toBe(404); // already deleted

    // the row is still there, marked
    const row = await db.admin(async (q) => (await q.query<any>('SELECT name, deleted_at, deleted_by FROM asset WHERE id = $1', [e.a2.id])).rows[0]);
    expect(row.name).toBe('A2');
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).not.toBeNull();

    const items = await trash(t);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ entity: 'asset', id: e.a2.id, label: 'A2 (S1)', clientId: e.client.id, deletedBy: expect.stringContaining('User'), includes: 0 });
    expect(Date.parse(items[0].deletedAt)).not.toBeNaN();
  });

  it('restores it, and refuses to restore something that is not deleted', async () => {
    const t = await register();
    const e = await estate(t);
    await del(t, `/assets/${e.a2.id}`);
    expect((await restore(t, 'asset', e.a2.id)).status).toBe(201);
    expect(ids((await http().get(`/api/sites/${e.s1.id}/assets`).set(auth(t))).body)).toEqual(ids([e.a1, e.a2]));
    expect(await trash(t)).toEqual([]);
    expect((await restore(t, 'asset', e.a2.id)).status).toBe(409);
    expect((await restore(t, 'asset', '00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await restore(t, 'widget', e.a2.id)).status).toBe(404);
  });

  it('refuses to delete things that are still in use', async () => {
    const t = await register();
    const e = await estate(t);
    expect((await del(t, `/regions/${e.region.id}`)).status).toBe(409); // sites use it
    expect((await del(t, `/asset-types/${e.type.id}`)).status).toBe(409); // assets use it
    const parent = (await http().post(`/api/sites/${e.s2.id}/assets`).set(auth(t)).send({ name: 'Cabinet' })).body;
    const part = (await http().post(`/api/sites/${e.s2.id}/assets`).set(auth(t)).send({ name: 'Battery', parentId: parent.id })).body;
    expect((await del(t, `/assets/${parent.id}`)).status).toBe(409); // has a component
    expect((await del(t, `/assets/${part.id}`)).status).toBe(200);
    expect((await del(t, `/assets/${parent.id}`)).status).toBe(200);
    expect(await db.admin(async (q) => (await q.query('SELECT 1 FROM asset WHERE id = $1', [parent.id])).rows.length)).toBe(1); // kept
  });

  it('does not let new records point at deleted ones', async () => {
    const t = await register();
    const e = await estate(t);
    const spare = (await http().post(`/api/clients/${e.client.id}/regions`).set(auth(t)).send({ code: 'VIC', name: 'Victoria' })).body;
    const spareType = (await http().post(`/api/clients/${e.client.id}/asset-types`).set(auth(t)).send({ name: 'Door' })).body;
    await del(t, `/regions/${spare.id}`);
    await del(t, `/asset-types/${spareType.id}`);
    expect((await http().post(`/api/clients/${e.client.id}/sites`).set(auth(t)).send({ code: 'X', name: 'X', regionId: spare.id })).status).toBe(400);
    expect((await http().patch(`/api/sites/${e.s1.id}`).set(auth(t)).send({ regionId: spare.id })).status).toBe(400);
    expect((await http().post(`/api/sites/${e.s1.id}/assets`).set(auth(t)).send({ name: 'X', assetTypeId: spareType.id })).status).toBe(400);
    expect((await http().patch(`/api/assets/${e.a1.id}`).set(auth(t)).send({ assetTypeId: spareType.id })).status).toBe(400);
    expect((await http().patch(`/api/assets/${e.a1.id}`).set(auth(t)).send({ parentId: e.a2.id })).status).toBe(200); // live target is fine
  });
});

describe('cascade and restore', () => {
  it('deleting a site takes its assets with it; restoring brings back only those, not ones deleted earlier', async () => {
    const t = await register();
    const e = await estate(t);
    await del(t, `/assets/${e.a2.id}`); // deleted on its own first
    const res = await del(t, `/sites/${e.s1.id}`);
    expect(res.status).toBe(200);
    expect(res.body.cascaded).toEqual({ assets: 1 }); // only A1; A2 was already deleted

    expect((await http().get(`/api/sites/${e.s1.id}`).set(auth(t))).status).toBe(404);
    expect((await http().get(`/api/sites/${e.s1.id}/assets`).set(auth(t))).body).toEqual([]);
    expect((await http().get(`/api/clients/${e.client.id}/sites`).set(auth(t))).body).toHaveLength(1);

    const items = await trash(t);
    expect(items.map((i) => [i.entity, i.label, i.includes])).toEqual(expect.arrayContaining([['site', 'S1 · Site S1', 1], ['asset', 'A2 (S1)', 0]]));
    expect(items).toHaveLength(2); // A1 is not listed separately: it went with its site

    const back = await restore(t, 'site', e.s1.id);
    expect(back.status).toBe(201);
    expect(back.body.alsoRestored).toEqual({ assets: 1 });
    expect(ids((await http().get(`/api/sites/${e.s1.id}/assets`).set(auth(t))).body)).toEqual([e.a1.id]); // A2 stays deleted
    expect((await trash(t)).map((i) => i.label)).toEqual(['A2 (S1)']);
  });

  it('deleting a client takes the whole estate; restoring brings it back except what was deleted before', async () => {
    const t = await register();
    const e = await estate(t);
    const extra = (await http().post(`/api/clients/${e.client.id}/scenarios`).set(auth(t)).send({ name: 'Old', params: { startYear: 2026, horizonYears: 5 } })).body;
    await del(t, `/scenarios/${extra.id}`);
    const res = await del(t, `/clients/${e.client.id}`);
    expect(res.status).toBe(200);
    expect(res.body.cascaded).toEqual({ assets: 3, sites: 2, regions: 1, assetTypes: 1, scenarios: 1 });

    expect((await http().get('/api/clients').set(auth(t))).body).toEqual([]);
    expect((await http().get(`/api/clients/${e.client.id}/sites`).set(auth(t))).body).toEqual([]);
    expect((await http().post(`/api/clients/${e.client.id}/forecast`).set(auth(t)).send({ startYear: 2026, horizonYears: 5 })).status).toBe(404);
    expect((await http().post(`/api/clients/${e.client.id}/sites`).set(auth(t)).send({ code: 'N', name: 'n' })).status).toBe(404);

    const items = await trash(t);
    expect(items.map((i) => i.entity).sort()).toEqual(['client', 'scenario']); // everything else went with the client
    expect(items.find((i) => i.entity === 'client')!.includes).toBe(5); // 2 sites + 3 assets

    // children cannot be restored while the client is deleted
    expect((await restore(t, 'site', e.s1.id)).status).toBe(409);
    const back = await restore(t, 'client', e.client.id);
    expect(back.status).toBe(201);
    expect(back.body.alsoRestored).toEqual({ regions: 1, assetTypes: 1, sites: 2, assets: 3, scenarios: 1 });
    expect((await http().get(`/api/clients/${e.client.id}/sites`).set(auth(t))).body).toHaveLength(2);
    expect((await http().get(`/api/clients/${e.client.id}/scenarios`).set(auth(t))).body.map((s: any) => s.name)).toEqual(['Base']); // "Old" stays deleted
    const f = await http().post(`/api/clients/${e.client.id}/forecast`).set(auth(t)).send({ startYear: 2026, horizonYears: 5 });
    expect(f.status).toBe(201);
    expect(f.body.assetsAssessed + f.body.skipped.length).toBe(0); // nothing inspected yet, but the endpoint works again
  });

  it('refuses a restore that would leave a live item pointing at something still deleted', async () => {
    const t = await register();
    const e = await estate(t);
    await del(t, `/sites/${e.s2.id}`); // A3 goes with it
    // now no live asset uses the type, so the type can be deleted on its own... after S1's assets are gone too
    await del(t, `/assets/${e.a1.id}`);
    await del(t, `/assets/${e.a2.id}`);
    expect((await del(t, `/asset-types/${e.type.id}`)).status).toBe(200);
    const r = await restore(t, 'site', e.s2.id);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/deleted asset type "Aircon"/);
    expect((await http().get(`/api/clients/${e.client.id}/sites`).set(auth(t))).body.map((s: any) => s.code)).toEqual(['S1']); // rolled back
    expect((await restore(t, 'asset-type', e.type.id)).status).toBe(201);
    expect((await restore(t, 'site', e.s2.id)).status).toBe(201);
  });

  it('refuses to restore a site whose region is deleted', async () => {
    const t = await register();
    const e = await estate(t);
    await del(t, `/sites/${e.s1.id}`);
    await del(t, `/sites/${e.s2.id}`);
    expect((await del(t, `/regions/${e.region.id}`)).status).toBe(200);
    const r = await restore(t, 'site', e.s1.id);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/deleted region "NSW New South Wales"/);
    expect((await restore(t, 'region', e.region.id)).status).toBe(201);
    expect((await restore(t, 'site', e.s1.id)).status).toBe(201);
  });
});

describe('codes can be reused after a delete', () => {
  it('lets a new site take a deleted site\'s code, and blocks the restore until that is resolved', async () => {
    const t = await register();
    const e = await estate(t);
    await del(t, `/sites/${e.s2.id}`);
    const again = await http().post(`/api/clients/${e.client.id}/sites`).set(auth(t)).send({ code: 'S2', name: 'Replacement' });
    expect(again.status).toBe(201);
    const blocked = await restore(t, 'site', e.s2.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/Another live site already uses this code/);
    await http().patch(`/api/sites/${again.body.id}`).set(auth(t)).send({ code: 'S2-NEW' });
    expect((await restore(t, 'site', e.s2.id)).status).toBe(201);
    // a client code too
    const c = (await http().post('/api/clients').set(auth(t)).send({ name: 'Coded', code: 'CODE' })).body;
    await del(t, `/clients/${c.id}`);
    expect((await http().post('/api/clients').set(auth(t)).send({ name: 'Coded again', code: 'CODE' })).status).toBe(201);
  });
});

describe('who can see and restore', () => {
  it('only an administrator can use the trash; other organisations see nothing of it', async () => {
    const t = await register();
    const e = await estate(t);
    await del(t, `/assets/${e.a1.id}`);
    const manager = await addUser(t, 'asset_manager');
    const viewer = await addUser(t, 'client_viewer');
    for (const tok of [manager, viewer]) {
      expect((await http().get('/api/trash').set(auth(tok))).status).toBe(403);
      expect((await restore(tok, 'asset', e.a1.id)).status).toBe(403);
    }
    expect((await del(manager, `/assets/${e.a3.id}`)).status).toBe(403); // delete is admin-only as well

    const other = await register();
    expect(await trash(other)).toEqual([]);
    expect((await restore(other, 'asset', e.a1.id)).status).toBe(404);
    expect((await http().get('/api/trash')).status).toBe(401);
    expect((await trash(t)).map((i) => i.id)).toEqual([e.a1.id]);
  });
});

describe('audit trail', () => {
  it('records what changed on update, and deletes and restores with what they touched', async () => {
    const t = await register();
    const e = await estate(t);
    await http().patch(`/api/assets/${e.a1.id}`).set(auth(t)).send({ name: 'A1 renamed', quantity: 4 });
    await http().patch(`/api/assets/${e.a1.id}`).set(auth(t)).send({ name: 'A1 renamed' }); // no change -> no entry
    await del(t, `/sites/${e.s1.id}`);
    await restore(t, 'site', e.s1.id);

    const rows = await db.withTenant({ orgId: orgOf(t) }, async (q) =>
      (await q.query<any>(`SELECT action, entity, details FROM audit_log WHERE entity IN ('asset','site') AND action <> 'create' ORDER BY id`)).rows);
    const upd = rows.filter((r) => r.action === 'update');
    expect(upd).toHaveLength(1);
    expect(upd[0].details.changes.name).toEqual({ from: 'A1', to: 'A1 renamed' });
    expect(Number(upd[0].details.changes.quantity.from)).toBe(1);
    expect(Number(upd[0].details.changes.quantity.to)).toBe(4);
    expect(rows.find((r) => r.action === 'delete')!.details).toEqual({ cascaded: { assets: 2 } });
    expect(rows.find((r) => r.action === 'restore')!.details).toEqual({ restored: { assets: 2 } });
  });
});

describe('the database itself forbids hard deletes', () => {
  it('the app role cannot DELETE data rows or touch the audit log', async () => {
    const t = await register();
    const e = await estate(t);
    const asTenant = (sql: string, params: unknown[] = []) => db.withTenant({ orgId: orgOf(t) }, (q) => q.query(sql, params));
    for (const [table, id] of [['client', e.client.id], ['region', e.region.id], ['site', e.s1.id], ['asset_type', e.type.id], ['asset', e.a1.id], ['forecast_scenario', e.scenario.id]]) {
      await expect(asTenant(`DELETE FROM ${table} WHERE id = $1`, [id]), table).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant('DELETE FROM audit_log'), 'audit delete').rejects.toThrow(/permission denied/);
    await expect(asTenant(`UPDATE audit_log SET action = 'x'`), 'audit update').rejects.toThrow(/permission denied/);
    // and nothing was lost
    expect(await db.admin(async (q) => Number((await q.query<{ n: string }>('SELECT count(*) AS n FROM asset WHERE id = $1', [e.a1.id])).rows[0]!.n))).toBe(1);
  });

  it('deleted rows are invisible to the app role unless asked for, and cannot be read across organisations', async () => {
    const t = await register();
    const e = await estate(t);
    await del(t, `/assets/${e.a1.id}`);
    const count = (ctx: object) => db.withTenant({ orgId: orgOf(t), ...ctx }, async (q) => Number((await q.query<{ n: string }>('SELECT count(*) AS n FROM asset WHERE id = $1', [e.a1.id])).rows[0]!.n));
    expect(await count({})).toBe(0);
    expect(await count({ includeDeleted: true })).toBe(1);
    const other = await register();
    expect(await db.withTenant({ orgId: orgOf(other), includeDeleted: true }, async (q) => (await q.query('SELECT 1 FROM asset WHERE id = $1', [e.a1.id])).rows.length)).toBe(0);
  });
});

describe('clearing optional fields on update', () => {
  it('lets a field be set back to empty so the type default applies again', async () => {
    const t = await register();
    const e = await estate(t);
    const a = (await http().post(`/api/sites/${e.s1.id}/assets`).set(auth(t)).send({ name: 'Own rate', assetTypeId: e.type.id, unitRate: 123, expectedLifeYears: 7, unit: 'ea' })).body;
    const get = async () => (await http().get(`/api/sites/${e.s1.id}/assets`).set(auth(t))).body.find((x: any) => x.id === a.id);
    expect(Number((await get()).unit_rate)).toBe(123);
    expect((await http().patch(`/api/assets/${a.id}`).set(auth(t)).send({ unitRate: null, expectedLifeYears: null, unit: null, assetTypeId: null })).status).toBe(200);
    expect(await get()).toMatchObject({ unit_rate: null, expected_life_years: null, unit: null, asset_type_id: null });
    expect((await http().patch(`/api/assets/${a.id}`).set(auth(t)).send({ name: null })).status).toBe(400); // required fields stay required
    expect((await http().patch(`/api/clients/${e.client.id}`).set(auth(t)).send({ code: null })).status).toBe(200);
  });
});
