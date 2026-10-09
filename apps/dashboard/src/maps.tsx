import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export type MapLayer =
  | { type: 'polygon'; ring: [number, number][]; color: string; label?: string }
  | { type: 'point'; lat: number; lng: number; color: string; label?: string; radius?: number }
  | { type: 'stop'; lat: number; lng: number; n: number; label?: string }
  | { type: 'start'; lat: number; lng: number; label?: string }
  | { type: 'line'; points: [number, number][]; color: string; dashed?: boolean };

interface MapCfg { tileUrl: string; attribution: string }
let cfg: Promise<MapCfg | null> | null = null;
/** Where the map pictures come from (set on the server, so a campaign can use its own tile provider). */
export const useMapConfig = () => {
  const [c, setC] = useState<MapCfg | null>(null);
  useEffect(() => { cfg ??= fetch('/api/region').then((r) => r.json()).then((j) => j.map ?? null).catch(() => null); cfg.then(setC); }, []);
  return c;
};

/** GeoJSON (longitude first) to the [lat, lng] order the map wants. */
export function toLayers(shape: any, color: string, label?: string): MapLayer[] {
  if (shape?.type === 'Point') return [{ type: 'point', lat: shape.coordinates[1], lng: shape.coordinates[0], color, label, radius: 10 }];
  if (shape?.type === 'Polygon') return [{ type: 'polygon', ring: shape.coordinates[0].map((c: number[]) => [c[1], c[0]] as [number, number]), color, label }];
  return [];
}

/** A real map (OpenStreetMap-style tiles) with the given shapes drawn on it. Leaflet is only used to draw; nothing is sent anywhere but the tile requests. */
export function MapView({ layers, height = 380, label }: { layers: MapLayer[]; height?: number; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const group = useRef<L.LayerGroup | null>(null);
  const config = useMapConfig();

  useEffect(() => {
    if (!host.current || map.current || !config) return;
    const m = L.map(host.current, { scrollWheelZoom: false }).setView([20.6, 78.9], 4);
    L.tileLayer(config.tileUrl, { attribution: config.attribution, maxZoom: 19, subdomains: 'abc' }).addTo(m);
    group.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, [config]);

  useEffect(() => {
    const m = map.current, g = group.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: L.LatLngTuple[] = [];
    for (const l of layers) {
      if (l.type === 'polygon') { L.polygon(l.ring, { color: l.color, weight: 2, fillOpacity: 0.25 }).bindTooltip(l.label ?? '').addTo(g); bounds.push(...l.ring); }
      else if (l.type === 'point') { L.circleMarker([l.lat, l.lng], { radius: l.radius ?? 8, color: l.color, fillColor: l.color, fillOpacity: 0.7 }).bindTooltip(l.label ?? '').addTo(g); bounds.push([l.lat, l.lng]); }
      else if (l.type === 'line') { L.polyline(l.points, { color: l.color, weight: 4, opacity: 0.8, dashArray: l.dashed ? '6 8' : undefined }).addTo(g); bounds.push(...l.points); }
      else if (l.type === 'start') { L.marker([l.lat, l.lng], { icon: L.divIcon({ className: 'map-pin start', html: '<span>●</span>', iconSize: [26, 26] }) }).bindTooltip(l.label ?? 'Start').addTo(g); bounds.push([l.lat, l.lng]); }
      else { L.marker([l.lat, l.lng], { icon: L.divIcon({ className: 'map-pin', html: `<span>${l.n}</span>`, iconSize: [26, 26] }) }).bindTooltip(l.label ?? `Stop ${l.n}`).addTo(g); bounds.push([l.lat, l.lng]); }
    }
    if (bounds.length) m.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
  }, [layers, config]);

  if (config === null && !host.current) return <div className="mapbox muted" style={{ height }}>Loading map…</div>;
  return <div ref={host} className="mapbox" style={{ height }} role="img" aria-label={label} />;
}
