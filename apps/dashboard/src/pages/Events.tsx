import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError } from '../api';
import { money, toMinor } from '../money';
import type { ShellCtx } from '../App';

const KIND: Record<string, string> = { sabha: 'Sabha / public meeting', rally: 'Rally', vehicle: 'Vehicle / roadshow', door_knock: 'Door-knocking', meeting: 'Small meeting', office_hours: 'Office hours' };
const PERM: Record<string, string> = { not_needed: 'Not needed', not_applied: 'Not applied', applied: 'Applied', granted: 'Granted', refused: 'Refused' };

export function Events() {
  const { tenant: t } = useOutletContext<ShellCtx>();
  const cur = t.region === 'IN' ? 'INR' : 'CAD';
  const [events, setEvents] = useState<any[]>([]);
  const [areas, setAreas] = useState<any[]>([]);
  const [vols, setVols] = useState<any[]>([]);
  const [form, setForm] = useState({ kind: t.region === 'IN' ? 'sabha' : 'door_knock', title: '', geoAreaId: '', startsAt: '', location: '' });
  const [open, setOpen] = useState<any>(null);
  const [err, setErr] = useState('');
  const load = () => api(`/t/${t.id}/ops/events`).then((ev) => { setEvents(ev); setOpen((o: any) => o && ev.find((e: any) => e.id === o.id)); });
  useEffect(() => { load(); api(`/t/${t.id}/geo`).then((g) => setAreas(g.filter((a: any) => a.parentId))); api(`/t/${t.id}/ops/volunteers`).then(setVols); }, [t.id]);
  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try { await api(`/t/${t.id}/ops/events`, { body: { ...form, geoAreaId: form.geoAreaId || undefined, location: form.location || undefined, startsAt: new Date(form.startsAt).toISOString() } }); setForm({ ...form, title: '', startsAt: '', location: '' }); load(); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not create.'); }
  }
  return (
    <>
      <header className="page-head"><h1>Events and volunteers</h1>
        <p className="muted">{t.region === 'IN' ? 'Sabhas, rallies and vehicles cannot be confirmed until their permission is granted and the reference number is recorded. Costs of finished events go straight into the expenditure register.' : 'Plan events, staff them with volunteers and send shift reminders. Costs of finished events go straight into the finance register.'}</p></header>
      <form className="panel inline-form" onSubmit={create}>
        <label>Type<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Title<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label>
        <label>Area<select value={form.geoAreaId} onChange={(e) => setForm({ ...form, geoAreaId: e.target.value })}><option value="">–</option>{areas.map((a) => <option key={a.id} value={a.id}>{a.nameEn}</option>)}</select></label>
        <label>Starts<input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} required /></label>
        <button className="btn primary">Add event</button>
        {err && <p className="err">{err}</p>}
      </form>
      <table className="table">
        <thead><tr><th>When</th><th>Event</th><th>Area</th><th>Permission</th><th>Status</th><th>Volunteers</th></tr></thead>
        <tbody>{events.map((e) => (
          <tr key={e.id} className="clickable" onClick={() => setOpen(e)}>
            <td>{new Date(e.startsAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</td>
            <td><strong>{e.title}</strong><div className="muted small">{KIND[e.kind]}</div></td><td>{e.area ?? '–'}</td>
            <td><span className={`badge ${e.permissionStatus === 'granted' || e.permissionStatus === 'not_needed' ? 'approved' : e.permissionStatus === 'refused' ? 'blocked' : ''}`}>{PERM[e.permissionStatus]}</span></td>
            <td>{e.status}</td><td>{e.shifts.reduce((s: number, x: any) => s + x.assigned, 0)} / {e.shifts.reduce((s: number, x: any) => s + x.needed, 0)}</td>
          </tr>
        ))}</tbody>
      </table>
      {open && <EventDrawer ev={open} tenant={t} vols={vols} cur={cur} onClose={() => setOpen(null)} onChange={load} />}
    </>
  );
}

function EventDrawer({ ev, tenant, vols, cur, onClose, onChange }: any) {
  const [perm, setPerm] = useState({ permissionStatus: ev.permissionStatus, permissionRef: ev.permissionRef ?? '' });
  const [cost, setCost] = useState('');
  const [shift, setShift] = useState({ title: '', needed: 5 });
  const [pick, setPick] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const patch = async (body: any) => { setErr(''); setMsg(''); try { await api(`/t/${tenant.id}/ops/events/${ev.id}`, { method: 'PATCH', body }); onChange(); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not save.'); } };
  return (
    <div className="drawer" role="dialog" aria-label={ev.title}><div className="drawer-in stack">
      <div className="row"><h2>{ev.title}</h2><button className="linklike" onClick={onClose}>Close</button></div>
      <p className="muted">{KIND[ev.kind]} · {new Date(ev.startsAt).toLocaleString()} · {ev.status}</p>
      <section className="stack sub">
        <h3>Permission</h3>
        <div className="two">
          <label>Status<select value={perm.permissionStatus} onChange={(e) => setPerm({ ...perm, permissionStatus: e.target.value })}>{Object.entries(PERM).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Reference number<input value={perm.permissionRef} onChange={(e) => setPerm({ ...perm, permissionRef: e.target.value })} /></label>
        </div>
        <div className="actions"><button className="btn" onClick={() => patch({ ...perm, permissionRef: perm.permissionRef || undefined })}>Save permission</button>
          <button className="btn primary" onClick={() => patch({ status: 'confirmed' })}>Confirm event</button></div>
      </section>
      <section className="stack sub">
        <h3>After the event</h3>
        <div className="two"><label>Total cost ({cur})<input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" /></label>
          <div className="stack" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => cost && patch({ status: 'done', costMinor: toMinor(cost) })}>Mark done and record cost</button></div></div>
        {ev.costMinor && <p className="muted small">Recorded: {money(ev.costMinor, cur)}, added to the finance register.</p>}
      </section>
      <section className="stack sub">
        <h3>Volunteer shifts</h3>
        {ev.shifts.map((s: any) => (
          <div key={s.id} className="shift"><div><strong>{s.title}</strong> <span className="muted">{s.assigned} of {s.needed} filled</span></div>
            <div className="actions">
              <select multiple value={pick} onChange={(e) => setPick([...e.target.selectedOptions].map((o) => o.value))} className="multi" aria-label="Volunteers">{vols.slice(0, 60).map((v: any) => <option key={v.id} value={v.id}>{v.name ?? '–'}{v.area ? ` · ${v.area}` : ''}</option>)}</select>
              <button className="btn small" onClick={async () => { if (pick.length) { await api(`/t/${tenant.id}/ops/shifts/${s.id}/assign`, { body: { contactIds: pick } }); setPick([]); onChange(); } }}>Add selected</button>
              <button className="btn small" onClick={async () => { try { const r = await api(`/t/${tenant.id}/ops/shifts/${s.id}/remind`, { method: 'POST' }); setMsg(r.queued ? 'Reminders are being sent in the background.' : `${r.sent} reminders sent${r.simulated ? ' (simulated)' : ''}, ${r.skipped} skipped (no consent for texts).`); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not send.'); } }}>Send reminders</button>
            </div></div>
        ))}
        <div className="two"><label>New shift<input value={shift.title} onChange={(e) => setShift({ ...shift, title: e.target.value })} placeholder="e.g. Setup and chairs" /></label>
          <label>People needed<input type="number" min={1} value={shift.needed} onChange={(e) => setShift({ ...shift, needed: Number(e.target.value) })} /></label></div>
        <button className="btn" onClick={async () => { if (shift.title) { await api(`/t/${tenant.id}/ops/shifts`, { body: { eventId: ev.id, title: shift.title, needed: shift.needed, startsAt: ev.startsAt } }); setShift({ title: '', needed: 5 }); onChange(); } }}>Add shift</button>
      </section>
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </div></div>
  );
}
