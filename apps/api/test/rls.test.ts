import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db';
import { createTestDb } from './helpers';

let db: Database;
let cleanup: () => Promise<void>;
const orgA = '11111111-1111-1111-1111-111111111111';
const orgB = '22222222-2222-2222-2222-222222222222';
const clientA1 = 'a1a1a1a1-0000-0000-0000-000000000001';
const clientA2 = 'a2a2a2a2-0000-0000-0000-000000000002';
const clientB1 = 'b1b1b1b1-0000-0000-0000-000000000003';

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.admin(async (q) => {
    await q.query(`INSERT INTO organisation (id,name,kind) VALUES ($1,'A','CONSULTANCY'),($2,'B','OWNER')`, [orgA, orgB]);
    await q.query(
      `INSERT INTO client (id,organisation_id,name) VALUES ($1,$4,'A1'),($2,$4,'A2'),($3,$5,'B1')`,
      [clientA1, clientA2, clientB1, orgA, orgB],
    );
    await q.query(
      `INSERT INTO site (organisation_id,client_id,code,name) VALUES ($1,$2,'S1','A1 site'),($1,$3,'S2','A2 site'),($4,$5,'S1','B1 site')`,
      [orgA, clientA1, clientA2, orgB, clientB1],
    );
  });
});
afterAll(() => cleanup());

const sites = (ctx: Parameters<Database['withTenant']>[0]) =>
  db.withTenant(ctx, async (q) => (await q.query<{ name: string }>('SELECT name FROM site ORDER BY name')).rows.map((r) => r.name));

describe('row level security', () => {
  it('org A sees only its own sites', async () => {
    expect(await sites({ orgId: orgA })).toEqual(['A1 site', 'A2 site']);
  });
  it('org B cannot see org A data', async () => {
    expect(await sites({ orgId: orgB })).toEqual(['B1 site']);
  });
  it('client grants restrict a user to specific clients', async () => {
    expect(await sites({ orgId: orgA, clientIds: [clientA1] })).toEqual(['A1 site']);
  });
  it('no tenant context sees nothing', async () => {
    const rows = await db.withTenant({ orgId: '' }, async (q) => (await q.query('SELECT 1 FROM site')).rows);
    expect(rows).toHaveLength(0);
  });
  it('rejects writing into another organisation', async () => {
    await expect(
      db.withTenant({ orgId: orgB }, (q) =>
        q.query(`INSERT INTO site (organisation_id,client_id,code,name) VALUES ($1,$2,'X','evil')`, [orgA, clientA1]),
      ),
    ).rejects.toThrow();
  });
  it('rejects a restricted user writing to a client outside their grant', async () => {
    await expect(
      db.withTenant({ orgId: orgA, clientIds: [clientA1] }, (q) =>
        q.query(`INSERT INTO site (organisation_id,client_id,code,name) VALUES ($1,$2,'Y','nope')`, [orgA, clientA2]),
      ),
    ).rejects.toThrow();
  });
  it('composite foreign keys block cross-tenant references', async () => {
    // org B user tries to create an asset in org B but pointing at org A's site id
    const siteA = await db.admin(async (q) => (await q.query<{ id: string }>(`SELECT id FROM site WHERE name='A1 site'`)).rows[0]!.id);
    await expect(
      db.withTenant({ orgId: orgB }, (q) =>
        q.query(`INSERT INTO asset (organisation_id,client_id,site_id,name) VALUES ($1,$2,$3,'x')`, [orgB, clientB1, siteA]),
      ),
    ).rejects.toThrow();
  });
  it('updates cannot move a row to another organisation', async () => {
    await expect(
      db.withTenant({ orgId: orgA }, (q) => q.query(`UPDATE site SET organisation_id=$1 WHERE name='A1 site'`, [orgB])),
    ).rejects.toThrow();
  });
});
