import '../../types.js';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { generatePassword, hashPassword, normaliseEmail, passwordProblem } from '../../lib/password.js';
import { requireUser } from '../../middleware/auth.js';
import { sendResetLink } from '../../routes/auth.js';
import type { Deps } from '../../types.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];
type User = typeof schema.users.$inferSelect;
const uuid = z.string().uuid();

/** What kind of account: a super admin manages accounts; an admin is platform staff; a user has no platform powers (a candidate, a manager). */
export type AccountType = 'super_admin' | 'admin' | 'user';
const typeOf = (u: Pick<User, 'isSuperAdmin' | 'isWesAdmin'>): AccountType => (u.isSuperAdmin ? 'super_admin' : u.isWesAdmin ? 'admin' : 'user');
const flags = (t: AccountType) => ({ isSuperAdmin: t === 'super_admin', isWesAdmin: t === 'super_admin' || t === 'admin' });

const view = (u: User, campaigns = 0) => ({
  id: u.id, name: u.name, email: u.email, type: typeOf(u), disabled: Boolean(u.disabledAt), mustChangePassword: u.mustChangePassword,
  hasPhone: Boolean(u.phoneHash), lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, campaigns,
});

/** Super admin portal API: create accounts (with an email and a password), change what they can do, disable them, reset their password. */
export function superAdminRoutes(deps: Deps) {
  const r = Router();
  const { pool } = deps;
  r.use(requireUser(deps));
  // Checked in the database each time, not only in the token: demoting or disabling a super admin takes effect at once.
  const onlySuper: RequestHandler = ah(async (req, _res, next) => {
    const [u] = await withTenant(pool, null, (db) => db.select().from(schema.users).where(eq(schema.users.id, req.user!.id)));
    if (!u?.isSuperAdmin || u.disabledAt) throw new HttpError(403, 'FORBIDDEN');
    next();
  });
  r.use(onlySuper);

  const audit = (db: Db, req: any, action: string, entityId: string, after: object = {}) =>
    db.insert(schema.auditLog).values({ actorId: req.user.id, action, entity: 'user', entityId, after, ip: req.ip });

  /** Another active super admin must always remain. */
  async function otherSupers(db: Db, exceptId: string) {
    const rows = await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.isSuperAdmin, true), isNull(schema.users.disabledAt)));
    return rows.filter((x) => x.id !== exceptId).length;
  }

  r.get('/users', ah(async (req, res) => {
    const q = z.string().max(100).optional().parse(req.query.q);
    res.json(await withTenant(pool, null, async (db) => {
      const users = await db.select().from(schema.users)
        .where(q ? or(ilike(schema.users.email, `%${q}%`), ilike(schema.users.name, `%${q}%`)) : undefined).orderBy(desc(schema.users.createdAt)).limit(500);
      const counts = await db.select({ u: schema.memberships.userId, n: sql<number>`count(*)::int` }).from(schema.memberships).groupBy(schema.memberships.userId);
      return users.map((u) => view(u, counts.find((c) => c.u === u.id)?.n ?? 0));
    }));
  }));

  r.post('/users', ah(async (req, res) => {
    const b = z.object({
      name: z.string().min(1).max(120), email: z.string().email().max(254),
      /** Leave out to have one generated (shown once). */
      password: z.string().max(256).optional(),
      type: z.enum(['super_admin', 'admin', 'user']).default('admin'),
      /** The person must choose their own password at first sign-in (default). */
      mustChangePassword: z.boolean().default(true),
      /** Do not set a password: email them a link to choose one. */
      sendInvite: z.boolean().default(false),
    }).strict().parse(req.body);
    const email = normaliseEmail(b.email);
    if (b.sendInvite && b.password) throw new HttpError(400, 'PASSWORD_OR_INVITE', 'Either give a password or send an invite link, not both.');
    if (b.password) { const p = passwordProblem(b.password, email); if (p) throw new HttpError(422, 'WEAK_PASSWORD', p); }
    const temporary = b.password ?? generatePassword();
    let user: User;
    try {
      user = await withTenant(pool, null, async (db) => {
        // An invited person gets a password nobody knows until they set their own.
        const [u] = await db.insert(schema.users).values({
          name: b.name, email, ...flags(b.type), passwordHash: await hashPassword(b.sendInvite ? generatePassword(32) : temporary),
          mustChangePassword: b.sendInvite ? true : b.mustChangePassword, passwordChangedAt: new Date(),
        }).returning();
        await audit(db, req, 'create_account', u!.id, { email, type: b.type, invited: b.sendInvite });
        return u!;
      });
    } catch (e: any) {
      if ((e?.cause ?? e)?.code === '23505') throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
      throw e;
    }
    let mailError: string | null = null;
    if (b.sendInvite) { try { await sendResetLink(deps, user, 'invite'); } catch (e) { mailError = (e as Error).message; deps.log.error({ err: e }, 'could not send the invite email'); } }
    res.status(201).json({ ...view(user), ...(b.sendInvite ? { invited: !mailError, ...(mailError && { inviteError: 'The invite email could not be sent. Use "Send reset link" to try again.' }) } : { temporaryPassword: temporary }) });
  }));

  r.patch('/users/:id', ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ name: z.string().min(1).max(120).optional(), type: z.enum(['super_admin', 'admin', 'user']).optional(), disabled: z.boolean().optional() }).strict().parse(req.body);
    const out = await withTenant(pool, null, async (db) => {
      const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id));
      if (!u) throw new HttpError(404, 'NOT_FOUND');
      const losesSuper = (b.type && b.type !== 'super_admin' && u.isSuperAdmin) || (b.disabled === true && u.isSuperAdmin);
      if (losesSuper) {
        if (u.id === req.user!.id) throw new HttpError(409, 'NOT_YOURSELF', 'You cannot remove your own super admin access or disable yourself. Ask another super admin.');
        if ((await otherSupers(db, u.id)) < 1) throw new HttpError(409, 'LAST_SUPER_ADMIN', 'There must always be one active super admin.');
      }
      const [n] = await db.update(schema.users).set({
        ...(b.name && { name: b.name }), ...(b.type && flags(b.type)), ...(b.disabled !== undefined && { disabledAt: b.disabled ? new Date() : null }), updatedAt: new Date(),
      }).where(eq(schema.users.id, id)).returning();
      await audit(db, req, 'update_account', id, b);
      return n!;
    });
    if (b.disabled) await deps.sessions.revokeAll(id); // a disabled person is signed out everywhere
    res.json(view(out));
  }));

  /** Sets a new password (given, or generated and shown once). The person must change it at their next sign-in, and is signed out everywhere. */
  r.post('/users/:id/reset-password', ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ password: z.string().max(256).optional() }).strict().parse(req.body ?? {});
    const temporary = b.password ?? generatePassword();
    await withTenant(pool, null, async (db) => {
      const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id));
      if (!u) throw new HttpError(404, 'NOT_FOUND');
      const p = b.password ? passwordProblem(b.password, u.email) : null;
      if (p) throw new HttpError(422, 'WEAK_PASSWORD', p);
      await db.update(schema.users).set({ passwordHash: await hashPassword(temporary), mustChangePassword: true, passwordChangedAt: new Date(), updatedAt: new Date() }).where(eq(schema.users.id, id));
      await audit(db, req, 'admin_reset_password', id);
    });
    await deps.sessions.revokeAll(id);
    res.json({ ok: true, temporaryPassword: temporary });
  }));

  /** Emails the person a link to choose their own password. */
  r.post('/users/:id/send-reset-link', ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const u = await withTenant(pool, null, async (db) => (await db.select().from(schema.users).where(eq(schema.users.id, id)))[0]);
    if (!u) throw new HttpError(404, 'NOT_FOUND');
    if (!u.email) throw new HttpError(409, 'NO_EMAIL', 'This account has no email address.');
    try { await sendResetLink(deps, u); } catch { throw new HttpError(502, 'EMAIL_NOT_SENT', 'The email could not be sent. Check the mail settings.'); }
    await withTenant(pool, null, (db) => audit(db, req, 'send_reset_link', id));
    res.json({ ok: true });
  }));

  return r;
}
