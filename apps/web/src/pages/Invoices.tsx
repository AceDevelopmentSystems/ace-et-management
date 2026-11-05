import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Client, ContractSummary, Contractor, InvoiceDetail, InvoiceStatus, InvoiceSummary, TaxCode, WorkOrder, api } from '../api';
import { useAuth } from '../auth';
import { useRemove } from '../hooks';
import { INVOICE_LABEL, InvoiceAction, invoiceActions, money2, priceInvoice, todayLocal } from '../lib';
import { ErrorMsg, Field, Loading, confirmDelete } from '../ui';

const REFRESH = [['invoices'], ['invoice'], ['work-orders']];

/** Shown wherever "paid" appears: this system keeps records and never moves money. */
export const NO_PAYMENTS = 'This system records invoices and exports them to your accounting system. It does not make payments; “paid” only records what your accounting system reports.';

// ------------------------------------------------------------------ list
export function InvoicesTab({ client }: { client: Client }) {
  const { canWrite } = useAuth();
  const [status, setStatus] = useState<'' | InvoiceStatus>('');
  const [contractorId, setContractorId] = useState('');
  const [adding, setAdding] = useState(false);
  const params = new URLSearchParams({ limit: '200' });
  if (status) params.set('status', status);
  if (contractorId) params.set('contractorId', contractorId);
  const contractors = useQuery({ queryKey: ['contractors'], queryFn: () => api.get<Contractor[]>('/contractors') });
  const list = useQuery({
    queryKey: ['invoices', client.id, status, contractorId],
    queryFn: () => api.get<{ items: InvoiceSummary[]; total: number; grossTotal: string }>(`/clients/${client.id}/invoices?${params}`),
  });

  return (
    <div className="stack">
      <p className="muted">{NO_PAYMENTS}</p>
      <div className="row">
        <Field label="Status">
          <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as '' | InvoiceStatus)}>
            <option value="">Any</option>
            {(Object.keys(INVOICE_LABEL) as InvoiceStatus[]).map((s) => <option key={s} value={s}>{INVOICE_LABEL[s]}</option>)}
          </select>
        </Field>
        <Field label="Contractor">
          <select aria-label="Filter by contractor" value={contractorId} onChange={(e) => setContractorId(e.target.value)}>
            <option value="">All contractors</option>
            {contractors.data?.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </Field>
        {canWrite && !adding && <button type="button" onClick={() => setAdding(true)}>New invoice</button>}
      </div>
      {adding && <NewInvoice client={client} onDone={() => setAdding(false)} />}
      <Loading query={list} />
      {list.data && list.data.total === 0 && <p className="muted">No invoices{status || contractorId ? ' match' : ' recorded yet'}.</p>}
      {list.data && list.data.total > 0 && (
        <>
          <table className="table">
            <thead><tr><th>Invoice</th><th>Contractor</th><th>Contract</th><th>Issued</th><th>Due</th><th>Total</th><th>Status</th></tr></thead>
            <tbody>
              {list.data.items.map((i) => (
                <tr key={i.id}>
                  <td><Link to={`/invoices/${i.id}`}>{i.supplier_ref}</Link></td>
                  <td>{i.contractor_name}</td><td>{i.contract_code}</td><td>{i.issue_date}</td><td>{i.due_date}</td>
                  <td>{money2(i.gross, i.currency)}</td>
                  <td><span className={`badge ${i.status}`}>{INVOICE_LABEL[i.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">{list.data.total} invoice{list.data.total === 1 ? '' : 's'} · {money2(list.data.grossTotal, client.currency)} in total</p>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ form (new and edit)
interface FormLine { description: string; quantity: string; unitPrice: string; taxCodeId: string; taxAmount: string; workOrderId: string }
interface FormState {
  contractorId: string; contractId: string; supplierRef: string; issueDate: string; dueDate: string; notes: string; lines: FormLine[];
}
const blankLine = (): FormLine => ({ description: '', quantity: '1', unitPrice: '', taxCodeId: '', taxAmount: '', workOrderId: '' });
const blank = (): FormState => ({ contractorId: '', contractId: '', supplierRef: '', issueDate: todayLocal(), dueDate: '', notes: '', lines: [blankLine()] });

function fromDetail(d: InvoiceDetail): FormState {
  return {
    contractorId: d.contractor_id, contractId: d.contract_id ?? '', supplierRef: d.supplier_ref, issueDate: d.issue_date, dueDate: d.due_date ?? '', notes: d.notes ?? '',
    lines: d.lines.map((l) => ({
      description: l.description, quantity: String(Number(l.quantity)), unitPrice: String(Number(l.unit_price)), taxCodeId: l.tax_code_id ?? '',
      // The stored tax is sent back as stated, so an edit never silently changes it.
      taxAmount: l.tax_amount, workOrderId: l.work_order_id ?? '',
    })),
  };
}

const toBody = (f: FormState) => ({
  contractorId: f.contractorId, contractId: f.contractId || null, supplierRef: f.supplierRef.trim(), issueDate: f.issueDate, dueDate: f.dueDate || null,
  notes: f.notes.trim() || null,
  lines: f.lines.map((l) => ({
    description: l.description.trim(), quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), taxCodeId: l.taxCodeId || null,
    taxAmount: l.taxAmount.trim() === '' ? null : Number(l.taxAmount), workOrderId: l.workOrderId || null,
  })),
});

function InvoiceForm({ client, initial, label, busy, error, onSubmit, onCancel }: {
  client: Client; initial: FormState; label: string; busy: boolean; error: unknown; onSubmit: (body: ReturnType<typeof toBody>) => void; onCancel: () => void;
}) {
  const [f, setF] = useState(initial);
  const contractors = useQuery({ queryKey: ['contractors'], queryFn: () => api.get<Contractor[]>('/contractors') });
  const contracts = useQuery({ queryKey: ['contracts', client.id], queryFn: () => api.get<ContractSummary[]>(`/clients/${client.id}/contracts`) });
  const taxCodes = useQuery({ queryKey: ['tax-codes'], queryFn: () => api.get<TaxCode[]>('/tax-codes') });
  const workOrders = useQuery({
    queryKey: ['work-orders', client.id, f.contractId, 'for-invoice'],
    queryFn: () => api.get<{ items: WorkOrder[] }>(`/clients/${client.id}/work-orders?limit=500${f.contractId ? `&contractId=${f.contractId}` : ''}`),
  });
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF({ ...f, [k]: v });
  const setLine = (i: number, patch: Partial<FormLine>) => setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const rates = new Map(taxCodes.data?.map((t) => [t.id, Number(t.rate)]));
  const sum = priceInvoice(f.lines.map((l) => ({
    quantity: Number(l.quantity) || 0, unitPrice: Number(l.unitPrice) || 0,
    taxAmount: l.taxAmount.trim() === '' ? null : Number(l.taxAmount) || 0, rate: l.taxCodeId ? rates.get(l.taxCodeId) ?? null : null,
  })));
  const contractsOf = contracts.data?.filter((k) => !f.contractorId || k.contractor_id === f.contractorId) ?? [];
  const submit = (e: FormEvent) => { e.preventDefault(); onSubmit(toBody(f)); };

  return (
    <form onSubmit={submit} className="card stack" aria-label={label}>
      <div className="row">
        <Field label="Contractor">
          <select required value={f.contractorId} onChange={(e) => setF({ ...f, contractorId: e.target.value, contractId: '' })}>
            <option value="">Choose…</option>
            {contractors.data?.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </Field>
        <Field label="Contract">
          <select value={f.contractId} onChange={(e) => set('contractId', e.target.value)}>
            <option value="">None</option>
            {contractsOf.map((k) => <option key={k.id} value={k.id}>{k.code} · {k.name}</option>)}
          </select>
        </Field>
        <Field label="Their invoice number"><input required value={f.supplierRef} onChange={(e) => set('supplierRef', e.target.value)} /></Field>
        <Field label="Issued"><input required type="date" value={f.issueDate} onChange={(e) => set('issueDate', e.target.value)} /></Field>
        <Field label="Due"><input type="date" value={f.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></Field>
        <Field label="Notes"><input value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
      <div className="scroll"><table className="table">
        <thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Tax code</th><th>Tax (if stated)</th><th>Work order</th><th /></tr></thead>
        <tbody>
          {f.lines.map((l, i) => (
            <tr key={i}>
              <td><input aria-label={`Line ${i + 1} description`} required value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
              <td><input aria-label={`Line ${i + 1} quantity`} required type="number" min="0" step="any" size={5} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
              <td><input aria-label={`Line ${i + 1} unit price`} required type="number" min="0" step="any" size={8} value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} /></td>
              <td>
                <select aria-label={`Line ${i + 1} tax code`} value={l.taxCodeId} onChange={(e) => setLine(i, { taxCodeId: e.target.value })}>
                  <option value="">No tax</option>
                  {taxCodes.data?.map((t) => <option key={t.id} value={t.id}>{t.code} ({Number(t.rate)}%)</option>)}
                </select>
              </td>
              <td><input aria-label={`Line ${i + 1} tax amount`} type="number" min="0" step="any" size={7} placeholder="from code" value={l.taxAmount} onChange={(e) => setLine(i, { taxAmount: e.target.value })} /></td>
              <td>
                <select aria-label={`Line ${i + 1} work order`} value={l.workOrderId} onChange={(e) => setLine(i, { workOrderId: e.target.value })}>
                  <option value="">None</option>
                  {workOrders.data?.items.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.title} · {w.site_code}</option>)}
                </select>
              </td>
              <td>{f.lines.length > 1 && <button type="button" className="link danger" onClick={() => set('lines', f.lines.filter((_, j) => j !== i))}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="row">
        <button type="button" onClick={() => set('lines', [...f.lines, blankLine()])}>Add line</button>
        <span className="muted">
          Net {money2(sum.net, client.currency)} · Tax {money2(sum.tax, client.currency)} · <strong>Total {money2(sum.gross, client.currency)}</strong> (confirmed when saved)
        </span>
      </div>
      <div className="row">
        <button type="submit" disabled={busy}>{label}</button>
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </div>
      <ErrorMsg error={error} />
    </form>
  );
}

function NewInvoice({ client, onDone }: { client: Client; onDone: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const create = useMutation({
    mutationFn: (body: ReturnType<typeof toBody>) => api.post<{ id: string }>(`/clients/${client.id}/invoices`, body),
    onSuccess: (r) => { for (const queryKey of REFRESH) qc.invalidateQueries({ queryKey }); onDone(); nav(`/invoices/${r.id}`); },
  });
  return <InvoiceForm client={client} initial={blank()} label="Record invoice" busy={create.isPending} error={create.error} onSubmit={(b) => create.mutate(b)} onCancel={onDone} />;
}

// ------------------------------------------------------------------ one invoice
export function InvoicePage() {
  const { invoiceId = '' } = useParams();
  const { canWrite, isAdmin } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState<InvoiceAction | null>(null);
  const [reason, setReason] = useState('');
  const [paidOn, setPaidOn] = useState(todayLocal());
  const invoice = useQuery({ queryKey: ['invoice', invoiceId], queryFn: () => api.get<InvoiceDetail>(`/invoices/${invoiceId}`) });
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<Client[]>('/clients') });
  const inv = invoice.data;
  const client = clients.data?.find((c) => c.id === inv?.client_id);

  const refresh = () => { for (const queryKey of REFRESH) qc.invalidateQueries({ queryKey }); };
  const move = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/invoices/${invoiceId}/status`, body),
    onSuccess: () => { refresh(); setAsking(null); setReason(''); },
  });
  const save = useMutation({
    mutationFn: (body: ReturnType<typeof toBody>) => api.patch(`/invoices/${invoiceId}`, body),
    onSuccess: () => { refresh(); setEditing(false); },
  });
  const remove = useRemove(REFRESH);
  const warnings = inv?.warnings ?? [];

  const run = (a: InvoiceAction) => {
    // Approving past matching warnings needs a reason, so it asks like the other moves that need one.
    if (a.to === 'approved' && warnings.length) setAsking({ ...a, ask: 'reason' });
    else if (a.ask) setAsking(a);
    else move.mutate({ status: a.to });
  };
  const confirm = (e: FormEvent) => {
    e.preventDefault();
    if (!asking) return;
    if (asking.ask === 'paidOn') move.mutate({ status: 'paid', paidOn });
    else if (asking.to === 'approved') move.mutate({ status: 'approved', override: true, reason: reason.trim() });
    else move.mutate({ status: asking.to, reason: reason.trim() });
  };

  return (
    <section className="stack">
      <p>{client ? <Link to={`/clients/${client.id}/invoices`}>← {client.name} invoices</Link> : <Link to="/">← Clients</Link>}</p>
      <Loading query={invoice} />
      {inv && (
        <>
          <h1>Invoice {inv.supplier_ref} <span className={`badge ${inv.status}`}>{INVOICE_LABEL[inv.status]}</span></h1>
          <p className="muted">
            {inv.contractor_name}{inv.contract_code ? ` · contract ${inv.contract_code}` : ''} · issued {inv.issue_date}{inv.due_date ? ` · due ${inv.due_date}` : ''}
            {inv.paid_on ? ` · recorded as paid ${inv.paid_on}` : ''}
          </p>
          {inv.notes && <p>{inv.notes}</p>}
          {inv.override_reason && <p className="muted">Approved despite warnings: {inv.override_reason}</p>}
          {(inv.status === 'paid' || inv.status === 'exported' || inv.status === 'approved') && <p className="muted">{NO_PAYMENTS}</p>}

          {warnings.length > 0 && (
            <div className="card" role="region" aria-label="Matching warnings">
              <strong className="warn">{inv.status === 'received' || inv.status === 'disputed' ? 'Check before approving' : 'Matching warnings'}</strong>
              <ul>{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
            </div>
          )}

          {editing && client ? (
            <InvoiceForm client={client} initial={fromDetail(inv)} label="Save changes" busy={save.isPending} error={save.error}
              onSubmit={(b) => save.mutate(b)} onCancel={() => setEditing(false)} />
          ) : (
            <div className="scroll"><table className="table">
              <thead><tr><th>#</th><th>Description</th><th>Qty</th><th>Unit price</th><th>Net</th><th>Tax</th><th>Work order</th></tr></thead>
              <tbody>
                {inv.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.position}</td><td>{l.description}</td><td>{Number(l.quantity)}</td><td>{money2(l.unit_price, inv.currency)}</td>
                    <td>{money2(l.net, inv.currency)}</td><td>{money2(l.tax_amount, inv.currency)}{l.tax_code ? <span className="muted"> {l.tax_code}</span> : null}</td>
                    <td>{l.work_order_code}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={4} /><td>{money2(inv.net, inv.currency)}</td><td>{money2(inv.tax, inv.currency)}</td><td><strong>Total {money2(inv.gross, inv.currency)}</strong></td></tr>
              </tfoot>
            </table></div>
          )}

          {canWrite && !editing && (
            <div className="row">
              {invoiceActions(inv.status).map((a) => (
                <button key={a.to} type="button" disabled={move.isPending} onClick={() => run(a)}>
                  {a.to === 'approved' && warnings.length ? 'Approve anyway…' : a.label}
                </button>
              ))}
              {(inv.status === 'received' || inv.status === 'disputed') && <button type="button" onClick={() => setEditing(true)}>Edit</button>}
              {isAdmin && ['received', 'disputed', 'rejected'].includes(inv.status) && (
                <button type="button" className="link danger" disabled={remove.isPending}
                  onClick={() => confirmDelete(`invoice ${inv.supplier_ref}`) && remove.mutate(`/invoices/${invoiceId}`, { onSuccess: () => nav(`/clients/${inv.client_id}/invoices`) })}>Delete</button>
              )}
            </div>
          )}
          {asking && (
            <form onSubmit={confirm} className="card row" aria-label={asking.label.replace('…', '')}>
              {asking.ask === 'paidOn' ? (
                <Field label="Date paid" hint="As reported by your accounting system. Nothing is paid from here."><input required type="date" max={todayLocal()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
              ) : (
                <Field label={asking.to === 'approved' ? 'Why approve despite the warnings?' : 'Reason'}><input required value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              )}
              <button type="submit" disabled={move.isPending}>Confirm</button>
              <button type="button" className="link" onClick={() => setAsking(null)}>Cancel</button>
            </form>
          )}
          <ErrorMsg error={move.error ?? save.error ?? remove.error} />
        </>
      )}
    </section>
  );
}
