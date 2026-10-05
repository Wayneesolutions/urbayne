import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { ShellCtx } from '../App';

export const STATUS: Record<string, string> = { new: 'New', assigned: 'Assigned', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed', rejected: 'Not accepted' };
const NEXT: Record<string, string[]> = { new: ['assigned', 'in_progress', 'resolved', 'rejected'], assigned: ['in_progress', 'resolved', 'rejected'], in_progress: ['resolved', 'rejected'], resolved: ['closed', 'in_progress'], closed: [], rejected: [] };
const CHANNEL: Record<string, string> = { web: 'Web form', sms: 'Text', voice: 'Helpline', office: 'Office' };
const EVENT: Record<string, string> = { created: 'Received', assigned: 'Assigned', status: 'Status', note: 'Note', edited: 'Changed', ack_sent: 'Acknowledgement text sent', update_sent: 'Status text sent', sms_failed: 'Text not sent' };

const when = (d?: string) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–');

export function Service() {
  const { tenant: t, role } = useOutletContext<ShellCtx>();
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [cats, setCats] = useState<any[]>([]);
  const [areas, setAreas] = useState<any[]>([]);
  const [team, setTeam] = useState<any[]>([]);
  const [f, setF] = useState({ open: '1', category: '', assigned: '', q: '', overdue: false });
  const [open, setOpen] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [msg, setMsg] = useState('');
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (f.open) p.set('open', '1');
    if (f.category) p.set('category', f.category);
    if (f.assigned) p.set('assigned', f.assigned);
    if (f.q.trim()) p.set('q', f.q.trim());
    if (f.overdue) p.set('overdue', '1');
    return p.toString();
  }, [f]);
  const load = () => api(`/t/${t.id}/service/tickets?${query}`).then((r) => { setItems(r.items); setTotal(r.total); });
  useEffect(() => { load(); }, [query, t.id]);
  useEffect(() => {
    api(`/t/${t.id}/service/categories`).then(setCats);
    api(`/t/${t.id}/geo`).then(setAreas);
    api(`/t/${t.id}/service/team`).then(setTeam);
  }, [t.id]);

  return (
    <>
      <header className="page-head row">
        <div><h1>Requests from residents</h1>
          <p className="muted">Requests arrive from the web page, text messages, the voice helpline and your office. Each gets a number, goes to the team member for its area, and the resident is told by text when it moves.</p></div>
        <div className="actions"><button className="btn primary" onClick={() => setShowNew(true)}>New request</button></div>
      </header>
      {t.slug && <p className="muted small">Page for residents: <span className="mono-ish">{`${location.origin}/help/${t.slug}`}</span></p>}
      {msg && <p className="ok">{msg}</p>}

      <div className="panel inline-form">
        <label>Show<select value={f.open} onChange={(e) => setF({ ...f, open: e.target.value })}><option value="1">Open requests</option><option value="">All requests</option></select></label>
        <label>Category<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All</option>{cats.map((c) => <option key={c.key} value={c.key}>{c.en}</option>)}</select></label>
        <label>Assigned to<select value={f.assigned} onChange={(e) => setF({ ...f, assigned: e.target.value })}><option value="">Anyone</option><option value="me">Me</option><option value="unassigned">Nobody yet</option>{team.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.role}</option>)}</select></label>
        <label>Search<input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="number, words, name" /></label>
        <label className="check"><input type="checkbox" checked={f.overdue} onChange={(e) => setF({ ...f, overdue: e.target.checked })} />Overdue only</label>
      </div>

      <table className="table">
        <thead><tr><th>No.</th><th>Request</th><th>Category</th><th>Area</th><th>Status</th><th>With</th><th>Due</th></tr></thead>
        <tbody>
          {items.map((x) => (
            <tr key={x.id} className="clickable" onClick={() => setOpen(x.id)}>
              <td className="mono-ish">{x.ref}</td>
              <td>{x.title}<div className="muted small">{CHANNEL[x.channel]}{x.requesterName ? ` · ${x.requesterName}` : ''}{x.phone ? ` · ${x.phone}` : ''}</div></td>
              <td>{x.category}</td>
              <td>{x.area ?? '–'}</td>
              <td><span className={`badge tk-${x.status}`}>{STATUS[x.status]}</span>{x.priority !== 'normal' && <span className={`badge pr-${x.priority}`}>{x.priority}</span>}</td>
              <td>{x.assignee ?? <span className="muted">nobody yet</span>}</td>
              <td className={x.overdue ? 'err-text' : ''}>{when(x.dueAt)}{x.overdue && ' · overdue'}</td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={7} className="muted">No requests match.</td></tr>}
        </tbody>
      </table>
      <p className="muted small">{total} request{total === 1 ? '' : 's'}{total > items.length ? `, showing the newest ${items.length}` : ''}.</p>

      {showNew && <NewRequest tenantId={t.id} cats={cats} areas={areas} onClose={() => setShowNew(false)} onDone={(m) => { setShowNew(false); setMsg(m); load(); }} />}
      {open && <Detail tenantId={t.id} id={open} role={role} team={team} areas={areas} onClose={() => { setOpen(null); load(); }} />}
    </>
  );
}

function NewRequest({ tenantId, cats, areas, onClose, onDone }: { tenantId: string; cats: any[]; areas: any[]; onClose: () => void; onDone: (m: string) => void }) {
  const [form, setForm] = useState({ title: '', description: '', category: '', areaId: '', name: '', phone: '', smsConsent: false, priority: 'normal' });
  const [err, setErr] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try {
      const r = await api(`/t/${tenantId}/service/tickets`, { body: {
        title: form.title, description: form.description || undefined, category: form.category || undefined, areaId: form.areaId || undefined,
        name: form.name || undefined, phone: form.phone || undefined, smsConsent: form.smsConsent, priority: form.priority } });
      onDone(`Request ${r.ref} recorded.${r.noTexts ? ' ' + r.noTexts : ''}`);
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not save.'); }
  }
  return (
    <div className="drawer" onClick={onClose}><div className="drawer-in" onClick={(e) => e.stopPropagation()}>
      <h2>New request</h2>
      <form className="stack" onSubmit={save}>
        <label>What is the problem?<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required minLength={3} /></label>
        <label>Details<textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <label>Category<select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}><option value="">Work it out from the words</option>{cats.map((c) => <option key={c.key} value={c.key}>{c.en}</option>)}</select></label>
        <label>Area<select value={form.areaId} onChange={(e) => setForm({ ...form, areaId: e.target.value })}><option value="">–</option>{areas.map((a) => <option key={a.id} value={a.id}>{a.nameEn}</option>)}</select></label>
        <label>Priority<select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
        <label>Resident's name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Mobile<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+91…" /></label>
        <label className="check"><input type="checkbox" checked={form.smsConsent} disabled={!form.phone} onChange={(e) => setForm({ ...form, smsConsent: e.target.checked })} />The resident agreed to texts about this request</label>
        {err && <p className="err">{err}</p>}
        <div className="actions"><button className="btn primary">Save request</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
      </form>
    </div></div>
  );
}

function Detail({ tenantId, id, role, team, areas, onClose }: { tenantId: string; id: string; role: string; team: any[]; areas: any[]; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  const [note, setNote] = useState('');
  const [vis, setVis] = useState('internal');
  const [resolution, setResolution] = useState('');
  const [err, setErr] = useState('');
  const [meId, setMeId] = useState('');
  useEffect(() => { api('/auth/me').then((m) => setMeId(m.user?.id ?? '')); }, []);
  const load = () => api(`/t/${tenantId}/service/tickets/${id}`).then((x) => { setD(x); setResolution(x.resolutionNote ?? ''); });
  useEffect(() => { load(); }, [id]);
  const send = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); await load(); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not save.'); } };
  const patch = (body: object) => send(() => api(`/t/${tenantId}/service/tickets/${id}`, { method: 'PATCH', body }));
  if (!d) return <div className="drawer"><div className="drawer-in muted">Loading…</div></div>;
  const closedOut = Boolean(d.scrubbedAt);
  const needsNote = (s: string) => s === 'resolved' || s === 'rejected';
  return (
    <div className="drawer" onClick={onClose}><div className="drawer-in" onClick={(e) => e.stopPropagation()}>
      <div className="row"><h2>{d.ref} <span className={`badge tk-${d.status}`}>{STATUS[d.status]}</span></h2><button className="btn small" onClick={onClose}>Close</button></div>
      <p className="body-text">{d.title}{d.description ? `\n\n${d.description}` : ''}</p>
      <dl className="facts">
        <dt>Category</dt><dd>{d.category}</dd>
        <dt>Area</dt><dd>{d.area ?? d.areaText ?? '–'}</dd>
        <dt>Resident</dt><dd>{d.requesterName ?? '–'}{d.phone ? ` · ${d.phone}` : ''}{d.optedOut && ' · asked not to be texted'}</dd>
        <dt>How it arrived</dt><dd>{CHANNEL[d.channel]}</dd>
        <dt>Received</dt><dd>{when(d.createdAt)}</dd>
        <dt>Due</dt><dd>{when(d.dueAt)}</dd>
        <dt>Acknowledged</dt><dd>{when(d.acknowledgedAt)}</dd>
      </dl>
      {closedOut && <p className="muted">Personal details were removed from this request. It is kept for the figures only.</p>}
      {!closedOut && (
        <>
          <div className="stack">
            {(role === 'owner' || role === 'manager') && (
              <label>Assigned to<select value={d.assignedTo ?? ''} onChange={(e) => patch({ assignedTo: e.target.value || null })}><option value="">Nobody</option>{team.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.role}</option>)}</select></label>
            )}
            {role === 'service_staff' && !d.assignedTo && meId && <button className="btn" onClick={() => patch({ assignedTo: meId })}>Take this request</button>}
            <div className="row-wrap">
              <label>Priority<select value={d.priority} onChange={(e) => patch({ priority: e.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
              <label>Area<select value={d.geoAreaId ?? ''} onChange={(e) => patch({ areaId: e.target.value || null })}><option value="">–</option>{areas.map((a: any) => <option key={a.id} value={a.id}>{a.nameEn}</option>)}</select></label>
            </div>
            {NEXT[d.status].length > 0 && (
              <div className="approve">
                <label>What was done / why not accepted<textarea rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="Needed to resolve or reject" /></label>
                <div className="actions">
                  {NEXT[d.status].map((s) => (
                    <button key={s} className={`btn small ${s === 'resolved' ? 'primary' : ''}`} onClick={() => patch({ status: s, ...(needsNote(s) ? { resolutionNote: resolution } : {}) })}>{s === 'in_progress' && d.status === 'resolved' ? 'Reopen' : `Mark ${STATUS[s].toLowerCase()}`}</button>
                  ))}
                </div>
                <p className="muted small">The resident gets a text when a request is taken up, resolved or not accepted (only if they agreed to texts).</p>
              </div>
            )}
          </div>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); send(async () => { await api(`/t/${tenantId}/service/tickets/${id}/notes`, { body: { body: note, visibility: vis } }); setNote(''); }); }}>
            <label>Add a note<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} required /></label>
            <div className="actions"><select value={vis} onChange={(e) => setVis(e.target.value)}><option value="internal">Team only</option><option value="public">Visible to the resident</option></select><button className="btn small">Add note</button></div>
          </form>
        </>
      )}
      {err && <p className="err">{err}</p>}
      <h3>Timeline</h3>
      <ul className="timeline">
        {d.events.map((e: any) => (
          <li key={e.id}><strong>{EVENT[e.kind] ?? e.kind}</strong>{e.visibility === 'public' && <span className="badge">resident can see</span>} <span className="muted small">{when(e.at)}{e.actor ? ` · ${e.actor}` : ''}</span>
            {e.body && <div>{e.body}</div>}</li>
        ))}
      </ul>
    </div></div>
  );
}
