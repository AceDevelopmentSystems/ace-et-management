import { describe, expect, it } from 'vitest';
import { RowState, buildAssessments, emptyRow } from './inspection';

const name = (id: string) => `asset-${id}`;
const row = (over: Partial<RowState> & { assetId: string }): RowState => ({ ...emptyRow(over.assetId), ...over });

describe('buildAssessments', () => {
  it('skips rows that were not assessed', () => {
    expect(buildAssessments([emptyRow('a')], name)).toEqual({ assessments: [], errors: [] });
  });
  it('maps a single grade to 100 percent', () => {
    const r = buildAssessments([row({ assetId: 'a', grade: 'average', remainingLife: '6', quality: 'B' })], name);
    expect(r.errors).toEqual([]);
    expect(r.assessments).toEqual([{ assetId: 'a', conditions: { average: { percent: 100, remainingLife: 6 } }, qualityConfidence: 'B', quantityConfidence: 'A' }]);
  });
  it('treats a blank remaining life as 0', () => {
    expect(buildAssessments([row({ assetId: 'a', grade: 'none' })], name).assessments[0]!.conditions.none).toEqual({ percent: 100, remainingLife: 0 });
  });
  it('rejects fractional or negative remaining life', () => {
    expect(buildAssessments([row({ assetId: 'a', grade: 'good', remainingLife: '2.5' })], name).errors).toHaveLength(1);
    expect(buildAssessments([row({ assetId: 'a', grade: 'good', remainingLife: '-1' })], name).errors).toHaveLength(1);
  });
  it('builds a mixed split that totals 100', () => {
    const r = buildAssessments([row({ assetId: 'a', mixed: true, split: { excellent: { percent: '60', life: '15' }, poor: { percent: '40', life: '3' } } })], name);
    expect(r.errors).toEqual([]);
    expect(r.assessments[0]!.conditions).toEqual({ excellent: { percent: 60, remainingLife: 15 }, poor: { percent: 40, remainingLife: 3 } });
  });
  it('flags a mixed split that does not total 100', () => {
    const r = buildAssessments([row({ assetId: 'a', mixed: true, split: { good: { percent: '50', life: '5' } } })], name);
    expect(r.assessments).toEqual([]);
    expect(r.errors[0]).toContain('must total 100');
  });
  it('ignores a mixed row with nothing typed and reports bad percents', () => {
    expect(buildAssessments([row({ assetId: 'a', mixed: true })], name)).toEqual({ assessments: [], errors: [] });
    expect(buildAssessments([row({ assetId: 'a', mixed: true, split: { good: { percent: '150', life: '1' } } })], name).errors[0]).toContain('0-100');
  });
  it('collects errors for every bad asset while keeping good ones', () => {
    const r = buildAssessments([row({ assetId: 'a', grade: 'good', remainingLife: 'x' }), row({ assetId: 'b', grade: 'poor', remainingLife: '2' })], name);
    expect(r.errors).toHaveLength(1);
    expect(r.assessments.map((a) => a.assetId)).toEqual(['b']);
  });
});
