import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, session } from '../api';

export function Login() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const nav = useNavigate();

  async function request(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try {
      const r = await api('/auth/otp/request', { body: { phone } });
      setSent(true);
      if (r.devCode) setCode(r.devCode); // demo servers only
    } catch (x: any) { setErr(x.message); }
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try {
      const r = await api('/auth/otp/verify', { body: { phone, code } });
      session.set(r.accessToken, r.refreshToken);
      nav('/');
    } catch { setErr('That code did not work. Check it and try again, or request a new one.'); }
  }
  return (
    <div className="centered">
      <div className="panel narrow">
        <h1>Sign in</h1>
        {!sent ? (
          <form onSubmit={request} className="stack">
            <label>Mobile number<input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98…  or  +1 204…" inputMode="tel" autoFocus /></label>
            <button className="btn primary">Send code</button>
          </form>
        ) : (
          <form onSubmit={verify} className="stack">
            <p className="muted">We sent a 6-digit code to {phone}.</p>
            <label>Code<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} autoFocus /></label>
            <button className="btn primary">Sign in</button>
            <button type="button" className="linklike" onClick={() => { setSent(false); setCode(''); }}>Use a different number</button>
          </form>
        )}
        {err && <p className="err">{err}</p>}
      </div>
    </div>
  );
}
