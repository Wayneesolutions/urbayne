import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { encrypt, hashOtp, hashPhone, newOtp, normalisePhone } from '../lib/crypto.js';
import { signAccess, signRefresh, verifyRefresh } from '../lib/jwt.js';
import { HttpError, ah } from '../lib/http.js';
import { requireUser } from '../middleware/auth.js';
import type { Deps } from '../types.js';

const OTP_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_REQUESTS_PER_10_MIN = 3;

export function authRoutes(deps: Deps) {
  const r = Router();
  const { env, pool } = deps;

  r.post('/otp/request', ah(async (req, res) => {
    const phone = normalisePhone(z.object({ phone: z.string() }).parse(req.body).phone);
    const phoneHash = hashPhone(phone, env.PHONE_HASH_KEY);
    const code = newOtp();
    await withTenant(pool, null, async (db) => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.otpCodes)
        .where(and(eq(schema.otpCodes.phoneHash, phoneHash), gt(schema.otpCodes.createdAt, new Date(Date.now() - 10 * 60_000))));
      if ((row?.n ?? 0) >= MAX_REQUESTS_PER_10_MIN) throw new HttpError(429, 'TOO_MANY_OTP_REQUESTS');
      await db.insert(schema.otpCodes).values({ phoneHash, codeHash: hashOtp(code, env.PHONE_HASH_KEY), expiresAt: new Date(Date.now() + OTP_TTL_MS) });
    });
    // Phase 0: console delivery only. Phase 1 wires SMS through the channel adapters.
    if (env.OTP_PROVIDER === 'console') console.log(`[otp] ${phone.slice(0, -4)}**** -> ${code}`);
    res.json(env.DEV_RETURN_OTP === 'true' ? { sent: true, devCode: code } : { sent: true });
  }));

  r.post('/otp/verify', ah(async (req, res) => {
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
      if (otp.codeHash !== hashOtp(body.code, env.PHONE_HASH_KEY)) {
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
    res.json({
      accessToken: signAccess({ sub: user.id, wes: user.isWesAdmin }, env.JWT_SECRET),
      refreshToken: signRefresh(user.id, env.JWT_REFRESH_SECRET),
      user: { id: user.id, name: user.name, locale: user.locale },
    });
  }));

  r.post('/refresh', ah(async (req, res) => {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    let sub: string;
    try { sub = verifyRefresh(refreshToken, env.JWT_REFRESH_SECRET); } catch { throw new HttpError(401, 'UNAUTHENTICATED'); }
    const [user] = await withTenant(pool, null, (db) => db.select().from(schema.users).where(eq(schema.users.id, sub)));
    if (!user) throw new HttpError(401, 'UNAUTHENTICATED');
    res.json({ accessToken: signAccess({ sub: user.id, wes: user.isWesAdmin }, env.JWT_SECRET) });
  }));

  r.get('/me', requireUser(deps), ah(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM user_memberships($1)', [req.user!.id]);
    res.json({ user: req.user, campaigns: rows });
  }));

  return r;
}
