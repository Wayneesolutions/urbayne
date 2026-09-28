import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError, session } from '../api';
import { money, toMinor } from '../money';
import type { ShellCtx } from '../App';

const FLAG: Record<string, string> = {
  MISSING_BILL: 'No bill number', BELOW_RATE_LIST: 'Below district rate list', AMOUNT_MISMATCH: 'Amount ≠ quantity × rate', OVER_SPENDING_LIMIT: 'Over spending limit',
  ELIGIBILITY_NOT_CONFIRMED: 'Eligibility not confirmed', OVER_CONTRIBUTION_LIMIT: 'Over contributor limit', LARGE_CASH: 'Large cash amount',
};

export function Finance() {
  const { tenant: t, role } = useOutletContext<ShellCtx>();
  const cur = t.region === 'IN' ? 'INR' : 'CAD';
  const [sum, setSum] = useState<any>(null);
  const [entries, setEntries] = useState<any[]>([]);
  const [rates, setRates] = useState<any[]>([]);
  const [kind, setKind] = useState<'expense' | 'contribution'>('expense');
  const [f, setF] = useState<any>({ entryDate: new Date().toISOString().slice(0, 10), amount: '', category: '', description: '', partyName: '', billNo: '', quantity: '', rate: '', rateListId: '', paymentMode: 'bank', eligibleAttested: false });
  const [err, setErr] = useState('');
  const load = () => { api(`/t/${t.id}/finance/summary`).then(setSum); api(`/t/${t.id}/finance/entries`).then(setEntries); api(`/t/${t.id}/finance/rate-list`).then(setRates); };
  useEffect(() => { load(); }, [t.id]);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try {
      await api(`/t/${t.id}/finance/entries`, { body: {
        kind, entryDate: f.entryDate, amountMinor: toMinor(f.amount), category: f.category || (sum?.categories[0] ?? 'Other'), description: f.description, partyName: f.partyName,
        billNo: f.billNo || undefined, quantity: f.quantity ? Number(f.quantity) : undefined, unitRateMinor: f.rate ? toMinor(f.rate) : undefined,
        rateListId: f.rateListId || undefined, paymentMode: f.paymentMode, eligibleAttested: f.eligibleAttested,
      } });
      setF({ ...f, amount: '', description: '', partyName: '', billNo: '', quantity: '', rate: '', rateListId: '', eligibleAttested: false }); load();
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not save.'); }
  }
  async function signoff() {
    setErr('');
    try { await api(`/t/${t.id}/finance/signoff`, { body: { periodTo: new Date().toISOString().slice(0, 10) } }); load(); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not sign off.'); }
  }
  async function exportCsv(k: string) {
    const r = await fetch(`/api/t/${t.id}/finance/export.csv?kind=${k}`, { headers: { authorization: `Bearer ${session.token}` } });
    if (!r.ok) { setErr((await r.json()).message); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = `${k}-register.csv`; a.click();
  }
  const pct = sum?.share != null ? Math.round(sum.share * 100) : null;
  const pickRate = (id: string) => { const r = rates.find((x) => x.id === id); setF({ ...f, rateListId: id, rate: r ? String(r.rateMinor / 100) : f.rate, description: f.description || (r ? r.item : '') }); };

  return (
    <>
      <header className="page-head row">
        <div><h1>{t.region === 'IN' ? 'Election expenditure' : 'Campaign finance'}</h1>
          <p className="muted">{t.region === 'IN' ? 'Day-to-day register, priced against the district rate list, ready for the expenditure observer.' : 'Contributions and expenses, checked against your limits, with receipts numbered automatically.'}</p></div>
        <div className="actions">
          {['owner', 'finance_agent'].includes(role) && <button className="btn" onClick={signoff}>Sign off up to today</button>}
          {['owner', 'finance_agent'].includes(role) && <button className="btn" onClick={() => exportCsv('expense')}>Export expenses</button>}
          {['owner', 'finance_agent'].includes(role) && t.region === 'CA' && <button className="btn" onClick={() => exportCsv('contribution')}>Export contributions</button>}
        </div>
      </header>
      {err && <p className="err">{err}</p>}
      <section className="panel limit">
        <div className="row"><h2>Spent against the limit</h2><strong>{sum ? money(sum.expense, cur) : '–'} <span className="muted">of {money(sum?.limitMinor, cur)}</span></strong></div>
        <div className={`bar big ${pct != null && pct >= 90 ? 'hot' : ''}`}><span style={{ width: `${Math.min(100, pct ?? 0)}%` }} /></div>
        <p className="muted small">{pct != null ? `${pct}% used.` : 'No limit set.'} {sum?.flagged ? `${sum.flagged} entries flagged for review.` : 'No flagged entries.'} {sum?.lockedUntil ? `Signed off and locked up to ${sum.lockedUntil}.` : ''}</p>
      </section>

      <form className="panel stack" onSubmit={save}>
        <div className="row"><h2>New entry</h2>
          <div className="seg" role="group">{(t.region === 'CA' ? ['expense', 'contribution'] : ['expense', 'contribution']).map((k) => <button type="button" key={k} aria-pressed={kind === k} onClick={() => setKind(k as any)}>{k === 'expense' ? 'Expense' : 'Contribution'}</button>)}</div></div>
        <div className="grid4">
          <label>Date<input type="date" value={f.entryDate} onChange={(e) => setF({ ...f, entryDate: e.target.value })} required /></label>
          {kind === 'expense' && <label>Category<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{sum?.categories.map((c: string) => <option key={c}>{c}</option>)}</select></label>}
          {kind === 'expense' && t.region === 'IN' && <label>Rate list item<select value={f.rateListId} onChange={(e) => pickRate(e.target.value)}><option value="">–</option>{rates.map((r) => <option key={r.id} value={r.id}>{r.item} ({money(r.rateMinor, cur)}/{r.unit})</option>)}</select></label>}
          <label>{kind === 'expense' ? 'Paid to' : 'Received from'}<input value={f.partyName} onChange={(e) => setF({ ...f, partyName: e.target.value })} required /></label>
          <label>Description<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required /></label>
          {kind === 'expense' && <label>Quantity<input value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value, amount: f.rate && e.target.value ? String(Number(e.target.value) * Number(f.rate)) : f.amount })} inputMode="decimal" /></label>}
          {kind === 'expense' && <label>Rate<input value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value, amount: f.quantity && e.target.value ? String(Number(f.quantity) * Number(e.target.value)) : f.amount })} inputMode="decimal" /></label>}
          <label>Amount ({cur})<input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required inputMode="decimal" /></label>
          {kind === 'expense' && <label>Bill / invoice no.<input value={f.billNo} onChange={(e) => setF({ ...f, billNo: e.target.value })} /></label>}
          <label>Paid by<select value={f.paymentMode} onChange={(e) => setF({ ...f, paymentMode: e.target.value })}>{['bank', 'cheque', 'upi', 'card', 'cash', 'other'].map((m) => <option key={m}>{m}</option>)}</select></label>
          {kind === 'contribution' && t.region === 'CA' && <label className="check"><input type="checkbox" checked={f.eligibleAttested} onChange={(e) => setF({ ...f, eligibleAttested: e.target.checked })} />Contributor confirmed they are eligible</label>}
        </div>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }}>Add entry</button>
      </form>

      <table className="table">
        <thead><tr><th>Date</th><th>{kind === 'expense' ? 'Category' : 'Type'}</th><th>Description</th><th>Party</th><th>Amount</th><th>Checks</th></tr></thead>
        <tbody>{entries.map((e) => (
          <tr key={e.id}><td>{e.entryDate}</td><td>{e.kind === 'expense' ? e.category : `Contribution ${e.receiptNo ?? ''}`}</td><td>{e.description}{e.source !== 'manual' && <span className="muted small"> · auto from {e.source === 'event' ? 'events' : 'calls'}</span>}</td>
            <td>{e.partyName}</td><td className="mono-ish">{e.kind === 'contribution' ? '+' : ''}{money(e.amountMinor, cur)}</td>
            <td>{e.flags.length ? e.flags.map((x: any) => <span key={x.code} className="badge blocked" title={x.message}>{FLAG[x.code] ?? x.code}</span>) : <span className="badge approved">OK</span>}</td></tr>
        ))}</tbody>
      </table>
    </>
  );
}
