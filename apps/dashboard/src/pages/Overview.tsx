import { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../api';
import type { ShellCtx } from '../App';

export function Overview() {
  const { tenant: t } = useOutletContext<ShellCtx>();
  const [s, setS] = useState<{ contacts: number; optedOut: number; runs: any[]; links: any[] } | null>(null);
  useEffect(() => {
    Promise.all([api(`/t/${t.id}/contacts`), api(`/t/${t.id}/calls/runs`), api(`/t/${t.id}/share-links`)])
      .then(([c, runs, links]) => setS({ contacts: c.total, optedOut: c.optedOut, runs, links }));
  }, [t.id]);
  const pub = t.slug ? `${location.origin}/v/${t.slug}` : null;
  const days = Math.ceil((new Date(t.electionDate).getTime() - Date.now()) / 86_400_000);
  return (
    <>
      <header className="page-head">
        <h1>{t.candidateName ?? t.campaignName}</h1>
        <p className="muted">{t.region === 'IN' ? 'Assembly' : 'Municipal'} election on {new Date(t.electionDate).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}{days > 0 ? `, ${days} days away` : ''}.</p>
      </header>
      {t.isDemo && <div className="note">This is a demo campaign. Calls are simulated and nobody is dialled, but every compliance rule runs exactly as it would live.</div>}
      <div className="figures">
        <Fig n={s?.contacts} label="contacts" sub={s ? `${s.optedOut} opted out` : ''} />
        <Fig n={s?.runs.length} label="call runs" sub={s ? `${s.runs.filter((r) => r.status === 'running').length} running now` : ''} />
        <Fig n={s?.links.reduce((a, l) => a + l.signups, 0)} label="sign-ups from shared links" sub={s ? `${s.links.reduce((a, l) => a + l.clicks, 0)} link opens` : ''} />
      </div>
      <section className="panel">
        <h2>Voter page</h2>
        {pub ? <p>Voters open <a href={pub} target="_blank" rel="noreferrer">{pub}</a>. Share it through <Link to="../share">share links</Link> so you can see which booth or worker brought each sign-up.</p>
          : <p className="muted">Set a page address in settings to publish the voter page.</p>}
      </section>
    </>
  );
}
function Fig({ n, label, sub }: { n?: number; label: string; sub: string }) {
  return <div className="fig"><span className="fig-n">{n ?? '–'}</span><span className="fig-l">{label}</span><span className="muted small">{sub}</span></div>;
}
