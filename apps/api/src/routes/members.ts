import '../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema, withTenant, ROLES } from '@cs/db';
import { encrypt, hashPhone, normalisePhone, decrypt } from '../lib/crypto.js';
import { HttpError, ah } from '../lib/http.js';
import { maskPhone, now } from '../lib/util.js';
import { assertWithinPlan } from '../modules/billing/metering.js';
import { loadTenant, requireRole } from '../middleware/auth.js';
import type { Deps } from '../types.js';

/** Team members: owner adds managers and finance agents; coordinators add field workers and agents. */
export function memberRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool, env } = deps;
  r.use(loadTenant(deps));

  r.get('/', requireRole('owner', 'manager', 'coordinator'), ah(async (req, res) => {
    const rows = await withTenant(pool, req.tenant!.id, (db) => db.select({ m: schema.memberships, u: schema.users })
      .from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)));
    res.json(rows.map(({ m, u }) => ({ userId: u.id, name: u.name, phone: maskPhone(decrypt(u.phoneEnc, env.PHONE_ENC_KEY)), role: m.role })));
  }));

  r.post('/', requireRole('owner', 'manager', 'coordinator'), ah(async (req, res) => {
    const b = z.object({ phone: z.string(), name: z.string().max(120).optional(), role: z.enum(ROLES) }).parse(req.body);
    const senior = ['owner', 'manager', 'finance_agent'];
    if (b.role === 'owner') throw new HttpError(403, 'FORBIDDEN');
    if (senior.includes(b.role) && req.role !== 'owner') throw new HttpError(403, 'OWNER_ONLY', 'Only the candidate can add managers or finance agents.');
    if (req.role === 'coordinator' && !['field_worker', 'agent_reporter'].includes(b.role)) throw new HttpError(403, 'FORBIDDEN');
    const phone = normalisePhone(b.phone);
    const phoneHash = hashPhone(phone, env.PHONE_HASH_KEY);
    const t = req.tenant!;
    const out = await withTenant(pool, t.id, async (db) => {
      await assertWithinPlan(db, t, 'teamMembers', now(deps));
      let [u] = await db.select().from(schema.users).where(eq(schema.users.phoneHash, phoneHash));
      if (!u) [u] = await db.insert(schema.users).values({ phoneHash, phoneEnc: encrypt(phone, env.PHONE_ENC_KEY), name: b.name }).returning();
      const [m] = await db.insert(schema.memberships).values({ tenantId: t.id, userId: u!.id, role: b.role }).onConflictDoNothing().returning();
      if (!m) throw new HttpError(409, 'ALREADY_MEMBER');
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'add_member', entity: 'membership', entityId: m.id, after: { role: b.role }, ip: req.ip });
      return { userId: u!.id, name: u!.name, role: b.role };
    });
    res.status(201).json(out);
  }));
  return r;
}
