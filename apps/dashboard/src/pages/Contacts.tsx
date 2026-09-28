import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { ShellCtx } from '../App';

export function Contacts() {
  const { tenant: t } = useOutletContext<ShellCtx>();
  const [data, setData] = useState<{ total: number; optedOut: number; items: any[] } | null>(null);
  const [areas, setAreas] = useState<any[]>([]);
  const [form, setForm] = useState({ name: '', phone: '', geoAreaId: '', consent: true });
  const [err, setErr] = useState('');
  const load = () => api(`/t/${t.id}/contacts`).then(setData);
  useEffect(() => { load(); api(`/t/${t.id}/geo`).then(setAreas); }, [t.id]);

  async function add(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try {
      await api(`/t/${t.id}/contacts`, { body: {
        name: form.name || undefined, phone: form.phone, source: 'form', geoAreaId: form.geoAreaId || undefined,
        consents: form.consent ? ['info', 'survey', 'reminder'].map((purpose) => ({ purpose, channel: 'voice', textVersion: 'paper-v1', locale: t.region === 'IN' ? 'pa' : 'en', capturedVia: 'paper' })) : [],
      } });
      setForm({ name: '', phone: '', geoAreaId: '', consent: true }); load();
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not add.'); }
  }
  return (
    <>
      <header className="page-head"><h1>Contacts</h1>
        <p className="muted">{data ? `${data.total} people, ${data.optedOut} opted out. Numbers are stored encrypted and shown masked.` : 'Loading…'}</p></header>
      <form className="panel inline-form" onSubmit={add}>
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Mobile<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required placeholder="+91…" /></label>
        <label>Area<select value={form.geoAreaId} onChange={(e) => setForm({ ...form, geoAreaId: e.target.value })}><option value="">–</option>{areas.filter((a) => a.parentId).map((a) => <option key={a.id} value={a.id}>{a.nameEn}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} />Consent to calls recorded on paper</label>
        <button className="btn">Add contact</button>
        {err && <p className="err">{err}</p>}
      </form>
      <table className="table">
        <thead><tr><th>Name</th><th>Mobile</th><th>Area</th><th>Source</th><th>Status</th></tr></thead>
        <tbody>{data?.items.map((c) => (
          <tr key={c.id}><td>{c.name ?? '–'}</td><td className="mono-ish">{c.phone}</td><td>{c.area ?? '–'}</td><td>{c.source}</td>
            <td>{c.optedOut ? <span className="badge blocked">Opted out</span> : <span className="badge approved">Active</span>}</td></tr>
        ))}</tbody>
      </table>
    </>
  );
}
