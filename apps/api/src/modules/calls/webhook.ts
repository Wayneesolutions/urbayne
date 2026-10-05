import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { recordOutcome } from './runner.js';
import { recordIvrConsent } from '../privacy/consent.js';
import { reconcileCallCost, syncRunCost } from './cost.js';
import { parseEndOfCall } from './vapi-report.js';
import type { Deps } from '../../types.js';

/**
 * Vapi end-of-call webhook for live tenants (message type "end-of-call-report", parsed by vapi-report.ts).
 * The call is matched to our interaction through the metadata we sent when placing it, and only if it is still
 * in progress, so a repeated delivery changes nothing.
 */
export function vapiWebhook(deps: Deps) {
  const r = Router();
  r.post('/vapi', ah(async (req, res) => {
    const secret = deps.env.VAPI_WEBHOOK_SECRET;
    const given = String(req.headers['x-vapi-secret'] ?? '');
    if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
      throw new HttpError(401, 'BAD_SIGNATURE');
    }
    const msg = req.body?.message;
    if (msg?.type !== 'end-of-call-report') return res.json({ ignored: true });
    const head = parseEndOfCall(msg);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!head.tenantId || !head.interactionId || !UUID.test(head.tenantId) || !UUID.test(head.interactionId)) return res.json({ ignored: true });
    const { tenantId, interactionId } = head;

    const needsCostLookup = await withTenant(deps.pool, tenantId, async (db) => {
      const [i] = await db.select().from(schema.interactions).where(eq(schema.interactions.id, interactionId));
      if (!i || i.status !== 'in_progress') return false;
      // Parse again with the survey that was actually asked, so answers that do not match it are dropped.
      const [item] = i.contentItemId ? await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, i.contentItemId)) : [];
      const p = parseEndOfCall(msg, item?.survey);
      if (p.hasRecording) deps.log.warn({ interactionId }, 'vapi sent a recording although recording is switched off for calls from this platform');

      await db.update(schema.interactions).set({
        status: p.status, endedAt: new Date(), durationSec: p.durationSec, transcript: p.transcript,
        optedOut: p.optOut, costUsdMicros: p.costUsdMicros, providerRef: i.providerRef ?? p.providerRef ?? null, updatedAt: new Date(),
      }).where(eq(schema.interactions.id, i.id));
      if (p.costUsdMicros && i.runId) {
        const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
        if (tenant) await syncRunCost(db, tenant, i.runId, deps.env);
      }
      if (p.status === 'completed' && i.contactId) {
        await recordOutcome(db, tenantId, i.id, i.contactId, p.answers, p.optOut);
        // Consent given on the call itself (only recorded when the provider says which consent text was played).
        if (!p.optOut) await recordIvrConsent(db, tenantId, i.id, i.contactId, p.locale ?? item?.locale ?? 'en', p.consent);
      }
      return p.costUsdMicros === null && p.status !== 'failed';
    });

    // Vapi's webhook copy of the cost can be missing or 0 before billing is final: ask again a little later.
    if (needsCostLookup) {
      if (deps.queues) await deps.queues.enqueueCallCost(tenantId, interactionId).catch((e) => deps.log.error({ err: e }, 'could not queue cost lookup'));
      else setTimeout(() => reconcileCallCost(deps, tenantId, interactionId).catch(() => {}), 60_000).unref();
    }
    res.json({ ok: true });
  }));
  return r;
}
