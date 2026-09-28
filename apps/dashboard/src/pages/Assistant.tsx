import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../api';
import type { ShellCtx } from '../App';

const OUT: Record<string, string> = { answered: 'Answered from approved content', handoff: 'Handed to the team', official_link: 'Sent to official election site' };

export function Assistant() {
  const { tenant: t } = useOutletContext<ShellCtx>();
  const [d, setD] = useState<any>(null);
  useEffect(() => { api(`/t/${t.id}/assistant`).then(setD); }, [t.id]);
  return (
    <>
      <header className="page-head"><h1>Assistant questions</h1>
        <p className="muted">What voters ask the assistant on your page. Questions it handed to the team are the gaps in your approved answers.</p></header>
      <div className="figures">{['answered', 'handoff', 'official_link'].map((k) => (
        <div className="fig" key={k}><span className="fig-n">{d?.byOutcome.find((x: any) => x.outcome === k)?.n ?? 0}</span><span className="fig-l">{OUT[k]}</span></div>
      ))}</div>
      <table className="table">
        <thead><tr><th>Question</th><th>Language</th><th>Result</th><th>When</th></tr></thead>
        <tbody>{d?.recent.map((q: any) => (
          <tr key={q.id}><td lang={q.locale}>{q.question}</td><td>{q.locale.toUpperCase()}</td><td>{OUT[q.outcome]}</td><td className="muted">{new Date(q.createdAt).toLocaleString()}</td></tr>
        ))}</tbody>
      </table>
      {d && !d.recent.length && <p className="muted">No questions yet. Open the voter page and ask one to see it here.</p>}
    </>
  );
}
