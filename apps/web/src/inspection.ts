import { CONDITIONS, CONDITION_LABEL, Condition } from './api';

export interface RowState {
  assetId: string;
  grade: Condition | '';
  remainingLife: string;
  mixed: boolean;
  /** Used when `mixed`: percent and remaining life per grade, as typed. */
  split: Partial<Record<Condition, { percent: string; life: string }>>;
  quality: 'A' | 'B' | 'C';
  quantity: 'A' | 'B' | 'C';
}

export interface AssessmentPayload {
  assetId: string;
  conditions: Partial<Record<Condition, { percent: number; remainingLife: number }>>;
  qualityConfidence: 'A' | 'B' | 'C';
  quantityConfidence: 'A' | 'B' | 'C';
}

export const emptyRow = (assetId: string): RowState => ({ assetId, grade: '', remainingLife: '', mixed: false, split: {}, quality: 'A', quantity: 'A' });

const wholeYears = (s: string): number | null => {
  if (s.trim() === '') return 0;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/**
 * Turn the form rows into API assessments. Rows left blank are skipped (the asset was not assessed).
 * Returns per-asset error messages instead of throwing so the form can show them all at once.
 */
export function buildAssessments(rows: RowState[], nameOf: (id: string) => string): { assessments: AssessmentPayload[]; errors: string[] } {
  const assessments: AssessmentPayload[] = [];
  const errors: string[] = [];
  for (const r of rows) {
    const name = nameOf(r.assetId);
    const conditions: AssessmentPayload['conditions'] = {};
    if (r.mixed) {
      let total = 0;
      for (const g of CONDITIONS) {
        const s = r.split[g];
        if (!s || s.percent.trim() === '') continue;
        const pct = Number(s.percent);
        const life = wholeYears(s.life);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) { errors.push(`${name}: ${CONDITION_LABEL[g]} percent must be 0-100`); continue; }
        if (life === null) { errors.push(`${name}: ${CONDITION_LABEL[g]} remaining life must be whole years`); continue; }
        if (pct > 0) { conditions[g] = { percent: pct, remainingLife: life }; total += pct; }
      }
      if (Object.keys(conditions).length === 0) continue; // nothing entered
      if (Math.abs(total - 100) > 0.01) { errors.push(`${name}: percentages total ${total}, they must total 100`); continue; }
    } else {
      if (r.grade === '') continue;
      const life = wholeYears(r.remainingLife);
      if (life === null) { errors.push(`${name}: remaining life must be whole years`); continue; }
      conditions[r.grade] = { percent: 100, remainingLife: life };
    }
    assessments.push({ assetId: r.assetId, conditions, qualityConfidence: r.quality, quantityConfidence: r.quantity });
  }
  return { assessments, errors };
}
