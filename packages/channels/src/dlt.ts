import type { SmsChannel, SmsRequest, SmsResult } from './types.js';

/**
 * India SMS rules (TRAI DLT): every message must be sent under a registered template, from a registered sender header,
 * and the text must match the template with only the {#var#} slots filled. A message that does not match is blocked
 * by the operator, so we refuse to send it ourselves.
 */
export const DLT_VAR = '{#var#}';
export const DLT_MAX_VAR_LENGTH = 30;
export const DLT_MAX_TEMPLATE_LENGTH = 1000;
export const DLT_MAX_VARS = 8;

export interface DltCheck { ok: boolean; errors: string[]; warnings: string[]; varCount: number }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parts = (body: string) => body.split(DLT_VAR);

/** Checks template text before it is submitted on the DLT portal. */
export function validateDltTemplate(body: string): DltCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const p = parts(body);
  const varCount = p.length - 1;
  if (!body.trim()) errors.push('Template is empty.');
  if (body.length > DLT_MAX_TEMPLATE_LENGTH) errors.push(`Template is longer than ${DLT_MAX_TEMPLATE_LENGTH} characters.`);
  if (varCount > DLT_MAX_VARS) errors.push(`Too many variables (${varCount}); the most allowed is ${DLT_MAX_VARS}.`);
  if (/\{#[^}]*#\}/.test(body.split(DLT_VAR).join(''))) errors.push(`Only ${DLT_VAR} is a valid variable.`);
  if (p.slice(1, -1).some((mid) => mid === '')) errors.push('Two variables cannot sit side by side; put text between them.');
  if (varCount === 0) warnings.push('No variables: the message will be sent exactly as written.');
  if (/https?:\/\/|www\./i.test(body)) warnings.push('Links must be registered as whitelisted URLs on the DLT portal first.');
  if (!/stop|opt.?out|unsubscribe/i.test(body)) warnings.push('Add an opt-out line (for example "Reply STOP to opt out").');
  return { ok: errors.length === 0, errors, warnings, varCount };
}

/** Fills the {#var#} slots in order. Throws when the count is wrong or a value is too long for DLT. */
export function fillDltTemplate(body: string, values: string[]): string {
  const p = parts(body);
  if (p.length - 1 !== values.length) throw new Error(`DLT_VAR_COUNT: template has ${p.length - 1} variables, got ${values.length}`);
  values.forEach((v, i) => {
    if (!v.trim()) throw new Error(`DLT_VAR_EMPTY: variable ${i + 1} is empty`);
    if ([...v].length > DLT_MAX_VAR_LENGTH) throw new Error(`DLT_VAR_TOO_LONG: variable ${i + 1} is longer than ${DLT_MAX_VAR_LENGTH} characters`);
  });
  return p.reduce((out, part, i) => out + part + (i < values.length ? values[i] : ''), '');
}

/** True when `message` is the template with every {#var#} filled by 1 to 30 characters. */
export function matchesDltTemplate(body: string, message: string): boolean {
  const re = new RegExp(`^${parts(body).map(escapeRe).join(`(.{1,${DLT_MAX_VAR_LENGTH}})`)}$`, 's');
  return re.test(message);
}

export interface DltSmsConfig {
  /** Provider API key (MSG91 authkey). */
  authKey: string;
  /** Registered 6-letter sender header (DLT header), for example "WAYNES". */
  senderId: string;
  baseUrl?: string;
}

/**
 * India SMS through a DLT-registered provider (MSG91 "send SMS" API v2).
 * NOTE: written from the provider's public docs and exercised only through its request builder and a mocked HTTP layer;
 * confirm against a real account (and the current API docs) before the first live send.
 */
export class DltSms implements SmsChannel {
  readonly name = 'dlt-msg91';
  readonly simulated = false;
  constructor(private cfg: DltSmsConfig, private fetchImpl: typeof fetch = fetch) {}

  /** Returns the HTTP request, or the reason the message must not be sent. */
  buildRequest(req: SmsRequest): { url: string; init: { method: 'POST'; headers: Record<string, string>; body: string } } | { refused: string } {
    if (!req.templateId) return { refused: 'DLT_TEMPLATE_MISSING' };
    if (!req.templateBody) return { refused: 'DLT_TEMPLATE_TEXT_MISSING' };
    if (!matchesDltTemplate(req.templateBody, req.body)) return { refused: 'MESSAGE_DOES_NOT_MATCH_TEMPLATE' };
    const m = /^\+91(\d{10})$/.exec(req.to);
    if (!m) return { refused: 'NOT_AN_INDIAN_NUMBER' };
    return {
      url: `${this.cfg.baseUrl ?? 'https://api.msg91.com'}/api/v2/sendsms?country=91`,
      init: {
        method: 'POST',
        headers: { authkey: this.cfg.authKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: this.cfg.senderId, route: '4', country: '91', DLT_TE_ID: req.templateId, sms: [{ message: req.body, to: [m[1]] }] }),
      },
    };
  }

  async send(req: SmsRequest): Promise<SmsResult> {
    const built = this.buildRequest(req);
    if ('refused' in built) return { provider: this.name, providerRef: '', status: 'failed', reason: built.refused };
    try {
      const res = await this.fetchImpl(built.url, built.init);
      if (!res.ok) return { provider: this.name, providerRef: '', status: 'failed', reason: `HTTP_${res.status}` };
      const body = (await res.json()) as { type?: string; message?: string };
      if (body.type !== 'success') return { provider: this.name, providerRef: '', status: 'failed', reason: 'PROVIDER_REJECTED' };
      return { provider: this.name, providerRef: body.message ?? '', status: 'queued' };
    } catch {
      return { provider: this.name, providerRef: '', status: 'failed', reason: 'NETWORK' };
    }
  }
}

/** Starting text for the messages the platform sends itself. Submit it on the DLT portal as-is (or adapt it, then keep the {#var#} order). */
export const DLT_SUGGESTED_TEMPLATES = {
  shift_reminder: {
    body: '{#var#}: reminder, {#var#}, {#var#}. Reply STOP to opt out.',
    variables: ['campaign name', 'shift title', 'day and time'],
  },
  ticket_ack: {
    body: '{#var#}: request {#var#} received. We will update you. Reply STOP to opt out.',
    variables: ['office name', 'request number'],
  },
  ticket_status: {
    body: '{#var#}: request {#var#} is now {#var#}. Reply STOP to opt out.',
    variables: ['office name', 'request number', 'status'],
  },
} as const;
export type DltTemplateKey = keyof typeof DLT_SUGGESTED_TEMPLATES;
