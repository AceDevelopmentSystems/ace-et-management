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
    const csv = forecastCsv(result, [{ id: 's1', code: 'TV1', name: 'Repeater', site_class: null, address: null }], { id: 'c', name: 'TVNZ', code: null, currency: 'NZD' });
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
