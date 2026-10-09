/** P0-4: India DLT template registration lifecycle and DLT-compliant reminders. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { testEnv } from './env.js';
import { ensureUser, tokenFor } from './auth-helper.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

const TEMPLATE = '{#var#}: reminder, {#var#}, {#var#}. Reply STOP to opt out.';
const TEMPLATE_ID = '1007123456789012345';

run('India DLT templates and reminders (integration)', () => {
  const env = testEnv();
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  let appCa: ReturnType<typeof createApp>;
  let token = '', tin = '', tca = '', tokenCa = '';
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  const sent: { url: string; body: any; headers: Record<string, string> }[] = [];
  let providerReply: object = { type: 'success', message: 'req-1' };

  async function login(phone: string) {
    const r = await ensureUser(app, phone);
    return (await tokenFor(app, phone)).body.accessToken as string;
  }
  const tpl = (over: object = {}) => request(app).post(`/api/t/${tin}/content`).set(auth()).send({ kind: 'sms_template', locale: 'en', title: 'Shift reminder', body: TEMPLATE, templateKey: 'shift_reminder', ...over });
  const dlt = (id: string, body: object) => request(app).post(`/api/t/${tin}/content/${id}/dlt`).set(auth()).send(body);

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, shift_assignments, shifts, interactions, consents, contacts, content_items, geo_areas, memberships, tenants, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    // A live (non-demo) India campaign gets the real DLT adapter; its HTTP calls are captured here instead of leaving the machine.
    app = createApp({ env, pool, channels: { dltSms: { authKey: 'K', senderId: 'WAYNES' } } });
    appCa = createApp({ env: testEnv({ DEPLOY_REGION: 'CA' }), pool }); // region is fixed per deployment, so Canada needs its own app
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', async (url: string, init: { body: string; headers: Record<string, string> }) => {
      sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { ok: true, json: async () => providerReply };
    });
    token = await login('+919800000801');
    tin = (await request(app).post('/api/tenants').set(auth()).send({ raceType: 'assembly', seatCode: 'DL-1', electionDate: '2027-02-20', campaignName: 'DLT Test' })).body.id;
    const rc = await ensureUser(appCa, '+12045550801');
    tokenCa = (await tokenFor(appCa, '+12045550801')).body.accessToken;
    tca = (await request(appCa).post('/api/tenants').set({ Authorization: `Bearer ${tokenCa}` }).send({ raceType: 'ward', seatCode: 'DL-CA', electionDate: '2026-10-26', campaignName: 'CA Test' })).body.id;
  });
  afterAll(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  describe('template lifecycle', () => {
    let id = '';
    it('rejects template text the DLT portal would refuse, accepts valid text', async () => {
      const bad = await tpl({ body: 'Hi {#var#}{#var#}' }).expect(422);
      expect(bad.body.error).toBe('DLT_TEMPLATE_INVALID');
      await tpl({ body: 'Hi {#name#}' }).expect(422);
      const ok = await tpl().expect(201);
      id = ok.body.id;
      expect(ok.body).toMatchObject({ dltStatus: 'not_registered', templateKey: 'shift_reminder' });
      await tpl({ title: 'Another reminder' }).expect(500); // one template per key per campaign (database rule)
      await tpl({ kind: 'page', templateKey: 'shift_reminder' }).expect(400);
    });

    it('shows the text to paste into the DLT portal, with checks and next steps', async () => {
      const r = (await request(app).get(`/api/t/${tin}/content/${id}/dlt`).set(auth()).expect(200)).body;
      expect(r).toMatchObject({ status: 'not_registered', portalText: TEMPLATE, ok: true, varCount: 3 });
      expect(r.steps).toHaveLength(3);
    });

    it('registration goes submitted -> registered, in that order, with a valid id and 6-letter header', async () => {
      expect((await dlt(id, { action: 'registered', templateId: TEMPLATE_ID, header: 'WAYNES' }).expect(409)).body.error).toBe('MARK_SUBMITTED_FIRST');
      await dlt(id, { action: 'submitted' }).expect(200);
      await dlt(id, { action: 'registered', templateId: 'abc', header: 'WAYNES' }).expect(400);
      await dlt(id, { action: 'registered', templateId: TEMPLATE_ID, header: 'WAY' }).expect(400);
      const ok = (await dlt(id, { action: 'registered', templateId: TEMPLATE_ID, header: 'waynes' }).expect(200)).body;
      expect(ok).toMatchObject({ dltStatus: 'registered', dltTemplateId: TEMPLATE_ID, dltHeader: 'WAYNES' });
      const actions = (await q("SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'dlt_%' ORDER BY id", [id])).map((a) => a.action);
      expect(actions).toEqual(['dlt_submitted', 'dlt_registered']);
    });

    it('a rejection needs a reason and clears the template id', async () => {
      const other = (await tpl({ title: 'Other', templateKey: undefined, body: 'Hello {#var#}. Reply STOP to opt out.' }).expect(201)).body.id;
      await dlt(other, { action: 'submitted' }).expect(200);
      await dlt(other, { action: 'rejected' }).expect(400);
      const r = (await dlt(other, { action: 'rejected', reason: 'Header not approved for this category' }).expect(200)).body;
      expect(r).toMatchObject({ dltStatus: 'rejected', dltTemplateId: null, dltRejectionReason: 'Header not approved for this category' });
    });

    it('changing the text sends it back to "not registered": the registration covered the old text only', async () => {
      const edited = (await request(app).patch(`/api/t/${tin}/content/${id}`).set(auth()).send({ body: '{#var#}: reminder for {#var#} at {#var#}. Reply STOP to opt out.' }).expect(200)).body;
      expect(edited).toMatchObject({ dltStatus: 'not_registered', dltTemplateId: null, dltHeader: null, status: 'draft' });
      await request(app).patch(`/api/t/${tin}/content/${id}`).set(auth()).send({ body: 'bad {#var#}{#var#}' }).expect(422);
      // Title-only edit keeps the registration.
      await dlt(id, { action: 'submitted' }).expect(200);
      await dlt(id, { action: 'registered', templateId: TEMPLATE_ID, header: 'WAYNES' }).expect(200);
      const same = (await request(app).patch(`/api/t/${tin}/content/${id}`).set(auth()).send({ title: 'Shift reminder v2' }).expect(200)).body;
      expect(same.dltStatus).toBe('registered');
    });

    it('is India only', async () => {
      const res = await request(appCa).get(`/api/t/${tca}/content/${id}/dlt`).set({ Authorization: `Bearer ${tokenCa}` }).expect(409);
      expect(res.body.error).toBe('DLT_INDIA_ONLY');
    });
  });

  describe('shift reminders under DLT', () => {
    let shift = '';
    const remind = () => request(app).post(`/api/t/${tin}/ops/shifts/${shift}/remind`).set(auth());

    beforeAll(async () => {
      // Back to a clean registration state for these tests: a second item is not allowed for the same key, so reuse the first.
      await owner.query("UPDATE content_items SET dlt_status = 'not_registered', dlt_template_id = NULL, status = 'draft', body = $2 WHERE tenant_id = $1 AND template_key = 'shift_reminder'", [tin, TEMPLATE]);
      shift = (await q("INSERT INTO shifts (tenant_id, title, starts_at) VALUES ($1, 'Booth duty', $2) RETURNING id", [tin, new Date('2027-02-12T08:00:00+05:30')]))[0].id;
      for (const [i, withConsent] of [[1, true], [2, true], [3, false]] as const) {
        const c = (await request(app).post(`/api/t/${tin}/contacts`).set(auth()).send({
          phone: `+9198111000${i}0`, name: `Vol ${i}`, source: 'form',
          consents: withConsent ? [{ purpose: 'reminder', channel: 'sms', textVersion: 'v1', locale: 'en', capturedVia: 'form' }] : [],
        }).expect(201)).body.id;
        await q('INSERT INTO shift_assignments (tenant_id, shift_id, contact_id) VALUES ($1,$2,$3)', [tin, shift, c]);
      }
    });

    it('is refused until a certified, DLT-registered "shift_reminder" template exists, and says what to register', async () => {
      const r = await remind().expect(422);
      expect(r.body.error).toBe('DLT_TEMPLATE_REQUIRED');
      expect(r.body.message).toContain(TEMPLATE);
      expect(sent).toHaveLength(0);
    });

    it('sends the registered template with the slots filled, under the registered template id, to consenting volunteers only', async () => {
      const id = (await q("SELECT id FROM content_items WHERE tenant_id = $1 AND template_key = 'shift_reminder'", [tin]))[0].id;
      await dlt(id, { action: 'submitted' }).expect(200);
      await dlt(id, { action: 'registered', templateId: TEMPLATE_ID, header: 'WAYNES' }).expect(200);
      await request(app).post(`/api/t/${tin}/content/${id}/approve`).set(auth()).send({ certificateNo: 'MCMC/DLT/1' }).expect(200);

      const r = (await remind().expect(200)).body;
      expect(r).toMatchObject({ sent: 2, skipped: 1, failed: 0, simulated: false });
      expect(sent).toHaveLength(2);
      for (const call of sent) {
        expect(call.url).toContain('/api/v2/sendsms');
        expect(call.headers.authkey).toBe('K');
        expect(call.body.DLT_TE_ID).toBe(TEMPLATE_ID);
        expect(call.body.sender).toBe('WAYNES');
        expect(call.body.sms[0].message).toMatch(/^DLT Test: reminder, Booth duty, .+\. Reply STOP to opt out\.$/);
      }
      // Sent once: a second run finds nobody left.
      expect((await remind().expect(200)).body).toMatchObject({ sent: 0 });
      expect(sent).toHaveLength(2);
    });

    it('a provider failure is counted, not marked as reminded, and can be retried', async () => {
      await q("UPDATE shift_assignments SET reminded_at = NULL WHERE shift_id = $1", [shift]);
      sent.length = 0;
      providerReply = { type: 'error', message: 'rejected' };
      const r = (await remind().expect(200)).body;
      expect(r).toMatchObject({ sent: 0, failed: 2 });
      expect(await q('SELECT 1 FROM shift_assignments WHERE shift_id = $1 AND reminded_at IS NOT NULL', [shift])).toHaveLength(0);
      providerReply = { type: 'success', message: 'req-2' };
      expect((await remind().expect(200)).body).toMatchObject({ sent: 2, failed: 0 });
    });

    it('a variable over 30 characters stops the whole send before anything leaves', async () => {
      await q("UPDATE shift_assignments SET reminded_at = NULL WHERE shift_id = $1", [shift]);
      await q("UPDATE tenants SET campaign_name = 'A very long campaign name that DLT will refuse' WHERE id = $1", [tin]);
      sent.length = 0;
      const r = await remind().expect(422);
      expect(r.body.error).toBe('DLT_VARIABLE_PROBLEM');
      expect(sent).toHaveLength(0);
    });
  });
});
