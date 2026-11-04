# Replacement forecast specification

Implemented in `packages/forecast`. Two engines:

## Parity engine (`legacyForwardCost`)
Port of the legacy Excel macro `ForwardCost` (`CMS-122.xlt`, module `basForwardCost`). It exists only to
validate results against historical reports. Quirks are preserved on purpose:
- overdue replacements before the start year are never charged;
- excellent and "none" buckets carry no partial maintenance cost;
- partial costs are one-offs at full unit rate;
- quality confidence A/B/C shortens life by 0/5/10 percent (banker's rounding); quantity confidence A/B/C uplifts quantity 0/2.5/5 percent.

Not yet ported: the spreadsheet columns `MaintenanceCost` and `ReplacementCost` (AB:AD) and the
CMS-123 variant, which differs in its "none" handling and fallback life.

## Standard engine (`runForecast`)
Each condition bucket is a portion of the asset. First replacement = assessment year + quality-adjusted
remaining life ("none" uses industry life); each portion recurs every industry life.

Scenario parameters: `startYear`, `horizonYears` (5-20 typical), `inflation`, `discountRate`,
`overdue` (`year1` | `spread` | `ignore`), `overdueSpreadYears`, optional `annualCap` (nominal; excess carries forward).

Outputs: per-asset cost lines (real, nominal, present value), yearly totals, optional levelled spend and backlog, skipped asset ids.

Differences from legacy: excellent portions included, no double counting, overdue policy, fractional quantities,
inflation, discounting, capping.

## Open items
- Deferral by criticality.
- Rollups by site/category (lines carry asset ids; join in the API layer).
- Golden-file parity tests need real CMS-122 output from the original template.
