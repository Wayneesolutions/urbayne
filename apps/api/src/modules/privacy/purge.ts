import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { VapiVoice } from '@cs/channels';
import { channelEnv, now } from '../../lib/util.js';
import { scrubTicket } from '../service/tickets.js';
import type { Deps, TenantRow } from '../../types.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

/**
 * Deletes the voice provider's own copy of each finished call (transcript, messages, any recording) for a campaign.
 * Each call is marked once it is gone, so this can be run again after a failure and only retries what is left.
 * Demo campaigns never reach a real provider, so they have nothing to delete.
 */
export async function deleteProviderCallData(deps: Deps, tenantId: string) {
  const cfg = channelEnv(deps).vapi;
  const pending = await withTenant(deps.pool, tenantId, (db) => db.select({ id: schema.interactions.id, ref: schema.interactions.providerRef }).from(schema.interactions)
    .where(and(eq(schema.interactions.provider, 'vapi'), isNotNull(schema.interactions.providerRef), isNull(schema.interactions.providerDataDeletedAt), ne(schema.interactions.status, 'in_progress'))));
  if (!pending.length) return { deleted: 0, failed: 0, remaining: 0 };
  if (!cfg) return { deleted: 0, failed: 0, remaining: pending.length, notConfigured: true as const };
  const vapi = new VapiVoice(cfg);
  let deleted = 0, failed = 0;
  for (let k = 0; k < pending.length; k += 5) {
    await Promise.all(pending.slice(k, k + 5).map(async (p) => {
      if (await vapi.deleteCall(p.ref!)) {
        await withTenant(deps.pool, tenantId, (db) => db.update(schema.interactions).set({ providerDataDeletedAt: new Date() }).where(eq(schema.interactions.id, p.id)));
        deleted++;
      } else failed++;
    }));
  }
  await withTenant(deps.pool, tenantId, (db) => db.insert(schema.auditLog).values({ tenantId, action: 'purge_provider_data', entity: 'tenant', entityId: tenantId, after: { deleted, failed } }));
  return { deleted, failed, remaining: failed };
}

/** Text that replaces a removed street address (the column cannot be empty). */
export const REMOVED = '[removed]';

/**
 * Erases one person at their request: the contact, their consents and shift assignments are deleted, and what they said
 * (transcripts, notes) is scrubbed. Only the one-way phone hash stays, on the suppression list, so the same number
 * cannot be added and called again by mistake.
 */
export async function eraseContact(db: Db, t: TenantRow, contactId: string, requestedBy: string) {
  const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
  if (!c) return null;
  await db.insert(schema.suppressions).values({ tenantId: t.id, phoneHash: c.phoneHash, reason: c.optedOut ? 'opted_out' : 'erasure_request' })
    .onConflictDoNothing();
  const transcripts = await db.update(schema.interactions).set({ transcript: null }).where(and(eq(schema.interactions.contactId, c.id), isNotNull(schema.interactions.transcript))).returning({ id: schema.interactions.id });
  const notes = await db.update(schema.doorVisits).set({ note: null, household: null }).where(eq(schema.doorVisits.contactId, c.id)).returning({ id: schema.doorVisits.id });
  const signs = await db.update(schema.signs).set({ address: REMOVED, lat: null, lng: null }).where(eq(schema.signs.contactId, c.id)).returning({ id: schema.signs.id });
  const consents = await db.select({ n: sql<number>`count(*)::int` }).from(schema.consents).where(eq(schema.consents.contactId, c.id));
  const theirTickets = await db.select({ id: schema.tickets.id }).from(schema.tickets).where(and(eq(schema.tickets.contactId, c.id), isNull(schema.tickets.scrubbedAt)));
  for (const tk of theirTickets) await scrubTicket(db, tk.id, new Date());
  await db.delete(schema.contacts).where(eq(schema.contacts.id, c.id)); // cascades consents and shift assignments
  const counts = { contacts: 1, consents: consents[0]?.n ?? 0, transcripts: transcripts.length, doorNotes: notes.length, signAddresses: signs.length, tickets: theirTickets.length };
  await db.insert(schema.dataPurges).values({ tenantId: t.id, kind: 'contact_erasure', counts, requestedBy });
  await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: requestedBy, action: 'erase_contact', entity: 'contact', entityId: c.id, after: counts });
  return counts;
}

export interface PurgeOptions {
  kind: 'retention' | 'owner_request';
  requestedBy?: string;
}

/**
 * Deletes a campaign's personal data once the election is over. Kept on purpose:
 *  - the suppression list (hashes only), so opted-out people stay protected;
 *  - results: counts of calls by status and anonymous survey answers (no link to a person any more);
 *  - finance entries: election spending and contribution registers must be kept for the election agent;
 *  - the audit log and the record of this deletion (counts only).
 * Removed: contacts (with consents and shift assignments), call transcripts, voter questions to the assistant,
 * door-knock notes, and lawn-sign addresses.
 * Safe to run twice: the second run finds nothing left to do.
 */
export async function purgeTenantData(deps: Deps, tenantId: string, opts: PurgeOptions) {
  const out = await withTenant(deps.pool, tenantId, async (db) => {
    const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    if (!t) return null;
    if (t.purgedAt) return { alreadyPurged: true as const };

    // Everyone who opted out is on the suppression list already (trigger); make sure nobody was missed.
    const opted = await db.select({ phoneHash: schema.contacts.phoneHash }).from(schema.contacts).where(eq(schema.contacts.optedOut, true));
    if (opted.length) await db.insert(schema.suppressions).values(opted.map((o) => ({ tenantId, phoneHash: o.phoneHash, reason: 'opted_out' as const }))).onConflictDoNothing();

    const transcripts = await db.update(schema.interactions).set({ transcript: null, contactId: null }).where(sql`${schema.interactions.transcript} IS NOT NULL OR ${schema.interactions.contactId} IS NOT NULL`).returning({ id: schema.interactions.id });
    const questions = await db.delete(schema.assistantQuestions).returning({ id: schema.assistantQuestions.id });
    const notes = await db.update(schema.doorVisits).set({ note: null, household: null, contactId: null }).returning({ id: schema.doorVisits.id });
    const signs = await db.update(schema.signs).set({ address: REMOVED, lat: null, lng: null, contactId: null }).returning({ id: schema.signs.id });
    const [consentCount] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.consents);
    const openTickets = await db.select({ id: schema.tickets.id }).from(schema.tickets).where(isNull(schema.tickets.scrubbedAt));
    for (const tk of openTickets) await scrubTicket(db, tk.id, now(deps));
    const contacts = await db.delete(schema.contacts).returning({ id: schema.contacts.id }); // cascades consents and shift assignments

    const counts = {
      contacts: contacts.length, consents: consentCount?.n ?? 0, interactionsScrubbed: transcripts.length,
      assistantQuestions: questions.length, doorVisitsScrubbed: notes.length, signAddresses: signs.length, tickets: openTickets.length,
    };
    await db.update(schema.tenants).set({ purgedAt: now(deps), status: 'archived', updatedAt: new Date() }).where(eq(schema.tenants.id, tenantId));
    await db.insert(schema.dataPurges).values({ tenantId, kind: opts.kind, counts, requestedBy: opts.requestedBy });
    await db.insert(schema.auditLog).values({ tenantId, actorId: opts.requestedBy, action: 'purge_personal_data', entity: 'tenant', entityId: tenantId, after: { kind: opts.kind, ...counts } });
    return { alreadyPurged: false as const, counts };
  });
  if (!out || out.alreadyPurged) return out;
  // After our own data is gone, remove the voice provider's copy of every finished call too (retried by the owner if some fail).
  const providerData = await deleteProviderCallData(deps, tenantId).catch((e) => {
    deps.log.error({ tenantId, err: e }, 'provider data deletion failed');
    return { deleted: 0, failed: -1, remaining: -1 };
  });
  return { ...out, providerData };
}

/** What the retention job would do today, without doing it. */
export async function privacyStatus(deps: Deps, t: TenantRow) {
  const nowDate = now(deps);
  const due = t.retentionDays == null ? null : new Date(`${t.electionDate}T00:00:00Z`).getTime() + t.retentionDays * 86_400_000;
  return withTenant(deps.pool, t.id, async (db) => {
    const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.contacts);
    const [s] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.suppressions);
    const [consents] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.consents);
    const purges = await db.select().from(schema.dataPurges).orderBy(sql`${schema.dataPurges.ranAt} desc`).limit(10);
    return {
      retentionDays: t.retentionDays,
      retentionConfigured: t.retentionDays != null,
      electionDate: t.electionDate,
      deleteOn: due == null ? null : new Date(due).toISOString().slice(0, 10),
      dueNow: due != null && due <= nowDate.getTime() && !t.purgedAt,
      purgedAt: t.purgedAt,
      contacts: c?.n ?? 0, consents: consents?.n ?? 0, suppressed: s?.n ?? 0,
      history: purges.map((p) => ({ id: p.id, kind: p.kind, counts: p.counts, ranAt: p.ranAt })),
    };
  });
}

/** The scheduled job: finds campaigns past their retention date and deletes their personal data. Run it daily. */
/**
 * Service offices: removes the personal details from requests that were closed more than `ticketRetentionDays` ago
 * (name, request text, notes, phone link). Category, area, dates and status stay, so the monthly reports and the
 * "work done" export keep working. A resident whose only trace was those requests (and a consent to texts about them) is
 * deleted too; opted-out numbers stay on the do-not-contact list as hashes.
 */
export async function purgeOldTickets(deps: Deps, tenantId: string) {
  return withTenant(deps.pool, tenantId, async (db) => {
    const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    if (!t?.ticketRetentionDays) return { tickets: 0, contacts: 0 };
    const cutoff = new Date(now(deps).getTime() - t.ticketRetentionDays * 86_400_000);
    const old = await db.select({ id: schema.tickets.id, contactId: schema.tickets.contactId }).from(schema.tickets).where(and(
      isNull(schema.tickets.scrubbedAt), inArray(schema.tickets.status, ['resolved', 'closed', 'rejected']), lt(sql`coalesce(${schema.tickets.closedAt}, ${schema.tickets.resolvedAt}, ${schema.tickets.updatedAt})`, cutoff)));
    const contactIds = [...new Set(old.map((x) => x.contactId).filter((x): x is string => Boolean(x)))];
    for (const x of old) await scrubTicket(db, x.id, now(deps));
    let removed = 0;
    for (const cid of contactIds) {
      const [stillUsed] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.tickets).where(eq(schema.tickets.contactId, cid));
      const [otherConsent] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.consents).where(and(eq(schema.consents.contactId, cid), ne(schema.consents.purpose, 'service')));
      if ((stillUsed?.n ?? 0) === 0 && (otherConsent?.n ?? 0) === 0) { await db.delete(schema.contacts).where(eq(schema.contacts.id, cid)); removed++; }
    }
    if (old.length) {
      await db.insert(schema.dataPurges).values({ tenantId, kind: 'retention', counts: { tickets: old.length, contacts: removed } });
      await db.insert(schema.auditLog).values({ tenantId, action: 'purge_old_tickets', entity: 'tenant', entityId: tenantId, after: { tickets: old.length, contacts: removed } });
    }
    return { tickets: old.length, contacts: removed };
  });
}

export async function purgeDueTenants(deps: Deps) {
  const { rows } = await deps.pool.query('SELECT id FROM tenants_due_for_purge($1)', [now(deps)]);
  const results: { tenantId: string; counts?: Record<string, number>; error?: string }[] = [];
  for (const { id } of rows as { id: string }[]) {
    try {
      const r = await purgeTenantData(deps, id, { kind: 'retention' });
      results.push({ tenantId: id, counts: r && !r.alreadyPurged ? r.counts : undefined });
    } catch (e) {
      console.error('[privacy] purge failed for tenant', id, (e as Error).message);
      results.push({ tenantId: id, error: (e as Error).message });
    }
  }
  // Service offices: the same daily job removes personal details from old closed requests.
  const offices = await deps.pool.query('SELECT id FROM tenants_with_ticket_retention()');
  for (const { id } of offices.rows as { id: string }[]) {
    try {
      const r = await purgeOldTickets(deps, id);
      if (r.tickets) results.push({ tenantId: id, counts: { tickets: r.tickets, contacts: r.contacts } });
    } catch (e) {
      console.error('[privacy] ticket purge failed for tenant', id, (e as Error).message);
      results.push({ tenantId: id, error: (e as Error).message });
    }
  }
  return results;
}
