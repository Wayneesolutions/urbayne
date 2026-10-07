import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, withTenant, EVENT_KINDS } from '@cs/db';
import { smsFor, fillDltTemplate, DLT_SUGGESTED_TEMPLATES } from '@cs/channels';
import { HttpError, ah } from '../../lib/http.js';
import { decrypt } from '../../lib/crypto.js';
import { channelEnv, now } from '../../lib/util.js';
import { loadTenant, requireRole } from '../../middleware/auth.js';
import { planRoute } from './route.js';
import { upsertEventExpense } from '../finance/routes.js';
import { assertWithinPlan } from '../billing/metering.js';
import type { Deps, TenantRow } from '../../types.js';

const MANAGERS = ['owner', 'manager', 'coordinator'] as const;
/** Events that always need official permission in India (rallies, public meetings, vehicles). */
const IN_PERMISSION_REQUIRED = new Set(['sabha', 'rally', 'vehicle']);

export function opsRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool, env } = deps;
  r.use(loadTenant(deps));

  // ----- events -----
  r.get('/events', ah(async (req, res) => {
    const rows = await withTenant(pool, req.tenant!.id, async (db) => {
      const ev = await db.select({ e: schema.events, area: schema.geoAreas.nameEn }).from(schema.events)
        .leftJoin(schema.geoAreas, eq(schema.geoAreas.id, schema.events.geoAreaId)).orderBy(asc(schema.events.startsAt));
      const sh = await db.select().from(schema.shifts);
      const asg = await db.select().from(schema.shiftAssignments);
      return ev.map(({ e, area }) => ({
        ...e, area,
        shifts: sh.filter((s) => s.eventId === e.id).map((s) => ({ ...s, assigned: asg.filter((a) => a.shiftId === s.id).length })),
      }));
    });
    res.json(rows);
  }));

  r.post('/events', requireRole(...MANAGERS), ah(async (req, res) => {
    const b = z.object({
      kind: z.enum(EVENT_KINDS), title: z.string().min(1).max(160), geoAreaId: z.string().uuid().optional(), location: z.string().max(200).optional(),
      startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }).optional(),
    }).parse(req.body);
    const t = req.tenant!;
    const [row] = await withTenant(pool, t.id, (db) => db.insert(schema.events).values({
      tenantId: t.id, ...b, startsAt: new Date(b.startsAt), endsAt: b.endsAt ? new Date(b.endsAt) : null,
    }).returning());
    res.status(201).json(row);
  }));

  r.patch('/events/:eventId', requireRole(...MANAGERS), ah(async (req, res) => {
    const b = z.object({
      permissionStatus: z.enum(['not_needed', 'not_applied', 'applied', 'granted', 'refused']).optional(),
      permissionRef: z.string().max(80).optional(),
      status: z.enum(['planned', 'confirmed', 'done', 'cancelled']).optional(),
      costMinor: z.number().int().positive().optional(),
    }).parse(req.body);
    const t = req.tenant!;
    const row = await withTenant(pool, t.id, async (db) => {
      const [ev] = await db.select().from(schema.events).where(eq(schema.events.id, req.params.eventId!));
      if (!ev) throw new HttpError(404, 'NOT_FOUND');
      const next = { ...ev, ...b };
      if (t.region === 'IN' && IN_PERMISSION_REQUIRED.has(next.kind) && next.permissionStatus === 'not_needed') {
        throw new HttpError(422, 'PERMISSION_REQUIRED', 'Rallies, sabhas and vehicles need official permission.');
      }
      if (next.permissionStatus === 'granted' && !next.permissionRef) throw new HttpError(422, 'PERMISSION_REF_REQUIRED', 'Enter the permission reference number.');
      if ((next.status === 'confirmed' || next.status === 'done') && !['granted', 'not_needed'].includes(next.permissionStatus)) {
        throw new HttpError(422, 'PERMISSION_NOT_GRANTED', 'An event can only be confirmed once its permission is granted.');
      }
      const [u] = await db.update(schema.events).set({ ...b, updatedAt: new Date() }).where(eq(schema.events.id, ev.id)).returning();
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'update', entity: 'event', entityId: ev.id, before: ev, after: u, ip: req.ip });
      // Costs of a finished event go straight into the finance register.
      if (u!.status === 'done' && u!.costMinor) await upsertEventExpense(db, t, u!, req.user!.id);
      return u;
    });
    res.json(row);
  }));

  // ----- shifts and volunteers -----
  r.post('/shifts', requireRole(...MANAGERS), ah(async (req, res) => {
    const b = z.object({ eventId: z.string().uuid().optional(), title: z.string().min(1).max(120), startsAt: z.string().datetime({ offset: true }), needed: z.number().int().min(1).max(500).default(1) }).parse(req.body);
    const t = req.tenant!;
    const [row] = await withTenant(pool, t.id, (db) => db.insert(schema.shifts).values({ tenantId: t.id, ...b, startsAt: new Date(b.startsAt) }).returning());
    res.status(201).json(row);
  }));

  r.get('/volunteers', requireRole(...MANAGERS), ah(async (req, res) => {
    const rows = await withTenant(pool, req.tenant!.id, (db) => db.select({ id: schema.contacts.id, name: schema.contacts.name, area: schema.geoAreas.nameEn })
      .from(schema.contacts).leftJoin(schema.geoAreas, eq(schema.geoAreas.id, schema.contacts.geoAreaId))
      .where(and(eq(schema.contacts.optedOut, false))).orderBy(schema.contacts.name));
    res.json(rows);
  }));

  r.post('/shifts/:shiftId/assign', requireRole(...MANAGERS), ah(async (req, res) => {
    const b = z.object({ contactIds: z.array(z.string().uuid()).min(1).max(200) }).parse(req.body);
    const t = req.tenant!;
    await withTenant(pool, t.id, (db) => db.insert(schema.shiftAssignments).values(b.contactIds.map((contactId) => ({ tenantId: t.id, shiftId: req.params.shiftId!, contactId }))).onConflictDoNothing());
    res.json({ ok: true });
  }));

  /** Shift reminders by SMS, only to volunteers who agreed to reminder texts. With Redis it runs as a background job. */
  r.post('/shifts/:shiftId/remind', requireRole(...MANAGERS), ah(async (req, res) => {
    const t = req.tenant!;
    const unavailable = reminderSmsProblem(deps, t);
    if (unavailable) throw new HttpError(422, 'SMS_PROVIDER_NOT_CONFIGURED', unavailable);
    const exists = await withTenant(pool, t.id, async (db) => (await db.select({ id: schema.shifts.id }).from(schema.shifts).where(eq(schema.shifts.id, req.params.shiftId!)))[0]);
    if (!exists) throw new HttpError(404, 'NOT_FOUND');
    if (deps.queues) {
      await deps.queues.enqueueReminders(t.id, req.params.shiftId!);
      return res.status(202).json({ queued: true });
    }
    res.json(await sendShiftReminders(deps, t, req.params.shiftId!));
  }));

  // ----- lawn signs (Canada) -----
  r.get('/signs', requireRole(...MANAGERS), ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, (db) => db.select().from(schema.signs).orderBy(schema.signs.createdAt)));
  }));
  r.post('/signs', requireRole(...MANAGERS), ah(async (req, res) => {
    const b = z.object({ address: z.string().min(3).max(200), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), contactId: z.string().uuid().optional() }).parse(req.body);
    const [row] = await withTenant(pool, req.tenant!.id, (db) => db.insert(schema.signs).values({ tenantId: req.tenant!.id, ...b }).returning());
    res.status(201).json(row);
  }));
  r.patch('/signs/:signId', requireRole(...MANAGERS), ah(async (req, res) => {
    const b = z.object({ status: z.enum(['requested', 'placed', 'collected']) }).parse(req.body);
    const [row] = await withTenant(pool, req.tenant!.id, (db) => db.update(schema.signs).set({ ...b, updatedAt: new Date() }).where(eq(schema.signs.id, req.params.signId!)).returning());
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    res.json(row);
  }));
  r.get('/signs/route', requireRole(...MANAGERS), ah(async (req, res) => {
    const status = z.enum(['requested', 'placed']).default('requested').parse(req.query.status);
    const t = req.tenant!;
    const pts = await withTenant(pool, t.id, (db) => db.select().from(schema.signs).where(eq(schema.signs.status, status)));
    const located = pts.filter((p) => p.lat != null && p.lng != null).map((p) => ({ id: p.id, lat: p.lat!, lng: p.lng! }));
    if (!located.length) return res.json({ order: [], km: 0, unlocated: pts.length });
    const start = t.officeLat != null && t.officeLng != null ? { lat: t.officeLat, lng: t.officeLng } : located[0]!;
    const plan = planRoute(start, located);
    res.json({
      start, km: plan.km, unlocated: pts.length - located.length,
      order: plan.order.map((o) => { const s = pts.find((p) => p.id === o.id)!; return { id: s.id, address: s.address, lat: s.lat, lng: s.lng }; }),
    });
  }));

  return r;
}

function smsFor_(deps: Deps, t: TenantRow) {
  try { return smsFor({ isDemo: t.isDemo, region: t.region }, channelEnv(deps)); } catch { return null; }
}

/** Why reminders cannot be sent for this campaign right now, or null when they can. */
export function reminderSmsProblem(deps: Deps, t: TenantRow): string | null {
  if (smsFor_(deps, t)) return null;
  return t.region === 'IN' ? 'India SMS needs the DLT provider set up first.' : 'SMS provider not configured.';
}

/**
 * Sends reminders for one shift. Safe to run from several workers at once: assignment rows are
 * locked with FOR UPDATE SKIP LOCKED, so a volunteer is never texted twice for the same shift.
 */
export async function sendShiftReminders(deps: Deps, t: TenantRow, shiftId: string) {
  const sms = smsFor_(deps, t);
  if (!sms) throw new HttpError(422, 'SMS_PROVIDER_NOT_CONFIGURED', reminderSmsProblem(deps, t) ?? undefined);
  return withTenant(deps.pool, t.id, async (db) => {
    const [shift] = await db.select().from(schema.shifts).where(eq(schema.shifts.id, shiftId));
    if (!shift) throw new HttpError(404, 'NOT_FOUND');
    const rows = await db.select({ a: schema.shiftAssignments, c: schema.contacts }).from(schema.shiftAssignments)
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.shiftAssignments.contactId))
      .where(and(eq(schema.shiftAssignments.shiftId, shift.id), isNull(schema.shiftAssignments.remindedAt)))
      .for('update', { of: schema.shiftAssignments, skipLocked: true });
    const consented = rows.length ? await db.select().from(schema.consents).where(and(
      inArray(schema.consents.contactId, rows.map((x) => x.c.id)), eq(schema.consents.channel, 'sms'), eq(schema.consents.purpose, 'reminder'), isNull(schema.consents.withdrawnAt),
    )) : [];
    await assertWithinPlan(db, t, 'smsSent', now(deps), rows.length);
    let sent = 0, skipped = 0, failed = 0;
    const when = shift.startsAt.toLocaleString(t.region === 'IN' ? 'en-IN' : 'en-CA', { timeZone: t.timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' });

    // India live SMS: the text must be the registered DLT template with only the {#var#} slots filled.
    let body = `${t.campaignName}: reminder, ${shift.title}, ${when}. Reply STOP to opt out.`;
    let template: { id: string; body: string } | null = null;
    if (t.region === 'IN' && !sms.simulated) {
      const [tpl] = await db.select().from(schema.contentItems).where(and(
        eq(schema.contentItems.kind, 'sms_template'), eq(schema.contentItems.templateKey, 'shift_reminder'),
        eq(schema.contentItems.dltStatus, 'registered'), inArray(schema.contentItems.status, ['approved', 'certified']),
      ));
      if (!tpl?.dltTemplateId) {
        throw new HttpError(422, 'DLT_TEMPLATE_REQUIRED', `Register an approved SMS template with templateKey "shift_reminder" on the DLT portal first. Suggested text: ${DLT_SUGGESTED_TEMPLATES.shift_reminder.body}`);
      }
      try { body = fillDltTemplate(tpl.body, [t.campaignName, shift.title, when]); }
      catch (e) { throw new HttpError(422, 'DLT_VARIABLE_PROBLEM', (e as Error).message); }
      template = { id: tpl.dltTemplateId, body: tpl.body };
    }

    for (const { a, c } of rows) {
      if (c.optedOut || !consented.some((x) => x.contactId === c.id)) { skipped++; continue; }
      const [i] = await db.insert(schema.interactions).values({ tenantId: t.id, contactId: c.id, channel: 'sms', direction: 'outbound', status: 'in_progress' }).returning();
      const r2 = await sms.send({ to: decrypt(c.phoneEnc, deps.env.PHONE_ENC_KEY), body, templateId: template?.id, templateBody: template?.body, metadata: { tenantId: t.id, interactionId: i!.id } });
      await db.update(schema.interactions).set({ status: r2.status === 'failed' ? 'failed' : 'completed', provider: r2.provider, providerRef: r2.providerRef || null, startedAt: now(deps) }).where(eq(schema.interactions.id, i!.id));
      if (r2.status === 'failed') { failed++; continue; } // not marked as reminded, so a retry can still reach this person
      await db.update(schema.shiftAssignments).set({ remindedAt: now(deps) }).where(eq(schema.shiftAssignments.id, a.id));
      sent++;
    }
    return { sent, skipped, failed, simulated: sms.simulated };
  });
}
