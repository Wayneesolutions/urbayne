/** Sign-in with email and password, forgot password, and the super admin portal (replaces login by phone and one-time code). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import { MemoryRateStore } from '../src/lib/rate-limit.js';
import { createSuperAdmin, ensureSuperAdmin } from '../src/lib/bootstrap.js';
import { generatePassword, hashPassword, passwordProblem, verifyPassword } from '../src/lib/password.js';
import { loadEnv } from '../src/env.js';
import { testEnv } from './env.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

describe('password rules', () => {
  it('hashes with a salt, verifies, and does not accept a wrong password', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterz', a)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
  it('asks for length, not symbols, and refuses obvious passwords and the email itself', () => {
    expect(passwordProblem('short1')).toMatch(/10 characters/);
    expect(passwordProblem('password')).toBeTruthy();
    expect(passwordProblem('aaaaaaaaaaaa')).toBeTruthy();
    expect(passwordProblem('1234567890')).toBeTruthy();
    expect(passwordProblem('priya.sharma-2027', 'priya.sharma@example.com')).toMatch(/email/);
    expect(passwordProblem('four plain words here')).toBeNull();
  });
  it('generated passwords are long, random and free of look-alike characters', () => {
    const a = generatePassword(), b = generatePassword();
    expect(a).toHaveLength(16);
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/[0OIl1]/);
    expect(passwordProblem(a)).toBeNull();
  });
});

describe('settings', () => {
  const base = { APP_DATABASE_URL: 'postgres://x:y@localhost/db', JWT_SECRET: 'x'.repeat(20), JWT_REFRESH_SECRET: 'y'.repeat(20), DEPLOY_REGION: 'IN', PHONE_ENC_KEY: 'a'.repeat(44), PHONE_HASH_KEY: 'b'.repeat(44) };
  it('production may run without email, but must never hand out reset tokens', () => {
    const prod = { ...base, NODE_ENV: 'production', REDIS_URL: 'redis://x', EVIDENCE_SIGNING_KEY: 'k'.repeat(32), STORAGE_DRIVER: 's3', FILES_BUCKET: 'files' };
    expect(loadEnv(prod as any).SMTP_URL).toBeUndefined();
    expect(() => loadEnv({ ...prod, SMTP_URL: 'smtp://m:25', DEV_RETURN_RESET_TOKEN: 'true' } as any)).toThrow(/DEV_RETURN_RESET_TOKEN/);
  });
});

run('Email login, password reset and the super admin portal (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  const mailer = new MemoryMailer();
  const SA_EMAIL = 'root@test.local', SA_PASSWORD = 'Root-password-2027';
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  const login = (email: string, password: string) => request(app).post('/api/auth/login').send({ email, password });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let sa = '', saRefresh = '';

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, password_resets, agency_members, agencies, memberships, tenants, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env: testEnv(), pool, mailer, rateStore: new MemoryRateStore() });
    await createSuperAdmin(pool, SA_EMAIL, SA_PASSWORD, 'Root');
  });
  afterAll(async () => { await pool.end(); await owner.end(); });

  describe('sign in', () => {
    it('a bootstrapped super admin must choose their own password before anything else', async () => {
      const r = await login(SA_EMAIL.toUpperCase(), SA_PASSWORD).expect(200); // email is not case sensitive
      expect(r.body).toMatchObject({ mustChangePassword: true, user: { email: SA_EMAIL, isSuperAdmin: true } });
      const blocked = await request(app).get('/api/superadmin/users').set(bearer(r.body.accessToken)).expect(403);
      expect(blocked.body.error).toBe('PASSWORD_CHANGE_REQUIRED');
      await request(app).get('/api/auth/me').set(bearer(r.body.accessToken)).expect(200); // the password routes still work
      const weak = await request(app).post('/api/auth/change-password').set(bearer(r.body.accessToken)).send({ currentPassword: SA_PASSWORD, newPassword: 'short' }).expect(422);
      expect(weak.body.error).toBe('WEAK_PASSWORD');
      await request(app).post('/api/auth/change-password').set(bearer(r.body.accessToken)).send({ currentPassword: 'wrong-password-12', newPassword: 'A brand new passphrase' }).expect(401);
      const ok = (await request(app).post('/api/auth/change-password').set(bearer(r.body.accessToken)).send({ currentPassword: SA_PASSWORD, newPassword: 'A brand new passphrase' }).expect(200)).body;
      expect(ok.mustChangePassword).toBe(false);
      sa = ok.accessToken; saRefresh = ok.refreshToken;
      await request(app).get('/api/superadmin/users').set(bearer(sa)).expect(200);
      await login(SA_EMAIL, SA_PASSWORD).expect(401); // the old password no longer works
      await request(app).post('/api/auth/refresh').send({ refreshToken: r.body.refreshToken }).expect(401); // and the old session ended
    });

    it('a wrong password and an unknown email look exactly the same', async () => {
      const a = await login(SA_EMAIL, 'not the password 1').expect(401);
      const b = await login('nobody@test.local', 'not the password 1').expect(401);
      expect(a.body).toEqual(b.body);
      await request(app).post('/api/auth/login').send({ email: SA_EMAIL }).expect(400);
      await request(app).post('/api/auth/login').send({ email: SA_EMAIL, password: 'x', extra: 1 }).expect(400);
    });

    it('stops guessing: too many tries on one account are refused, even with the right password', async () => {
      const email = 'guess@test.local';
      await request(app).post('/api/superadmin/users').set(bearer(sa)).send({ name: 'Guess', email, password: 'Lemon-tree-walks-123', mustChangePassword: false, type: 'user' }).expect(201);
      let last = 0;
      for (let i = 0; i < 22; i++) last = (await login(email, `wrong-password-${i}`)).status;
      expect(last).toBe(429);
      expect((await login(email, 'Lemon-tree-walks-123')).status).toBe(429);
    });
  });

  describe('forgot password', () => {
    let email = 'forgetful@test.local';
    beforeAll(async () => {
      await request(app).post('/api/superadmin/users').set(bearer(sa)).send({ name: 'Forgetful', email, password: 'Original-password-1', mustChangePassword: false, type: 'user' }).expect(201);
    });
    const tokenFromMail = () => /token=([A-Za-z0-9_-]+)/.exec(mailer.sent.at(-1)!.text)![1]!;

    it('answers the same for an account and for a stranger, and emails only the account', async () => {
      const before = mailer.sent.length;
      const a = (await request(app).post('/api/auth/forgot').send({ email }).expect(200)).body;
      const b = (await request(app).post('/api/auth/forgot').send({ email: 'stranger@test.local' }).expect(200)).body;
      expect(a.message).toBe(b.message);
      expect(mailer.sent.length).toBe(before + 1);
      expect(mailer.sent.at(-1)).toMatchObject({ to: email });
      expect(mailer.sent.at(-1)!.text).toContain('http://t/admin/reset-password?token=');
      expect(a.devToken).toBeTruthy(); // test settings only
    });

    it('only a hash of the link is kept, the link works once, and signs the person out everywhere', async () => {
      const token = tokenFromMail();
      expect(JSON.stringify(await q('SELECT * FROM password_resets'))).not.toContain(token);
      const session = (await login(email, 'Original-password-1').expect(200)).body;
      await request(app).post('/api/auth/reset').send({ token, password: 'short' }).expect(422);
      await request(app).post('/api/auth/reset').send({ token: 'x'.repeat(43), password: 'Whatever-new-pass-1' }).expect(400);
      await request(app).post('/api/auth/reset').send({ token, password: 'Newer-password-2027' }).expect(200);
      await request(app).post('/api/auth/reset').send({ token, password: 'Another-password-2027' }).expect(400); // used
      await login(email, 'Original-password-1').expect(401);
      await login(email, 'Newer-password-2027').expect(200);
      await request(app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken }).expect(401);
    });

    it('a newer link replaces the older one, and an expired link does not work', async () => {
      await request(app).post('/api/auth/forgot').send({ email }).expect(200);
      const first = tokenFromMail();
      await request(app).post('/api/auth/forgot').send({ email }).expect(200);
      const second = tokenFromMail();
      expect(second).not.toBe(first);
      await request(app).post('/api/auth/reset').send({ token: first, password: 'Newest-password-2027' }).expect(400);
      await owner.query("UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL");
      await request(app).post('/api/auth/reset').send({ token: second, password: 'Newest-password-2027' }).expect(400);
    });

    it('does not mail a disabled account, and limits how often one address can ask', async () => {
      const dis = 'disabled@test.local';
      const id = (await request(app).post('/api/superadmin/users').set(bearer(sa)).send({ name: 'Off', email: dis, password: 'Switch-off-pass-123', type: 'user' }).expect(201)).body.id;
      await request(app).patch(`/api/superadmin/users/${id}`).set(bearer(sa)).send({ disabled: true }).expect(200);
      const n = mailer.sent.length;
      await request(app).post('/api/auth/forgot').send({ email: dis }).expect(200);
      expect(mailer.sent.length).toBe(n);
      for (let i = 0; i < 5; i++) await request(app).post('/api/auth/forgot').send({ email: 'spam@test.local' }).expect(200);
      await request(app).post('/api/superadmin/users').set(bearer(sa)).send({ name: 'Spam', email: 'spam@test.local', password: 'Spammed-pass-123', type: 'user' }).expect(201);
      const m = mailer.sent.length;
      for (let i = 0; i < 5; i++) await request(app).post('/api/auth/forgot').send({ email: 'spam@test.local' }).expect(200);
      expect(mailer.sent.length - m).toBeLessThanOrEqual(3);
    });
  });

  describe('super admin portal', () => {
    it('only a super admin may use it', async () => {
      await request(app).get('/api/superadmin/users').expect(401);
      const id = (await request(app).post('/api/superadmin/users').set(bearer(sa)).send({ name: 'Plain Admin', email: 'admin1@test.local', password: 'Admin-one-password-1', mustChangePassword: false, type: 'admin' }).expect(201)).body.id;
      const t = (await login('admin1@test.local', 'Admin-one-password-1').expect(200)).body.accessToken;
      await request(app).get('/api/superadmin/users').set(bearer(t)).expect(403); // platform staff are not super admins
      await request(app).post('/api/superadmin/users').set(bearer(t)).send({ name: 'x', email: 'x@test.local' }).expect(403);
      expect(id).toBeTruthy();
    });

    it('creates an admin with an email and a password they sign in with (and must change)', async () => {
      const r = (await request(app).post('/api/superadmin/users').set(bearer(sa)).send({ name: 'Asha Verma', email: 'Asha.Verma@Test.local', password: 'Handed-over-pass-1' }).expect(201)).body;
      expect(r).toMatchObject({ email: 'asha.verma@test.local', type: 'admin', mustChangePassword: true, temporaryPassword: 'Handed-over-pass-1' });
      const l = (await login('asha.verma@test.local', 'Handed-over-pass-1').expect(200)).body;
      expect(l.mustChangePassword).toBe(true);
      expect(l.user.isPlatformAdmin).toBe(true);
      const [row] = await q('SELECT password_hash FROM users WHERE email = $1', ['asha.verma@test.local']);
      expect(row.password_hash).not.toContain('Handed-over-pass-1');
      await request(app).post('/api/superadmin/users').set(bearer(sa)).send({ name: 'Dup', email: 'asha.verma@test.local' }).expect(409);
    });

    it('generates a password when none is given (shown once), and refuses a weak one', async () => {
      const r = (await request(app).post('/api/superadmin/users').set(bearer(sa)).send({ name: 'Generated', email: 'gen@test.local' }).expect(201)).body;
      expect(r.temporaryPassword).toHaveLength(16);
      await login('gen@test.local', r.temporaryPassword).expect(200);
      const weak = await request(app).post('/api/superadmin/users').set(bearer(sa)).send({ name: 'Weak', email: 'weak@test.local', password: 'password' }).expect(422);
      expect(weak.body.error).toBe('WEAK_PASSWORD');
      await request(app).post('/api/superadmin/users').set(bearer(sa)).send({ name: 'Both', email: 'both@test.local', password: 'Both-password-123', sendInvite: true }).expect(400);
    });

    it('can invite by email instead: no password is set, the person chooses one from the link', async () => {
      const n = mailer.sent.length;
      const r = (await request(app).post('/api/superadmin/users').set(bearer(sa)).send({ name: 'Invitee', email: 'invitee@test.local', sendInvite: true, type: 'user' }).expect(201)).body;
      expect(r).toMatchObject({ invited: true });
      expect(r.temporaryPassword).toBeUndefined();
      expect(mailer.sent.length).toBe(n + 1);
      const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent.at(-1)!.text)![1]!;
      expect(mailer.sent.at(-1)!.subject).toMatch(/Set your password/);
      await request(app).post('/api/auth/reset').send({ token, password: 'Chosen-by-me-today-1' }).expect(200);
      expect((await login('invitee@test.local', 'Chosen-by-me-today-1').expect(200)).body.mustChangePassword).toBe(false);
    });

    it('lists accounts, finds them by email or name, and shows what each is', async () => {
      const all = (await request(app).get('/api/superadmin/users').set(bearer(sa)).expect(200)).body;
      expect(all.find((u: any) => u.email === SA_EMAIL)).toMatchObject({ type: 'super_admin' });
      expect(all.find((u: any) => u.email === 'admin1@test.local')).toMatchObject({ type: 'admin', disabled: false });
      expect(JSON.stringify(all)).not.toMatch(/password_hash|passwordHash|scrypt/);
      const found = (await request(app).get('/api/superadmin/users?q=verma').set(bearer(sa)).expect(200)).body;
      expect(found.map((u: any) => u.email)).toEqual(['asha.verma@test.local']);
    });

    it('changes what an account can do, and disabling signs the person out at once', async () => {
      const [{ id }] = await q("SELECT id FROM users WHERE email = 'admin1@test.local'");
      const session = (await login('admin1@test.local', 'Admin-one-password-1').expect(200)).body;
      await request(app).patch(`/api/superadmin/users/${id}`).set(bearer(sa)).send({ type: 'user', name: 'Plain User' }).expect(200);
      expect((await q('SELECT is_wes_admin FROM users WHERE id = $1', [id]))[0].is_wes_admin).toBe(false);
      await request(app).patch(`/api/superadmin/users/${id}`).set(bearer(sa)).send({ disabled: true }).expect(200);
      await request(app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken }).expect(401);
      await login('admin1@test.local', 'Admin-one-password-1').expect(401);
      await request(app).patch(`/api/superadmin/users/${id}`).set(bearer(sa)).send({ disabled: false }).expect(200);
      await login('admin1@test.local', 'Admin-one-password-1').expect(200);
    });

    it('there is no way for an admin to set another person password: a forgotten one is reset by the person, from the emailed link', async () => {
      const [{ id }] = await q("SELECT id FROM users WHERE email = 'asha.verma@test.local'");
      await request(app).post(`/api/superadmin/users/${id}/reset-password`).set(bearer(sa)).send({}).expect(404);
      await request(app).post(`/api/superadmin/users/${id}/send-reset-link`).set(bearer(sa)).expect(200);
      expect(mailer.sent.at(-1)).toMatchObject({ to: 'asha.verma@test.local' });
    });

    it('there is always one active super admin, and nobody removes their own access', async () => {
      const [{ id }] = await q('SELECT id FROM users WHERE email = $1', [SA_EMAIL]);
      expect((await request(app).patch(`/api/superadmin/users/${id}`).set(bearer(sa)).send({ disabled: true }).expect(409)).body.error).toBe('NOT_YOURSELF');
      expect((await request(app).patch(`/api/superadmin/users/${id}`).set(bearer(sa)).send({ type: 'admin' }).expect(409)).body.error).toBe('NOT_YOURSELF');
      // A second super admin may demote the first, but not the last one.
      const second = (await request(app).post('/api/superadmin/users').set(bearer(sa)).send({ name: 'Second', email: 'second@test.local', password: 'Super-pass-number-two', type: 'super_admin', mustChangePassword: false }).expect(201)).body.id;
      const t2 = (await login('second@test.local', 'Super-pass-number-two').expect(200)).body.accessToken;
      await request(app).patch(`/api/superadmin/users/${id}`).set(bearer(t2)).send({ type: 'admin' }).expect(200);
      expect((await request(app).patch(`/api/superadmin/users/${second}`).set(bearer(t2)).send({ type: 'admin' }).expect(409)).body.error).toBe('NOT_YOURSELF');
      // The demoted one lost super admin access immediately, even with a token that still says otherwise.
      await request(app).get('/api/superadmin/users').set(bearer(sa)).expect(403);
      await request(app).post('/api/superadmin/users').set(bearer(t2)).send({ name: 'Back', email: 'back@test.local', type: 'user' }).expect(201);
      await request(app).patch(`/api/superadmin/users/${id}`).set(bearer(t2)).send({ type: 'super_admin' }).expect(200);
    });

    it('everything done here is in the audit log', async () => {
      const actions = (await q("SELECT DISTINCT action FROM audit_log WHERE entity = 'user'")).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['create_account', 'update_account', 'send_reset_link', 'password_reset', 'password_change']));
    });
  });

  describe('a production server with no email set up', () => {
    let prod: ReturnType<typeof createApp>, t = '';
    beforeAll(async () => {
      await owner.query('TRUNCATE audit_log, password_resets, memberships, tenants, users CASCADE');
      await owner.query("INSERT INTO users (email, password_hash, name, is_super_admin, is_wes_admin) VALUES ('boss@test.local', $1, 'Boss', true, true)", [await hashPassword('Boss-long-passphrase-1')]);
      prod = createApp({ env: testEnv({ NODE_ENV: 'production', DEV_RETURN_RESET_TOKEN: 'false', REDIS_URL: 'redis://localhost:6379', EVIDENCE_SIGNING_KEY: 'k'.repeat(32), STORAGE_DRIVER: 's3', FILES_BUCKET: 'test-files' }), pool, mailer, rateStore: new MemoryRateStore() });
      t = (await request(prod).post('/api/auth/login').send({ email: 'boss@test.local', password: 'Boss-long-passphrase-1' }).expect(200)).body.accessToken;
    });
    it('switches "forgot password" off, and says so plainly', async () => {
      expect((await request(prod).get('/api/auth/config').expect(200)).body).toEqual({ passwordReset: false });
      const r = await request(prod).post('/api/auth/forgot').send({ email: 'boss@test.local' }).expect(503);
      expect(r.body.error).toBe('RESET_BY_EMAIL_OFF');
      expect((await request(app).get('/api/auth/config').expect(200)).body).toEqual({ passwordReset: true }); // development servers log the email instead
    });
    it('a super admin still creates accounts with a password to hand over', async () => {
      const made = (await request(prod).post('/api/superadmin/users').set(bearer(t)).send({ name: 'Hand', email: 'hand@test.local' }).expect(201)).body;
      await login('hand@test.local', made.temporaryPassword).expect(200);
    });
    it('email-only options are refused instead of failing silently', async () => {
      expect((await request(prod).post('/api/superadmin/users').set(bearer(t)).send({ name: 'Inv', email: 'inv@test.local', sendInvite: true }).expect(409)).body.error).toBe('EMAIL_NOT_CONFIGURED');
      const [{ id }] = await q("SELECT id FROM users WHERE email = 'hand@test.local'");
      expect((await request(prod).post(`/api/superadmin/users/${id}/send-reset-link`).set(bearer(t)).expect(409)).body.error).toBe('EMAIL_NOT_CONFIGURED');
    });
    it('a team member must be given a password', async () => {
      const tenant = (await request(prod).post('/api/tenants').set(bearer(t)).send({ raceType: 'assembly', seatCode: 'NM-1', electionDate: '2027-02-20', campaignName: 'No Mail' }).expect(201)).body.id;
      const r = await request(prod).post(`/api/t/${tenant}/members`).set(bearer(t)).send({ email: 'w@test.local', role: 'field_worker' }).expect(422);
      expect(r.body.error).toBe('PASSWORD_REQUIRED');
      await request(prod).post(`/api/t/${tenant}/members`).set(bearer(t)).send({ email: 'w@test.local', role: 'field_worker', password: 'Worker-given-pass-1' }).expect(201);
    });
  });

  describe('first super admin', () => {
    const log = { info: () => {}, error: () => {} };
    it('is created from the environment only while there is none', async () => {
      await owner.query('TRUNCATE audit_log, password_resets, memberships, tenants, users CASCADE');
      await ensureSuperAdmin(pool, {}, log);
      expect(await q('SELECT 1 FROM users')).toHaveLength(0); // nothing set: nothing created
      await ensureSuperAdmin(pool, { SUPERADMIN_EMAIL: 'first@test.local', SUPERADMIN_PASSWORD: 'Super-pass-number-one' }, log);
      expect((await q('SELECT is_super_admin, is_wes_admin, must_change_password FROM users WHERE email = $1', ['first@test.local']))[0]).toEqual({ is_super_admin: true, is_wes_admin: true, must_change_password: true });
      await ensureSuperAdmin(pool, { SUPERADMIN_EMAIL: 'another@test.local', SUPERADMIN_PASSWORD: 'Super-pass-number-three' }, log);
      expect(await q('SELECT 1 FROM users')).toHaveLength(1); // one exists already
      await login('first@test.local', 'Super-pass-number-one').expect(200);
    });
    it('a weak bootstrap password is refused', async () => {
      await expect(createSuperAdmin(pool, 'weak@test.local', 'password')).rejects.toThrow(/not accepted/);
    });
  });

  describe('team members by email', () => {
    it('an owner adds someone by email: with a password they must change, or with an invite email', async () => {
      await owner.query('TRUNCATE audit_log, password_resets, memberships, tenants, users CASCADE');
      await createSuperAdmin(pool, SA_EMAIL, SA_PASSWORD);
      await request(app).post('/api/superadmin/users').set(bearer((await login(SA_EMAIL, SA_PASSWORD).expect(200)).body.accessToken)).expect(403); // still has to change the password
      const cand = 'candidate@test.local';
      await owner.query("INSERT INTO users (email, password_hash, name) VALUES ($1, $2, 'Candidate')", [cand, await hashPassword('Candidate-pass-2027')]);
      const t = (await login(cand, 'Candidate-pass-2027').expect(200)).body.accessToken;
      const tenant = (await request(app).post('/api/tenants').set(bearer(t)).send({ raceType: 'assembly', seatCode: 'EM-1', electionDate: '2027-02-20', campaignName: 'Email Test' }).expect(201)).body.id;
      const withPw = (await request(app).post(`/api/t/${tenant}/members`).set(bearer(t)).send({ email: 'worker@test.local', name: 'Worker', role: 'field_worker', password: 'Start-pass-field-1' }).expect(201)).body;
      expect(withPw).toMatchObject({ email: 'worker@test.local', role: 'field_worker' });
      expect(withPw.invited).toBeUndefined();
      expect((await login('worker@test.local', 'Start-pass-field-1').expect(200)).body.mustChangePassword).toBe(true);
      const n = mailer.sent.length;
      const invited = (await request(app).post(`/api/t/${tenant}/members`).set(bearer(t)).send({ email: 'manager@test.local', role: 'manager' }).expect(201)).body;
      expect(invited.invited).toBe(true);
      expect(mailer.sent.length).toBe(n + 1);
      await request(app).post(`/api/t/${tenant}/members`).set(bearer(t)).send({ email: 'MANAGER@test.local', role: 'manager' }).expect(409); // already on the team, whatever the capital letters
      await request(app).post(`/api/t/${tenant}/members`).set(bearer(t)).send({ phone: '+919800000000', role: 'manager' }).expect(400); // an email is required now
      const list = (await request(app).get(`/api/t/${tenant}/members`).set(bearer(t)).expect(200)).body;
      expect(list.map((m: any) => m.email).sort()).toEqual(['candidate@test.local', 'manager@test.local', 'worker@test.local']);
    });
  });
});
