import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoiceActions, priceInvoice } from '../lib';
import { mockApi, renderApp } from '../testing';

const client = { id: 'c1', name: 'TVNZ', code: 'TV', currency: 'NZD' };
const contractor = { id: 'r1', name: 'Acme Mowing', contact_name: null, email: null, phone: null, notes: null, contract_count: 1 };
const contract = { id: 'k1', code: 'GRD', name: 'Grounds', status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', contractor_id: 'r1', contractor_name: 'Acme Mowing', line_count: 1, open_work_orders: 1 };
const gst = { id: 't1', code: 'GST', name: 'GST 15%', rate: '15.0000', external_codes: { xero: 'INPUT2', other: 'KEEP' } };
const summary = (over: object = {}) => ({
  id: 'i1', client_id: 'c1', contractor_id: 'r1', contractor_name: 'Acme Mowing', contract_id: 'k1', contract_code: 'GRD', supplier_ref: 'INV-100', issue_date: '2026-04-01',
  due_date: '2026-05-01', currency: 'NZD', net: '250.00', tax: '37.50', gross: '287.50', status: 'received', source: 'keyed', notes: null, approved_at: null,
  override_reason: null, paid_on: null, line_count: 1, ...over,
});
const detail = (over: object = {}) => ({
  ...summary(over), lines: [{
    id: 'l1', position: 1, description: 'Mowing', quantity: '1.0000', unit_price: '250.0000', net: '250.00', tax_code_id: 't1', tax_code: 'GST', tax_amount: '37.50',
    work_order_id: 'w1', work_order_code: 'GRD-0001', account_code: null,
  }], warnings: [], ...over,
});
const list = (items: object[]) => ({ items, total: items.length, grossTotal: '287.50' });
const base = { 'GET /clients': [client], 'GET /contractors': [contractor], 'GET /clients/c1/contracts': [contract], 'GET /tax-codes': [gst], 'GET /clients/c1/work-orders': { items: [], total: 0 } };

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('invoice helpers', () => {
  it('prices the way the server does: whole cents, stated tax wins, then the rate', () => {
    expect(priceInvoice([
      { quantity: 3, unitPrice: 33.33, taxAmount: null, rate: 15 },
      { quantity: 1.5, unitPrice: 100, taxAmount: 7.5, rate: 15 },
      { quantity: 2, unitPrice: 10, taxAmount: null, rate: null },
    ])).toEqual({ net: 269.99, tax: 22.5, gross: 292.49 });
  });

  it('offers only moves the server allows, and never "exported"', () => {
    const all = (['received', 'approved', 'exported', 'paid', 'disputed', 'rejected'] as const).flatMap((s) => invoiceActions(s).map((a) => a.to));
    expect(all).not.toContain('exported');
    expect(invoiceActions('received').map((a) => a.to)).toEqual(['approved', 'disputed', 'rejected']);
    expect(invoiceActions('rejected').map((a) => a.to)).toEqual(['received']);
  });
});

describe('invoices tab', () => {
  it('lists invoices with their status and total, says it makes no payments, and lets a viewer look but not add', async () => {
    mockApi({ ...base, 'GET /clients/c1/invoices': list([summary(), summary({ id: 'i2', supplier_ref: 'INV-101', status: 'paid', paid_on: '2026-05-20' })]) });
    renderApp('/clients/c1/invoices', 'client_viewer');
    expect(await screen.findByText('INV-100')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Paid (recorded)')).toBeInTheDocument();
    expect(screen.getAllByText('$287.50').length).toBeGreaterThan(0);
    expect(screen.getByText(/does not make payments/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New invoice' })).not.toBeInTheDocument();
  });

  it('records a new invoice with a live total, and sends blank optionals as null', async () => {
    const calls = mockApi({
      ...base, 'GET /clients/c1/invoices': list([]), 'POST /clients/c1/invoices': { status: 201, body: { id: 'i9' } },
      'GET /invoices/i9': detail({ id: 'i9' }),
    });
    renderApp('/clients/c1/invoices', 'asset_manager');
    await userEvent.click(await screen.findByRole('button', { name: 'New invoice' }));
    const form = await screen.findByRole('form', { name: 'Record invoice' });
    await userEvent.selectOptions(within(form).getByLabelText('Contractor'), 'r1');
    await userEvent.type(within(form).getByLabelText('Their invoice number'), 'INV-9');
    await userEvent.type(within(form).getByLabelText('Line 1 description'), 'Mowing');
    await userEvent.type(within(form).getByLabelText('Line 1 unit price'), '100');
    await within(form).findByRole('option', { name: 'GST (15%)' });
    await userEvent.selectOptions(within(form).getByLabelText('Line 1 tax code'), 't1');
    expect(within(form).getByText(/Total \$115\.00/)).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Record invoice' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeDefined());
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      contractorId: 'r1', contractId: null, supplierRef: 'INV-9', dueDate: null, notes: null,
      lines: [{ description: 'Mowing', quantity: 1, unitPrice: 100, taxCodeId: 't1', taxAmount: null, workOrderId: null }],
    });
    expect(await screen.findByRole('heading', { name: /Invoice INV-100/ })).toBeInTheDocument(); // went to the new invoice
  });
});

describe('invoice page', () => {
  const open = (d: object, role = 'asset_manager', extra: Record<string, unknown> = {}) => {
    const calls = mockApi({ ...base, 'GET /invoices/i1': d, 'POST /invoices/i1/status': { status: 201, body: { id: 'i1' } }, ...extra });
    renderApp('/invoices/i1', role);
    return calls;
  };

  it('a clean invoice approves in one click', async () => {
    const calls = open(detail());
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ status: 'approved' });
  });

  it('shows matching warnings and only approves past them with a reason', async () => {
    const calls = open(detail({ warnings: [{ code: 'wo_not_complete', message: 'GRD-0001 is new, not complete.' }] }));
    expect(await screen.findByText('GRD-0001 is new, not complete.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve anyway…' }));
    const form = screen.getByRole('form', { name: 'Approve' });
    await userEvent.type(within(form).getByLabelText('Why approve despite the warnings?'), 'Agreed by phone');
    await userEvent.click(within(form).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ status: 'approved', override: true, reason: 'Agreed by phone' });
  });

  it('rejecting needs a reason', async () => {
    const calls = open(detail());
    await userEvent.click(await screen.findByRole('button', { name: 'Reject…' }));
    const form = screen.getByRole('form', { name: 'Reject' });
    await userEvent.type(within(form).getByLabelText('Reason'), 'Not our site');
    await userEvent.click(within(form).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ status: 'rejected', reason: 'Not our site' });
  });

  it('recording payment asks for the date as reported elsewhere and says nothing is paid from here', async () => {
    const calls = open(detail({ status: 'approved' }));
    expect(await screen.findByText(/does not make payments/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Record as paid…' }));
    const form = screen.getByRole('form', { name: 'Record as paid' });
    expect(within(form).getByText(/Nothing is paid from here/)).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ status: 'paid', paidOn: expect.stringMatching(/^\d{4}-\d\d-\d\d$/) });
  });

  it('a viewer sees the invoice but no actions; only received or disputed invoices can be edited', async () => {
    open(detail(), 'client_viewer');
    expect(await screen.findByRole('heading', { name: /Invoice INV-100/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('an approved invoice cannot be edited from the page', async () => {
    open(detail({ status: 'approved' }));
    await screen.findByRole('heading', { name: /Invoice INV-100/ });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
  });

  it('offers Delete to an administrator only while the invoice can still be deleted', async () => {
    open(detail({ status: 'approved' }), 'org_admin');
    await screen.findByRole('heading', { name: /Invoice INV-100/ });
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('offers Delete to an administrator for a received invoice', async () => {
    open(detail(), 'org_admin');
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('shows the server error when a move is refused', async () => {
    open(detail(), 'asset_manager', { 'POST /invoices/i1/status': { status: 409, body: { message: 'Invoice is already approved' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invoice is already approved');
  });
});

describe('tax codes page', () => {
  it('adds a code with the accounting system names, and keeps other systems’ entries when editing', async () => {
    const calls = mockApi({ ...base, 'POST /tax-codes': { status: 201, body: { id: 't2' } }, 'PATCH /tax-codes/t1': { body: { id: 't1' } } });
    renderApp('/tax-codes', 'org_admin');
    expect(await screen.findByText('GST 15%')).toBeInTheDocument();
    expect(screen.getByText('INPUT2')).toBeInTheDocument();

    const add = screen.getByRole('form', { name: 'Add tax code' });
    await userEvent.type(within(add).getByLabelText('Code'), 'ZERO');
    await userEvent.type(within(add).getByLabelText('Name'), 'Zero rated');
    await userEvent.type(within(add).getByLabelText('Rate %'), '0');
    await userEvent.type(within(add).getByLabelText('MYOB tax code'), 'FRE');
    await userEvent.click(within(add).getByRole('button', { name: 'Add tax code' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeDefined());
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ code: 'ZERO', name: 'Zero rated', rate: 0, externalCodes: { myob: 'FRE' } });

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('form', { name: 'Edit tax code GST' });
    await userEvent.clear(within(edit).getByLabelText('Xero tax type'));
    await userEvent.type(within(edit).getByLabelText('SAP tax code'), 'V1');
    await userEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeDefined());
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ code: 'GST', name: 'GST 15%', rate: 15, externalCodes: { other: 'KEEP', sap: 'V1' } });
  });
});
