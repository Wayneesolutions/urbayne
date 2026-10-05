/**
 * Integration tests against a real Postgres with the migration applied.
 * Run: TEST_DATABASE_URL=postgres://cs:cs@localhost:5432/campaign_suite \
 *      TEST_APP_DATABASE_URL=postgres://cs_app:cs_app@localhost:5432/campaign_suite pnpm test
 * Skipped when those variables are not set.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { IN, CA } from '@cs/regions';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

const key = () => randomBytes(32).toString('base64');
const baseEnv = (region: 'IN' | 'CA'): Env => ({
  APP_DATABASE_URL: APP_URL ?? '',
  JWT_SECRET: 'test-secret-test-secret',
  JWT_REFRESH_SECRET: 'test-refresh-test-refresh',
  DEPLOY_REGION: region,
  OTP_PROVIDER: 'console',
  PHONE_ENC_KEY: KEY_ENC,
  PHONE_HASH_KEY: KEY_HASH,
  PORT: 0,
  PUBLIC_BASE_URL: 'http://localhost:4000',
  ANTHROPIC_MODEL: 'claude-sonnet-5', NODE_ENV: 'test', DEV_RETURN_OTP: 'false', FX_USD_TO_INR: 85, FX_USD_TO_CAD: 1.4, RUN_WORKERS: 'true', WORKER_CONCURRENCY: 4,
});
const KEY_ENC = key();
const KEY_HASH = key();

run('API (integration)', () => {
  let owner: pg.Pool;
  let pool: pg.Pool;
  let appIN: ReturnType<typeof createApp>;
  let appCA: ReturnType<typeof createApp>;

  async function login(app: ReturnType<typeof createApp>, phone: string) {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await request(app).post('/api/auth/otp/request').send({ phone }).expect(200);
    const line = String(spy.mock.calls.at(-1)?.[0] ?? '');
    spy.mockRestore();
    const code = line.split('-> ')[1]!;
    const res = await request(app).post('/api/auth/otp/verify').send({ phone, code }).expect(200);
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, consents, contacts, content_items, geo_areas, memberships, tenants, otp_codes, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    appIN = createApp({ env: baseEnv('IN'), pool });
    appCA = createApp({ env: baseEnv('CA'), pool });
  });
  afterAll(async () => { await pool.end(); await owner.end(); });

  let tokenA = '', tokenB = '', tenantA = '';

  it('health and auth guard', async () => {
    await request(appIN).get('/health').expect(200, { ok: true, region: 'IN' });
    await request(appIN).post('/api/tenants').send({}).expect(401);
  });

  it('rejects a wrong OTP', async () => {
    await request(appIN).post('/api/auth/otp/request').send({ phone: '+919800000009' }).expect(200);
    await request(appIN).post('/api/auth/otp/verify').send({ phone: '+919800000009', code: '000000' }).expect(401);
  });

  it('logs in by OTP and creates a campaign', async () => {
    tokenA = await login(appIN, '+919800000001');
    tokenB = await login(appIN, '+919800000002');
    const res = await request(appIN).post('/api/tenants').set('Authorization', `Bearer ${tokenA}`).send({
      raceType: 'assembly', seatCode: 'pb-061', electionDate: '2027-02-20',
      campaignName: 'Test Candidate', pollCloseAt: '2027-02-20T18:00:00+05:30', enabledModules: ['calls', 'hub'],
    }).expect(201);
    tenantA = res.body.id;
    expect(res.body.region).toBe('IN');
    expect(res.body.seatCode).toBe('PB-061');
  });

  it('enforces one race, one client', async () => {
    const res = await request(appIN).post('/api/tenants').set('Authorization', `Bearer ${tokenB}`).send({
      raceType: 'assembly', seatCode: 'PB-061', electionDate: '2027-02-20', campaignName: 'Rival',
    }).expect(409);
    expect(res.body.error).toBe('ONE_RACE_ONE_CLIENT');
  });

  it('isolates tenants (API and RLS)', async () => {
    await request(appIN).get(`/api/tenants/${tenantA}`).set('Authorization', `Bearer ${tokenB}`).expect(404);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", ['00000000-0000-0000-0000-000000000000']);
      const { rows } = await c.query('SELECT count(*)::int AS n FROM tenants');
      expect(rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });

  let scriptId = '';
  it('only approves scripts that open with the disclosure and carry an MCMC certificate', async () => {
    const auth = { Authorization: `Bearer ${tokenA}` };
    const bad = await request(appIN).post(`/api/t/${tenantA}/content`).set(auth)
      .send({ kind: 'script', locale: 'pa', title: 'Sabha invite', body: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਜੀ ...' }).expect(201);
    await request(appIN).post(`/api/t/${tenantA}/content/${bad.body.id}/approve`).set(auth).send({ certificateNo: 'MCMC/1' }).expect(422);

    const good = await request(appIN).post(`/api/t/${tenantA}/content`).set(auth)
      .send({ kind: 'script', locale: 'pa', title: 'Sabha invite', body: `${IN.aiDisclosure.spoken.pa} ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਜੀ ...` }).expect(201);
    scriptId = good.body.id;
    const noCert = await request(appIN).post(`/api/t/${tenantA}/content/${scriptId}/approve`).set(auth).send({}).expect(422);
    expect(noCert.body.error).toBe('CERTIFICATE_REQUIRED');
    const ok = await request(appIN).post(`/api/t/${tenantA}/content/${scriptId}/approve`).set(auth).send({ certificateNo: 'MCMC/LDH/0042' }).expect(200);
    expect(ok.body.status).toBe('certified');
  });

  it('sends edited content back to draft', async () => {
    const auth = { Authorization: `Bearer ${tokenA}` };
    const edited = await request(appIN).patch(`/api/t/${tenantA}/content/${scriptId}`).set(auth)
      .send({ body: `${IN.aiDisclosure.spoken.pa} ਨਵਾਂ ਸੁਨੇਹਾ` }).expect(200);
    expect(edited.body.status).toBe('draft');
    expect(edited.body.certificateNo).toBeNull();
    await request(appIN).post(`/api/t/${tenantA}/content/${scriptId}/approve`).set(auth).send({ certificateNo: 'MCMC/LDH/0043' }).expect(200);
  });

  let contactId = '';
  it('guards contact data sources and extra fields', async () => {
    const auth = { Authorization: `Bearer ${tokenA}` };
    await request(appIN).post(`/api/t/${tenantA}/contacts`).set(auth).send({ phone: '+919811111111', source: 'roll' }).expect(422);
    await request(appIN).post(`/api/t/${tenantA}/contacts`).set(auth).send({ phone: '+919811111111', source: 'form', caste: 'x' }).expect(400);
    const res = await request(appIN).post(`/api/t/${tenantA}/contacts`).set(auth).send({
      phone: '+919811111111', source: 'form',
      consents: [{ purpose: 'info', channel: 'voice', textVersion: 'v1', locale: 'pa', capturedVia: 'form' }],
    }).expect(201);
    contactId = res.body.id;
  });

  it('IN: blocks voice until calling hours are confirmed', async () => {
    const res = await request(appIN).post(`/api/t/${tenantA}/compliance/check`).set('Authorization', `Bearer ${tokenA}`).send({
      contentItemId: scriptId, contactId, channel: 'voice', purpose: 'info', sendAt: '2027-02-10T11:00:00+05:30',
    }).expect(200);
    expect(res.body.allowed).toBe(false);
    expect(res.body.reasons.map((r: any) => r.code)).toEqual(['CALLING_HOURS_NOT_CONFIGURED']);
  });

  it('CA: allows an approved, identified weekday-evening call', async () => {
    const token = await login(appCA, '+12045550101');
    const auth = { Authorization: `Bearer ${token}` };
    const t = await request(appCA).post('/api/tenants').set(auth).send({
      raceType: 'ward', seatCode: 'wpg-ward-3', electionDate: '2026-10-28', campaignName: 'Jane Doe for Ward 3',
      pollCloseAt: '2026-10-28T20:00:00-05:00',
    }).expect(201);
    expect(t.body.timeZone).toBe('America/Winnipeg');
    const s = await request(appCA).post(`/api/t/${t.body.id}/content`).set(auth).send({
      kind: 'script', locale: 'en', title: 'Advance vote reminder',
      body: `${CA.aiDisclosure.spoken.en} Jane Doe for Ward 3. Advance voting is open until Thursday.`,
    }).expect(201);
    const a = await request(appCA).post(`/api/t/${t.body.id}/content/${s.body.id}/approve`).set(auth).send({}).expect(200);
    expect(a.body.status).toBe('approved');
    const c = await request(appCA).post(`/api/t/${t.body.id}/contacts`).set(auth).send({
      phone: '+12045550199', source: 'form',
      consents: [{ purpose: 'reminder', channel: 'voice', textVersion: 'v1', locale: 'en', capturedVia: 'form' }],
    }).expect(201);
    const ok = await request(appCA).post(`/api/t/${t.body.id}/compliance/check`).set(auth).send({
      contentItemId: s.body.id, contactId: c.body.id, channel: 'voice', purpose: 'reminder', sendAt: '2026-10-21T18:00:00-05:00',
    }).expect(200);
    expect(ok.body).toMatchObject({ allowed: true, reasons: [] });
    const late = await request(appCA).post(`/api/t/${t.body.id}/compliance/check`).set(auth).send({
      contentItemId: s.body.id, contactId: c.body.id, channel: 'voice', purpose: 'reminder', sendAt: '2026-10-21T22:00:00-05:00',
    }).expect(200);
    expect(late.body.reasons.map((r: any) => r.code)).toContain('OUTSIDE_CALLING_HOURS');
  });

  it('writes an audit trail', async () => {
    const { rows } = await owner.query('SELECT action, entity FROM audit_log WHERE tenant_id = $1 ORDER BY id', [tenantA]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['create', 'approve', 'edit_reset_to_draft']));
  });
});
