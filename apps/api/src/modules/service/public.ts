import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { decrypt } from '../../lib/crypto.js';
import { now } from '../../lib/util.js';
import { rateLimit } from '../../lib/rate-limit.js';
import { CATEGORIES, CATEGORY_LABELS, guessCategory, STATUS_WORDS } from './categories.js';
import { personForTicket } from './people.js';
import { queueTicketSms } from './sms.js';
import { createTicket, resolveArea } from './tickets.js';
import type { Deps } from '../../types.js';

async function tenantIdBySlug(deps: Deps, slug: string): Promise<string> {
  const { rows } = await deps.pool.query('SELECT id FROM tenant_by_slug($1)', [slug]);
  if (!rows[0]) throw new HttpError(404, 'NOT_FOUND');
  return rows[0].id as string;
}

const MESSAGES = {
  pa: (ref: string) => `ਤੁਹਾਡੀ ਸ਼ਿਕਾਇਤ ਦਰਜ ਹੋ ਗਈ ਹੈ। ਨੰਬਰ: ${ref}। ਇਹ ਨੰਬਰ ਸੰਭਾਲ ਕੇ ਰੱਖੋ।`,
  hi: (ref: string) => `आपकी शिकायत दर्ज हो गई है। नंबर: ${ref}। यह नंबर सँभाल कर रखें।`,
  en: (ref: string) => `Your request is recorded. Your number is ${ref}. Keep it to check progress.`,
};

/** Residents' side of constituent service: raise a request on the public page, and check its progress. No login. */
export function servicePublicRoutes(deps: Deps) {
  const r = Router();
  const { pool, env } = deps;

  /** What the form needs: the office, the categories, and the areas people can choose. */
  r.get('/:slug/service', rateLimit(deps.rateStore, 60, 60_000), ah(async (req, res) => {
    const id = await tenantIdBySlug(deps, req.params.slug!);
    const out = await withTenant(pool, id, async (db) => {
      const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, id));
      const areas = await db.select({ id: schema.geoAreas.id, level: schema.geoAreas.level, nameEn: schema.geoAreas.nameEn, namePa: schema.geoAreas.namePa, nameHi: schema.geoAreas.nameHi, code: schema.geoAreas.code })
        .from(schema.geoAreas).orderBy(asc(schema.geoAreas.nameEn)).limit(500);
      return { t: t!, areas };
    });
    res.json({
      office: out.t.candidateName ?? out.t.campaignName, slaDays: out.t.serviceSlaDays,
      categories: CATEGORIES.map((key) => ({ key, ...CATEGORY_LABELS[key] })),
      areas: out.areas,
      consentText: {
        en: 'Send me a text when my request is received and when it is updated. I can reply STOP at any time.',
        pa: 'ਮੇਰੀ ਸ਼ਿਕਾਇਤ ਮਿਲਣ ਅਤੇ ਅੱਪਡੇਟ ਹੋਣ ਤੇ ਮੈਨੂੰ ਟੈਕਸਟ ਭੇਜੋ। ਮੈਂ ਕਦੇ ਵੀ STOP ਭੇਜ ਸਕਦਾ/ਸਕਦੀ ਹਾਂ।',
        hi: 'मेरी शिकायत मिलने और अपडेट होने पर मुझे टेक्स्ट भेजें। मैं कभी भी STOP भेज सकता/सकती हूँ।',
      },
    });
  }));

  r.post('/:slug/tickets', rateLimit(deps.rateStore, 5, 60_000), ah(async (req, res) => {
    const id = await tenantIdBySlug(deps, req.params.slug!);
    const b = z.object({
      category: z.enum(CATEGORIES).optional(), title: z.string().trim().min(3).max(200), description: z.string().trim().max(2000).optional(),
      areaId: z.string().uuid().optional(), areaText: z.string().trim().max(200).optional(),
      name: z.string().trim().max(120).optional(), phone: z.string().trim().max(30).optional(), smsConsent: z.boolean().default(false),
      language: z.enum(['pa', 'hi', 'en']).default('en'),
      website: z.string().max(200).optional(), // hidden field: only bots fill it in
    }).strict().parse(req.body);
    if (b.website) return res.status(201).json({ ref: 'T-0000', message: MESSAGES[b.language]('T-0000') }); // pretend, so bots learn nothing
    if (b.smsConsent && !b.phone) throw new HttpError(422, 'PHONE_REQUIRED');

    const out = await withTenant(pool, id, async (db) => {
      const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, id));
      const geoAreaId = await resolveArea(db, { areaId: b.areaId, areaText: b.areaText });
      const person = await personForTicket(db, id, env, { phone: b.phone, name: b.name, geoAreaId, smsConsent: b.smsConsent, via: 'form', locale: b.language });
      if (person.contactId) {
        // One person cannot flood the office: at most 5 requests a day from the same number.
        const [recent] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.tickets)
          .where(and(eq(schema.tickets.contactId, person.contactId), gt(schema.tickets.createdAt, new Date(now(deps).getTime() - 86_400_000))));
        if ((recent?.n ?? 0) >= 5) throw new HttpError(429, 'TOO_MANY_REQUESTS', 'Too many requests from this number today. Please call the office.');
      }
      const { ticket } = await createTicket(db, t!, {
        channel: 'web', category: b.category ?? guessCategory(`${b.title} ${b.description ?? ''}`) ?? 'other', title: b.title, description: b.description,
        geoAreaId, areaText: geoAreaId ? null : b.areaText, contactId: person.contactId, requesterName: b.name, language: b.language,
      }, now(deps));
      return { ticket, texts: person.contactId !== null && person.smsConsent };
    });
    if (out.texts) await queueTicketSms(deps, id, out.ticket.id, 'ack');
    res.status(201).json({ ref: out.ticket.ref, message: MESSAGES[b.language](out.ticket.ref) });
  }));

  /** Progress of a request. Needs the request number AND the last 4 digits of the phone it was raised with; anything else is a plain 404. */
  r.get('/:slug/tickets/:ref', rateLimit(deps.rateStore, 20, 60_000), ah(async (req, res) => {
    const id = await tenantIdBySlug(deps, req.params.slug!);
    const q = z.object({ last4: z.string().regex(/^\d{4}$/) }).safeParse(req.query);
    if (!q.success) throw new HttpError(404, 'NOT_FOUND');
    const ref = z.string().regex(/^T-\d{3,8}$/i).safeParse(req.params.ref);
    if (!ref.success) throw new HttpError(404, 'NOT_FOUND');
    const out = await withTenant(pool, id, async (db) => {
      const [x] = await db.select({ t: schema.tickets, phoneEnc: schema.contacts.phoneEnc }).from(schema.tickets)
        .innerJoin(schema.contacts, eq(schema.contacts.id, schema.tickets.contactId)).where(eq(schema.tickets.ref, ref.data.toUpperCase()));
      if (!x || x.t.scrubbedAt || decrypt(x.phoneEnc, env.PHONE_ENC_KEY).slice(-4) !== q.data.last4) return null;
      const events = await db.select({ kind: schema.ticketEvents.kind, body: schema.ticketEvents.body, at: schema.ticketEvents.createdAt }).from(schema.ticketEvents)
        .where(and(eq(schema.ticketEvents.ticketId, x.t.id), eq(schema.ticketEvents.visibility, 'public'))).orderBy(asc(schema.ticketEvents.id));
      return { t: x.t, events };
    });
    if (!out) throw new HttpError(404, 'NOT_FOUND');
    res.json({
      ref: out.t.ref, status: out.t.status, statusText: STATUS_WORDS[out.t.status], category: CATEGORY_LABELS[out.t.category], receivedAt: out.t.createdAt, updatedAt: out.t.updatedAt,
      timeline: out.events.map((e) => ({ at: e.at, text: e.kind === 'note' ? e.body : e.body })),
    });
  }));

  return r;
}
