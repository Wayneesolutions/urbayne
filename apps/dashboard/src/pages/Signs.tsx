import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { MapView, type MapLayer } from '../maps';
import type { ShellCtx } from '../App';

/** Lawn signs (Canada): requests, delivery route for tonight on a real map, and status. */
export function Signs() {
  const { tenant: t } = useOutletContext<ShellCtx>();
  const [signs, setSigns] = useState<any[]>([]);
  const [route, setRoute] = useState<any>(null);
  const load = () => { api(`/t/${t.id}/ops/signs`).then(setSigns); api(`/t/${t.id}/ops/signs/route`).then(setRoute); };
  useEffect(() => { load(); }, [t.id]);
  const setStatus = async (id: string, status: string) => { await api(`/t/${t.id}/ops/signs/${id}`, { method: 'PATCH', body: { status } }); load(); };
  const count = (s: string) => signs.filter((x) => x.status === s).length;

  const pts: any[] = route?.order ?? [];
  const layers = useMemo<MapLayer[]>(() => {
    if (!route?.start || !pts.length) return [];
    const line: [number, number][] = route.geometry ?? [[route.start.lat, route.start.lng], ...pts.map((p) => [p.lat, p.lng] as [number, number])];
    return [
      { type: 'line', points: line, color: '#1E2240', dashed: !route.geometry },
      { type: 'start', lat: route.start.lat, lng: route.start.lng, label: 'Start (campaign office)' },
      ...pts.map((p, i): MapLayer => ({ type: 'stop', lat: p.lat, lng: p.lng, n: i + 1, label: `${i + 1}. ${p.address}` })),
    ];
  }, [route]);

  return (
    <>
      <header className="page-head"><h1>Lawn signs</h1><p className="muted">Requests come from the voter page and from canvassers. Tonight’s route orders the drops so one driver covers them in the shortest loop.</p></header>
      <div className="figures">
        <div className="fig"><span className="fig-n">{count('requested')}</span><span className="fig-l">waiting for a sign</span></div>
        <div className="fig"><span className="fig-n">{count('placed')}</span><span className="fig-l">placed</span></div>
        <div className="fig"><span className="fig-n">{route?.km ?? 0} km</span><span className="fig-l">tonight’s route{route?.minutes ? `, about ${route.minutes} min` : ''}</span></div>
      </div>
      {pts.length > 0 && (
        <section className="panel">
          <h2>Tonight’s route, {pts.length} stops</h2>
          <p className="muted small">{route?.routing === 'road' ? 'Ordered and measured along the roads.' : 'Straight-line distances: connect a road routing server for driving distances and times (see the setup guide).'}{route?.unlocated ? ` ${route.unlocated} request(s) have no map position yet and are not on this route.` : ''}</p>
          <MapView layers={layers} label={`Delivery route with ${pts.length} stops, ${route.km} km`} />
          <ol className="stops">{pts.map((p: any) => <li key={p.id}><span>{p.address}</span><button className="btn small" onClick={() => setStatus(p.id, 'placed')}>Placed</button></li>)}</ol>
        </section>
      )}
      <table className="table"><thead><tr><th>Address</th><th>Status</th><th /></tr></thead>
        <tbody>{signs.map((s) => <tr key={s.id}><td>{s.address}</td><td>{s.status}</td>
          <td className="actions">{s.status === 'placed' && <button className="btn small" onClick={() => setStatus(s.id, 'collected')}>Collected</button>}</td></tr>)}</tbody></table>
    </>
  );
}
