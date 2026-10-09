import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, errText } from '../api';
import type { ShellCtx } from '../App';

const PHASE: Record<string, string> = { before_launch: 'Before you launch', before_first_call: 'Before the first call or text', before_election: 'Before election day' };

/** The onboarding checklist for this election: what the platform can see is ticked for you, the rest you tick yourself. */
export function Pack() {
  const { tenant: t, role, reload } = useOutletContext<ShellCtx>();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const load = () => api(`/t/${t.id}/pack`).then(setD);
  useEffect(() => { load(); }, [t.id]);
  const owner = role === 'owner';
  async function apply(packId: string) { setErr(''); try { await api(`/t/${t.id}/pack/apply`, { body: { packId } }); await load(); reload(); } catch (x) { setErr(errText(x, 'Could not apply the package.')); } }
  async function tick(id: string, done: boolean) { setErr(''); try { await api(`/t/${t.id}/pack/checks/${id}`, { body: { done } }); load(); } catch (x) { setErr(errText(x)); } }
  if (!d) return <div className="muted">Loading…</div>;

  return (
    <>
      <header className="page-head"><h1>Election checklist</h1>
        <p className="muted">{d.applied ? d.applied.election : 'Start from a ready-made package for your election: draft voter pages, a first survey, and the steps to get ready.'}</p></header>
      {err && <p className="err" role="alert">{err}</p>}

      {!d.applied && <section className="panel">
        <h2>Choose a package</h2>
        {d.available.length === 0 && <p className="muted">There is no package for this campaign yet.</p>}
        {d.available.map((p: any) => (
          <div key={p.id} className="stack" style={{ marginBottom: 16 }}>
            <strong>{p.title}</strong><span className="muted small">{p.election}</span>
            <span className="small">Creates {p.contentItems} draft items in {p.locales.join(', ').toUpperCase()}, turns on {p.modules.length} modules, and sets up a {p.checklistItems}-step checklist. Nothing is public or sent until you fill it in and approve it.</span>
            {owner ? <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => apply(p.id)}>Use this package</button> : <span className="muted small">Only the candidate can apply a package.</span>}
          </div>
        ))}
      </section>}

      {d.applied && d.progress && <>
        <div className="figures">
          <div className="fig"><span className="fig-n">{d.progress.done} / {d.progress.total}</span><span className="fig-l">steps done</span></div>
        </div>
        {Object.entries(PHASE).map(([phase, title]) => {
          const items = d.progress.items.filter((i: any) => i.phase === phase);
          return items.length ? (
            <section className="panel" key={phase}>
              <h2>{title}</h2>
              <ul className="checklist">{items.map((i: any) => (
                <li key={i.id}>
                  <span className={`tick ${i.done ? 'done' : ''}`} aria-hidden>{i.done ? '✓' : ''}</span>
                  <div style={{ flex: 1 }}><strong>{i.title}</strong><div className="muted small">{i.why}</div></div>
                  {i.manual ? <label className="small rowflex"><input type="checkbox" checked={i.done} disabled={!['owner', 'manager'].includes(role)} onChange={(e) => tick(i.id, e.target.checked)} />Done</label> : <span className="chip">{i.done ? 'Done' : 'Not yet'}</span>}
                </li>
              ))}</ul>
            </section>
          ) : null;
        })}
        {d.applied.confirmWithCounsel.length > 0 && <p className="muted small">These settings in the package are drafts until counsel confirms them: {d.applied.confirmWithCounsel.join(', ')}.</p>}
      </>}

      {d.province && <section className="panel">
        <h2>{d.province.name} rules</h2>
        <p className="muted small">Election office: <a href={d.province.electionBodyUrl} target="_blank" rel="noopener noreferrer">{d.province.electionBody}</a>. Acts to check: {d.province.acts.join('; ')}. Next general election: {d.province.nextGeneral}.</p>
        {d.province.unset.length > 0 && <p className="chip warn">Not set yet (take these from {d.province.electionBody}, the platform does not guess legal figures): {d.province.unset.map((k: string) => k === 'spendLimitMinor' ? 'spending limit' : k === 'contributionLimitMinor' ? 'contribution limit' : 'blackout period').join(', ')}.</p>}
      </section>}
    </>
  );
}
