import { describe, it, expect } from 'vitest';
import { IN, CA } from '@cs/regions';
import { checkOutbound, renderDisclosure, type OutboundCtx, type Contact } from '../src/index.js';

const consentAll = (channel: 'voice' | 'sms'): Contact['consents'] => [
  { purpose: 'info', channel },
  { purpose: 'survey', channel },
  { purpose: 'reminder', channel },
];

// ---------- India ----------
const inTenant = {
  id: 't-in',
  campaignName: 'Test Candidate',
  timeZone: 'Asia/Kolkata',
  pollCloseAt: new Date('2027-02-20T18:00:00+05:30'),
  // IN calling hours are not confirmed yet; tests supply a counsel-approved override.
  callingHoursOverride: { weekday: { start: 9 * 60, end: 21 * 60 }, weekend: { start: 9 * 60, end: 21 * 60 } },
};
const inVoice = (over: Partial<OutboundCtx> = {}): OutboundCtx => ({
  tenant: inTenant,
  region: IN,
  channel: 'voice',
  purpose: 'info',
  sendAt: new Date('2027-02-10T11:00:00+05:30'),
  contentItem: {
    id: 'c1', kind: 'script', locale: 'pa', status: 'certified', certificateNo: 'MCMC/LDH/0042',
    body: `${IN.aiDisclosure.spoken.pa} ਸਤ ਸ੍ਰੀ ਅਕਾਲ ...`,
  },
  contact: { id: 'p1', optedOut: false, consents: consentAll('voice') },
  ...over,
});

describe('India edition', () => {
  it('allows a certified, disclosed, consented call inside hours', () => {
    const res = checkOutbound(inVoice());
    expect(res.reasons).toEqual([]);
    expect(res.allowed).toBe(true);
  });

  it('blocks without an MCMC certificate', () => {
    const res = checkOutbound(inVoice({ contentItem: { ...inVoice().contentItem, status: 'approved', certificateNo: null } }));
    expect(res.reasons.map((x) => x.code)).toContain('CERTIFICATE_MISSING');
  });

  it('blocks inside the 48-hour silence window', () => {
    const res = checkOutbound(inVoice({ sendAt: new Date('2027-02-19T12:00:00+05:30') }));
    expect(res.reasons.map((x) => x.code)).toContain('SILENCE_WINDOW');
  });

  it('allows just before the silence window starts', () => {
    const res = checkOutbound(inVoice({ sendAt: new Date('2027-02-18T17:59:00+05:30') }));
    expect(res.allowed).toBe(true);
  });

  it('blocks when the poll close time is not set', () => {
    const res = checkOutbound(inVoice({ tenant: { ...inTenant, pollCloseAt: null } }));
    expect(res.reasons.map((x) => x.code)).toContain('POLL_CLOSE_NOT_SET');
  });

  it('blocks voice when calling hours are not configured', () => {
    const res = checkOutbound(inVoice({ tenant: { ...inTenant, callingHoursOverride: null } }));
    expect(res.reasons.map((x) => x.code)).toContain('CALLING_HOURS_NOT_CONFIGURED');
  });

  it('blocks a script that does not open with the AI disclosure', () => {
    const res = checkOutbound(inVoice({ contentItem: { ...inVoice().contentItem, body: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ ... ' + IN.aiDisclosure.spoken.pa } }));
    expect(res.reasons.map((x) => x.code)).toContain('DISCLOSURE_MISSING');
  });

  it('blocks automated donation calls outright', () => {
    const res = checkOutbound(inVoice({ purpose: 'donation', contact: { id: 'p1', optedOut: false, consents: [{ purpose: 'donation', channel: 'voice' }] } }));
    expect(res.reasons.map((x) => x.code)).toContain('DONATION_BLOCKED');
  });

  it('requires a DLT template id for SMS', () => {
    const res = checkOutbound(inVoice({
      channel: 'sms',
      contentItem: { id: 's1', kind: 'sms_template', locale: 'pa', status: 'certified', certificateNo: 'MCMC/1', body: 'Sabha today 5pm', dltTemplateId: null },
      contact: { id: 'p1', optedOut: false, consents: consentAll('sms') },
    }));
    expect(res.reasons.map((x) => x.code)).toContain('DLT_TEMPLATE_MISSING');
  });
});

// ---------- Canada ----------
const caTenant = {
  id: 't-ca',
  campaignName: 'Jane Doe for Ward 3',
  timeZone: 'America/Winnipeg',
  pollCloseAt: new Date('2026-10-28T20:00:00-05:00'),
};
const caVoice = (over: Partial<OutboundCtx> = {}): OutboundCtx => ({
  tenant: caTenant,
  region: CA,
  channel: 'voice',
  purpose: 'reminder',
  sendAt: new Date('2026-10-21T18:00:00-05:00'), // Wednesday 6 pm Winnipeg
  contentItem: {
    id: 'c2', kind: 'script', locale: 'en', status: 'approved',
    body: `${renderDisclosure({ region: CA, tenant: caTenant }, 'en')} Advance voting runs until Thursday...`,
  },
  contact: { id: 'p2', optedOut: false, consents: consentAll('voice') },
  ...over,
});

describe('Canada edition', () => {
  it('allows an approved, identified reminder call on a weekday evening', () => {
    const res = checkOutbound(caVoice());
    expect(res.reasons).toEqual([]);
  });

  it('blocks a weekday call after 9:30 pm local time', () => {
    const res = checkOutbound(caVoice({ sendAt: new Date('2026-10-21T21:45:00-05:00') }));
    expect(res.reasons.map((x) => x.code)).toContain('OUTSIDE_CALLING_HOURS');
  });

  it('blocks a Saturday call after 6 pm local time', () => {
    const res = checkOutbound(caVoice({ sendAt: new Date('2026-10-24T18:30:00-05:00') }));
    expect(res.reasons.map((x) => x.code)).toContain('OUTSIDE_CALLING_HOURS');
  });

  it('uses the contact time zone when known', () => {
    // 8:30 pm in Toronto = 7:30 pm in Winnipeg; Saturday -> outside for Toronto contact
    const res = checkOutbound(caVoice({
      sendAt: new Date('2026-10-24T20:30:00-04:00'),
      contact: { id: 'p3', timeZone: 'America/Toronto', optedOut: false, consents: consentAll('voice') },
    }));
    expect(res.reasons.map((x) => x.code)).toContain('OUTSIDE_CALLING_HOURS');
  });

  it('blocks when the campaign is not named after the disclosure', () => {
    const res = checkOutbound(caVoice({ contentItem: { ...caVoice().contentItem, body: `${CA.aiDisclosure.spoken.en} someone. Vote!` } }));
    expect(res.reasons.map((x) => x.code)).toContain('CAMPAIGN_NOT_IDENTIFIED');
  });

  it('blocks donation calls without express consent, allows with it', () => {
    const noConsent = checkOutbound(caVoice({ purpose: 'donation' }));
    expect(noConsent.reasons.map((x) => x.code)).toContain('NO_CONSENT');
    const withConsent = checkOutbound(caVoice({
      purpose: 'donation',
      contact: { id: 'p2', optedOut: false, consents: [{ purpose: 'donation', channel: 'voice' }] },
    }));
    expect(withConsent.allowed).toBe(true);
  });

  it('never calls opted-out contacts', () => {
    const res = checkOutbound(caVoice({ contact: { id: 'p2', optedOut: true, consents: consentAll('voice') } }));
    expect(res.reasons.map((x) => x.code)).toContain('OPTED_OUT');
  });

  it('treats a withdrawn consent as no consent', () => {
    const res = checkOutbound(caVoice({ contact: { id: 'p2', optedOut: false, consents: [{ purpose: 'reminder', channel: 'voice', withdrawnAt: new Date() }] } }));
    expect(res.reasons.map((x) => x.code)).toContain('NO_CONSENT');
  });
});

describe('shared gates', () => {
  it('run-scope checks skip per-contact gates but keep content and timing gates', () => {
    const ok = checkOutbound(caVoice({ scope: 'run', contact: undefined }));
    expect(ok.allowed).toBe(true);
    const late = checkOutbound(caVoice({ scope: 'run', contact: undefined, sendAt: new Date('2026-10-21T22:00:00-05:00') }));
    expect(late.reasons.map((x) => x.code)).toContain('OUTSIDE_CALLING_HOURS');
  });

  it('blocks drafts', () => {
    const res = checkOutbound(caVoice({ contentItem: { ...caVoice().contentItem, status: 'draft' } }));
    expect(res.reasons.map((x) => x.code)).toContain('CONTENT_NOT_APPROVED');
  });

  it('enforces the hourly cap', () => {
    const res = checkOutbound(caVoice({ hourlySentCount: 500, hourlyCap: 500 }));
    expect(res.reasons.map((x) => x.code)).toContain('RATE_LIMIT');
  });

  it('warns near the spend limit and blocks over it', () => {
    const near = checkOutbound(caVoice({ spentMinor: 9_000, estimatedCostMinor: 200, spendLimitMinor: 10_000 }));
    expect(near.allowed).toBe(true);
    expect(near.warnings.map((x) => x.code)).toContain('SPEND_NEAR_LIMIT');
    const over = checkOutbound(caVoice({ spentMinor: 9_900, estimatedCostMinor: 200, spendLimitMinor: 10_000 }));
    expect(over.reasons.map((x) => x.code)).toContain('SPEND_OVER_LIMIT');
  });

  it('inbound AI answers skip outbound-only gates', () => {
    const res = checkOutbound({
      ...caVoice(),
      channel: 'ai_answer',
      contact: undefined,
      sendAt: new Date('2026-10-21T23:30:00-05:00'),
      contentItem: { id: 'f1', kind: 'faq', locale: 'en', status: 'approved', body: 'Our transit plan...' },
    });
    expect(res.allowed).toBe(true);
  });
});
