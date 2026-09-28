import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { ShellCtx } from '../App';

interface Item { id: string; kind: string; locale: string; title: string; body: string; status: string; certificateNo?: string; survey?: { key: string; question: string; options: { value: string; label: string; dtmf: string }[] }[] }
const KIND: Record<string, string> = { script: 'Call script', sms_template: 'SMS', page: 'Voter page block', faq: 'Assistant answer', ad: 'Share message' };

export function Content() {
  const { tenant: t, role } = useOutletContext<ShellCtx>();
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState<Item | null>(null);
  const [creating, setCreating] = useState(false);
  const load = () => api<Item[]>(`/t/${t.id}/content`).then(setItems);
  useEffect(() => { load(); }, [t.id]);

  return (
    <>
      <header className="page-head row">
        <div><h1>Content and approvals</h1><p className="muted">{t.region === 'IN'
          ? 'Scripts, SMS and share messages need an MCMC certificate number before they can go out. Editing anything sends it back to draft.'
          : 'Everything voters hear or read needs the candidate’s approval. Editing anything sends it back to draft.'}</p></div>
        {role !== 'field_worker' && <button className="btn primary" onClick={() => setCreating(true)}>New content</button>}
      </header>
      <table className="table">
        <thead><tr><th>Title</th><th>Type</th><th>Language</th><th>Status</th></tr></thead>
        <tbody>{items.map((i) => (
          <tr key={i.id} onClick={() => setOpen(i)} className="clickable">
            <td>{i.title}</td><td>{KIND[i.kind]}</td><td>{i.locale.toUpperCase()}</td>
            <td><Status s={i.status} cert={i.certificateNo} /></td>
          </tr>
        ))}</tbody>
      </table>
      {open && <ItemDrawer item={open} tenant={t} canApprove={role === 'owner'} onClose={() => setOpen(null)} onChange={() => { load(); setOpen(null); }} />}
      {creating && <NewItem tenant={t} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
    </>
  );
}

export function Status({ s, cert }: { s: string; cert?: string | null }) {
  const label = s === 'certified' ? `Certified${cert ? ` · ${cert}` : ''}` : s === 'approved' ? 'Approved' : 'Draft';
  return <span className={`badge ${s}`}>{label}</span>;
}

function ItemDrawer({ item, tenant, canApprove, onClose, onChange }: { item: Item; tenant: ShellCtx['tenant']; canApprove: boolean; onClose: () => void; onChange: () => void }) {
  const [cert, setCert] = useState('');
  const [err, setErr] = useState('');
  const needsCert = tenant.region === 'IN' && ['script', 'sms_template', 'ad'].includes(item.kind);
  async function approve() {
    setErr('');
    try { await api(`/t/${tenant.id}/content/${item.id}/approve`, { body: needsCert ? { certificateNo: cert } : {} }); onChange(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not approve.'); }
  }
  return (
    <div className="drawer" role="dialog" aria-label={item.title}>
      <div className="drawer-in">
        <div className="row"><h2>{item.title}</h2><button className="linklike" onClick={onClose}>Close</button></div>
        <p className="muted">{KIND[item.kind]} · {item.locale.toUpperCase()} · <Status s={item.status} cert={item.certificateNo} /></p>
        <div className="body-text" lang={item.locale}>{item.body}</div>
        {item.survey?.map((q) => (
          <div key={q.key} className="survey-q"><strong lang={item.locale}>{q.question}</strong>
            <ul>{q.options.map((o) => <li key={o.value}><kbd>{o.dtmf}</kbd> <span lang={item.locale}>{o.label}</span></li>)}</ul></div>
        ))}
        {item.status === 'draft' && canApprove && (
          <div className="stack approve">
            {needsCert && <label>MCMC certificate number<input value={cert} onChange={(e) => setCert(e.target.value)} placeholder="e.g. MCMC/LDH/0042" /></label>}
            <button className="btn primary" onClick={approve}>{needsCert ? 'Record certificate and approve' : 'Approve'}</button>
            {err && <p className="err">{err}</p>}
          </div>
        )}
        {item.status === 'draft' && !canApprove && <p className="muted">Only the candidate can approve content.</p>}
      </div>
    </div>
  );
}

function NewItem({ tenant, onClose, onCreated }: { tenant: ShellCtx['tenant']; onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState('faq');
  const [locale, setLocale] = useState(tenant.region === 'IN' ? 'pa' : 'en');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState('');
  const [err, setErr] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    const survey = kind === 'script' && question.trim() ? [{
      key: 'q1', question,
      options: options.split('\n').map((l) => l.trim()).filter(Boolean).map((label, i) => ({ value: `opt${i + 1}`, label, dtmf: String(i + 1) })),
    }] : undefined;
    try { await api(`/t/${tenant.id}/content`, { body: { kind, locale, title, body, survey } }); onCreated(); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not save.'); }
  }
  return (
    <div className="drawer" role="dialog" aria-label="New content">
      <form className="drawer-in stack" onSubmit={save}>
        <div className="row"><h2>New content</h2><button type="button" className="linklike" onClick={onClose}>Cancel</button></div>
        <div className="two">
          <label>Type<select value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Language<select value={locale} onChange={(e) => setLocale(e.target.value)}>{(tenant.region === 'IN' ? ['pa', 'hi', 'en'] : ['en', 'pa', 'hi', 'tl', 'fr']).map((l) => <option key={l}>{l}</option>)}</select></label>
        </div>
        <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
        <label>Text<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} required lang={locale} /></label>
        {kind === 'script' && <p className="muted small">Call scripts must start with the AI disclosure line for this language, or approval will be refused.</p>}
        {kind === 'script' && <>
          <label>Survey question (optional)<input value={question} onChange={(e) => setQuestion(e.target.value)} lang={locale} /></label>
          <label>Answer options, one per line (keypad 1, 2, 3…)<textarea value={options} onChange={(e) => setOptions(e.target.value)} rows={4} lang={locale} /></label>
        </>}
        <button className="btn primary">Save as draft</button>
        {err && <p className="err">{err}</p>}
      </form>
    </div>
  );
}
