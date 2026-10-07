import type { schema, Metric } from '@cs/db';
import { METRIC_LABEL, WINDOWED } from './metering.js';

export interface PlanSub {
  plan: string; billing: 'per_campaign' | 'monthly'; priceMinor: number; taxPercent: string | null; discountPercent: string | null; startedOn: string;
  terms: NonNullable<(typeof schema.subscriptions.$inferSelect)['terms']>;
}

const daysInMonth = (m: string) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();

/**
 * One invoice for a package subscription.
 *  - Monthly: the price (pro rata in the first month) and, for each metered unit, what was used in the month beyond what the package includes.
 *  - Per campaign: the price once, in the month the campaign starts; usage beyond the included units is billed as it happens, cumulatively,
 *    and a unit already billed on an earlier invoice (`billedBefore`) is never billed again.
 * Units with no overage price are never billed per unit: they are only capped. Tax is added only when a rate was set for the subscription.
 */
export function buildPlanInvoice(sub: PlanSub, month: string, used: Partial<Record<Metric, number>>, billedBefore: Partial<Record<Metric, number>> = {}) {
  const lines: schema.InvoiceLine[] = [];
  const started = String(sub.startedOn).slice(0, 10);
  const dim = daysInMonth(month);
  const startsThisMonth = started.slice(0, 7) === month;
  const startedBefore = started.slice(0, 7) < month;

  let base = 0;
  if (sub.billing === 'monthly') {
    const activeDays = startedBefore ? dim : startsThisMonth ? dim - Number(started.slice(8, 10)) + 1 : 0;
    if (activeDays > 0) {
      base = activeDays === dim ? sub.priceMinor : Math.round((sub.priceMinor * activeDays) / dim);
      lines.push({ description: activeDays === dim ? `${sub.plan}, ${month}` : `${sub.plan}, ${month} (${activeDays} of ${dim} days)`, quantity: 1, unitMinor: sub.priceMinor, amountMinor: base });
    }
  } else if (startsThisMonth) {
    base = sub.priceMinor;
    lines.push({ description: `${sub.plan}: campaign package`, quantity: 1, unitMinor: sub.priceMinor, amountMinor: base });
  }
  const active = startedBefore || startsThisMonth;
  if (base > 0 && sub.discountPercent != null && Number(sub.discountPercent) > 0) {
    const off = Math.round((base * Number(sub.discountPercent)) / 100);
    lines.push({ description: `Discount ${Number(sub.discountPercent)}%`, quantity: 1, unitMinor: -off, amountMinor: -off });
  }
  if (active) {
    for (const k of Object.keys(METRIC_LABEL) as Metric[]) {
      const price = sub.terms.overageMinor[k];
      if (!WINDOWED.includes(k) || !price || price <= 0) continue;
      const over = Math.max(0, (used[k] ?? 0) - (sub.terms.included[k] ?? 0));
      const billable = sub.billing === 'per_campaign' ? Math.max(0, over - (billedBefore[k] ?? 0)) : over;
      if (billable > 0) lines.push({ description: `${METRIC_LABEL[k]} beyond the ${sub.terms.included[k] ?? 0} included (${used[k]} used)`, quantity: billable, unitMinor: price, amountMinor: billable * price, metric: k });
    }
  }
  const subtotal = lines.reduce((s, l) => s + l.amountMinor, 0);
  const taxMinor = sub.taxPercent == null ? 0 : Math.round((subtotal * Number(sub.taxPercent)) / 100);
  return { lines, subtotalMinor: subtotal, taxMinor, totalMinor: subtotal + taxMinor };
}

/** Units of each metric already billed on earlier (not void) invoices. */
export function billedUnits(invoices: { status: string; lines: schema.InvoiceLine[] }[]): Partial<Record<Metric, number>> {
  const out: Partial<Record<Metric, number>> = {};
  for (const inv of invoices) {
    if (inv.status === 'void') continue;
    for (const l of inv.lines) if (l.metric) out[l.metric] = (out[l.metric] ?? 0) + l.quantity;
  }
  return out;
}
