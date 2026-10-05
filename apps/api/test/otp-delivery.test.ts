import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { TwilioSms } from '@cs/channels';
import { createApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/env.js';
import { TwilioOtp, otpSenderFor, type OtpSender } from '../src/lib/otp-sender.js';

const key = () => randomBytes(32).toString('base64');
const base = { APP_DATABASE_URL: 'postgres://u:p@localhost:5432/x', JWT_SECRET: 'x'.repeat(20), JWT_REFRESH_SECRET: 'y'.repeat(20), DEPLOY_REGION: 'CA', PHONE_ENC_KEY: key(), PHONE_HASH_KEY: key() };

describe('OTP env rules', () => {
  it('refuses console OTP in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', OTP_PROVIDER: 'console' })).toThrow(/development only/);
  });
  it('twilio provider needs its keys', () => {
    expect(() => loadEnv({ ...base, OTP_PROVIDER: 'twilio' })).toThrow(/TWILIO_ACCOUNT_SID/);
    const env = loadEnv({ ...base, OTP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_MESSAGING_SERVICE_SID: 'MG1' });
    expect(otpSenderFor(env, 5).name).toBe('twilio');
  });
  const dlt = { ...base, DEPLOY_REGION: 'IN', OTP_PROVIDER: 'dlt', DLT_AUTH_KEY: 'K', DLT_SENDER_ID: 'WAYNES', DLT_OTP_TEMPLATE_ID: '1007123456789012345', DLT_OTP_TEMPLATE_TEXT: 'Your login code is {#var#}. Valid for 5 minutes. Do not share it.' };

  it('dlt provider needs its keys and a one-variable template, checked at startup', () => {
    expect(() => loadEnv({ ...base, DEPLOY_REGION: 'IN', OTP_PROVIDER: 'dlt' })).toThrow(/DLT_AUTH_KEY/);
    expect(() => loadEnv({ ...dlt, DLT_OTP_TEMPLATE_TEXT: 'Code {#var#} for {#var#}' })).toThrow(/exactly one/);
    expect(() => loadEnv({ ...dlt, DLT_SENDER_ID: 'TOOLONGHEADER' })).toThrow(/6-letter/);
    expect(otpSenderFor(loadEnv(dlt), 5).name).toBe('dlt');
  });

  it('dlt sends the code through the registered template, and reports failure', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ type: 'success', message: 'req-1' }) };
    });
    const sender = otpSenderFor(loadEnv(dlt), 5);
    expect(await sender.send('+919999900001', '123456')).toBe(true);
    expect(calls[0]!.body).toMatchObject({ sender: 'WAYNES', DLT_TE_ID: '1007123456789012345', sms: [{ message: 'Your login code is 123456. Valid for 5 minutes. Do not share it.', to: ['9999900001'] }] });
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ type: 'error' }) }));
    expect(await otpSenderFor(loadEnv(dlt), 5).send('+919999900001', '123456')).toBe(false);
    expect(await otpSenderFor(loadEnv(dlt), 5).send('+12045550001', '123456')).toBe(false); // not an Indian number
    vi.unstubAllGlobals();
  });
});

describe('TwilioOtp', () => {
  it('posts the code to the Messaging Service and reports failure without throwing', async () => {
    const calls: { url: string; body: string }[] = [];
    const ok = (async (url: string, init: { body: URLSearchParams }) => {
      calls.push({ url, body: init.body.toString() });
      return { ok: true, json: async () => ({ sid: 'SM1' }) };
    }) as unknown as typeof fetch;
    const sender = new TwilioOtp(new TwilioSms({ accountSid: 'AC1', authToken: 't', messagingServiceSid: 'MG1' }, ok), 5);
    expect(await sender.send('+12045550001', '654321')).toBe(true);
    expect(calls[0]!.url).toContain('/Accounts/AC1/Messages.json');
    expect(decodeURIComponent(calls[0]!.body.replace(/\+/g, ' '))).toContain('654321');
    const bad = (async () => ({ ok: false })) as unknown as typeof fetch;
    expect(await new TwilioOtp(new TwilioSms({ accountSid: 'AC1', authToken: 't', messagingServiceSid: 'MG1' }, bad), 5).send('+12045550001', '1')).toBe(false);
    const boom = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    expect(await new TwilioOtp(new TwilioSms({ accountSid: 'AC1', authToken: 't', messagingServiceSid: 'MG1' }, boom), 5).send('+12045550001', '1')).toBe(false);
  });
});

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
(OWNER_URL && APP_URL ? describe : describe.skip)('OTP delivery in /otp/request (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool;
  const env = (): Env => ({ ...loadEnv({ ...base, APP_DATABASE_URL: APP_URL!, DEPLOY_REGION: 'CA' }) });
  beforeAll(() => { owner = new pg.Pool({ connectionString: OWNER_URL }); pool = new pg.Pool({ connectionString: APP_URL }); });
  afterAll(async () => { await pool.end(); await owner.end(); });

  it('sends the code through the sender, and never returns it', async () => {
    const sent: { phone: string; code: string }[] = [];
    const sender: OtpSender = { name: 'fake', send: async (phone, code) => (sent.push({ phone, code }), true) };
    const res = await request(createApp({ env: env(), pool, otpSender: sender })).post('/api/auth/otp/request').send({ phone: '+12045559001' }).expect(200);
    expect(res.body).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.code).toMatch(/^\d{6}$/);
  });

  it('returns 502 and burns the code when delivery fails', async () => {
    let code = '';
    const sender: OtpSender = { name: 'fake', send: async (_p, c) => ((code = c), false) };
    const app = createApp({ env: env(), pool, otpSender: sender });
    const res = await request(app).post('/api/auth/otp/request').send({ phone: '+12045559002' }).expect(502);
    expect(res.body.error).toBe('OTP_DELIVERY_FAILED');
    await request(app).post('/api/auth/otp/verify').send({ phone: '+12045559002', code }).expect(401);
  });
});
