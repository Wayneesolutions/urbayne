import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../api';
import type { ShellCtx } from '../App';

/** Lawn signs (Canada): requests, delivery route for tonight, and status. */
export function Signs() {
  const { tenant: t } = useOutletContext<ShellCtx>();
  const [signs, setSigns] = useState<any[]>([]);
  const [route, setRoute] = useState<any>(null);
  const load = () => { api(`/t/${t.id}/ops/signs`).then(setSigns); api(`/t/${t.id}/ops/signs/route`).then(setRoute); };
  useEffect(() => { load(); }, [t.id]);
  const setStatus = async (id: string, status: string) => { await api(`/t/${t.id}/ops/signs/${id}`, { method: 'PATCH', body: { status } }); load(); };
  const count = (s: string) => signs.filter((x) => x.status === s).length;

  // Simple projected plot of the route (no map tiles needed).
  const pts = route?.order ?? [];
  const all = [route?.start, ...pts].filter(Boolean);
  const [minLat, maxLat] = [Math.min(...all.map((p: any) => p.lat)), Math.max(...all.map((p: any) => p.lat))];
  const [minLng, maxLng] = [Math.min(...all.map((p: any) => p.lng)), Math.max(...all.map((p: any) => p.lng))];
  const W = 640, H = 360, pad = 28;
  const X = (lng: number) => pad + ((lng - minLng) / (maxLng - minLng || 1)) * (W - 2 * pad);
  const Y = (lat: number) => H - pad - ((lat - minLat) / (maxLat - minLat || 1)) * (H - 2 * pad);

  return (
    <>
      <header className="page-head"><h1>Lawn signs</h1><p className="muted">Requests come from the voter page and from canvassers. Tonight’s route orders the drops so one driver covers them in the shortest loop.</p></header>
      <div className="figures">
        <div className="fig"><span className="fig-n">{count('requested')}</span><span className="fig-l">waiting for a sign</span></div>
        <div className="fig"><span className="fig-n">{count('placed')}</span><span className="fig-l">placed</span></div>
        <div className="fig"><span className="fig-n">{route?.km ?? 0} km</span><span className="fig-l">tonight’s route</span></div>
      </div>
      {pts.length > 0 && (
        <section className="panel">
          <h2>Tonight’s route, {pts.length} stops</h2>
          <svg viewBox={`0 0 ${W} ${H}`} className="routemap" role="img" aria-label={`Delivery route with ${pts.length} stops, ${route.km} km`}>
            <polyline fill="none" stroke="#1E2240" strokeWidth="2" points={all.map((p: any) => `${X(p.lng)},${Y(p.lat)}`).join(' ')} />
            <rect x={X(route.start.lng) - 8} y={Y(route.start.lat) - 8} width="16" height="16" rx="3" fill="#E8A317" />
            {pts.map((p: any, i: number) => <g key={p.id}><circle cx={X(p.lng)} cy={Y(p.lat)} r="11" fill="#fff" stroke="#1E2240" strokeWidth="2" /><text x={X(p.lng)} y={Y(p.lat) + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="#1E2240">{i + 1}</text></g>)}
          </svg>
          <ol className="stops">{pts.map((p: any) => <li key={p.id}><span>{p.address}</span><button className="btn small" onClick={() => setStatus(p.id, 'placed')}>Placed</button></li>)}</ol>
        </section>
      )}
      <table className="table"><thead><tr><th>Address</th><th>Status</th><th /></tr></thead>
        <tbody>{signs.map((s) => <tr key={s.id}><td>{s.address}</td><td>{s.status}</td>
          <td className="actions">{s.status === 'placed' && <button className="btn small" onClick={() => setStatus(s.id, 'collected')}>Collected</button>}</td></tr>)}</tbody></table>
    </>
  );
}
