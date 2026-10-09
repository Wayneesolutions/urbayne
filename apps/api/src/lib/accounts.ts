import { eq } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { encrypt, hashPhone, normalisePhone } from './crypto.js';
import { HttpError } from './http.js';
import { generatePassword, hashPassword, normaliseEmail, passwordProblem } from './password.js';
import type { Deps } from '../types.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

export interface AccountInput { email: string; name?: string | null; phone?: string | null; password?: string | null }

/**
 * Finds the account for an email, or creates one. A new account gets the password it was given (and must change it at first sign-in),
 * or, with none given, a password nobody knows plus an emailed link to choose one (`invite: true`: the caller sends it after saving).
 * A phone number is optional and only used to match a results agent's text message to the account.
 */
export async function findOrCreateAccount(deps: Deps, db: Db, input: AccountInput) {
  const email = normaliseEmail(input.email);
  let phone: string | null = null;
  if (input.phone) {
    try { phone = normalisePhone(input.phone); } catch { throw new HttpError(400, 'BAD_PHONE', 'The phone number must look like +91... or +1...'); }
  }
  const phoneHash = phone ? hashPhone(phone, deps.env.PHONE_HASH_KEY) : null;
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (existing) {
    if (phone && !existing.phoneHash) {
      const [taken] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.phoneHash, phoneHash!));
      if (taken) throw new HttpError(409, 'PHONE_IN_USE', 'That phone number belongs to another account.');
      const [u] = await db.update(schema.users).set({ phoneHash, phoneEnc: encrypt(phone, deps.env.PHONE_ENC_KEY), updatedAt: new Date() }).where(eq(schema.users.id, existing.id)).returning();
      return { user: u!, created: false, invite: false };
    }
    return { user: existing, created: false, invite: false };
  }
  if (phone) {
    const [taken] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.phoneHash, phoneHash!));
    if (taken) throw new HttpError(409, 'PHONE_IN_USE', 'That phone number belongs to another account.');
  }
  if (input.password) { const p = passwordProblem(input.password, email); if (p) throw new HttpError(422, 'WEAK_PASSWORD', p); }
  const [user] = await db.insert(schema.users).values({
    email, name: input.name ?? null, phoneHash, phoneEnc: phone ? encrypt(phone, deps.env.PHONE_ENC_KEY) : null,
    passwordHash: await hashPassword(input.password ?? generatePassword(32)), mustChangePassword: true, passwordChangedAt: new Date(),
  }).returning();
  return { user: user!, created: true, invite: !input.password };
}
