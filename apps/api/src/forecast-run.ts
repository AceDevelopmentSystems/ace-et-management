import { NotFoundException } from '@nestjs/common';
import { Scenario, runForecast } from '@ace/forecast';
import { TokenClaims } from './auth';
import { tenant } from './common';
import { Database } from './db';
import { ForecastRow, toAssessedAsset } from './forecast-map';

/** Run a scenario over the latest assessment of every asset of a client (optionally one site). */
export async function runClientForecast(db: Database, c: TokenClaims, clientId: string, scenario: Scenario, siteId?: string) {
  const rows = await db.withTenant(tenant(c), async (q) => {
    if (!(await q.query('SELECT 1 FROM client WHERE id = $1', [clientId])).rows.length) throw new NotFoundException('Client not found');
    return (await q.query<ForecastRow>(
      `SELECT DISTINCT ON (a.id)
              a.id AS asset_id, a.site_id, a.quantity AS asset_quantity, a.unit_rate AS asset_unit_rate, a.expected_life_years AS asset_life,
              t.unit_rate AS type_unit_rate, t.expected_life_years AS type_life,
              i.inspected_on, s.conditions, s.quality_confidence, s.quantity_confidence, s.assessed_quantity
         FROM asset a
         JOIN assessment s ON s.asset_id = a.id
         JOIN inspection i ON i.id = s.inspection_id
         LEFT JOIN asset_type t ON t.id = a.asset_type_id
        WHERE a.client_id = $1 AND ($2::uuid IS NULL OR a.site_id = $2::uuid)
        ORDER BY a.id, i.inspected_on DESC`, [clientId, siteId ?? null])).rows;
  });
  const result = runForecast(rows.map(toAssessedAsset), scenario);
  const siteOf = new Map(rows.map((r) => [r.asset_id, r.site_id]));
  const bySite: Record<string, Record<number, number>> = {};
  for (const l of result.lines) {
    const s = siteOf.get(l.assetId)!;
    const row = (bySite[s] ??= {});
    row[l.year] = (row[l.year] ?? 0) + l.nominal;
  }
  return {
    scenario,
    assetsAssessed: rows.length - result.skipped.length,
    skipped: result.skipped,
    byYear: result.byYear,
    leveled: result.leveled,
    bySite,
    totals: {
      real: result.byYear.reduce((n, y) => n + y.real, 0),
      nominal: result.byYear.reduce((n, y) => n + y.nominal, 0),
      presentValue: result.byYear.reduce((n, y) => n + y.presentValue, 0),
    },
  };
}
