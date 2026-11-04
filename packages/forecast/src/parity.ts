import { AssessedAsset, Condition } from './types';
import { QUALITY_ADJ, QUANTITY_ADJ, vbaMod, vbaRound } from './vba';

/**
 * Faithful port of the legacy Excel macro `ForwardCost` (CMS-122.xlt, module basForwardCost),
 * including its known quirks. Used only to validate the new engine against historical output.
 *
 * Returns null where the macro returns Null (industry life 0, or nothing assessed).
 * Quirks preserved: overdue items before the start year are never charged; the excellent and
 * "none" buckets carry no partial maintenance cost; partial costs are one-offs at full unit rate.
 */
export function legacyForwardCost(a: AssessedAsset, year: number): number | null {
  if (a.industryLife === 0) return null;
  const b = a.buckets;
  const pct = (c: Condition) => b[c].percent;
  const life = (c: Condition) => b[c].remainingLife;

  const qualityAdj = QUALITY_ADJ[a.qualityConfidence] ?? 0;
  const quantityAdj = QUANTITY_ADJ[a.quantityConfidence] ?? 0;

  const total =
    pct('none') + pct('excellent') + pct('good') + pct('average') +
    pct('poor') + pct('veryPoor') + pct('urgent');
  if (total === 0) return null;

  // Replacement life: the macro checks buckets in this order; the last 100% bucket wins.
  let replLife = 0;
  let calculated = false;
  if (pct('none') === 100) { replLife = a.industryLife; calculated = true; }
  const order: Condition[] = ['excellent', 'good', 'average', 'poor', 'veryPoor', 'urgent'];
  for (const c of order) {
    if (pct(c) === 100) { replLife = life(c); calculated = true; }
  }
  if (!calculated) {
    replLife = a.industryLife;
    for (const c of order) {
      if (replLife === 0) replLife = life(c);
    }
  }

  const lifeAdjusted = replLife + vbaRound(replLife * qualityAdj);
  if (vbaMod(year - lifeAdjusted - a.assessmentYear, a.industryLife) === 0 && a.unitRate > 0) {
    return a.unitRate * (a.quantity + a.quantity * quantityAdj);
  }

  // No maintenance if any bucket is 100%.
  if (pct('none') === 100 || order.some((c) => pct(c) === 100)) return 0;

  // Partial costs; the macro walks urgent -> good and skips excellent/none.
  let cost = 0;
  for (const c of ['urgent', 'veryPoor', 'poor', 'average', 'good'] as Condition[]) {
    if (pct(c) > 0) {
      const adj = life(c) + vbaRound(life(c) * qualityAdj);
      if (a.assessmentYear + adj === year) {
        const q = (pct(c) / 100) * a.quantity * quantityAdj + a.quantity * (pct(c) / 100);
        cost += q * a.unitRate;
      }
    }
  }
  return cost;
}
