// Shared helpers for the page tests: a fetch mock routed by "METHOD /path", and a renderer for the whole app.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from './App';
import { AuthProvider } from './auth';

export const token = (role: string) => `x.${btoa(JSON.stringify({ role, org: 'o' }))}.y`;
export type Handler = (body: any) => { status?: number; body: unknown };
export interface Call { method: string; path: string; body: any }

/**
 * Routes are keyed "METHOD /path" (query string included). A route is a handler function, a response descriptor
 * `{ status?, body }`, or just the JSON body to return. Every call is recorded so tests can assert on the requests sent.
 */
export function mockApi(routes: Record<string, Handler | unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^\/api/, '');
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, body });
    // Exact path first, then the same path without its query string.
    const route = routes[`${method} ${path}`] ?? routes[`${method} ${path.split('?')[0]}`];
    if (route === undefined) return new Response(JSON.stringify({ message: `unmocked ${method} ${path}` }), { status: 404 });
    const isDescriptor = route !== null && typeof route === 'object' && !Array.isArray(route) && 'body' in (route as object);
    const out = typeof route === 'function' ? (route as Handler)(body) : isDescriptor ? (route as { status?: number; body: unknown }) : { body: route };
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return calls;
}

export function renderApp(path: string, role: string) {
  sessionStorage.setItem('ace.token', token(role));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider><App /></AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
