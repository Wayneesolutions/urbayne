import { describe, it, expect } from 'vitest';
import { DltSms, fillDltTemplate, matchesDltTemplate, validateDltTemplate, smsFor } from '../src/index.js';

const T = '{#var#}: reminder, {#var#}, {#var#}. Reply STOP to opt out.';

describe('DLT template rules', () => {
  it('validates template text', () => {
    expect(validateDltTemplate(T)).toMatchObject({ ok: true, varCount: 3, errors: [] });
    expect(validateDltTemplate('').ok).toBe(false);
    expect(validateDltTemplate('Hi {#var#}{#var#} STOP').errors.join()).toMatch(/side by side/);
    expect(validateDltTemplate('Hi {#name#} STOP').errors.join()).toMatch(/Only \{#var#\}/);
    expect(validateDltTemplate('a {#var#} '.repeat(9)).errors.join()).toMatch(/Too many variables/);
    const w = validateDltTemplate('Vote: https://x.example/a');
    expect(w.ok).toBe(true);
    expect(w.warnings.join()).toMatch(/whitelisted/);
    expect(w.warnings.join()).toMatch(/opt-out/);
  });

  it('fills variables in order and refuses bad values', () => {
    expect(fillDltTemplate(T, ['Gurpreet Kaur', 'Booth duty', 'Sat 8:00 am'])).toBe('Gurpreet Kaur: reminder, Booth duty, Sat 8:00 am. Reply STOP to opt out.');
    expect(() => fillDltTemplate(T, ['a', 'b'])).toThrow(/DLT_VAR_COUNT/);
    expect(() => fillDltTemplate(T, ['a', 'b', 'x'.repeat(31)])).toThrow(/DLT_VAR_TOO_LONG/);
    expect(() => fillDltTemplate(T, ['a', ' ', 'c'])).toThrow(/DLT_VAR_EMPTY/);
    expect(fillDltTemplate('ਸਤ ਸ੍ਰੀ ਅਕਾਲ {#var#}', ['ਜੀ'])).toBe('ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਜੀ');
  });

  it('matches a message only when it is the template with the slots filled', () => {
    const ok = fillDltTemplate(T, ['Gurpreet Kaur', 'Booth duty', 'Sat 8:00 am']);
    expect(matchesDltTemplate(T, ok)).toBe(true);
    expect(matchesDltTemplate(T, ok.replace('reminder', 'reminders'))).toBe(false);
    expect(matchesDltTemplate(T, `${ok} Vote now!`)).toBe(false);
    expect(matchesDltTemplate('Code {#var#} (valid 5 min).', 'Code 123456 (valid 5 min).')).toBe(true);
    expect(matchesDltTemplate('Cost is 5.00 {#var#}', 'Cost is 5x00 rupees')).toBe(false); // "." is not a wildcard
    expect(matchesDltTemplate(T, ['a'.repeat(31), 'b', 'c'].reduce((m, v) => m.replace('{#var#}', v), T))).toBe(false); // slot over 30 chars
  });
});

describe('DltSms', () => {
  const cfg = { authKey: 'KEY', senderId: 'WAYNES' };
  const msg = fillDltTemplate(T, ['Gurpreet Kaur', 'Booth duty', 'Sat 8:00 am']);
  const base = { to: '+919876543210', body: msg, templateId: '1007123456789012345', templateBody: T, metadata: { tenantId: 't', interactionId: 'i' } };

  it('builds the provider request with the template id, sender header and a 10-digit number', () => {
    const built = new DltSms(cfg).buildRequest(base);
    if ('refused' in built) throw new Error('should not be refused');
    expect(built.url).toBe('https://api.msg91.com/api/v2/sendsms?country=91');
    expect(built.init.headers.authkey).toBe('KEY');
    expect(JSON.parse(built.init.body)).toEqual({ sender: 'WAYNES', route: '4', country: '91', DLT_TE_ID: '1007123456789012345', sms: [{ message: msg, to: ['9876543210'] }] });
  });

  it('refuses (fails closed) when anything DLT needs is missing or does not match', () => {
    const d = new DltSms(cfg);
    expect(d.buildRequest({ ...base, templateId: null })).toEqual({ refused: 'DLT_TEMPLATE_MISSING' });
    expect(d.buildRequest({ ...base, templateBody: null })).toEqual({ refused: 'DLT_TEMPLATE_TEXT_MISSING' });
    expect(d.buildRequest({ ...base, body: `${msg} extra` })).toEqual({ refused: 'MESSAGE_DOES_NOT_MATCH_TEMPLATE' });
    expect(d.buildRequest({ ...base, to: '+12045550001' })).toEqual({ refused: 'NOT_AN_INDIAN_NUMBER' });
  });

  it('sends through fetch, and reports failures without leaking the number or text', async () => {
    const calls: string[] = [];
    const ok = (async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ type: 'success', message: 'req-123' }) }; }) as unknown as typeof fetch;
    expect(await new DltSms(cfg, ok).send(base)).toEqual({ provider: 'dlt-msg91', providerRef: 'req-123', status: 'queued' });
    expect(calls).toHaveLength(1);

    const rejected = (async () => ({ ok: true, json: async () => ({ type: 'error', message: 'template mismatch' }) })) as unknown as typeof fetch;
    expect(await new DltSms(cfg, rejected).send(base)).toMatchObject({ status: 'failed', reason: 'PROVIDER_REJECTED' });
    const http500 = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    expect(await new DltSms(cfg, http500).send(base)).toMatchObject({ status: 'failed', reason: 'HTTP_500' });
    const down = (async () => { throw new Error('ECONNREFUSED 9876543210'); }) as unknown as typeof fetch;
    const r = await new DltSms(cfg, down).send(base);
    expect(r).toMatchObject({ status: 'failed', reason: 'NETWORK' });
    expect(JSON.stringify(r)).not.toContain('9876543210');
    // A refused message never reaches the network at all.
    expect(await new DltSms(cfg, ok).send({ ...base, body: 'free text' })).toMatchObject({ status: 'failed', reason: 'MESSAGE_DOES_NOT_MATCH_TEMPLATE' });
    expect(calls).toHaveLength(1);
  });

  it('smsFor: demo is simulated, live India uses DLT when configured, otherwise fails closed', () => {
    expect(smsFor({ isDemo: true, region: 'IN' }, { dltSms: cfg }).simulated).toBe(true);
    expect(smsFor({ isDemo: false, region: 'IN' }, { dltSms: cfg }).name).toBe('dlt-msg91');
    expect(() => smsFor({ isDemo: false, region: 'IN' }, {})).toThrow('SMS_PROVIDER_NOT_CONFIGURED');
    expect(() => smsFor({ isDemo: false, region: 'CA' }, { dltSms: cfg })).toThrow('SMS_PROVIDER_NOT_CONFIGURED');
  });
});
