import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Contractor, api } from '../api';
import { useAuth } from '../auth';
import { usePatch, useRemove } from '../hooks';
import { ErrorMsg, Field, Loading, RowActions, confirmDelete } from '../ui';

const blank = { name: '', contactName: '', email: '', phone: '', notes: '' };

export function Contractors() {
  const { canWrite, isAdmin } = useAuth();
  const qc = useQueryClient();
  const contractors = useQuery({ queryKey: ['contractors'], queryFn: () => api.get<Contractor[]>('/contractors') });
  const [editing, setEditing] = useState<string | null>(null);
  const [f, setF] = useState(blank);
  const remove = useRemove([['contractors']]);
  const create = useMutation({
    mutationFn: () => api.post('/contractors', body(f)),
    onSuccess: () => { setF(blank); qc.invalidateQueries({ queryKey: ['contractors'] }); },
  });
  const onSubmit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };

  return (
    <section className="stack">
      <h1>Contractors</h1>
      <p className="muted">The firms that carry out contracted work. They are shared across all your clients.</p>
      <Loading query={contractors} />
      {contractors.data?.length === 0 && <p className="muted">No contractors yet.</p>}
      <table className="table">
        <thead><tr><th>Name</th><th>Contact</th><th>Email</th><th>Phone</th><th>Contracts</th><th /></tr></thead>
        <tbody>
          {contractors.data?.map((k) => editing === k.id ? (
            <tr key={k.id}><td colSpan={6} className="edit-cell"><ContractorEdit contractor={k} onDone={() => setEditing(null)} /></td></tr>
          ) : (
            <tr key={k.id}>
              <td>{k.name}</td><td>{k.contact_name}</td><td>{k.email}</td><td>{k.phone}</td><td>{k.contract_count}</td>
              <td><RowActions canEdit={canWrite} canDelete={isAdmin} busy={remove.isPending} onEdit={() => setEditing(k.id)}
                onDelete={() => confirmDelete(`contractor “${k.name}”`) && remove.mutate(`/contractors/${k.id}`)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorMsg error={remove.error} />
      {canWrite && (
        <form onSubmit={onSubmit} className="card row">
          <ContractorFields f={f} setF={setF} />
          <button type="submit" disabled={create.isPending}>Add contractor</button>
          <ErrorMsg error={create.error} />
        </form>
      )}
    </section>
  );
}

/** Blank optional fields are sent as null so they clear on update and stay empty on create. */
const body = (f: typeof blank) => ({
  name: f.name.trim(), contactName: f.contactName.trim() || null, email: f.email.trim() || null, phone: f.phone.trim() || null, notes: f.notes.trim() || null,
});

function ContractorFields({ f, setF }: { f: typeof blank; setF: (v: typeof blank) => void }) {
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <Field label="Name"><input required value={f.name} onChange={set('name')} /></Field>
      <Field label="Contact"><input value={f.contactName} onChange={set('contactName')} /></Field>
      <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
      <Field label="Phone"><input value={f.phone} onChange={set('phone')} size={12} /></Field>
      <Field label="Notes"><input value={f.notes} onChange={set('notes')} /></Field>
    </>
  );
}

function ContractorEdit({ contractor, onDone }: { contractor: Contractor; onDone: () => void }) {
  const [f, setF] = useState({
    name: contractor.name, contactName: contractor.contact_name ?? '', email: contractor.email ?? '', phone: contractor.phone ?? '', notes: contractor.notes ?? '',
  });
  const save = usePatch([['contractors']], onDone);
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate({ path: `/contractors/${contractor.id}`, body: body(f) }); };
  return (
    <form onSubmit={submit} className="row" aria-label={`Edit contractor ${contractor.name}`}>
      <ContractorFields f={f} setF={setF} />
      <button type="submit" disabled={save.isPending}>Save</button>
      <button type="button" className="link" onClick={onDone}>Cancel</button>
      <ErrorMsg error={save.error} />
    </form>
  );
}
