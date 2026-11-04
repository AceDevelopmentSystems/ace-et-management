import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AuthProvider } from '../auth';
import { toParams } from './Forecast';

const base = { startYear: '2025', horizon: '20', inflation: '3', discount: '6', overdue: 'year1' as const, spread: '3', cap: '' };

describe('toParams', () => {
  it('converts percentages to fractions and omits a blank cap', () => {
    expect(toParams(base)).toEqual({ startYear: 2025, horizonYears: 20, inflation: 0.03, discountRate: 0.06, overdue: 'year1', overdueSpreadYears: 3 });
  });
  it('includes a cap when given', () => {
    expect(toParams({ ...base, cap: '50000' })).toMatchObject({ annualCap: 50000 });
  });
  it('rejects bad input with a message', () => {
    expect(toParams({ ...base, startYear: '1999' })).toMatch(/Start year/);
    expect(toParams({ ...base, startYear: '2025.5' })).toMatch(/Start year/);
    expect(toParams({ ...base, inflation: '-1' })).toMatch(/percentages/);
    expect(toParams({ ...base, discount: 'abc' })).toMatch(/percentages/);
    expect(toParams({ ...base, spread: '0' })).toMatch(/Spread/);
    expect(toParams({ ...base, cap: '-5' })).toMatch(/cap/);
  });
});

const token = (role: string) => `x.${btoa(JSON.stringify({ role, org: 'o' }))}.y`;

function renderApp(path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider><App /></AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('app shell', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('sends signed-out visitors to the login page', async () => {
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows an API error on a failed login and stays on the page', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(401, { message: 'Invalid credentials' })));
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
    expect(sessionStorage.getItem('ace.token')).toBeNull();
  });

  it('logs in and lists clients; an admin sees the add form, a viewer does not', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (url.endsWith('/auth/login') ? json(201, { token: token('org_admin') }) : json(200, [{ id: 'c1', name: 'TVNZ', code: null, currency: 'NZD' }]))));
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'long-enough-pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('link', { name: 'TVNZ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add client' })).toBeInTheDocument();
  });

  it('hides write controls from a read-only viewer', async () => {
    sessionStorage.setItem('ace.token', token('client_viewer'));
    vi.stubGlobal('fetch', vi.fn(() => json(200, [{ id: 'c1', name: 'TVNZ', code: null, currency: 'NZD' }])));
    renderApp('/');
    expect(await screen.findByRole('link', { name: 'TVNZ' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add client' })).not.toBeInTheDocument();
  });

  it('returns to login when the API reports an expired token', async () => {
    sessionStorage.setItem('ace.token', token('org_admin'));
    vi.stubGlobal('fetch', vi.fn(() => json(401, { message: 'Unauthorized' })));
    renderApp('/');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument());
    expect(sessionStorage.getItem('ace.token')).toBeNull();
  });

  it('tells contractors they have no access instead of showing errors', async () => {
    sessionStorage.setItem('ace.token', token('contractor'));
    renderApp('/');
    expect(await screen.findByRole('alert')).toHaveTextContent('Contractor access is not available yet');
  });
});
