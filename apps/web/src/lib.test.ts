import { describe, expect, it } from 'vitest';
import { ForecastResponse } from './api';
import { csvCell, forecastCsv, money, num, toCsv } from './lib';

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell(12.5)).toBe('12.5');
  });
  it('neutralises spreadsheet formulas in text', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-5)).toBe('-5'); // real numbers are untouched
  });
  it('joins rows with CRLF', () => {
    expect(toCsv([[1, 'a'], [2, 'b']])).toBe('1,a\r\n2,b\r\n');
  });
});

describe('forecastCsv', () => {
  const result: ForecastResponse = {
    scenario: { startYear: 2025, horizonYears: 2, inflation: 0, discountRate: 0, overdue: 'year1', overdueSpreadYears: 3 },
    assetsAssessed: 1, skipped: [],
    byYear: [{ year: 2025, real: 0, nominal: 0, presentValue: 0 }, { year: 2026, real: 100.456, nominal: 110, presentValue: 90 }],
    bySite: { s1: { '2026': 110 } },
    totals: { real: 100.456, nominal: 110, presentValue: 90 },
  };
  it('includes the yearly table, site rollup and client header', () => {
    const csv = forecastCsv(result, [{ id: 's1', code: 'TV1', name: 'Repeater', site_class: null, address: null, region_id: null, region_code: null, region_name: null }], { id: 'c', name: 'TVNZ', code: null, currency: 'NZD' });
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Client: TVNZ,Currency: NZD');
    expect(lines).toContain('Year,Real cost,Nominal cost,Present value');
    expect(lines).toContain('2026,100.46,110,90');
    expect(lines).toContain('TV1 Repeater,0,110,110');
  });
  it('adds capped columns when levelled', () => {
    const csv = forecastCsv({ ...result, leveled: [{ year: 2025, demand: 0, spend: 0, carried: 0 }, { year: 2026, demand: 110, spend: 50, carried: 60 }] }, [], undefined);
    expect(csv).toContain('Year,Real cost,Nominal cost,Present value,Capped spend,Backlog carried');
    expect(csv).toContain('2026,100.46,110,90,50,60');
  });
});

describe('helpers', () => {
  it('parses numbers', () => {
    expect(num('')).toBeUndefined();
    expect(num(' 3.5 ')).toBe(3.5);
    expect(num('abc')).toBeNaN();
  });
  it('formats money', () => {
    expect(money(1234.5, 'NZD')).toContain('1,235');
  });
});

import { addDays, describeFrequency, isOverdue, statusActions, todayLocal } from './lib';

describe('dates', () => {
  it('addDays crosses month, year and leap-day boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-11-04', 90)).toBe('2027-02-02');
  });
  it('todayLocal is a YYYY-MM-DD date', () => {
    expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('describes how often', () => {
    expect(describeFrequency(1, 'month')).toBe('monthly');
    expect(describeFrequency(1, 'year')).toBe('yearly');
    expect(describeFrequency(3, 'month')).toBe('every 3 months');
    expect(describeFrequency(2, 'week')).toBe('every 2 weeks');
  });
});

describe('work order status flow', () => {
  it('offers only the moves the server allows', () => {
    expect(statusActions('new').map((a) => a.to)).toEqual(['in_progress', 'complete', 'cancelled']);
    expect(statusActions('in_progress').map((a) => a.to)).toEqual(['complete', 'new', 'cancelled']);
    expect(statusActions('complete').map((a) => a.to)).toEqual(['in_progress']);
    expect(statusActions('cancelled').map((a) => a.to)).toEqual(['new']);
  });
  it('completing needs details; nothing else does', () => {
    const all = (['new', 'in_progress', 'complete', 'cancelled'] as const).flatMap(statusActions);
    expect(all.filter((a) => a.needsDetails).every((a) => a.to === 'complete')).toBe(true);
    expect(all.some((a) => a.needsDetails)).toBe(true);
  });
  it('overdue means open and past due', () => {
    expect(isOverdue({ status: 'new', due_date: '2026-01-01' }, '2026-06-01')).toBe(true);
    expect(isOverdue({ status: 'in_progress', due_date: '2026-01-01' }, '2026-06-01')).toBe(true);
    expect(isOverdue({ status: 'complete', due_date: '2026-01-01' }, '2026-06-01')).toBe(false);
    expect(isOverdue({ status: 'cancelled', due_date: '2026-01-01' }, '2026-06-01')).toBe(false);
    expect(isOverdue({ status: 'new', due_date: '2026-06-01' }, '2026-06-01')).toBe(false); // due today is not late yet
    expect(isOverdue({ status: 'new', due_date: '2026-06-02' }, '2026-06-01')).toBe(false);
  });
});
