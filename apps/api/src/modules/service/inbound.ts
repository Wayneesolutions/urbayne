import '../../types.js';
import { Router, urlencoded } from 'express';
import { and, eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { hashPhone, normalisePhone, safeEqual } from '../../lib/crypto.js';
import { now } from '../../lib/util.js';
import { guessCategory, STATUS_WORDS } from './categories.js';
import { personForTicket } from './people.js';
import { queueTicketSms } from './sms.js';
import { addEvent, createTicket, resolveArea } from './tickets.js';
import type { Deps } from '../../types.js';

/** The office that owns a number people text or call (registered by platform staff). */
export async function tenantForNumber(deps: Deps, kind: 'sms' | 'voice', identifier: string): Promise<string | null> {
  const { rows } = await deps.pool.query('SELECT tenant_id FROM service_number_tenant($1, $2)', [kind, identifier]);
  return (rows[0]?.tenant_id as string | undefined) ?? null;
}

const STOP_WORDS = /^(stop|stopall|unsubscribe|cancel|end|quit)\b/i;
const STATUS_CMD = /^status\s+(t-?\d{3,8})\b/i;
const LEADING_KEYWORD = /^(issue|problem|complaint|shikayat|samasya)[\s:.-]*/i;
const HELP = 'To report a problem text: ISSUE <area code> <what is wrong>. To check a request text: STATUS T-0042. Reply STOP to opt out.';

export interface InboundSms { to: string; from: string; body: string; messageId: string }

/**
 * An inbound text to an office number. STOP opts the person out; "STATUS T-0042" answers with progress; anything else
 * that reads like a request becomes a ticket (category and area are guessed from the words, a known area code anywhere in
 * the text sets the area). Texting the office counts as agreeing to replies about that request.
 * Returns the reply to show (Twilio sends it as the answer to the text), or '' for none.
 * `inlineReply`: the provider will deliver our reply itself, so no separate acknowledgement text is queued.
 */
export async function handleInboundSms(deps: Deps, m: InboundSms, opts: { inlineReply: boolean }): Promise<string> {
  const tenantId = await tenantForNumber(deps, 'sms', m.to);
  if (!tenantId) return '';
  let from: string;
  try { from = normalisePhone(m.from); } catch { return ''; }
  const body = m.body.trim();
  const phoneHash = hashPhone(from, deps.env.PHONE_HASH_KEY);

  if (STOP_WORDS.test(body)) {
    await withTenant(deps.pool, tenantId, async (db) => {
      await db.update(schema.contacts).set({ optedOut: true, updatedAt: now(deps) }).where(and(eq(schema.contacts.tenantId, tenantId), eq(schema.contacts.phoneHash, phoneHash)));
      // A number we hold no contact for is still put on the do-not-contact list.
      await db.insert(schema.suppressions).values({ tenantId, phoneHash, reason: 'opted_out' }).onConflictDoNothing();
    });
    return '';
  }

  const status = STATUS_CMD.exec(body);
  if (status) {
    const ref = status[1]!.toUpperCase().replace(/^T-?/, 'T-');
    return withTenant(deps.pool, tenantId, async (db) => {
      const [x] = await db.select({ t: schema.tickets }).from(schema.tickets).innerJoin(schema.contacts, eq(schema.contacts.id, schema.tickets.contactId))
        .where(and(eq(schema.tickets.ref, ref), eq(schema.contacts.phoneHash, phoneHash)));
      return x && !x.t.scrubbedAt ? `Request ${x.t.ref} is ${STATUS_WORDS[x.t.status]}.` : `We could not find request ${ref} for this number.`;
    });
  }

  const text = body.replace(LEADING_KEYWORD, '').trim();
  if (text.length < 8) return HELP;

  const result = await withTenant(deps.pool, tenantId, async (db) => {
    const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    if (!t) return null;
    // A known area code anywhere in the text sets the area.
    let geoAreaId: string | null = null;
    for (const word of text.split(/[\s,;:]+/).slice(0, 40)) {
      if (word.length >= 2 && word.length <= 40) { geoAreaId = await resolveArea(db, { areaCode: word }); if (geoAreaId) break; }
    }
    const person = await personForTicket(db, tenantId, deps.env, { phone: from, geoAreaId, smsConsent: true, via: 'form', evidenceRef: m.messageId, locale: 'en' });
    const { ticket, duplicate } = await createTicket(db, t, {
      channel: 'sms', category: guessCategory(text) ?? 'other', title: text.slice(0, 80), description: text.length > 80 ? text : null, geoAreaId,
      contactId: person.contactId, sourceRef: m.messageId,
    }, now(deps));
    const replies = person.contactId !== null;
    if (opts.inlineReply && replies && !duplicate && !ticket.acknowledgedAt) {
      await db.update(schema.tickets).set({ acknowledgedAt: now(deps), updatedAt: now(deps) }).where(eq(schema.tickets.id, ticket.id));
      await addEvent(db, tenantId, ticket.id, { kind: 'ack_sent', meta: { inline: true, seconds: 0 } });
    }
    return { ticket, duplicate, replies };
  });
  if (!result) return '';
  if (!opts.inlineReply && result.replies && !result.duplicate) await queueTicketSms(deps, tenantId, result.ticket.id, 'ack');
  // The person is on the do-not-contact list: take the request but do not text back.
  return result.replies ? `Request ${result.ticket.ref} received. We will update you. Reply STOP to opt out.` : '';
}

// ---------------------------------------------------------------------------------------------------------------------

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));

/** Twilio signs each webhook: HMAC-SHA1 of the full URL plus the sorted form fields, with the account's auth token. */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** Inbound SMS webhooks. Twilio (Canada) answers with TwiML; the generic one (India providers) is a JSON call with a shared secret. */
export function inboundSmsRoutes(deps: Deps) {
  const r = Router();

  r.post('/twilio', urlencoded({ extended: false, limit: '20kb' }), ah(async (req, res) => {
    const token = deps.env.TWILIO_AUTH_TOKEN;
    const params = (req.body ?? {}) as Record<string, string>;
    const url = `${deps.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhooks/sms/twilio`;
    if (!token || !safeEqual(String(req.headers['x-twilio-signature'] ?? ''), twilioSignature(url, params, token))) throw new HttpError(403, 'BAD_SIGNATURE');
    if (!params.From || !params.To || !params.MessageSid) throw new HttpError(400, 'BAD_REQUEST');
    const reply = await handleInboundSms(deps, { from: params.From, to: params.To, body: params.Body ?? '', messageId: params.MessageSid }, { inlineReply: true });
    res.type('text/xml').send(reply ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xml(reply)}</Message></Response>` : '<?xml version="1.0" encoding="UTF-8"?><Response/>');
  }));

  r.post('/inbound', ah(async (req, res) => {
    const secret = deps.env.SMS_INBOUND_SECRET;
    if (!secret || !safeEqual(String(req.headers['x-webhook-secret'] ?? ''), secret)) throw new HttpError(401, 'BAD_SIGNATURE');
    const b = req.body as { from?: string; to?: string; text?: string; id?: string };
    if (!b?.from || !b.to || !b.id) throw new HttpError(400, 'BAD_REQUEST');
    const reply = await handleInboundSms(deps, { from: b.from, to: b.to, body: b.text ?? '', messageId: b.id }, { inlineReply: false });
    res.json({ ok: true, reply });
  }));

  return r;
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * A finished call to the voice helpline (Vapi end-of-call report for an inbound call). The assistant collects the issue and the
 * area and returns them as structured data; the transcript is never stored on the ticket, only what the assistant summarised.
 * Returns true when the report belonged to a helpline number (so the campaign-call handler leaves it alone).
 */
export async function handleHelplineReport(deps: Deps, msg: any): Promise<boolean> {
  const call = msg?.call ?? {};
  // Only inbound calls: the same Vapi number may also be used for outbound campaign calls, whose reports must not become tickets.
  if (call.type !== 'inboundPhoneCall') return false;
  const numberId = call.phoneNumberId ?? call.phoneNumber?.id;
  if (!numberId) return false;
  const tenantId = await tenantForNumber(deps, 'voice', String(numberId));
  if (!tenantId) return false;

  const sd = (msg.analysis?.structuredData ?? {}) as { category?: string; issue?: string; areaText?: string; areaCode?: string; name?: string; language?: string; smsConsent?: boolean };
  const issue = (typeof sd.issue === 'string' ? sd.issue : typeof msg.analysis?.summary === 'string' ? msg.analysis.summary : '').trim();
  const callId = typeof call.id === 'string' ? call.id : null;
  if (!issue || issue.length < 5 || !callId) return true; // a hang-up or a wrong number: no ticket

  const lang = sd.language === 'pa' || sd.language === 'hi' ? sd.language : 'en';
  const caller = typeof call.customer?.number === 'string' ? call.customer.number : null;
  const out = await withTenant(deps.pool, tenantId, async (db) => {
    const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    if (!t) return null;
    const geoAreaId = await resolveArea(db, { areaCode: sd.areaCode, areaText: sd.areaText });
    const person = await personForTicket(db, tenantId, deps.env, { phone: caller, name: typeof sd.name === 'string' ? sd.name : null, geoAreaId, smsConsent: sd.smsConsent === true, via: 'ivr', evidenceRef: callId, locale: lang });
    const category = (schema.TICKET_CATEGORIES as readonly string[]).includes(String(sd.category)) ? (sd.category as (typeof schema.TICKET_CATEGORIES)[number]) : guessCategory(issue) ?? 'other';
    const { ticket, duplicate } = await createTicket(db, t, {
      channel: 'voice', category, title: issue.slice(0, 80), description: issue.length > 80 ? issue : null, geoAreaId, areaText: geoAreaId ? null : (sd.areaText ?? null),
      contactId: person.contactId, requesterName: typeof sd.name === 'string' ? sd.name : null, language: lang, sourceRef: callId,
    }, now(deps));
    if (!duplicate) {
      // Record the call itself, so its provider cost shows in the cost dashboard.
      const cost = Number(msg.cost ?? call.cost);
      await db.insert(schema.interactions).values({
        tenantId, contactId: person.contactId, channel: 'voice', direction: 'inbound', provider: 'vapi', providerRef: callId, status: 'completed',
        startedAt: now(deps), durationSec: Math.round(Number(msg.durationSeconds ?? 0)) || null, costUsdMicros: Number.isFinite(cost) && cost > 0 ? Math.round(cost * 1e6) : null,
      });
    }
    return { ticket, duplicate, texts: person.contactId !== null && person.smsConsent };
  });
  if (out && !out.duplicate && out.texts) await queueTicketSms(deps, tenantId, out.ticket.id, 'ack');
  return true;
}
