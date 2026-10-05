import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { recordOutcome } from './runner.js';
import { syncRunCost } from './cost.js';
import type { Deps } from '../../types.js';

/**
 * Vapi end-of-call webhook for live tenants. Payload fields follow Vapi's
 * "end-of-call-report" server message; verify against current Vapi docs.
 * Survey answers are expected in structured analysis data as { answers: { key: value } }.
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
    const meta = msg.call?.metadata ?? msg.call?.assistantOverrides?.metadata ?? {};
    const { tenantId, interactionId } = meta as { tenantId?: string; interactionId?: string };
    if (!tenantId || !interactionId) return res.json({ ignored: true });
    const answers = (msg.analysis?.structuredData?.answers ?? {}) as Record<string, string>;
    const optOut = Boolean(msg.analysis?.structuredData?.optOut);
    // Vapi reports the total call cost in USD; keep it so it can be charged to the campaign spending register.
    const rawCost = Number(msg.cost ?? msg.call?.cost);
    const costUsdMicros = Number.isFinite(rawCost) && rawCost >= 0 ? Math.round(rawCost * 1_000_000) : null;
    await withTenant(deps.pool, tenantId, async (db) => {
      const [i] = await db.select().from(schema.interactions).where(eq(schema.interactions.id, interactionId));
      if (!i || i.status !== 'in_progress') return;
      const ended = msg.endedReason === 'customer-did-not-answer' ? 'no_answer' : 'completed';
      await db.update(schema.interactions).set({
        status: ended, endedAt: new Date(), durationSec: Math.round(Number(msg.durationSeconds ?? 0)),
        transcript: typeof msg.transcript === 'string' ? msg.transcript : null, optedOut: optOut, costUsdMicros, updatedAt: new Date(),
      }).where(eq(schema.interactions.id, i.id));
      if (costUsdMicros && i.runId) {
        const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
        if (tenant) await syncRunCost(db, tenant, i.runId, deps.env);
      }
      if (ended === 'completed' && i.contactId) await recordOutcome(db, tenantId, i.id, i.contactId, answers, optOut);
    });
    res.json({ ok: true });
  }));
  return r;
}
