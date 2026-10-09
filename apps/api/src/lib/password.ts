import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, createHash, type ScryptOptions } from 'node:crypto';

// scrypt from Node's own crypto: no extra dependency. Cost parameters are stored in each hash, so they can be raised later
// without locking anyone out (old hashes still verify, and can be upgraded at the next sign-in).
// Tests lower the cost (PASSWORD_SCRYPT_N) so hundreds of sign-ins stay fast; production always uses the full cost.
const N = process.env.NODE_ENV !== 'production' && Number(process.env.PASSWORD_SCRYPT_N) > 0 ? Number(process.env.PASSWORD_SCRYPT_N) : 2 ** 15;
const R = 8, P = 1, KEYLEN = 32;
const scrypt = (pw: string, salt: Buffer, n: number, r: number, p: number, len: number) =>
  new Promise<Buffer>((res, rej) => {
    const opts: ScryptOptions = { N: n, r, p, maxmem: 128 * n * r * 2 };
    scryptCb(pw.normalize('NFKC'), salt, len, opts, (e, k) => (e ? rej(e) : res(k)));
  });

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, N, R, P, KEYLEN);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  // An account with no password (or an unknown email) still costs the same time, so response time does not reveal which emails exist.
  const parts = (stored ?? DUMMY).split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, n, r, p, salt, hash] = parts;
  const want = Buffer.from(hash!, 'base64');
  const got = await scrypt(pw, Buffer.from(salt!, 'base64'), Number(n), Number(r), Number(p), want.length);
  return stored != null && timingSafeEqual(got, want);
}
const DUMMY = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

const COMMON = new Set(['password', 'passw0rd', 'qwertyuiop', 'letmein123', 'welcome123', '1234567890', '0123456789', 'iloveyou12', 'admin12345', 'changeme123']);

/** Why a password is not acceptable, or null. Length matters more than symbols: 10 characters minimum. */
export function passwordProblem(pw: string, email?: string | null): string | null {
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 128) return 'Use at most 128 characters.';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(pw) || /^(0123456789|1234567890|abcdefghij)/.test(lower)) return 'That password is too easy to guess.';
  if (email) {
    const local = email.split('@')[0]!.toLowerCase();
    if (lower === email.toLowerCase() || (local.length >= 5 && lower.includes(local))) return 'The password must not contain your email address.';
  }
  return null;
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** A random password to hand over once (no look-alike letters). */
export const generatePassword = (len = 16) => Array.from({ length: len }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/** One-time links: the token is random and only its hash is stored. */
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export const normaliseEmail = (e: string) => e.trim().toLowerCase();
