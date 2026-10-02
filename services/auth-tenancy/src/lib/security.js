import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config.js';

export const hashPassword = (plain) => bcrypt.hash(plain, 12);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// Used when the email doesn't exist, so response time doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);
export const fakeVerify = (plain) => bcrypt.compare(plain, DUMMY_HASH);

export const generateTempPassword = () => crypto.randomBytes(9).toString('base64url'); // 12 chars

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

export async function verifySuperAdmin(email, password) {
  const emailOk = safeEqual(email.toLowerCase(), env.SUPER_ADMIN_EMAIL);
  const passOk = env.SUPER_ADMIN_PASSWORD_HASH
    ? await bcrypt.compare(password, env.SUPER_ADMIN_PASSWORD_HASH)
    : safeEqual(password, env.SUPER_ADMIN_PASSWORD);
  return emailOk && passOk;
}

export const signSuperAdminToken = () =>
  jwt.sign({ role: 'SUPER_ADMIN' }, env.JWT_SECRET, { subject: 'super-admin', expiresIn: env.SUPER_ADMIN_JWT_EXPIRES_IN });

export const signUserToken = (user) =>
  jwt.sign({ role: user.role, tv: user.token_version }, env.JWT_SECRET, { subject: user.id, expiresIn: env.JWT_EXPIRES_IN });

export const verifyToken = (token) => jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
