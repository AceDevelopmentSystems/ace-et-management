import {
  AssessedAsset, Condition, CostKind, CostLine, ForecastResult, LeveledYear, Scenario, YearTotal,
} from './types';
import { QUALITY_ADJ, QUANTITY_ADJ, vbaRound } from './vba';

const ORDER: Condition[] = ['none', 'excellent', 'good', 'average', 'poor', 'veryPoor', 'urgent'];

/**
 * Standard forecast. Each condition bucket is a portion of the asset with its own first
 * replacement year (assessment year + quality-adjusted remaining life; the "none" bucket uses
 * industry life). Every portion then recurs each industryLife years. Fixes vs the legacy macro:
 *  - excellent/none portions are included and mixed assets are not double counted;
 *  - overdue replacements follow the scenario policy instead of being silently dropped;
 *  - fractional quantities are kept; inflation, discounting and budget capping are supported.
 */
export function runForecast(assets: AssessedAsset[], s: Scenario): ForecastResult {
  const lines: CostLine[] = [];
  const skipped: string[] = [];
  const endYear = s.startYear + s.horizonYears - 1;

  for (const a of assets) {
    const total = ORDER.reduce((n, c) => n + a.buckets[c].percent, 0);
    if (a.industryLife <= 0 || total <= 0 || a.unitRate <= 0) {
      skipped.push(a.id);
      continue;
    }
    const qAdj = QUALITY_ADJ[a.qualityConfidence] ?? 0;
    const nAdj = QUANTITY_ADJ[a.quantityConfidence] ?? 0;

    for (const c of ORDER) {
      const { percent, remainingLife } = a.buckets[c];
      if (percent <= 0) continue;
      const baseLife = c === 'none' ? a.industryLife : remainingLife;
      const adjLife = baseLife + vbaRound(baseLife * qAdj);
      const portion = (percent / total) * a.quantity * (1 + nAdj);
      const real = portion * a.unitRate;
      const kind: CostKind = percent / total >= 0.99999 ? 'replacement' : 'partial';

      let year = a.assessmentYear + adjLife;
      if (year < s.startYear) {
        if (s.overdue === 'ignore') {
          while (year < s.startYear) year += a.industryLife;
        } else if (s.overdue === 'year1') {
          year = s.startYear;
        } else {
          const n = Math.max(1, Math.floor(s.overdueSpreadYears));
          for (let i = 0; i < n; i++) {
            const y = s.startYear + i;
            if (y <= endYear) push(lines, a.id, y, kind, real / n, s);
          }
          year = s.startYear + n - 1 + a.industryLife; // cycle restarts from the last spread year
        }
      }
      for (; year <= endYear; year += a.industryLife) push(lines, a.id, year, kind, real, s);
    }
  }

  const byYear = rollUp(lines, s);
  const leveled = s.annualCap === undefined ? undefined : level(byYear, s.annualCap);
  return { lines, byYear, leveled, skipped };
}

function push(lines: CostLine[], assetId: string, year: number, kind: CostKind, real: number, s: Scenario) {
  const t = year - s.startYear;
  const nominal = real * Math.pow(1 + s.inflation, t);
  lines.push({ assetId, year, kind, real, nominal, presentValue: nominal / Math.pow(1 + s.discountRate, t) });
}

function rollUp(lines: CostLine[], s: Scenario): YearTotal[] {
  const out: YearTotal[] = [];
  for (let i = 0; i < s.horizonYears; i++) {
    out.push({ year: s.startYear + i, real: 0, nominal: 0, presentValue: 0 });
  }
  for (const l of lines) {
    const row = out[l.year - s.startYear];
    if (!row) continue;
    row.real += l.real;
    row.nominal += l.nominal;
    row.presentValue += l.presentValue;
  }
  return out;
}

/** Cap nominal spend per year; unspent demand carries forward (any backlog left at the end stays in `carried`). */
export function level(byYear: YearTotal[], cap: number): LeveledYear[] {
  let backlog = 0;
  return byYear.map((y) => {
    const available = y.nominal + backlog;
    const spend = Math.min(available, cap);
    backlog = available - spend;
    return { year: y.year, demand: y.nominal, spend, carried: backlog };
  });
}
