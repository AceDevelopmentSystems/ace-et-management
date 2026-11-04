# API

NestJS REST API over PostgreSQL. All routes are under `/api`.

## Run
```bash
cp ../../deploy/docker/.env.example ../../deploy/docker/.env   # then start the db (docker compose up db)
DATABASE_URL=postgres://ace:change-me@localhost:5432/ace JWT_SECRET=<32+ random chars> npm run start -w @ace/api
```
Migrations in `migrations/` apply automatically at start. `DATABASE_URL` must be a role that owns the
schema (or a superuser) and may `SET ROLE ace_app`; requests run as `ace_app`, which is subject to row level security.

## Tenancy
`organisation` (OWNER or CONSULTANCY) -> `client` -> data. Each request runs in one transaction with
`app.org_id` and `app.client_ids` set from the JWT; RLS policies enforce isolation. Composite foreign keys
prevent cross-tenant references. An OWNER organisation gets one implicit client on registration.

## Routes
| Method | Path | Roles |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | public |
| GET/POST | `/clients` | read: any, write: org_admin, asset_manager |
| GET/POST | `/clients/:id/sites`, `/clients/:id/asset-types` | same |
| GET/POST | `/sites/:id/assets` | same |
| POST | `/sites/:id/inspections` (with assessments) | org_admin, asset_manager, assessor |
| GET | `/assets/:id/assessments` | any |
| POST | `/clients/:id/forecast?siteId=` | any (read-only calculation) |

## Tests
`npm test -w @ace/api` runs against in-process Postgres (PGlite), so no database install is needed.
The node-postgres path (`createPgDatabase`) is not covered by tests yet.
