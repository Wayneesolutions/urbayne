import { and, eq, isNull } from 'drizzle-orm';
import { schema, type withTenant } from '@cs/db';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

export interface ConsentInput {
  purpose: 'info' | 'survey' | 'reminder' | 'donation';
  channel: 'voice' | 'sms' | 'ai_answer';
  textVersion: string;
  locale: string;
  capturedVia: 'form' | 'missed_call' | 'ivr' | 'paper';
  /** Paper: the form / sheet serial number. IVR: the call id. */
  evidenceRef?: string;
  capturedAt?: Date;
}

/**
 * Records consents for a contact. A consent that is already active for the same purpose and channel is
 * not recorded twice (the first record is the proof). Returns how many new records were written.
 */
export async function addConsents(db: Db, tenantId: string, contactId: string, list: ConsentInput[], capturedBy?: string): Promise<number> {
  if (!list.length) return 0;
  const active = await db.select({ purpose: schema.consents.purpose, channel: schema.consents.channel }).from(schema.consents)
    .where(and(eq(schema.consents.contactId, contactId), isNull(schema.consents.withdrawnAt)));
  const have = new Set(active.map((c) => `${c.purpose}:${c.channel}`));
  const fresh = list.filter((c, i) => {
    const k = `${c.purpose}:${c.channel}`;
    if (have.has(k) || list.findIndex((x) => `${x.purpose}:${x.channel}` === k) !== i) return false;
    return true;
  });
  if (fresh.length) {
    await db.insert(schema.consents).values(fresh.map((c) => ({
      tenantId, contactId, purpose: c.purpose, channel: c.channel, textVersion: c.textVersion, locale: c.locale,
      capturedVia: c.capturedVia, evidenceRef: c.evidenceRef, capturedAt: c.capturedAt, capturedBy,
    })));
  }
  return fresh.length;
}

/**
 * Consent given by pressing a key during an AI call. Only recorded when the provider tells us which consent text
 * was played (textVersion): without it there is no proof of what the person agreed to.
 */
export async function recordIvrConsent(
  db: Db, tenantId: string, interactionId: string, contactId: string, locale: string,
  consent: { purposes?: unknown; textVersion?: unknown } | undefined,
): Promise<number> {
  const textVersion = typeof consent?.textVersion === 'string' ? consent.textVersion.trim() : '';
  const purposes = Array.isArray(consent?.purposes)
    ? (consent!.purposes as unknown[]).filter((p): p is ConsentInput['purpose'] => p === 'info' || p === 'survey' || p === 'reminder' || p === 'donation')
    : [];
  if (!textVersion || !purposes.length) return 0;
  // Money is never asked for by an automated call (region rule), so a donation consent can never come from IVR.
  const allowed = purposes.filter((p) => p !== 'donation');
  return addConsents(db, tenantId, contactId,
    allowed.map((purpose) => ({ purpose, channel: 'voice' as const, textVersion, locale, capturedVia: 'ivr' as const, evidenceRef: interactionId })));
}
