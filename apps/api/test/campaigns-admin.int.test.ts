/** Super admin portal: create a campaign for a candidate (account + owner + package) in one step. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import { MemoryRateStore } from '../src/lib/rate-limit.js';
import { createSuperAdmin } from '../src/lib/bootstrap.js';
import { hashPassword } from '../src/lib/password.js';
import { testEnv } from './env.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

run('Super admin: create a campaign for a candidate (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  const mailer = new MemoryMailer();
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = (email: string, password: string) => request(app).post('/api/auth/login').send({ email, password });
  let sa = '', plain = '';
  const campaign = (extra: object = {}) => ({
    campaignName: 'Gurpreet Kaur for Ludhiana West', seatCode: 'pb-061', raceType: 'assembly', electionDate: '2027-02-20',
    owner: { email: 'Gurpreet@Test.local', name: 'Gurpreet Kaur' }, plan: { planCode: 'assembly-2027' }, ...extra,
  });
  const create = (body: object, tk = sa) => request(app).post('/api/superadmin/campaigns').set(bearer(tk)).send(body);

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, password_resets, subscriptions, plans, memberships, tenants, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env: testEnv(), pool, mailer, rateStore: new MemoryRateStore() });
    await createSuperAdmin(pool, 'root@test.local', 'Root-password-2027');
    const first = (await login('root@test.local', 'Root-password-2027').expect(200)).body;
    sa = (await request(app).post('/api/auth/change-password').set(bearer(first.accessToken)).send({ currentPassword: 'Root-password-2027', newPassword: 'A brand new passphrase' }).expect(200)).body.accessToken;
    await owner.query("INSERT INTO users (email, password_hash) VALUES ('plain@test.local', $1)", [await hashPassword('Plain-user-passphrase-1')]);
    plain = (await login('plain@test.local', 'Plain-user-passphrase-1').expect(200)).body.accessToken;
    const plan = { name: 'Assembly package', region: 'IN', billing: 'per_campaign', priceMinor: 5_000_000, included: { smsSent: 1000 }, overageMinor: { smsSent: 20 }, hardLimits: {}, active: true };
    await request(app).put('/api/admin/plans/assembly-2027').set(bearer(sa)).send(plan).expect(200);
    await request(app).put('/api/admin/plans/canada-only').set(bearer(sa)).send({ ...plan, name: 'Canada', region: 'CA' }).expect(200);
  });
  afterAll(async () => { await pool.end(); await owner.end(); });

  it('only a super admin can do it', async () => {
    await create(campaign(), plain).expect(403);
    await request(app).get('/api/superadmin/campaigns').set(bearer(plain)).expect(403);
  });

  it('creates the candidate\'s account, the campaign, their ownership and the package in one step', async () => {
    const r = (await create(campaign()).expect(201)).body;
    expect(r.campaign).toMatchObject({ campaignName: 'Gurpreet Kaur for Ludhiana West', seatCode: 'PB-061', region: 'IN' });
    expect(r.owner).toMatchObject({ email: 'gurpreet@test.local', newAccount: true });
    expect(r.owner.temporaryPassword).toHaveLength(16);
    expect(r.plan).toBe('assembly-2027');
    const [m] = await q("SELECT role FROM memberships WHERE tenant_id = $1", [r.campaign.id]);
    expect(m.role).toBe('owner');
    const [s] = await q("SELECT plan, plan_code, status FROM subscriptions WHERE tenant_id = $1", [r.campaign.id]);
    expect(s).toMatchObject({ plan: 'Assembly package', plan_code: 'assembly-2027', status: 'active' });
    // The candidate signs in with the password they were handed, must choose their own, and then sees their campaign.
    const l = (await login('gurpreet@test.local', r.owner.temporaryPassword).expect(200)).body;
    expect(l.mustChangePassword).toBe(true);
    const mine = (await request(app).post('/api/auth/change-password').set(bearer(l.accessToken)).send({ currentPassword: r.owner.temporaryPassword, newPassword: 'Chosen-words-for-me-1' }).expect(200)).body;
    const me = (await request(app).get('/api/auth/me').set(bearer(mine.accessToken)).expect(200)).body;
    expect(me.campaigns).toEqual([expect.objectContaining({ tenant_id: r.campaign.id, role: 'owner', campaign_name: 'Gurpreet Kaur for Ludhiana West' })]);
    expect((await request(app).get(`/api/t/${r.campaign.id}/billing`).set(bearer(mine.accessToken)).expect(200)).body.subscription).toMatchObject({ plan: 'Assembly package' });
    expect((await q("SELECT action FROM audit_log WHERE tenant_id = $1", [r.campaign.id])).map((x) => x.action)).toEqual(expect.arrayContaining(['create', 'assign_plan', 'superadmin_create_campaign']));
  });

  it('an existing account becomes owner of another campaign, and keeps its password', async () => {
    const r = (await create(campaign({ campaignName: 'Second Seat', seatCode: 'PB-062', owner: { email: 'gurpreet@test.local' }, plan: undefined })).expect(201)).body;
    expect(r.owner).toMatchObject({ newAccount: false });
    expect(r.owner.temporaryPassword).toBeUndefined();
    expect(r.plan).toBeNull();
    await login('gurpreet@test.local', 'Chosen-words-for-me-1').expect(200);
    expect(await q("SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'gurpreet@test.local' AND m.role = 'owner'")).toHaveLength(2);
  });

  it('a taken seat is refused and leaves no new account behind', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM users'))[0].n;
    const r = await create(campaign({ owner: { email: 'newcomer@test.local' } })).expect(409);
    expect(r.body.error).toBe('ONE_RACE_ONE_CLIENT');
    expect((await q('SELECT count(*)::int AS n FROM users'))[0].n).toBe(before);
  });

  it('a package for the wrong country, or a weak password, is refused before anything is created', async () => {
    const before = { users: (await q('SELECT count(*)::int AS n FROM users'))[0].n, tenants: (await q('SELECT count(*)::int AS n FROM tenants'))[0].n };
    const wrong = await create(campaign({ seatCode: 'PB-070', owner: { email: 'wrong@test.local' }, plan: { planCode: 'canada-only' } })).expect(422);
    expect(wrong.body.error).toBe('PLAN_REGION_MISMATCH');
    await create(campaign({ seatCode: 'PB-071', owner: { email: 'nope@test.local' }, plan: { planCode: 'does-not-exist' } })).expect(404);
    const weak = await create(campaign({ seatCode: 'PB-072', owner: { email: 'weak@test.local', password: 'password' } })).expect(422);
    expect(weak.body.error).toBe('WEAK_PASSWORD');
    expect({ users: (await q('SELECT count(*)::int AS n FROM users'))[0].n, tenants: (await q('SELECT count(*)::int AS n FROM tenants'))[0].n }).toEqual(before);
  });

  it('can email the candidate a link to choose a password instead', async () => {
    const n = mailer.sent.length;
    const r = (await create(campaign({ seatCode: 'PB-080', campaignName: 'Invited Candidate', owner: { email: 'invited@test.local', sendInvite: true }, plan: undefined })).expect(201)).body;
    expect(r.owner).toMatchObject({ newAccount: true, invited: true });
    expect(r.owner.temporaryPassword).toBeUndefined();
    expect(mailer.sent.length).toBe(n + 1);
    expect(mailer.sent.at(-1)).toMatchObject({ to: 'invited@test.local' });
    await create(campaign({ seatCode: 'PB-081', owner: { email: 'both@test.local', password: 'Both-given-pass-123', sendInvite: true } })).expect(400);
  });

  it('refuses a disabled owner account', async () => {
    const [{ id }] = await q("SELECT id FROM users WHERE email = 'invited@test.local'");
    await request(app).patch(`/api/superadmin/users/${id}`).set(bearer(sa)).send({ disabled: true }).expect(200);
    expect((await create(campaign({ seatCode: 'PB-090', owner: { email: 'invited@test.local' } })).expect(409)).body.error).toBe('ACCOUNT_DISABLED');
  });

  it('lists every campaign with its owner and package', async () => {
    const list = (await request(app).get('/api/superadmin/campaigns').set(bearer(sa)).expect(200)).body;
    const g = list.find((c: any) => c.seatCode === 'PB-061');
    expect(g).toMatchObject({ campaignName: 'Gurpreet Kaur for Ludhiana West', electionDate: '2027-02-20', owner: { email: 'gurpreet@test.local', name: 'Gurpreet Kaur' }, plan: { name: 'Assembly package', status: 'active' } });
    expect(list.find((c: any) => c.seatCode === 'PB-062').plan).toBeNull();
    expect(JSON.stringify(list)).not.toMatch(/password|hash/i);
  });

  it('the ordinary campaign-creation route still works for a signed-in user', async () => {
    const r = await request(app).post('/api/tenants').set(bearer(plain)).send({ raceType: 'assembly', seatCode: 'PB-100', electionDate: '2027-02-20', campaignName: 'Self made' }).expect(201);
    expect(r.body.seatCode).toBe('PB-100');
    await request(app).post('/api/tenants').set(bearer(plain)).send({ raceType: 'assembly', seatCode: 'PB-100', electionDate: '2027-02-20', campaignName: 'Again' }).expect(409);
  });
});
