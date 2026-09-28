import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { ShellCtx } from '../App';

const ROLE: Record<string, string> = { owner: 'Candidate', manager: 'Campaign manager', finance_agent: 'Finance / election agent', coordinator: 'Coordinator', field_worker: 'Booth worker / canvasser', agent_reporter: 'Polling agent', service_staff: 'Office staff' };

export function Team() {
  const { tenant: t, role } = useOutletContext<ShellCtx>();
  const [members, setMembers] = useState<any[]>([]);
  const [form, setForm] = useState({ phone: '', name: '', role: 'field_worker' });
  const [err, setErr] = useState('');
  const load = () => api(`/t/${t.id}/members`).then(setMembers);
  useEffect(() => { load(); }, [t.id]);
  const allowed = role === 'owner' ? ['manager', 'finance_agent', 'coordinator', 'field_worker', 'agent_reporter', 'service_staff'] : ['field_worker', 'agent_reporter'];
  async function add(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try { await api(`/t/${t.id}/members`, { body: form }); setForm({ phone: '', name: '', role: 'field_worker' }); load(); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not add.'); }
  }
  return (
    <>
      <header className="page-head"><h1>Team</h1><p className="muted">People sign in with their mobile number. Booth workers open <a href="/w/" target="_blank" rel="noreferrer">{location.origin}/w</a> on their phone; it keeps working without signal.</p></header>
      <form className="panel inline-form" onSubmit={add}>
        <label>Mobile<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required placeholder="+91…" /></label>
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{allowed.map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select></label>
        <button className="btn primary">Add to team</button>
        {err && <p className="err">{err}</p>}
      </form>
      <table className="table"><thead><tr><th>Name</th><th>Mobile</th><th>Role</th></tr></thead>
        <tbody>{members.map((m) => <tr key={m.userId}><td>{m.name ?? '–'}</td><td className="mono-ish">{m.phone}</td><td>{ROLE[m.role]}</td></tr>)}</tbody></table>
    </>
  );
}
