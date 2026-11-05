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

async function register() {
  const email = `inv${++seq}@example.com`;
  const r = await http().post('/api/auth/register').send({ organisationName: email, kind: 'CONSULTANCY', email, displayName: `User ${seq}`, password: 'correct-horse-battery' });
  expect(r.status).toBe(201);
  return r.body.token as string;
}
async function addUser(ownerToken: string, role: string) {
  const email = `inv-u${++seq}@example.com`;
  const hash = await hashPassword('correct-horse-battery');
  await db.admin(async (q) => {
    const u = (await q.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ($1,'U',$2) RETURNING id`, [email, hash])).rows[0]!;
    await q.query('INSERT INTO membership (user_id, organisation_id, role) VALUES ($1,$2,$3)', [u.id, orgOf(ownerToken), role]);
  });
  return (await http().post('/api/auth/login').send({ email, password: 'correct-horse-battery' })).body.token as string;
}

/** A client, a contractor with an active contract, and three monthly work orders (Jan to Mar 2026) costing 250 each. */
async function setup(t: string) {
  const client = (await http().post('/api/clients').set(auth(t)).send({ name: `Client ${++seq}`, currency: 'NZD' })).body;
  const site = (await http().post(`/api/clients/${client.id}/sites`).set(auth(t)).send({ code: 'S1', name: 'Site 1' })).body;
  const contractor = (await http().post('/api/contractors').set(auth(t)).send({ name: `Mowers ${++seq}` })).body;
  const contract = (await http().post(`/api/clients/${client.id}/contracts`).set(auth(t)).send({
    contractorId: contractor.id, code: `C${seq}`, name: 'Grounds', status: 'active', startDate: '2026-01-01', endDate: '2026-12-31',
  })).body;
  await http().post(`/api/contracts/${contract.id}/lines`).set(auth(t)).send({
    siteId: site.id, description: 'Mow grounds', frequencyInterval: 1, frequencyUnit: 'month', firstDueDate: '2026-01-15', costPerOccurrence: 250,
  });
  await http().post(`/api/contracts/${contract.id}/generate`).set(auth(t)).send({ through: '2026-03-31' });
  const wos = (await http().get(`/api/clients/${client.id}/work-orders`).set(auth(t))).body.items as any[];
  const gst = (await http().post('/api/tax-codes').set(auth(t)).send({ code: `GST${seq}`, name: 'GST 15%', rate: 15, externalCodes: { xero: 'INPUT2' } })).body;
  return { client, site, contractor, contract, wos, gst };
}
const complete = (t: string, id: string) => http().post(`/api/work-orders/${id}/status`).set(auth(t)).send({ status: 'complete' });
const line = (over: object = {}) => ({ description: 'Mowing', quantity: 1, unitPrice: 250, ...over });
const post = (t: string, clientId: string, body: object) => http().post(`/api/clients/${clientId}/invoices`).set(auth(t)).send(body);
const getInv = async (t: string, id: string) => (await http().get(`/api/invoices/${id}`).set(auth(t))).body;
const status = (t: string, id: string, body: object) => http().post(`/api/invoices/${id}/status`).set(auth(t)).send(body);
const del = (t: string, path: string) => http().delete(`/api/${path}`).set(auth(t));
const restore = (t: string, entity: string, id: string) => http().post(`/api/trash/${entity}/${id}/restore`).set(auth(t));
const trash = async (t: string) => (await http().get('/api/trash').set(auth(t))).body as any[];
const invoice = (e: Awaited<ReturnType<typeof setup>>, over: object = {}) => ({
  contractorId: e.contractor.id, contractId: e.contract.id, supplierRef: `INV-${++seq}`, issueDate: '2026-04-01', dueDate: '2026-05-01', lines: [line()], ...over,
});

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const mod = await Test.createTestingModule({ imports: [AppModule.register(db, { jwtSecret: 'x'.repeat(40) })] }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
});
afterAll(async () => { await app.close(); await cleanup(); });

describe('tax codes', () => {
  it('are created, updated, unique by code, and kept per organisation', async () => {
    const t = await register();
    const r = (await http().post('/api/tax-codes').set(auth(t)).send({ code: 'GST', name: 'GST 15%', rate: 15, externalCodes: { xero: 'INPUT2', myob: 'GST' } }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: 'GST', external_codes: { xero: 'INPUT2', myob: 'GST' } });
    expect((await http().post('/api/tax-codes').set(auth(t)).send({ code: 'gst', name: 'dup', rate: 15 })).status).toBe(409);
    expect((await http().post('/api/tax-codes').set(auth(t)).send({ code: 'BAD', name: 'x', rate: 120 })).status).toBe(400);
    expect((await http().post('/api/tax-codes').set(auth(t)).send({ code: 'NORATE', name: 'x' })).status).toBe(400);
    expect((await http().patch(`/api/tax-codes/${r.body.id}`).set(auth(t)).send({ rate: 10 })).status).toBe(200);
    expect((await http().get('/api/tax-codes').set(auth(t))).body).toMatchObject([{ code: 'GST', rate: '10.0000' }]);

    const other = await register();
    expect((await http().get('/api/tax-codes').set(auth(other))).body).toEqual([]);
    expect((await http().patch(`/api/tax-codes/${r.body.id}`).set(auth(other)).send({ rate: 0 })).status).toBe(404);
    const viewer = await addUser(t, 'client_viewer');
    expect((await http().get('/api/tax-codes').set(auth(viewer))).status).toBe(200);
    expect((await http().post('/api/tax-codes').set(auth(viewer)).send({ code: 'V', name: 'v', rate: 1 })).status).toBe(403);
  });
});

describe('recording invoices', () => {
  it('works out net, tax and gross from the lines, in whole cents', async () => {
    const t = await register();
    const e = await setup(t);
    const r = await post(t, e.client.id, invoice(e, { lines: [
      line({ quantity: 3, unitPrice: 33.33, taxCodeId: e.gst.id }),   // net 99.99, tax 15.00 (14.9985 rounds)
      line({ quantity: 1.5, unitPrice: 100, taxAmount: 7.5 }),         // stated tax wins: net 150.00
      line({ quantity: 2, unitPrice: 10 }),                            // no tax code, no tax
    ] }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ net: '269.99', tax: '22.50', gross: '292.49', status: 'received' });
    const inv = await getInv(t, r.body.id);
    expect(inv).toMatchObject({ currency: 'NZD', contractor_name: expect.any(String), contract_code: e.contract.code, source: 'keyed', warnings: [] });
    expect(inv.lines.map((l: any) => [l.position, l.net, l.tax_amount, l.tax_code])).toEqual([[1, '99.99', '15.00', e.gst.code], [2, '150.00', '7.50', null], [3, '20.00', '0.00', null]]);
  });

  it('validates what it is given', async () => {
    const t = await register();
    const e = await setup(t);
    const bad = async (over: object, code = 400) => expect((await post(t, e.client.id, invoice(e, over))).status, JSON.stringify(over)).toBe(code);
    await bad({ lines: [] });
    await bad({ supplierRef: ' ' });
    await bad({ issueDate: '2026-13-01' });
    await bad({ dueDate: '2026-03-01' });                      // before the invoice date
    await bad({ lines: [line({ quantity: 0 })] });
    await bad({ lines: [line({ unitPrice: -1 })] });
    await bad({ currency: 'NZ' });
    await bad({ contractorId: '00000000-0000-0000-0000-000000000000' });
    await bad({ lines: [line({ taxCodeId: '00000000-0000-0000-0000-000000000000' })] });
    await bad({ lines: [line({ workOrderId: '00000000-0000-0000-0000-000000000000' })] });
    // a contract that belongs to another contractor
    const other = (await http().post('/api/contractors').set(auth(t)).send({ name: 'Someone else' })).body;
    await bad({ contractorId: other.id });
    expect((await post(t, '00000000-0000-0000-0000-000000000000', invoice(e))).status).toBe(404);
  });

  it('refuses the same contractor invoice number twice, even at the same moment, but not for another contractor', async () => {
    const t = await register();
    const e = await setup(t);
    const body = invoice(e, { supplierRef: 'A-100' });
    expect((await post(t, e.client.id, body)).status).toBe(201);
    expect((await post(t, e.client.id, { ...body, supplierRef: 'a-100' })).status).toBe(409);
    const other = (await http().post('/api/contractors').set(auth(t)).send({ name: 'Other firm' })).body;
    expect((await post(t, e.client.id, { ...body, contractorId: other.id, contractId: undefined })).status).toBe(201);
    const results = await Promise.all([1, 2, 3, 4].map(() => post(t, e.client.id, invoice(e, { supplierRef: 'RACE-1' }))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
  });

  it('only accepts work orders of the same client, and lists with filters', async () => {
    const t = await register();
    const e = await setup(t);
    const e2 = await setup(t);
    expect((await post(t, e.client.id, invoice(e, { lines: [line({ workOrderId: e2.wos[0].id })] }))).status).toBe(400);
    const a = (await post(t, e.client.id, invoice(e, { issueDate: '2026-04-01' }))).body;
    const b = (await post(t, e.client.id, invoice(e, { issueDate: '2026-06-01', dueDate: '2026-07-01', lines: [line({ unitPrice: 100 })] }))).body;
    await status(t, b.id, { status: 'approved' });
    const list = async (q = '') => (await http().get(`/api/clients/${e.client.id}/invoices${q}`).set(auth(t))).body;
    expect((await list()).items.map((i: any) => i.id)).toEqual([b.id, a.id]); // newest first
    expect((await list('?status=approved')).items.map((i: any) => i.id)).toEqual([b.id]);
    expect((await list('?from=2026-05-01')).total).toBe(1);
    expect((await list('?contractorId=' + e.contractor.id)).total).toBe(2);
    expect(await list()).toMatchObject({ total: 2, grossTotal: '350.00' });
    expect((await list('?limit=1&offset=1')).items.map((i: any) => i.id)).toEqual([a.id]);
    expect((await list('?status=bogus'))).toMatchObject({ statusCode: 400 });
    expect((await http().get(`/api/clients/${e2.client.id}/invoices`).set(auth(t))).body.total).toBe(0);
  });

  it('can be edited while received or disputed (lines replaced as a set), not once approved', async () => {
    const t = await register();
    const e = await setup(t);
    const inv = (await post(t, e.client.id, invoice(e))).body;
    const patch = (b: object) => http().patch(`/api/invoices/${inv.id}`).set(auth(t)).send(b);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ notes: 'Checked with site', dueDate: '2026-06-01' })).status).toBe(200);
    expect((await patch({ lines: [line({ quantity: 2, unitPrice: 100, taxCodeId: e.gst.id }), line({ description: 'Extra', unitPrice: 50 })] })).body).toMatchObject({ net: '250.00', tax: '30.00', gross: '280.00' });
    const after = await getInv(t, inv.id);
    expect(after.lines).toHaveLength(2);
    expect(after).toMatchObject({ notes: 'Checked with site', due_date: '2026-06-01', gross: '280.00' });
    expect((await patch({ supplierRef: 'x', contractorId: '00000000-0000-0000-0000-000000000000' })).status).toBe(400);
    expect((await patch({ dueDate: '2026-01-01' })).status).toBe(400);   // before the invoice date

    expect((await status(t, inv.id, { status: 'approved' })).status).toBe(201);
    expect((await patch({ notes: 'too late' })).status).toBe(409);
    expect((await status(t, inv.id, { status: 'received' })).status).toBe(201); // reopen
    expect((await patch({ notes: 'now ok' })).status).toBe(200);

    // the replaced lines are kept (soft deleted), not destroyed
    const kept = await db.admin(async (q) => Number((await q.query<{ n: string }>('SELECT count(*) AS n FROM invoice_line WHERE invoice_id = $1 AND deleted_at IS NOT NULL', [inv.id])).rows[0]!.n));
    expect(kept).toBe(1);
  });

  it('is private to the organisation and its roles', async () => {
    const t = await register();
    const e = await setup(t);
    const inv = (await post(t, e.client.id, invoice(e))).body;
    const other = await register();
    expect((await http().get(`/api/invoices/${inv.id}`).set(auth(other))).status).toBe(404);
    expect((await status(other, inv.id, { status: 'approved' })).status).toBe(404);
    const viewer = await addUser(t, 'client_viewer');
    const contractor = await addUser(t, 'contractor');
    expect((await http().get(`/api/invoices/${inv.id}`).set(auth(viewer))).status).toBe(200);
    expect((await post(viewer, e.client.id, invoice(e))).status).toBe(403);
    expect((await status(viewer, inv.id, { status: 'approved' })).status).toBe(403);
    expect((await http().get(`/api/invoices/${inv.id}`).set(auth(contractor))).status).toBe(403);
    const assessor = await addUser(t, 'assessor');
    expect((await status(assessor, inv.id, { status: 'approved' })).status).toBe(403);
  });
});

describe('approving against work orders', () => {
  it('a clean match approves and fills in the work order actual cost', async () => {
    const t = await register();
    const e = await setup(t);
    await complete(t, e.wos[0].id);
    const inv = (await post(t, e.client.id, invoice(e, { lines: [line({ workOrderId: e.wos[0].id })] }))).body;
    expect((await getInv(t, inv.id)).warnings).toEqual([]);
    const r = await status(t, inv.id, { status: 'approved' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('approved');
    const wo = (await http().get(`/api/work-orders/${e.wos[0].id}`).set(auth(t))).body;
    expect(Number(wo.actual_cost)).toBe(250);
    expect(await getInv(t, inv.id)).toMatchObject({ status: 'approved', override_reason: null, approved_at: expect.any(String) });
  });

  it('does not overwrite an actual cost somebody already recorded', async () => {
    const t = await register();
    const e = await setup(t);
    await http().post(`/api/work-orders/${e.wos[0].id}/status`).set(auth(t)).send({ status: 'complete', actualCost: 240 });
    const inv = (await post(t, e.client.id, invoice(e, { lines: [line({ workOrderId: e.wos[0].id })] }))).body;
    expect((await status(t, inv.id, { status: 'approved' })).status).toBe(201);
    expect(Number((await http().get(`/api/work-orders/${e.wos[0].id}`).set(auth(t))).body.actual_cost)).toBe(240);
  });

  it('warns about incomplete work, another contractor, a different contract, being billed twice, and going over the estimate', async () => {
    const t = await register();
    const e = await setup(t);
    const [w1, w2, w3] = e.wos;
    await complete(t, w1.id); await complete(t, w2.id);
    // invoice 1 bills w1 properly; invoice 2 bills w1 again, w2 at far above its estimate, and w3 which is not complete
    const first = (await post(t, e.client.id, invoice(e, { supplierRef: 'FIRST', lines: [line({ workOrderId: w1.id })] }))).body;
    const second = (await post(t, e.client.id, invoice(e, { supplierRef: 'SECOND', lines: [
      line({ workOrderId: w1.id }), line({ workOrderId: w2.id, unitPrice: 400 }), line({ workOrderId: w3.id }),
    ] }))).body;
    const codes = (await getInv(t, second.id)).warnings.map((w: any) => w.code).sort();
    expect(codes).toEqual(['wo_already_invoiced', 'wo_not_complete', 'wo_over_estimate', 'wo_over_estimate'].sort());
    const msgs = (await getInv(t, second.id)).warnings.map((w: any) => w.message).join(' | ');
    expect(msgs).toContain('also on invoice FIRST');
    expect(msgs).toContain('not complete');

    // approving is refused with the list, and is allowed only with an override and a reason
    const refused = await status(t, second.id, { status: 'approved' });
    expect(refused.status).toBe(409);
    expect(refused.body.warnings).toHaveLength(4);
    expect((await status(t, second.id, { status: 'approved', override: true })).status).toBe(409); // no reason
    expect((await status(t, second.id, { status: 'approved', reason: 'because' })).status).toBe(409); // reason without override
    const ok = await status(t, second.id, { status: 'approved', override: true, reason: 'Variation agreed by phone' });
    expect(ok.status).toBe(201);
    expect(await getInv(t, second.id)).toMatchObject({ status: 'approved', override_reason: 'Variation agreed by phone' });
    const audit = await db.admin(async (q) => (await q.query<{ details: any }>(
      `SELECT details FROM audit_log WHERE entity = 'invoice' AND entity_id = $1 AND details ? 'overrodeWarnings'`, [second.id])).rows);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details.reason).toBe('Variation agreed by phone');
    expect(first.id).toBeTruthy();

    // a work order assigned to a different contractor, and a different contract
    const stranger = (await http().post('/api/contractors').set(auth(t)).send({ name: 'Stranger Ltd' })).body;
    const third = (await post(t, e.client.id, invoice(e, { contractorId: stranger.id, contractId: undefined, lines: [line({ workOrderId: w2.id })] }))).body;
    expect((await getInv(t, third.id)).warnings.map((w: any) => w.code)).toContain('wo_contractor');
  });

  it('a total within the tolerance of the estimate is fine; a rejected invoice does not count as billed', async () => {
    const t = await register();
    const e = await setup(t);
    await complete(t, e.wos[0].id);
    const a = (await post(t, e.client.id, invoice(e, { lines: [line({ workOrderId: e.wos[0].id, unitPrice: 270 })] }))).body; // 8% over
    expect((await getInv(t, a.id)).warnings).toEqual([]);
    await status(t, a.id, { status: 'rejected', reason: 'wrong amount' });
    const b = (await post(t, e.client.id, invoice(e, { lines: [line({ workOrderId: e.wos[0].id })] }))).body;
    expect((await getInv(t, b.id)).warnings).toEqual([]); // the rejected one is ignored
  });
});

describe('status flow', () => {
  it('follows the flow, needs reasons to dispute or reject, and never lets exported be set by hand', async () => {
    const t = await register();
    const e = await setup(t);
    const inv = (await post(t, e.client.id, invoice(e))).body;
    expect((await status(t, inv.id, { status: 'received' })).status).toBe(409);        // already
    expect((await status(t, inv.id, { status: 'paid' })).status).toBe(409);            // must be approved first
    expect((await status(t, inv.id, { status: 'exported' })).status).toBe(400);        // only an export does that
    expect((await status(t, inv.id, { status: 'disputed' })).status).toBe(400);        // reason needed
    expect((await status(t, inv.id, { status: 'disputed', reason: 'Rate is wrong' })).status).toBe(201);
    expect((await status(t, inv.id, { status: 'approved' })).status).toBe(409);        // back to received first
    expect((await status(t, inv.id, { status: 'received' })).status).toBe(201);
    expect((await status(t, inv.id, { status: 'rejected' })).status).toBe(400);
    expect((await status(t, inv.id, { status: 'rejected', reason: 'Not ours' })).status).toBe(201);
    expect((await status(t, inv.id, { status: 'received' })).status).toBe(201);
    expect((await status(t, inv.id, { status: 'approved' })).status).toBe(201);
    expect((await status(t, inv.id, { status: 'bogus' })).status).toBe(400);
    expect((await status(t, '00000000-0000-0000-0000-000000000000', { status: 'approved' })).status).toBe(404);
  });

  it('records payment as information only: a date, never in the future, not before the invoice, cleared when reopened', async () => {
    const t = await register();
    const e = await setup(t);
    const inv = (await post(t, e.client.id, invoice(e, { issueDate: '2026-04-01' }))).body;
    await status(t, inv.id, { status: 'approved' });
    expect((await status(t, inv.id, { status: 'paid', paidOn: '2999-01-01' })).status).toBe(400);
    expect((await status(t, inv.id, { status: 'paid', paidOn: '2026-03-01' })).status).toBe(400);
    const paid = await status(t, inv.id, { status: 'paid', paidOn: '2026-05-20' });
    expect(paid.body).toMatchObject({ status: 'paid', paid_on: '2026-05-20' });
    expect((await http().patch(`/api/invoices/${inv.id}`).set(auth(t)).send({ notes: 'x' })).status).toBe(409);
    expect((await status(t, inv.id, { status: 'received' })).status).toBe(409);        // paid cannot go straight back
    // nothing in the API moves money: there is no payment endpoint at all
    expect((await http().post(`/api/invoices/${inv.id}/pay`).set(auth(t)).send({})).status).toBe(404);
  });

  it('writes an audit trail of what happened', async () => {
    const t = await register();
    const e = await setup(t);
    const inv = (await post(t, e.client.id, invoice(e))).body;
    await status(t, inv.id, { status: 'approved' });
    await status(t, inv.id, { status: 'received' });
    const rows = await db.admin(async (q) => (await q.query<{ action: string; details: any }>(
      `SELECT action, details FROM audit_log WHERE entity = 'invoice' AND entity_id = $1 ORDER BY id`, [inv.id])).rows);
    expect(rows.map((r) => r.action)).toEqual(['create', 'update', 'update']);
    expect(rows[1]!.details.changes.status).toEqual({ from: 'received', to: 'approved' });
    expect(rows[2]!.details.reopened).toBe(true);
  });
});

describe('deleting and restoring (soft)', () => {
  it('an invoice can be deleted only before it is approved, then restored with its lines', async () => {
    const t = await register();
    const e = await setup(t);
    const inv = (await post(t, e.client.id, invoice(e, { lines: [line(), line({ description: 'Second' })] }))).body;
    await status(t, inv.id, { status: 'approved' });
    expect((await del(t, `invoices/${inv.id}`)).status).toBe(409);
    await status(t, inv.id, { status: 'received' });
    expect((await del(t, `invoices/${inv.id}`)).body).toMatchObject({ cascaded: { invoiceLines: 2 } });
    expect((await http().get(`/api/invoices/${inv.id}`).set(auth(t))).status).toBe(404);
    expect((await trash(t)).find((x) => x.entity === 'invoice')).toMatchObject({ id: inv.id, includes: 2 });
    // its number can be reused while it is in the trash, which then blocks the restore
    const again = await post(t, e.client.id, invoice(e, { supplierRef: inv.supplier_ref }));
    expect(again.status).toBe(201);
    expect((await restore(t, 'invoice', inv.id)).status).toBe(409);
    await del(t, `invoices/${again.body.id}`);
    expect((await restore(t, 'invoice', inv.id)).body).toMatchObject({ alsoRestored: { invoiceLines: 2 } });
    expect((await getInv(t, inv.id)).lines).toHaveLength(2);
  });

  it('restoring brings back the lines deleted with it, not lines that were replaced earlier', async () => {
    const t = await register();
    const e = await setup(t);
    const inv = (await post(t, e.client.id, invoice(e))).body;
    await http().patch(`/api/invoices/${inv.id}`).set(auth(t)).send({ lines: [line({ description: 'A' }), line({ description: 'B' })] });
    await del(t, `invoices/${inv.id}`);
    await restore(t, 'invoice', inv.id);
    expect((await getInv(t, inv.id)).lines.map((l: any) => l.description)).toEqual(['A', 'B']);
  });

  it('things that invoices depend on cannot be deleted from under them', async () => {
    const t = await register();
    const e = await setup(t);
    await complete(t, e.wos[0].id);
    const inv = (await post(t, e.client.id, invoice(e, { lines: [line({ workOrderId: e.wos[0].id, taxCodeId: e.gst.id })] }))).body;
    expect((await del(t, `contractors/${e.contractor.id}`)).status).toBe(409);
    expect((await del(t, `contracts/${e.contract.id}`)).status).toBe(409);
    expect((await del(t, `work-orders/${e.wos[0].id}`)).status).toBe(409);
    expect((await del(t, `sites/${e.site.id}`)).status).toBe(409);
    expect((await del(t, `tax-codes/${e.gst.id}`)).status).toBe(409);
    expect((await del(t, `work-orders/${e.wos[1].id}`)).status).toBe(200);   // an unbilled one is fine
    await del(t, `invoices/${inv.id}`);
    expect((await del(t, `tax-codes/${e.gst.id}`)).status).toBe(200);
    expect((await del(t, `work-orders/${e.wos[0].id}`)).status).toBe(200);
    // an invoice that no longer has a live work order, tax code or contract cannot be restored into a broken state
    expect((await restore(t, 'invoice', inv.id)).status).toBe(409);
    await restore(t, 'work-order', e.wos[0].id);
    expect((await restore(t, 'invoice', inv.id)).status).toBe(409); // tax code still deleted
    expect((await restore(t, 'tax-code', e.gst.id)).status).toBe(201);
    expect((await restore(t, 'invoice', inv.id)).status).toBe(201);
  });

  it('deleting a client takes its invoices, and restoring the client brings them back', async () => {
    const t = await register();
    const e = await setup(t);
    const inv = (await post(t, e.client.id, invoice(e, { lines: [line(), line()] }))).body;
    const r = await del(t, `clients/${e.client.id}`);
    expect(r.status).toBe(200);
    expect(r.body.cascaded).toMatchObject({ invoices: 1, invoiceLines: 2 });
    expect((await http().get(`/api/invoices/${inv.id}`).set(auth(t))).status).toBe(404);
    expect((await restore(t, 'client', e.client.id)).body.alsoRestored).toMatchObject({ invoices: 1, invoiceLines: 2 });
    expect((await getInv(t, inv.id)).lines).toHaveLength(2);
  });

  it('only administrators delete or restore invoices and tax codes', async () => {
    const t = await register();
    const e = await setup(t);
    const inv = (await post(t, e.client.id, invoice(e))).body;
    const manager = await addUser(t, 'asset_manager');
    expect((await del(manager, `invoices/${inv.id}`)).status).toBe(403);
    expect((await del(manager, `tax-codes/${e.gst.id}`)).status).toBe(403);
    await del(t, `invoices/${inv.id}`);
    expect((await restore(manager, 'invoice', inv.id)).status).toBe(403);
  });
});

describe('the database forbids hard deletes of these tables too', () => {
  it('the app role cannot DELETE tax codes, invoices or invoice lines', async () => {
    const t = await register();
    const e = await setup(t);
    await post(t, e.client.id, invoice(e));
    const asTenant = (sql: string) => db.withTenant({ orgId: orgOf(t) }, (q) => q.query(sql));
    for (const table of ['tax_code', 'invoice', 'invoice_line']) await expect(asTenant(`DELETE FROM ${table}`), table).rejects.toThrow(/permission denied/);
  });

  it('cannot be given inconsistent totals or a paid invoice without a date', async () => {
    const t = await register();
    const e = await setup(t);
    const inv = (await post(t, e.client.id, invoice(e))).body;
    const run = (sql: string) => db.admin((q) => q.query(sql));
    await expect(run(`UPDATE invoice SET gross = gross + 1 WHERE id = '${inv.id}'`)).rejects.toThrow();
    await expect(run(`UPDATE invoice SET status = 'paid' WHERE id = '${inv.id}'`)).rejects.toThrow();
  });
});
