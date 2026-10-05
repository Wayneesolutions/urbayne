import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Normalise to E.164-ish digits with leading +. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (!/^\+\d{10,15}$/.test(digits)) throw new Error('Phone must be in +<country><number> format');
  return digits;
}

export const hashPhone = (phone: string, key: string) =>
  createHmac('sha256', Buffer.from(key, 'base64')).update(phone).digest('hex');

export function encrypt(plain: string, key: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(token: string, key: string): string {
  const [iv, tag, enc] = token.split('.').map((s) => Buffer.from(s, 'base64'));
  if (!iv || !tag || !enc) throw new Error('Bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

/** Constant-time string comparison (for secrets and hashes). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const newOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const hashOtp = (code: string, key: string) =>
  createHmac('sha256', Buffer.from(key, 'base64')).update(`otp:${code}`).digest('hex');
