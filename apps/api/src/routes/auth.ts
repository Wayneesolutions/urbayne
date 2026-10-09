import { Router } from 'express';
import { z } from 'zod';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { signAccess, signRefresh, verifyRefresh } from '../lib/jwt.js';
import { HttpError, ah } from '../lib/http.js';
import { requireUser } from '../middleware/auth.js';
import { rateLimit } from '../lib/rate-limit.js';
import { mailEnabled } from '../lib/mailer.js';
import { hashPassword, hashToken, newToken, normaliseEmail, passwordProblem, verifyPassword } from '../lib/password.js';
import type { Deps } from '../types.js';

const RESET_TTL_MS = 60 * 60_000;
// Per account (shared across servers with Redis), on top of the per-IP limit on the route.
const LOGIN_TRIES = 20, LOGIN_WINDOW_MS = 15 * 60_000;
const FORGOT_PER_EMAIL = 3, FORGOT_WINDOW_MS = 60 * 60_000;

type User = typeof schema.users.$inferSelect;

/** Starts a session and signs the tokens. Platform staff and super admins carry `wes`; a password someone else chose carries `mcp`. */
export async function issueTokens(deps: Deps, user: User) {
  const sid = await deps.sessions.create(user.id);
  return {
    accessToken: signAccess({ sub: user.id, wes: user.isWesAdmin || user.isSuperAdmin, sa: user.isSuperAdmin, mcp: user.mustChangePassword }, deps.env.JWT_SECRET),
    refreshToken: signRefresh(user.id, sid, deps.env.JWT_REFRESH_SECRET),
    user: { id: user.id, name: user.name, email: user.email, locale: user.locale, isSuperAdmin: user.isSuperAdmin, isPlatformAdmin: user.isWesAdmin },
    mustChangePassword: user.mustChangePassword,
  };
}

export const resetLink = (deps: Deps, token: string) => `${deps.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/admin/reset-password?token=${encodeURIComponent(token)}`;

/** Creates a one-hour, single-use reset token for a user and emails the link. Older unused links stop working. Returns the token (for tests and dev). */
export async function sendResetLink(deps: Deps, user: Pick<User, 'id' | 'email' | 'name'>, why: 'forgot' | 'invite' = 'forgot'): Promise<string | null> {
  if (!user.email) return null;
  const token = newToken();
  await withTenant(deps.pool, null, async (db) => {
    await db.update(schema.passwordResets).set({ usedAt: new Date() }).where(and(eq(schema.passwordResets.userId, user.id), isNull(schema.passwordResets.usedAt)));
    await db.insert(schema.passwordResets).values({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
  });
  const link = resetLink(deps, token);
  const hello = user.name ? `Hello ${user.name},` : 'Hello,';
  await deps.mailer.send({
    to: user.email,
    subject: why === 'invite' ? 'Set your password for the Campaign Suite' : 'Reset your Campaign Suite password',
    text: why === 'invite'
      ? `${hello}\n\nAn account was created for you on the Campaign Suite. Choose your password here (the link works once, for 1 hour):\n\n${link}\n\nIf you were not expecting this, ignore this email.\n`
      : `${hello}\n\nSomeone asked to reset the password for this email address. To choose a new password, open this link (it works once, for 1 hour):\n\n${link}\n\nIf this was not you, ignore this email: your password stays as it is.\n`,
  });
  return token;
}

export function authRoutes(deps: Deps) {
  const r = Router();
  const { env, pool, log } = deps;
  const byEmail = (email: string) => withTenant(pool, null, async (db) => (await db.select().from(schema.users).where(eq(schema.users.email, email)))[0] ?? null);

  /** What the sign-in page needs to know: whether it should offer "forgot password". */
  r.get('/config', (_req, res) => res.json({ passwordReset: mailEnabled(env) }));

  r.post('/login', rateLimit(deps.rateStore, env.LOGIN_MAX_PER_IP, 10 * 60_000), ah(async (req, res) => {
    const b = z.object({ email: z.string().max(254), password: z.string().min(1).max(256) }).strict().parse(req.body);
    const email = normaliseEmail(b.email);
    if ((await deps.rateStore.hit(`login:${email}`, LOGIN_WINDOW_MS)) > LOGIN_TRIES) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many sign-in attempts for this account. Wait 15 minutes, or reset your password.');
    const user = await byEmail(email);
    // The same work and the same answer whether the email is unknown, the password is wrong, or the account is disabled.
    const ok = await verifyPassword(b.password, user?.passwordHash);
    if (!user || !ok || user.disabledAt) throw new HttpError(401, 'INVALID_LOGIN', 'Email or password is not right.');
    await withTenant(pool, null, (db) => db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id)));
    res.json(await issueTokens(deps, user));
  }));

  /** Always answers the same, so it cannot be used to find out which emails have accounts. */
  r.post('/forgot', rateLimit(deps.rateStore, Math.floor(env.LOGIN_MAX_PER_IP / 3), 60 * 60_000), ah(async (req, res) => {
    if (!mailEnabled(env)) throw new HttpError(503, 'RESET_BY_EMAIL_OFF', 'Password reset by email is not set up. Ask your administrator to reset your password.');
    const b = z.object({ email: z.string().max(254) }).strict().parse(req.body);
    const email = normaliseEmail(b.email);
    let devToken: string | null = null;
    if ((await deps.rateStore.hit(`forgot:${email}`, FORGOT_WINDOW_MS)) <= FORGOT_PER_EMAIL) {
      const user = await byEmail(email);
      if (user && !user.disabledAt) {
        try { devToken = await sendResetLink(deps, user); }
        catch (e) { log.error({ err: e }, 'could not send the password reset email'); }
      }
    }
    res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.', ...(env.DEV_RETURN_RESET_TOKEN === 'true' && devToken ? { devToken } : {}) });
  }));

  r.post('/reset', rateLimit(deps.rateStore, Math.floor(env.LOGIN_MAX_PER_IP * 2 / 3), 60 * 60_000), ah(async (req, res) => {
    const b = z.object({ token: z.string().min(20).max(200), password: z.string().max(256) }).strict().parse(req.body);
    const out = await withTenant(pool, null, async (db) => {
      const [row] = await db.select().from(schema.passwordResets).where(and(eq(schema.passwordResets.tokenHash, hashToken(b.token)), isNull(schema.passwordResets.usedAt), gt(schema.passwordResets.expiresAt, new Date())));
      if (!row) throw new HttpError(400, 'RESET_LINK_INVALID', 'This link has expired or was already used. Ask for a new one.');
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId));
      if (!user || user.disabledAt) throw new HttpError(400, 'RESET_LINK_INVALID', 'This link has expired or was already used. Ask for a new one.');
      const problem = passwordProblem(b.password, user.email);
      if (problem) throw new HttpError(422, 'WEAK_PASSWORD', problem);
      await db.update(schema.users).set({ passwordHash: await hashPassword(b.password), mustChangePassword: false, passwordChangedAt: new Date(), updatedAt: new Date() }).where(eq(schema.users.id, user.id));
      await db.update(schema.passwordResets).set({ usedAt: new Date() }).where(and(eq(schema.passwordResets.userId, user.id), isNull(schema.passwordResets.usedAt)));
      await db.insert(schema.auditLog).values({ actorId: user.id, action: 'password_reset', entity: 'user', entityId: user.id, ip: req.ip });
      return user.id;
    });
    await deps.sessions.revokeAll(out); // every device signs in again with the new password
    res.json({ ok: true });
  }));

  /** Signed-in: choose a new password. Also how a person replaces the password an admin gave them. */
  r.post('/change-password', requireUser(deps), ah(async (req, res) => {
    const b = z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) }).strict().parse(req.body);
    if ((await deps.rateStore.hit(`chpw:${req.user!.id}`, LOGIN_WINDOW_MS)) > 10) throw new HttpError(429, 'TOO_MANY_ATTEMPTS');
    const user = await withTenant(pool, null, async (db) => (await db.select().from(schema.users).where(eq(schema.users.id, req.user!.id)))[0]);
    if (!user || user.disabledAt || !(await verifyPassword(b.currentPassword, user.passwordHash))) throw new HttpError(401, 'INVALID_LOGIN', 'The current password is not right.');
    const problem = passwordProblem(b.newPassword, user.email);
    if (problem) throw new HttpError(422, 'WEAK_PASSWORD', problem);
    if (b.newPassword === b.currentPassword) throw new HttpError(422, 'SAME_PASSWORD', 'Choose a password you have not been using.');
    const [updated] = await withTenant(pool, null, async (db) => {
      const out = await db.update(schema.users).set({ passwordHash: await hashPassword(b.newPassword), mustChangePassword: false, passwordChangedAt: new Date(), updatedAt: new Date() }).where(eq(schema.users.id, user.id)).returning();
      await db.insert(schema.auditLog).values({ actorId: user.id, action: 'password_change', entity: 'user', entityId: user.id, ip: req.ip });
      return out;
    });
    await deps.sessions.revokeAll(user.id);
    res.json(await issueTokens(deps, updated!)); // this device carries on with a fresh session
  }));

  r.post('/refresh', ah(async (req, res) => {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    let sub: string, sid: string;
    try { ({ sub, sid } = verifyRefresh(refreshToken, [env.JWT_REFRESH_SECRET, env.JWT_REFRESH_SECRET_PREVIOUS ?? ''])); } catch { throw new HttpError(401, 'UNAUTHENTICATED'); }
    if (!(await deps.sessions.isValid(sid, sub))) throw new HttpError(401, 'SESSION_ENDED');
    const [user] = await withTenant(pool, null, (db) => db.select().from(schema.users).where(eq(schema.users.id, sub)));
    if (!user || user.disabledAt) throw new HttpError(401, 'UNAUTHENTICATED');
    res.json({ accessToken: signAccess({ sub: user.id, wes: user.isWesAdmin || user.isSuperAdmin, sa: user.isSuperAdmin, mcp: user.mustChangePassword }, env.JWT_SECRET) });
  }));

  /** Ends this device's session: its refresh token stops working at once (the 15-minute access token simply expires). */
  r.post('/logout', ah(async (req, res) => {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    try { await deps.sessions.revoke(verifyRefresh(refreshToken, [env.JWT_REFRESH_SECRET, env.JWT_REFRESH_SECRET_PREVIOUS ?? '']).sid); } catch { /* already invalid: nothing to end */ }
    res.json({ ok: true });
  }));

  /** Signs the user out of every device. */
  r.post('/logout-all', requireUser(deps), ah(async (req, res) => {
    res.json({ ok: true, ended: await deps.sessions.revokeAll(req.user!.id) });
  }));

  r.get('/me', requireUser(deps), ah(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM user_memberships($1)', [req.user!.id]);
    const [u] = await withTenant(pool, null, (db) => db.select().from(schema.users).where(eq(schema.users.id, req.user!.id)));
    res.json({
      user: { ...req.user, name: u?.name ?? null, email: u?.email ?? null, mustChangePassword: Boolean(u?.mustChangePassword), isSuperAdmin: Boolean(u?.isSuperAdmin) },
      campaigns: rows,
    });
  }));

  return r;
}
