import { useQueryClient } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { ClientPage } from './pages/ClientPage';
import { ContractPage } from './pages/Contracts';
import { Contractors } from './pages/Contractors';
import { Clients } from './pages/Clients';
import { Login } from './pages/Login';
import { Trash } from './pages/Trash';
import { SitePage } from './pages/SitePage';

const ROLE_LABEL: Record<string, string> = {
  org_admin: 'Administrator', asset_manager: 'Asset manager', assessor: 'Assessor', client_viewer: 'Viewer', contractor: 'Contractor',
};

function Protected({ children }: { children: ReactNode }) {
  const { authed, role, isAdmin, signOut } = useAuth();
  const qc = useQueryClient();
  if (!authed) return <Navigate to="/login" replace />;
  // Contractors have no register access yet (the API refuses them), so say so rather than show errors.
  if (role === 'contractor') {
    return <main className="auth"><p role="alert" className="error">Contractor access is not available yet.</p><button onClick={signOut}>Sign out</button></main>;
  }
  return (
    <>
      <header className="top">
        <Link to="/" className="brand">Asset Management</Link>
        <Link to="/contractors">Contractors</Link>
        {isAdmin && <Link to="/trash">Trash</Link>}
        <span className="muted">{role ? ROLE_LABEL[role] : ''}</span>
        <button className="link" onClick={() => { qc.clear(); signOut(); }}>Sign out</button>
      </header>
      <main className="page">{children}</main>
    </>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Protected><Clients /></Protected>} />
      <Route path="/clients/:clientId/*" element={<Protected><ClientPage /></Protected>} />
      <Route path="/sites/:siteId" element={<Protected><SitePage /></Protected>} />
      <Route path="/contractors" element={<Protected><Contractors /></Protected>} />
      <Route path="/contracts/:contractId" element={<Protected><ContractPage /></Protected>} />
      <Route path="/trash" element={<Protected><Trash /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
