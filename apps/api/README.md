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
| GET/POST | `/clients/:id/sites` (GET: `?regionId=`), `/clients/:id/regions`, `/clients/:id/asset-types` | same |
| GET | `/sites/:id` (includes region code and name) | readers |
| GET/POST | `/sites/:id/assets` | same |
| PATCH | `/clients/:id`, `/regions/:id`, `/sites/:id` (incl. `regionId`, or `null` to clear), `/asset-types/:id`, `/assets/:id` | org_admin, asset_manager (only sent fields change) |
| DELETE | `/clients/:id`, `/regions/:id`, `/sites/:id`, `/asset-types/:id`, `/assets/:id`, `/scenarios/:id` | org_admin (scenarios: also asset_manager). **Soft delete**; 409 if still in use |
| GET | `/trash` | org_admin: items deleted on their own, newest first |
| POST | `/trash/:entity/:id/restore` (`client`, `region`, `site`, `asset-type`, `asset`, `scenario`) | org_admin |
| POST | `/sites/:id/inspections` (with assessments) | org_admin, asset_manager, assessor |
| GET | `/assets/:id/assessments` | readers |
| POST | `/clients/:id/forecast?siteId=` | readers (read-only calculation from the request body) |
| GET/POST | `/clients/:id/scenarios` | read: readers; write: org_admin, asset_manager |
| POST | `/scenarios/:id/run?siteId=` | readers |

Routes are deny-by-default: any route without an explicit role list is limited to the reader roles, so
`contractor` has no access until a contractor portal adds its own routes. Every create, update and delete
writes an `audit_log` row in the same transaction; an update records what changed (old and new values), and a delete or
restore records what it touched.

## Soft delete
Nothing is ever removed, so history is retained. A delete sets `deleted_at` / `deleted_by`; row level security hides
such rows from every normal query, and the app database role has **no DELETE privilege** on the data tables (and no
UPDATE or DELETE on `audit_log`), so even a bug cannot hard-delete.
- Deleting a **site** also deletes its assets; deleting a **client** takes its regions, sites, asset types, assets and
  saved scenarios. They share one timestamp, so restoring the parent brings back exactly those and nothing that was
  deleted earlier on its own. Restoring a child needs its client (and any region, type or site it uses) to be live: a
  restore that would leave a live item pointing at a deleted one is refused with 409 and nothing changes.
- A **region**, **asset type** or **asset** that is still in use (by sites, assets or components) cannot be deleted (409).
- Codes (client, site, region) can be reused after a delete; restoring over a live clash is refused until one is renamed.
- Only an `org_admin` sees the Trash or restores. Deletes and restores run with `includeDeleted` (PostgreSQL also
  checks the new row of an UPDATE against the read policy, so the row being marked must stay visible to that statement);
  inside `src/trash.ts` every query filters `deleted_at IS NULL` explicitly. Everything else relies on the policy.
- The only hard delete is the demo seed's `--reset`, run as the database owner (demo data only).

## Demo data
`npm run seed:demo -w @ace/api` fills the database in `DATABASE_URL` with a demo estate, for demos and manual testing:
the **Demo Consulting** consultancy, one client (**TVNZ**), the Australian states as **regions** (code = state code, e.g.
`NSW`), and every digital TV transmitter site listed on ozdigitaltv.com as a site (code `<STATE>-<site id>`, e.g. `ACT-3`),
with illustrative asset types, assets and one inspection per site so forecasts have something to project
(about 600 sites and 4,000 assets; prices and lives are placeholders, not real figures).

```bash
npm run seed:demo -w @ace/api                                  # create or top up (idempotent, deterministic)
npm run seed:demo -w @ace/api -- --reset                       # permanently wipe the demo client (owner-level hard delete), then rebuild it
npm run seed:demo -w @ace/api -- --states ACT,TAS --no-assets  # a subset, sites only
DEMO_PASSWORD=<choose one> npm run seed:demo -w @ace/api -- --reset-password   # set the demo login's password
```
The demo login is `demo@example.com`. Its password is random and printed once when the user is created, unless
`DEMO_PASSWORD` is set. The command refuses to run against a non-local database unless `ALLOW_REMOTE_SEED=1`.
Tests use the same `seedDemo()` function (`src/seed/demo.ts`).

The site list comes from `src/seed/transmitters.json`, committed so that seeding and tests never touch the website.
Rebuild it with `npm run seed:build-transmitters -w @ace/api` (fetches 8 pages, 2 s apart; `-- --from-dir DIR` parses saved
HTML instead). The data is credited on that site as based on Australian Communications and Media Authority data.

## Tests
`npm test -w @ace/api` runs against in-process Postgres (PGlite), so no database install is needed.
Set `TEST_DATABASE_URL` (a role with CREATEDB, e.g. the `ace_dev` URL from `.env`) to run the same tests on a
real PostgreSQL server; each run creates and drops its own throwaway database.

Local dev database: `deploy/scripts/dev-db-setup.ps1` creates the `ace_dev` role and database and writes `.env`
(set `POSTGRES_ADMIN_PASSWORD` to skip the password prompts).
