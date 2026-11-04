import { AssessedAsset, CONDITIONS, Condition, Confidence } from '@ace/forecast';

/** One row per asset joined with its latest assessment and type defaults (see ForecastController query). */
export interface ForecastRow {
  asset_id: string;
  site_id: string;
  asset_quantity: string | number;
  asset_unit_rate: string | number | null;
  asset_life: number | null;
  type_unit_rate: string | number | null;
  type_life: number | null;
  inspected_on: string | Date;
  conditions: Partial<Record<Condition, { percent?: number; remainingLife?: number }>>;
  quality_confidence: string;
  quantity_confidence: string;
  assessed_quantity: string | number | null;
}

const num = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
const conf = (v: string): Confidence => (v === 'B' || v === 'C' ? v : 'A');

/** Asset values override type defaults; assessed quantity overrides register quantity. */
export function toAssessedAsset(r: ForecastRow): AssessedAsset {
  const buckets = {} as AssessedAsset['buckets'];
  for (const c of CONDITIONS) {
    buckets[c] = { percent: num(r.conditions[c]?.percent), remainingLife: num(r.conditions[c]?.remainingLife) };
  }
  return {
    id: r.asset_id,
    siteId: r.site_id,
    assessmentYear: new Date(r.inspected_on).getUTCFullYear(),
    industryLife: r.asset_life ?? r.type_life ?? 0,
    qualityConfidence: conf(r.quality_confidence),
    quantityConfidence: conf(r.quantity_confidence),
    quantity: r.assessed_quantity !== null ? num(r.assessed_quantity) : num(r.asset_quantity),
    unitRate: r.asset_unit_rate !== null ? num(r.asset_unit_rate) : num(r.type_unit_rate),
    buckets,
  };
}
