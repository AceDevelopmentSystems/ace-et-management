import { Client, ForecastResponse, Site } from './api';

export function money(n: number, currency = 'NZD'): string {
  return new Intl.NumberFormat('en-NZ', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}

/** CSV cell: quote when needed, and neutralise spreadsheet formulas (CSV injection) in text cells. */
export function csvCell(v: string | number): string {
  let s = typeof v === 'number' ? String(v) : v;
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (rows: (string | number)[][]): string => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** Yearly budget table plus per-site rollup, ready to download. */
export function forecastCsv(result: ForecastResponse, sites: Site[], client: Client | undefined): string {
  const lev = result.leveled;
  const header: (string | number)[] = ['Year', 'Real cost', 'Nominal cost', 'Present value'];
  if (lev) header.push('Capped spend', 'Backlog carried');
  const rows: (string | number)[][] = [header];
  result.byYear.forEach((y, i) => {
    const row: (string | number)[] = [y.year, round2(y.real), round2(y.nominal), round2(y.presentValue)];
    if (lev) row.push(round2(lev[i]!.spend), round2(lev[i]!.carried));
    rows.push(row);
  });
  rows.push([], ['Nominal cost by site'], ['Site', ...result.byYear.map((y) => y.year), 'Total']);
  const name = new Map(sites.map((s) => [s.id, `${s.code} ${s.name}`]));
  for (const [siteId, byYear] of Object.entries(result.bySite)) {
    const vals = result.byYear.map((y) => round2(byYear[y.year] ?? 0));
    rows.push([name.get(siteId) ?? siteId, ...vals, round2(vals.reduce((a, b) => a + b, 0))]);
  }
  if (client) rows.unshift([`Client: ${client.name}`, `Currency: ${client.currency}`], []);
  return toCsv(rows);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function download(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Parse a user-typed number; empty string -> undefined, garbage -> NaN. */
export function num(s: string): number | undefined {
  const t = s.trim();
  return t === '' ? undefined : Number(t);
}
