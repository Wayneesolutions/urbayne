import pg from 'pg';
import request from 'supertest';
import { hashPassword } from '../src/lib/password.js';

/**
 * Test sign-in. Accounts are created straight in the database (there is no self-sign-up) with a known password,
 * and the email is derived from the phone-style label the older tests used, so one label is always the same person.
 */
export const TEST_PASSWORD = 'Test-password-12';
export const emailFor = (label: string) => `u${label.replace(/\D/g, '')}@test.local`;

let pool: pg.Pool | undefined;
let hash: string | undefined;
const db = () => (pool ??= new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }));
export const closeAuthHelper = async () => { await pool?.end(); pool = undefined; };

type Thenable<T> = Promise<T> & { expect: (status?: number) => Promise<T> };
const withExpect = <T extends { status: number }>(p: Promise<T>): Thenable<T> =>
  Object.assign(p, { expect: (status?: number) => p.then((r) => { if (status !== undefined && r.status !== status) throw new Error(`expected ${status}, got ${r.status}`); return r; }) });

/** Makes sure the account exists, has the known password, and does not have to change it. */
export function ensureUser(_app: unknown, label: string, name?: string) {
  return withExpect((async () => {
    hash ??= await hashPassword(TEST_PASSWORD);
    await db().query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
       ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE SET password_hash = $2, must_change_password = false`,
      [emailFor(label), hash, name ?? null],
    );
    return { status: 200, body: { sent: true, devCode: '000000' } };
  })());
}

/** Signs in as the account for this label (created if needed). The response has body.accessToken and body.refreshToken. */
export function tokenFor(app: Parameters<typeof request>[0], label: string) {
  return withExpect((async () => {
    await ensureUser(app, label);
    return request(app).post('/api/auth/login').send({ email: emailFor(label), password: TEST_PASSWORD });
  })());
}
