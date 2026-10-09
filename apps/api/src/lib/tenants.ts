import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { schema, withTenant } from '@cs/db';
import { getProvince, getRegion } from '@cs/regions';
import { HttpError } from './http.js';
import type { Deps } from '../types.js';

export const MODULES = ['hub', 'assistant', 'calls', 'field', 'ops', 'finance', 'results', 'service'] as const;

export const createCampaignSchema = z.object({
  raceType: z.enum(['assembly', 'parliament', 'municipal', 'ward', 'trustee', 'panchayat', 'other']),
  seatCode: z.string().min(1).max(64),
  electionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  campaignName: z.string().min(2).max(120),
  timeZone: z.string().optional(),
  pollCloseAt: z.string().datetime({ offset: true }).optional(),
  enabledModules: z.array(z.enum(MODULES)).default([]),
  /** 'office' = a sitting representative's service office (no election-date deletion; ticket retention instead). */
  kind: z.enum(['campaign', 'office']).default('campaign'),
  /** Canadian province whose rules apply (for example MB). Only for Canadian deployments. */
  province: z.string().regex(/^[A-Z]{2}$/).optional(),
});
export type CreateCampaign = z.infer<typeof createCampaignSchema>;

/** Checks that need no database: run them before creating anything else (an account, a package) for the campaign. */
export function checkCampaign(deps: Deps, b: CreateCampaign) {
  const region = getRegion(deps.env.DEPLOY_REGION);
  if (b.province && !getProvince(region.code, b.province)) throw new HttpError(422, 'PROVINCE_NOT_SUPPORTED', `Provincial rules for ${b.province} are not set up on this deployment.`);
  return region;
}

/** Creates a campaign for this deployment's region and makes `ownerId` its owner. One active campaign per seat. */
export async function createCampaign(deps: Deps, ownerId: string, b: CreateCampaign, ip?: string) {
  const region = checkCampaign(deps, b);
  const id = randomUUID();
  try {
    return await withTenant(deps.pool, id, async (db) => {
      const [t] = await db.insert(schema.tenants).values({
        id,
        region: region.code,
        raceType: b.raceType,
        seatCode: b.seatCode.trim().toUpperCase(),
        electionDate: b.electionDate,
        campaignName: b.campaignName,
        timeZone: b.timeZone ?? region.defaultTimeZone,
        pollCloseAt: b.pollCloseAt ? new Date(b.pollCloseAt) : null,
        enabledModules: b.enabledModules,
        kind: b.kind,
        province: b.province ?? null,
      }).returning();
      await db.insert(schema.memberships).values({ tenantId: id, userId: ownerId, role: 'owner' });
      await db.insert(schema.auditLog).values({ tenantId: id, actorId: ownerId, action: 'create', entity: 'tenant', entityId: id, after: t, ip });
      return t!;
    });
  } catch (e: any) {
    // drizzle wraps the database error: the Postgres error (code, constraint) is on .cause
    const pgErr = e?.cause ?? e;
    if (pgErr?.code === '23505' && String(pgErr?.constraint ?? pgErr?.message).includes('one_race_one_client')) {
      throw new HttpError(409, 'ONE_RACE_ONE_CLIENT', 'This seat already has an active campaign on the platform.');
    }
    throw e;
  }
}
