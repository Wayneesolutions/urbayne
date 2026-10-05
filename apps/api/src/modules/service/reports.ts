import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { requireRole } from '../../middleware/auth.js';
import { now } from '../../lib/util.js';
import { csvCell } from '../finance/rules.js';
import type { Deps } from '../../types.js';

const num = (v: unknown) => (v == null ? 0 : Number(v));
const monthOf = (d: Date, tz: string) => d.toLocaleDateString('en-CA', { timeZone: tz }).slice(0, 7);

/** Monthly figures for the office: what came in, what was done, how fast, and where. */
export function reportRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool } = deps;

  r.get('/', ah(async (req, res) => {
    const t = req.tenant!;
    const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).default(monthOf(now(deps), t.timeZone)).parse(req.query.month);
    const start = `${month}-01`;
    const out = await withTenant(pool, t.id, async (db) => {
      const q = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows as Record<string, unknown>[];
      // The month in the office's own time zone: [start, end)
      const bounds = sql`(${start}::date)::timestamp AT TIME ZONE ${t.timeZone}`;
      const endBounds = sql`((${start}::date + interval '1 month')::timestamp AT TIME ZONE ${t.timeZone})`;

      const [tot] = await q(sql`
        SELECT count(*) FILTER (WHERE created_at >= ${bounds} AND created_at < ${endBounds})::int AS received,
               count(*) FILTER (WHERE resolved_at >= ${bounds} AND resolved_at < ${endBounds})::int AS resolved,
               count(*) FILTER (WHERE created_at < ${endBounds} AND (resolved_at IS NULL OR resolved_at >= ${endBounds}) AND status NOT IN ('rejected', 'closed') AND (closed_at IS NULL OR closed_at >= ${endBounds}))::int AS open_at_month_end,
               count(*) FILTER (WHERE status NOT IN ('resolved', 'closed', 'rejected') AND due_at < ${sql`${now(deps)}::timestamptz`})::int AS overdue_now,
               round(avg(extract(epoch FROM (resolved_at - created_at)) / 86400) FILTER (WHERE resolved_at >= ${bounds} AND resolved_at < ${endBounds}), 1) AS avg_days_to_resolve,
               count(*) FILTER (WHERE resolved_at >= ${bounds} AND resolved_at < ${endBounds} AND resolved_at <= due_at)::int AS resolved_in_time,
               count(*) FILTER (WHERE created_at >= ${bounds} AND created_at < ${endBounds} AND status = 'rejected')::int AS rejected
        FROM tickets`);
      const byCategory = await q(sql`
        SELECT category, count(*) FILTER (WHERE created_at >= ${bounds} AND created_at < ${endBounds})::int AS received,
               count(*) FILTER (WHERE resolved_at >= ${bounds} AND resolved_at < ${endBounds})::int AS resolved,
               round(avg(extract(epoch FROM (resolved_at - created_at)) / 86400) FILTER (WHERE resolved_at >= ${bounds} AND resolved_at < ${endBounds}), 1) AS avg_days
        FROM tickets GROUP BY category HAVING count(*) FILTER (WHERE created_at >= ${bounds} AND created_at < ${endBounds}) > 0 OR count(*) FILTER (WHERE resolved_at >= ${bounds} AND resolved_at < ${endBounds}) > 0
        ORDER BY received DESC`);
      const byArea = await q(sql`
        SELECT coalesce(g.name_en, 'Not matched to an area') AS area, g.level AS level, count(*) FILTER (WHERE tk.created_at >= ${bounds} AND tk.created_at < ${endBounds})::int AS received,
               count(*) FILTER (WHERE tk.resolved_at >= ${bounds} AND tk.resolved_at < ${endBounds})::int AS resolved,
               count(*) FILTER (WHERE tk.status NOT IN ('resolved', 'closed', 'rejected'))::int AS open_now
        FROM tickets tk LEFT JOIN geo_areas g ON g.id = tk.geo_area_id
        GROUP BY g.name_en, g.level HAVING count(*) FILTER (WHERE tk.created_at >= ${bounds} AND tk.created_at < ${endBounds}) > 0 OR count(*) FILTER (WHERE tk.resolved_at >= ${bounds} AND tk.resolved_at < ${endBounds}) > 0
        ORDER BY received DESC LIMIT 100`);
      const byChannel = await q(sql`SELECT channel, count(*)::int AS received FROM tickets WHERE created_at >= ${bounds} AND created_at < ${endBounds} GROUP BY channel ORDER BY received DESC`);
      const [ack] = await q(sql`
        SELECT count(*) FILTER (WHERE contact_id IS NOT NULL)::int AS with_phone, count(acknowledged_at)::int AS acknowledged,
               count(*) FILTER (WHERE acknowledged_at IS NOT NULL AND acknowledged_at - created_at <= interval '60 seconds')::int AS within_60s,
               round(avg(extract(epoch FROM (acknowledged_at - created_at))))::int AS avg_seconds
        FROM tickets WHERE created_at >= ${bounds} AND created_at < ${endBounds}`);
      const trend = await q(sql`
        SELECT to_char(m, 'YYYY-MM') AS month,
               (SELECT count(*)::int FROM tickets WHERE created_at >= m AND created_at < m + interval '1 month') AS received,
               (SELECT count(*)::int FROM tickets WHERE resolved_at >= m AND resolved_at < m + interval '1 month') AS resolved
        FROM generate_series(((${start}::date - interval '5 months')::timestamp AT TIME ZONE ${t.timeZone}), ${bounds}, interval '1 month') AS m ORDER BY m`);
      return { tot: tot!, byCategory, byArea, byChannel, ack: ack!, trend };
    });
    const resolved = num(out.tot.resolved);
    res.json({
      month, serviceLevelDays: t.serviceSlaDays,
      received: num(out.tot.received), resolved, rejected: num(out.tot.rejected), openAtMonthEnd: num(out.tot.open_at_month_end), overdueNow: num(out.tot.overdue_now),
      avgDaysToResolve: out.tot.avg_days_to_resolve == null ? null : Number(out.tot.avg_days_to_resolve),
      resolvedInTimeShare: resolved ? num(out.tot.resolved_in_time) / resolved : null,
      acknowledgement: {
        withPhone: num(out.ack.with_phone), acknowledged: num(out.ack.acknowledged), within60s: num(out.ack.within_60s), avgSeconds: out.ack.avg_seconds == null ? null : num(out.ack.avg_seconds),
      },
      byCategory: out.byCategory.map((c) => ({ category: c.category, received: num(c.received), resolved: num(c.resolved), avgDays: c.avg_days == null ? null : Number(c.avg_days) })),
      byArea: out.byArea.map((a) => ({ area: a.area, level: a.level, received: num(a.received), resolved: num(a.resolved), openNow: num(a.open_now) })),
      byChannel: out.byChannel.map((c) => ({ channel: c.channel, received: num(c.received) })),
      trend: out.trend.map((m) => ({ month: m.month, received: num(m.received), resolved: num(m.resolved) })),
    });
  }));

  /**
   * "Work done": what was resolved, where and how fast, for the next campaign or a public report. Never contains a name,
   * a phone number or the request text. The note on what was done is added only on request, by the owner, because staff
   * sometimes write names in it.
   */
  r.get('/work-done.csv', requireRole('owner', 'manager'), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), includeNotes: z.enum(['1']).optional() }).parse(req.query);
    if (b.includeNotes && req.role !== 'owner') throw new HttpError(403, 'OWNER_ONLY', 'Only the owner can include the notes on what was done.');
    const rows = await withTenant(pool, t.id, async (db) => (await db.execute(sql`
      SELECT tk.ref, tk.category, coalesce(g.name_en, '') AS area, coalesce(g.level, '') AS level, tk.channel,
             to_char(tk.created_at AT TIME ZONE ${t.timeZone}, 'YYYY-MM-DD') AS received_on, to_char(tk.resolved_at AT TIME ZONE ${t.timeZone}, 'YYYY-MM-DD') AS resolved_on,
             round(extract(epoch FROM (tk.resolved_at - tk.created_at)) / 86400, 1) AS days, tk.resolution_note AS note
      FROM tickets tk LEFT JOIN geo_areas g ON g.id = tk.geo_area_id
      WHERE tk.resolved_at IS NOT NULL AND (tk.resolved_at AT TIME ZONE ${t.timeZone})::date BETWEEN ${b.from}::date AND ${b.to}::date
      ORDER BY tk.resolved_at`)).rows as Record<string, unknown>[]);
    const head = ['Request', 'Category', 'Area', 'Area type', 'How it came in', 'Received', 'Resolved', 'Days taken', ...(b.includeNotes ? ['What was done'] : [])];
    const lines = rows.map((x) => [x.ref, x.category, x.area, x.level, x.channel, x.received_on, x.resolved_on, x.days, ...(b.includeNotes ? [x.note ?? ''] : [])].map(csvCell).join(','));
    res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="work-done-${b.from}-to-${b.to}.csv"`);
    res.send([`# ${t.candidateName ?? t.campaignName}: requests resolved ${b.from} to ${b.to}. No names, phone numbers or request text.`, head.map(csvCell).join(','), ...lines].join('\n'));
  }));

  return r;
}
