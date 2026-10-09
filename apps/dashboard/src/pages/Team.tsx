import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, errText } from '../api';
import type { ShellCtx } from '../App';

const ROLE: Record<string, string> = { owner: 'Candidate', manager: 'Campaign manager', finance_agent: 'Finance / election agent', coordinator: 'Coordinator', field_worker: 'Booth worker / canvasser', agent_reporter: 'Polling agent', service_staff: 'Office staff' };
const blank = { email: '', name: '', role: 'field_worker', phone: '', how: 'invite' as 'invite' | 'set', password: '' };

export function Team() {
  const { tenant: t, role } = useOutletContext<ShellCtx>();
  const [members, setMembers] = useState<any[]>([]);
  const [form, setForm] = useState(blank);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api(`/t/${t.id}/members`).then(setMembers);
  useEffect(() => { load(); }, [t.id]);
  const allowed = role === 'owner' ? ['manager', 'finance_agent', 'coordinator', 'field_worker', 'agent_reporter', 'service_staff'] : ['field_worker', 'agent_reporter'];
  async function add(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    try {
      const r = await api(`/t/${t.id}/members`, { body: {
        email: form.email, role: form.role, ...(form.name && { name: form.name }), ...(form.phone && { phone: form.phone }), ...(form.how === 'set' ? { password: form.password } : {}),
      } });
      setMsg({ ok: true, text: r.invited === false ? 'Added, but the invite email could not be sent. Ask your platform contact to check the mail settings.' : r.invited ? `Added. We emailed ${r.email} a link to choose a password.` : `Added. Give ${r.email} the password you typed: they must change it at first sign-in.` });
      setForm(blank); load();
    } catch (x) { setMsg({ ok: false, text: errText(x, 'Could not add.') }); }
  }
  return (
    <>
      <header className="page-head"><h1>Team</h1><p className="muted">People sign in with their email and password. Booth workers open <a href="/w/" target="_blank" rel="noreferrer">{location.origin}/w</a> on their phone and sign in the same way; it keeps working without signal.</p></header>
      <form className="panel stack" onSubmit={add}>
        <div className="grid4">
          <label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{allowed.map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select></label>
          <label>Password<select value={form.how} onChange={(e) => setForm({ ...form, how: e.target.value as any })}><option value="invite">Email them a link to choose</option><option value="set">I will type one</option></select></label>
        </div>
        {form.how === 'set' && <label>Password (at least 10 characters)<input type="text" minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>}
        {form.role === 'agent_reporter' && <label>Mobile (only if they report results by text message)<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+91…" /></label>}
        <button className="btn primary" style={{ alignSelf: 'flex-start' }}>Add to team</button>
        {msg && <p className={msg.ok ? 'muted' : 'err'} role="status">{msg.text}</p>}
      </form>
      <table className="table"><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
        <tbody>{members.map((m) => <tr key={m.userId}><td>{m.name ?? '–'}</td><td>{m.email ?? <span className="muted small">no email</span>}{m.disabled && <span className="chip bad"> disabled</span>}</td><td>{ROLE[m.role]}</td></tr>)}</tbody></table>
    </>
  );
}
