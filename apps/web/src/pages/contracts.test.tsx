import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderApp } from '../testing';

const client = { id: 'c1', name: 'TVNZ', code: 'TV', currency: 'AUD' };
const contractor = { id: 'r1', name: 'Acme Mowing', contact_name: 'Pat', email: 'pat@acme.test', phone: '021 555', notes: null, contract_count: 2 };
const summary = { id: 'k1', code: 'GRD-26', name: 'Grounds 2026', status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', contractor_id: 'r1', contractor_name: 'Acme Mowing', line_count: 2, open_work_orders: 5 };
const siteLine = { id: 'l1', description: 'Mow grounds', frequency_interval: 1, frequency_unit: 'month', first_due_date: '2026-01-15', cost_per_occurrence: '250.00', site_id: 's1', asset_id: null, site_code: 'S1', site_name: 'Site One', asset_name: null, asset_site_code: null };
const assetLine = { id: 'l2', description: 'Annual aircon service', frequency_interval: 1, frequency_unit: 'year', first_due_date: '2026-03-01', cost_per_occurrence: '480.00', site_id: null, asset_id: 'a1', site_code: null, site_name: null, asset_name: 'Split system', asset_site_code: 'S1' };
const detail = (over: object = {}) => ({ ...summary, client_id: 'c1', notes: null, lines: [siteLine, assetLine], workOrderCounts: { new: 4, complete: 1 }, ...over });
const sites = [{ id: 's1', code: 'S1', name: 'Site One', site_class: null, address: null, region_id: null, region_code: null, region_name: null }];
const wo = (over: object = {}) => ({
  id: 'w1', code: 'GRD-26-0001', title: 'Mow grounds', status: 'new', due_date: '2020-01-15', estimated_cost: '250.00', actual_cost: null, completed_on: null, notes: null,
  client_id: 'c1', site_id: 's1', site_code: 'S1', site_name: 'Site One', asset_id: null, asset_name: null, contract_id: 'k1', contract_code: 'GRD-26', contract_line_id: 'l1',
  contractor_id: 'r1', contractor_name: 'Acme Mowing', ...over,
});
const page = (items: object[], total = items.length) => ({ items, total });

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('contractors page', () => {
  it('lists contractors; an administrator can add, edit and delete; blank optional fields are sent as null', async () => {
    const calls = mockApi({
      'GET /clients': [client], 'GET /contractors': [contractor],
      'POST /contractors': { status: 201, body: { id: 'r2' } }, 'PATCH /contractors/r1': { body: { id: 'r1' } }, 'DELETE /contractors/r1': { body: { deleted: 'r1' } },
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/contractors', 'org_admin');
    expect(await screen.findByText('Acme Mowing')).toBeInTheDocument();
    expect(screen.getByText('pat@acme.test')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name'), 'Fresh Air Ltd');
    await userEvent.click(screen.getByRole('button', { name: 'Add contractor' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeDefined());
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'Fresh Air Ltd', contactName: null, email: null, phone: null, notes: null });

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit contractor Acme Mowing' });
    await userEvent.clear(within(form).getByLabelText('Phone'));
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeDefined());
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ name: 'Acme Mowing', contactName: 'Pat', email: 'pat@acme.test', phone: null, notes: null });

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/contractors/r1')).toBe(true));
    expect(confirm.mock.calls[0]![0]).toMatch(/moves to the Trash/);
  });

  it('shows the reason when a contractor in use cannot be deleted, and hides controls from other roles', async () => {
    mockApi({ 'GET /clients': [client], 'GET /contractors': [contractor], 'DELETE /contractors/r1': { status: 409, body: { message: '2 contracts use this contractor. Change or delete them first.' } } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { unmount } = renderApp('/contractors', 'org_admin');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('2 contracts use this contractor');
    unmount();

    renderApp('/contractors', 'client_viewer');
    await screen.findByText('Acme Mowing');
    expect(screen.queryByRole('button', { name: 'Add contractor' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});

describe("a client's contracts", () => {
  it('lists contracts with links, and adds one', async () => {
    const calls = mockApi({ 'GET /clients': [client], 'GET /clients/c1/contracts': [summary], 'GET /contractors': [contractor], 'POST /clients/c1/contracts': { status: 201, body: { id: 'k2' } } });
    renderApp('/clients/c1/contracts', 'asset_manager');
    const link = await screen.findByRole('link', { name: 'GRD-26' });
    expect(link).toHaveAttribute('href', '/contracts/k1');
    expect(screen.getByText('2026-01-01 to 2026-12-31')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Contractor/ }), 'r1');
    await userEvent.type(screen.getByLabelText('Code'), 'AIR-26');
    await userEvent.type(screen.getByLabelText('Name'), 'Aircon 2026');
    await userEvent.click(screen.getByRole('button', { name: 'Add contract' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeDefined());
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ contractorId: 'r1', code: 'AIR-26', name: 'Aircon 2026', status: 'draft' });
  });

  it('asks for a contractor first when there are none, and gives viewers no form', async () => {
    mockApi({ 'GET /clients': [client], 'GET /clients/c1/contracts': [], 'GET /contractors': [] });
    const { unmount } = renderApp('/clients/c1/contracts', 'asset_manager');
    expect(await screen.findByText(/Add a contractor first/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add contract' })).not.toBeInTheDocument();
    unmount();
    renderApp('/clients/c1/contracts', 'client_viewer');
    await screen.findByText('No contracts yet.');
    expect(screen.queryByText(/Add a contractor first/)).not.toBeInTheDocument();
  });
});

describe('a contract', () => {
  const base = {
    'GET /clients': [client], 'GET /contracts/k1': detail(), 'GET /clients/c1/sites': sites, 'GET /contractors': [contractor], 'GET /clients/c1/work-orders': page([wo()]),
  };

  it('shows its lines with plain-language schedules', async () => {
    mockApi(base);
    renderApp('/contracts/k1', 'asset_manager');
    expect(await screen.findByRole('heading', { name: /GRD-26 · Grounds 2026/ })).toBeInTheDocument();
    expect(screen.getByText('monthly')).toBeInTheDocument();
    expect(screen.getByText('yearly')).toBeInTheDocument();
    expect(screen.getByText('Split system (S1)')).toBeInTheDocument();
    expect(screen.getByText('S1 · Site One')).toBeInTheDocument();
    expect(screen.getByText(/4 new · 1 complete/)).toBeInTheDocument();
  });

  it('changes status from a selector', async () => {
    const calls = mockApi({ ...base, 'GET /contracts/k1': detail({ status: 'draft' }), 'PATCH /contracts/k1': { body: { id: 'k1' } } });
    renderApp('/contracts/k1', 'asset_manager');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Contract status' }), 'active');
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeDefined());
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/contracts/k1', body: { status: 'active' } });
  });

  it('adds a line for a site, and for an asset (which loads that site\'s assets)', async () => {
    const calls = mockApi({
      ...base, 'POST /contracts/k1/lines': { status: 201, body: { id: 'l3' } },
      'GET /sites/s1/assets': [{ id: 'a1', parent_id: null, asset_type_id: null, name: 'Split system', install_date: null, quantity: '1', unit: null, unit_rate: null, expected_life_years: null, criticality: null }],
    });
    renderApp('/contracts/k1', 'asset_manager');
    const form = await screen.findByRole('form', { name: 'Add line' });
    await within(form).findByRole('option', { name: /S1 · Site One/ }); // sites load after the contract
    await userEvent.selectOptions(within(form).getByLabelText('Line site'), 's1');
    await userEvent.type(within(form).getByLabelText('What is done'), 'Weed spray');
    await userEvent.clear(within(form).getByLabelText('Cost each visit'));
    await userEvent.type(within(form).getByLabelText('Cost each visit'), '90');
    await userEvent.click(within(form).getByRole('button', { name: 'Add line' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/contracts/k1/lines')).toBeDefined());
    expect(calls.find((c) => c.path === '/contracts/k1/lines')!.body).toMatchObject({ siteId: 's1', description: 'Weed spray', frequencyInterval: 1, frequencyUnit: 'month', costPerOccurrence: 90 });

    await userEvent.selectOptions(within(form).getByLabelText('Line applies to'), 'asset');
    await userEvent.selectOptions(await within(form).findByLabelText('Line asset'), await within(form).findByRole('option', { name: 'Split system' }));
    await userEvent.type(within(form).getByLabelText('What is done'), 'Service');
    await userEvent.click(within(form).getByRole('button', { name: 'Add line' }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/contracts/k1/lines')).toHaveLength(2));
    const second = calls.filter((c) => c.path === '/contracts/k1/lines')[1]!.body;
    expect(second).toMatchObject({ assetId: 'a1', description: 'Service' });
    expect(second.siteId).toBeUndefined();
  });

  it('previews then creates work orders, reporting what already existed', async () => {
    const calls = mockApi({
      ...base,
      'POST /contracts/k1/generate': (b: any) => ({
        status: 201,
        body: b.dryRun
          ? { dryRun: true, from: b.from ?? null, through: b.through, existing: 2, deletedSkipped: 1, wouldCreate: 3, created: 0, sample: [{ lineId: 'l1', description: 'Mow grounds', dueDate: '2026-12-15' }] }
          : { dryRun: false, from: b.from ?? null, through: b.through, existing: 2, deletedSkipped: 1, wouldCreate: 3, created: 3, sample: [] },
      }),
    });
    renderApp('/contracts/k1', 'asset_manager');
    await screen.findByRole('heading', { name: 'Generate work orders' });
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent('Would create 3 work orders.');
    expect(note).toHaveTextContent('2 already exist');
    expect(note).toHaveTextContent('1 were deleted and are not recreated');
    expect(note).toHaveTextContent('2026-12-15 · Mow grounds');
    expect(calls.find((c) => c.path === '/contracts/k1/generate')!.body.dryRun).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Create work orders' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Created 3 work orders.'));
    const real = calls.filter((c) => c.path === '/contracts/k1/generate')[1]!.body;
    expect(real.dryRun).toBe(false);
    expect(real.through).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(real.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('cannot generate from a draft contract or one with no lines, and shows a server refusal', async () => {
    mockApi({ ...base, 'GET /contracts/k1': detail({ status: 'draft' }) });
    const { unmount } = renderApp('/contracts/k1', 'asset_manager');
    expect(await screen.findByText('The contract must be active to generate work orders.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create work orders' })).toBeDisabled();
    unmount();

    mockApi({ ...base, 'GET /contracts/k1': detail({ lines: [] }) });
    const second = renderApp('/contracts/k1', 'asset_manager');
    expect(await screen.findByText('Add at least one line first.')).toBeInTheDocument();
    second.unmount();

    mockApi({ ...base, 'POST /contracts/k1/generate': { status: 400, body: { message: 'That would create 6402 work orders (limit 5000). Use a shorter window.' } } });
    renderApp('/contracts/k1', 'asset_manager');
    await userEvent.click(await screen.findByRole('button', { name: 'Create work orders' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('limit 5000');
  });

  it('deleting a line or the contract is soft and says what goes with it; the contract delete returns to the list', async () => {
    const calls = mockApi({ ...base, 'GET /clients/c1/contracts': [], 'DELETE /contract-lines/l1': { body: { deleted: 'l1' } }, 'DELETE /contracts/k1': { body: { deleted: 'k1' } } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/contracts/k1', 'org_admin');
    await screen.findByRole('heading', { name: /GRD-26/ });
    const lineRow = screen.getByText('Mow grounds', { selector: 'td' }).closest('tr')!;
    await userEvent.click(within(lineRow).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/contract-lines/l1')).toBe(true));
    expect(confirm.mock.calls[0]![0]).toMatch(/Work orders already generated from it stay/);

    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!); // the contract's own Delete (first on the page)
    await waitFor(() => expect(calls.some((c) => c.path === '/contracts/k1' && c.method === 'DELETE')).toBe(true));
    expect(confirm.mock.calls.at(-1)![0]).toMatch(/Its lines and work orders are deleted with it/);
    expect(await screen.findByRole('link', { name: '← Clients' })).toBeInTheDocument(); // back on the client page
  });

  it('hides editing, generating and deleting from a viewer', async () => {
    mockApi(base);
    renderApp('/contracts/k1', 'client_viewer');
    await screen.findByRole('heading', { name: /GRD-26/ });
    expect(screen.queryByRole('form', { name: 'Add line' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Generate work orders' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Contract status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});

describe('work orders', () => {
  const tab = (extra: Record<string, unknown> = {}) => ({ 'GET /clients': [client], 'GET /clients/c1/sites': sites, 'GET /clients/c1/work-orders': page([wo()]), ...extra });

  it('lists work orders and flags overdue ones', async () => {
    mockApi(tab({ 'GET /clients/c1/work-orders': page([wo(), wo({ id: 'w2', code: 'GRD-26-0002', due_date: '2999-01-15' }), wo({ id: 'w3', code: 'GRD-26-0003', status: 'complete', completed_on: '2020-01-16', actual_cost: '240.00' })]) }));
    renderApp('/clients/c1/work-orders', 'asset_manager');
    expect(await screen.findByText('GRD-26-0001')).toBeInTheDocument();
    expect(screen.getByTitle('Overdue')).toHaveTextContent('2020-01-15');
    expect(screen.getAllByTitle('Overdue')).toHaveLength(1); // not the future one, not the completed one
    expect(screen.getByText(/actual A\$240/)).toBeInTheDocument();
    expect(screen.getByText('3 work orders')).toBeInTheDocument();
  });

  it('moves a work order through its states with the right requests', async () => {
    const calls = mockApi(tab({ 'POST /work-orders/w1/status': { status: 201, body: { id: 'w1' } } }));
    renderApp('/clients/c1/work-orders', 'asset_manager');
    await screen.findByText('GRD-26-0001');
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/work-orders/w1/status')).toBeDefined());
    expect(calls.find((c) => c.path === '/work-orders/w1/status')!.body).toEqual({ status: 'in_progress' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/work-orders/w1/status')).toHaveLength(2));
    expect(calls.filter((c) => c.path === '/work-orders/w1/status')[1]!.body).toEqual({ status: 'cancelled' });
  });

  it('completing asks for the date and cost first, and only sends what was filled in', async () => {
    const calls = mockApi(tab({ 'POST /work-orders/w1/status': { status: 201, body: { id: 'w1' } } }));
    renderApp('/clients/c1/work-orders', 'asset_manager');
    await userEvent.click(await screen.findByRole('button', { name: 'Complete…' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // nothing sent yet
    const form = screen.getByRole('form', { name: 'Complete GRD-26-0001' });
    await userEvent.type(within(form).getByLabelText(/Actual cost/), '275.5');
    await userEvent.click(within(form).getByRole('button', { name: 'Mark complete' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeDefined());
    const body = calls.find((c) => c.method === 'POST')!.body;
    expect(body).toMatchObject({ status: 'complete', actualCost: 275.5 });
    expect(body.completedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.notes).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Complete GRD-26-0001' })).not.toBeInTheDocument());
  });

  it('shows the server reason when a move is refused', async () => {
    mockApi(tab({ 'POST /work-orders/w1/status': { status: 409, body: { message: 'A complete work order cannot be changed to cancelled' } } }));
    renderApp('/clients/c1/work-orders', 'asset_manager');
    await userEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot be changed to cancelled');
  });

  it('filters by status, site, dates and overdue, and goes back to the first page when a filter changes', async () => {
    const calls = mockApi(tab({ 'GET /clients/c1/work-orders': page(Array.from({ length: 50 }, (_, i) => wo({ id: `w${i}`, code: `GRD-26-${String(i + 1).padStart(4, '0')}` })), 120) }));
    renderApp('/clients/c1/work-orders', 'asset_manager');
    await screen.findByText('GRD-26-0001');
    expect(screen.getByText('1–50 of 120')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('51–100 of 120');
    expect(calls.at(-1)!.path).toContain('offset=50');

    await userEvent.selectOptions(screen.getByLabelText('Filter by status'), 'in_progress');
    await waitFor(() => expect(calls.at(-1)!.path).toContain('status=in_progress'));
    expect(calls.at(-1)!.path).toContain('offset=0'); // back to the first page
    await screen.findByRole('option', { name: /S1 · Site One/ }); // the site list loads separately
    await userEvent.selectOptions(screen.getByLabelText('Filter by site'), 's1');
    await waitFor(() => expect(calls.at(-1)!.path).toContain('siteId=s1'));
    await userEvent.click(screen.getByRole('checkbox', { name: /Overdue only/ }));
    await waitFor(() => expect(calls.at(-1)!.path).toContain('overdue=true'));
    await userEvent.type(screen.getByLabelText('Due from'), '2026-01-01');
    await waitFor(() => expect(calls.at(-1)!.path).toContain('from=2026-01-01'));
  });

  it('edits title, due date and estimate; a cleared estimate is sent as null', async () => {
    const calls = mockApi(tab({ 'PATCH /work-orders/w1': { body: { id: 'w1' } } }));
    renderApp('/clients/c1/work-orders', 'asset_manager');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit GRD-26-0001' });
    await userEvent.clear(within(form).getByLabelText('Estimate'));
    await userEvent.clear(within(form).getByLabelText('Title'));
    await userEvent.type(within(form).getByLabelText('Title'), 'Mow (wet week)');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeDefined());
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ title: 'Mow (wet week)', dueDate: '2020-01-15', estimatedCost: null, notes: null });
  });

  it('gives viewers the list without any actions, and lets only administrators delete', async () => {
    mockApi(tab());
    const { unmount } = renderApp('/clients/c1/work-orders', 'client_viewer');
    await screen.findByText('GRD-26-0001');
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    unmount();
    renderApp('/clients/c1/work-orders', 'asset_manager');
    await screen.findByText('GRD-26-0001');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('explains an empty result', async () => {
    mockApi(tab({ 'GET /clients/c1/work-orders': page([]) }));
    renderApp('/clients/c1/work-orders', 'asset_manager');
    expect(await screen.findByText('No work orders match.')).toBeInTheDocument();
  });
});

describe('trash with the new item types', () => {
  it('labels contractors (organisation-wide), contracts and work orders', async () => {
    mockApi({
      'GET /clients': [client],
      'GET /trash': [
        { entity: 'contractor', id: 'r9', label: 'Old Mowers', clientId: null, clientName: null, deletedAt: '2026-03-01T01:00:00.000Z', deletedBy: 'Demo User', includes: 0 },
        { entity: 'contract', id: 'k9', label: 'OLD · Old contract', clientId: 'c1', clientName: 'TVNZ', deletedAt: '2026-02-01T01:00:00.000Z', deletedBy: null, includes: 7 },
        { entity: 'work-order', id: 'w9', label: 'GRD-26-0009 · Mow grounds', clientId: 'c1', clientName: 'TVNZ', deletedAt: '2026-01-01T01:00:00.000Z', deletedBy: null, includes: 0 },
      ],
    });
    renderApp('/trash', 'org_admin');
    const contractorRow = (await screen.findByText('Old Mowers')).closest('tr')!;
    expect(within(contractorRow).getByText('Contractor')).toBeInTheDocument();
    expect(within(contractorRow).getByText('All clients')).toBeInTheDocument();
    const contractRow = screen.getByText(/OLD · Old contract/).closest('tr')!;
    expect(within(contractRow).getByText('Contract')).toBeInTheDocument();
    expect(within(contractRow).getByText(/with 7 items/)).toBeInTheDocument();
    expect(within(screen.getByText(/GRD-26-0009/).closest('tr')!).getByText('Work order')).toBeInTheDocument();
  });
});
