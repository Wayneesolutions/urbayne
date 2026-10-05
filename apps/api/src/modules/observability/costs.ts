import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { and, eq, gte, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { loadTenant, requireRole, requireUser } from '../../middleware/auth.js';
import { now } from '../../lib/util.js';
import { fxRateFor, usdMicrosToMinor } from '../calls/cost.js';
import type { Deps } from '../../types.js';

const days = z.coerce.number().int().min(1).max(366).default(30);
const usd = (micros: number) => Math.round(micros / 1e4) / 100; // micro-dollars to dollars, 2 decimals

/** One campaign's AI call spend: by day and by run, and how much of the spending limit it uses. */
export function costRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  r.use(loadTenant(deps));
  r.use(requireRole('owner', 'manager', 'finance_agent'));

  r.get('/', ah(async (req, res) => {
    const t = req.tenant!;
    const n = days.parse(req.query.days);
    const since = new Date(now(deps).getTime() - n * 86_400_000);
    const rate = fxRateFor(deps.env, t.region);
    const out = await withTenant(deps.pool, t.id, async (db) => {
      const i = schema.interactions;
      const costed = and(gte(i.startedAt, since), sql`${i.costUsdMicros} IS NOT NULL`);
      const [tot] = await db.select({ calls: sql<number>`count(*)::int`, micros: sql<number>`coalesce(sum(${i.costUsdMicros}), 0)::bigint` }).from(i).where(costed);
      const day = sql<string>`to_char(${i.startedAt} AT TIME ZONE ${t.timeZone}, 'YYYY-MM-DD')`;
      const byDay = await db.select({ day, calls: sql<number>`count(*)::int`, micros: sql<number>`sum(${i.costUsdMicros})::bigint` }).from(i).where(costed).groupBy(sql`1`).orderBy(sql`1`); // group by the first column: the time zone is a bound parameter, so the expression cannot be repeated
      const byRun = await db.select({ runId: i.runId, name: schema.campaignRuns.name, calls: sql<number>`count(*)::int`, micros: sql<number>`sum(${i.costUsdMicros})::bigint` })
        .from(i).leftJoin(schema.campaignRuns, eq(schema.campaignRuns.id, i.runId)).where(costed).groupBy(i.runId, schema.campaignRuns.name).orderBy(sql`sum(${i.costUsdMicros}) desc`).limit(20);
      const [spent] = await db.select({ minor: sql<number>`coalesce(sum(${schema.financeEntries.amountMinor}), 0)::bigint` }).from(schema.financeEntries)
        .where(and(eq(schema.financeEntries.kind, 'expense'), eq(schema.financeEntries.source, 'call_run')));
      const [allSpent] = await db.select({ minor: sql<number>`coalesce(sum(${schema.financeEntries.amountMinor}), 0)::bigint` }).from(schema.financeEntries)
        .where(eq(schema.financeEntries.kind, 'expense'));
      return { tot, byDay, byRun, callCostsInRegisterMinor: Number(spent?.minor ?? 0), allSpendMinor: Number(allSpent?.minor ?? 0) };
    });
    const micros = Number(out.tot?.micros ?? 0), calls = out.tot?.calls ?? 0;
    res.json({
      days: n, currency: t.region === 'IN' ? 'INR' : 'CAD', fxRate: rate,
      calls, totalUsd: usd(micros), totalMinor: usdMicrosToMinor(micros, rate), avgPerCallUsd: calls ? Math.round((micros / calls) / 1e2) / 1e4 : 0,
      byDay: out.byDay.map((d) => ({ day: d.day, calls: d.calls, usd: usd(Number(d.micros)) })),
      byRun: out.byRun.map((x) => ({ runId: x.runId, name: x.name, calls: x.calls, usd: usd(Number(x.micros)) })),
      spendLimitMinor: t.spendLimitMinor, callCostsInRegisterMinor: out.callCostsInRegisterMinor,
      shareOfLimit: t.spendLimitMinor ? out.callCostsInRegisterMinor / t.spendLimitMinor : null,
    });
  }));
  return r;
}

/** Platform-wide provider cost (all campaigns). Wayne E Solutions staff only. */
export function adminCostRoutes(deps: Deps) {
  const r = Router();
  r.get('/costs', requireUser(deps), ah(async (req, res) => {
    if (!req.user!.wes) throw new HttpError(403, 'FORBIDDEN');
    const n = days.parse(req.query.days);
    const to = now(deps);
    const from = new Date(to.getTime() - n * 86_400_000);
    const { rows } = await deps.pool.query('SELECT * FROM provider_costs($1, $2)', [from, to]);
    const items = rows.map((x) => ({
      tenantId: x.tenant_id as string, campaign: x.campaign_name as string, region: x.region as string, demo: x.is_demo as boolean,
      calls: Number(x.calls), usd: usd(Number(x.cost_usd_micros)),
    }));
    const live = items.filter((x) => !x.demo);
    res.json({
      days: n, totalUsd: Math.round(live.reduce((s, x) => s + x.usd, 0) * 100) / 100, totalCalls: live.reduce((s, x) => s + x.calls, 0),
      byRegion: ['IN', 'CA'].map((region) => ({ region, usd: Math.round(live.filter((x) => x.region === region).reduce((s, x) => s + x.usd, 0) * 100) / 100 })),
      campaigns: items,
    });
  }));
  return r;
}
