import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { getPack, getProvince, getRegion, packsFor, type ChecklistItem, type ElectionPack } from '@cs/regions';
import { renderDisclosure } from '@cs/compliance';
import { DLT_SUGGESTED_TEMPLATES } from '@cs/channels';
import { HttpError, ah } from '../../lib/http.js';
import { now } from '../../lib/util.js';
import { loadTenant, requireRole, requireUser } from '../../middleware/auth.js';
import type { Deps, TenantRow } from '../../types.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

const summary = (p: ElectionPack) => ({
  id: p.id, title: p.title, election: p.election, region: p.region, province: p.province ?? null, locales: p.locales, modules: p.enabledModules,
  contentItems: p.content.length, checklistItems: p.checklist.length, confirmWithCounsel: p.confirmWithCounsel,
});

/** Where a campaign stands on each onboarding item, from its own settings and data. Items marked manual are ticked by the owner. */
export async function checklistStatus(db: Db, t: TenantRow, pack: ElectionPack) {
  const region = getRegion(t.region);
  const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const facts = {
    slug: Boolean(t.slug), pollClose: Boolean(t.pollCloseAt), spendLimit: t.spendLimitMinor != null, retention: t.retentionDays != null,
    callingHours: Boolean(region.callingHours || t.callingHoursOverride),
    rolls: (await count(db.select({ n: sql<number>`count(*)::int` }).from(schema.rollImports))) > 0,
    team: (await count(db.select({ n: sql<number>`count(*)::int` }).from(schema.memberships))) >= 3,
    contentApproved: (await count(db.select({ n: sql<number>`count(*)::int` }).from(schema.contentItems).where(and(eq(schema.contentItems.kind, 'page'), inArray(schema.contentItems.status, ['approved', 'certified']))))) > 0,
    dlt: t.region !== 'IN' || (await count(db.select({ n: sql<number>`count(*)::int` }).from(schema.contentItems).where(and(eq(schema.contentItems.kind, 'sms_template'), eq(schema.contentItems.dltStatus, 'registered'))))) > 0,
  } as const;
  const items = pack.checklist.map((it: ChecklistItem) => {
    const manual = t.packChecks[it.id];
    const done = it.check === 'manual' ? Boolean(manual) : facts[it.check];
    return { ...it, done, manual: it.check === 'manual', tickedAt: manual?.at ?? null };
  });
  return { items, done: items.filter((i) => i.done).length, total: items.length };
}

/** Election packages: list what is available, apply one to a campaign, follow the onboarding checklist. */
export function packRoutes(deps: Deps) {
  const r = Router();
  r.get('/', requireUser(deps), (_req, res) => res.json(packsFor(deps.env.DEPLOY_REGION).map(summary)));
  return r;
}

export function tenantPackRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool } = deps;
  r.use(loadTenant(deps));

  r.get('/', ah(async (req, res) => {
    const t = req.tenant!;
    const province = getProvince(t.region, t.province);
    const rules = province ? { ...province, unset: ['spendLimitMinor', 'contributionLimitMinor', 'silenceWindowHours'].filter((k) => (province as any)[k] == null) } : null;
    const pack = t.packId ? getPack(t.packId) : undefined;
    const progress = pack ? await withTenant(pool, t.id, (db) => checklistStatus(db, t, pack)) : null;
    res.json({
      applied: pack ? { ...summary(pack), appliedAt: t.packAppliedAt } : null,
      available: pack ? [] : packsFor(t.region).filter((p) => !p.province || p.province === t.province || !t.province).map(summary),
      progress, province: rules,
    });
  }));

  /** Creates the pack's content as drafts, turns on its modules and sets the campaign's province. Once per campaign. */
  r.post('/apply', requireRole('owner'), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({ packId: z.string() }).strict().parse(req.body);
    const pack = getPack(b.packId);
    if (!pack || pack.region !== t.region) throw new HttpError(404, 'PACK_NOT_FOUND');
    if (t.packId) throw new HttpError(409, 'PACK_ALREADY_APPLIED', 'This campaign already has an election package.');
    if (pack.province && t.province && t.province !== pack.province) throw new HttpError(422, 'PACK_PROVINCE_MISMATCH', `This package is for ${pack.province}.`);
    const region = getRegion(t.region);
    const out = await withTenant(pool, t.id, async (db) => {
      const created: { id: string; kind: string; locale: string; title: string }[] = [];
      for (const c of pack.content) {
        let body = c.body;
        if (c.kind === 'script') {
          const opening = renderDisclosure({ region, tenant: { id: t.id, campaignName: t.campaignName, timeZone: t.timeZone, pollCloseAt: t.pollCloseAt, callingHoursOverride: null } }, c.locale);
          body = body.replace('{DISCLOSURE}', opening).replace('{CAMPAIGN}', t.campaignName);
        }
        const [row] = await db.insert(schema.contentItems).values({ tenantId: t.id, kind: c.kind, locale: c.locale, title: c.title, body, survey: c.survey ?? null }).returning();
        created.push({ id: row!.id, kind: row!.kind, locale: row!.locale, title: row!.title });
      }
      // India texts must be registered DLT templates: start the one campaigns need (shift reminders) from the suggested wording.
      if (t.region === 'IN') {
        const s = DLT_SUGGESTED_TEMPLATES.shift_reminder;
        const [row] = await db.insert(schema.contentItems).values({ tenantId: t.id, kind: 'sms_template', locale: 'en', title: 'Shift reminder', body: s.body, templateKey: 'shift_reminder' }).returning();
        created.push({ id: row!.id, kind: row!.kind, locale: row!.locale, title: row!.title });
      }
      const modules = [...new Set([...t.enabledModules, ...pack.enabledModules])];
      await db.update(schema.tenants).set({ packId: pack.id, packAppliedAt: now(deps), enabledModules: modules, province: t.province ?? pack.province ?? null, updatedAt: new Date() }).where(eq(schema.tenants.id, t.id));
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'apply_pack', entity: 'tenant', entityId: t.id, after: { packId: pack.id, content: created.length }, ip: req.ip });
      return { packId: pack.id, created, modules };
    });
    res.status(201).json(out);
  }));

  /** Tick or untick an onboarding item that the platform cannot see for itself (for example a certificate obtained). */
  r.post('/checks/:itemId', requireRole('owner', 'manager'), ah(async (req, res) => {
    const t = req.tenant!;
    const pack = t.packId ? getPack(t.packId) : undefined;
    const item = pack?.checklist.find((i) => i.id === req.params.itemId);
    if (!pack || !item) throw new HttpError(404, 'NOT_FOUND');
    if (item.check !== 'manual') throw new HttpError(409, 'AUTOMATIC_ITEM', 'This item is checked from the campaign\'s own settings.');
    const b = z.object({ done: z.boolean() }).strict().parse(req.body);
    const checks = { ...t.packChecks };
    if (b.done) checks[item.id] = { by: req.user!.id, at: now(deps).toISOString() }; else delete checks[item.id];
    await withTenant(pool, t.id, async (db) => {
      await db.update(schema.tenants).set({ packChecks: checks, updatedAt: new Date() }).where(eq(schema.tenants.id, t.id));
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: b.done ? 'pack_check_done' : 'pack_check_undone', entity: 'tenant', entityId: t.id, after: { item: item.id }, ip: req.ip });
    });
    res.json({ id: item.id, done: b.done });
  }));

  return r;
}

