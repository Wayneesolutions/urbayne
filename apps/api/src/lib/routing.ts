import { haversineKm, type Pt } from '../modules/ops/route.js';

export interface RoadPlan {
  /** Stop ids in the order to drive them, starting from the start point. */
  order: string[];
  km: number;
  minutes: number;
  /** The road line to draw, as [lat, lng] pairs. */
  geometry: [number, number][];
}

export const MAX_ROAD_STOPS = 99; // OSRM's default trip limit is 100 coordinates including the start

/**
 * Orders stops by road distance and returns the road line, using an OSRM server (the /trip service, open path from the start).
 * Returns null when it cannot (no server configured, too many stops, the server is down or answers something unexpected):
 * the caller then falls back to straight-line ordering, so a routing outage never stops sign drops.
 */
export async function roadTrip(base: string | undefined, start: { lat: number; lng: number }, stops: Pt[], fetchImpl: typeof fetch = fetch): Promise<RoadPlan | null> {
  if (!base || !stops.length || stops.length > MAX_ROAD_STOPS) return null;
  const coords = [start, ...stops].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${base.replace(/\/$/, '')}/trip/v1/driving/${coords}?roundtrip=false&source=first&destination=any&overview=full&geometries=geojson`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { code?: string; waypoints?: { waypoint_index?: number }[]; trips?: { distance?: number; duration?: number; geometry?: { coordinates?: [number, number][] } }[] };
    const trip = data.trips?.[0];
    if (data.code !== 'Ok' || !trip || data.waypoints?.length !== stops.length + 1) return null;
    const positions = data.waypoints.map((w) => w.waypoint_index);
    if (positions.some((p) => typeof p !== 'number' || p < 0 || p > stops.length) || new Set(positions).size !== positions.length) return null;
    if (positions[0] !== 0) return null; // the trip must start where we asked
    const order = stops.map((s, i) => ({ id: s.id, pos: positions[i + 1]! })).sort((a, b) => a.pos - b.pos).map((x) => x.id);
    const line = trip.geometry?.coordinates;
    if (!Array.isArray(line) || typeof trip.distance !== 'number' || typeof trip.duration !== 'number') return null;
    return { order, km: Math.round(trip.distance / 100) / 10, minutes: Math.round(trip.duration / 60), geometry: line.filter((c) => Array.isArray(c) && c.length >= 2).map((c) => [c[1], c[0]] as [number, number]) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Straight-line length of a visiting order, used when no road server is available. */
export const lineKm = (start: { lat: number; lng: number }, order: { lat: number; lng: number }[]) =>
  Math.round(order.reduce((s, p, i) => s + haversineKm(i ? order[i - 1]! : start, p), 0) * 10) / 10;
