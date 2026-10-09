import '../../types.js';
import { Router } from 'express';
import { desc } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { ah } from '../../lib/http.js';
import { now } from '../../lib/util.js';
import { loadTenant, requireRole } from '../../middleware/auth.js';
import { subscriptionOf, usageReport } from './metering.js';
import type { Deps } from '../../types.js';

/** A campaign owner's view of their package, how much of it is used, and their invoices. */
export function billingRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  r.use(loadTenant(deps));
  r.use(requireRole('owner', 'manager'));

  r.get('/', ah(async (req, res) => {
    const t = req.tenant!;
    const out = await withTenant(deps.pool, t.id, async (db) => {
      const sub = await subscriptionOf(db);
      const usage = await usageReport(db, t, now(deps));
      const invoices = await db.select().from(schema.invoices).orderBy(desc(schema.invoices.periodStart));
      return {
        currency: t.region === 'IN' ? 'INR' : 'CAD',
        subscription: sub ? { plan: sub.plan, planCode: sub.planCode, billing: sub.billing, status: sub.status, priceMinor: sub.priceMinor, startedOn: sub.startedOn, discountPercent: sub.discountPercent, taxPercent: sub.taxPercent } : null,
        usage, invoices,
      };
    });
    res.json(out);
  }));

  return r;
}
