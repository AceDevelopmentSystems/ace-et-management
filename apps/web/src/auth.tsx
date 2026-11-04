import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { UNAUTHORIZED_EVENT, Role, claimsOf, getToken, setToken } from './api';

interface AuthValue {
  authed: boolean;
  role: Role | null;
  /** May create/edit register data. */
  canWrite: boolean;
  /** May record inspections. */
  canAssess: boolean;
  signIn: (token: string) => void;
  signOut: () => void;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(getToken());
  const signIn = useCallback((t: string) => { setToken(t); setTokenState(t); }, []);
  const signOut = useCallback(() => { setToken(null); setTokenState(null); }, []);

  // Any 401 on a protected call (expired token) returns the user to the login page.
  useEffect(() => {
    window.addEventListener(UNAUTHORIZED_EVENT, signOut);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, signOut);
  }, [signOut]);

  const value = useMemo<AuthValue>(() => {
    const role = claimsOf(token)?.role ?? null;
    return {
      authed: !!token && !!role, role,
      canWrite: role === 'org_admin' || role === 'asset_manager',
      canAssess: role === 'org_admin' || role === 'asset_manager' || role === 'assessor',
      signIn, signOut,
    };
  }, [token, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
