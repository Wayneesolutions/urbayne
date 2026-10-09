import '../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema, withTenant, ROLES } from '@cs/db';
import { decrypt } from '../lib/crypto.js';
import { HttpError, ah } from '../lib/http.js';
import { maskPhone, now } from '../lib/util.js';
import { findOrCreateAccount } from '../lib/accounts.js';
import { sendResetLink } from './auth.js';
import { loadTenant, requireRole } from '../middleware/auth.js';
import { assertWithinPlan } from '../modules/billing/metering.js';
import type { Deps } from '../types.js';

/** Team members: owner adds managers and finance agents; coordinators add field workers and agents. */
export function memberRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool, env } = deps;
  r.use(loadTenant(deps));

  r.get('/', requireRole('owner', 'manager', 'coordinator'), ah(async (req, res) => {
    const rows = await withTenant(pool, req.tenant!.id, (db) => db.select({ m: schema.memberships, u: schema.users })
      .from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)));
    res.json(rows.map(({ m, u }) => ({
      userId: u.id, name: u.name, email: u.email, phone: u.phoneEnc ? maskPhone(decrypt(u.phoneEnc, env.PHONE_ENC_KEY)) : null, role: m.role, disabled: Boolean(u.disabledAt),
    })));
  }));

  /**
   * Adds someone to the team by email. With a password, they sign in with it and must change it at first sign-in; without one, they
   * are emailed a link to choose their own. The phone number is optional (needed only for results agents who report by text).
   */
  r.post('/', requireRole('owner', 'manager', 'coordinator'), ah(async (req, res) => {
    const b = z.object({
      email: z.string().email().max(254), name: z.string().max(120).optional(), role: z.enum(ROLES),
      phone: z.string().optional(), password: z.string().max(256).optional(),
    }).strict().parse(req.body);
    const senior = ['owner', 'manager', 'finance_agent'];
    if (b.role === 'owner') throw new HttpError(403, 'FORBIDDEN');
    if (senior.includes(b.role) && req.role !== 'owner') throw new HttpError(403, 'OWNER_ONLY', 'Only the candidate can add managers or finance agents.');
    if (req.role === 'coordinator' && !['field_worker', 'agent_reporter'].includes(b.role)) throw new HttpError(403, 'FORBIDDEN');
    const t = req.tenant!;
    const out = await withTenant(pool, t.id, async (db) => {
      await assertWithinPlan(db, t, 'teamMembers', now(deps));
      const { user, invite } = await findOrCreateAccount(deps, db, { email: b.email, name: b.name, phone: b.phone, password: b.password });
      if (user.disabledAt) throw new HttpError(409, 'ACCOUNT_DISABLED', 'This account is disabled.');
      const [m] = await db.insert(schema.memberships).values({ tenantId: t.id, userId: user.id, role: b.role }).onConflictDoNothing().returning();
      if (!m) throw new HttpError(409, 'ALREADY_MEMBER');
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'add_member', entity: 'membership', entityId: m.id, after: { role: b.role, email: user.email }, ip: req.ip });
      return { user, invite };
    });
    let invited: boolean | undefined;
    if (out.invite) { try { await sendResetLink(deps, out.user, 'invite'); invited = true; } catch (e) { invited = false; deps.log.error({ err: e }, 'could not send the invite email'); } }
    res.status(201).json({ userId: out.user.id, name: out.user.name, email: out.user.email, role: b.role, ...(invited !== undefined && { invited }) });
  }));
  return r;
}
