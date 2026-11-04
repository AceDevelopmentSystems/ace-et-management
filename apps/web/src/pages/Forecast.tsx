import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Client, ForecastResponse, SavedScenario, ScenarioParams, Site, api } from '../api';
import { useAuth } from '../auth';
import { download, forecastCsv, money, num } from '../lib';
import { useRemove } from '../hooks';
import { BarChart, ErrorMsg, Field, Loading, confirmDelete } from '../ui';

interface FormState { startYear: string; horizon: string; inflation: string; discount: string; overdue: ScenarioParams['overdue']; spread: string; cap: string }

const initial = (): FormState => ({ startYear: String(new Date().getFullYear()), horizon: '20', inflation: '3', discount: '6', overdue: 'year1', spread: '3', cap: '' });

/** Form -> API params; returns an error message instead of params when the input is not valid. */
export function toParams(f: FormState): ScenarioParams | string {
  const startYear = num(f.startYear), horizonYears = Number(f.horizon), inflation = num(f.inflation) ?? 0, discount = num(f.discount) ?? 0;
  const spread = num(f.spread) ?? 3, cap = num(f.cap);
  if (startYear === undefined || !Number.isInteger(startYear) || startYear < 2000 || startYear > 2200) return 'Start year must be a year between 2000 and 2200.';
  if ([inflation, discount].some((n) => Number.isNaN(n) || n < 0 || n > 100)) return 'Inflation and discount rate must be percentages between 0 and 100.';
  if (!Number.isInteger(spread) || spread < 1 || spread > 20) return 'Spread years must be a whole number from 1 to 20.';
  if (cap !== undefined && (Number.isNaN(cap) || cap < 0)) return 'Annual cap must be zero or more (or blank for no cap).';
  return { startYear, horizonYears, inflation: inflation / 100, discountRate: discount / 100, overdue: f.overdue, overdueSpreadYears: spread, ...(cap !== undefined ? { annualCap: cap } : {}) };
}

const toForm = (p: ScenarioParams): FormState => ({
  startYear: String(p.startYear), horizon: String(p.horizonYears), inflation: String(+(p.inflation * 100).toFixed(4)), discount: String(+(p.discountRate * 100).toFixed(4)),
  overdue: p.overdue, spread: String(p.overdueSpreadYears), cap: p.annualCap === undefined ? '' : String(p.annualCap),
});

export function ForecastTab({ client }: { client: Client }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(initial);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const sites = useQuery({ queryKey: ['sites', client.id], queryFn: () => api.get<Site[]>(`/clients/${client.id}/sites`) });
  const scenarios = useQuery({ queryKey: ['scenarios', client.id], queryFn: () => api.get<SavedScenario[]>(`/clients/${client.id}/scenarios`) });

  const run = useMutation({ mutationFn: (p: ScenarioParams) => api.post<ForecastResponse>(`/clients/${client.id}/forecast`, p) });
  const runSaved = useMutation({ mutationFn: (s: SavedScenario) => api.post<ForecastResponse>(`/scenarios/${s.id}/run`), onSuccess: (_r, s) => setF(toForm(s.params)) });
  const save = useMutation({
    mutationFn: (params: ScenarioParams) => api.post(`/clients/${client.id}/scenarios`, { name: saveName, params }),
    onSuccess: () => { setSaveName(''); qc.invalidateQueries({ queryKey: ['scenarios', client.id] }); },
  });
  const remove = useRemove([['scenarios', client.id]]);

  const parsed = toParams({ ...f });
  const onRun = (e: FormEvent) => {
    e.preventDefault();
    setFormError(typeof parsed === 'string' ? parsed : null);
    if (typeof parsed !== 'string') { runSaved.reset(); run.mutate(parsed); }
  };
  const result = run.data ?? runSaved.data;
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="stack">
      <p className="muted">Projects replacement spend from the latest inspection of each asset. Costs are in {client.currency}.</p>
      <form onSubmit={onRun} className="card row">
        <Field label="Start year"><input required type="number" value={f.startYear} onChange={set('startYear')} size={6} /></Field>
        <Field label="Horizon">
          <select value={f.horizon} onChange={set('horizon')}>{[5, 10, 15, 20, 25, 30].map((n) => <option key={n} value={n}>{n} years</option>)}</select>
        </Field>
        <Field label="Inflation % / yr"><input type="number" min={0} max={100} step="any" value={f.inflation} onChange={set('inflation')} size={5} /></Field>
        <Field label="Discount rate % / yr"><input type="number" min={0} max={100} step="any" value={f.discount} onChange={set('discount')} size={5} /></Field>
        <Field label="Overdue work" hint="Replacements already past due">
          <select value={f.overdue} onChange={set('overdue')}>
            <option value="year1">Do in first year</option><option value="spread">Spread over years</option><option value="ignore">Ignore until next cycle</option>
          </select>
        </Field>
        {f.overdue === 'spread' && <Field label="Spread over (yrs)"><input type="number" min={1} max={20} step={1} value={f.spread} onChange={set('spread')} size={4} /></Field>}
        <Field label="Annual budget cap" hint="Blank = none"><input type="number" min={0} step="any" value={f.cap} onChange={set('cap')} size={10} /></Field>
        <button type="submit" disabled={run.isPending}>Run forecast</button>
      </form>
      {formError && <p role="alert" className="error">{formError}</p>}
      <ErrorMsg error={run.error ?? runSaved.error} />

      {result && <Result result={result} client={client} sites={sites.data ?? []} />}

      {canWrite && result && (
        <form className="card row" onSubmit={(e) => { e.preventDefault(); if (typeof parsed !== 'string') save.mutate(parsed); }}>
          <Field label="Save these settings as"><input required value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="e.g. 10 year, 3% inflation" /></Field>
          <button type="submit" disabled={save.isPending || typeof parsed === 'string'}>Save scenario</button>
          <ErrorMsg error={save.error} />
        </form>
      )}

      <h2>Saved scenarios</h2>
      <Loading query={scenarios} />
      {scenarios.data?.length === 0 && <p className="muted">None saved yet.</p>}
      <ul className="list">
        {scenarios.data?.map((s) => (
          <li key={s.id}>
            {s.name} <span className="muted">{s.params.horizonYears} yrs from {s.params.startYear}</span>{' '}
            <button type="button" className="link" onClick={() => { run.reset(); runSaved.mutate(s); }}>Run</button>
            {canWrite && <button type="button" className="link danger" onClick={() => { if (confirmDelete(`scenario “${s.name}”`)) remove.mutate(`/scenarios/${s.id}`); }}>Delete</button>}
          </li>
        ))}
      </ul>
      <ErrorMsg error={remove.error} />
    </div>
  );
}

function Result({ result, client, sites }: { result: ForecastResponse; client: Client; sites: Site[] }) {
  const cur = client.currency;
  const lev = result.leveled;
  const peak = result.byYear.reduce((m, y) => (y.nominal > m.nominal ? y : m), result.byYear[0]!);
  const siteName = (id: string) => { const s = sites.find((x) => x.id === id); return s ? `${s.code} ${s.name}` : id; };
  const backlog = lev?.[lev.length - 1]?.carried ?? 0;
  return (
    <div className="stack">
      <div className="cards">
        <div className="card"><small>Assets forecast</small><strong>{result.assetsAssessed}</strong></div>
        <div className="card"><small>Total (nominal)</small><strong>{money(result.totals.nominal, cur)}</strong></div>
        <div className="card"><small>Present value</small><strong>{money(result.totals.presentValue, cur)}</strong></div>
        <div className="card"><small>Peak year</small><strong>{peak.nominal > 0 ? `${peak.year}: ${money(peak.nominal, cur)}` : '—'}</strong></div>
      </div>
      {result.skipped.length > 0 && (
        <p role="status" className="warn">{result.skipped.length} assessed asset{result.skipped.length === 1 ? ' was' : 's were'} left out because they have no life or replacement rate (set them on the asset or its type).</p>
      )}
      {result.assetsAssessed === 0 && result.skipped.length === 0 && <p role="status" className="warn">No assets have been inspected yet, so there is nothing to forecast. Record an inspection on a site first.</p>}
      <BarChart data={result.byYear} currency={cur} cap={result.scenario.annualCap} spend={lev?.map((y) => y.spend)} />
      {lev && backlog > 0 && <p role="status" className="warn">With this cap, {money(backlog, cur)} of work is still unfunded at the end of the period.</p>}
      <div><button type="button" onClick={() => download(`forecast-${client.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${result.scenario.startYear}.csv`, forecastCsv(result, sites, client))}>Export CSV</button></div>
      <table className="table">
        <thead><tr><th>Year</th><th>Real</th><th>Nominal</th><th>Present value</th>{lev && <><th>Capped spend</th><th>Backlog</th></>}</tr></thead>
        <tbody>
          {result.byYear.map((y, i) => (
            <tr key={y.year}><td>{y.year}</td><td>{money(y.real, cur)}</td><td>{money(y.nominal, cur)}</td><td>{money(y.presentValue, cur)}</td>
              {lev && <><td>{money(lev[i]!.spend, cur)}</td><td>{money(lev[i]!.carried, cur)}</td></>}</tr>
          ))}
        </tbody>
      </table>
      <h3>By site (nominal)</h3>
      <table className="table">
        <thead><tr><th>Site</th><th>Total</th></tr></thead>
        <tbody>
          {Object.entries(result.bySite)
            .map(([id, years]) => ({ id, name: siteName(id), total: Object.values(years).reduce((a, b) => a + b, 0) }))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((s) => <tr key={s.id}><td>{s.name}</td><td>{money(s.total, cur)}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
