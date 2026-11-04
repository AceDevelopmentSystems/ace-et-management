import { useMutation } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorMsg, Field } from '../ui';

export function Login() {
  const { authed, signIn } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ email: '', password: '', displayName: '', organisationName: '', kind: 'OWNER' as 'OWNER' | 'CONSULTANCY' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = useMutation({
    mutationFn: () =>
      mode === 'login'
        ? api.post<{ token: string }>('/auth/login', { email: f.email, password: f.password })
        : api.post<{ token: string }>('/auth/register', f),
    onSuccess: (r) => signIn(r.token),
  });

  if (authed) return <Navigate to="/" replace />;
  const onSubmit = (e: FormEvent) => { e.preventDefault(); submit.mutate(); };

  return (
    <main className="auth">
      <h1>Asset Management</h1>
      <form onSubmit={onSubmit} className="card stack">
        <h2>{mode === 'login' ? 'Sign in' : 'Create an organisation'}</h2>
        {mode === 'register' && (
          <>
            <Field label="Organisation name"><input required value={f.organisationName} onChange={set('organisationName')} /></Field>
            <Field label="We are" hint="A consultancy manages assets for several clients; an owner manages its own.">
              <select value={f.kind} onChange={set('kind')}>
                <option value="OWNER">A company managing its own assets</option>
                <option value="CONSULTANCY">A consultancy managing assets for clients</option>
              </select>
            </Field>
            <Field label="Your name"><input required value={f.displayName} onChange={set('displayName')} /></Field>
          </>
        )}
        <Field label="Email"><input type="email" required autoComplete="username" value={f.email} onChange={set('email')} /></Field>
        <Field label="Password" hint={mode === 'register' ? 'At least 10 characters.' : undefined}>
          <input type="password" required minLength={mode === 'register' ? 10 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={f.password} onChange={set('password')} />
        </Field>
        <ErrorMsg error={submit.error} />
        <button type="submit" disabled={submit.isPending}>{mode === 'login' ? 'Sign in' : 'Create organisation'}</button>
        <button type="button" className="link" onClick={() => { submit.reset(); setMode(mode === 'login' ? 'register' : 'login'); }}>
          {mode === 'login' ? 'New here? Create an organisation' : 'Have an account? Sign in'}
        </button>
      </form>
    </main>
  );
}
