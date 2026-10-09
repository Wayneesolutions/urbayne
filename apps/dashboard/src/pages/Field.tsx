import { useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError, errText, upload } from '../api';
import { MapView, toLayers, type MapLayer } from '../maps';
import type { ShellCtx } from '../App';

const RES = [
  ['supporter', 'Supporter'], ['undecided', 'Undecided'], ['not_interested', 'Not interested'], ['not_home', 'Not home'], ['needs_help', 'Needs help'], ['wants_sign', 'Wants a sign'],
] as const;

export function Field() {
  const { tenant: t, role } = useOutletContext<ShellCtx>();
  const [turfs, setTurfs] = useState<any[]>([]);
  const [summary, setSummary] = useState<any[]>([]);
  const [areas, setAreas] = useState<any[]>([]);
  const [workers, setWorkers] = useState<any[]>([]);
  const [form, setForm] = useState({ geoAreaId: '', name: '', assignedUserId: '' });
  const [err, setErr] = useState('');
  const load = () => { api(`/t/${t.id}/field/turfs`).then(setTurfs); api(`/t/${t.id}/field/summary`).then(setSummary); };
  const loadAreas = () => api(`/t/${t.id}/geo`).then((g) => setAreas(g.filter((a: any) => a.parentId)));
  useEffect(() => {
    load(); loadAreas();
    api(`/t/${t.id}/members`).then((m) => setWorkers(m.filter((x: any) => ['field_worker', 'coordinator'].includes(x.role))));
  }, [t.id]);
  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try { await api(`/t/${t.id}/field/turfs`, { body: { geoAreaId: form.geoAreaId, name: form.name, assignedUserId: form.assignedUserId || null } }); setForm({ geoAreaId: '', name: '', assignedUserId: '' }); load(); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not create.'); }
  }
  async function assign(turfId: string, userId: string) { await api(`/t/${t.id}/field/turfs/${turfId}`, { method: 'PATCH', body: { assignedUserId: userId || null } }); load(); }
  const cols = RES.filter(([k]) => t.region === 'CA' || k !== 'wants_sign');
  const manager = ['owner', 'manager', 'coordinator'].includes(role);

  // Each area on the map, greener the more of its households have been visited.
  const layers = useMemo<MapLayer[]>(() => turfs.flatMap((x) => {
    const pct = x.households ? Math.min(1, x.visited / x.households) : 0;
    const color = pct >= 0.66 ? '#2F7D5B' : pct >= 0.25 ? '#E8A317' : '#B54A2C';
    return toLayers(x.shape, color, `${x.name}: ${x.visited} of ${x.households} households (${Math.round(pct * 100)}%)`);
  }), [turfs]);

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
        <h2>Map</h2>
        <p className="muted small">Areas that have a position on the map, coloured by how many households have been visited. Red is under 25%, amber under 66%, green above.</p>
        {layers.length ? <MapView layers={layers} label="Map of canvassing areas by progress" height={420} /> : <p className="muted">No area has a position yet. Place one below.</p>}
        {manager && <PlaceArea tenantId={t.id} areas={areas} onSaved={() => { loadAreas(); load(); }} />}
      </section>

      {manager && <RollImport tenantId={t.id} areas={areas} onDone={load} />}

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

/** Puts an area on the map as a point (latitude and longitude, as a phone's map app shows them). */
function PlaceArea({ tenantId, areas, onSaved }: { tenantId: string; areas: any[]; onSaved: () => void }) {
  const [f, setF] = useState({ id: '', lat: '', lng: '' });
  const [err, setErr] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try { await api(`/t/${tenantId}/geo/${f.id}`, { method: 'PATCH', body: { shape: { type: 'Point', coordinates: [Number(f.lng), Number(f.lat)] } } }); setF({ id: '', lat: '', lng: '' }); onSaved(); }
    catch (x) { setErr(errText(x, 'Could not place the area.')); }
  }
  return (
    <form className="inline-form" onSubmit={save}>
      <label>Put an area on the map<select value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} required><option value="">Choose…</option>{areas.map((a) => <option key={a.id} value={a.id}>{a.nameEn}{a.polygon ? ' (placed)' : ''}</option>)}</select></label>
      <label>Latitude<input value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} inputMode="decimal" placeholder="30.9010" required /></label>
      <label>Longitude<input value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} inputMode="decimal" placeholder="75.8573" required /></label>
      <button className="btn">Place</button>
      {err && <p className="err">{err}</p>}
    </form>
  );
}

/** Household lists from the electoral roll copy the candidate legally receives. The copy itself is kept as proof. */
function RollImport({ tenantId, areas, onDone }: { tenantId: string; areas: any[]; onDone: () => void }) {
  const [imports, setImports] = useState<any[]>([]);
  const [areaId, setAreaId] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const loadList = () => api(`/t/${tenantId}/field/roll-imports`).then(setImports).catch(() => {});
  useEffect(() => { loadList(); }, [tenantId]);
  async function send(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const f = file.current?.files?.[0];
    if (!f) return setMsg({ ok: false, text: 'Choose the roll copy file (Excel or CSV).' });
    setBusy(true);
    try {
      const r = await upload(`/t/${tenantId}/field/roll-imports/spreadsheet?areaId=${areaId}&sourceDescription=${encodeURIComponent(source)}`, f, f.name);
      setMsg({ ok: true, text: `${r.households} households added${r.alreadyOnFile ? `, ${r.alreadyOnFile} were already on file` : ''}${r.rejected ? `, ${r.rejected} rows had no house number` : ''}. Columns not kept: ${r.ignoredColumns.join(', ') || 'none'}.` });
      if (file.current) file.current.value = '';
      loadList(); onDone();
    } catch (x) { setMsg({ ok: false, text: errText(x, 'Could not import.') }); }
    finally { setBusy(false); }
  }
  return (
    <section className="panel">
      <h2>Household lists from the electoral roll</h2>
      <p className="muted small">Upload the roll copy you legally received (Excel or CSV), one booth or area at a time. Only the house number, address and number of electors are kept: names, ages and relatives are dropped, and a file with caste or religion columns is refused. The file is kept as proof of where the list came from and is deleted with the other personal data after the election. For a PDF roll, ask your platform contact to load it as proof together with the typed-in households.</p>
      <form className="inline-form" onSubmit={send}>
        <label>Area<select value={areaId} onChange={(e) => setAreaId(e.target.value)} required><option value="">Choose…</option>{areas.map((a) => <option key={a.id} value={a.id}>{a.nameEn}</option>)}</select></label>
        <label style={{ flex: '2 1 280px' }}>Where did this list come from?<input value={source} onChange={(e) => setSource(e.target.value)} minLength={10} maxLength={500} required placeholder="e.g. Certified roll copy, Part 14, received from the ERO on 3 Jan 2027" /></label>
        <label>Roll copy<input ref={file} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" /></label>
        <button className="btn primary" disabled={busy}>{busy ? 'Importing…' : 'Import households'}</button>
      </form>
      {msg && <p className={msg.ok ? 'muted' : 'err'} role="status">{msg.text}</p>}
      {imports.length > 0 && <table className="table compact"><thead><tr><th>When</th><th>Area</th><th>Households</th><th>Source</th></tr></thead>
        <tbody>{imports.map((i) => <tr key={i.id}><td>{new Date(i.createdAt).toLocaleDateString()}</td><td>{i.area}</td><td>{i.rowsImported}{i.rowsDuplicate ? ` (+${i.rowsDuplicate} already there)` : ''}</td><td className="small">{i.sourceDescription}</td></tr>)}</tbody></table>}
    </section>
  );
}
