import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { smsFor, fillDltTemplate, DLT_SUGGESTED_TEMPLATES } from '@cs/channels';
import { decrypt } from '../../lib/crypto.js';
import { channelEnv, now } from '../../lib/util.js';
import { STATUS_WORDS, type Status } from './categories.js';
import { addEvent } from './tickets.js';
import type { Deps } from '../../types.js';

export type NotifyKind = 'ack' | 'status';
export type NotifyResult = 'sent' | 'failed' | `skipped:${string}`;

/**
 * Texts the resident about their request: an acknowledgement when it is received, and a status update when the team
 * moves it. Only to someone who agreed to texts about this request and has not opted out. In India the text is the
 * registered DLT template with the slots filled; if no such template is registered, nothing is sent and the timeline
 * says why, so staff can fix it. This is a reply to the person's own request, not campaign messaging.
 */
export async function notifyTicket(deps: Deps, tenantId: string, ticketId: string, kind: NotifyKind, status?: Status): Promise<NotifyResult> {
  return withTenant(deps.pool, tenantId, async (db): Promise<NotifyResult> => {
    const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));
    if (!tenant || !ticket || ticket.scrubbedAt) return 'skipped:gone';
    if (!ticket.contactId) return 'skipped:no_phone';
    if (kind === 'ack' && ticket.acknowledgedAt) return 'skipped:already_sent';

    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, ticket.contactId));
    if (!contact || contact.optedOut) return 'skipped:opted_out';
    const [consent] = await db.select().from(schema.consents).where(and(
      eq(schema.consents.contactId, contact.id), eq(schema.consents.purpose, 'service'), eq(schema.consents.channel, 'sms'), isNull(schema.consents.withdrawnAt)));
    if (!consent) return 'skipped:no_consent';

    const word = STATUS_WORDS[status ?? ticket.status];
    if (kind === 'status') {
      const [last] = await db.select().from(schema.ticketEvents).where(and(eq(schema.ticketEvents.ticketId, ticket.id), eq(schema.ticketEvents.kind, 'update_sent'))).orderBy(desc(schema.ticketEvents.id)).limit(1);
      if ((last?.meta as { status?: string } | null)?.status === (status ?? ticket.status)) return 'skipped:already_sent';
    }

    let sms;
    try { sms = smsFor({ isDemo: tenant.isDemo, region: tenant.region }, channelEnv(deps)); }
    catch {
      await addEvent(db, tenantId, ticket.id, { kind: 'sms_failed', body: 'SMS provider is not configured for this office' });
      return 'skipped:sms_not_configured';
    }

    const name = tenant.candidateName || tenant.campaignName;
    let body = kind === 'ack'
      ? `${name}: request ${ticket.ref} received. We will update you. Reply STOP to opt out.`
      : `${name}: request ${ticket.ref} is now ${word}. Reply STOP to opt out.`;
    let template: { id: string; body: string } | null = null;
    if (tenant.region === 'IN' && !sms.simulated) {
      const key = kind === 'ack' ? 'ticket_ack' : 'ticket_status';
      const [tpl] = await db.select().from(schema.contentItems).where(and(
        eq(schema.contentItems.kind, 'sms_template'), eq(schema.contentItems.templateKey, key),
        eq(schema.contentItems.dltStatus, 'registered'), inArray(schema.contentItems.status, ['approved', 'certified'])));
      if (!tpl?.dltTemplateId) {
        await addEvent(db, tenantId, ticket.id, { kind: 'sms_failed', body: `No registered DLT template "${key}". Suggested text: ${DLT_SUGGESTED_TEMPLATES[key].body}` });
        return 'skipped:dlt_template_missing';
      }
      try { body = fillDltTemplate(tpl.body, kind === 'ack' ? [name, ticket.ref] : [name, ticket.ref, word]); }
      catch (e) {
        await addEvent(db, tenantId, ticket.id, { kind: 'sms_failed', body: `Template problem: ${(e as Error).message}` });
        return 'skipped:dlt_variable_problem';
      }
      template = { id: tpl.dltTemplateId, body: tpl.body };
    }

    const [i] = await db.insert(schema.interactions).values({ tenantId, contactId: contact.id, channel: 'sms', direction: 'outbound', status: 'in_progress' }).returning();
    const r = await sms.send({ to: decrypt(contact.phoneEnc, deps.env.PHONE_ENC_KEY), body, templateId: template?.id, templateBody: template?.body, metadata: { tenantId, interactionId: i!.id } });
    await db.update(schema.interactions).set({ status: r.status === 'failed' ? 'failed' : 'completed', provider: r.provider, providerRef: r.providerRef || null, startedAt: now(deps) }).where(eq(schema.interactions.id, i!.id));
    if (r.status === 'failed') {
      await addEvent(db, tenantId, ticket.id, { kind: 'sms_failed', body: `The ${kind === 'ack' ? 'acknowledgement' : 'status'} text could not be sent`, meta: { reason: r.reason ?? null } });
      return 'failed';
    }
    if (kind === 'ack') {
      await db.update(schema.tickets).set({ acknowledgedAt: now(deps), updatedAt: now(deps) }).where(eq(schema.tickets.id, ticket.id));
      await addEvent(db, tenantId, ticket.id, { kind: 'ack_sent', meta: { seconds: Math.round((now(deps).getTime() - ticket.createdAt.getTime()) / 1000) } });
    } else {
      await addEvent(db, tenantId, ticket.id, { kind: 'update_sent', meta: { status: status ?? ticket.status } });
    }
    return 'sent';
  });
}

/** Sends the text in the background: as a queue job when Redis is configured, otherwise right after this request in this process. */
export async function queueTicketSms(deps: Deps, tenantId: string, ticketId: string, kind: NotifyKind, status?: Status): Promise<void> {
  if (deps.queues) return deps.queues.enqueueTicketSms(tenantId, ticketId, kind, status);
  setImmediate(() => notifyTicket(deps, tenantId, ticketId, kind, status).catch((e) => deps.log.error({ err: e, ticketId }, 'ticket text failed')));
}
