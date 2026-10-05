import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { ShellCtx } from '../App';

const money = (minor: number, cur: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(minor / 100);

export function ServiceSetup() {
  const { tenant: t, role, reload } = useOutletContext<ShellCtx>();
  const [routes, setRoutes] = useState<any[]>([]);
  const [areas, setAreas] = useState<any[]>([]);
  const [team, setTeam] = useState<any[]>([]);
  const [numbers, setNumbers] = useState<any[]>([]);
  const [billing, setBilling] = useState<any>(null);
  const [form, setForm] = useState({ areaId: '', userId: '' });
  const [sla, setSla] = useState<string>(String((t as any).serviceSlaDays ?? 7));
  const [ret, setRet] = useState<string>((t as any).ticketRetentionDays ? String((t as any).ticketRetentionDays) : '');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const canEdit = role === 'owner' || role === 'manager';
  const load = () => {
    api(`/t/${t.id}/service/routes`).then(setRoutes);
    if (canEdit) api(`/t/${t.id}/service/numbers`).then(setNumbers).catch(() => {});
    if (role === 'owner') api(`/t/${t.id}/service/billing`).then(setBilling).catch(() => {});
  };
  useEffect(() => { load(); api(`/t/${t.id}/geo`).then(setAreas); api(`/t/${t.id}/service/team`).then(setTeam); }, [t.id]);
  const wrap = async (fn: () => Promise<unknown>, ok: string) => { setErr(''); setMsg(''); try { await fn(); setMsg(ok); load(); reload(); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not save.'); } };
  const cur = t.region === 'IN' ? 'INR' : 'CAD';

  return (
    <>
      <header className="page-head"><h1>Service setup</h1>
        <p className="muted">Who receives requests from which area, how fast they should be handled, and how long personal details are kept.</p></header>
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">{err}</p>}

      <div className="panel">
        <h3>Who gets requests from which area</h3>
        <p className="muted">A request goes to the team member set for its area, or for the nearest area above it. Requests with no match wait for someone to take them.</p>
        <table className="table compact"><thead><tr><th>Area</th><th>Team member</th><th /></tr></thead>
          <tbody>{routes.map((x) => <tr key={x.areaId}><td>{x.area}</td><td>{x.user}</td><td>{canEdit && <button className="btn small" onClick={() => wrap(() => api(`/t/${t.id}/service/routes`, { method: 'PUT', body: { areaId: x.areaId, userId: null } }), 'Removed.')}>Remove</button>}</td></tr>)}
            {routes.length === 0 && <tr><td colSpan={3} className="muted">No areas set up yet.</td></tr>}</tbody></table>
        {canEdit && (
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); wrap(() => api(`/t/${t.id}/service/routes`, { method: 'PUT', body: { areaId: form.areaId, userId: form.userId } }), 'Saved.'); }}>
            <label>Area<select value={form.areaId} onChange={(e) => setForm({ ...form, areaId: e.target.value })} required><option value="">–</option>{areas.map((a) => <option key={a.id} value={a.id}>{a.nameEn}</option>)}</select></label>
            <label>Team member<select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} required><option value="">–</option>{team.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.role}</option>)}</select></label>
            <button className="btn">Set</button>
          </form>
        )}
      </div>

      {role === 'owner' && (
        <div className="panel">
          <h3>Service level and retention</h3>
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); wrap(() => api(`/tenants/${t.id}/settings`, { method: 'PATCH', body: { serviceSlaDays: Number(sla), ticketRetentionDays: ret ? Number(ret) : null } }), 'Saved.'); }}>
            <label>Resolve requests within (days)<input type="number" min={1} max={90} value={sla} onChange={(e) => setSla(e.target.value)} /></label>
            <label>Remove personal details this many days after a request is closed<input type="number" min={30} max={3650} value={ret} onChange={(e) => setRet(e.target.value)} placeholder="not set: kept" /></label>
            <button className="btn">Save</button>
          </form>
          <p className="muted small">The right retention period is a legal question: confirm it with your counsel. Until it is set, nothing is removed automatically. Names, request text, notes and the phone link are removed; the category, area and dates stay, so the reports keep working.</p>
        </div>
      )}

      {canEdit && (
        <div className="panel">
          <h3>Numbers for texts and calls</h3>
          <p className="muted">Residents text or call these numbers. Wayne E Solutions registers them for your office.</p>
          <ul className="plain">{numbers.map((n) => <li key={n.id}><strong>{n.kind === 'sms' ? 'Text' : 'Helpline'}</strong> {n.identifier} <span className="muted">({n.provider})</span></li>)}
            {numbers.length === 0 && <li className="muted">None registered yet: residents can still use the web page and your office.</li>}</ul>
        </div>
      )}

      {role === 'owner' && billing && (
        <div className="panel">
          <h3>Subscription and invoices</h3>
          {billing.subscription
            ? <p>{billing.subscription.plan}: {money(billing.subscription.priceMinor, cur)} a month ({billing.subscription.status}).</p>
            : <p className="muted">No subscription is set up yet. Wayne E Solutions sets this up with you.</p>}
          {billing.invoices.length > 0 && (
            <table className="table compact"><thead><tr><th>Invoice</th><th>Month</th><th>Total</th><th>Status</th></tr></thead>
              <tbody>{billing.invoices.map((i: any) => <tr key={i.id}><td className="mono-ish">{i.number}</td><td>{String(i.periodStart).slice(0, 7)}</td><td>{money(i.totalMinor, i.currency)}</td><td>{i.status}</td></tr>)}</tbody></table>
          )}
          <p className="muted small">Payment is arranged directly with Wayne E Solutions for now; online payment is not connected yet.</p>
        </div>
      )}
    </>
  );
}
