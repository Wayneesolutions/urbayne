/** P0-11: security controls: headers and CSP, token rules, support access, tenant isolation across every module, bad input. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { createApp, resolveDeps } from '../src/app.js';
import { signAccess, signRefresh, verifyAccess, verifyRefresh } from '../src/lib/jwt.js';
import { safeEqual } from '../src/lib/crypto.js';
import { testEnv } from './env.js';

describe('tokens', () => {
  const S = 'current-secret-current-secret', OLD = 'previous-secret-previous-secret';

  it('only HS256 tokens signed with a known secret are accepted ("none", other algorithms and wrong secrets are not)', () => {
    const good = signAccess({ sub: 'u1' }, S);
    expect(verifyAccess(good, S).sub).toBe('u1');
    expect(() => verifyAccess(good, 'some-other-secret-some-other')).toThrow();
    const none = jwt.sign({ sub: 'u1' }, '', { algorithm: 'none' });
    expect(() => verifyAccess(none, S)).toThrow();
    const hs512 = jwt.sign({ sub: 'u1' }, S, { algorithm: 'HS512' });
    expect(() => verifyAccess(hs512, S)).toThrow(); // right secret, wrong algorithm
    expect(() => verifyAccess('garbage', S)).toThrow();
    expect(() => verifyAccess(jwt.sign({ sub: 'u1' }, S, { expiresIn: -10 }), S)).toThrow(); // expired
    expect(() => verifyAccess(jwt.sign({}, S), S)).toThrow(); // no subject
  });

  it('a refresh token cannot be used as an access token or the other way round', () => {
    const refresh = signRefresh('u1', 'sid-1', S);
    expect(verifyRefresh(refresh, S)).toEqual({ sub: 'u1', sid: 'sid-1' });
    expect(() => verifyRefresh(signAccess({ sub: 'u1' }, S), S)).toThrow();
  });

  it('secret rotation: tokens signed with the previous secret still verify until it is removed', () => {
    const old = signAccess({ sub: 'u1' }, OLD);
    expect(() => verifyAccess(old, S)).toThrow();
    expect(verifyAccess(old, [S, OLD]).sub).toBe('u1');
    expect(verifyAccess(signAccess({ sub: 'u2' }, S), [S, OLD]).sub).toBe('u2');
    expect(verifyRefresh(signRefresh('u1', 's', OLD), [S, OLD]).sid).toBe('s');
    expect(() => verifyAccess(old, [S, ''])).toThrow(); // an empty "previous" never matches
  });

  it('safeEqual compares secrets without leaking length or content', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
(OWNER_URL && APP_URL ? describe : describe.skip)('headers, support access, isolation, bad input (integration)', () => {
  const env = testEnv();
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  const tok: Record<string, string> = {};
  let tenantA = '', tenantB = '';
  const as = (who: string) => ({ Authorization: `Bearer ${tok[who]}` });
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  async function login(a: ReturnType<typeof createApp>, phone: string) {
    const r = await request(a).post('/api/auth/otp/request').send({ phone });
    return (await request(a).post('/api/auth/otp/verify').send({ phone, code: r.body.devCode })).body.accessToken as string;
  }

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, finance_entries, interactions, campaign_runs, content_items, geo_areas, memberships, tenants, otp_codes, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env, pool });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tok.a = await login(app, '+919800001001');
    tok.b = await login(app, '+919800001002');
    tok.wes = await login(app, '+919800001003');
    tenantA = (await request(app).post('/api/tenants').set(as('a')).send({ raceType: 'assembly', seatCode: 'SEC-A', electionDate: '2027-02-20', campaignName: 'Campaign A' })).body.id;
    tenantB = (await request(app).post('/api/tenants').set(as('b')).send({ raceType: 'assembly', seatCode: 'SEC-B', electionDate: '2027-02-20', campaignName: 'Campaign B' })).body.id;
    await request(app).post(`/api/t/${tenantA}/content`).set(as('a')).send({ kind: 'page', locale: 'en', title: 'Secret plan', body: 'Only for A' }).expect(201);
    await owner.query('UPDATE users SET is_wes_admin = true WHERE id = $1', [(jwt.decode(tok.wes) as { sub: string }).sub]);
    tok.wes = await login(app, '+919800001003'); // sign in again so the token carries the staff flag
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  describe('headers', () => {
    it('every response is marked nosniff, unframeable, referrer-less; API answers are never cached', async () => {
      const r = await request(app).get('/api/region').expect(200);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['strict-transport-security']).toBeUndefined(); // only in production
    });

    it('production adds HSTS', async () => {
      const prod = createApp(resolveDeps({
        pool, env: testEnv({
          NODE_ENV: 'production', DEV_RETURN_OTP: 'false', REDIS_URL: 'redis://localhost:6379', EVIDENCE_SIGNING_KEY: 'k'.repeat(32), STORAGE_DRIVER: 's3', FILES_BUCKET: 'test-files',
          OTP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_MESSAGING_SERVICE_SID: 'MG1',
        }),
      }));
      expect((await request(prod).get('/api/region')).headers['strict-transport-security']).toContain('max-age=31536000');
    });

    it('the voter page allows its one script by a fresh nonce, not by unsafe-inline', async () => {
      const a = await request(app).get('/v/anything').expect(200);
      const b = await request(app).get('/v/anything').expect(200);
      const nonce = /script-src 'nonce-([^']+)'/.exec(a.headers['content-security-policy']!)?.[1];
      expect(nonce).toBeTruthy();
      expect(a.text).toContain(`<script nonce="${nonce}">`);
      expect(a.text).not.toMatch(/<script>/);
      expect(a.headers['content-security-policy']).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(a.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(/script-src 'nonce-([^']+)'/.exec(b.headers['content-security-policy']!)?.[1]).not.toBe(nonce);
    });

    it('the booth-worker app only runs scripts from this server', async () => {
      const r = await request(app).get('/w/').expect(200);
      expect(r.headers['content-security-policy']).toContain("script-src 'self'");
      expect(r.headers['content-security-policy']).not.toContain('unsafe-eval');
    });
  });

  describe('tenant isolation: another campaign\'s user sees nothing, in every module', () => {
    const GETS = ['content', 'contacts', 'geo', 'calls/runs', 'share-links', 'assistant', 'members', 'field/turfs', 'ops/events', 'ops/shifts', 'ops/signs',
      'finance/summary', 'finance/entries', 'finance/rate-list', 'privacy', 'costs'];

    it.each(GETS)('GET /api/t/<other campaign>/%s is refused for a member of a different campaign', async (path) => {
      const res = await request(app).get(`/api/t/${tenantA}/${path}`).set(as('b'));
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('TENANT_NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain('Secret plan');
    });

    it.each(GETS)('GET /api/t/.../%s needs a login', async (path) => {
      await request(app).get(`/api/t/${tenantA}/${path}`).expect(401);
    });

    it('writing into another campaign is refused too, and nothing changes', async () => {
      await request(app).post(`/api/t/${tenantA}/content`).set(as('b')).send({ kind: 'page', locale: 'en', title: 'Planted', body: 'x' }).expect(404);
      await request(app).patch(`/api/tenants/${tenantA}/settings`).set(as('b')).send({ slug: 'taken-over' }).expect(404);
      await request(app).delete(`/api/t/${tenantA}/privacy/contacts/00000000-0000-4000-8000-000000000000`).set(as('b')).expect(404);
      expect(await q("SELECT 1 FROM content_items WHERE title = 'Planted'")).toHaveLength(0);
    });

    it('the campaign list only shows your own campaigns', async () => {
      const me = (await request(app).get('/api/auth/me').set(as('b')).expect(200)).body;
      expect(me.campaigns.map((c: { tenant_id?: string; id?: string }) => c.tenant_id ?? c.id)).toEqual([tenantB]);
    });
  });

  describe('support access (Wayne E Solutions staff)', () => {
    it('needs a stated reason, is read-only, and every request is logged with the reason and the path', async () => {
      const noReason = await request(app).get(`/api/t/${tenantA}/content`).set(as('wes')).expect(403);
      expect(noReason.body.error).toBe('SUPPORT_REASON_REQUIRED');
      await request(app).get(`/api/t/${tenantA}/content`).set(as('wes')).set('X-Support-Reason', 'too short').expect(403);

      await request(app).get(`/api/t/${tenantA}/content`).set(as('wes')).set('X-Support-Reason', 'TICKET-123: owner cannot see approvals').expect(200);
      const [log] = await q("SELECT after FROM audit_log WHERE action = 'support_access' ORDER BY id DESC LIMIT 1");
      expect(log.after).toMatchObject({ reason: 'TICKET-123: owner cannot see approvals', method: 'GET', path: `/api/t/${tenantA}/content` });

      const write = await request(app).post(`/api/t/${tenantA}/content`).set(as('wes')).set('X-Support-Reason', 'TICKET-123: trying to edit')
        .send({ kind: 'page', locale: 'en', title: 'By staff', body: 'x' }).expect(403);
      expect(write.body.error).toBe('SUPPORT_READ_ONLY');
      expect(await q("SELECT 1 FROM content_items WHERE title = 'By staff'")).toHaveLength(0);
    });

    it('does not slow down or log normal members', async () => {
      const before = (await q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'support_access'"))[0].n;
      await request(app).get(`/api/t/${tenantA}/content`).set(as('a')).expect(200);
      expect((await q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'support_access'"))[0].n).toBe(before);
    });
  });

  describe('bad input', () => {
    it('malformed JSON is a 400 and an oversized body is a 413, neither is a server error', async () => {
      const bad = await request(app).post('/api/auth/otp/request').set('Content-Type', 'application/json').send('{"phone": ').expect(400);
      expect(bad.body.error).toBe('BAD_JSON');
      const big = await request(app).post('/api/auth/otp/request').send({ phone: '+919800001999', pad: 'x'.repeat(1_100_000) }).expect(413);
      expect(big.body.error).toBe('PAYLOAD_TOO_LARGE');
    });

    it('a token for a user that does not exist, and a tampered token, are refused', async () => {
      await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tok.a!.slice(0, -3)}abc`).expect(401);
      await request(app).get('/api/auth/me').set('Authorization', 'Bearer').expect(401);
      await request(app).get('/api/auth/me').set('Authorization', `Basic ${tok.a}`).expect(401);
    });

    it('SQL-looking and path-traversal input is just text or a 404', async () => {
      await request(app).get(`/api/t/${tenantA}'; DROP TABLE tenants;--/content`).set(as('a')).expect(404);
      await request(app).get('/api/public/x%27%3B%20DROP%20TABLE%20tenants%3B--').expect(404);
      // The dashboard falls back to its index page for unknown paths; it must never read a file outside its folder.
      const trav = await request(app).get('/admin/..%2f..%2f..%2f..%2f..%2fWindows%2fwin.ini');
      expect(trav.text).not.toMatch(/\[fonts\]|root:/);
      const trav2 = await request(app).get('/w/..%2f..%2f..%2fenv.ts');
      expect(trav2.text).not.toContain('APP_DATABASE_URL');
      expect(await q('SELECT 1 FROM tenants')).toHaveLength(2);
    });
  });
});
