import { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError, session } from '../api';
import type { ShellCtx } from '../App';

type Tab = 'poll' | 'counting' | 'flags' | 'setup' | 'archive';
const TABS: [Tab, string][] = [['poll', 'Poll day'], ['counting', 'Counting'], ['flags', 'Needs a look'], ['setup', 'Setup'], ['archive', 'Archive']];
const pct = (x: number | null) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
const clock = (d?: string | null) => (d ? new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '–');
const num = (n: number | null | undefined) => (n == null ? '–' : n.toLocaleString());

/** Sends a CSV file as text (the JSON helper cannot). */
async function postCsv(path: string, body: string) {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'text/csv', authorization: `Bearer ${session.token}` }, body });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, j.error ?? 'ERROR', j.message ?? j.error ?? 'Failed', j);
  return j;
}

export function Results() {
  const { tenant: t, role } = useOutletContext<ShellCtx>();
  const [tab, setTab] = useState<Tab>('poll');
  return (
    <>
      <header className="page-head"><h1>Poll day and counting</h1>
        <p className="muted">Numbers reported by your own agents, shown next to the official figures your team types in. Nothing here is connected to any official system: "official" means someone on the team read it from the official site and entered it, with the source written down.</p></header>
      <div className="tabs">{TABS.map(([k, label]) => <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{label}</button>)}</div>
      {tab === 'poll' && <PollDay tenantId={t.id} />}
      {tab === 'counting' && <Counting tenantId={t.id} role={role} />}
      {tab === 'flags' && <Flags tenantId={t.id} role={role} />}
      {tab === 'setup' && <Setup tenantId={t.id} role={role} />}
      {tab === 'archive' && <Archive tenantId={t.id} role={role} />}
      <p className="muted small">Agents report from the phone app at <span className="mono-ish">{location.origin}/r/</span> or by text: <span className="mono-ish">VOTE B045 312</span> (turnout so far) and <span className="mono-ish">COUNT R3 A 4521 B 3980</span> (a counting round).</p>
    </>
  );
}

function useLoad<T>(path: string, every = 0) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const load = () => api(path).then((d) => { setData(d); setErr(''); }).catch((x) => setErr(x instanceof ApiError ? x.message : 'Could not load.'));
  useEffect(() => { load(); if (!every) return; const i = setInterval(load, every); return () => clearInterval(i); }, [path]);
  return { data, err, reload: load };
}

function PollDay({ tenantId }: { tenantId: string }) {
  const { data: s, err } = useLoad<any>(`/t/${tenantId}/results/turnout`, 30_000);
  if (err) return <p className="err">{err}</p>;
  if (!s) return <p className="muted">Loading…</p>;
  const maxV = Math.max(1, ...s.timeline.map((x: any) => x.votes));
  return (
    <>
      <p className="label-pill">{s.label}</p>
      <div className="cards">
        <div className="card"><span className="muted">Stations reported</span><strong>{s.totals.reported} / {s.totals.stations}</strong></div>
        <div className="card"><span className="muted">Votes polled so far</span><strong>{num(s.totals.votes)}</strong></div>
        <div className="card"><span className="muted">Turnout (stations reported)</span><strong>{pct(s.totals.turnoutPct)}</strong></div>
        <div className="card"><span className="muted">Registered electors</span><strong>{num(s.totals.electorsAll)}</strong></div>
      </div>
      {s.timeline.length > 0 && (
        <>
          <h3>Running total by the hour</h3>
          <div className="trend">{s.timeline.map((h: any) => (
            <div className="trend-col" key={h.at}><div className="bars"><span className="bar done" style={{ height: `${(h.votes / maxV) * 100}%` }} title={`${h.votes} votes from ${h.stations} stations`} /></div>
              <span className="muted small">{clock(h.at)}</span><span className="small">{num(h.votes)}</span></div>
          ))}</div>
        </>
      )}
      <h3>By station</h3>
      <table className="table compact">
        <thead><tr><th>Code</th><th>Station</th><th>Electors</th><th>Votes</th><th>Turnout</th><th>Last report</th><th /></tr></thead>
        <tbody>{s.stations.map((x: any) => (
          <tr key={x.areaId} className={x.votes == null ? 'muted-row' : ''}>
            <td className="mono-ish">{x.code ?? ''}</td><td>{x.name}</td><td>{num(x.electors)}</td><td>{x.votes == null ? <span className="muted">no report yet</span> : num(x.votes)}</td>
            <td>{pct(x.pct)}</td><td>{x.asOf ? `${clock(x.asOf)} · ${x.channel}` : '–'}</td>
            <td>{x.openFlags > 0 && <span className="badge blocked" title="A report here needs a second look">{x.openFlags} to check</span>}</td>
          </tr>
        ))}</tbody>
      </table>
    </>
  );
}

function Counting({ tenantId, role }: { tenantId: string; role: string }) {
  const { data: c, err, reload } = useLoad<any>(`/t/${tenantId}/results/counting`, 30_000);
  const [form, setForm] = useState({ kind: 'round', unit: '', candidate: '', votes: '', note: '' });
  const [msg, setMsg] = useState('');
  const [e2, setE2] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const canEdit = role === 'owner' || role === 'manager';
  if (err) return <p className="err">{err}</p>;
  if (!c) return <p className="muted">Loading…</p>;
  async function addOfficial(e: React.FormEvent) {
    e.preventDefault(); setE2(''); setMsg('');
    try {
      const entry: any = { kind: form.kind, candidateCode: form.candidate, votes: Number(form.votes) };
      if (form.kind === 'round') entry.roundNo = Number(form.unit); else entry.areaCode = form.unit;
      const r = await api(`/t/${tenantId}/results/official`, { body: { sourceNote: form.note, entries: [entry] } });
      setMsg(r.errors.length ? `Not saved: ${r.errors[0].error}` : r.unchanged ? 'Already the same.' : 'Saved.'); setForm({ ...form, votes: '' }); reload();
    } catch (x) { setE2(x instanceof ApiError ? x.message : 'Could not save.'); }
  }
  async function upload() {
    const f = file.current?.files?.[0]; if (!f) return;
    setE2(''); setMsg('');
    if (form.note.trim().length < 5) { setE2('Write where the figures came from first (at least 5 characters).'); return; }
    try {
      const r = await postCsv(`/t/${tenantId}/results/official/csv?sourceNote=${encodeURIComponent(form.note)}`, await f.text());
      setMsg(`${r.recorded} saved, ${r.unchanged} unchanged${r.errors.length ? `, ${r.errors.length} rows could not be read` : ''}.`); reload();
    } catch (x) { setE2(x instanceof ApiError ? x.message : 'Could not upload.'); }
  }
  const cell = (x: any, key: string) => (
    <td key={key} className={`cmp ${x.status}`}>{x.campaign == null ? <span className="muted">–</span> : num(x.campaign)}<span className="official">{x.official == null ? '' : ` / ${num(x.official)}`}</span>
      {x.status === 'differs' && <span className="diff">{x.diff > 0 ? '+' : ''}{x.diff}</span>}</td>
  );
  return (
    <>
      <p className="muted">Each cell shows <strong>campaign reported</strong> / <span className="official">official</span>. A red difference means the two disagree.</p>
      {c.lead.campaign && (
        <div className="cards">
          <div className="card"><span className="muted">Campaign reported lead</span><strong>{c.lead.campaign.margin >= 0 ? '+' : ''}{num(c.lead.campaign.margin)}</strong><span className="muted small">vs {c.lead.campaign.bestOtherName}</span></div>
          {c.lead.official && <div className="card"><span className="muted">Official lead</span><strong>{c.lead.official.margin >= 0 ? '+' : ''}{num(c.lead.official.margin)}</strong><span className="muted small">vs {c.lead.official.bestOtherName}</span></div>}
          <div className="card"><span className={c.mismatches ? 'err-text' : 'muted'}>Numbers that differ</span><strong>{c.mismatches}</strong></div>
          <div className="card"><span className={c.unreviewedFlags ? 'err-text' : 'muted'}>Reports to check</span><strong>{c.unreviewedFlags}</strong></div>
        </div>
      )}
      <h3>Round by round</h3>
      <table className="table compact">
        <thead><tr><th>Round</th>{c.candidates.map((x: any) => <th key={x.id}>{x.code} · {x.name}{x.isOurs ? ' ★' : ''}</th>)}</tr></thead>
        <tbody>{c.rounds.map((r: any) => <tr key={r.roundNo}><td>{r.roundNo}</td>{c.candidates.map((x: any) => cell(r.cells[x.id], x.id))}</tr>)}
          {c.rounds.length === 0 && <tr><td colSpan={c.candidates.length + 1} className="muted">No counting rounds reported yet.</td></tr>}
          {c.rounds.length > 0 && <tr className="total"><td>Total (rounds both sides have)</td>{c.candidates.map((x: any) => { const cu = c.cumulative.find((y: any) => y.candidateId === x.id); return <td key={x.id}>{num(cu.campaign)} <span className="official">/ {num(cu.official)}</span></td>; })}</tr>}
        </tbody>
      </table>
      {c.stations.length > 0 && (
        <>
          <h3>Station by station</h3>
          <table className="table compact">
            <thead><tr><th>Station</th><th>Electors</th>{c.candidates.map((x: any) => <th key={x.id}>{x.code}</th>)}<th /></tr></thead>
            <tbody>{c.stations.map((s: any) => <tr key={s.areaId}><td>{s.code} {s.name}</td><td>{num(s.electors)}</td>{c.candidates.map((x: any) => cell(s.cells[x.id], x.id))}
              <td>{s.flags.length > 0 && <span className="badge blocked">check</span>}</td></tr>)}</tbody>
          </table>
        </>
      )}
      {canEdit && (
        <div className="panel">
          <h3>Official figures</h3>
          <p className="muted">Read them from the official site, then enter them here. The source note is kept with every figure.</p>
          <form className="inline-form" onSubmit={addOfficial}>
            <label>Type<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="round">Counting round</option><option value="station">Station</option></select></label>
            <label>{form.kind === 'round' ? 'Round number' : 'Station code'}<input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} required /></label>
            <label>Candidate<select value={form.candidate} onChange={(e) => setForm({ ...form, candidate: e.target.value })} required><option value="">–</option>{c.candidates.map((x: any) => <option key={x.id} value={x.code}>{x.code} · {x.name}</option>)}</select></label>
            <label>Votes<input value={form.votes} inputMode="numeric" onChange={(e) => setForm({ ...form, votes: e.target.value.replace(/\D/g, '') })} required /></label>
            <label style={{ flex: '2 1 280px' }}>Where it came from (and when)<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. official results page, read at 14:10 by Harpreet" required /></label>
            <button className="btn">Save</button>
          </form>
          <div className="inline-form" style={{ marginTop: 12 }}>
            <label>Or upload a CSV (columns: round or station, candidate, votes)<input type="file" accept=".csv,text/csv" ref={file} /></label>
            <button className="btn" onClick={upload}>Upload</button>
          </div>
          {msg && <p className="ok">{msg}</p>}{e2 && <p className="err">{e2}</p>}
        </div>
      )}
      <p><a className="btn small" href="#export" onClick={async (e) => { e.preventDefault(); const res = await api<Response>(`/t/${tenantId}/results/export.csv`, { raw: true }); const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = 'results.csv'; a.click(); }}>Download all figures (CSV)</a></p>
    </>
  );
}

function Flags({ tenantId, role }: { tenantId: string; role: string }) {
  const { data, err, reload } = useLoad<any[]>(`/t/${tenantId}/results/flags`, 30_000);
  if (err) return <p className="err">{err}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="muted">Reports that look odd. They are kept and counted (the latest report wins); marking one as checked only removes it from this list.</p>
      <table className="table compact">
        <thead><tr><th>When</th><th>Report</th><th>Why it needs a look</th><th>By</th><th /></tr></thead>
        <tbody>{data.map((f) => (
          <tr key={`${f.kind}${f.id}`}>
            <td>{clock(f.receivedAt)}</td>
            <td>{f.kind === 'turnout' ? `${f.stationCode ?? ''} ${f.station}: ${num(f.votes)} votes` : `${f.round ? `Round ${f.round}` : `${f.stationCode ?? ''} ${f.station}`}: ${f.candidate} ${num(f.votes)}`}</td>
            <td>{f.explanation.join('; ')}</td><td>{f.agent ?? '–'} · {f.channel}</td>
            <td>{(role === 'owner' || role === 'manager') && <button className="btn small" onClick={async () => { await api(`/t/${tenantId}/results/flags/${f.kind}/${f.id}/review`, { method: 'POST', body: {} }); reload(); }}>Checked</button>}</td>
          </tr>
        ))}
          {data.length === 0 && <tr><td colSpan={5} className="muted">Nothing needs a look.</td></tr>}</tbody>
      </table>
    </>
  );
}

function Setup({ tenantId, role }: { tenantId: string; role: string }) {
  const stations = useLoad<any>(`/t/${tenantId}/results/stations`);
  const agents = useLoad<any[]>(role === 'owner' || role === 'manager' ? `/t/${tenantId}/results/agents` : `/t/${tenantId}/results/candidates`);
  const cands = useLoad<any[]>(`/t/${tenantId}/results/candidates`);
  const [team, setTeam] = useState<any[]>([]);
  const [csv, setCsv] = useState('');
  const [cand, setCand] = useState({ code: '', name: '', party: '', isOurs: false });
  const [asg, setAsg] = useState({ userId: '', scope: 'station', areaCode: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const canEdit = role === 'owner' || role === 'manager';
  useEffect(() => { if (canEdit) api(`/t/${tenantId}/members`).then(setTeam).catch(() => {}); }, [tenantId]);
  const run = async (fn: () => Promise<any>, ok: string) => { setErr(''); setMsg(''); try { const r = await fn(); setMsg(typeof ok === 'string' ? ok.replace('{n}', String(r?.saved ?? '')) : ''); stations.reload(); cands.reload(); agents.reload(); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not save.'); } };
  return (
    <>
      {msg && <p className="ok">{msg}</p>}{err && <p className="err">{err}</p>}
      <div className="panel">
        <h3>Candidates</h3>
        <p className="muted">The short code is what agents type in a text message (for example A, B, C).</p>
        <ul className="plain">{cands.data?.map((c: any) => <li key={c.id}><strong>{c.code}</strong> {c.name}{c.party ? ` (${c.party})` : ''}{c.isOurs ? ' ★ our candidate' : ''}</li>)}{cands.data?.length === 0 && <li className="muted">None yet.</li>}</ul>
        {canEdit && (
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run(() => api(`/t/${tenantId}/results/candidates`, { body: { code: cand.code, name: cand.name, party: cand.party || undefined, isOurs: cand.isOurs } }), 'Added.').then(() => setCand({ code: '', name: '', party: '', isOurs: false })); }}>
            <label>Code<input value={cand.code} maxLength={4} onChange={(e) => setCand({ ...cand, code: e.target.value.toUpperCase() })} required style={{ maxWidth: 90 }} /></label>
            <label>Name<input value={cand.name} onChange={(e) => setCand({ ...cand, name: e.target.value })} required /></label>
            <label>Party<input value={cand.party} onChange={(e) => setCand({ ...cand, party: e.target.value })} /></label>
            <label className="check"><input type="checkbox" checked={cand.isOurs} onChange={(e) => setCand({ ...cand, isOurs: e.target.checked })} />Our candidate</label>
            <button className="btn">Add</button>
          </form>
        )}
      </div>

      <div className="panel">
        <h3>Polling stations and electors</h3>
        <p className="muted">Stations are the booths (India) or voting places (Canada) you added as areas, with their area code. Paste a list to set how many electors each has: one line per station, <span className="mono-ish">code,electors</span>.</p>
        <table className="table compact"><thead><tr><th>Code</th><th>Station</th><th>Electors</th><th>Agents</th></tr></thead>
          <tbody>{stations.data?.configured.map((s: any) => <tr key={s.area_id}><td className="mono-ish">{s.code}</td><td>{s.name}</td><td>{num(s.electors)}</td><td>{s.agents.join(', ') || <span className="muted">none</span>}</td></tr>)}
            {stations.data?.configured.length === 0 && <tr><td colSpan={4} className="muted">No stations set up yet.</td></tr>}</tbody></table>
        {stations.data?.available.length > 0 && <p className="muted small">Booths not set up yet: {stations.data.available.slice(0, 12).map((a: any) => a.code ?? a.name).join(', ')}{stations.data.available.length > 12 ? '…' : ''}</p>}
        {canEdit && (
          <>
            <textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'code,electors\nB001,812\nB002,640'} style={{ width: '100%' }} />
            <button className="btn" onClick={() => run(() => postCsv(`/t/${tenantId}/results/stations/csv`, csv), '{n} stations saved.')}>Save stations</button>
          </>
        )}
      </div>

      {canEdit && (
        <div className="panel">
          <h3>Who reports for which station</h3>
          <p className="muted">Add people to the team with the role "results reporter" first (Team page). A person can report only for the stations they are given here, or from the counting hall.</p>
          <table className="table compact"><thead><tr><th>Person</th><th>Role</th><th>Reports for</th><th /></tr></thead>
            <tbody>{(agents.data as any[] | null)?.map((a: any) => (
              <tr key={a.id}><td>{a.name}</td><td>{a.role}</td><td>{a.scope === 'counting' ? 'Counting hall' : `${a.code ?? ''} ${a.area ?? ''}`}</td>
                <td><button className="btn small" onClick={() => run(() => api(`/t/${tenantId}/results/agents`, { method: 'PUT', body: { userId: a.user_id, scope: a.scope, ...(a.scope === 'station' ? { areaId: a.area_id } : {}), remove: true } }), 'Removed.')}>Remove</button></td></tr>
            ))}</tbody></table>
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run(() => api(`/t/${tenantId}/results/agents`, { method: 'PUT', body: { userId: asg.userId, scope: asg.scope, ...(asg.scope === 'station' ? { areaCode: asg.areaCode } : {}) } }), 'Saved.'); }}>
            <label>Person<select value={asg.userId} onChange={(e) => setAsg({ ...asg, userId: e.target.value })} required><option value="">–</option>{team.map((m) => <option key={m.userId} value={m.userId}>{m.name ?? m.email} ({m.role})</option>)}</select></label>
            <label>For<select value={asg.scope} onChange={(e) => setAsg({ ...asg, scope: e.target.value })}><option value="station">A station</option><option value="counting">The counting hall</option></select></label>
            {asg.scope === 'station' && <label>Station code<input value={asg.areaCode} onChange={(e) => setAsg({ ...asg, areaCode: e.target.value })} required /></label>}
            <button className="btn">Assign</button>
          </form>
        </div>
      )}
    </>
  );
}

function Archive({ tenantId, role }: { tenantId: string; role: string }) {
  const { data, reload } = useLoad<any[]>(`/t/${tenantId}/results/archives`);
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  return (
    <>
      <p className="muted">After the election, freeze the results for the next one. The archive keeps turnout by station and the counting figures (campaign reported and official), with no personal data. <strong>Once archived, no more reports are accepted.</strong></p>
      <ul className="plain">{data?.map((a) => <li key={a.id}>Archived {new Date(a.takenAt).toLocaleString()}</li>)}{data?.length === 0 && <li className="muted">Not archived yet.</li>}</ul>
      {role === 'owner' && (data?.length ?? 0) === 0 && (
        <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await api(`/t/${tenantId}/results/archive`, { body: { confirm } }); reload(); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not archive.'); } }}>
          <label>Type ARCHIVE to confirm<input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
          <button className="btn" disabled={confirm !== 'ARCHIVE'}>Archive the results</button>
        </form>
      )}
      {err && <p className="err">{err}</p>}
    </>
  );
}
