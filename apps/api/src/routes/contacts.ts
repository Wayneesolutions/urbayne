import { Router } from 'express';
import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { decrypt } from '../lib/crypto.js';
import { maskPhone } from '../lib/util.js';
import { encrypt, hashPhone, normalisePhone } from '../lib/crypto.js';
import { HttpError, ah } from '../lib/http.js';
import { loadTenant, requireRole } from '../middleware/auth.js';
import type { Deps } from '../types.js';

const consentSchema = z.object({
  purpose: z.enum(['info', 'survey', 'reminder', 'donation']),
  channel: z.enum(['voice', 'sms', 'ai_answer']),
  textVersion: z.string().min(1),
  locale: z.string(),
  capturedVia: z.enum(['form', 'missed_call', 'ivr', 'paper']),
});

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
    const phone = normalisePhone(b.phone);
    const row = await withTenant(pool, t.id, async (db) => {
      const [c] = await db.insert(schema.contacts).values({
        tenantId: t.id,
        phoneHash: hashPhone(phone, env.PHONE_HASH_KEY),
        phoneEnc: encrypt(phone, env.PHONE_ENC_KEY),
        name: b.name,
        geoAreaId: b.geoAreaId,
        source: b.source,
        sourceProofFile: b.sourceProofFile,
        tags: b.tags ?? [],
      }).onConflictDoNothing().returning();
      if (!c) throw new HttpError(409, 'CONTACT_EXISTS');
      if (b.consents.length) {
        await db.insert(schema.consents).values(b.consents.map((x) => ({ ...x, tenantId: t.id, contactId: c.id })));
      }
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'create', entity: 'contact', entityId: c.id, ip: req.ip });
      return c;
    });
    res.status(201).json({ id: row.id, name: row.name, source: row.source });
  }));

  return r;
}
