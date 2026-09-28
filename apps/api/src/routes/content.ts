import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { getRegion, type Locale } from '@cs/regions';
import { renderDisclosure } from '@cs/compliance';
import { HttpError, ah } from '../lib/http.js';
import { loadTenant, requireRole } from '../middleware/auth.js';
import type { Deps } from '../types.js';

const kinds = ['script', 'sms_template', 'page', 'faq', 'ad'] as const;
const surveySchema = z.array(z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  question: z.string().min(3).max(300),
  options: z.array(z.object({ value: z.string().min(1).max(40), label: z.string().min(1).max(80), dtmf: z.string().regex(/^[0-9]$/) })).min(2).max(9),
})).max(5);

export function contentRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool } = deps;
  r.use(loadTenant(deps));

  r.get('/', ah(async (req, res) => {
    const rows = await withTenant(pool, req.tenant!.id, (db) =>
      db.select().from(schema.contentItems).orderBy(desc(schema.contentItems.updatedAt)));
    res.json(rows);
  }));

  r.post('/', requireRole('owner', 'manager'), ah(async (req, res) => {
    const t = req.tenant!;
    const region = getRegion(t.region);
    const b = z.object({
      kind: z.enum(kinds),
      locale: z.string(),
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(20_000),
      geoAreaId: z.string().uuid().optional(),
      survey: surveySchema.optional(),
    }).parse(req.body);
    if (b.survey && b.kind !== 'script') throw new HttpError(400, 'SURVEY_ONLY_ON_SCRIPTS');
    if (!region.locales.includes(b.locale as Locale)) throw new HttpError(400, 'LOCALE_NOT_SUPPORTED');
    const row = await withTenant(pool, t.id, async (db) => {
      const [c] = await db.insert(schema.contentItems).values({ tenantId: t.id, ...b }).returning();
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'create', entity: 'content_item', entityId: c!.id, after: c, ip: req.ip });
      return c;
    });
    res.status(201).json(row);
  }));

  // Any edit sends content back to draft: approval and certificates cover exact text only.
  r.patch('/:id', requireRole('owner', 'manager'), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({ title: z.string().min(1).max(200).optional(), body: z.string().min(1).max(20_000).optional(), survey: surveySchema.optional() }).parse(req.body);
    const row = await withTenant(pool, t.id, async (db) => {
      const [before] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, req.params.id!));
      if (!before) throw new HttpError(404, 'NOT_FOUND');
      const [after] = await db.update(schema.contentItems).set({
        ...b, status: 'draft', certificateNo: null, approvedBy: null, approvedAt: null, updatedAt: new Date(),
      }).where(eq(schema.contentItems.id, before.id)).returning();
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'edit_reset_to_draft', entity: 'content_item', entityId: before.id, before, after, ip: req.ip });
      return after;
    });
    res.json(row);
  }));

  r.post('/:id/approve', requireRole('owner'), ah(async (req, res) => {
    const t = req.tenant!;
    const region = getRegion(t.region);
    const b = z.object({ certificateNo: z.string().min(3).optional(), dltTemplateId: z.string().min(3).optional() }).parse(req.body);
    const row = await withTenant(pool, t.id, async (db) => {
      const [item] = await db.select().from(schema.contentItems).where(and(eq(schema.contentItems.id, req.params.id!)));
      if (!item) throw new HttpError(404, 'NOT_FOUND');

      // Voice scripts must open with the disclosure before anyone can approve them.
      if (item.kind === 'script') {
        const opening = renderDisclosure({ region, tenant: { ...t, pollCloseAt: t.pollCloseAt, id: t.id } as any }, item.locale as Locale);
        if (!item.body.trim().startsWith(opening.replace(/\.$/, ''))) {
          throw new HttpError(422, 'DISCLOSURE_MISSING', `Script must begin with: "${opening}"`);
        }
      }
      const needsCert = region.approvalGate.type === 'mcmc_certificate' && ['script', 'sms_template', 'ad'].includes(item.kind);
      if (needsCert && !b.certificateNo) throw new HttpError(422, 'CERTIFICATE_REQUIRED', 'Enter the MCMC certificate number.');
      if (item.kind === 'sms_template' && region.smsTemplateIdRequired && !b.dltTemplateId && !item.dltTemplateId) {
        throw new HttpError(422, 'DLT_TEMPLATE_REQUIRED');
      }
      const [after] = await db.update(schema.contentItems).set({
        status: needsCert ? 'certified' : 'approved',
        certificateNo: b.certificateNo ?? null,
        dltTemplateId: b.dltTemplateId ?? item.dltTemplateId,
        approvedBy: req.user!.id,
        approvedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.contentItems.id, item.id)).returning();
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'approve', entity: 'content_item', entityId: item.id, before: item, after, ip: req.ip });
      return after;
    });
    res.json(row);
  }));

  return r;
}
