import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { decrypt } from '../lib/crypto.js';
import { maskPhone, now } from '../lib/util.js';
import { encrypt, hashPhone, normalisePhone } from '../lib/crypto.js';
import { HttpError, ah } from '../lib/http.js';
import { loadTenant, requireRole } from '../middleware/auth.js';
import { addConsents } from '../modules/privacy/consent.js';
import type { Deps } from '../types.js';

const consentSchema = z.object({
  purpose: z.enum(['info', 'survey', 'reminder', 'donation', 'service']),
  channel: z.enum(['voice', 'sms', 'ai_answer']),
  textVersion: z.string().min(1),
  locale: z.string(),
  capturedVia: z.enum(['form', 'missed_call', 'ivr', 'paper']),
  /** Paper consents must say which form they came from (the serial number printed on it). */
  evidenceRef: z.string().min(1).max(80).optional(),
  /** When the person actually signed (paper is often entered days later). Cannot be in the future. */
  capturedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Rules every manually entered consent must meet. IVR consent is recorded by the system from the call itself, never typed in. */
function checkConsentEvidence(list: z.infer<typeof consentSchema>[], today: Date) {
  for (const c of list) {
    if (c.capturedVia === 'ivr') throw new HttpError(422, 'IVR_CONSENT_IS_SYSTEM_ONLY', 'IVR consent is recorded from the call itself.');
    if (c.capturedVia === 'paper' && !c.evidenceRef) throw new HttpError(422, 'CONSENT_EVIDENCE_REQUIRED', 'Paper consent needs the form number printed on the paper form.');
    if (c.capturedAt && new Date(`${c.capturedAt}T00:00:00Z`).getTime() > today.getTime()) throw new HttpError(422, 'CONSENT_DATE_IN_FUTURE');
  }
}
const toInput = (c: z.infer<typeof consentSchema>) => ({ ...c, capturedAt: c.capturedAt ? new Date(`${c.capturedAt}T12:00:00Z`) : undefined });

export function contactRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { env, pool } = deps;
  r.use(loadTenant(deps));

  r.get('/', requireRole('owner', 'manager', 'coordinator'), ah(async (req, res) => {
    const rows = await withTenant(pool, req.tenant!.id, async (db) => {
      const list = await db.select({ c: schema.contacts, area: schema.geoAreas.nameEn }).from(schema.contacts)
        .leftJoin(schema.geoAreas, eq(schema.geoAreas.id, schema.contacts.geoAreaId))
        .orderBy(desc(schema.contacts.createdAt)).limit(200);
      const [tot] = await db.select({ n: sql<number>`count(*)::int`, optedOut: sql<number>`count(*) filter (where ${schema.contacts.optedOut})::int` }).from(schema.contacts);
      return { total: tot?.n ?? 0, optedOut: tot?.optedOut ?? 0, items: list };
    });
    res.json({
      total: rows.total, optedOut: rows.optedOut,
      items: rows.items.map(({ c, area }) => ({ id: c.id, name: c.name, phone: maskPhone(decrypt(c.phoneEnc, env.PHONE_ENC_KEY)), area, source: c.source, tags: c.tags, optedOut: c.optedOut, createdAt: c.createdAt })),
    });
  }));

  r.post('/', requireRole('owner', 'manager', 'coordinator'), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({
      phone: z.string(),
      name: z.string().max(120).optional(),
      geoAreaId: z.string().uuid().optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      source: z.enum(['form', 'missed_call', 'roll', 'import']),
      sourceProofFile: z.string().optional(),
      consents: z.array(consentSchema).default([]),
    }).strict().parse(req.body); // .strict(): unknown fields (e.g. caste, religion) are rejected
    // Guardrail: roll copies and imports must show where the data came from.
    if ((b.source === 'roll' || b.source === 'import') && !b.sourceProofFile) {
      throw new HttpError(422, 'SOURCE_PROOF_REQUIRED', 'Upload proof of where this list came from.');
    }
    checkConsentEvidence(b.consents, now(deps));
    const phone = normalisePhone(b.phone);
    let suppressed = false as boolean;
    const row = await withTenant(pool, t.id, async (db) => {
      const phoneHash = hashPhone(phone, env.PHONE_HASH_KEY);
      // Someone who opted out (or asked to be erased) stays blocked even if their number shows up on a new list.
      const [sup] = await db.select().from(schema.suppressions).where(eq(schema.suppressions.phoneHash, phoneHash));
      suppressed = Boolean(sup);
      const [c] = await db.insert(schema.contacts).values({
        tenantId: t.id,
        phoneHash,
        phoneEnc: encrypt(phone, env.PHONE_ENC_KEY),
        optedOut: suppressed,
        name: b.name,
        geoAreaId: b.geoAreaId,
        source: b.source,
        sourceProofFile: b.sourceProofFile,
        tags: b.tags ?? [],
      }).onConflictDoNothing().returning();
      if (!c) throw new HttpError(409, 'CONTACT_EXISTS');
      if (!suppressed) await addConsents(db, t.id, c.id, b.consents.map(toInput), req.user!.id);
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'create', entity: 'contact', entityId: c.id, ip: req.ip });
      return c;
    });
    res.status(201).json({ id: row.id, name: row.name, source: row.source, ...(suppressed ? { suppressed: true } : {}) });
  }));

  /**
   * One paper sign-up sheet: many people, one consent text, one serial number. Each person's consent is stored with the
   * sheet number and the date they signed, so the paper can be found again if anyone asks for proof.
   */
  r.post('/paper-sheet', requireRole('owner', 'manager', 'coordinator'), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({
      sheetNo: z.string().min(1).max(80),
      capturedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      locale: z.string().min(2).max(10),
      textVersion: z.string().min(1).max(60),
      purposes: z.array(z.enum(['info', 'survey', 'reminder'])).min(1).max(3),
      channels: z.array(z.enum(['voice', 'sms'])).min(1).default(['voice']),
      entries: z.array(z.object({ phone: z.string(), name: z.string().max(120).optional(), geoAreaId: z.string().uuid().optional() }).strict()).min(1).max(100),
    }).strict().parse(req.body);
    if (new Date(`${b.capturedAt}T00:00:00Z`).getTime() > now(deps).getTime()) throw new HttpError(422, 'CONSENT_DATE_IN_FUTURE');

    const out = { created: 0, updated: 0, suppressed: 0, invalid: [] as { row: number; reason: string }[] };
    const consents = b.purposes.flatMap((purpose) => b.channels.map((channel) => ({
      purpose, channel, textVersion: b.textVersion, locale: b.locale, capturedVia: 'paper' as const, evidenceRef: b.sheetNo, capturedAt: new Date(`${b.capturedAt}T12:00:00Z`),
    })));
    await withTenant(pool, t.id, async (db) => {
      for (const [i, e] of b.entries.entries()) {
        let phone: string;
        try { phone = normalisePhone(e.phone); } catch { out.invalid.push({ row: i + 1, reason: 'BAD_PHONE' }); continue; }
        const phoneHash = hashPhone(phone, env.PHONE_HASH_KEY);
        const [sup] = await db.select().from(schema.suppressions).where(eq(schema.suppressions.phoneHash, phoneHash));
        if (sup) { out.suppressed++; continue; }
        let [c] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.phoneHash, phoneHash)));
        if (c?.optedOut) { out.suppressed++; continue; }
        if (!c) {
          [c] = await db.insert(schema.contacts).values({ tenantId: t.id, phoneHash, phoneEnc: encrypt(phone, env.PHONE_ENC_KEY), name: e.name, geoAreaId: e.geoAreaId, source: 'form', tags: [] }).returning();
          out.created++;
        } else out.updated++;
        await addConsents(db, t.id, c!.id, consents, req.user!.id);
      }
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'paper_sheet', entity: 'consent', entityId: null, after: { sheetNo: b.sheetNo, ...out, invalid: out.invalid.length }, ip: req.ip });
    });
    res.status(201).json(out);
  }));

  return r;
}
