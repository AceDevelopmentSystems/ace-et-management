import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Site, WorkOrder, WorkOrderStatus, api } from '../api';
import { useAuth } from '../auth';
import { usePatch, useRemove } from '../hooks';
import { STATUS_LABEL, isOverdue, money, num, statusActions, todayLocal } from '../lib';
import { ErrorMsg, Field, Loading, RowActions, confirmDelete } from '../ui';

const PAGE = 50;
const REFRESH = [['work-orders'], ['contracts'], ['contract']];

/** Work orders for a client, or for one contract. Filters, paging, status moves, completion details and editing. */
export function WorkOrdersPanel({ clientId, currency, contractId }: { clientId: string; currency: string; contractId?: string }) {
  const { canWrite, isAdmin } = useAuth();
  const qc = useQueryClient();
  const [filters, setFilters] = useState({ status: '' as '' | WorkOrderStatus, overdue: false, from: '', to: '', siteId: '' });
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<{ id: string; mode: 'complete' | 'edit' } | null>(null);
  const setFilter = <K extends keyof typeof filters>(k: K, v: (typeof filters)[K]) => { setFilters({ ...filters, [k]: v }); setPage(0); };

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
  if (filters.status) params.set('status', filters.status);
  if (filters.overdue) params.set('overdue', 'true');
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.siteId) params.set('siteId', filters.siteId);
  if (contractId) params.set('contractId', contractId);

  const sites = useQuery({ queryKey: ['sites', clientId, ''], queryFn: () => api.get<Site[]>(`/clients/${clientId}/sites`) });
  const list = useQuery({
    queryKey: ['work-orders', clientId, contractId ?? '', filters, page],
    queryFn: () => api.get<{ items: WorkOrder[]; total: number }>(`/clients/${clientId}/work-orders?${params}`),
  });
  const change = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.post(`/work-orders/${id}/status`, body),
    onSuccess: () => { for (const queryKey of REFRESH) qc.invalidateQueries({ queryKey }); setOpen(null); },
  });
  const remove = useRemove(REFRESH);

  const total = list.data?.total ?? 0;
  const first = total === 0 ? 0 : page * PAGE + 1;
  const last = Math.min(total, (page + 1) * PAGE);

  return (
    <div className="stack">
      <div className="row">
        <Field label="Status">
          <select aria-label="Filter by status" value={filters.status} onChange={(e) => setFilter('status', e.target.value as '' | WorkOrderStatus)}>
            <option value="">Any</option>
            {(Object.keys(STATUS_LABEL) as WorkOrderStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </Field>
        {!contractId && (
          <Field label="Site">
            <select aria-label="Filter by site" value={filters.siteId} onChange={(e) => setFilter('siteId', e.target.value)}>
              <option value="">All sites</option>
              {sites.data?.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Due from"><input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} /></Field>
        <Field label="Due to"><input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={filters.overdue} onChange={(e) => setFilter('overdue', e.target.checked)} /> Overdue only</label>
      </div>

      <Loading query={list} />
      {list.data && total === 0 && <p className="muted">No work orders match.{contractId ? ' Generate them from the contract’s lines above.' : ''}</p>}
      {list.data && total > 0 && (
        <table className="table">
          <thead><tr><th>Code</th><th>Due</th><th>Work</th><th>Contractor</th><th>Cost</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.data.items.map((w) => (
              <WorkOrderRows key={w.id} w={w} currency={currency} canWrite={canWrite} isAdmin={isAdmin} open={open?.id === w.id ? open.mode : null}
                busy={change.isPending || remove.isPending} setOpen={(mode) => setOpen(mode ? { id: w.id, mode } : null)}
                move={(body) => change.mutate({ id: w.id, body })} remove={() => confirmDelete(`work order ${w.code}`) && remove.mutate(`/work-orders/${w.id}`)} />
            ))}
          </tbody>
        </table>
      )}
      <ErrorMsg error={change.error ?? remove.error} />
      {total > PAGE && (
        <div className="row">
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted">{first}–{last} of {total}</span>
          <button type="button" disabled={last >= total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
      {total > 0 && total <= PAGE && <p className="muted">{total} work order{total === 1 ? '' : 's'}</p>}
    </div>
  );
}

function WorkOrderRows({ w, currency, canWrite, isAdmin, open, busy, setOpen, move, remove }: {
  w: WorkOrder; currency: string; canWrite: boolean; isAdmin: boolean; open: 'complete' | 'edit' | null; busy: boolean;
  setOpen: (mode: 'complete' | 'edit' | null) => void; move: (body: Record<string, unknown>) => void; remove: () => void;
}) {
  const late = isOverdue(w);
  return (
    <>
      <tr>
        <td>{w.code}</td>
        <td className={late ? 'error' : undefined} title={late ? 'Overdue' : undefined}>{w.due_date}</td>
        <td>
          {w.title} <span className="muted">· <Link to={`/sites/${w.site_id}`}>{w.site_code}</Link>{w.asset_name ? ` · ${w.asset_name}` : ''}</span>
          {w.notes && <div className="muted">{w.notes}</div>}
        </td>
        <td>{w.contractor_name}</td>
        <td>
          {w.estimated_cost !== null && <div>{money(Number(w.estimated_cost), currency)}</div>}
          {w.actual_cost !== null && <div className="muted">actual {money(Number(w.actual_cost), currency)}</div>}
        </td>
        <td><span className={`badge ${w.status}`}>{STATUS_LABEL[w.status]}</span>{w.completed_on && <div className="muted">{w.completed_on}</div>}</td>
        <td>
          {canWrite && (
            <span className="actions">
              {statusActions(w.status).map((a) => (
                <button key={a.to} type="button" className="link" disabled={busy}
                  onClick={() => (a.needsDetails ? setOpen('complete') : move({ status: a.to }))}>{a.label}</button>
              ))}
            </span>
          )}{' '}
          <RowActions canEdit={canWrite} canDelete={isAdmin} busy={busy} onEdit={() => setOpen('edit')} onDelete={remove} />
        </td>
      </tr>
      {open === 'complete' && <tr><td colSpan={7} className="edit-cell"><CompleteForm w={w} busy={busy} onSubmit={move} onCancel={() => setOpen(null)} /></td></tr>}
      {open === 'edit' && <tr><td colSpan={7} className="edit-cell"><WorkOrderEdit w={w} onDone={() => setOpen(null)} /></td></tr>}
    </>
  );
}

function CompleteForm({ w, busy, onSubmit, onCancel }: { w: WorkOrder; busy: boolean; onSubmit: (body: Record<string, unknown>) => void; onCancel: () => void }) {
  const today = todayLocal();
  const [f, setF] = useState({ completedOn: today, cost: w.actual_cost ?? '', notes: '' });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const cost = num(f.cost);
    onSubmit({ status: 'complete', completedOn: f.completedOn, ...(cost !== undefined ? { actualCost: cost } : {}), ...(f.notes.trim() ? { notes: f.notes.trim() } : {}) });
  };
  return (
    <form onSubmit={submit} className="row" aria-label={`Complete ${w.code}`}>
      <Field label="Completed on"><input type="date" required max={today} value={f.completedOn} onChange={(e) => setF({ ...f, completedOn: e.target.value })} /></Field>
      <Field label="Actual cost" hint="Optional"><input type="number" min={0} step="0.01" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} size={10} /></Field>
      <Field label="Notes" hint="Optional"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <button type="submit" disabled={busy}>Mark complete</button>
      <button type="button" className="link" onClick={onCancel}>Cancel</button>
    </form>
  );
}

function WorkOrderEdit({ w, onDone }: { w: WorkOrder; onDone: () => void }) {
  const [f, setF] = useState({ title: w.title, dueDate: w.due_date, estimate: w.estimated_cost ?? '', notes: w.notes ?? '' });
  const save = usePatch(REFRESH, onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ path: `/work-orders/${w.id}`, body: { title: f.title.trim(), dueDate: f.dueDate, estimatedCost: num(f.estimate) ?? null, notes: f.notes.trim() || null } });
  };
  return (
    <form onSubmit={submit} className="row" aria-label={`Edit ${w.code}`}>
      <Field label="Title"><input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Due"><input type="date" required value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
      <Field label="Estimate"><input type="number" min={0} step="0.01" value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value })} size={10} /></Field>
      <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <button type="submit" disabled={save.isPending}>Save</button>
      <button type="button" className="link" onClick={onDone}>Cancel</button>
      <ErrorMsg error={save.error} />
    </form>
  );
}
