# Web app

React + Vite + TypeScript single-page app for the asset management API. Plain CSS and a small SVG chart, no UI library.

## Screens
- **Sign in / create an organisation** (owner or consultancy).
- **Clients** list; per client: **Sites** (with a region column and region filter), **Regions** (e.g. states), **Asset types** (default life and rate), **Forecast**.
- **Site**: asset list (values inherited from the asset type shown in grey), add asset, **record an inspection**
  (one condition per asset, or "Mixed" for a percentage split across conditions).
- **Forecast**: scenario form (start year, horizon, inflation, discount rate, overdue-work policy, annual cap),
  chart, yearly and per-site tables, CSV export, saved scenarios.

Every list has inline **Edit** (managers and administrators; blank optional fields clear, so a blank rate or life falls back to the
asset type's) and **Delete** (administrators). Delete is a **soft delete**: the confirmation says the item moves to the Trash, and
an administrator's **Trash** page lists what was deleted on its own and restores it (with whatever went with it).
A delete or restore the server refuses (for example a region that still has sites) shows the server's reason.

Write controls are hidden for roles that cannot use them (the API enforces this regardless).
The `contractor` role sees a "not available yet" message.

## Run
```bash
npm run start -w @ace/api      # API on PORT (default 3000), needs DATABASE_URL and JWT_SECRET (see apps/api/README.md)
npm run dev -w @ace/web        # http://localhost:5173, proxies /api to the API
```
Point the proxy elsewhere with `API_TARGET` (environment or a gitignored `apps/web/.env.local`).
The token is kept in `sessionStorage`, so it is cleared when the tab closes.

## Test
`npm test -w @ace/web` (unit tests for CSV export, inspection building, forecast form validation, and the
sign-in / role behaviour of the app shell with a mocked API). `npm run build -w @ace/web` type-checks and builds.
