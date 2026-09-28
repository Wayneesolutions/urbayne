import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { ShellCtx } from '../App';

const RES = [
  ['supporter', 'Supporter'], ['undecided', 'Undecided'], ['not_interested', 'Not interested'], ['not_home', 'Not home'], ['needs_help', 'Needs help'], ['wants_sign', 'Wants a sign'],
] as const;

export function Field() {
  const { tenant: t } = useOutletContext<ShellCtx>();
  const [turfs, setTurfs] = useState<any[]>([]);
  const [summary, setSummary] = useState<any[]>([]);
  const [areas, setAreas] = useState<any[]>([]);
  const [workers, setWorkers] = useState<any[]>([]);
  const [form, setForm] = useState({ geoAreaId: '', name: '', assignedUserId: '' });
  const [err, setErr] = useState('');
  const load = () => { api(`/t/${t.id}/field/turfs`).then(setTurfs); api(`/t/${t.id}/field/summary`).then(setSummary); };
  useEffect(() => {
    load();
    api(`/t/${t.id}/geo`).then((g) => setAreas(g.filter((a: any) => a.parentId)));
    api(`/t/${t.id}/members`).then((m) => setWorkers(m.filter((x: any) => ['field_worker', 'coordinator'].includes(x.role))));
  }, [t.id]);
  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try { await api(`/t/${t.id}/field/turfs`, { body: { geoAreaId: form.geoAreaId, name: form.name, assignedUserId: form.assignedUserId || null } }); setForm({ geoAreaId: '', name: '', assignedUserId: '' }); load(); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not create.'); }
  }
  async function assign(turfId: string, userId: string) { await api(`/t/${t.id}/field/turfs/${turfId}`, { method: 'PATCH', body: { assignedUserId: userId || null } }); load(); }
  const cols = RES.filter(([k]) => t.region === 'CA' || k !== 'wants_sign');
  return (
    <>
      <header className="page-head"><h1>{t.region === 'IN' ? 'Booth workers' : 'Door-to-door'}</h1>
        <p className="muted">Give each worker an area. They mark every house on their phone, with or without signal, and results appear here by area.</p></header>
      <form className="panel inline-form" onSubmit={create}>
        <label>Area<select value={form.geoAreaId} onChange={(e) => setForm({ ...form, geoAreaId: e.target.value, name: form.name || areas.find((a) => a.id === e.target.value)?.nameEn || '' })} required>
          <option value="">Choose…</option>{areas.map((a) => <option key={a.id} value={a.id}>{a.nameEn}</option>)}</select></label>
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label>Worker<select value={form.assignedUserId} onChange={(e) => setForm({ ...form, assignedUserId: e.target.value })}><option value="">Unassigned</option>{workers.map((w) => <option key={w.userId} value={w.userId}>{w.name ?? w.phone}</option>)}</select></label>
        <button className="btn primary">Create area list</button>
        {err && <p className="err">{err}</p>}
      </form>
      <table className="table">
        <thead><tr><th>Area</th><th>Worker</th><th>Households</th><th>Visited</th><th>Progress</th></tr></thead>
        <tbody>{turfs.map((x) => {
          const pct = x.households ? Math.min(100, Math.round((x.visited / x.households) * 100)) : 0;
          return <tr key={x.id}><td>{x.name}</td>
            <td><select value={x.assignedUserId ?? ''} onChange={(e) => assign(x.id, e.target.value)} aria-label={`Worker for ${x.name}`}><option value="">Unassigned</option>{workers.map((w) => <option key={w.userId} value={w.userId}>{w.name ?? w.phone}</option>)}</select></td>
            <td>{x.households}</td><td>{x.visited}</td><td style={{ minWidth: 160 }}><div className="bar thin"><span style={{ width: `${pct}%` }} /></div><span className="muted small">{pct}%</span></td></tr>;
        })}</tbody>
      </table>
      <section className="panel">
        <h2>Where you stand, by area</h2>
        <p className="muted small">Latest answer from each household.</p>
        <table className="table compact"><thead><tr><th>Area</th>{cols.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
          <tbody>{summary.map((r) => <tr key={r.area}><td>{r.area}</td>{cols.map(([k]) => <td key={k} className={k === 'supporter' && (r.counts.supporter ?? 0) >= (r.counts.undecided ?? 0) ? 'top' : ''}>{r.counts[k] ?? 0}</td>)}</tr>)}</tbody></table>
        {!summary.length && <p className="muted">No visits yet.</p>}
      </section>
    </>
  );
}
