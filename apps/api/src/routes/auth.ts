import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { encrypt, hashOtp, hashPhone, newOtp, normalisePhone, safeEqual } from '../lib/crypto.js';
import { signAccess, signRefresh, verifyRefresh } from '../lib/jwt.js';
import { HttpError, ah } from '../lib/http.js';
import { requireUser } from '../middleware/auth.js';
import { otpSenderFor } from '../lib/otp-sender.js';
import { rateLimit } from '../lib/rate-limit.js';
import type { Deps } from '../types.js';

const OTP_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_REQUESTS_PER_10_MIN = 3;

export function authRoutes(deps: Deps) {
  const r = Router();
  const { env, pool } = deps;
  const otpSender = deps.otpSender ?? otpSenderFor(env, OTP_TTL_MS / 60_000);

  // Per-IP limits on top of the per-phone database limit below; shared across servers when Redis is configured.
  r.post('/otp/request', rateLimit(deps.rateStore, 20, 10 * 60_000), ah(async (req, res) => {
    const phone = normalisePhone(z.object({ phone: z.string() }).parse(req.body).phone);
    const phoneHash = hashPhone(phone, env.PHONE_HASH_KEY);
    const code = newOtp();
    let otpId = '';
    await withTenant(pool, null, async (db) => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.otpCodes)
        .where(and(eq(schema.otpCodes.phoneHash, phoneHash), gt(schema.otpCodes.createdAt, new Date(Date.now() - 10 * 60_000))));
      if ((row?.n ?? 0) >= MAX_REQUESTS_PER_10_MIN) throw new HttpError(429, 'TOO_MANY_OTP_REQUESTS');
      const [ins] = await db.insert(schema.otpCodes).values({ phoneHash, codeHash: hashOtp(code, env.PHONE_HASH_KEY), expiresAt: new Date(Date.now() + OTP_TTL_MS) }).returning({ id: schema.otpCodes.id });
      otpId = ins!.id;
    });
    const delivered = await otpSender.send(phone, code);
    if (!delivered) {
      // Burn the unsent code so it cannot be guessed, and tell the client plainly.
      await withTenant(pool, null, (db) => db.update(schema.otpCodes).set({ usedAt: new Date() }).where(eq(schema.otpCodes.id, otpId)));
      throw new HttpError(502, 'OTP_DELIVERY_FAILED');
    }
    res.json(env.DEV_RETURN_OTP === 'true' ? { sent: true, devCode: code } : { sent: true });
  }));

  r.post('/otp/verify', rateLimit(deps.rateStore, 30, 10 * 60_000), ah(async (req, res) => {
    const body = z.object({ phone: z.string(), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const phone = normalisePhone(body.phone);
    const phoneHash = hashPhone(phone, env.PHONE_HASH_KEY);
    const user = await withTenant(pool, null, async (db) => {
      const [otp] = await db
        .select()
        .from(schema.otpCodes)
        .where(and(eq(schema.otpCodes.phoneHash, phoneHash), isNull(schema.otpCodes.usedAt), gt(schema.otpCodes.expiresAt, new Date())))
        .orderBy(desc(schema.otpCodes.createdAt))
        .limit(1);
      if (!otp || otp.attempts >= MAX_ATTEMPTS) throw new HttpError(401, 'OTP_INVALID');
      if (!safeEqual(otp.codeHash, hashOtp(body.code, env.PHONE_HASH_KEY))) {
        await db.update(schema.otpCodes).set({ attempts: otp.attempts + 1 }).where(eq(schema.otpCodes.id, otp.id));
        return null;
      }
      await db.update(schema.otpCodes).set({ usedAt: new Date() }).where(eq(schema.otpCodes.id, otp.id));
      const [existing] = await db.select().from(schema.users).where(eq(schema.users.phoneHash, phoneHash));
      if (existing) return existing;
      const [created] = await db.insert(schema.users).values({ phoneHash, phoneEnc: encrypt(phone, env.PHONE_ENC_KEY) }).returning();
      return created!;
    });
    if (!user) throw new HttpError(401, 'OTP_INVALID');
    const sid = await deps.sessions.create(user.id);
    res.json({
      accessToken: signAccess({ sub: user.id, wes: user.isWesAdmin }, env.JWT_SECRET),
      refreshToken: signRefresh(user.id, sid, env.JWT_REFRESH_SECRET),
      user: { id: user.id, name: user.name, locale: user.locale },
    });
  }));

  r.post('/refresh', ah(async (req, res) => {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    let sub: string, sid: string;
    try { ({ sub, sid } = verifyRefresh(refreshToken, [env.JWT_REFRESH_SECRET, env.JWT_REFRESH_SECRET_PREVIOUS ?? ''])); } catch { throw new HttpError(401, 'UNAUTHENTICATED'); }
    if (!(await deps.sessions.isValid(sid, sub))) throw new HttpError(401, 'SESSION_ENDED');
    const [user] = await withTenant(pool, null, (db) => db.select().from(schema.users).where(eq(schema.users.id, sub)));
    if (!user) throw new HttpError(401, 'UNAUTHENTICATED');
    res.json({ accessToken: signAccess({ sub: user.id, wes: user.isWesAdmin }, env.JWT_SECRET) });
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
    res.json({ user: req.user, campaigns: rows });
  }));

  return r;
}
