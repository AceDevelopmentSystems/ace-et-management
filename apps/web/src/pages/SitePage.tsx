import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Asset, AssetType, CONDITIONS, CONDITION_LABEL, Condition, api } from '../api';
import { useAuth } from '../auth';
import { RowState, buildAssessments, emptyRow } from '../inspection';
import { num } from '../lib';
import { ErrorMsg, Field, Loading } from '../ui';

interface SiteDetail { id: string; client_id: string; code: string; name: string }

export function SitePage() {
  const { siteId = '' } = useParams();
  const { canWrite, canAssess } = useAuth();
  const site = useQuery({ queryKey: ['site', siteId], queryFn: () => api.get<SiteDetail>(`/sites/${siteId}`) });
  const clientId = site.data?.client_id;
  const assets = useQuery({ queryKey: ['assets', siteId], queryFn: () => api.get<Asset[]>(`/sites/${siteId}/assets`) });
  const types = useQuery({ queryKey: ['types', clientId], enabled: !!clientId, queryFn: () => api.get<AssetType[]>(`/clients/${clientId}/asset-types`) });

  return (
    <section className="stack">
      {clientId && <p><Link to={`/clients/${clientId}/sites`}>← Sites</Link></p>}
      <Loading query={site} />
      {site.data && <h1>{site.data.code} · {site.data.name}</h1>}
      <h2>Assets</h2>
      <Loading query={assets} />
      {assets.data?.length === 0 && <p className="muted">No assets at this site yet.</p>}
      {assets.data && assets.data.length > 0 && (
        <table className="table">
          <thead><tr><th>Name</th><th>Type</th><th>Qty</th><th>Rate</th><th>Life (yrs)</th><th>Installed</th></tr></thead>
          <tbody>
            {assets.data.map((a) => {
              const type = types.data?.find((t) => t.id === a.asset_type_id);
              // Show the value the forecast will use; grey when it comes from the asset type rather than the asset itself.
              const rate = a.unit_rate ?? type?.unit_rate ?? null;
              const life = a.expected_life_years ?? type?.expected_life_years ?? null;
              return (
                <tr key={a.id}>
                  <td>{a.parent_id ? '↳ ' : ''}{a.name}</td><td>{type?.name ?? ''}</td><td>{Number(a.quantity)} {a.unit ?? type?.unit ?? ''}</td>
                  <td className={a.unit_rate === null ? 'muted' : undefined} title={a.unit_rate === null && rate !== null ? 'From the asset type' : undefined}>{rate ?? <span className="warn-text">not set</span>}</td>
                  <td className={a.expected_life_years === null ? 'muted' : undefined} title={a.expected_life_years === null && life !== null ? 'From the asset type' : undefined}>{life ?? <span className="warn-text">not set</span>}</td>
                  <td>{a.install_date ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {canWrite && <AddAsset siteId={siteId} assets={assets.data ?? []} types={types.data ?? []} />}
      {canAssess && assets.data && assets.data.length > 0 && <InspectionForm siteId={siteId} assets={assets.data} />}
    </section>
  );
}

function AddAsset({ siteId, assets, types }: { siteId: string; assets: Asset[]; types: AssetType[] }) {
  const qc = useQueryClient();
  const blank = { name: '', typeId: '', parentId: '', quantity: '1', unit: '', rate: '', life: '', installed: '' };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const create = useMutation({
    mutationFn: () => api.post(`/sites/${siteId}/assets`, {
      name: f.name, assetTypeId: f.typeId || undefined, parentId: f.parentId || undefined, quantity: num(f.quantity),
      unit: f.unit || undefined, unitRate: num(f.rate), expectedLifeYears: num(f.life), installDate: f.installed || undefined,
    }),
    onSuccess: () => { setF(blank); qc.invalidateQueries({ queryKey: ['assets', siteId] }); },
  });
  const onSubmit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  return (
    <form onSubmit={onSubmit} className="card row">
      <Field label="Name"><input required value={f.name} onChange={set('name')} /></Field>
      <Field label="Type">
        <select value={f.typeId} onChange={set('typeId')}><option value="">—</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      </Field>
      <Field label="Part of">
        <select value={f.parentId} onChange={set('parentId')}><option value="">—</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      </Field>
      <Field label="Quantity"><input type="number" min={0} step="any" value={f.quantity} onChange={set('quantity')} size={6} /></Field>
      <Field label="Unit"><input value={f.unit} onChange={set('unit')} size={5} /></Field>
      <Field label="Rate" hint="Blank = type default"><input type="number" min={0} step="0.01" value={f.rate} onChange={set('rate')} size={8} /></Field>
      <Field label="Life (yrs)" hint="Blank = type default"><input type="number" min={1} step={1} value={f.life} onChange={set('life')} size={5} /></Field>
      <Field label="Installed"><input type="date" value={f.installed} onChange={set('installed')} /></Field>
      <button type="submit" disabled={create.isPending}>Add asset</button>
      <ErrorMsg error={create.error} />
    </form>
  );
}

function InspectionForm({ siteId, assets }: { siteId: string; assets: Asset[] }) {
  const qc = useQueryClient();
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
  const [head, setHead] = useState({ date: today, inspector: '', notes: '' });
  const [rows, setRows] = useState<RowState[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);

  // Keep one row per asset, preserving what has been typed when assets change.
  useEffect(() => {
    setRows((prev) => assets.map((a) => prev.find((r) => r.assetId === a.id) ?? emptyRow(a.id)));
  }, [assets]);

  const nameOf = (id: string) => assets.find((a) => a.id === id)?.name ?? id;
  const update = (id: string, patch: Partial<RowState>) => setRows((rs) => rs.map((r) => (r.assetId === id ? { ...r, ...patch } : r)));

  const save = useMutation({
    mutationFn: (assessments: ReturnType<typeof buildAssessments>['assessments']) =>
      api.post<{ assessments: number }>(`/sites/${siteId}/inspections`, { inspectedOn: head.date, inspector: head.inspector || undefined, notes: head.notes || undefined, assessments }),
    onSuccess: (r) => {
      setDone(`Recorded ${r.assessments} assessment${r.assessments === 1 ? '' : 's'}. The forecast now uses them.`);
      setRows(assets.map((a) => emptyRow(a.id)));
      qc.invalidateQueries({ queryKey: ['forecast'] });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setDone(null);
    const { assessments, errors } = buildAssessments(rows, nameOf);
    if (assessments.length === 0 && errors.length === 0) errors.push('Assess at least one asset: pick a condition for it.');
    setProblems(errors);
    if (errors.length === 0) save.mutate(assessments);
  };

  return (
    <form onSubmit={onSubmit} className="card stack">
      <h2>Record an inspection</h2>
      <p className="muted">Pick a condition for each asset you inspected and leave the rest blank. Use “Mixed” when an asset is part one condition, part another.</p>
      <div className="row">
        <Field label="Inspection date"><input type="date" required value={head.date} max={today} onChange={(e) => setHead({ ...head, date: e.target.value })} /></Field>
        <Field label="Inspector"><input value={head.inspector} onChange={(e) => setHead({ ...head, inspector: e.target.value })} /></Field>
        <Field label="Notes"><input value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} /></Field>
      </div>
      <table className="table">
        <thead><tr><th>Asset</th><th>Condition</th><th>Years left</th><th>Quality</th><th>Quantity</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <RowEditor key={r.assetId} row={r} name={nameOf(r.assetId)} onChange={(p) => update(r.assetId, p)} />
          ))}
        </tbody>
      </table>
      {problems.length > 0 && <ul role="alert" className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <ErrorMsg error={save.error} />
      {done && <p role="status" className="ok">{done}</p>}
      <div><button type="submit" disabled={save.isPending}>Save inspection</button></div>
    </form>
  );
}

function RowEditor({ row, name, onChange }: { row: RowState; name: string; onChange: (p: Partial<RowState>) => void }) {
  const conf = (key: 'quality' | 'quantity', label: string) => (
    <select aria-label={`${label} confidence for ${name}`} value={row[key]} onChange={(e) => onChange({ [key]: e.target.value as 'A' | 'B' | 'C' })}>
      <option value="A">A · high</option><option value="B">B · medium</option><option value="C">C · low</option>
    </select>
  );
  return (
    <>
      <tr>
        <td>{name}</td>
        <td>
          {row.mixed ? <span className="muted">Mixed</span> : (
            <select aria-label={`Condition for ${name}`} value={row.grade} onChange={(e) => onChange({ grade: e.target.value as Condition | '' })}>
              <option value="">Not inspected</option>
              {CONDITIONS.map((g) => <option key={g} value={g}>{CONDITION_LABEL[g]}</option>)}
            </select>
          )}
        </td>
        <td>{!row.mixed && <input aria-label={`Years left for ${name}`} type="number" min={0} step={1} value={row.remainingLife} onChange={(e) => onChange({ remainingLife: e.target.value })} size={4} />}</td>
        <td>{conf('quality', 'Quality')}</td>
        <td>{conf('quantity', 'Quantity')}</td>
        <td><button type="button" className="link" onClick={() => onChange({ mixed: !row.mixed })}>{row.mixed ? 'Single' : 'Mixed…'}</button></td>
      </tr>
      {row.mixed && (
        <tr className="split">
          <td colSpan={6}>
            <div className="row">
              {CONDITIONS.map((g) => (
                <fieldset key={g}>
                  <legend>{CONDITION_LABEL[g]}</legend>
                  <input aria-label={`${CONDITION_LABEL[g]} percent for ${name}`} placeholder="%" type="number" min={0} max={100} step="any" size={4}
                    value={row.split[g]?.percent ?? ''} onChange={(e) => onChange({ split: { ...row.split, [g]: { percent: e.target.value, life: row.split[g]?.life ?? '' } } })} />
                  <input aria-label={`${CONDITION_LABEL[g]} years left for ${name}`} placeholder="yrs" type="number" min={0} step={1} size={3}
                    value={row.split[g]?.life ?? ''} onChange={(e) => onChange({ split: { ...row.split, [g]: { percent: row.split[g]?.percent ?? '', life: e.target.value } } })} />
                </fieldset>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
