import { and, eq } from 'drizzle-orm';
import { schema, type withTenant } from '@cs/db';
import { encrypt, hashPhone, normalisePhone } from '../../lib/crypto.js';
import { addConsents } from '../privacy/consent.js';
import type { Env } from '../../env.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

export interface PersonInput {
  phone?: string | null;
  name?: string | null;
  geoAreaId?: string | null;
  /** The person agreed to texts about THEIR request. */
  smsConsent: boolean;
  via: 'form' | 'ivr' | 'paper';
  /** Call id or paper form number: the proof of the consent. */
  evidenceRef?: string;
  locale: string;
  actorId?: string;
}

export type PersonResult =
  | { contactId: string; smsConsent: boolean }
  | { contactId: null; reason: 'NO_PHONE' | 'BAD_PHONE' | 'SUPPRESSED' };

/**
 * Finds or creates the contact for a resident who raised a request, and records their consent to texts about it.
 * Someone on the do-not-contact list (opted out, or erased on request) is never given a contact or a text: the request
 * is still taken, and answered through the office, not by SMS.
 */
export async function personForTicket(db: Db, tenantId: string, env: Pick<Env, 'PHONE_ENC_KEY' | 'PHONE_HASH_KEY'>, p: PersonInput): Promise<PersonResult> {
  if (!p.phone) return { contactId: null, reason: 'NO_PHONE' };
  let phone: string;
  try { phone = normalisePhone(p.phone); } catch { return { contactId: null, reason: 'BAD_PHONE' }; }
  const phoneHash = hashPhone(phone, env.PHONE_HASH_KEY);

  const [sup] = await db.select().from(schema.suppressions).where(eq(schema.suppressions.phoneHash, phoneHash));
  if (sup) return { contactId: null, reason: 'SUPPRESSED' };

  let [c] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.tenantId, tenantId), eq(schema.contacts.phoneHash, phoneHash)));
  if (c?.optedOut) return { contactId: null, reason: 'SUPPRESSED' };
  if (!c) {
    [c] = await db.insert(schema.contacts).values({
      tenantId, phoneHash, phoneEnc: encrypt(phone, env.PHONE_ENC_KEY), name: p.name ?? undefined, geoAreaId: p.geoAreaId ?? undefined, source: 'form', tags: ['service'],
    }).returning();
  }
  let smsConsent = false;
  if (p.smsConsent) {
    await addConsents(db, tenantId, c!.id, [{
      purpose: 'service', channel: 'sms', textVersion: `service-${p.via}-v1`, locale: p.locale, capturedVia: p.via === 'ivr' ? 'ivr' : p.via === 'paper' ? 'paper' : 'form', evidenceRef: p.evidenceRef,
    }], p.actorId);
    smsConsent = true;
  }
  return { contactId: c!.id, smsConsent };
}
