import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, authConfig, session } from '../api';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(true);
  useEffect(() => { authConfig().then((c) => setReset(c.passwordReset)); }, []);
  const nav = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api('/auth/login', { body: { email, password } });
      session.set(r.accessToken, r.refreshToken);
      // A password someone else chose must be replaced before anything else (kept only in this page's navigation state, not stored).
      if (r.mustChangePassword) nav('/change-password', { state: { forced: true, current: password } });
      else nav('/');
    } catch (x) {
      setErr(x instanceof ApiError && x.status === 429 ? x.message : 'Email or password is not right.');
    } finally { setBusy(false); }
  }
  return (
    <div className="centered">
      <div className="panel narrow">
        <h1>Sign in</h1>
        <form onSubmit={submit} className="stack">
          <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          {reset ? <Link to="/forgot-password" className="small">Forgot your password?</Link> : <span className="muted small">Forgot your password? Ask your administrator to reset it.</span>}
        </form>
        {err && <p className="err" role="alert">{err}</p>}
      </div>
    </div>
  );
}
