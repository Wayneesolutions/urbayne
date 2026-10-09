import type pg from 'pg';
import { eq } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { hashPassword, normaliseEmail, passwordProblem } from './password.js';

/**
 * Creates the first super admin, or turns an existing account into one. The new password must be changed at the first sign-in.
 * Used at startup (SUPERADMIN_EMAIL + SUPERADMIN_PASSWORD, only while no super admin exists) and by `pnpm create-superadmin`.
 */
export async function createSuperAdmin(pool: pg.Pool, emailRaw: string, password: string, name = 'Super admin') {
  const email = normaliseEmail(emailRaw);
  const problem = passwordProblem(password, email);
  if (problem) throw new Error(`Password not accepted: ${problem}`);
  const hash = await hashPassword(password);
  return withTenant(pool, null, async (db) => {
    const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (existing) {
      const [u] = await db.update(schema.users).set({ isSuperAdmin: true, isWesAdmin: true, disabledAt: null, passwordHash: hash, mustChangePassword: true, passwordChangedAt: new Date(), updatedAt: new Date() }).where(eq(schema.users.id, existing.id)).returning();
      await db.insert(schema.auditLog).values({ action: 'bootstrap_super_admin', entity: 'user', entityId: u!.id, after: { email, promoted: true } });
      return { id: u!.id, created: false };
    }
    const [u] = await db.insert(schema.users).values({ email, name, isSuperAdmin: true, isWesAdmin: true, passwordHash: hash, mustChangePassword: true, passwordChangedAt: new Date() }).returning();
    await db.insert(schema.auditLog).values({ action: 'bootstrap_super_admin', entity: 'user', entityId: u!.id, after: { email, promoted: false } });
    return { id: u!.id, created: true };
  });
}

/** At startup: if SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD are set and nobody is a super admin yet, create one. Harmless to leave set. */
export async function ensureSuperAdmin(pool: pg.Pool, env: { SUPERADMIN_EMAIL?: string; SUPERADMIN_PASSWORD?: string }, log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }) {
  if (!env.SUPERADMIN_EMAIL || !env.SUPERADMIN_PASSWORD) return;
  const has = await withTenant(pool, null, async (db) => (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.isSuperAdmin, true))).length > 0);
  if (has) return;
  try {
    await createSuperAdmin(pool, env.SUPERADMIN_EMAIL, env.SUPERADMIN_PASSWORD);
    log.info({ email: env.SUPERADMIN_EMAIL }, 'first super admin created: sign in and choose a new password, then remove SUPERADMIN_PASSWORD from the environment');
  } catch (e) { log.error({ err: e }, 'could not create the first super admin'); }
}
