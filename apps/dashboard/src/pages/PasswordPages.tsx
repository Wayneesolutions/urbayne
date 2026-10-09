import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errText, session } from '../api';

/** "Forgot password": asks for the email and says the same thing whether or not it has an account. */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try { await api('/auth/forgot', { body: { email } }); setDone(true); }
    catch (x) { setErr(errText(x, 'Could not send the email. Try again in a few minutes.')); }
  }
  return (
    <div className="centered">
      <div className="panel narrow">
        <h1>Forgot your password?</h1>
        {done ? (
          <>
            <p>If <strong>{email}</strong> has an account, a link to choose a new password is on its way. It works once and for one hour.</p>
            <p className="muted small">Nothing arrived? Check spam, then try again, or ask your administrator to reset it for you.</p>
            <Link className="btn" to="/login">Back to sign in</Link>
          </>
        ) : (
          <form onSubmit={submit} className="stack">
            <p className="muted">Enter the email you sign in with. We will send you a link.</p>
            <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></label>
            <button className="btn primary">Send reset link</button>
            <Link to="/login" className="small">Back to sign in</Link>
            {err && <p className="err" role="alert">{err}</p>}
          </form>
        )}
      </div>
    </div>
  );
}

/** Opened from the emailed link: /admin/reset-password?token=... */
export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    if (pw !== pw2) return setErr('The two passwords are not the same.');
    try { await api('/auth/reset', { body: { token, password: pw } }); session.clear(); setDone(true); }
    catch (x) { setErr(errText(x, 'Could not set the password.')); }
  }
  if (!token) return <div className="centered"><div className="panel narrow"><h1>Link not valid</h1><p>This page needs the link from your email. <Link to="/forgot-password">Ask for a new one</Link>.</p></div></div>;
  return (
    <div className="centered">
      <div className="panel narrow">
        <h1>Choose a new password</h1>
        {done ? (
          <><p>Your password is changed. You were signed out on all devices.</p><Link className="btn primary" to="/login">Sign in</Link></>
        ) : (
          <form onSubmit={submit} className="stack">
            <label>New password<input type="password" autoComplete="new-password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus required /></label>
            <label>Type it again<input type="password" autoComplete="new-password" minLength={10} value={pw2} onChange={(e) => setPw2(e.target.value)} required /></label>
            <p className="muted small">At least 10 characters. A few ordinary words together is a good password.</p>
            <button className="btn primary">Save password</button>
            {err && <p className="err" role="alert">{err}</p>}
            {err.includes('expired') && <Link to="/forgot-password" className="small">Ask for a new link</Link>}
          </form>
        )}
      </div>
    </div>
  );
}

/** Signed in: change your own password. Also shown first when someone else chose it for you. */
export function ChangePassword() {
  const nav = useNavigate();
  const st = (useLocation().state ?? {}) as { forced?: boolean; current?: string };
  const forced = Boolean(st.forced);
  const [current, setCurrent] = useState(st.current ?? '');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    if (pw !== pw2) return setErr('The two passwords are not the same.');
    try {
      const r = await api('/auth/change-password', { body: { currentPassword: current, newPassword: pw } });
      session.set(r.accessToken, r.refreshToken);
      setOk(true);
      if (forced) nav('/', { replace: true });
    } catch (x) { setErr(errText(x, 'Could not change the password.')); }
  }
  return (
    <div className="centered">
      <div className="panel narrow">
        <h1>{forced ? 'Choose your own password' : 'Change password'}</h1>
        {forced && <p className="muted">Your password was set by someone else. Choose one only you know before you continue.</p>}
        {ok && !forced ? <><p role="status">Password changed. You were signed out on your other devices.</p><Link className="btn" to="/">Back</Link></> : (
          <form onSubmit={submit} className="stack">
            {!forced && <label>Current password<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label>}
            <label>New password<input type="password" autoComplete="new-password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus required /></label>
            <label>Type it again<input type="password" autoComplete="new-password" minLength={10} value={pw2} onChange={(e) => setPw2(e.target.value)} required /></label>
            <p className="muted small">At least 10 characters. A few ordinary words together is a good password.</p>
            <button className="btn primary">Save password</button>
            {!forced && <Link to="/" className="small">Cancel</Link>}
            {err && <p className="err" role="alert">{err}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
