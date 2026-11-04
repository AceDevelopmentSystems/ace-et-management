import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run a script of several statements (no parameters). */
  exec(sql: string): Promise<unknown>;
}

export interface TenantContext {
  orgId: string;
  /** Clients the user is limited to; empty/undefined means all clients in the organisation. */
  clientIds?: string[];
}

export interface Database {
  /** Run outside any tenant (login, registration, migrations). Runs as the connecting role. */
  admin<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Run one transaction as the restricted ace_app role with row level security scoped to the tenant. */
  withTenant<T>(ctx: TenantContext, fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', 'migrations');

const TENANT_SETUP = `SELECT set_config('app.org_id', $1, true), set_config('app.client_ids', $2, true)`;

async function setupTenant(q: Queryable, ctx: TenantContext) {
  await q.query('SET LOCAL ROLE ace_app');
  await q.query(TENANT_SETUP, [ctx.orgId, (ctx.clientIds ?? []).join(',')]);
}

/** Apply any migrations/*.sql not yet recorded. Idempotent. */
export async function migrate(db: Database): Promise<string[]> {
  const applied: string[] = [];
  await db.admin(async (q) => {
    await q.query(`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await q.query<{ name: string }>('SELECT name FROM schema_migration')).rows.map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      await q.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      await q.query('INSERT INTO schema_migration (name) VALUES ($1)', [f]);
      applied.push(f);
    }
  });
  return applied;
}

/** Production database over node-postgres. DATABASE_URL must be a role that may SET ROLE ace_app. */
export async function createPgDatabase(connectionString: string): Promise<Database> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString });
  const run = async <T>(fn: (q: Queryable) => Promise<T>, setup?: (q: Queryable) => Promise<void>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const q: Queryable = {
        query: (sql, params) => client.query(sql, params as any[]) as any,
        exec: (sql) => client.query(sql),
      };
      if (setup) await setup(q);
      const out = await fn(q);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  };
  return {
    admin: (fn) => run(fn),
    withTenant: (ctx, fn) => run(fn, (q) => setupTenant(q, ctx)),
    close: () => pool.end(),
  };
}

/** In-process Postgres (WASM) for tests and zero-install local demos. */
export async function createPgliteDatabase(): Promise<Database> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite();
  await lite.waitReady;
  const run = <T>(fn: (q: Queryable) => Promise<T>, setup?: (q: Queryable) => Promise<void>) =>
    lite.transaction(async (tx) => {
      const q: Queryable = {
        query: (sql, params) => tx.query(sql, params as any[]) as any,
        exec: (sql) => tx.exec(sql),
      };
      if (setup) await setup(q);
      return fn(q);
    });
  return {
    admin: (fn) => run(fn),
    withTenant: (ctx, fn) => run(fn, (q) => setupTenant(q, ctx)),
    close: () => lite.close(),
  };
}
