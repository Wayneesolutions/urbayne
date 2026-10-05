import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { getRegion, type Locale } from '@cs/regions';
import { renderDisclosure } from '@cs/compliance';
import { HttpError, ah } from '../lib/http.js';
import { loadTenant, requireRole } from '../middleware/auth.js';
import { validateDltTemplate } from '@cs/channels';
import type { Deps } from '../types.js';

/** Rejects India SMS text that the DLT portal or the operator would refuse. */
function assertValidDltText(body: string) {
  const check = validateDltTemplate(body);
  if (!check.ok) throw new HttpError(422, 'DLT_TEMPLATE_INVALID', check.errors.join(' '));
}

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
      /** Which platform message this SMS template is for (reminders need a registered 'shift_reminder' template in India). */
      templateKey: z.enum(['shift_reminder', 'ticket_ack', 'ticket_status']).optional(),
    }).parse(req.body);
    if (b.survey && b.kind !== 'script') throw new HttpError(400, 'SURVEY_ONLY_ON_SCRIPTS');
    if (b.templateKey && b.kind !== 'sms_template') throw new HttpError(400, 'TEMPLATE_KEY_ONLY_ON_SMS_TEMPLATES');
    if (!region.locales.includes(b.locale as Locale)) throw new HttpError(400, 'LOCALE_NOT_SUPPORTED');
    // India SMS templates must be valid DLT text from the start, so what gets registered is what gets sent.
    if (b.kind === 'sms_template' && region.smsTemplateIdRequired) assertValidDltText(b.body);
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
      const smsTextChanged = before.kind === 'sms_template' && b.body !== undefined && b.body !== before.body;
      if (smsTextChanged && getRegion(t.region).smsTemplateIdRequired) assertValidDltText(b.body!);
      // A registered DLT template covers its exact text only: changing the text means registering again.
      const dltReset = smsTextChanged
        ? { dltStatus: 'not_registered' as const, dltTemplateId: null, dltHeader: null, dltSubmittedAt: null, dltRejectionReason: null } : {};
      const [after] = await db.update(schema.contentItems).set({
        ...b, ...dltReset, status: 'draft', certificateNo: null, approvedBy: null, approvedAt: null, updatedAt: new Date(),
      }).where(eq(schema.contentItems.id, before.id)).returning();
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'edit_reset_to_draft', entity: 'content_item', entityId: before.id, before, after, ip: req.ip });
      return after;
    });
    res.json(row);
  }));

  /** What to paste into the DLT portal, and where the registration stands. India SMS templates only. */
  r.get('/:id/dlt', requireRole('owner', 'manager'), ah(async (req, res) => {
    const t = req.tenant!;
    if (!getRegion(t.region).smsTemplateIdRequired) throw new HttpError(409, 'DLT_INDIA_ONLY');
    const [item] = await withTenant(pool, t.id, (db) => db.select().from(schema.contentItems).where(eq(schema.contentItems.id, req.params.id!)));
    if (!item) throw new HttpError(404, 'NOT_FOUND');
    if (item.kind !== 'sms_template') throw new HttpError(409, 'NOT_AN_SMS_TEMPLATE');
    const check = validateDltTemplate(item.body);
    res.json({
      status: item.dltStatus, templateId: item.dltTemplateId, header: item.dltHeader, submittedAt: item.dltSubmittedAt, rejectionReason: item.dltRejectionReason,
      templateKey: item.templateKey, portalText: item.body, ...check,
      steps: [
        'Copy "portalText" into a new Content Template on the DLT portal (category: service or transactional as your operator advises).',
        'Mark it submitted here, then wait for the approval.',
        'When approved, record the template id and the 6-letter sender header here. Only then can it be sent.',
      ],
    });
  }));

  /**
   * Record where the DLT registration stands. The platform cannot register templates for you: the operator does that on the DLT portal.
   * submitted -> registered (needs the template id and the 6-letter sender header) or rejected (needs the reason).
   */
  r.post('/:id/dlt', requireRole('owner', 'manager'), ah(async (req, res) => {
    const t = req.tenant!;
    if (!getRegion(t.region).smsTemplateIdRequired) throw new HttpError(409, 'DLT_INDIA_ONLY');
    const b = z.discriminatedUnion('action', [
      z.object({ action: z.literal('submitted') }),
      z.object({ action: z.literal('registered'), templateId: z.string().regex(/^\d{10,25}$/, 'DLT template ids are 10 to 25 digits'), header: z.string().regex(/^[A-Za-z]{6}$/, 'The sender header is 6 letters') }),
      z.object({ action: z.literal('rejected'), reason: z.string().min(3).max(500) }),
    ]).parse(req.body);
    const row = await withTenant(pool, t.id, async (db) => {
      const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, req.params.id!));
      if (!item) throw new HttpError(404, 'NOT_FOUND');
      if (item.kind !== 'sms_template') throw new HttpError(409, 'NOT_AN_SMS_TEMPLATE');
      if (b.action === 'submitted') assertValidDltText(item.body);
      if (b.action !== 'submitted' && item.dltStatus !== 'submitted') throw new HttpError(409, 'MARK_SUBMITTED_FIRST', 'Mark the template as submitted before recording the answer.');
      const patch = b.action === 'submitted'
        ? { dltStatus: 'submitted' as const, dltSubmittedAt: new Date(), dltRejectionReason: null }
        : b.action === 'registered'
          ? { dltStatus: 'registered' as const, dltTemplateId: b.templateId, dltHeader: b.header.toUpperCase(), dltRejectionReason: null }
          : { dltStatus: 'rejected' as const, dltRejectionReason: b.reason, dltTemplateId: null, dltHeader: null };
      const [after] = await db.update(schema.contentItems).set({ ...patch, updatedAt: new Date() }).where(eq(schema.contentItems.id, item.id)).returning();
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: `dlt_${b.action}`, entity: 'content_item', entityId: item.id, before: item, after, ip: req.ip });
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
        // An id typed in at approval means the template was already registered with the operator.
        ...(b.dltTemplateId && item.dltStatus !== 'registered' && { dltStatus: 'registered' as const }),
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
