import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, authConfig, errText, session } from '../api';
import { PasswordInput } from '../PasswordInput';

type Type = 'super_admin' | 'admin' | 'user';
const TYPE_LABEL: Record<Type, string> = { super_admin: 'Super admin', admin: 'Admin (platform staff)', user: 'User (candidate or team member)' };
const blank = { name: '', email: '', type: 'admin' as Type, how: 'generate' as 'generate' | 'set' | 'invite', password: '' };
const RACES = ['assembly', 'parliament', 'municipal', 'ward', 'trustee', 'panchayat', 'other'];
const blankCamp = { email: '', name: '', campaignName: '', seatCode: '', raceType: 'assembly', electionDate: '', planCode: '', how: 'generate' as 'generate' | 'set' | 'invite', password: '' };

/** Super admin portal: create accounts with an email and a password, change what they can do, disable them, reset their password. */
export function SuperAdmin() {
  const nav = useNavigate();
  const [users, setUsers] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [mail, setMail] = useState(true);
  const [c, setC] = useState(blankCamp);
  const [camps, setCamps] = useState<any[] | null>(null);
  const [plans, setPlans] = useState<any[]>([]);
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
  const loadCamps = () => api('/superadmin/campaigns').then(setCamps).catch(() => {});
  useEffect(() => { loadCamps(); api('/admin/plans').then(setPlans).catch(() => {}); }, []);

  async function createCamp(e: React.FormEvent) {
    e.preventDefault(); setMsg(null); setSecret(null);
    try {
      const r = await api('/superadmin/campaigns', { body: {
        campaignName: c.campaignName, seatCode: c.seatCode, raceType: c.raceType, electionDate: c.electionDate,
        owner: { email: c.email, ...(c.name ? { name: c.name } : {}), ...(c.how === 'set' ? { password: c.password } : {}), ...(c.how === 'invite' ? { sendInvite: true } : {}) },
        ...(c.planCode ? { plan: { planCode: c.planCode } } : {}),
      } });
      if (r.owner.temporaryPassword) setSecret({ who: r.owner.email, password: r.owner.temporaryPassword });
      setMsg({ ok: true, text: `Campaign “${r.campaign.campaignName}” created. ${r.owner.email} is its owner${r.plan ? ` on the ${r.plan} package` : ''}.${r.owner.invited ? ' A link to choose a password was emailed.' : ''}` });
      setC(blankCamp); loadCamps(); load();
    } catch (x) { setMsg({ ok: false, text: errText(x, 'Could not create the campaign.') }); }
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

      <form className="panel stack" onSubmit={createCamp}>
        <h2>Create a campaign for a candidate</h2>
        <p className="muted small">One step: the candidate’s account is made (or an existing one is used), they become the campaign’s owner, and the package is applied.</p>
        <div className="grid4">
          <label>Candidate email<input type="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} required /></label>
          <label>Candidate name<input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
          <label>Campaign name<input value={c.campaignName} onChange={(e) => setC({ ...c, campaignName: e.target.value })} minLength={2} required /></label>
          <label>Seat code<input value={c.seatCode} onChange={(e) => setC({ ...c, seatCode: e.target.value })} placeholder="e.g. PB-061" required /></label>
          <label>Race<select value={c.raceType} onChange={(e) => setC({ ...c, raceType: e.target.value })}>{RACES.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
          <label>Election date<input type="date" value={c.electionDate} onChange={(e) => setC({ ...c, electionDate: e.target.value })} required /></label>
          <label>Package<select value={c.planCode} onChange={(e) => setC({ ...c, planCode: e.target.value })}>
            <option value="">No package yet</option>{plans.filter((p) => p.active).map((p) => <option key={p.code} value={p.code}>{p.name} ({p.region})</option>)}</select></label>
          <label>Password<select value={c.how} onChange={(e) => setC({ ...c, how: e.target.value as any })}>
            <option value="generate">Generate one for me</option><option value="set">I will type one</option>{mail && <option value="invite">Email them a link to choose</option>}</select></label>
        </div>
        {c.how === 'set' && <label>Password (at least 10 characters)<PasswordInput value={c.password} onChange={(e) => setC({ ...c, password: e.target.value })} minLength={10} autoComplete="new-password" required /></label>}
        <p className="muted small">If the email already has an account, it keeps its password and is simply made owner of this campaign.</p>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }}>Create campaign</button>
      </form>

      <h2>Campaigns</h2>
      <table className="table compact" style={{ marginBottom: 24 }}>
        <thead><tr><th>Campaign</th><th>Seat</th><th>Election</th><th>Owner</th><th>Package</th></tr></thead>
        <tbody>{(camps ?? []).map((x) => (
          <tr key={x.id}>
            <td>{x.campaignName}</td><td>{x.seatCode}</td><td>{x.electionDate}</td>
            <td>{x.owner ? `${x.owner.name ?? ''} ${x.owner.email ?? ''}`.trim() : '–'}</td>
            <td>{x.plan ? `${x.plan.name} (${x.plan.status})` : <span className="muted small">none</span>}</td>
          </tr>
        ))}</tbody>
      </table>
      {camps && !camps.length && <p className="muted">No campaigns yet.</p>}

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
