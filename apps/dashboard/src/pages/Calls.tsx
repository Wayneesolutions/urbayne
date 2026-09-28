import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { api, ApiError, REASONS } from '../api';
import type { ShellCtx } from '../App';

const RUN_STATUS: Record<string, string> = { draft: 'Not started', running: 'Calling', paused: 'Paused', completed: 'Finished', blocked: 'Blocked' };

export function Calls() {
  const { tenant: t } = useOutletContext<ShellCtx>();
  const [runs, setRuns] = useState<any[]>([]);
  const [scripts, setScripts] = useState<any[]>([]);
  const [areas, setAreas] = useState<any[]>([]);
  const [form, setForm] = useState({ name: '', contentItemId: '', purpose: 'survey', geoAreaIds: [] as string[] });
  const [err, setErr] = useState('');
  const nav = useNavigate();
  useEffect(() => {
    api(`/t/${t.id}/calls/runs`).then(setRuns);
    api(`/t/${t.id}/content`).then((c) => setScripts(c.filter((i: any) => i.kind === 'script')));
    api(`/t/${t.id}/geo`).then((g) => setAreas(g.filter((a: any) => a.parentId)));
  }, [t.id]);

  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try {
      const r = await api(`/t/${t.id}/calls/runs`, { body: { name: form.name, contentItemId: form.contentItemId, purpose: form.purpose, audience: form.geoAreaIds.length ? { geoAreaIds: form.geoAreaIds } : {} } });
      nav(r.id);
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not create.'); }
  }
  return (
    <>
      <header className="page-head"><h1>Calls and surveys</h1>
        <p className="muted">{t.isDemo ? 'Demo campaign: calls are simulated, the rules are real.' : 'Every call is checked against the rules right before it is placed.'}</p></header>
      <form className="panel inline-form" onSubmit={create}>
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Issue survey, Model Town" /></label>
        <label>Script<select value={form.contentItemId} onChange={(e) => setForm({ ...form, contentItemId: e.target.value })} required>
          <option value="">Choose…</option>{scripts.map((s) => <option key={s.id} value={s.id}>{s.title} ({s.status})</option>)}</select></label>
        <label>Purpose<select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })}>
          <option value="survey">Survey</option><option value="info">Information</option><option value="reminder">Reminder</option></select></label>
        <label>Areas<select multiple value={form.geoAreaIds} onChange={(e) => setForm({ ...form, geoAreaIds: [...e.target.selectedOptions].map((o) => o.value) })} className="multi">
          {areas.map((a) => <option key={a.id} value={a.id}>{a.nameEn}</option>)}</select></label>
        <button className="btn primary">Create run</button>
        {err && <p className="err">{err}</p>}
      </form>
      <table className="table">
        <thead><tr><th>Run</th><th>Status</th><th>Answered</th><th>No answer</th><th>Blocked</th></tr></thead>
        <tbody>{runs.map((r) => (
          <tr key={r.id} className="clickable" onClick={() => nav(r.id)}>
            <td><Link to={r.id}>{r.name}</Link></td><td><span className={`badge run-${r.status}`}>{RUN_STATUS[r.status]}</span></td>
            <td>{r.counts.completed ?? 0}</td><td>{r.counts.no_answer ?? 0}</td><td>{r.counts.blocked ?? 0}</td>
          </tr>
        ))}</tbody>
      </table>
    </>
  );
}

const GATES: { key: string; label: string; codes: string[] }[] = [
  { key: 'approval', label: 'Script approved', codes: ['CONTENT_NOT_APPROVED', 'CERTIFICATE_MISSING', 'DLT_TEMPLATE_MISSING'] },
  { key: 'disclosure', label: 'Opens with AI disclosure', codes: ['DISCLOSURE_TEXT_MISSING_FOR_LOCALE', 'DISCLOSURE_MISSING', 'CAMPAIGN_NOT_IDENTIFIED'] },
  { key: 'silence', label: 'Outside the silence period', codes: ['POLL_CLOSE_NOT_SET', 'SILENCE_WINDOW'] },
  { key: 'hours', label: 'Within calling hours', codes: ['CALLING_HOURS_NOT_CONFIGURED', 'OUTSIDE_CALLING_HOURS'] },
  { key: 'purpose', label: 'Allowed call purpose', codes: ['DONATION_BLOCKED'] },
  { key: 'spend', label: 'Within spending limit', codes: ['SPEND_OVER_LIMIT'] },
];

export function RunDetail() {
  const { tenant: t } = useOutletContext<ShellCtx>();
  const { runId } = useParams();
  const [run, setRun] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [calls, setCalls] = useState<any[]>([]);
  const [preflight, setPreflight] = useState<{ allowed: boolean; reasons: { code: string }[] } | null>(null);
  const [err, setErr] = useState('');

  const loadRun = () => api(`/t/${t.id}/calls/runs`).then((rs) => setRun(rs.find((r: any) => r.id === runId)));
  const loadStats = () => Promise.all([
    api(`/t/${t.id}/calls/runs/${runId}/stats`).then(setStats),
    api(`/t/${t.id}/calls/runs/${runId}/interactions`).then(setCalls),
  ]);
  useEffect(() => { loadRun(); loadStats(); }, [runId]);
  useEffect(() => {
    if (run && (run.status === 'draft' || run.status === 'blocked')) {
      api(`/t/${t.id}/compliance/check`, { body: { contentItemId: run.contentItemId, channel: 'voice', purpose: run.purpose, scope: 'run' } }).then(setPreflight);
    }
  }, [run?.id, run?.status]);
  useEffect(() => {
    if (run?.status !== 'running') return;
    const h = setInterval(() => { loadStats(); loadRun(); }, 1500);
    return () => clearInterval(h);
  }, [run?.status]);

  async function act(action: 'start' | 'pause' | 'resume') {
    setErr('');
    try { await api(`/t/${t.id}/calls/runs/${runId}/${action}`, { method: 'POST' }); }
    catch (x) { if (x instanceof ApiError) setErr((x.body as any)?.reasons?.map((r: any) => REASONS[r.code] ?? r.code).join('; ') || x.message); }
    loadRun(); loadStats();
  }
  async function evidence() {
    const pack = await api(`/t/${t.id}/calls/runs/${runId}/evidence`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }));
    a.download = `evidence-${runId}.json`; a.click();
  }

  const failed = useMemo(() => new Set((preflight?.reasons ?? run?.gateResult?.reasons ?? []).map((r: any) => r.code)), [preflight, run]);
  if (!run) return <p className="muted">Loading…</p>;
  const done = (stats?.counts.completed ?? 0) + (stats?.counts.no_answer ?? 0) + (stats?.counts.failed ?? 0) + (stats?.counts.blocked ?? 0);
  const pct = stats?.total ? Math.round((done / stats.total) * 100) : 0;

  return (
    <>
      <header className="page-head row">
        <div><Link to=".." relative="path" className="muted small">All runs</Link><h1>{run.name}</h1>
          <span className={`badge run-${run.status}`}>{RUN_STATUS[run.status]}</span></div>
        <div className="actions">
          {(run.status === 'draft' || run.status === 'blocked') && <button className="btn primary" onClick={() => act('start')} disabled={preflight ? !preflight.allowed : false}>Start calling</button>}
          {run.status === 'running' && <button className="btn" onClick={() => act('pause')}>Pause</button>}
          {run.status === 'paused' && <button className="btn primary" onClick={() => act('resume')}>Resume</button>}
          {run.status !== 'draft' && <button className="btn" onClick={evidence}>Download evidence pack</button>}
        </div>
      </header>
      {err && <p className="err">{err}</p>}

      <div className="run-grid">
        <section className="gates" aria-label="Compliance checks">
          <h2>Rules check</h2>
          <ul>{GATES.map((g) => {
            const bad = g.codes.find((c) => failed.has(c));
            return <li key={g.key} className={bad ? 'fail' : 'pass'}><span className="gate-dot" aria-hidden="true" /><div><strong>{g.label}</strong>{bad && <span>{REASONS[bad]}</span>}</div></li>;
          })}
            <li className="pass per"><span className="gate-dot" aria-hidden="true" /><div><strong>Consent and opt-outs</strong><span>Checked for every person, right before each call{stats?.blockedReasons && Object.keys(stats.blockedReasons).length ? `: ${Object.entries(stats.blockedReasons).map(([k, n]) => `${n} × ${REASONS[k] ?? k}`).join(', ')}` : ''}</span></div></li>
          </ul>
        </section>

        <section className="panel">
          <h2>Progress</h2>
          <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
          <div className="figures small-figs">
            <div className="fig"><span className="fig-n">{stats?.counts.completed ?? 0}</span><span className="fig-l">answered</span></div>
            <div className="fig"><span className="fig-n">{stats?.counts.no_answer ?? 0}</span><span className="fig-l">no answer</span></div>
            <div className="fig"><span className="fig-n">{stats?.counts.blocked ?? 0}</span><span className="fig-l">stopped by rules</span></div>
            <div className="fig"><span className="fig-n">{stats?.optOuts ?? 0}</span><span className="fig-l">said stop</span></div>
            <div className="fig"><span className="fig-n">{stats?.followUps ?? 0}</span><span className="fig-l">want a callback</span></div>
          </div>
        </section>
      </div>

      {stats?.survey?.map((q: any) => {
        const total = q.options.reduce((a: number, o: any) => a + o.count, 0) || 1;
        const max = Math.max(...q.options.map((o: any) => o.count), 1);
        return (
          <section className="panel" key={q.key}>
            <h2 className="survey-title">{q.question}</h2>
            <div className="hbars">{[...q.options].sort((a: any, b: any) => b.count - a.count).map((o: any) => (
              <div className="hbar" key={o.value}><span className="hbar-l">{o.label}</span><span className="hbar-t"><span style={{ width: `${(o.count / max) * 100}%` }} /></span><span className="hbar-n">{o.count} <span className="muted">({Math.round((o.count / total) * 100)}%)</span></span></div>
            ))}</div>
            {q.byArea.length > 1 && (
              <table className="table compact"><thead><tr><th>Area</th>{q.options.map((o: any) => <th key={o.value}>{o.label}</th>)}</tr></thead>
                <tbody>{q.byArea.map((r: any) => {
                  const top = Object.entries(r.counts as Record<string, number>).sort((a, b) => b[1] - a[1])[0]?.[0];
                  return <tr key={r.area}><td>{r.area}</td>{q.options.map((o: any) => <td key={o.value} className={o.value === top ? 'top' : ''}>{r.counts[o.value] ?? 0}</td>)}</tr>;
                })}</tbody></table>
            )}
          </section>
        );
      })}

      <section className="panel">
        <h2>Latest calls</h2>
        <table className="table compact">
          <thead><tr><th>Person</th><th>Mobile</th><th>Result</th><th>Length</th><th /></tr></thead>
          <tbody>{calls.map((c) => <CallRow key={c.id} c={c} />)}</tbody>
        </table>
      </section>
    </>
  );
}

function CallRow({ c }: { c: any }) {
  const [open, setOpen] = useState(false);
  const label = c.status === 'blocked' ? `Stopped: ${(c.blockReasons ?? []).map((r: any) => REASONS[r.code] ?? r.code).join(', ')}` : c.optedOut ? 'Answered, said stop' : ({ completed: 'Answered', no_answer: 'No answer', failed: 'Failed', queued: 'Waiting', in_progress: 'On call' } as Record<string, string>)[c.status];
  return (
    <>
      <tr><td>{c.name ?? '–'}</td><td className="mono-ish">{c.phone}</td><td className={c.status === 'blocked' ? 'err-text' : ''}>{label}{c.followUp ? ' · wants a callback' : ''}</td><td>{c.durationSec ? `${c.durationSec}s` : '–'}</td>
        <td>{c.transcript && <button className="linklike" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Transcript'}</button>}</td></tr>
      {open && <tr className="transcript"><td colSpan={5}><pre>{c.transcript}</pre></td></tr>}
    </>
  );
}
