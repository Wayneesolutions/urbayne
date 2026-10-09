import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { HttpError } from '../../lib/http.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

export const assignPlanSchema = z.object({
  planCode: z.string(), startedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), taxPercent: z.number().min(0).max(100).nullable().default(null),
  discountPercent: z.number().min(0).max(100).nullable().default(null), status: z.enum(['trial', 'active', 'past_due', 'cancelled']).default('active'),
});
export type AssignPlan = z.infer<typeof assignPlanSchema>;

/** The package must exist, be active and be for the campaign's region. */
export async function findPlanFor(db: Db, planCode: string, region: 'IN' | 'CA') {
  const [p] = await db.select().from(schema.plans).where(eq(schema.plans.code, planCode));
  if (!p || !p.active) throw new HttpError(404, 'PLAN_NOT_FOUND');
  if (p.region !== region) throw new HttpError(422, 'PLAN_REGION_MISMATCH', `This package is for ${p.region} campaigns.`);
  return p;
}

/** Puts a campaign on a package: the package's terms are copied onto its subscription. Must run inside withTenant(tenantId). */
export async function assignPlan(db: Db, tenantId: string, actorId: string, b: AssignPlan, now: Date, ip?: string) {
  const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  if (!t) throw new HttpError(404, 'TENANT_NOT_FOUND');
  const p = await findPlanFor(db, b.planCode, t.region);
  const v = {
    plan: p.name, priceMinor: p.priceMinor, smsRateMinor: p.overageMinor.smsSent ?? 0, smsIncluded: p.included.smsSent ?? 0, taxPercent: b.taxPercent == null ? null : String(b.taxPercent),
    status: b.status, startedOn: b.startedOn, planCode: p.code, billing: p.billing, terms: { included: p.included, overageMinor: p.overageMinor, hardLimits: p.hardLimits },
    discountPercent: b.discountPercent == null ? null : String(b.discountPercent), updatedAt: now,
  };
  const [s] = await db.insert(schema.subscriptions).values({ tenantId, ...v }).onConflictDoUpdate({ target: schema.subscriptions.tenantId, set: v }).returning();
  await db.insert(schema.auditLog).values({ tenantId, actorId, action: 'assign_plan', entity: 'subscription', entityId: tenantId, after: { planCode: p.code, startedOn: b.startedOn, discountPercent: b.discountPercent }, ip });
  return s!;
}
