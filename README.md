# ace-et-management
Asset management platform: a modernisation of the legacy CMS (Delphi/PHP). It serves a company managing its
own assets, or a consultancy managing assets for several clients, and projects replacement spend 5-30 years ahead.

| Path | What |
|---|---|
| `packages/forecast` | Replacement forecast engine (pure TypeScript) with a parity port of the legacy Excel macro. See `docs/forecast-spec.md`. |
| `apps/api` | NestJS API over PostgreSQL with row level security per organisation/client. |
| `apps/web` | React web app. |
| `deploy/` | Docker, Kubernetes, Terraform and helper scripts. |

## Quick start (local)
Needs Node 22.9+ and PostgreSQL 16+.
```bash
npm install
pwsh deploy/scripts/dev-db-setup.ps1      # creates the dev role/database and apps/api/.env (Windows; see the script for details)
npm run start -w @ace/api                 # applies migrations, serves http://localhost:3000/api
npm run dev -w @ace/web                   # http://localhost:5173
npm test                                  # all tests, no database needed (in-process Postgres)
```
