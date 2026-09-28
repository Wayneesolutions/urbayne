import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { and, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { getRegion } from '@cs/regions';
import { HttpError, ah } from '../../lib/http.js';
import { encrypt, hashPhone, normalisePhone } from '../../lib/crypto.js';
import { rateLimit } from '../../lib/util.js';
import { answer, assistantText } from '../assistant/answer.js';
import type { Deps } from '../../types.js';

export const CONSENT_TEXT_VERSION = 'public-form-v1';

async function tenantIdBySlug(deps: Deps, slug: string): Promise<string> {
  const { rows } = await deps.pool.query('SELECT id FROM tenant_by_slug($1)', [slug]);
  if (!rows[0]) throw new HttpError(404, 'NOT_FOUND');
  return rows[0].id as string;
}

/** Voter-facing API: no login. Everything goes through the slug and RLS. */
export function publicRoutes(deps: Deps) {
  const r = Router();
  const { pool, env } = deps;
  r.use(rateLimit(60, 60_000));

  r.get('/:slug', ah(async (req, res) => {
    const id = await tenantIdBySlug(deps, req.params.slug!);
    const t = await withTenant(pool, id, async (db) => (await db.select().from(schema.tenants).where(eq(schema.tenants.id, id)))[0]!);
    const region = getRegion(t.region);
    res.json({
      slug: t.slug, region: t.region, candidateName: t.candidateName ?? t.campaignName, campaignName: t.campaignName,
      tagline: t.tagline, officialInfoUrl: t.officialInfoUrl, locales: region.locales.filter((l) => ['pa', 'hi', 'en'].includes(l) || t.region === 'CA'),
      defaultLocale: region.defaultLocale, demo: t.isDemo,
      assistantDisclosure: Object.fromEntries(['en', 'pa', 'hi'].map((l) => [l, assistantText(l).disclosure])),
    });
  }));

  r.get('/:slug/areas', ah(async (req, res) => {
    const id = await tenantIdBySlug(deps, req.params.slug!);
    const q = String(req.query.q ?? '').trim();
    const rows = await withTenant(pool, id, (db) => db.select({
      id: schema.geoAreas.id, level: schema.geoAreas.level, nameEn: schema.geoAreas.nameEn, namePa: schema.geoAreas.namePa, nameHi: schema.geoAreas.nameHi,
    }).from(schema.geoAreas).where(and(
      inArray(schema.geoAreas.level, ['locality', 'ward', 'village', 'colony', 'street', 'neighbourhood']),
      q ? or(ilike(schema.geoAreas.nameEn, `%${q}%`), ilike(schema.geoAreas.namePa, `%${q}%`), ilike(schema.geoAreas.nameHi, `%${q}%`)) : sql`true`,
    )).orderBy(schema.geoAreas.nameEn).limit(40));
    res.json(rows);
  }));

  r.get('/:slug/areas/:areaId', ah(async (req, res) => {
    const id = await tenantIdBySlug(deps, req.params.slug!);
    const locale = String(req.query.locale ?? 'en');
    const out = await withTenant(pool, id, async (db) => {
      const [area] = await db.select().from(schema.geoAreas).where(eq(schema.geoAreas.id, req.params.areaId!));
      if (!area) throw new HttpError(404, 'NOT_FOUND');
      // Area pages for this area and its parents, plus campaign-wide pages (no area).
      const chain: string[] = [area.id];
      let parent = area.parentId;
      while (parent) {
        chain.push(parent);
        const [p] = await db.select({ parentId: schema.geoAreas.parentId }).from(schema.geoAreas).where(eq(schema.geoAreas.id, parent));
        parent = p?.parentId ?? null;
      }
      const pages = await db.select({ id: schema.contentItems.id, title: schema.contentItems.title, body: schema.contentItems.body, locale: schema.contentItems.locale, geoAreaId: schema.contentItems.geoAreaId })
        .from(schema.contentItems).where(and(
          eq(schema.contentItems.kind, 'page'), inArray(schema.contentItems.status, ['approved', 'certified']),
          or(inArray(schema.contentItems.geoAreaId, chain), isNull(schema.contentItems.geoAreaId)),
        ));
      const inLocale = pages.filter((p) => p.locale === locale);
      const chosen = (inLocale.length ? inLocale : pages.filter((p) => p.locale === 'en'))
        .sort((a, b) => Number(b.geoAreaId === area.id) - Number(a.geoAreaId === area.id));
      return { area: { id: area.id, nameEn: area.nameEn, namePa: area.namePa, nameHi: area.nameHi, level: area.level }, pages: chosen };
    });
    res.json(out);
  }));

  r.post('/:slug/signup', rateLimit(10, 60_000), ah(async (req, res) => {
    const id = await tenantIdBySlug(deps, req.params.slug!);
    const b = z.object({
      name: z.string().max(120).optional(),
      phone: z.string(),
      areaId: z.string().uuid().optional(),
      interests: z.array(z.enum(['updates', 'volunteer', 'issue', 'sign', 'question'])).min(1),
      issueText: z.string().max(1000).optional(),
      locale: z.string().default('en'),
      consentCalls: z.boolean().default(false),
      consentSms: z.boolean().default(false),
      ref: z.string().max(16).optional(),
    }).strict().parse(req.body);
    const phone = normalisePhone(b.phone);
    const phoneHash = hashPhone(phone, env.PHONE_HASH_KEY);
    await withTenant(pool, id, async (db) => {
      let [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.phoneHash, phoneHash));
      if (!c) {
        [c] = await db.insert(schema.contacts).values({
          tenantId: id, phoneHash, phoneEnc: encrypt(phone, env.PHONE_ENC_KEY), name: b.name, geoAreaId: b.areaId, source: 'form',
          tags: [...b.interests, ...(b.ref ? [`ref:${b.ref}`] : [])],
        }).returning();
      } else {
        await db.update(schema.contacts).set({
          tags: sql`array(select distinct unnest(${schema.contacts.tags} || ${b.interests}::text[]))`, updatedAt: new Date(),
        }).where(eq(schema.contacts.id, c.id));
      }
      const consentRows = [
        ...(b.consentCalls ? (['info', 'reminder', 'survey'] as const).map((purpose) => ({ purpose, channel: 'voice' as const })) : []),
        ...(b.consentSms ? (['info', 'reminder'] as const).map((purpose) => ({ purpose, channel: 'sms' as const })) : []),
      ];
      if (consentRows.length) {
        await db.insert(schema.consents).values(consentRows.map((x) => ({
          ...x, tenantId: id, contactId: c!.id, textVersion: CONSENT_TEXT_VERSION, locale: b.locale, capturedVia: 'form',
        })));
        // A new consent also lifts an earlier opt-out, because the person just asked to hear from the campaign.
        await db.update(schema.contacts).set({ optedOut: false }).where(eq(schema.contacts.id, c!.id));
      }
      if (b.ref) await db.update(schema.shareLinks).set({ signups: sql`${schema.shareLinks.signups} + 1` }).where(eq(schema.shareLinks.code, b.ref));
      await db.insert(schema.auditLog).values({ tenantId: id, action: 'public_signup', entity: 'contact', entityId: c!.id, after: { interests: b.interests, consents: consentRows.length, ref: b.ref ?? null }, ip: req.ip });
    });
    res.status(201).json({ ok: true });
  }));

  r.post('/:slug/assistant/ask', rateLimit(20, 60_000), ah(async (req, res) => {
    const id = await tenantIdBySlug(deps, req.params.slug!);
    const b = z.object({ question: z.string().min(2).max(500), locale: z.string().default('en') }).parse(req.body);
    const out = await withTenant(pool, id, async (db) => {
      const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, id));
      const items = await db.select().from(schema.contentItems).where(and(
        inArray(schema.contentItems.kind, ['faq', 'page']), inArray(schema.contentItems.status, ['approved', 'certified']),
      ));
      const inLocale = items.filter((i) => i.locale === b.locale);
      const pool2 = (inLocale.length ? inLocale : items).map((i) => ({ id: i.id, title: i.title, body: i.body, locale: i.locale }));
      const a = await answer(b.question, b.locale, pool2, t?.officialInfoUrl ?? null, { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL });
      await db.insert(schema.assistantQuestions).values({ tenantId: id, question: b.question, locale: b.locale, outcome: a.outcome, citedContentId: a.source?.id ?? null });
      return a;
    });
    res.json({ ...out, disclosure: assistantText(b.locale).disclosure });
  }));

  return r;
}
