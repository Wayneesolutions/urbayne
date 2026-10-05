import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { ShellCtx } from '../App';

const pct = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)}%`);

export function ServiceReports() {
  const { tenant: t, role } = useOutletContext<ShellCtx>();
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState('');
  const [range, setRange] = useState({ from: `${thisMonth}-01`, to: new Date().toISOString().slice(0, 10), notes: false });
  useEffect(() => { setErr(''); api(`/t/${t.id}/service/reports?month=${month}`).then(setR).catch((x) => setErr(x instanceof ApiError ? x.message : 'Could not load.')); }, [month, t.id]);

  async function download() {
    const res = await api<Response>(`/t/${t.id}/service/reports/work-done.csv?from=${range.from}&to=${range.to}${range.notes ? '&includeNotes=1' : ''}`, { raw: true });
    if (!res.ok) { setErr('Could not create the export.'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = `work-done-${range.from}-to-${range.to}.csv`; a.click();
  }

  const maxTrend = Math.max(1, ...(r?.trend ?? []).map((m: any) => Math.max(m.received, m.resolved)));
  return (
    <>
      <header className="page-head"><h1>Service reports</h1>
        <p className="muted">What came in, what was done, how fast, and where. Figures stay after personal details are removed.</p></header>
      <div className="panel inline-form"><label>Month<input type="month" value={month} max={thisMonth} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label></div>
      {err && <p className="err">{err}</p>}
      {r && (
        <>
          <div className="cards">
            <div className="card"><span className="muted">Received</span><strong>{r.received}</strong></div>
            <div className="card"><span className="muted">Resolved</span><strong>{r.resolved}</strong></div>
            <div className="card"><span className="muted">Average days to resolve</span><strong>{r.avgDaysToResolve ?? '–'}</strong></div>
            <div className="card"><span className="muted">Resolved within {r.serviceLevelDays} days</span><strong>{pct(r.resolvedInTimeShare)}</strong></div>
            <div className="card"><span className="muted">Open at month end</span><strong>{r.openAtMonthEnd}</strong></div>
            <div className="card"><span className={r.overdueNow ? 'err-text' : 'muted'}>Overdue now</span><strong>{r.overdueNow}</strong></div>
          </div>
          <p className="muted">Acknowledgement texts: {r.acknowledgement.acknowledged} of {r.acknowledgement.withPhone} requests with a phone number were acknowledged{r.acknowledgement.within60s ? `, ${r.acknowledgement.within60s} within a minute` : ''}{r.acknowledgement.avgSeconds != null ? ` (average ${r.acknowledgement.avgSeconds} seconds)` : ''}.</p>

          <div className="two">
            <div><h3>By category</h3>
              <table className="table compact"><thead><tr><th>Category</th><th>Received</th><th>Resolved</th><th>Avg days</th></tr></thead>
                <tbody>{r.byCategory.map((c: any) => <tr key={c.category}><td>{c.category}</td><td>{c.received}</td><td>{c.resolved}</td><td>{c.avgDays ?? '–'}</td></tr>)}
                  {r.byCategory.length === 0 && <tr><td colSpan={4} className="muted">Nothing this month.</td></tr>}</tbody></table></div>
            <div><h3>By village / ward</h3>
              <table className="table compact"><thead><tr><th>Area</th><th>Received</th><th>Resolved</th><th>Open now</th></tr></thead>
                <tbody>{r.byArea.map((a: any, i: number) => <tr key={i}><td>{a.area}</td><td>{a.received}</td><td>{a.resolved}</td><td>{a.openNow}</td></tr>)}
                  {r.byArea.length === 0 && <tr><td colSpan={4} className="muted">Nothing this month.</td></tr>}</tbody></table></div>
          </div>

          <h3>Last six months</h3>
          <div className="trend">
            {r.trend.map((m: any) => (
              <div key={m.month} className="trend-col">
                <div className="bars"><span className="bar in" style={{ height: `${(m.received / maxTrend) * 100}%` }} title={`${m.received} received`} /><span className="bar done" style={{ height: `${(m.resolved / maxTrend) * 100}%` }} title={`${m.resolved} resolved`} /></div>
                <span className="muted small">{m.month.slice(5)}</span><span className="small">{m.received}/{m.resolved}</span>
              </div>
            ))}
          </div>
          <p className="muted small">Received / resolved per month.</p>
        </>
      )}

      {(role === 'owner' || role === 'manager') && (
        <div className="panel">
          <h3>"Work done" export</h3>
          <p className="muted">A spreadsheet of resolved requests by category, area and days taken, for the next campaign or a public report. It never contains names, phone numbers or what residents wrote.</p>
          <div className="inline-form">
            <label>From<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
            <label>To<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
            {role === 'owner' && <label className="check"><input type="checkbox" checked={range.notes} onChange={(e) => setRange({ ...range, notes: e.target.checked })} />Include the notes on what was done (check them for names first)</label>}
            <button className="btn" onClick={download}>Download CSV</button>
          </div>
        </div>
      )}
    </>
  );
}
