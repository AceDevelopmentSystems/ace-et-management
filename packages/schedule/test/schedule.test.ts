import { describe, expect, it } from 'vitest';
import { MAX_OCCURRENCES, addInterval, describe as describeRecurrence, isDate, occurrences } from '../src';

describe('addInterval', () => {
  it('adds days and weeks across month and year ends', () => {
    expect(addInterval('2026-12-30', 3, 'day')).toBe('2027-01-02');
    expect(addInterval('2026-02-26', 1, 'week')).toBe('2026-03-05');
    expect(addInterval('2024-02-28', 2, 'day')).toBe('2024-03-01'); // leap year
    expect(addInterval('2025-02-28', 2, 'day')).toBe('2025-03-02');
  });
  it('clamps a month-end day instead of overflowing', () => {
    expect(addInterval('2026-01-31', 1, 'month')).toBe('2026-02-28');
    expect(addInterval('2024-01-31', 1, 'month')).toBe('2024-02-29');
    expect(addInterval('2026-03-31', 1, 'month')).toBe('2026-04-30');
    expect(addInterval('2026-08-31', 6, 'month')).toBe('2027-02-28');
  });
  it('does not drift when counting from the anchor', () => {
    const got = [0, 1, 2, 3].map((k) => addInterval('2026-01-31', k, 'month'));
    expect(got).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });
  it('rolls the year over for months and handles years', () => {
    expect(addInterval('2026-11-15', 3, 'month')).toBe('2027-02-15');
    expect(addInterval('2026-11-15', 25, 'month')).toBe('2028-12-15');
    expect(addInterval('2024-02-29', 1, 'year')).toBe('2025-02-28');
    expect(addInterval('2024-02-29', 4, 'year')).toBe('2028-02-29');
  });
  it('supports counting backwards and zero', () => {
    expect(addInterval('2026-03-31', 0, 'month')).toBe('2026-03-31');
    expect(addInterval('2026-03-31', -1, 'month')).toBe('2026-02-28');
  });
  it('rejects things that are not real dates', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', 'tomorrow', '', '2026-00-10']) {
      expect(() => addInterval(bad, 1, 'day'), bad).toThrow(RangeError);
    }
  });
});

describe('occurrences', () => {
  it('monthly: every month from the first due date through the end of the window', () => {
    expect(occurrences({ firstDue: '2026-01-15', interval: 1, unit: 'month' }, { through: '2026-04-30' }))
      .toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
  });
  it('includes both ends of the window', () => {
    expect(occurrences({ firstDue: '2026-01-01', interval: 1, unit: 'week' }, { from: '2026-01-08', through: '2026-01-22' }))
      .toEqual(['2026-01-08', '2026-01-15', '2026-01-22']);
  });
  it('every N units', () => {
    expect(occurrences({ firstDue: '2026-01-31', interval: 3, unit: 'month' }, { through: '2026-12-31' }))
      .toEqual(['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31']);
    expect(occurrences({ firstDue: '2026-01-01', interval: 10, unit: 'day' }, { through: '2026-01-31' }))
      .toEqual(['2026-01-01', '2026-01-11', '2026-01-21', '2026-01-31']);
  });
  it('yearly service', () => {
    expect(occurrences({ firstDue: '2025-06-01', interval: 1, unit: 'year' }, { from: '2026-01-01', through: '2028-12-31' }))
      .toEqual(['2026-06-01', '2027-06-01', '2028-06-01']);
  });
  it('stops at the hard end (contract end date) even if the window goes further', () => {
    expect(occurrences({ firstDue: '2026-01-01', interval: 1, unit: 'month' }, { through: '2026-12-31', until: '2026-03-15' }))
      .toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });
  it('is empty when nothing falls in the window', () => {
    expect(occurrences({ firstDue: '2026-06-01', interval: 1, unit: 'month' }, { through: '2026-05-31' })).toEqual([]);
    expect(occurrences({ firstDue: '2026-01-01', interval: 1, unit: 'year' }, { from: '2026-02-01', through: '2026-12-31' })).toEqual([]);
    expect(occurrences({ firstDue: '2026-01-01', interval: 1, unit: 'day' }, { from: '2026-02-01', through: '2026-01-15' })).toEqual([]);
  });
  it('gives the same answer however the window is split (so generating in pieces never duplicates)', () => {
    const r = { firstDue: '2026-01-31', interval: 1, unit: 'month' as const };
    const whole = occurrences(r, { through: '2027-12-31' });
    const a = occurrences(r, { through: '2026-06-30' });
    const b = occurrences(r, { from: '2026-07-01', through: '2027-12-31' });
    expect([...a, ...b]).toEqual(whole);
    expect(new Set(whole).size).toBe(whole.length);
  });
  it('is strictly increasing', () => {
    const got = occurrences({ firstDue: '2024-02-29', interval: 1, unit: 'month' }, { through: '2030-01-01' });
    for (let i = 1; i < got.length; i++) expect(got[i]! > got[i - 1]!).toBe(true);
  });
  it('refuses ranges that would be huge', () => {
    expect(() => occurrences({ firstDue: '2000-01-01', interval: 1, unit: 'day' }, { through: '2026-01-01' })).toThrow(/occurrences/);
    expect(occurrences({ firstDue: '2000-01-01', interval: 1, unit: 'day' }, { from: '2025-12-01', through: '2026-01-01' })).toHaveLength(32);
    expect(MAX_OCCURRENCES).toBe(5000);
  });
  it('validates its input', () => {
    const ok = { firstDue: '2026-01-01', interval: 1, unit: 'month' as const };
    expect(() => occurrences({ ...ok, interval: 0 }, { through: '2026-12-31' })).toThrow(/Interval/);
    expect(() => occurrences({ ...ok, interval: 1.5 }, { through: '2026-12-31' })).toThrow(/Interval/);
    expect(() => occurrences({ ...ok, interval: 121 }, { through: '2026-12-31' })).toThrow(/Interval/);
    expect(() => occurrences({ ...ok, unit: 'fortnight' as never }, { through: '2026-12-31' })).toThrow(/Unit/);
    expect(() => occurrences({ ...ok, firstDue: 'nope' }, { through: '2026-12-31' })).toThrow(RangeError);
    expect(() => occurrences(ok, { through: '2026-02-30' })).toThrow(RangeError);
    expect(() => occurrences(ok, { from: 'x', through: '2026-12-31' })).toThrow(RangeError);
  });
});

describe('helpers', () => {
  it('isDate', () => {
    expect(isDate('2026-02-28')).toBe(true);
    expect(isDate('2026-02-29')).toBe(false);
    expect(isDate(20260228)).toBe(false);
    expect(isDate(undefined)).toBe(false);
  });
  it('describes a recurrence', () => {
    expect(describeRecurrence({ interval: 1, unit: 'month' })).toBe('monthly');
    expect(describeRecurrence({ interval: 1, unit: 'year' })).toBe('yearly');
    expect(describeRecurrence({ interval: 3, unit: 'month' })).toBe('every 3 months');
    expect(describeRecurrence({ interval: 2, unit: 'week' })).toBe('every 2 weeks');
  });
});
