import { randomBytes } from 'node:crypto';
import { Database, createPgDatabase, createPgliteDatabase, migrate } from '../src/db';

/**
 * Test database. With TEST_DATABASE_URL set, creates a throwaway database on that server (the role needs
 * CREATEDB) and drops it afterwards, so tests exercise real PostgreSQL. Otherwise uses in-process PGlite.
 */
export async function createTestDb(): Promise<{ db: Database; cleanup: () => Promise<void> }> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) {
    const db = await createPgliteDatabase();
    await migrate(db);
    return { db, cleanup: () => db.close() };
  }
  const name = `ace_test_${randomBytes(4).toString('hex')}`;
  const adminUrl = new URL(base);
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const testUrl = new URL(base);
  testUrl.pathname = `/${name}`;
  const db = await createPgDatabase(testUrl.toString());
  await migrate(db);
  return {
    db,
    cleanup: async () => {
      await db.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
