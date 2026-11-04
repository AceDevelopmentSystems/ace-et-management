import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Client, api } from '../api';
import { useAuth } from '../auth';
import { ErrorMsg, Field, Loading } from '../ui';

export function Clients() {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<Client[]>('/clients') });
  const [f, setF] = useState({ name: '', code: '', currency: 'NZD' });
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
          <li key={c.id}><Link to={`/clients/${c.id}`}>{c.name}</Link> <span className="muted">{c.code ?? ''} {c.currency}</span></li>
        ))}
      </ul>
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
