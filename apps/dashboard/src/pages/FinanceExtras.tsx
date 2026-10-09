import { useEffect, useRef, useState } from 'react';
import { api, errText, fetchFile, upload } from '../api';
import { money } from '../money';

/** Receipt photo or PDF for one register entry. */
export function ReceiptCell({ tenantId, entry, canEdit, onChange }: { tenantId: string; entry: any; canEdit: boolean; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function pick(f?: File) {
    if (!f) return;
    setBusy(true); setErr('');
    try { await upload(`/t/${tenantId}/finance/entries/${entry.id}/receipt`, f, f.name); onChange(); }
    catch (x) { setErr(errText(x, 'Could not save the receipt.')); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  return (
    <span className="rowflex">
      {entry.receiptFileId && <button className="btn small" onClick={() => fetchFile(`/t/${tenantId}/finance/entries/${entry.id}/receipt`).catch((x) => setErr(errText(x)))}>View</button>}
      {canEdit && <>
        <button className="btn small" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Saving…' : entry.receiptFileId ? 'Replace' : 'Add receipt'}</button>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden onChange={(e) => pick(e.target.files?.[0])} />
      </>}
      {!entry.receiptFileId && !canEdit && <span className="muted small">none</span>}
      {err && <span className="err-text small" role="alert">{err}</span>}
    </span>
  );
}

/** Choose the layout the election authority wants, then download the signed-off register as CSV or Excel. */
export function ExportMenu({ tenantId, onError }: { tenantId: string; onError: (m: string) => void }) {
  const [formats, setFormats] = useState<{ expense: any[]; contribution: any[] } | null>(null);
  const [kind, setKind] = useState<'expense' | 'contribution'>('expense');
  const [fmt, setFmt] = useState('');
  useEffect(() => { api(`/t/${tenantId}/finance/formats`).then(setFormats).catch(() => {}); }, [tenantId]);
  const list = formats?.[kind] ?? [];
  const chosen = list.find((f) => f.id === (fmt || list[0]?.id));
  async function go(as: 'csv' | 'xlsx') {
    try { await fetchFile(`/t/${tenantId}/finance/export.csv?kind=${kind}&format=${chosen.id}&as=${as}`, `${kind}-${chosen.id}.${as}`); }
    catch (x) { onError(errText(x, 'Could not export.')); }
  }
  if (!formats) return null;
  return (
    <section className="panel">
      <h2>Export for filing</h2>
      <p className="muted small">Only periods the finance agent has signed off can be exported. Layouts marked “draft” follow the usual headings but have not been checked against the official form: compare before filing.</p>
      <div className="inline-form">
        <label>Register<select value={kind} onChange={(e) => { setKind(e.target.value as any); setFmt(''); }}><option value="expense">Expenses</option><option value="contribution">Contributions</option></select></label>
        <label style={{ flex: '2 1 280px' }}>Layout<select value={chosen?.id ?? ''} onChange={(e) => setFmt(e.target.value)}>{list.map((f) => <option key={f.id} value={f.id}>{f.title}{f.confirmed ? '' : ' (draft layout)'}</option>)}</select></label>
        <button className="btn" onClick={() => go('csv')}>Download CSV</button>
        <button className="btn" onClick={() => go('xlsx')}>Download Excel</button>
      </div>
      {chosen && !chosen.confirmed && <p className="chip warn">Draft layout for {chosen.authority}: not yet confirmed against their form.</p>}
    </section>
  );
}

const STATUS_CHIP: Record<string, string> = { matched: 'good', suggested: 'warn', unmatched: 'bad', ignored: '' };

/** Bank statement upload and matching: money the bank shows that has no entry, and entries the bank never shows. */
export function Reconcile({ tenantId, currency, canEdit }: { tenantId: string; currency: 'INR' | 'CAD'; canEdit: boolean }) {
  const [statements, setStatements] = useState<any[]>([]);
  const [open, setOpen] = useState<any>(null);
  const [rec, setRec] = useState<any>(null);
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const reload = async (id = open?.statement?.id) => {
    setStatements(await api(`/t/${tenantId}/finance/bank-statements`));
    setRec(await api(`/t/${tenantId}/finance/reconciliation`));
    if (id) setOpen(await api(`/t/${tenantId}/finance/bank-statements/${id}`));
  };
  useEffect(() => { reload().catch(() => {}); }, [tenantId]);

  async function send(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const f = file.current?.files?.[0];
    if (!f) return setMsg({ ok: false, text: 'Choose the statement file (CSV).' });
    try {
      const r = await upload(`/t/${tenantId}/finance/bank-statements?label=${encodeURIComponent(label || f.name)}`, f, f.name);
      setMsg({ ok: true, text: `${r.lines} lines read: ${r.matched} matched, ${r.suggested} need a choice, ${r.unmatched} not in the register.${r.skipped?.length ? ` ${r.skipped.length} row(s) were skipped (totals, blank or unreadable).` : ''}` });
      if (file.current) file.current.value = ''; setLabel('');
      await reload(r.id);
    } catch (x) { setMsg({ ok: false, text: errText(x, 'Could not read the statement.') }); }
  }
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await reload(); } catch (x) { setMsg({ ok: false, text: errText(x) }); } };
  const m = (n: number) => money(n, currency);

  return (
    <section className="panel">
      <h2>Bank statement check</h2>
      <p className="muted small">Upload the bank’s CSV export. Each line is paired with the register entry of the same amount and date; what cannot be paired shows up below, so money that moved without an entry is found before you file.</p>
      {canEdit && <form className="inline-form" onSubmit={send}>
        <label>Name<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. April, main account" /></label>
        <label>Statement (CSV)<input ref={file} type="file" accept=".csv,text/csv" /></label>
        <button className="btn primary">Upload and match</button>
      </form>}
      {msg && <p className={msg.ok ? 'muted' : 'err'} role="status">{msg.text}</p>}

      {statements.length > 0 && <table className="table compact"><thead><tr><th>Statement</th><th>Period</th><th>Lines</th><th>Matched</th><th>Open</th><th /></tr></thead>
        <tbody>{statements.map((s) => <tr key={s.id}><td>{s.label}</td><td>{s.periodFrom} to {s.periodTo}</td><td>{s.lineCount}</td><td>{s.counts.matched ?? 0}</td>
          <td>{(s.counts.unmatched ?? 0) + (s.counts.suggested ?? 0)}</td><td><button className="btn small" onClick={() => api(`/t/${tenantId}/finance/bank-statements/${s.id}`).then(setOpen)}>Open</button></td></tr>)}</tbody></table>}

      {rec && statements.length > 0 && (
        <div className="figures small-figs">
          <div className="fig"><span className="fig-n">{rec.totals.bankLinesOpen}</span><span className="fig-l">bank lines with no entry ({m(rec.totals.bankAmountOpenMinor)})</span></div>
          <div className="fig"><span className="fig-n">{rec.totals.entriesNotOnStatement}</span><span className="fig-l">bank-paid entries not on a statement ({m(rec.totals.entriesAmountMinor)})</span></div>
          <div className="fig"><span className="fig-n">{rec.clean ? 'Agrees' : 'Differs'}</span><span className="fig-l">register against the bank</span></div>
        </div>
      )}

      {open && (
        <>
          <h3>{open.statement.label}</h3>
          <table className="table compact"><thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Status</th><th>Register entry</th></tr></thead>
            <tbody>{open.lines.map((l: any) => (
              <tr key={l.id}><td>{l.lineDate}</td><td className="small">{l.description}{l.reference ? <span className="muted"> · {l.reference}</span> : null}</td>
                <td className="mono-ish">{l.direction === 'debit' ? '−' : '+'}{m(l.amountMinor)}</td>
                <td><span className={`chip ${STATUS_CHIP[l.matchStatus]}`}>{l.matchStatus === 'unmatched' ? 'not in register' : l.matchStatus}</span>{l.matchNote && <div className="muted small">{l.matchNote}</div>}</td>
                <td className="small">
                  {l.entry && <>{l.entry.partyName}, {l.entry.entryDate} {canEdit && <button className="linklike" onClick={() => act(() => api(`/t/${tenantId}/finance/bank-lines/${l.id}/unmatch`, { method: 'POST', body: {} }))}>unmatch</button>}</>}
                  {!l.entry && canEdit && l.matchStatus !== 'ignored' && <div className="rowflex">
                    {l.candidates.map((c: any) => <button key={c.id} className="btn small" onClick={() => act(() => api(`/t/${tenantId}/finance/bank-lines/${l.id}/match`, { body: { entryId: c.id, ...(c.amountMinor !== l.amountMinor ? { note: window.prompt('Why do the amounts differ?') ?? '' } : {}) } }))}>Match {c.partyName} {m(c.amountMinor)}</button>)}
                    <button className="btn small" onClick={() => { const note = window.prompt('Why does this line not belong in the register? (for example bank charge)'); if (note) act(() => api(`/t/${tenantId}/finance/bank-lines/${l.id}/ignore`, { body: { note } })); }}>Ignore</button>
                  </div>}
                </td></tr>
            ))}</tbody></table>
        </>
      )}

      {rec?.inRegisterNotInBank?.length > 0 && (
        <>
          <h3>In the register but not on the statement</h3>
          <table className="table compact"><thead><tr><th>Date</th><th>Paid to / from</th><th>Amount</th><th>By</th></tr></thead>
            <tbody>{rec.inRegisterNotInBank.map((e: any) => <tr key={e.id}><td>{e.date}</td><td>{e.partyName}</td><td>{m(e.amountMinor)}</td><td>{e.paymentMode}</td></tr>)}</tbody></table>
        </>
      )}
    </section>
  );
}
