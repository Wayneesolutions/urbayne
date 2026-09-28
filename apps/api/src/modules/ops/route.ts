export interface Pt { id: string; lat: number; lng: number }

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371, toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Nearest-neighbour ordering, then 2-opt improvement. Good enough for an evening of sign drops. */
export function planRoute(start: { lat: number; lng: number }, pts: Pt[]): { order: Pt[]; km: number } {
  const left = [...pts];
  const order: Pt[] = [];
  let cur: { lat: number; lng: number } = start;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) if (haversineKm(cur, left[i]!) < haversineKm(cur, left[best]!)) best = i;
    cur = left.splice(best, 1)[0]!;
    order.push(cur as Pt);
  }
  const len = (o: Pt[]) => o.reduce((s, p, i) => s + haversineKm(i ? o[i - 1]! : start, p), 0);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let k = i + 1; k < order.length; k++) {
        const cand = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
        if (len(cand) + 1e-9 < len(order)) { order.splice(0, order.length, ...cand); improved = true; }
      }
    }
  }
  return { order, km: Math.round(len(order) * 10) / 10 };
}
