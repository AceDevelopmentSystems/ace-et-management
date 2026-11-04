import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AssetType, Client, Region, Site, api } from '../api';
import { useAuth } from '../auth';
import { num } from '../lib';
import { ErrorMsg, Field, Loading } from '../ui';
import { ForecastTab } from './Forecast';

export function ClientPage() {
  const { clientId = '' } = useParams();
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<Client[]>('/clients') });
  const client = clients.data?.find((c) => c.id === clientId);
  return (
    <section className="stack">
      <p><Link to="/">← Clients</Link></p>
      <Loading query={clients} />
      {clients.data && !client && <p role="alert" className="error">Client not found.</p>}
      {client && (
        <>
          <h1>{client.name}</h1>
          <nav className="tabs">
            <NavLink to="sites">Sites</NavLink>
            <NavLink to="regions">Regions</NavLink>
            <NavLink to="types">Asset types</NavLink>
            <NavLink to="forecast">Forecast</NavLink>
          </nav>
          <Routes>
            <Route index element={<Navigate to="sites" replace />} />
            <Route path="sites" element={<SitesTab clientId={clientId} />} />
            <Route path="regions" element={<RegionsTab clientId={clientId} />} />
            <Route path="types" element={<TypesTab clientId={clientId} />} />
            <Route path="forecast" element={<ForecastTab client={client} />} />
          </Routes>
        </>
      )}
    </section>
  );
}

function SitesTab({ clientId }: { clientId: string }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const [regionFilter, setRegionFilter] = useState('');
  const regions = useQuery({ queryKey: ['regions', clientId], queryFn: () => api.get<Region[]>(`/clients/${clientId}/regions`) });
  const sites = useQuery({
    queryKey: ['sites', clientId, regionFilter],
    queryFn: () => api.get<Site[]>(`/clients/${clientId}/sites${regionFilter ? `?regionId=${regionFilter}` : ''}`),
  });
  const [f, setF] = useState({ code: '', name: '', siteClass: '', address: '', regionId: '' });
  const create = useMutation({
    mutationFn: () => api.post(`/clients/${clientId}/sites`, { code: f.code, name: f.name, siteClass: f.siteClass || undefined, address: f.address || undefined, regionId: f.regionId || undefined }),
    onSuccess: () => {
      setF({ code: '', name: '', siteClass: '', address: '', regionId: f.regionId });
      qc.invalidateQueries({ queryKey: ['sites', clientId] });
      qc.invalidateQueries({ queryKey: ['regions', clientId] });
    },
  });
  const onSubmit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  return (
    <div className="stack">
      <div className="row">
        <Field label="Region">
          <select aria-label="Filter sites by region" value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}>
            <option value="">All regions</option>
            {regions.data?.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name} ({r.site_count})</option>)}
          </select>
        </Field>
        {sites.data && <span className="muted">{sites.data.length} site{sites.data.length === 1 ? '' : 's'}</span>}
      </div>
      <Loading query={sites} />
      {sites.data?.length === 0 && <p className="muted">No sites{regionFilter ? ' in this region' : ' yet'}.</p>}
      <table className="table">
        <thead><tr><th>Code</th><th>Name</th><th>Region</th><th>Class</th><th>Location</th></tr></thead>
        <tbody>
          {sites.data?.map((s) => (
            <tr key={s.id}><td>{s.code}</td><td><Link to={`/sites/${s.id}`}>{s.name}</Link></td><td title={s.region_name ?? undefined}>{s.region_code}</td><td>{s.site_class}</td><td>{s.address}</td></tr>
          ))}
        </tbody>
      </table>
      {canWrite && (
        <form onSubmit={onSubmit} className="card row">
          <Field label="Code"><input required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} size={8} /></Field>
          <Field label="Region">
            <select value={f.regionId} onChange={(e) => setF({ ...f, regionId: e.target.value })}>
              <option value="">—</option>
              {regions.data?.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
            </select>
          </Field>
          <Field label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Class"><input value={f.siteClass} onChange={(e) => setF({ ...f, siteClass: e.target.value })} size={12} /></Field>
          <Field label="Address"><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <button type="submit" disabled={create.isPending}>Add site</button>
          <ErrorMsg error={create.error} />
        </form>
      )}
    </div>
  );
}

function TypesTab({ clientId }: { clientId: string }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const types = useQuery({ queryKey: ['types', clientId], queryFn: () => api.get<AssetType[]>(`/clients/${clientId}/asset-types`) });
  const [f, setF] = useState({ name: '', life: '', unit: '', rate: '' });
  const create = useMutation({
    mutationFn: () => api.post(`/clients/${clientId}/asset-types`, { name: f.name, expectedLifeYears: num(f.life), unit: f.unit || undefined, unitRate: num(f.rate) }),
    onSuccess: () => { setF({ name: '', life: '', unit: '', rate: '' }); qc.invalidateQueries({ queryKey: ['types', clientId] }); },
  });
  const onSubmit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  return (
    <div className="stack">
      <p className="muted">Types supply the default life and replacement rate for assets that do not set their own.</p>
      <Loading query={types} />
      <table className="table">
        <thead><tr><th>Name</th><th>Life (years)</th><th>Unit</th><th>Rate per unit</th></tr></thead>
        <tbody>
          {types.data?.map((t) => (
            <tr key={t.id}><td>{t.name}</td><td>{t.expected_life_years}</td><td>{t.unit}</td><td>{t.unit_rate}</td></tr>
          ))}
        </tbody>
      </table>
      {canWrite && (
        <form onSubmit={onSubmit} className="card row">
          <Field label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Life (years)"><input type="number" min={1} step={1} value={f.life} onChange={(e) => setF({ ...f, life: e.target.value })} size={6} /></Field>
          <Field label="Unit"><input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} size={6} /></Field>
          <Field label="Rate per unit"><input type="number" min={0} step="0.01" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} size={10} /></Field>
          <button type="submit" disabled={create.isPending}>Add type</button>
          <ErrorMsg error={create.error} />
        </form>
      )}
    </div>
  );
}

function RegionsTab({ clientId }: { clientId: string }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const regions = useQuery({ queryKey: ['regions', clientId], queryFn: () => api.get<Region[]>(`/clients/${clientId}/regions`) });
  const [f, setF] = useState({ code: '', name: '' });
  const create = useMutation({
    mutationFn: () => api.post(`/clients/${clientId}/regions`, { code: f.code.trim(), name: f.name.trim() }),
    onSuccess: () => { setF({ code: '', name: '' }); qc.invalidateQueries({ queryKey: ['regions', clientId] }); },
  });
  const onSubmit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  return (
    <div className="stack">
      <p className="muted">Regions group a client's sites, for example by state. The code is short and unique per client.</p>
      <Loading query={regions} />
      {regions.data?.length === 0 && <p className="muted">No regions yet.</p>}
      <table className="table">
        <thead><tr><th>Code</th><th>Name</th><th>Sites</th></tr></thead>
        <tbody>
          {regions.data?.map((r) => (
            <tr key={r.id}><td>{r.code}</td><td>{r.name}</td><td>{r.site_count}</td></tr>
          ))}
        </tbody>
      </table>
      {canWrite && (
        <form onSubmit={onSubmit} className="card row">
          <Field label="Code"><input required maxLength={20} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} size={8} /></Field>
          <Field label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <button type="submit" disabled={create.isPending}>Add region</button>
          <ErrorMsg error={create.error} />
        </form>
      )}
    </div>
  );
}
