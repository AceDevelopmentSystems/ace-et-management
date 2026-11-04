import { describe, expect, it } from 'vitest';
import {
  AssessedAsset, Condition, Scenario, legacyForwardCost, runForecast, vbaMod, vbaRound,
} from '../src';

type Partials = Partial<Record<Condition, { percent: number; remainingLife: number }>>;

function asset(over: Partial<Omit<AssessedAsset, 'buckets'>> & { buckets?: Partials } = {}): AssessedAsset {
  const zero = { percent: 0, remainingLife: 0 };
  const { buckets, ...rest } = over;
  return {
    id: 'a1', assessmentYear: 2020, industryLife: 20,
    qualityConfidence: 'A', quantityConfidence: 'A', quantity: 10, unitRate: 100,
    buckets: {
      none: zero, excellent: zero, good: zero, average: zero, poor: zero, veryPoor: zero, urgent: zero,
      ...buckets,
    },
    ...rest,
  };
}
const scenario = (o: Partial<Scenario> = {}): Scenario => ({
  startYear: 2025, horizonYears: 20, inflation: 0, discountRate: 0,
  overdue: 'year1', overdueSpreadYears: 3, ...o,
});

describe('vba helpers', () => {
  it('rounds half to even', () => {
    expect([0.5, 1.5, 2.5, 2.4, 2.6].map(vbaRound)).toEqual([0, 2, 2, 2, 3]);
  });
  it('mod keeps dividend sign', () => {
    expect(vbaMod(-7, 5)).toBe(-2);
    expect(vbaMod(10, 5)).toBe(0);
  });
});

describe('legacy parity (CMS-122 ForwardCost)', () => {
  const a = asset({ buckets: { average: { percent: 100, remainingLife: 8 } } });
  it('charges replacement in assessYear+life and every industry life after', () => {
    expect(legacyForwardCost(a, 2028)).toBe(1000);
    expect(legacyForwardCost(a, 2048)).toBe(1000);
    expect(legacyForwardCost(a, 2030)).toBe(0);
  });
  it('applies quality and quantity confidence', () => {
    const b = asset({ qualityConfidence: 'C', quantityConfidence: 'C', buckets: { poor: { percent: 100, remainingLife: 10 } } });
    expect(legacyForwardCost(b, 2029)).toBeCloseTo(100 * 10 * 1.05); // 10 + round(-1) = 9
  });
  it('returns null when life missing or unassessed', () => {
    expect(legacyForwardCost(asset({ industryLife: 0 }), 2030)).toBeNull();
    expect(legacyForwardCost(asset(), 2030)).toBeNull();
  });
  it('charges partial buckets as one-offs and skips excellent', () => {
    const m = asset({ buckets: { excellent: { percent: 60, remainingLife: 15 }, poor: { percent: 40, remainingLife: 3 } } });
    expect(legacyForwardCost(m, 2023)).toBeCloseTo(0.4 * 10 * 100);
    expect(legacyForwardCost(m, 2035)).toBe(0);
  });
  it('quirk: an overdue replacement is only charged in its past year', () => {
    const o = asset({ buckets: { urgent: { percent: 100, remainingLife: 1 } } });
    expect(legacyForwardCost(o, 2021)).toBe(1000);
    expect(legacyForwardCost(o, 2025)).toBe(0);
  });
});

describe('standard forecast', () => {
  it('matches legacy for a clean in-horizon 100% asset', () => {
    const a = asset({ buckets: { average: { percent: 100, remainingLife: 8 } } });
    const r = runForecast([a], scenario({ horizonYears: 25 }));
    expect(r.lines.map((l) => l.year)).toEqual([2028, 2048]);
    expect(r.byYear.find((y) => y.year === 2028)!.real).toBe(1000);
  });

  it('charges overdue work in year 1 and recurs from there', () => {
    const a = asset({ buckets: { urgent: { percent: 100, remainingLife: 1 } } });
    expect(runForecast([a], scenario()).lines.map((l) => l.year)).toEqual([2025]);
    expect(runForecast([a], scenario({ horizonYears: 30 })).lines.map((l) => l.year)).toEqual([2025, 2045]);
  });

  it('spreads overdue work and conserves total cost', () => {
    const a = asset({ buckets: { urgent: { percent: 100, remainingLife: 1 } } });
    const r = runForecast([a], scenario({ overdue: 'spread', overdueSpreadYears: 4 }));
    expect(r.lines).toHaveLength(4);
    expect(r.lines.reduce((n, l) => n + l.real, 0)).toBeCloseTo(1000);
  });

  it('ignore skips overdue work until the next cycle', () => {
    const a = asset({ buckets: { urgent: { percent: 100, remainingLife: 1 } } });
    const r = runForecast([a], scenario({ overdue: 'ignore', horizonYears: 30 }));
    expect(r.lines.map((l) => l.year)).toEqual([2041]);
  });

  it('includes excellent portions and splits mixed assets without double counting', () => {
    const m = asset({ buckets: { excellent: { percent: 60, remainingLife: 15 }, poor: { percent: 40, remainingLife: 8 } } });
    const r = runForecast([m], scenario({ horizonYears: 20 }));
    const got = r.lines.map((l) => [l.year, l.real]).sort((x, y) => x[0]! - y[0]!);
    expect(got).toEqual([[2028, 400], [2035, 600]]);
  });

  it('keeps fractional quantities', () => {
    const a = asset({ quantity: 2.5, buckets: { average: { percent: 100, remainingLife: 8 } } });
    expect(runForecast([a], scenario()).byYear.find((y) => y.year === 2028)!.real).toBe(250);
  });

  it('applies inflation and discounting from the start year', () => {
    const a = asset({ buckets: { average: { percent: 100, remainingLife: 8 } } });
    const l = runForecast([a], scenario({ inflation: 0.03, discountRate: 0.06 })).lines[0]!; // 2028, t = 3
    expect(l.nominal).toBeCloseTo(1000 * 1.03 ** 3);
    expect(l.presentValue).toBeCloseTo(l.nominal / 1.06 ** 3);
  });

  it('caps annual spend and carries the backlog', () => {
    const a = asset({ buckets: { average: { percent: 100, remainingLife: 8 } } });
    const l = runForecast([a], scenario({ annualCap: 400 })).leveled!;
    expect(l.find((y) => y.year === 2028)!.spend).toBe(400);
    expect(l.find((y) => y.year === 2028)!.carried).toBe(600);
    expect(l.find((y) => y.year === 2030)!.carried).toBe(0);
    expect(l.reduce((n, y) => n + y.spend, 0)).toBe(1000);
  });

  it('skips assets with missing data', () => {
    const r = runForecast([asset({ id: 'x', industryLife: 0 }), asset({ id: 'y' })], scenario());
    expect(r.skipped).toEqual(['x', 'y']);
    expect(r.lines).toHaveLength(0);
  });

  it('never produces negative costs and covers exactly the horizon', () => {
    const a = asset({ buckets: { good: { percent: 70, remainingLife: 5 }, poor: { percent: 30, remainingLife: 2 } } });
    const r = runForecast([a], scenario({ horizonYears: 15, inflation: 0.02 }));
    expect(r.byYear).toHaveLength(15);
    expect(r.lines.every((l) => l.real >= 0 && l.year >= 2025 && l.year <= 2039)).toBe(true);
  });
});
