/** Phase 3, Tool 8: how requests arrive: public form, inbound texts, voice helpline; and DLT-registered texts back in India. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { createApp, resolveDeps } from '../src/app.js';
import { twilioSignature } from '../src/modules/service/inbound.js';
import { testEnv } from './env.js';

const SECRET = 'vapi-hook-secret-0123456789';
const TWILIO = 'twilio-auth-token-0123456789';
const INBOUND = 'sms-inbound-secret-0123456789';

describe('Twilio signature', () => {
  it('is the documented HMAC-SHA1 of the URL plus the sorted form fields', () => {
    // The worked example from Twilio's own documentation for request validation.
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
    expect(twilioSignature(url, params, '12345')).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });
});

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
(OWNER_URL && APP_URL ? describe : describe.skip)('service intake (integration)', () => {
  const env = testEnv({ VAPI_WEBHOOK_SECRET: SECRET, TWILIO_AUTH_TOKEN: TWILIO, SMS_INBOUND_SECRET: INBOUND, PUBLIC_BASE_URL: 'http://t' });
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  const tok: Record<string, string> = {};
  let tenant = '', areaMT = '', areaDugri = '';
  const as = (who: string) => ({ Authorization: `Bearer ${tok[who]}` });
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  async function login(a: ReturnType<typeof createApp>, phone: string) {
    const r = await request(a).post('/api/auth/otp/request').send({ phone });
    return (await request(a).post('/api/auth/otp/verify').send({ phone, code: r.body.devCode })).body.accessToken as string;
  }
  const waitFor = async (check: () => Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  const twilio = (params: Record<string, string>, sign = true) => {
    const req = request(app).post('/webhooks/sms/twilio').type('form');
    if (sign) req.set('X-Twilio-Signature', twilioSignature('http://t/webhooks/sms/twilio', params, TWILIO));
    return req.send(params);
  };
  const SMS_NUMBER = '+19998887777';
  // Each public-form request uses a fresh app, so the per-address rate limit (tested on its own below) does not interfere.
  const fresh = () => createApp(resolveDeps({ env, pool }));

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE tenants, users, otp_codes CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp(resolveDeps({ env, pool }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tok.owner = await login(app, '+919800003001');
    tenant = (await request(app).post('/api/tenants').set(as('owner')).send({ kind: 'office', raceType: 'assembly', seatCode: 'IN-1', electionDate: '2027-02-20', campaignName: 'Office of Test MLA' })).body.id;
    await owner.query('UPDATE tenants SET is_demo = true WHERE id = $1', [tenant]);
    await request(app).patch(`/api/tenants/${tenant}/settings`).set(as('owner')).send({ slug: 'intake-test', candidateName: 'Test MLA' }).expect(200);
    const root = (await request(app).post(`/api/t/${tenant}/geo`).set(as('owner')).send({ level: 'constituency', nameEn: 'Test Constituency' })).body.id;
    areaMT = (await request(app).post(`/api/t/${tenant}/geo`).set(as('owner')).send({ parentId: root, level: 'locality', nameEn: 'Model Town', code: 'MT12' })).body.id;
    areaDugri = (await request(app).post(`/api/t/${tenant}/geo`).set(as('owner')).send({ parentId: root, level: 'locality', nameEn: 'Dugri', code: 'DG3', namePa: 'ਦੁੱਗਰੀ' })).body.id;
    // Platform staff register the numbers people text and call.
    await owner.query('UPDATE users SET is_wes_admin = true');
    tok.wes = await login(app, '+919800003001');
    tok.plain = await login(app, '+919800003002'); // an ordinary user, created after the staff flag was set
    await request(app).post('/api/admin/service-numbers').set(as('wes')).send({ tenantId: tenant, kind: 'sms', identifier: SMS_NUMBER, provider: 'twilio' }).expect(201);
    await request(app).post('/api/admin/service-numbers').set(as('wes')).send({ tenantId: tenant, kind: 'voice', identifier: 'vapi-pn-1', provider: 'vapi' }).expect(201);
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  describe('numbers', () => {
    it('a number belongs to one office; only platform staff register it; the owner can see theirs', async () => {
      const dup = await request(app).post('/api/admin/service-numbers').set(as('wes')).send({ tenantId: tenant, kind: 'sms', identifier: SMS_NUMBER, provider: 'twilio' }).expect(409);
      expect(dup.body.error).toBe('NUMBER_ALREADY_REGISTERED');
      await request(app).post('/api/admin/service-numbers').set(as('plain')).send({ tenantId: tenant, kind: 'sms', identifier: '+1999', provider: 'x' }).expect(403);
      const mine = (await request(app).get(`/api/t/${tenant}/service/numbers`).set(as('owner')).expect(200)).body;
      expect(mine.map((n: { identifier: string }) => n.identifier).sort()).toEqual([SMS_NUMBER, 'vapi-pn-1']);
    });
  });

  describe('public form', () => {
    it('gives the form its office, categories in three languages, areas and consent wording', async () => {
      const r = (await request(fresh()).get('/api/public/intake-test/service').expect(200)).body;
      expect(r.office).toBe('Test MLA');
      expect(r.categories.find((c: { key: string }) => c.key === 'roads').pa).toBe('ਸੜਕਾਂ');
      expect(r.areas.map((a: { nameEn: string }) => a.nameEn)).toEqual(['Dugri', 'Model Town', 'Test Constituency']);
      expect(r.consentText.pa).toContain('STOP');
      await request(fresh()).get('/api/public/no-such-office/service').expect(404);
    });

    it('takes a request, matches the area by name in any language, guesses the category, and tells the person the number in their language', async () => {
      const r = await request(fresh()).post('/api/public/intake-test/tickets').send({ title: 'ਸੜਕ ਵਿੱਚ ਵੱਡਾ ਟੋਇਆ', areaText: 'ਦੁੱਗਰੀ', name: 'Balwinder', language: 'pa' }).expect(201);
      expect(r.body.ref).toBe('T-0001');
      expect(r.body.message).toContain('T-0001');
      expect(r.body.message).toContain('ਦਰਜ');
      expect((await q('SELECT category, geo_area_id, channel, language FROM tickets WHERE ref = $1', ['T-0001']))[0]).toMatchObject({ category: 'roads', geo_area_id: areaDugri, channel: 'web', language: 'pa' });
    });

    it('a request with a phone number and consent is acknowledged by text, and its progress can be checked with the last four digits', async () => {
      const r = await request(fresh()).post('/api/public/intake-test/tickets').send({ title: 'Street light is out', phone: '+919811300010', smsConsent: true, language: 'en' }).expect(201);
      expect(await waitFor(async () => (await q('SELECT acknowledged_at FROM tickets WHERE ref = $1', [r.body.ref]))[0].acknowledged_at !== null)).toBe(true);
      const status = (await request(fresh()).get(`/api/public/intake-test/tickets/${r.body.ref}?last4=0010`).expect(200)).body;
      expect(status).toMatchObject({ ref: r.body.ref, status: 'new', statusText: 'received' });
      expect(JSON.stringify(status)).not.toContain('9811300010');
      await request(fresh()).get(`/api/public/intake-test/tickets/${r.body.ref}?last4=1111`).expect(404);
      await request(fresh()).get('/api/public/intake-test/tickets/T-0001?last4=0000').expect(404); // that one had no phone: nothing to check against
      await request(fresh()).get('/api/public/intake-test/tickets/not-a-ref?last4=0010').expect(404);
    });

    it('bots that fill the hidden field get a fake answer and no ticket; bad input is refused', async () => {
      const before = (await q('SELECT count(*)::int AS n FROM tickets'))[0].n;
      const bot = await request(fresh()).post('/api/public/intake-test/tickets').send({ title: 'Buy cheap watches', website: 'http://spam.example' }).expect(201);
      expect(bot.body.ref).toBe('T-0000');
      expect((await q('SELECT count(*)::int AS n FROM tickets'))[0].n).toBe(before);
      await request(fresh()).post('/api/public/intake-test/tickets').send({ title: 'ab' }).expect(400);
      await request(fresh()).post('/api/public/intake-test/tickets').send({ title: 'Valid title', smsConsent: true }).expect(422);
      await request(fresh()).post('/api/public/intake-test/tickets').send({ title: 'Valid title', caste: 'x' }).expect(400);
    });

    it('one number cannot flood the office: five a day', async () => {
      const first = (await request(fresh()).post('/api/public/intake-test/tickets').send({ title: 'Flood test one', phone: '+919811300099' }).expect(201)).body.ref;
      const cid = (await q('SELECT contact_id FROM tickets WHERE ref = $1', [first]))[0].contact_id;
      for (let i = 0; i < 4; i++) await owner.query("INSERT INTO tickets (tenant_id, seq, ref, channel, category, title, contact_id) VALUES ($1, $2, $3, 'web', 'other', 'filler', $4)", [tenant, 500 + i, `T-${500 + i}`, cid]);
      const blocked = await request(fresh()).post('/api/public/intake-test/tickets').send({ title: 'Flood test six', phone: '+919811300099' }).expect(429);
      expect(blocked.body.error).toBe('TOO_MANY_REQUESTS');
    });

    it('the form is rate limited per address', async () => {
      const fresh = createApp(resolveDeps({ env, pool })); // its own counters
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await request(fresh).post('/api/public/intake-test/tickets').send({ title: `Rate test ${i}` })).status);
      expect(codes).toEqual([201, 201, 201, 201, 201, 429, 429]);
    });
  });

  describe('inbound texts (Twilio)', () => {
    const from = '+919811300001';
    it('rejects anything not signed by Twilio', async () => {
      const params = { From: from, To: SMS_NUMBER, Body: 'ISSUE MT12 no water', MessageSid: 'SMbad' };
      await twilio(params, false).expect(403);
      await request(app).post('/webhooks/sms/twilio').type('form').set('X-Twilio-Signature', 'AAAA').send(params).expect(403);
      expect(await q("SELECT 1 FROM tickets WHERE source_ref = 'SMbad'")).toHaveLength(0);
    });

    it('a text becomes a ticket: category from the words, area from a code, acknowledged in the reply itself', async () => {
      const r = await twilio({ From: from, To: SMS_NUMBER, Body: 'ISSUE MT12 gali me pani nahi aa raha 3 din se', MessageSid: 'SM001' }).expect(200);
      expect(r.headers['content-type']).toContain('text/xml');
      const ref = /T-\d{4}/.exec(r.text)![0];
      expect(r.text).toContain(`Request ${ref} received`);
      const [t] = await q('SELECT category, geo_area_id, channel, acknowledged_at, title FROM tickets WHERE source_ref = $1', ['SM001']);
      expect(t).toMatchObject({ category: 'water', geo_area_id: areaMT, channel: 'sms' });
      expect(t.acknowledged_at).toBeTruthy();
      expect(t.title).not.toMatch(/^ISSUE/);
      expect(await q("SELECT 1 FROM consents WHERE evidence_ref = 'SM001' AND purpose = 'service'")).toHaveLength(1);
      // The acknowledgement is the reply itself, so no separate text went out to this person.
      expect(await q('SELECT 1 FROM interactions WHERE contact_id = (SELECT contact_id FROM tickets WHERE source_ref = $1) AND channel = $2', ['SM001', 'sms'])).toHaveLength(0);
    });

    it('the same message delivered twice makes one ticket and the same answer', async () => {
      const params = { From: from, To: SMS_NUMBER, Body: 'ISSUE MT12 gali me pani nahi aa raha 3 din se', MessageSid: 'SM001' };
      const again = await twilio(params).expect(200);
      expect(await q("SELECT 1 FROM tickets WHERE source_ref = 'SM001'")).toHaveLength(1);
      expect(again.text).toMatch(/T-\d{4}/);
    });

    it('short messages get help, STATUS answers for the same number only, texts to unknown numbers are ignored', async () => {
      const help = await twilio({ From: from, To: SMS_NUMBER, Body: 'hi', MessageSid: 'SM002' }).expect(200);
      expect(help.text).toContain('ISSUE &lt;area code&gt;'); // XML-escaped for Twilio
      expect(await q("SELECT 1 FROM tickets WHERE source_ref = 'SM002'")).toHaveLength(0);
      const ref = (await q("SELECT ref FROM tickets WHERE source_ref = 'SM001'"))[0].ref;
      expect((await twilio({ From: from, To: SMS_NUMBER, Body: `STATUS ${ref}`, MessageSid: 'SM003' }).expect(200)).text).toContain(`Request ${ref} is `);
      expect((await twilio({ From: '+919811300555', To: SMS_NUMBER, Body: `status ${ref}`, MessageSid: 'SM004' }).expect(200)).text).toContain('could not find');
      const stranger = await twilio({ From: from, To: '+10000000000', Body: 'ISSUE MT12 no water here', MessageSid: 'SM005' }).expect(200);
      expect(stranger.text).toContain('<Response/>');
      expect(await q("SELECT 1 FROM tickets WHERE source_ref = 'SM005'")).toHaveLength(0);
    });

    it('STOP opts the person out and puts the number on the do-not-contact list; later texts are taken but never answered', async () => {
      const stop = await twilio({ From: from, To: SMS_NUMBER, Body: 'STOP', MessageSid: 'SM006' }).expect(200);
      expect(stop.text).toContain('<Response/>');
      expect((await q('SELECT c.opted_out FROM contacts c JOIN tickets t ON t.contact_id = c.id WHERE t.source_ref = $1', ['SM001']))[0].opted_out).toBe(true);
      expect(await q('SELECT 1 FROM suppressions')).not.toHaveLength(0);
      const later = await twilio({ From: from, To: SMS_NUMBER, Body: 'ISSUE DG3 school roof is leaking badly', MessageSid: 'SM007' }).expect(200);
      expect(later.text).toContain('<Response/>');
      const [t] = await q("SELECT contact_id, category FROM tickets WHERE source_ref = 'SM007'");
      expect(t).toMatchObject({ contact_id: null, category: 'education' });
      // Even a number we never held a contact for can say STOP.
      await twilio({ From: '+919811300777', To: SMS_NUMBER, Body: 'stop', MessageSid: 'SM008' }).expect(200);
      expect(await q('SELECT 1 FROM suppressions')).toHaveLength(2);
    });
  });

  describe('inbound texts (other providers, JSON)', () => {
    it('needs the shared secret, then makes a ticket and queues the acknowledgement as a text', async () => {
      const body = { from: '+919811300020', to: SMS_NUMBER, text: 'PROBLEM DG3 transformer sparking near the school', id: 'IN-1' };
      await request(app).post('/webhooks/sms/inbound').send(body).expect(401);
      await request(app).post('/webhooks/sms/inbound').set('x-webhook-secret', 'wrong-secret-wrong-secret').send(body).expect(401);
      const r = await request(app).post('/webhooks/sms/inbound').set('x-webhook-secret', INBOUND).send(body).expect(200);
      expect(r.body.reply).toMatch(/Request T-\d{4} received/);
      expect((await q("SELECT category, geo_area_id FROM tickets WHERE source_ref = 'IN-1'"))[0]).toMatchObject({ category: 'electricity', geo_area_id: areaDugri });
      expect(await waitFor(async () => (await q("SELECT acknowledged_at FROM tickets WHERE source_ref = 'IN-1'"))[0].acknowledged_at !== null)).toBe(true);
      await request(app).post('/webhooks/sms/inbound').set('x-webhook-secret', INBOUND).send({ from: '+919811300020' }).expect(400);
    });
  });

  describe('voice helpline (Vapi inbound calls)', () => {
    const report = (message: object) => request(app).post('/webhooks/vapi').set('x-vapi-secret', SECRET).send({ message: { type: 'end-of-call-report', ...message } });
    const inbound = (over: Record<string, unknown> = {}, sd: Record<string, unknown> = {}) => ({
      call: { id: 'call-in-1', type: 'inboundPhoneCall', phoneNumberId: 'vapi-pn-1', customer: { number: '+919811300002' }, ...over },
      cost: 0.2, durationSeconds: 95, transcript: 'SECRET TRANSCRIPT the caller said their address is 12 Main Street',
      analysis: { structuredData: { category: 'roads', issue: 'There is a big pothole near the temple', areaText: 'Dugri', name: 'Balwinder', language: 'pa', smsConsent: true, ...sd } },
    });

    it('a finished call becomes a ticket with the issue, area and language the assistant collected; the transcript is not kept', async () => {
      await report(inbound()).expect(200);
      const [t] = await q("SELECT category, geo_area_id, channel, language, requester_name, description, title, contact_id FROM tickets WHERE source_ref = 'call-in-1'");
      expect(t).toMatchObject({ category: 'roads', geo_area_id: areaDugri, channel: 'voice', language: 'pa', requester_name: 'Balwinder', title: 'There is a big pothole near the temple' });
      expect(t.contact_id).toBeTruthy();
      expect(JSON.stringify(await q('SELECT * FROM tickets'))).not.toContain('SECRET TRANSCRIPT');
      expect(JSON.stringify(await q('SELECT * FROM ticket_events'))).not.toContain('SECRET TRANSCRIPT');
      expect(await q("SELECT 1 FROM consents WHERE captured_via = 'ivr' AND evidence_ref = 'call-in-1' AND purpose = 'service'")).toHaveLength(1);
      expect(await waitFor(async () => (await q("SELECT acknowledged_at FROM tickets WHERE source_ref = 'call-in-1'"))[0].acknowledged_at !== null)).toBe(true);
    });

    it('the call itself is recorded with its cost, so it shows in the provider cost dashboard', async () => {
      const [i] = await q("SELECT direction, channel, provider, status, duration_sec, cost_usd_micros FROM interactions WHERE provider_ref = 'call-in-1'");
      expect(i).toMatchObject({ direction: 'inbound', channel: 'voice', provider: 'vapi', status: 'completed', duration_sec: 95, cost_usd_micros: '200000' });
    });

    it('the same call reported twice changes nothing', async () => {
      await report(inbound()).expect(200);
      expect(await q("SELECT 1 FROM tickets WHERE source_ref = 'call-in-1'")).toHaveLength(1);
      expect(await q("SELECT 1 FROM interactions WHERE provider_ref = 'call-in-1'")).toHaveLength(1);
    });

    it('outbound campaign calls on the same number, unknown numbers and calls with nothing said do not make tickets', async () => {
      const before = (await q('SELECT count(*)::int AS n FROM tickets'))[0].n;
      await report(inbound({ id: 'call-out-1', type: 'outboundPhoneCall' })).expect(200);
      await report(inbound({ id: 'call-in-2', phoneNumberId: 'not-registered' })).expect(200);
      await report(inbound({ id: 'call-in-3' }, { issue: '' })).expect(200);
      await report(inbound({ id: 'call-in-4' }, { issue: 'ok' })).expect(200); // too short to be a request
      expect((await q('SELECT count(*)::int AS n FROM tickets'))[0].n).toBe(before);
    });

    it('without consent to texts the ticket is taken but nobody is texted; an unknown category is guessed from the words', async () => {
      await report(inbound({ id: 'call-in-5', customer: { number: '+919811300003' } }, { smsConsent: false, category: 'unknown', issue: 'The hospital has no doctor in the evening' })).expect(200);
      const [t] = await q("SELECT category, contact_id FROM tickets WHERE source_ref = 'call-in-5'");
      expect(t).toMatchObject({ category: 'health' });
      expect(t.contact_id).toBeTruthy();
      await new Promise((r) => setTimeout(r, 300));
      expect((await q("SELECT acknowledged_at FROM tickets WHERE source_ref = 'call-in-5'"))[0].acknowledged_at).toBeNull();
    });

    it('the webhook still needs the secret', async () => {
      await request(app).post('/webhooks/vapi').send({ message: inbound() }).expect(401);
    });
  });

  describe('India: texts back to residents use registered DLT templates', () => {
    let live = '', liveToken = '';
    const calls: { url: string; body: any }[] = [];
    let liveApp: ReturnType<typeof createApp>;
    const tpl = async (key: string, body: string, id: string) => {
      const c = (await request(liveApp).post(`/api/t/${live}/content`).set({ Authorization: `Bearer ${liveToken}` }).send({ kind: 'sms_template', locale: 'en', title: key, body, templateKey: key }).expect(201)).body.id;
      const hdr = { Authorization: `Bearer ${liveToken}` };
      await request(liveApp).post(`/api/t/${live}/content/${c}/dlt`).set(hdr).send({ action: 'submitted' }).expect(200);
      await request(liveApp).post(`/api/t/${live}/content/${c}/dlt`).set(hdr).send({ action: 'registered', templateId: id, header: 'WAYNES' }).expect(200);
      await request(liveApp).post(`/api/t/${live}/content/${c}/approve`).set(hdr).send({ certificateNo: `MCMC/${key}` }).expect(200);
    };

    beforeAll(async () => {
      liveApp = createApp(resolveDeps({ env, pool, channels: { dltSms: { authKey: 'K', senderId: 'WAYNES' } } }));
      vi.stubGlobal('fetch', async (url: string, init: { body: string }) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ type: 'success', message: 'req-1' }) }; });
      liveToken = await login(liveApp, '+919800003050');
      live = (await request(liveApp).post('/api/tenants').set({ Authorization: `Bearer ${liveToken}` }).send({ kind: 'office', raceType: 'assembly', seatCode: 'IN-LIVE', electionDate: '2027-02-20', campaignName: 'Live Office' })).body.id; // not a demo: real texts
    });
    afterAll(() => { vi.unstubAllGlobals(); });

    const open = (title: string) => request(liveApp).post(`/api/t/${live}/service/tickets`).set({ Authorization: `Bearer ${liveToken}` }).send({ title, name: 'Resident', phone: '+919811300060', smsConsent: true });

    it('without a registered template nothing is sent, and the ticket timeline says what to register', async () => {
      const r = await open('No water in our lane').expect(201);
      expect(await waitFor(async () => (await q("SELECT 1 FROM ticket_events WHERE ticket_id = $1 AND kind = 'sms_failed'", [r.body.id])).length > 0)).toBe(true);
      const [e] = await q("SELECT body FROM ticket_events WHERE ticket_id = $1 AND kind = 'sms_failed'", [r.body.id]);
      expect(e.body).toContain('ticket_ack');
      expect(e.body).toContain('{#var#}: request {#var#} received');
      expect(calls).toHaveLength(0);
    });

    it('with registered templates the acknowledgement and the status update are the template with the slots filled', async () => {
      await tpl('ticket_ack', '{#var#}: request {#var#} received. We will update you. Reply STOP to opt out.', '1007000000000000001');
      await tpl('ticket_status', '{#var#}: request {#var#} is now {#var#}. Reply STOP to opt out.', '1007000000000000002');
      const r = await open('Drain overflowing').expect(201);
      expect(await waitFor(async () => calls.length >= 1)).toBe(true);
      expect(calls[0]!.body).toMatchObject({ sender: 'WAYNES', DLT_TE_ID: '1007000000000000001' });
      expect(calls[0]!.body.sms[0]).toMatchObject({ message: `Live Office: request ${r.body.ref} received. We will update you. Reply STOP to opt out.`, to: ['9811300060'] });

      await request(liveApp).patch(`/api/t/${live}/service/tickets/${r.body.id}`).set({ Authorization: `Bearer ${liveToken}` }).send({ status: 'resolved', resolutionNote: 'Drain cleaned' }).expect(200);
      expect(await waitFor(async () => calls.length >= 2)).toBe(true);
      expect(calls[1]!.body).toMatchObject({ DLT_TE_ID: '1007000000000000002' });
      expect(calls[1]!.body.sms[0].message).toBe(`Live Office: request ${r.body.ref} is now resolved. Reply STOP to opt out.`);
    });
  });
});

// keep the jwt import used when this file is reduced
void jwt;
