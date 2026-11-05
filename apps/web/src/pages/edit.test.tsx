import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderApp } from '../testing';

const client = { id: 'c1', name: 'TVNZ', code: 'TV', currency: 'AUD' };
const site = { id: 's1', client_id: 'c1', code: 'S1', name: 'Site One', site_class: 'Repeater', address: 'Hill Rd', region_id: 'r1', region_code: 'NSW', region_name: 'New South Wales' };
const region = { id: 'r1', code: 'NSW', name: 'New South Wales', site_count: 1 };
const type = { id: 't1', parent_id: null, name: 'Aircon', expected_life_years: 15, unit: 'ea', unit_rate: '9000.00' };
const asset = { id: 'a1', parent_id: null, asset_type_id: 't1', name: 'Split system', install_date: '2020-05-01', quantity: '2.000', unit: null, unit_rate: '9500.00', expected_life_years: 12, criticality: null };

describe('delete is soft and says so', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('an administrator can delete after a confirmation that mentions the trash; cancelling sends nothing', async () => {
    const calls = mockApi({ 'GET /clients': [client], 'DELETE /clients/c1': { body: { deleted: 'c1', cascaded: {} } } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderApp('/', 'org_admin');
    await screen.findByRole('link', { name: 'TVNZ' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false); // cancelled
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/clients/c1')).toBe(true));
    const text = confirm.mock.calls[0]![0] as string;
    expect(text).toMatch(/Delete client “TVNZ”/);
    expect(text).toMatch(/regions, sites, assets and saved scenarios are deleted with it/);
    expect(text).toMatch(/moves to the Trash/);
    expect(text).not.toMatch(/permanent|cannot be undone/i);
  });

  it('shows the server reason when a delete is refused', async () => {
    mockApi({ 'GET /clients': [client], 'DELETE /clients/c1': { status: 409, body: { message: 'This region still has 3 sites. Move or delete them first.' } } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/', 'org_admin');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('still has 3 sites');
    expect(screen.getByRole('link', { name: 'TVNZ' })).toBeInTheDocument();
  });

  it('only administrators see Delete; managers can edit; viewers can do neither', async () => {
    mockApi({ 'GET /clients': [client] });
    const { unmount } = renderApp('/', 'asset_manager');
    await screen.findByRole('link', { name: 'TVNZ' });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    unmount();
    renderApp('/', 'client_viewer');
    await screen.findByRole('link', { name: 'TVNZ' });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});

describe('editing', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('edits a client with only the fields it has, clearing an emptied code', async () => {
    const calls = mockApi({ 'GET /clients': [client], 'PATCH /clients/c1': { body: { id: 'c1' } } });
    renderApp('/', 'asset_manager');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit TVNZ' });
    await userEvent.clear(within(form).getByLabelText('Name'));
    await userEvent.type(within(form).getByLabelText('Name'), 'TVNZ Australia');
    await userEvent.clear(within(form).getByLabelText('Code'));
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeDefined());
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/clients/c1', body: { name: 'TVNZ Australia', code: null, currency: 'AUD' } });
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit TVNZ' })).not.toBeInTheDocument()); // closes after saving
  });

  it('keeps the form open and shows the reason when a save is refused', async () => {
    mockApi({ 'GET /clients': [client], 'PATCH /clients/c1': { status: 409, body: { message: 'Client code already in use' } } });
    renderApp('/', 'asset_manager');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.click(within(screen.getByRole('form', { name: 'Edit TVNZ' })).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Client code already in use');
    expect(screen.getByRole('form', { name: 'Edit TVNZ' })).toBeInTheDocument();
  });

  it('cancel closes the form without saving', async () => {
    const calls = mockApi({ 'GET /clients': [client] });
    renderApp('/', 'org_admin');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Edit TVNZ' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('a blank rate and life are sent as null so the asset falls back to its type', async () => {
    const calls = mockApi({
      'GET /sites/s1': site, 'GET /sites/s1/assets': [asset], 'GET /clients/c1/asset-types': [type], 'GET /clients/c1/regions': [region],
      'PATCH /assets/a1': { body: { id: 'a1' } },
    });
    renderApp('/sites/s1', 'asset_manager');
    await screen.findAllByText('Split system');
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' }).at(-1)!); // the asset row (the first Edit is the site)
    const form = screen.getByRole('form', { name: 'Edit asset Split system' });
    await userEvent.clear(within(form).getByLabelText(/^Rate/));
    await userEvent.clear(within(form).getByLabelText(/^Life/));
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeDefined());
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      name: 'Split system', assetTypeId: 't1', parentId: null, quantity: 2, unit: null, unitRate: null, expectedLifeYears: null, installDate: '2020-05-01',
    });
  });

  it('deleting a site returns to the client sites list', async () => {
    const calls = mockApi({
      'GET /sites/s1': site, 'GET /sites/s1/assets': [], 'GET /clients/c1/asset-types': [], 'GET /clients/c1/regions': [region],
      'DELETE /sites/s1': { body: { deleted: 's1', cascaded: { assets: 0 } } }, 'GET /clients': [client], 'GET /clients/c1/sites': [],
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/sites/s1', 'org_admin');
    await screen.findByRole('heading', { name: /S1 · Site One/ });
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/sites/s1')).toBe(true));
    expect(confirm.mock.calls[0]![0]).toMatch(/Its assets are deleted with it/);
    expect(await screen.findByRole('link', { name: '← Clients' })).toBeInTheDocument(); // now on the client page
  });
});

describe('trash', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());
  const items = [
    { entity: 'site', id: 's9', label: 'S9 · Old site', clientId: 'c1', clientName: 'TVNZ', deletedAt: '2026-03-01T01:00:00.000Z', deletedBy: 'Demo User', includes: 4 },
    { entity: 'client', id: 'c2', label: 'Gone Co', clientId: 'c2', clientName: 'Gone Co', deletedAt: '2026-02-01T01:00:00.000Z', deletedBy: null, includes: 0 },
  ];

  it('lists deleted items and restores one', async () => {
    const calls = mockApi({ 'GET /clients': [client], 'GET /trash': items, 'POST /trash/site/s9/restore': { status: 201, body: { restored: 's9', alsoRestored: { assets: 4 } } } });
    renderApp('/', 'org_admin');
    await userEvent.click(await screen.findByRole('link', { name: 'Trash' }));
    expect(await screen.findByText('S9 · Old site')).toBeInTheDocument();
    expect(screen.getByText(/with 4 items/)).toBeInTheDocument();
    expect(screen.getByText('Gone Co', { selector: 'td' })).toBeInTheDocument();
    const row = screen.getByText('S9 · Old site').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/trash/site/s9/restore')).toBe(true));
  });

  it('shows the reason when a restore is refused', async () => {
    mockApi({ 'GET /clients': [client], 'GET /trash': items, 'POST /trash/site/s9/restore': { status: 409, body: { message: 'Cannot restore: a site belongs to the deleted region "NSW". Restore that region first.' } } });
    renderApp('/trash', 'org_admin');
    const row = (await screen.findByText('S9 · Old site')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Restore that region first');
  });

  it('shows an empty state', async () => {
    mockApi({ 'GET /clients': [client], 'GET /trash': [] });
    renderApp('/trash', 'org_admin');
    expect(await screen.findByText('The trash is empty.')).toBeInTheDocument();
  });

  it('is for administrators only: other roles get no link and are sent away from the page', async () => {
    const calls = mockApi({ 'GET /clients': [client] });
    renderApp('/trash', 'asset_manager');
    expect(await screen.findByRole('link', { name: 'TVNZ' })).toBeInTheDocument(); // redirected to the clients page
    expect(screen.queryByRole('link', { name: 'Trash' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/trash')).toBe(false); // never even asked
  });
});
