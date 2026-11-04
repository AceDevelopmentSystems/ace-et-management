import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import { TrashEntity, TrashItem, api } from '../api';
import { useAuth } from '../auth';
import { ErrorMsg, Loading } from '../ui';

const KIND: Record<TrashEntity, string> = {
  client: 'Client', region: 'Region', site: 'Site', 'asset-type': 'Asset type', asset: 'Asset', scenario: 'Saved scenario',
};

export function Trash() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const trash = useQuery({ queryKey: ['trash'], enabled: isAdmin, queryFn: () => api.get<TrashItem[]>('/trash') });
  const restore = useMutation({
    mutationFn: (i: TrashItem) => api.post<unknown>(`/trash/${i.entity}/${i.id}/restore`),
    // A restore can bring back many things (a client's sites and assets), so refresh everything.
    onSuccess: () => qc.invalidateQueries(),
  });
  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <section className="stack">
      <h1>Trash</h1>
      <p className="muted">
        Deleted items are kept, not erased. Restoring a client or site brings back what was deleted with it, but not anything that was deleted earlier on its own.
      </p>
      <Loading query={trash} />
      <ErrorMsg error={restore.error} />
      {trash.data?.length === 0 && <p className="muted">The trash is empty.</p>}
      {trash.data && trash.data.length > 0 && (
        <table className="table">
          <thead><tr><th>Type</th><th>Item</th><th>Client</th><th>Deleted</th><th /></tr></thead>
          <tbody>
            {trash.data.map((i) => (
              <tr key={`${i.entity}:${i.id}`}>
                <td>{KIND[i.entity]}</td>
                <td>{i.label}{i.includes > 0 && <span className="muted"> · with {i.includes} item{i.includes === 1 ? '' : 's'}</span>}</td>
                <td>{i.entity === 'client' ? '' : i.clientName}</td>
                <td title={i.deletedAt}>{new Date(i.deletedAt).toLocaleString()}{i.deletedBy ? <span className="muted"> · {i.deletedBy}</span> : null}</td>
                <td><button type="button" disabled={restore.isPending} onClick={() => restore.mutate(i)}>Restore</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p><Link to="/">← Clients</Link></p>
    </section>
  );
}
