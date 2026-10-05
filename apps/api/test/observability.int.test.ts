/** P0-10: structured logs without personal data, error reporting, readiness and the provider cost dashboard. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Writable } from 'node:stream';
import request from 'supertest';
import pg from 'pg';
import type { ErrorEvent } from '@sentry/node';
import { createApp, resolveDeps } from '../src/app.js';
import { createLogger, maskPhones } from '../src/lib/logger.js';
import { scrubEvent, type ErrorReporter, type ErrorContext } from '../src/lib/observability.js';
import { testEnv } from './env.js';

const memoryStream = () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  return { stream, text: () => lines.join(''), json: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
};
class FakeReporter implements ErrorReporter {
  readonly name = 'fake';
  captured: { err: unknown; ctx?: ErrorContext }[] = [];
  capture(err: unknown, ctx?: ErrorContext) { this.captured.push({ err, ctx }); }
  async flush() {}
}

describe('logs and error reports never carry personal data', () => {
  it('masks phone numbers in text', () => {
    expect(maskPhones('call +919876543210 and +12045550001 now')).toBe('call [phone] and [phone] now');
  });

  it('logger redacts secrets and phone fields, and masks numbers inside messages', () => {
    const m = memoryStream();
    const log = createLogger({ level: 'info', destination: m.stream });
    log.info({ req: { headers: { authorization: 'Bearer abc', cookie: 'c=1', 'x-vapi-secret': 's3' } }, body: { phone: '+919876543210', code: '123456', refreshToken: 'rt', name: 'ok' } }, 'hello +919876543210');
    const out = m.text();
    for (const secret of ['Bearer abc', 'c=1', 's3', '+919876543210', '123456', '"rt"']) expect(out).not.toContain(secret);
    expect(out).toContain('hello [phone]');
    expect(out).toContain('"service":"campaign-suite-api"');
  });

  it('scrubEvent strips request data, auth headers, user and phone numbers before anything is sent to Sentry', () => {
    const event = {
      type: undefined,
      message: 'failed for +919876543210',
      request: { data: { phone: '+919876543210' }, cookies: { a: 'b' }, query_string: 'token=x', headers: { authorization: 'Bearer z', 'x-vapi-secret': 's', accept: 'json' } },
      user: { id: 'u1', ip_address: '1.2.3.4' },
      exception: { values: [{ type: 'Error', value: 'boom +12045550001' }] },
      breadcrumbs: [{ message: 'dialled +919876543210', data: { to: '+919876543210' } }],
    } as unknown as ErrorEvent;
    const out = scrubEvent(event);
    const dump = JSON.stringify(out);
    expect(dump).not.toMatch(/\+\d{10,15}/);
    expect(dump).not.toContain('Bearer z');
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.headers).toEqual({ accept: 'json' });
    expect(out.user).toBeUndefined();
  });
});

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
(OWNER_URL && APP_URL ? describe : describe.skip)('requests, errors, readiness, cost dashboard (integration)', () => {
  const env = testEnv({ VAPI_WEBHOOK_SECRET: 'hook-secret', FX_USD_TO_INR: '85' });
  let owner: pg.Pool, pool: pg.Pool;
  let logs: ReturnType<typeof memoryStream>;
  let reporter: FakeReporter;
  let app: ReturnType<typeof createApp>;
  let token = '', tenantId = '', runId = '';
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const phone = '+919800000701';

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, finance_entries, interactions, campaign_runs, content_items, memberships, tenants, otp_codes, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    logs = memoryStream();
    reporter = new FakeReporter();
    app = createApp(resolveDeps({ env, pool, log: createLogger({ level: 'info', destination: logs.stream }), reporter }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await request(app).post('/api/auth/otp/request').send({ phone });
    token = (await request(app).post('/api/auth/otp/verify').send({ phone, code: r.body.devCode })).body.accessToken;
    tenantId = (await request(app).post('/api/tenants').set(auth()).send({ raceType: 'assembly', seatCode: 'OB-1', electionDate: '2027-02-20', campaignName: 'Obs Test' })).body.id;
    await owner.query('UPDATE tenants SET spend_limit_minor = 1000000 WHERE id = $1', [tenantId]);
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  it('every request gets an id (echoed if the caller sent a sane one) and one log line without bodies or phone numbers', async () => {
    const mine = await request(app).get('/api/region').set('X-Request-Id', 'trace-abc-12345').expect(200);
    expect(mine.headers['x-request-id']).toBe('trace-abc-12345');
    const generated = await request(app).get('/api/region').set('X-Request-Id', 'bad id with spaces').expect(200);
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    await request(app).post('/api/auth/otp/request').send({ phone: '+919800000799' });
    const all = logs.text();
    expect(all).not.toContain('919800000799');
    const line = logs.json().find((l) => l.reqId === 'trace-abc-12345')!;
    expect(line).toMatchObject({ method: 'GET', path: '/api/region', status: 200, level: 'info' });
    expect(typeof line.ms).toBe('number');
    const authed = await request(app).get(`/api/t/${tenantId}/privacy`).set(auth()).expect(200);
    const authedLine = logs.json().find((l) => l.reqId === authed.headers['x-request-id'])!;
    expect(authedLine.tenantId).toBe(tenantId);
    expect(authedLine.userId).toBeTruthy();
  });

  it('expected errors (401, 404, validation) are logged as warnings and NOT reported; health checks are not logged', async () => {
    const before = reporter.captured.length;
    await request(app).get(`/api/t/${tenantId}/privacy`).expect(401);
    await request(app).get('/api/t/00000000-0000-4000-8000-000000000000/privacy').set(auth()).expect(404);
    await request(app).post('/api/auth/otp/request').send({}).expect(400);
    expect(reporter.captured.length).toBe(before);
    expect(logs.json().some((l) => l.level === 'warn' && l.status === 401)).toBe(true);
    await request(app).get('/health').expect(200);
    expect(logs.json().some((l) => l.path === '/health')).toBe(false);
  });

  it('an unexpected error is reported with its request id, logged, and the caller only sees INTERNAL (no message, no phone)', async () => {
    const broken = new pg.Pool({ connectionString: 'postgres://nobody:nope@127.0.0.1:1/none', connectionTimeoutMillis: 300 });
    const rep = new FakeReporter();
    const m = memoryStream();
    const badApp = createApp(resolveDeps({ env, pool: broken, log: createLogger({ level: 'info', destination: m.stream }), reporter: rep }));
    const res = await request(badApp).post('/api/auth/otp/request').send({ phone: '+919800000750' }).expect(500);
    await broken.end().catch(() => {});
    expect(res.body.error).toBe('INTERNAL');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|9198000/);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(rep.captured).toHaveLength(1);
    expect(rep.captured[0]!.ctx?.reqId).toBe(res.body.requestId);
    expect(m.text()).toContain('unhandled error');
    expect(m.text()).not.toContain('919800000750');
  });

  it('/ready says 200 when the database answers and 503 (without details) when it does not', async () => {
    const ok = await request(app).get('/ready').expect(200);
    expect(ok.body).toEqual({ ok: true, checks: { database: true } });
    const broken = new pg.Pool({ connectionString: 'postgres://nobody:nope@127.0.0.1:1/none', connectionTimeoutMillis: 300 });
    const bad = await request(createApp({ env, pool: broken })).get('/ready').expect(503);
    await broken.end().catch(() => {});
    expect(bad.body).toEqual({ ok: false, checks: { database: false } });
  });

  describe('provider cost dashboard', () => {
    beforeAll(async () => {
      const item = (await owner.query("INSERT INTO content_items (tenant_id, kind, locale, title, body, status) VALUES ($1,'script','en','s','b','approved') RETURNING id", [tenantId])).rows[0].id;
      runId = (await owner.query("INSERT INTO campaign_runs (tenant_id, name, channel, content_item_id, purpose, status, started_at) VALUES ($1,'Cost run','voice',$2,'survey','completed', now()) RETURNING id", [tenantId, item])).rows[0].id;
      for (const micros of [500_000, 250_000, 250_000]) {
        await owner.query("INSERT INTO interactions (tenant_id, run_id, channel, direction, status, started_at, cost_usd_micros) VALUES ($1,$2,'voice','outbound','completed', now(), $3)", [tenantId, runId, micros]);
      }
      await owner.query("INSERT INTO interactions (tenant_id, run_id, channel, direction, status, started_at) VALUES ($1,$2,'voice','outbound','no_answer', now())", [tenantId, runId]); // no cost reported: not counted
      await owner.query("INSERT INTO interactions (tenant_id, run_id, channel, direction, status, started_at, cost_usd_micros) VALUES ($1,$2,'voice','outbound','completed', now() - interval '90 days', 9000000)", [tenantId, runId]); // outside the window
      await owner.query("INSERT INTO finance_entries (tenant_id, kind, entry_date, amount_minor, category, description, party_name, source, source_ref) VALUES ($1,'expense','2027-01-01',8500,'Other','calls','Vapi','call_run',$2)", [tenantId, runId]);
    });

    it("shows the campaign's own AI call spend by day and by run, and its share of the spending limit", async () => {
      const r = (await request(app).get(`/api/t/${tenantId}/costs?days=30`).set(auth()).expect(200)).body;
      expect(r).toMatchObject({ days: 30, currency: 'INR', calls: 3, totalUsd: 1, totalMinor: 8500, avgPerCallUsd: 0.3333 });
      expect(r.byDay).toHaveLength(1);
      expect(r.byRun).toEqual([{ runId, name: 'Cost run', calls: 3, usd: 1 }]);
      expect(r.callCostsInRegisterMinor).toBe(8500);
      expect(r.shareOfLimit).toBeCloseTo(0.0085, 4);
      await request(app).get(`/api/t/${tenantId}/costs?days=0`).set(auth()).expect(400);
      await request(app).get(`/api/t/${tenantId}/costs`).expect(401);
    });

    it('platform-wide cost is for Wayne E Solutions staff only', async () => {
      await request(app).get('/api/admin/costs').set(auth()).expect(403);
      await owner.query('UPDATE users SET is_wes_admin = true');
      const r = await request(app).post('/api/auth/otp/request').send({ phone });
      const wes = (await request(app).post('/api/auth/otp/verify').send({ phone, code: r.body.devCode })).body.accessToken;
      const all = (await request(app).get('/api/admin/costs?days=30').set('Authorization', `Bearer ${wes}`).expect(200)).body;
      expect(all.totalUsd).toBe(1);
      expect(all.totalCalls).toBe(3);
      expect(all.byRegion.find((x: { region: string }) => x.region === 'IN').usd).toBe(1);
      expect(all.campaigns[0]).toMatchObject({ campaign: 'Obs Test', calls: 3, usd: 1, demo: false });
      expect(JSON.stringify(all)).not.toMatch(/\+91|transcript/);
    });
  });
});
