/** Multi-row VALUES: placeholders for `rows` starting after `fixed` shared params, plus the flattened values. */
export function values(rows: unknown[][], fixed: number): { sql: string; params: unknown[] } {
  let n = fixed;
  const sql = rows.map((r) => `(${r.map(() => `$${++n}`).join(',')})`).join(',');
  return { sql, params: rows.flat() };
}

/** Run `fn` over slices of `items`, so one statement never carries too many parameters. */
export async function inChunks<T>(items: T[], size: number, fn: (chunk: T[]) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size));
}
