import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { getProvince, getRegion } from '@cs/regions';
import { HttpError, ah } from '../lib/http.js';
import { loadTenant, requireRole } from '../middleware/auth.js';
import type { Deps } from '../types.js';

export const MODULES = ['hub', 'assistant', 'calls', 'field', 'ops', 'finance', 'results', 'service'] as const;

const createSchema = z.object({
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

export function tenantRoutes(deps: Deps) {
  const r = Router();
  const { env, pool } = deps;

  r.post('/', ah(async (req, res) => {
    const b = createSchema.parse(req.body);
    const region = getRegion(env.DEPLOY_REGION);
    if (b.province && !getProvince(region.code, b.province)) throw new HttpError(422, 'PROVINCE_NOT_SUPPORTED', `Provincial rules for ${b.province} are not set up on this deployment.`);
    const id = randomUUID();
    try {
      const tenant = await withTenant(pool, id, async (db) => {
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
        await db.insert(schema.memberships).values({ tenantId: id, userId: req.user!.id, role: 'owner' });
        await db.insert(schema.auditLog).values({ tenantId: id, actorId: req.user!.id, action: 'create', entity: 'tenant', entityId: id, after: t, ip: req.ip });
        return t;
      });
      res.status(201).json(tenant);
    } catch (e: any) {
      // drizzle wraps the database error: the Postgres error (code, constraint) is on .cause
      const pgErr = e?.cause ?? e;
      if (pgErr?.code === '23505' && String(pgErr?.constraint ?? pgErr?.message).includes('one_race_one_client')) {
        throw new HttpError(409, 'ONE_RACE_ONE_CLIENT', 'This seat already has an active campaign on the platform.');
      }
      throw e;
    }
  }));

  r.get('/:tenantId', loadTenant(deps), (req, res) => res.json({ tenant: req.tenant, role: req.role }));

  r.patch('/:tenantId/settings', loadTenant(deps), requireRole('owner'), ah(async (req, res) => {
    const b = z.object({
      pollCloseAt: z.string().datetime({ offset: true }).nullable().optional(),
      enabledModules: z.array(z.enum(MODULES)).optional(),
      spendLimitMinor: z.number().int().positive().nullable().optional(),
      /** Personal data is deleted this many days after the election (7 to 3650). Confirm the right number with counsel. */
      retentionDays: z.number().int().min(7).max(3650).nullable().optional(),
      /** Days within which a request should be resolved. */
      serviceSlaDays: z.number().int().min(1).max(90).optional(),
      /** Personal details on closed requests are removed this many days after closing (30 to 3650). Confirm the right number with counsel. */
      ticketRetentionDays: z.number().int().min(30).max(3650).nullable().optional(),
      slug: z.string().regex(/^[a-z0-9-]{3,40}$/).optional(),
      candidateName: z.string().max(120).optional(),
      tagline: z.string().max(200).optional(),
      officialInfoUrl: z.string().url().optional(),
      contributionLimitMinor: z.number().int().positive().nullable().optional(),
      officeLat: z.number().min(-90).max(90).optional(),
      officeLng: z.number().min(-180).max(180).optional(),
      callingHoursOverride: z.object({
        weekday: z.object({ start: z.number().int().min(0).max(1440), end: z.number().int().min(0).max(1440) }),
        weekend: z.object({ start: z.number().int().min(0).max(1440), end: z.number().int().min(0).max(1440) }),
      }).nullable().optional(),
    }).parse(req.body);
    // Calling hours are a legal setting: only demo tenants may set them here.
    // Live tenants get counsel-confirmed values through region config or a wes_admin change.
    if (b.callingHoursOverride !== undefined && !req.tenant!.isDemo) {
      throw new HttpError(403, 'CALLING_HOURS_LOCKED', 'Calling hours for live campaigns are set by Wayne E Solutions after legal confirmation.');
    }
    const t = req.tenant!;
    const updated = await withTenant(pool, t.id, async (db) => {
      const [u] = await db.update(schema.tenants).set({
        ...(b.pollCloseAt !== undefined && { pollCloseAt: b.pollCloseAt ? new Date(b.pollCloseAt) : null }),
        ...(b.enabledModules && { enabledModules: b.enabledModules }),
        ...(b.spendLimitMinor !== undefined && { spendLimitMinor: b.spendLimitMinor }),
        ...(b.retentionDays !== undefined && { retentionDays: b.retentionDays }),
        ...(b.serviceSlaDays !== undefined && { serviceSlaDays: b.serviceSlaDays }),
        ...(b.ticketRetentionDays !== undefined && { ticketRetentionDays: b.ticketRetentionDays }),
        ...(b.slug && { slug: b.slug }),
        ...(b.candidateName !== undefined && { candidateName: b.candidateName }),
        ...(b.tagline !== undefined && { tagline: b.tagline }),
        ...(b.officialInfoUrl !== undefined && { officialInfoUrl: b.officialInfoUrl }),
        ...(b.contributionLimitMinor !== undefined && { contributionLimitMinor: b.contributionLimitMinor }),
        ...(b.officeLat !== undefined && { officeLat: b.officeLat }),
        ...(b.officeLng !== undefined && { officeLng: b.officeLng }),
        ...(b.callingHoursOverride !== undefined && { callingHoursOverride: b.callingHoursOverride }),
        updatedAt: new Date(),
      }).where(eq(schema.tenants.id, t.id)).returning();
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'update_settings', entity: 'tenant', entityId: t.id, before: t, after: u, ip: req.ip });
      return u;
    });
    res.json(updated);
  }));

  return r;
}
