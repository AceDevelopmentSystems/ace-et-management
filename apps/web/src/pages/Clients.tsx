import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Client, api } from '../api';
import { useAuth } from '../auth';
import { usePatch, useRemove } from '../hooks';
import { ErrorMsg, Field, Loading, RowActions, confirmDelete } from '../ui';

export function Clients() {
  const { canWrite, isAdmin } = useAuth();
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<Client[]>('/clients') });
  const [f, setF] = useState({ name: '', code: '', currency: 'NZD' });
  const [editing, setEditing] = useState<string | null>(null);
  const remove = useRemove([['clients']]);
  const create = useMutation({
    mutationFn: () => api.post<Client>('/clients', { name: f.name, code: f.code || undefined, currency: f.currency.toUpperCase() }),
    onSuccess: () => { setF({ name: '', code: '', currency: f.currency }); qc.invalidateQueries({ queryKey: ['clients'] }); },
  });
  const onSubmit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };

  return (
    <section className="stack">
      <h1>Clients</h1>
      <Loading query={clients} />
      {clients.data?.length === 0 && <p className="muted">No clients yet.{canWrite ? ' Add the first one below.' : ''}</p>}
      <ul className="list">
        {clients.data?.map((c) => (
          <li key={c.id}>
            {editing === c.id ? <ClientEdit client={c} onDone={() => setEditing(null)} /> : (
              <>
                <Link to={`/clients/${c.id}`}>{c.name}</Link> <span className="muted">{c.code ?? ''} {c.currency}</span>
                <RowActions canEdit={canWrite} canDelete={isAdmin} busy={remove.isPending} onEdit={() => setEditing(c.id)}
                  onDelete={() => confirmDelete(`client “${c.name}”`, 'Its regions, sites, assets and saved scenarios are deleted with it. ') && remove.mutate(`/clients/${c.id}`)} />
              </>
            )}
          </li>
        ))}
      </ul>
      <ErrorMsg error={remove.error} />
      {canWrite && (
        <form onSubmit={onSubmit} className="card row">
          <Field label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
          <Field label="Currency"><input required minLength={3} maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} size={4} /></Field>
          <button type="submit" disabled={create.isPending}>Add client</button>
          <ErrorMsg error={create.error} />
        </form>
      )}
    </section>
  );
}

function ClientEdit({ client, onDone }: { client: Client; onDone: () => void }) {
  const [f, setF] = useState({ name: client.name, code: client.code ?? '', currency: client.currency });
  const save = usePatch([['clients']], onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ path: `/clients/${client.id}`, body: { name: f.name.trim(), code: f.code.trim() || null, currency: f.currency.trim().toUpperCase() } });
  };
  return (
    <form onSubmit={submit} className="row" aria-label={`Edit ${client.name}`}>
      <Field label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} size={8} /></Field>
      <Field label="Currency"><input required minLength={3} maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} size={4} /></Field>
      <button type="submit" disabled={save.isPending}>Save</button>
      <button type="button" className="link" onClick={onDone}>Cancel</button>
      <ErrorMsg error={save.error} />
    </form>
  );
}
