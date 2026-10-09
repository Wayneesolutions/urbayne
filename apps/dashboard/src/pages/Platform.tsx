import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errText } from '../api';
import { money } from '../money';

const METRICS = [['smsSent', 'Texts sent'], ['callMinutes', 'Call minutes'], ['assistantQuestions', 'Assistant questions'], ['contacts', 'Contacts held'], ['teamMembers', 'Team members']] as const;
const PRICED = new Set(['smsSent', 'callMinutes', 'assistantQuestions']);
type Units = Record<string, string>;
const blank = { code: '', name: '', region: 'IN', billing: 'per_campaign', price: '', active: true, included: {} as Units, overage: {} as Units, limit: {} as Units };

/** Platform staff only: define packages (prices are entered here, nothing is built in) and put a campaign on one. */
export function Platform() {
  const nav = useNavigate();
  const [plans, setPlans] = useState<any[]>([]);
  const [f, setF] = useState(blank);
  const [a, setA] = useState({ tenantId: '', planCode: '', startedOn: new Date().toISOString().slice(0, 10), discount: '', tax: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api('/admin/plans').then(setPlans).catch(() => nav('/'));
  useEffect(() => { load(); }, []);

  const toUnits = (u: Units) => Object.fromEntries(Object.entries(u).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
  const toMinor = (s: string) => Math.round(Number(s) * 100);
  const edit = (p: any) => setF({
    code: p.code, name: p.name, region: p.region, billing: p.billing, price: String(p.priceMinor / 100), active: p.active,
    included: Object.fromEntries(Object.entries(p.included).map(([k, v]) => [k, String(v)])),
    overage: Object.fromEntries(Object.entries(p.overageMinor).map(([k, v]) => [k, String((v as number) / 100)])),
    limit: Object.fromEntries(Object.entries(p.hardLimits).map(([k, v]) => [k, String(v)])),
  });
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    try {
      await api(`/admin/plans/${f.code}`, { method: 'PUT', body: {
        name: f.name, region: f.region, billing: f.billing, priceMinor: toMinor(f.price), active: f.active,
        included: toUnits(f.included), overageMinor: Object.fromEntries(Object.entries(toUnits(f.overage)).map(([k, v]) => [k, Math.round(v * 100)])), hardLimits: toUnits(f.limit),
      } });
      setMsg({ ok: true, text: 'Package saved. Campaigns already on it keep the terms they were given.' }); setF(blank); load();
    } catch (x) { setMsg({ ok: false, text: errText(x, 'Could not save.') }); }
  }
  async function assign(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    try {
      await api(`/admin/tenants/${a.tenantId}/plan`, { method: 'PUT', body: { planCode: a.planCode, startedOn: a.startedOn, discountPercent: a.discount ? Number(a.discount) : null, taxPercent: a.tax ? Number(a.tax) : null } });
      setMsg({ ok: true, text: 'Campaign is on the package.' });
    } catch (x) { setMsg({ ok: false, text: errText(x, 'Could not assign.') }); }
  }
  const cell = (key: 'included' | 'overage' | 'limit', m: string, label: string) => (
    <label key={`${key}${m}`}>{label}<input inputMode="decimal" value={f[key][m] ?? ''} onChange={(e) => setF({ ...f, [key]: { ...f[key], [m]: e.target.value } })} /></label>
  );

  return (
    <div className="work" style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <header className="page-head row"><div><h1>Packages and pricing</h1><p className="muted">Platform staff only. Prices are in the campaign’s currency (rupees or dollars), not paise or cents. A blank box means “none”.</p></div><Link className="btn" to="/">Back</Link></header>
      {msg && <p className={msg.ok ? 'muted' : 'err'} role="status">{msg.text}</p>}

      <table className="table compact"><thead><tr><th>Code</th><th>Name</th><th>Region</th><th>Billing</th><th>Price</th><th>Included / extra price / cap</th><th /></tr></thead>
        <tbody>{plans.map((p) => (
          <tr key={p.code}><td>{p.code}{!p.active && <span className="chip"> inactive</span>}</td><td>{p.name}</td><td>{p.region}</td><td>{p.billing === 'per_campaign' ? 'per campaign' : 'monthly'}</td><td>{money(p.priceMinor, p.currency)}</td>
            <td className="small">{METRICS.map(([k, l]) => (p.included[k] != null || p.overageMinor[k] != null || p.hardLimits[k] != null) && <div key={k}>{l}: {p.included[k] ?? '–'} incl. / {p.overageMinor[k] != null ? money(p.overageMinor[k], p.currency) : '–'} / cap {p.hardLimits[k] ?? '–'}</div>)}</td>
            <td><button className="btn small" onClick={() => edit(p)}>Edit</button></td></tr>
        ))}</tbody></table>

      <form className="panel stack" onSubmit={save}>
        <h2>{plans.some((p) => p.code === f.code) ? 'Edit package' : 'New package'}</h2>
        <div className="grid4">
          <label>Code<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} pattern="[a-z0-9_-]{2,40}" placeholder="assembly-2027" required /></label>
          <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <label>Region<select value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })}><option value="IN">India (INR)</option><option value="CA">Canada (CAD)</option></select></label>
          <label>Billing<select value={f.billing} onChange={(e) => setF({ ...f, billing: e.target.value })}><option value="per_campaign">One price per campaign</option><option value="monthly">Monthly</option></select></label>
          <label>Price<input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required /></label>
          <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Can be given to campaigns</label>
        </div>
        <h3>Units</h3>
        <p className="muted small">Included: covered by the price. Extra price: charged per unit beyond that. Cap: the hard stop (calls pause, adding people is refused). Team members and contacts have a cap only.</p>
        {METRICS.map(([k, l]) => (
          <div className="grid4" key={k}><strong>{l}</strong>{cell('included', k, 'Included')}{PRICED.has(k) ? cell('overage', k, 'Extra price per unit') : <span />}{cell('limit', k, 'Cap')}</div>
        ))}
        <button className="btn primary" style={{ alignSelf: 'flex-start' }}>Save package</button>
      </form>

      <form className="panel inline-form" onSubmit={assign}>
        <h2 style={{ width: '100%' }}>Put a campaign on a package</h2>
        <label style={{ flex: '2 1 280px' }}>Campaign id<input value={a.tenantId} onChange={(e) => setA({ ...a, tenantId: e.target.value })} placeholder="the id in the campaign’s address" required /></label>
        <label>Package<select value={a.planCode} onChange={(e) => setA({ ...a, planCode: e.target.value })} required><option value="">Choose…</option>{plans.filter((p) => p.active).map((p) => <option key={p.code} value={p.code}>{p.name} ({p.region})</option>)}</select></label>
        <label>Starts<input type="date" value={a.startedOn} onChange={(e) => setA({ ...a, startedOn: e.target.value })} required /></label>
        <label>Discount %<input inputMode="decimal" value={a.discount} onChange={(e) => setA({ ...a, discount: e.target.value })} /></label>
        <label>Tax % (only if confirmed)<input inputMode="decimal" value={a.tax} onChange={(e) => setA({ ...a, tax: e.target.value })} /></label>
        <button className="btn primary">Assign</button>
      </form>
    </div>
  );
}
