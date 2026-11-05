/**
 * Recurring due dates for scheduled maintenance ("mow monthly", "service the aircon every year").
 * Pure functions over date-only strings (YYYY-MM-DD, no time zone), so results never depend on the machine's zone or DST.
 */

export type Unit = 'day' | 'week' | 'month' | 'year';
export const UNITS: readonly Unit[] = ['day', 'week', 'month', 'year'];

export interface Recurrence {
  /** The first due date; every later one is counted from it. */
  firstDue: string;
  /** Every `interval` units, 1..MAX_INTERVAL. */
  interval: number;
  unit: Unit;
}

export const MAX_INTERVAL = 120;
/** Guard against runaway ranges (for example a daily schedule asked for across decades). */
export const MAX_OCCURRENCES = 5000;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const daysInMonth = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

function parts(s: string): [number, number, number] {
  const m = DATE.exec(s);
  if (!m) throw new RangeError(`Not a date (YYYY-MM-DD): "${s}"`);
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  if (mo < 0 || mo > 11 || d < 1 || d > daysInMonth(y, mo)) throw new RangeError(`Not a real date: "${s}"`);
  return [y, mo, d];
}

export const isDate = (s: unknown): s is string => {
  if (typeof s !== 'string') return false;
  try { parts(s); return true; } catch { return false; }
};

const fmt = (y: number, mo0: number, d: number) => `${String(y).padStart(4, '0')}-${String(mo0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * `anchor` plus `n` units. Months and years keep the anchor's day of the month where they can and otherwise fall back
 * to the last day (31 Jan + 1 month = 28/29 Feb). Always count from the anchor, never from the previous result, so
 * 31 Jan, 28 Feb, 31 Mar does not drift to the 28th.
 */
export function addInterval(anchor: string, n: number, unit: Unit): string {
  const [y, mo, d] = parts(anchor);
  if (unit === 'day' || unit === 'week') {
    const t = new Date(Date.UTC(y, mo, d + n * (unit === 'week' ? 7 : 1)));
    return fmt(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  }
  const total = mo + n * (unit === 'year' ? 12 : 1);
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  return fmt(year, month, Math.min(d, daysInMonth(year, month)));
}

export interface Window {
  /** Skip occurrences before this date (default: none skipped). */
  from?: string;
  /** Last date to include. */
  through: string;
  /** Hard end, for example the contract's end date; occurrences after it never exist. */
  until?: string;
}

/** Validate a recurrence, throwing RangeError with a readable message. */
export function assertRecurrence(r: Recurrence): void {
  parts(r.firstDue);
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > MAX_INTERVAL) throw new RangeError(`Interval must be a whole number from 1 to ${MAX_INTERVAL}`);
  if (!UNITS.includes(r.unit)) throw new RangeError(`Unit must be one of ${UNITS.join(', ')}`);
}

/** All due dates of the recurrence inside the window, oldest first. */
export function occurrences(r: Recurrence, w: Window): string[] {
  assertRecurrence(r);
  parts(w.through);
  if (w.from) parts(w.from);
  if (w.until) parts(w.until);
  // ISO date strings sort the same as the dates they name.
  const last = w.until && w.until < w.through ? w.until : w.through;
  const out: string[] = [];
  for (let k = 0; ; k++) {
    const due = addInterval(r.firstDue, k * r.interval, r.unit);
    if (due > last) break;
    if (k > 200_000) throw new RangeError('Schedule range too large');
    if (w.from && due < w.from) continue;
    out.push(due);
    if (out.length > MAX_OCCURRENCES) throw new RangeError(`More than ${MAX_OCCURRENCES} occurrences; use a shorter window`);
  }
  return out;
}

/** Human description, for example "every 3 months" or "monthly". */
export function describe(r: Pick<Recurrence, 'interval' | 'unit'>): string {
  if (r.interval === 1) return { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[r.unit];
  return `every ${r.interval} ${r.unit}s`;
}
