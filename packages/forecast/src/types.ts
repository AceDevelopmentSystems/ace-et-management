/** Condition grades, ordered best to worst (as in the legacy CMS). */
export const CONDITIONS = [
  'none',
  'excellent',
  'good',
  'average',
  'poor',
  'veryPoor',
  'urgent',
] as const;
export type Condition = (typeof CONDITIONS)[number];

export type Confidence = 'A' | 'B' | 'C';

/** One condition bucket: share of the asset (0-100) and years of remaining life. */
export interface Bucket {
  percent: number;
  remainingLife: number;
}

export interface AssessedAsset {
  id: string;
  /** Calendar year of the assessment. */
  assessmentYear: number;
  /** Industry (expected) life in years. 0 means data missing -> no forecast. */
  industryLife: number;
  qualityConfidence: Confidence;
  quantityConfidence: Confidence;
  quantity: number;
  /** Replacement cost per unit, in base-year money. */
  unitRate: number;
  buckets: Record<Condition, Bucket>;
  /** Optional rollup keys. */
  siteId?: string;
  category?: string;
}

export type CostKind = 'replacement' | 'partial';

export interface CostLine {
  assetId: string;
  year: number;
  kind: CostKind;
  /** Cost in base-year (real) money. */
  real: number;
  /** Cost escalated by inflation. */
  nominal: number;
  /** Nominal cost discounted to the start year. */
  presentValue: number;
}

export type OverdueMode = 'year1' | 'spread' | 'ignore';

export interface Scenario {
  startYear: number;
  /** 1-50. Typical: 5, 10, 20. */
  horizonYears: number;
  /** Annual inflation, e.g. 0.03. */
  inflation: number;
  /** Annual discount rate, e.g. 0.06. */
  discountRate: number;
  /** What to do with replacements that fell due before startYear. */
  overdue: OverdueMode;
  /** Years over which overdue work is spread when overdue === 'spread'. */
  overdueSpreadYears: number;
  /** Optional annual nominal budget cap; excess carries forward. */
  annualCap?: number;
}

export interface YearTotal {
  year: number;
  real: number;
  nominal: number;
  presentValue: number;
}

export interface LeveledYear {
  year: number;
  /** Nominal demand falling due this year. */
  demand: number;
  /** Nominal spend after capping and carry-forward. */
  spend: number;
  /** Unspent backlog carried out of this year. */
  carried: number;
}

export interface ForecastResult {
  lines: CostLine[];
  byYear: YearTotal[];
  leveled?: LeveledYear[];
  /** Assets skipped because of missing life or no assessment. */
  skipped: string[];
}
