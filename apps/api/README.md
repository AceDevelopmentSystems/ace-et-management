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
| GET/POST | `/clients` | read: org_admin, asset_manager, assessor, client_viewer; write: org_admin, asset_manager |
| GET/POST | `/clients/:id/sites`, `/clients/:id/asset-types` | same |
| GET/POST | `/sites/:id/assets` | same |
| PATCH | `/clients/:id`, `/sites/:id`, `/asset-types/:id`, `/assets/:id` | org_admin, asset_manager (only sent fields change) |
| DELETE | `/clients/:id`, `/sites/:id`, `/asset-types/:id`, `/assets/:id`, `/scenarios/:id` | org_admin (scenarios: also asset_manager); 409 if still referenced |
| POST | `/sites/:id/inspections` (with assessments) | org_admin, asset_manager, assessor |
| GET | `/assets/:id/assessments` | readers |
| POST | `/clients/:id/forecast?siteId=` | readers (read-only calculation from the request body) |
| GET/POST | `/clients/:id/scenarios` | read: readers; write: org_admin, asset_manager |
| POST | `/scenarios/:id/run?siteId=` | readers |

Routes are deny-by-default: any route without an explicit role list is limited to the reader roles, so
`contractor` has no access until a contractor portal adds its own routes. Every create, update and delete
writes an `audit_log` row in the same transaction.

## Tests
`npm test -w @ace/api` runs against in-process Postgres (PGlite), so no database install is needed.
Set `TEST_DATABASE_URL` (a role with CREATEDB, e.g. the `ace_dev` URL from `.env`) to run the same tests on a
real PostgreSQL server; each run creates and drops its own throwaway database.

Local dev database: `deploy/scripts/dev-db-setup.ps1` creates the `ace_dev` role and database and writes `.env`
(set `POSTGRES_ADMIN_PASSWORD` to skip the password prompts).
