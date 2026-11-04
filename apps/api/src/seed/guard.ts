const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Demo data must not land in a shared or production database by accident. Throws unless the host is local or overridden. */
export function assertSeedAllowed(databaseUrl: string | undefined, env: Record<string, string | undefined> = process.env): void {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!LOCAL_HOSTS.has(host) && env.ALLOW_REMOTE_SEED !== '1') {
    throw new Error(`Refusing to seed demo data into non-local database host "${host}". Set ALLOW_REMOTE_SEED=1 to override.`);
  }
}
