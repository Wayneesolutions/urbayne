import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { schema, withTenant, METRICS, type Metric } from '@cs/db';
import { HttpError } from '../../lib/http.js';
import type { TenantRow } from '../../types.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];
export type Usage = Record<Metric, number>;
export { METRICS };
export type Sub = typeof schema.subscriptions.$inferSelect;

export const METRIC_LABEL: Record<Metric, string> = {
  smsSent: 'Texts sent', callMinutes: 'Call minutes', assistantQuestions: 'Assistant questions', contacts: 'Contacts held', teamMembers: 'Team members',
};
/** Used up over time (counted in a window) or a count of what exists right now (capped, never billed per unit). */
export const WINDOWED: Metric[] = ['smsSent', 'callMinutes', 'assistantQuestions'];

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The days a subscription is measured over. Monthly packages: the calendar month containing `at`, and the units included are for
 * that month. Per-campaign packages: from the start date onward, one running total for the whole campaign.
 */
export function usageWindow(sub: Pick<Sub, 'billing' | 'startedOn'>, at: Date): { from: string; to: string | null } {
  const started = String(sub.startedOn).slice(0, 10);
  if (sub.billing === 'per_campaign') return { from: started, to: null };
  const first = `${ymd(at).slice(0, 7)}-01`;
  const next = new Date(Date.UTC(+first.slice(0, 4), +first.slice(5, 7), 1));
  return { from: first, to: ymd(next) };
}

/** Meters what was used between two local dates (to = null: no end). Dates are in the campaign's own time zone. */
export async function meterUsage(db: Db, timeZone: string, from: string, to: string | null): Promise<Usage> {
  const start = sql`((${from}::date)::timestamp AT TIME ZONE ${timeZone})`;
  const end = to ? sql`((${to}::date)::timestamp AT TIME ZONE ${timeZone})` : null;
  const i = schema.interactions;
  const inWindow = (col: unknown) => and(gte(col as never, start), end ? lt(col as never, end) : undefined);
  const [sms] = await db.select({ n: sql<number>`count(*)::int` }).from(i)
    .where(and(eq(i.channel, 'sms'), eq(i.direction, 'outbound'), eq(i.status, 'completed'), inWindow(i.startedAt)));
  const [calls] = await db.select({ n: sql<number>`coalesce(sum(ceil(${i.durationSec} / 60.0)), 0)::int` }).from(i)
    .where(and(eq(i.channel, 'voice'), eq(i.direction, 'outbound'), eq(i.status, 'completed'), inWindow(i.startedAt)));
  const [q] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.assistantQuestions).where(inWindow(schema.assistantQuestions.createdAt));
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.contacts);
  const [m] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.memberships);
  return { smsSent: sms?.n ?? 0, callMinutes: calls?.n ?? 0, assistantQuestions: q?.n ?? 0, contacts: c?.n ?? 0, teamMembers: m?.n ?? 0 };
}

export async function subscriptionOf(db: Db): Promise<Sub | null> {
  const [s] = await db.select().from(schema.subscriptions);
  return s && s.status !== 'cancelled' ? s : null;
}

/** Where a campaign stands against its package right now, metric by metric. */
export async function usageReport(db: Db, t: TenantRow, at: Date) {
  const sub = await subscriptionOf(db);
  if (!sub?.terms) return null;
  const w = usageWindow(sub, at);
  const used = await meterUsage(db, t.timeZone, w.from, w.to);
  const terms = sub.terms;
  return {
    plan: sub.plan, planCode: sub.planCode, billing: sub.billing, status: sub.status, period: w,
    metrics: METRICS.map((k) => {
      const limit = terms.hardLimits[k] ?? null;
      const included = terms.included[k] ?? null;
      return { metric: k, label: METRIC_LABEL[k], used: used[k], included, overageMinor: terms.overageMinor[k] ?? null, limit, share: limit ? used[k] / limit : included ? used[k] / included : null, over: included != null && used[k] > included, atLimit: limit != null && used[k] >= limit };
    }),
  };
}

/** True when this campaign has used up a capped metric. No package, or no cap on the metric, means never. */
export async function planLimitReached(db: Db, t: TenantRow, metric: Metric, at: Date, adding = 0): Promise<{ limit: number; used: number } | null> {
  const sub = await subscriptionOf(db);
  const limit = sub?.terms?.hardLimits[metric];
  if (!sub || limit == null) return null;
  const w = WINDOWED.includes(metric) ? usageWindow(sub, at) : { from: '1970-01-01', to: null };
  const used = (await meterUsage(db, t.timeZone, w.from, w.to))[metric];
  return used + adding > limit ? { limit, used } : null;
}

/** Stops an action that would take the campaign past its package cap. The owner is told what to do about it. */
export async function assertWithinPlan(db: Db, t: TenantRow, metric: Metric, at: Date, adding = 1) {
  const hit = await planLimitReached(db, t, metric, at, adding);
  if (hit) throw new HttpError(402, 'PLAN_LIMIT_REACHED', `Your package allows ${hit.limit} ${METRIC_LABEL[metric].toLowerCase()} and ${hit.used} are used. Ask Wayne E Solutions to move you to a larger package.`);
}
