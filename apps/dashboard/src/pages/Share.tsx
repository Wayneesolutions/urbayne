import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError, session } from '../api';
import type { ShellCtx } from '../App';

export function Share() {
  const { tenant: t } = useOutletContext<ShellCtx>();
  const [links, setLinks] = useState<any[]>([]);
  const [areas, setAreas] = useState<any[]>([]);
  const [ads, setAds] = useState<any[]>([]);
  const [form, setForm] = useState({ label: '', geoAreaId: '' });
  const [qr, setQr] = useState<{ code: string; url: string } | null>(null);
  const [copied, setCopied] = useState('');
  const [err, setErr] = useState('');
  const load = () => api(`/t/${t.id}/share-links`).then(setLinks);
  useEffect(() => {
    load();
    api(`/t/${t.id}/geo`).then((g) => setAreas(g.filter((a: any) => a.parentId)));
    api(`/t/${t.id}/content`).then((c) => setAds(c.filter((i: any) => i.kind === 'ad' && i.status !== 'draft')));
  }, [t.id]);

  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try { await api(`/t/${t.id}/share-links`, { body: { label: form.label, geoAreaId: form.geoAreaId || undefined } }); setForm({ label: '', geoAreaId: '' }); load(); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not create.'); }
  }
  async function copy(code: string) {
    if (!ads[0]) { setErr('Approve a share message first (Content → Share message).'); return; }
    const m = await api(`/t/${t.id}/share-links/${code}/message?contentId=${ads[0].id}`);
    await navigator.clipboard.writeText(m.text).catch(() => {});
    setCopied(code); setTimeout(() => setCopied(''), 2000);
  }
  async function showQr(code: string) {
    const r = await fetch(`/api/t/${t.id}/share-links/${code}/qr.svg`, { headers: { authorization: `Bearer ${session.token}` } });
    setQr({ code, url: URL.createObjectURL(await r.blob()) });
  }
  return (
    <>
      <header className="page-head"><h1>Share links</h1>
        <p className="muted">Give each booth worker or poster their own link. They paste the approved message into WhatsApp themselves; the platform never sends WhatsApp messages. Each link counts opens and sign-ups.</p></header>
      <form className="panel inline-form" onSubmit={create}>
        <label>Who or where<input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required placeholder="e.g. Booth 12 – Harjit" /></label>
        <label>Area<select value={form.geoAreaId} onChange={(e) => setForm({ ...form, geoAreaId: e.target.value })}><option value="">–</option>{areas.map((a) => <option key={a.id} value={a.id}>{a.nameEn}</option>)}</select></label>
        <button className="btn primary">Create link</button>
        {err && <p className="err">{err}</p>}
      </form>
      <table className="table">
        <thead><tr><th>Link for</th><th>Address</th><th>Opens</th><th>Sign-ups</th><th /></tr></thead>
        <tbody>{links.map((l) => (
          <tr key={l.id}><td>{l.label}</td><td className="mono-ish">{l.url}</td><td>{l.clicks}</td><td>{l.signups}</td>
            <td className="actions"><button className="btn small" onClick={() => copy(l.code)}>{copied === l.code ? 'Copied' : 'Copy message'}</button><button className="btn small" onClick={() => showQr(l.code)}>QR code</button></td></tr>
        ))}</tbody>
      </table>
      {qr && <div className="drawer" role="dialog" aria-label="QR code"><div className="drawer-in"><div className="row"><h2>QR code for print</h2><button className="linklike" onClick={() => setQr(null)}>Close</button></div>
        <img src={qr.url} alt="QR code" className="qr" /><a className="btn" href={qr.url} download={`qr-${qr.code}.svg`}>Download SVG</a></div></div>}
    </>
  );
}
