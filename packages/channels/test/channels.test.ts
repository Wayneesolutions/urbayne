import { describe, it, expect } from 'vitest';
import { MockVoice, VapiVoice, voiceFor } from '../src/index.js';

const survey = [{ key: 'issue', question: 'Top issue?', options: [
  { value: 'roads', label: 'Roads', dtmf: '1' }, { value: 'water', label: 'Water', dtmf: '2' }, { value: 'jobs', label: 'Jobs', dtmf: '3' },
] }];

describe('channels', () => {
  it('demo tenants always get the simulated channel, even with real keys set', () => {
    const v = voiceFor({ isDemo: true, region: 'CA' }, { vapi: { apiKey: 'k', phoneNumberId: 'p', assistantId: 'a' } });
    expect(v.simulated).toBe(true);
  });

  it('live tenants without provider config fail closed', () => {
    expect(() => voiceFor({ isDemo: false, region: 'IN' }, {})).toThrow('VOICE_PROVIDER_NOT_CONFIGURED');
  });

  it('mock results are deterministic and survey answers use valid options', async () => {
    const m = new MockVoice();
    const req = { to: '+12045550123', locale: 'en', script: 'This is an automated call...', survey, metadata: { tenantId: 't', interactionId: 'i', runId: 'r' } };
    const a = await m.startCall(req);
    const b = await m.startCall(req);
    expect(a).toEqual(b);
    if (a.status === 'completed' && !a.optOut) expect(['roads', 'water', 'jobs']).toContain(a.answers?.issue);
  });

  it('Vapi request plays the approved script first', () => {
    const v = new VapiVoice({ apiKey: 'k', phoneNumberId: 'pn', assistantId: 'as' });
    const body = v.buildRequest({ to: '+12045550123', locale: 'en', script: 'This is an automated call on behalf of X.', metadata: { tenantId: 't', interactionId: 'i' } });
    expect(body.assistantOverrides.firstMessage).toBe('This is an automated call on behalf of X.');
    expect(body.customer.number).toBe('+12045550123');
  });
});
