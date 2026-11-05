import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { TaxCode, api } from '../api';
import { useAuth } from '../auth';
import { usePatch, useRemove } from '../hooks';
import { ErrorMsg, Field, Loading, RowActions, confirmDelete } from '../ui';

/** The accounting systems we can export to, and what each calls a tax code. More are added as exports are built. */
const SYSTEMS = [['xero', 'Xero tax type'], ['myob', 'MYOB tax code'], ['sap', 'SAP tax code']] as const;
const blank = { code: '', name: '', rate: '', xero: '', myob: '', sap: '' };
type Form = typeof blank;

/** Other systems' entries on an existing code are kept; blank boxes remove that system's entry. */
function externalCodes(f: Form, existing: Record<string, string> = {}) {
  const out = { ...existing };
  for (const [key] of SYSTEMS) {
    const v = f[key].trim();
    if (v) out[key] = v; else delete out[key];
  }
  return out;
}
const toBody = (f: Form, existing?: Record<string, string>) => ({ code: f.code.trim(), name: f.name.trim(), rate: Number(f.rate), externalCodes: externalCodes(f, existing) });

export function TaxCodes() {
  const { canWrite, isAdmin } = useAuth();
  const qc = useQueryClient();
  const codes = useQuery({ queryKey: ['tax-codes'], queryFn: () => api.get<TaxCode[]>('/tax-codes') });
  const [editing, setEditing] = useState<string | null>(null);
  const [f, setF] = useState(blank);
  const remove = useRemove([['tax-codes']]);
  const create = useMutation({
    mutationFn: () => api.post('/tax-codes', toBody(f)),
    onSuccess: () => { setF(blank); qc.invalidateQueries({ queryKey: ['tax-codes'] }); },
  });
  const onSubmit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };

  return (
    <section className="stack">
      <h1>Tax codes</h1>
      <p className="muted">
        The rates used on contractor invoices, and what your accounting systems call each one so exports line up. Changing a rate does not change invoices already recorded.
      </p>
      <Loading query={codes} />
      {codes.data?.length === 0 && <p className="muted">No tax codes yet. Add one for each rate you are invoiced, for example GST 15%, and one at 0% for zero-rated work.</p>}
      <table className="table">
        <thead><tr><th>Code</th><th>Name</th><th>Rate</th>{SYSTEMS.map(([k, label]) => <th key={k}>{label}</th>)}<th /></tr></thead>
        <tbody>
          {codes.data?.map((t) => editing === t.id ? (
            <tr key={t.id}><td colSpan={7} className="edit-cell"><TaxEdit code={t} onDone={() => setEditing(null)} /></td></tr>
          ) : (
            <tr key={t.id}>
              <td>{t.code}</td><td>{t.name}</td><td>{Number(t.rate)}%</td>
              {SYSTEMS.map(([k]) => <td key={k}>{t.external_codes[k]}</td>)}
              <td><RowActions canEdit={canWrite} canDelete={isAdmin} busy={remove.isPending} onEdit={() => setEditing(t.id)}
                onDelete={() => confirmDelete(`tax code “${t.code}”`) && remove.mutate(`/tax-codes/${t.id}`)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorMsg error={remove.error} />
      {canWrite && (
        <form onSubmit={onSubmit} className="card row" aria-label="Add tax code">
          <TaxFields f={f} setF={setF} />
          <button type="submit" disabled={create.isPending}>Add tax code</button>
          <ErrorMsg error={create.error} />
        </form>
      )}
    </section>
  );
}

function TaxFields({ f, setF }: { f: Form; setF: (v: Form) => void }) {
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <Field label="Code"><input required value={f.code} onChange={set('code')} size={8} /></Field>
      <Field label="Name"><input required value={f.name} onChange={set('name')} /></Field>
      <Field label="Rate %"><input required type="number" min="0" max="100" step="any" value={f.rate} onChange={set('rate')} size={6} /></Field>
      {SYSTEMS.map(([k, label]) => <Field key={k} label={label}><input value={f[k]} onChange={set(k)} size={10} /></Field>)}
    </>
  );
}

function TaxEdit({ code, onDone }: { code: TaxCode; onDone: () => void }) {
  const [f, setF] = useState<Form>({
    code: code.code, name: code.name, rate: String(Number(code.rate)), xero: code.external_codes.xero ?? '', myob: code.external_codes.myob ?? '', sap: code.external_codes.sap ?? '',
  });
  const save = usePatch([['tax-codes']], onDone);
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate({ path: `/tax-codes/${code.id}`, body: toBody(f, code.external_codes) }); };
  return (
    <form onSubmit={submit} className="row" aria-label={`Edit tax code ${code.code}`}>
      <TaxFields f={f} setF={setF} />
      <button type="submit" disabled={save.isPending}>Save</button>
      <button type="button" className="link" onClick={onDone}>Cancel</button>
      <ErrorMsg error={save.error} />
    </form>
  );
}
