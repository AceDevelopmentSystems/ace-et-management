import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Asset, Client, ContractDetail, ContractLine, ContractStatus, ContractSummary, Contractor, Frequency, GenerateResult, Site, api } from '../api';
import { useAuth } from '../auth';
import { usePatch, useRemove } from '../hooks';
import { addDays, describeFrequency, money, num, todayLocal } from '../lib';
import { ErrorMsg, Field, Loading, RowActions, confirmDelete } from '../ui';
import { WorkOrdersPanel } from './WorkOrders';

const STATUSES: ContractStatus[] = ['draft', 'active', 'closed'];
const REFRESH = [['contracts'], ['contract']];

// ------------------------------------------------------------------ a client's contracts
export function ContractsTab({ clientId }: { clientId: string }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const contracts = useQuery({ queryKey: ['contracts', clientId], queryFn: () => api.get<ContractSummary[]>(`/clients/${clientId}/contracts`) });
  const contractors = useQuery({ queryKey: ['contractors'], queryFn: () => api.get<Contractor[]>('/contractors') });
  const year = new Date().getFullYear();
  const [f, setF] = useState({ contractorId: '', code: '', name: '', status: 'draft' as ContractStatus, startDate: `${year}-01-01`, endDate: `${year}-12-31` });
  const create = useMutation({
    mutationFn: () => api.post(`/clients/${clientId}/contracts`, { ...f, code: f.code.trim(), name: f.name.trim() }),
    onSuccess: () => { setF({ ...f, code: '', name: '' }); qc.invalidateQueries({ queryKey: ['contracts', clientId] }); },
  });
  const onSubmit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  return (
    <div className="stack">
      <p className="muted">A contract is an agreement with a contractor. Its lines say what is done, where and how often; work orders are generated from them.</p>
      <Loading query={contracts} />
      {contracts.data?.length === 0 && <p className="muted">No contracts yet.</p>}
      {contracts.data && contracts.data.length > 0 && (
        <table className="table">
          <thead><tr><th>Code</th><th>Name</th><th>Contractor</th><th>Status</th><th>Dates</th><th>Lines</th><th>Open work</th></tr></thead>
          <tbody>
            {contracts.data.map((k) => (
              <tr key={k.id}>
                <td><Link to={`/contracts/${k.id}`}>{k.code}</Link></td><td>{k.name}</td><td>{k.contractor_name}</td>
                <td><span className={`badge ${k.status}`}>{k.status}</span></td><td>{k.start_date} to {k.end_date}</td><td>{k.line_count}</td><td>{k.open_work_orders}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canWrite && (
        contractors.data?.length === 0 ? <p className="warn">Add a contractor first (see <Link to="/contractors">Contractors</Link>).</p> : (
          <form onSubmit={onSubmit} className="card row">
            <Field label="Contractor">
              <select required value={f.contractorId} onChange={(e) => setF({ ...f, contractorId: e.target.value })}>
                <option value="">—</option>{contractors.data?.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            </Field>
            <Field label="Code"><input required maxLength={40} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} size={10} /></Field>
            <Field label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Starts"><input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
            <Field label="Ends"><input type="date" required value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
            <Field label="Status">
              <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as ContractStatus })}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            </Field>
            <button type="submit" disabled={create.isPending}>Add contract</button>
            <ErrorMsg error={create.error} />
          </form>
        )
      )}
    </div>
  );
}

export function WorkOrdersTab({ client }: { client: Client }) {
  return (
    <div className="stack">
      <p className="muted">Work orders are generated from contract lines. Costs are in {client.currency}.</p>
      <WorkOrdersPanel clientId={client.id} currency={client.currency} />
    </div>
  );
}

// ------------------------------------------------------------------ one contract
export function ContractPage() {
  const { contractId = '' } = useParams();
  const navigate = useNavigate();
  const { canWrite, isAdmin } = useAuth();
  const [editing, setEditing] = useState(false);
  const contract = useQuery({ queryKey: ['contract', contractId], queryFn: () => api.get<ContractDetail>(`/contracts/${contractId}`) });
  const clientId = contract.data?.client_id;
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<Client[]>('/clients') });
  const sites = useQuery({ queryKey: ['sites', clientId, ''], enabled: !!clientId, queryFn: () => api.get<Site[]>(`/clients/${clientId}/sites`) });
  const currency = clients.data?.find((c) => c.id === clientId)?.currency ?? 'NZD';
  const remove = useRemove(REFRESH);
  const setStatus = usePatch(REFRESH, () => undefined);
  const k = contract.data;

  return (
    <section className="stack">
      {clientId && <p><Link to={`/clients/${clientId}/contracts`}>← Contracts</Link></p>}
      <Loading query={contract} />
      {k && (
        <>
          <div className="row">
            <h1>{k.code} · {k.name}</h1>
            <span className={`badge ${k.status}`}>{k.status}</span>
            <RowActions canEdit={canWrite} canDelete={isAdmin} busy={remove.isPending} onEdit={() => setEditing(true)}
              onDelete={() => confirmDelete(`contract ${k.code}`, 'Its lines and work orders are deleted with it. ') &&
                remove.mutate(`/contracts/${k.id}`, { onSuccess: () => navigate(`/clients/${k.client_id}/contracts`) })} />
          </div>
          <p className="muted">{k.contractor_name} · {k.start_date} to {k.end_date}{k.notes ? ` · ${k.notes}` : ''}</p>
          <ErrorMsg error={remove.error} />
          {canWrite && (
            <div className="row">
              <Field label="Status" hint={k.status === 'active' ? undefined : 'Set to active to generate work orders'}>
                <select aria-label="Contract status" value={k.status} disabled={setStatus.isPending}
                  onChange={(e) => setStatus.mutate({ path: `/contracts/${k.id}`, body: { status: e.target.value } })}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
              <ErrorMsg error={setStatus.error} />
            </div>
          )}
          {editing && <div className="card"><ContractEdit contract={k} onDone={() => setEditing(false)} /></div>}

          <h2>Lines</h2>
          <LinesTable contract={k} currency={currency} />
          {canWrite && <AddLine contract={k} sites={sites.data ?? []} />}

          {canWrite && <GeneratePanel contract={k} />}

          <h2>Work orders</h2>
          {Object.keys(k.workOrderCounts).length > 0 && (
            <p className="muted">{Object.entries(k.workOrderCounts).map(([s, n]) => `${n} ${s.replace('_', ' ')}`).join(' · ')}</p>
          )}
          {clientId && <WorkOrdersPanel clientId={clientId} currency={currency} contractId={k.id} />}
        </>
      )}
    </section>
  );
}

function ContractEdit({ contract, onDone }: { contract: ContractDetail; onDone: () => void }) {
  const contractors = useQuery({ queryKey: ['contractors'], queryFn: () => api.get<Contractor[]>('/contractors') });
  const [f, setF] = useState({
    code: contract.code, name: contract.name, contractorId: contract.contractor_id, startDate: contract.start_date, endDate: contract.end_date, notes: contract.notes ?? '',
  });
  const save = usePatch(REFRESH, onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ path: `/contracts/${contract.id}`, body: { ...f, code: f.code.trim(), name: f.name.trim(), notes: f.notes.trim() || null } });
  };
  return (
    <form onSubmit={submit} className="row" aria-label={`Edit contract ${contract.code}`}>
      <Field label="Code"><input required maxLength={40} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} size={10} /></Field>
      <Field label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Contractor">
        <select value={f.contractorId} onChange={(e) => setF({ ...f, contractorId: e.target.value })}>
          {contractors.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Starts"><input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
      <Field label="Ends"><input type="date" required value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
      <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <button type="submit" disabled={save.isPending}>Save</button>
      <button type="button" className="link" onClick={onDone}>Cancel</button>
      <ErrorMsg error={save.error} />
    </form>
  );
}

// ------------------------------------------------------------------ lines
const targetOf = (l: ContractLine) => (l.asset_id ? `${l.asset_name ?? 'Asset'}${l.asset_site_code ? ` (${l.asset_site_code})` : ''}` : `${l.site_code ?? ''} · ${l.site_name ?? ''}`);

function LinesTable({ contract, currency }: { contract: ContractDetail; currency: string }) {
  const { canWrite, isAdmin } = useAuth();
  const [editing, setEditing] = useState<string | null>(null);
  const remove = useRemove(REFRESH);
  if (contract.lines.length === 0) return <p className="muted">No lines yet. Add what is done, where and how often.</p>;
  return (
    <>
      <table className="table">
        <thead><tr><th>What</th><th>Where</th><th>How often</th><th>First due</th><th>Cost each</th><th /></tr></thead>
        <tbody>
          {contract.lines.map((l) => editing === l.id ? (
            <tr key={l.id}><td colSpan={6} className="edit-cell"><LineEdit line={l} contract={contract} onDone={() => setEditing(null)} /></td></tr>
          ) : (
            <tr key={l.id}>
              <td>{l.description}</td><td>{targetOf(l)}</td><td>{describeFrequency(l.frequency_interval, l.frequency_unit)}</td><td>{l.first_due_date}</td>
              <td>{money(Number(l.cost_per_occurrence), currency)}</td>
              <td><RowActions canEdit={canWrite} canDelete={isAdmin} busy={remove.isPending} onEdit={() => setEditing(l.id)}
                onDelete={() => confirmDelete(`line “${l.description}”`, 'Work orders already generated from it stay. ') && remove.mutate(`/contract-lines/${l.id}`)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorMsg error={remove.error} />
    </>
  );
}

function ScheduleFields({ f, setF }: { f: { interval: string; unit: Frequency; first: string; cost: string }; setF: (v: typeof f) => void }) {
  return (
    <>
      <Field label="Every"><input type="number" required min={1} max={120} step={1} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })} size={4} /></Field>
      <Field label="Unit">
        <select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value as Frequency })}>
          {(['day', 'week', 'month', 'year'] as Frequency[]).map((u) => <option key={u} value={u}>{u}(s)</option>)}
        </select>
      </Field>
      <Field label="First due"><input type="date" required value={f.first} onChange={(e) => setF({ ...f, first: e.target.value })} /></Field>
      <Field label="Cost each visit"><input type="number" min={0} step="0.01" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} size={9} /></Field>
    </>
  );
}

function LineEdit({ line, contract, onDone }: { line: ContractLine; contract: ContractDetail; onDone: () => void }) {
  const [description, setDescription] = useState(line.description);
  const [s, setS] = useState({ interval: String(line.frequency_interval), unit: line.frequency_unit, first: line.first_due_date, cost: String(Number(line.cost_per_occurrence)) });
  const save = usePatch(REFRESH, onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ path: `/contract-lines/${line.id}`, body: { description: description.trim(), frequencyInterval: Number(s.interval), frequencyUnit: s.unit, firstDueDate: s.first, costPerOccurrence: num(s.cost) ?? 0 } });
  };
  return (
    <form onSubmit={submit} className="row" aria-label={`Edit line ${line.description}`}>
      <Field label="What"><input required value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <ScheduleFields f={s} setF={setS} />
      <button type="submit" disabled={save.isPending}>Save</button>
      <button type="button" className="link" onClick={onDone}>Cancel</button>
      <p className="muted">Changes affect work orders generated from now on, not ones already created. Contract runs {contract.start_date} to {contract.end_date}.</p>
      <ErrorMsg error={save.error} />
    </form>
  );
}

function AddLine({ contract, sites }: { contract: ContractDetail; sites: Site[] }) {
  const qc = useQueryClient();
  const today = todayLocal();
  const firstDefault = today >= contract.start_date && today <= contract.end_date ? today : contract.start_date;
  const [kind, setKind] = useState<'site' | 'asset'>('site');
  const [siteId, setSiteId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [description, setDescription] = useState('');
  const [s, setS] = useState({ interval: '1', unit: 'month' as Frequency, first: firstDefault, cost: '0' });
  const assets = useQuery({ queryKey: ['assets', siteId], enabled: kind === 'asset' && !!siteId, queryFn: () => api.get<Asset[]>(`/sites/${siteId}/assets`) });
  const add = useMutation({
    mutationFn: () => api.post(`/contracts/${contract.id}/lines`, {
      ...(kind === 'site' ? { siteId } : { assetId }), description: description.trim(), frequencyInterval: Number(s.interval), frequencyUnit: s.unit, firstDueDate: s.first, costPerOccurrence: num(s.cost) ?? 0,
    }),
    onSuccess: () => { setDescription(''); for (const queryKey of REFRESH) qc.invalidateQueries({ queryKey }); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  return (
    <form onSubmit={submit} className="card row" aria-label="Add line">
      <Field label="Applies to">
        <select aria-label="Line applies to" value={kind} onChange={(e) => { setKind(e.target.value as 'site' | 'asset'); setAssetId(''); }}>
          <option value="site">A site</option><option value="asset">An asset</option>
        </select>
      </Field>
      <Field label="Site">
        <select aria-label="Line site" required value={siteId} onChange={(e) => { setSiteId(e.target.value); setAssetId(''); }}>
          <option value="">—</option>{sites.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
        </select>
      </Field>
      {kind === 'asset' && (
        <Field label="Asset">
          <select aria-label="Line asset" required value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">—</option>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="What is done"><input required value={description} placeholder="e.g. Mow grounds" onChange={(e) => setDescription(e.target.value)} /></Field>
      <ScheduleFields f={s} setF={setS} />
      <button type="submit" disabled={add.isPending}>Add line</button>
      <ErrorMsg error={add.error} />
    </form>
  );
}

// ------------------------------------------------------------------ generate work orders
function GeneratePanel({ contract }: { contract: ContractDetail }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ from: todayLocal(), through: addDays(todayLocal(), 90) });
  const [result, setResult] = useState<GenerateResult | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<GenerateResult>(`/contracts/${contract.id}/generate`, { through: f.through, ...(f.from ? { from: f.from } : {}), dryRun }),
    onSuccess: (r) => { setResult(r); if (!r.dryRun) for (const queryKey of [['work-orders'], ...REFRESH]) qc.invalidateQueries({ queryKey }); },
  });
  const ready = contract.status === 'active' && contract.lines.length > 0;
  return (
    <div className="card stack">
      <h2>Generate work orders</h2>
      <p className="muted">Creates the work orders that fall due in the window. Safe to repeat: ones that already exist are never duplicated, and ones you deleted are not brought back.</p>
      {!ready && <p className="warn">{contract.lines.length === 0 ? 'Add at least one line first.' : 'The contract must be active to generate work orders.'}</p>}
      <div className="row">
        <Field label="From" hint="Blank = from each line's first due date"><input type="date" value={f.from} onChange={(e) => { setF({ ...f, from: e.target.value }); setResult(null); }} /></Field>
        <Field label="Through"><input type="date" required value={f.through} onChange={(e) => { setF({ ...f, through: e.target.value }); setResult(null); }} /></Field>
        <button type="button" disabled={!ready || run.isPending || !f.through} onClick={() => run.mutate(true)}>Preview</button>
        <button type="button" disabled={!ready || run.isPending || !f.through} onClick={() => run.mutate(false)}>Create work orders</button>
      </div>
      <ErrorMsg error={run.error} />
      {result && (
        <div role="status" className={result.dryRun ? 'warn' : 'ok'}>
          {result.dryRun
            ? <>Would create {result.wouldCreate} work order{result.wouldCreate === 1 ? '' : 's'}.</>
            : <>Created {result.created} work order{result.created === 1 ? '' : 's'}.</>}
          {' '}{result.existing > 0 && `${result.existing} already exist${result.existing === 1 ? 's' : ''}. `}
          {result.deletedSkipped > 0 && `${result.deletedSkipped} were deleted and are not recreated. `}
          {result.dryRun && result.sample.length > 0 && (
            <ul>
              {result.sample.map((x) => <li key={`${x.lineId}${x.dueDate}`}>{x.dueDate} · {x.description}</li>)}
              {result.wouldCreate > result.sample.length && <li>…and {result.wouldCreate - result.sample.length} more</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
