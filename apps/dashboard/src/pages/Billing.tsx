import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, errText } from '../api';
import { money } from '../money';
import type { ShellCtx } from '../App';

/** The campaign's package, how much of it is used, invoices, and which consultancy (if any) is linked. */
export function Billing() {
  const { tenant: t, role, reload } = useOutletContext<ShellCtx>();
  const [d, setD] = useState<any>(null);
  const [agency, setAgency] = useState<any>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [err, setErr] = useState('');
  const owner = role === 'owner';
  const load = () => { api(`/t/${t.id}/billing`).then(setD); if (owner) api(`/t/${t.id}/agency`).then(setAgency).catch(() => {}); };
  useEffect(() => { load(); }, [t.id]);
  const cur = (t.region === 'IN' ? 'INR' : 'CAD') as 'INR' | 'CAD';
  const act = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); load(); reload(); } catch (x) { setErr(errText(x)); } };
  if (!d) return <div className="muted">Loading…</div>;

  return (
    <>
      <header className="page-head"><h1>Package and usage</h1><p className="muted">What your package includes, how much you have used, and your invoices.</p></header>
      {err && <p className="err" role="alert">{err}</p>}
      {!d.subscription ? <section className="panel"><p className="muted">No package is set for this campaign yet. Wayne E Solutions sets it up when you start.</p></section> : (
        <section className="panel">
          <div className="row"><h2>{d.subscription.plan}</h2><span className="chip">{d.subscription.billing === 'per_campaign' ? 'One price for the campaign' : 'Monthly'} · {d.subscription.status}</span></div>
          <p className="muted small">{money(d.subscription.priceMinor, cur)}{d.subscription.discountPercent ? `, less ${Number(d.subscription.discountPercent)}%` : ''}. Started {String(d.subscription.startedOn).slice(0, 10)}.{d.usage ? ` Measured ${d.usage.period.to ? `for ${d.usage.period.from.slice(0, 7)}` : `since ${d.usage.period.from}`}.` : ''}</p>
          {d.usage && <table className="table compact"><thead><tr><th>What</th><th>Used</th><th>Included</th><th>Limit</th><th>Beyond included</th></tr></thead>
            <tbody>{d.usage.metrics.map((m: any) => (
              <tr key={m.metric}><td>{m.label}</td>
                <td>{m.used}{m.atLimit && <span className="chip bad"> at limit</span>}{m.over && !m.atLimit && <span className="chip warn"> over</span>}</td>
                <td>{m.included ?? '–'}</td><td>{m.limit ?? 'none'}</td><td>{m.overageMinor ? `${money(m.overageMinor, cur)} each` : '–'}</td></tr>
            ))}</tbody></table>}
          <p className="muted small">A limit stops the action (for example, calls pause) until Wayne E Solutions moves you to a larger package.</p>
        </section>
      )}

      {d.invoices.length > 0 && <section className="panel"><h2>Invoices</h2>
        <table className="table compact"><thead><tr><th>Number</th><th>Period</th><th>Total</th><th>Status</th></tr></thead>
          <tbody>{d.invoices.map((i: any) => <tr key={i.id}><td>{i.number}</td><td>{String(i.periodStart).slice(0, 7)}</td><td>{money(i.totalMinor, cur)}{i.taxMinor ? <span className="muted small"> incl. tax {money(i.taxMinor, cur)}</span> : null}</td><td>{i.status}</td></tr>)}</tbody></table>
      </section>}

      {owner && agency && <section className="panel">
        <h2>Consultancy access</h2>
        <p className="muted small">A political consultancy you work with can see totals for this campaign (counts, spending against the limit, what awaits approval): never your contacts, phone numbers or what people said. Give them a one-time code; you can remove access at any time. To let their staff work inside the campaign, add them to your team.</p>
        {agency.links.map((l: any) => (
          <div key={l.id} className="rowflex" style={{ padding: '6px 0' }}>
            <strong>{l.agency}</strong><span className="chip">{l.status}</span>
            {l.status === 'active' && <>
              <label className="small rowflex"><input type="checkbox" checked={l.whiteLabel} onChange={(e) => act(() => api(`/t/${t.id}/agency/${l.id}`, { method: 'PATCH', body: { whiteLabel: e.target.checked } }))} />Show their name and colour to my team</label>
              <button className="btn small" onClick={() => window.confirm(`Remove ${l.agency}'s access?`) && act(() => api(`/t/${t.id}/agency/${l.id}/revoke`, { method: 'POST', body: {} }))}>Remove access</button>
            </>}
          </div>
        ))}
        <button className="btn" onClick={() => act(async () => setCode(await api(`/t/${t.id}/agency/invite`, { body: {} })))}>Create a code for a consultancy</button>
        {code && <p role="status">Give this code to the agency now. It is shown once and expires {new Date(code.expiresAt).toLocaleDateString()}: <strong style={{ fontSize: 20, letterSpacing: 1 }}>{code.code}</strong></p>}
      </section>}
    </>
  );
}
