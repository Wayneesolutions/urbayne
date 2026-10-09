import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errText, session } from '../api';
import { money } from '../money';

const FLAG: Record<string, string> = {
  SPENDING_NEAR_LIMIT: 'Spending near the limit', FLAGGED_ENTRIES: 'Flagged entries', CONTENT_AWAITING_APPROVAL: 'Content awaiting approval', BLOCKED_CALL_RUNS: 'Call run blocked',
  OVERDUE_REQUESTS: 'Overdue requests', RETENTION_NOT_SET: 'Data deletion date not set',
};

/** A consultancy's view across the campaigns it works on: totals and what needs attention, nothing about individual people. */
export function Agency() {
  const { agencyId } = useParams();
  const nav = useNavigate();
  const [a, setA] = useState<any>(null);
  const [o, setO] = useState<any>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const load = () => {
    api(`/agencies/${agencyId}`).then(setA).catch(() => nav('/'));
    api(`/agencies/${agencyId}/overview`).then(setO).catch((x) => setErr(errText(x)));
  };
  useEffect(() => { load(); }, [agencyId]);
  async function link(e: React.FormEvent) { e.preventDefault(); setErr(''); try { await api(`/agencies/${agencyId}/link`, { body: { code } }); setCode(''); load(); } catch (x) { setErr(errText(x, 'Could not link.')); } }
  if (!a) return <div className="centered muted">Loading…</div>;
  const accent = a.primaryColor ?? undefined;

  return (
    <div className="work" style={{ maxWidth: 1100, margin: '0 auto', padding: 24, ['--accent' as any]: accent }}>
      <header className="page-head row">
        <div><h1 style={accent ? { borderLeft: `6px solid ${accent}`, paddingLeft: 12 } : undefined}>{a.brandName ?? a.name}</h1><p className="muted">All your campaigns on one page. Totals only: open a campaign you are on the team of for the detail.</p></div>
        <div className="actions"><Link className="btn" to="/">Your campaigns</Link><button className="btn" onClick={() => { session.clear(); nav('/login'); }}>Sign out</button></div>
      </header>
      {err && <p className="err" role="alert">{err}</p>}
      {o && <div className="figures"><div className="fig"><span className="fig-n">{o.campaigns.length}</span><span className="fig-l">campaigns</span></div><div className="fig"><span className="fig-n">{o.attention}</span><span className="fig-l">things need attention</span></div></div>}
      {o?.campaigns.length === 0 && <p className="muted">No campaign is linked yet. Ask the campaign’s candidate for a code.</p>}
      {o?.campaigns.map((c: any) => (
        <section className="panel" key={c.linkId}>
          <div className="row"><h2>{c.candidateName ?? c.campaignName}{c.isDemo && <span className="demo-pill"> demo</span>}</h2>
            <span className="muted">{c.region === 'IN' ? 'India' : 'Canada'} · {c.seatCode}{c.daysToElection != null ? ` · ${c.daysToElection >= 0 ? `${c.daysToElection} days to the election` : 'election over'}` : ''}</span></div>
          {c.attention.length > 0 && <p>{c.attention.map((k: string) => <span key={k} className="chip warn" style={{ marginRight: 6 }}>{FLAG[k] ?? k}</span>)}</p>}
          <div className="figures small-figs">
            <div className="fig"><span className="fig-n">{c.contacts}</span><span className="fig-l">contacts ({c.optedOut} opted out)</span></div>
            <div className="fig"><span className="fig-n">{c.callsLast7Days}</span><span className="fig-l">calls and texts, 7 days</span></div>
            <div className="fig"><span className="fig-n">{c.doorsVisited}</span><span className="fig-l">doors visited</span></div>
            <div className="fig"><span className="fig-n">{c.content.drafts}</span><span className="fig-l">items awaiting approval</span></div>
            <div className="fig"><span className="fig-n">{c.service.open}</span><span className="fig-l">open requests ({c.service.overdue} overdue)</span></div>
          </div>
          <div className="bar"><span style={{ width: `${Math.min(100, Math.round((c.spending.share ?? 0) * 100))}%` }} /></div>
          <p className="muted small">Spent {money(c.spending.spentMinor, c.spending.currency)}{c.spending.limitMinor ? ` of ${money(c.spending.limitMinor, c.spending.currency)}` : ' (no limit set)'}; {c.spending.flaggedEntries} flagged.</p>
        </section>
      ))}
      {a.role === 'admin' && <form className="panel inline-form" onSubmit={link}>
        <label>Link another campaign<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="AG-XXXXX-XXXXX" required /></label>
        <button className="btn primary">Link</button>
      </form>}
      <section className="panel"><h2>Your team</h2><ul>{a.members.map((m: any) => <li key={m.userId}>{m.name ?? m.email} <span className="muted">· {m.role}</span></li>)}</ul></section>
    </div>
  );
}
