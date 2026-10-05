import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { usdMicrosToMinor } from '../src/modules/calls/cost.js';
import { testEnv } from './env.js';

describe('usdMicrosToMinor', () => {
  it('converts provider USD to paise/cents at the configured rate', () => {
    expect(usdMicrosToMinor(1_000_000, 85)).toBe(8500);
    expect(usdMicrosToMinor(120_000, 1.4)).toBe(17);
    expect(usdMicrosToMinor(0, 85)).toBe(0);
  });
});

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
(OWNER_URL && APP_URL ? describe : describe.skip)('Call cost reaches the finance register (integration)', () => {
  const env = testEnv({ VAPI_WEBHOOK_SECRET: 'hook-secret-0123456789', FX_USD_TO_INR: '85', FX_USD_TO_CAD: '1.4' });
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>, token = '', tenantId = '', runId = '';
  const ids: string[] = [];
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const report = (interactionId: string, cost: number) => request(app).post('/webhooks/vapi').set('x-vapi-secret', 'hook-secret-0123456789').send({
    message: { type: 'end-of-call-report', cost, durationSeconds: 60, transcript: 'x', endedReason: 'hangup', call: { metadata: { tenantId, interactionId } }, analysis: { structuredData: { answers: {} } } },
  });
  const reopen = (id: string) => owner.query("UPDATE interactions SET status = 'in_progress' WHERE id = $1", [id]);

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, finance_signoffs, finance_entries, survey_responses, interactions, campaign_runs, content_items, memberships, tenants, otp_codes, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env, pool });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await request(app).post('/api/auth/otp/request').send({ phone: '+919800000301' });
    token = (await request(app).post('/api/auth/otp/verify').send({ phone: '+919800000301', code: r.body.devCode })).body.accessToken;
    tenantId = (await request(app).post('/api/tenants').set(auth()).send({ raceType: 'assembly', seatCode: 'C1', electionDate: '2027-02-20', campaignName: 'Cost Test' })).body.id;
    await owner.query('UPDATE tenants SET spend_limit_minor = 10000 WHERE id = $1', [tenantId]);
    const item = (await owner.query("INSERT INTO content_items (tenant_id, kind, locale, title, body, status) VALUES ($1,'script','en','s','b','approved') RETURNING id", [tenantId])).rows[0].id;
    runId = (await owner.query("INSERT INTO campaign_runs (tenant_id, name, channel, content_item_id, purpose, status, started_at) VALUES ($1,'Run 1','voice',$2,'survey','running', now()) RETURNING id", [tenantId, item])).rows[0].id;
    for (let k = 0; k < 2; k++) {
      ids.push((await owner.query("INSERT INTO interactions (tenant_id, run_id, channel, direction, status) VALUES ($1,$2,'voice','outbound','in_progress') RETURNING id", [tenantId, runId])).rows[0].id);
    }
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  const entries = async () => (await request(app).get(`/api/t/${tenantId}/finance/entries`).set(auth())).body as Array<{ amountMinor: number; source: string; flags: { code: string }[]; description: string }>;

  it('rejects a webhook without the secret', async () => {
    await request(app).post('/webhooks/vapi').send({ message: { type: 'end-of-call-report' } }).expect(401);
  });

  it('creates ONE expense for the run and grows it as more calls report cost', async () => {
    await report(ids[0]!, 0.5).expect(200);
    let e = await entries();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ source: 'call_run', amountMinor: 4250 }); // 0.50 USD x 85 = Rs 42.50
    await report(ids[1]!, 0.25).expect(200);
    e = await entries();
    expect(e).toHaveLength(1);
    expect(e[0]!.amountMinor).toBe(6375);
    expect(e[0]!.description).toContain('2 calls');
  });

  it('a repeated webhook for the same call does not double count', async () => {
    await report(ids[1]!, 0.25).expect(200);
    expect((await entries())[0]!.amountMinor).toBe(6375);
  });

  it('counts toward the spending limit and flags when it goes over', async () => {
    await owner.query('UPDATE interactions SET cost_usd_micros = 2000000 WHERE id = $1', [ids[0]]);
    await reopen(ids[1]!);
    await report(ids[1]!, 0.25).expect(200);
    const e = await entries();
    expect(e[0]!.amountMinor).toBe(2 * 8500 + 2125);
    expect(e[0]!.flags.map((f) => f.code)).toContain('OVER_SPENDING_LIMIT');
    const summary = (await request(app).get(`/api/t/${tenantId}/finance/summary`).set(auth())).body;
    expect(summary.expense).toBe(19125);
  });

  it('never changes a signed-off period', async () => {
    await owner.query("UPDATE tenants SET finance_locked_until = '2999-01-01' WHERE id = $1", [tenantId]);
    await reopen(ids[1]!);
    const before = (await entries())[0]!.amountMinor;
    await report(ids[1]!, 5).expect(200);
    expect((await entries())[0]!.amountMinor).toBe(before);
  });
});
