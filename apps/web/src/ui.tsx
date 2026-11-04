import { ReactNode } from 'react';
import { YearTotal } from './api';
import { money } from './lib';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function ErrorMsg({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert" className="error">{error instanceof Error ? error.message : String(error)}</p>;
}

export function Loading({ query }: { query: { isLoading: boolean; error: unknown } }) {
  if (query.isLoading) return <p className="muted">Loading…</p>;
  return <ErrorMsg error={query.error} />;
}

/**
 * Yearly cost bars (SVG, no chart library). `cap` draws the annual budget cap line and `spend` overlays capped
 * spend so a levelled budget is visible against demand.
 */
export function BarChart({ data, currency, cap, spend }: { data: YearTotal[]; currency: string; cap?: number; spend?: number[] }) {
  const W = 760, H = 260, L = 64, B = 28, T = 12, R = 8;
  const max = Math.max(1, ...data.map((d) => d.nominal), cap ?? 0, ...(spend ?? []));
  const bw = (W - L - R) / Math.max(1, data.length);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const step = Math.ceil(data.length / 10);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Forecast nominal cost per year" className="chart">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid" />
          <text x={L - 6} y={y(t) + 4} textAnchor="end" className="axis">{compact(t, currency)}</text>
        </g>
      ))}
      {data.map((d, i) => (
        <g key={d.year}>
          <rect x={L + i * bw + bw * 0.12} width={bw * 0.76} y={y(d.nominal)} height={Math.max(0, H - B - y(d.nominal))} className="bar">
            <title>{`${d.year}: ${money(d.nominal, currency)}`}</title>
          </rect>
          {spend && (
            <rect x={L + i * bw + bw * 0.28} width={bw * 0.44} y={y(spend[i] ?? 0)} height={Math.max(0, H - B - y(spend[i] ?? 0))} className="bar-spend">
              <title>{`${d.year} capped spend: ${money(spend[i] ?? 0, currency)}`}</title>
            </rect>
          )}
          {i % step === 0 && <text x={L + i * bw + bw / 2} y={H - 8} textAnchor="middle" className="axis">{d.year}</text>}
        </g>
      ))}
      {cap !== undefined && <line x1={L} x2={W - R} y1={y(cap)} y2={y(cap)} className="cap" />}
    </svg>
  );
}

function compact(n: number, currency: string): string {
  return new Intl.NumberFormat('en-NZ', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
