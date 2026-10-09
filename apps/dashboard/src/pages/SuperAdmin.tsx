import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, authConfig, errText, session } from '../api';
import { PasswordInput } from '../PasswordInput';

type Type = 'super_admin' | 'admin' | 'user';
const TYPE_LABEL: Record<Type, string> = { super_admin: 'Super admin', admin: 'Admin (platform staff)', user: 'User (candidate or team member)' };
const blank = { name: '', email: '', type: 'admin' as Type, how: 'generate' as 'generate' | 'set' | 'invite', password: '' };

/** Super admin portal: create accounts with an email and a password, change what they can do, disable them, reset their password. */
export function SuperAdmin() {
  const nav = useNavigate();
  const [users, setUsers] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [mail, setMail] = useState(true);
  useEffect(() => { authConfig().then((c) => setMail(c.passwordReset)); }, []);
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null);
  const load = (query = q) => api(`/superadmin/users${query ? `?q=${encodeURIComponent(query)}` : ''}`).then(setUsers).catch((x) => { if (x?.status === 403) nav('/'); else setMsg({ ok: false, text: errText(x) }); });
  useEffect(() => { load(''); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault(); setMsg(null); setSecret(null);
    try {
      const r = await api('/superadmin/users', { body: {
        name: f.name, email: f.email, type: f.type,
        ...(f.how === 'set' ? { password: f.password } : {}), ...(f.how === 'invite' ? { sendInvite: true } : {}),
      } });
      if (r.temporaryPassword) setSecret({ who: r.email, password: r.temporaryPassword });
      setMsg({ ok: true, text: r.invited === false ? `Account created, but the invite email could not be sent. ${r.inviteError ?? ''}` : r.invited ? `Account created. An email with a link to choose a password was sent to ${r.email}.` : `Account created for ${r.email}. Give them the password below: they must change it when they first sign in.` });
      setF(blank); load();
    } catch (x) { setMsg({ ok: false, text: errText(x, 'Could not create the account.') }); }
  }
  const act = async (fn: () => Promise<any>, done?: (r: any) => string) => {
    setMsg(null); setSecret(null);
    try { const r = await fn(); if (done) setMsg({ ok: true, text: done(r) }); load(); return r; } catch (x) { setMsg({ ok: false, text: errText(x) }); }
  };

  return (
    <div className="work" style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <header className="page-head row">
        <div><h1>Super admin: accounts</h1><p className="muted">Create people’s accounts and decide what they can do. A forgotten password is reset by the person themselves with “Forgot your password?”. Everyone signs in with an email and a password.</p></div>
        <div className="actions"><Link className="btn" to="/">Back</Link><button className="btn" onClick={() => { session.clear(); nav('/login'); }}>Sign out</button></div>
      </header>
      {msg && <p className={msg.ok ? 'muted' : 'err'} role="status">{msg.text}</p>}
      {secret && (
        <section className="panel" role="alert" style={{ background: '#FFF8E5' }}>
          <strong>Password for {secret.who}: shown only once</strong>
          <div className="rowflex" style={{ marginTop: 8 }}>
            <code style={{ fontSize: 22, letterSpacing: 1 }}>{secret.password}</code>
            <button className="btn small" onClick={() => navigator.clipboard?.writeText(secret.password)}>Copy</button>
            <button className="btn small" onClick={() => setSecret(null)}>I have saved it</button>
          </div>
          <p className="muted small">Send it privately (not by email if you can avoid it). They will choose their own password at the first sign-in.</p>
        </section>
      )}

      <form className="panel stack" onSubmit={create}>
        <h2>Create an account</h2>
        <div className="grid4">
          <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <label>Email<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
          <label>This person is<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as Type })}>{(Object.keys(TYPE_LABEL) as Type[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></label>
          <label>Password<select value={f.how} onChange={(e) => setF({ ...f, how: e.target.value as any })}>
            <option value="generate">Generate one for me</option><option value="set">I will type one</option>{mail && <option value="invite">Email them a link to choose</option>}</select></label>
        </div>
        {f.how === 'set' && <label>Password (at least 10 characters)<PasswordInput value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} minLength={10} autoComplete="new-password" required /></label>}
        <p className="muted small">A super admin can manage accounts. An admin is platform staff (packages, billing, support). A user has no platform powers: a candidate creates their campaign after signing in, and team members are added by the campaign owner.</p>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }}>Create account</button>
      </form>

      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); load(); }} style={{ marginBottom: 12 }}>
        <label>Find<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="name or email" /></label>
        <button className="btn">Search</button>
      </form>
      <table className="table compact">
        <thead><tr><th>Name</th><th>Email</th><th>Type</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
        <tbody>{(users ?? []).map((u) => (
          <tr key={u.id}>
            <td>{u.name ?? '–'}</td>
            <td>{u.email ?? <span className="muted small">no email: cannot sign in</span>}</td>
            <td><select value={u.type} aria-label={`Type for ${u.email}`} onChange={(e) => act(() => api(`/superadmin/users/${u.id}`, { method: 'PATCH', body: { type: e.target.value } }), () => 'Updated.')}>
              {(Object.keys(TYPE_LABEL) as Type[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></td>
            <td>{u.disabled ? <span className="chip bad">disabled</span> : u.mustChangePassword ? <span className="chip warn">must change password</span> : <span className="chip good">active</span>}</td>
            <td className="small">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
            <td className="rowflex">
              <button className="btn small" onClick={() => act(() => api(`/superadmin/users/${u.id}/send-reset-link`, { body: {} }), () => `Reset link sent to ${u.email}.`)} disabled={!u.email || !mail} title={mail ? '' : 'Email is not set up on this server'}>Email reset link</button>
              <button className="btn small" onClick={() => act(() => api(`/superadmin/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } }), () => (u.disabled ? 'Account enabled.' : 'Account disabled and signed out.'))}>{u.disabled ? 'Enable' : 'Disable'}</button>
            </td>
          </tr>
        ))}</tbody>
      </table>
      {users && !users.length && <p className="muted">No accounts match.</p>}
    </div>
  );
}
