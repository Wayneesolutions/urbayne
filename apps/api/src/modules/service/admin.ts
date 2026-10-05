import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { requireUser } from '../../middleware/auth.js';
import { now } from '../../lib/util.js';
import type { Deps } from '../../types.js';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const uuid = z.string().uuid();

export interface BillingRow { tenant_id: string; campaign_name: string; region: 'IN' | 'CA'; kind: string; plan: string; price_minor: string; sms_rate_minor: string; sms_included: number; tax_percent: string | null; status: string; started_on: string }

/** A date column as YYYY-MM-DD (node-postgres hands raw queries a Date at local midnight). */
const ymd = (v: unknown) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10));

const daysInMonth = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y!, mo!, 0)).getUTCDate(); };

/**
 * Builds one month's invoice for one subscription: the monthly price (pro rata in the first month), plus resident texts
 * beyond the included amount. Tax is added only when a tax rate has been set for the subscription: the right rate and the
 * invoice format (for example GST in India) must be confirmed with the accountant first.
 */
export function buildInvoice(sub: Pick<BillingRow, 'plan' | 'price_minor' | 'sms_rate_minor' | 'sms_included' | 'tax_percent' | 'started_on'>, m: string, smsSent: number) {
  const dim = daysInMonth(m);
  const start = ymd(sub.started_on);
  const monthStart = `${m}-01`;
  const monthEnd = `${m}-${String(dim).padStart(2, '0')}`;
  const activeDays = start <= monthStart ? dim : start > monthEnd ? 0 : dim - Number(start.slice(8, 10)) + 1;
  const lines: schema.InvoiceLine[] = [];
  const price = Number(sub.price_minor);
  const baseAmount = activeDays === dim ? price : Math.round((price * activeDays) / dim);
  if (activeDays > 0) lines.push({ description: activeDays === dim ? `${sub.plan} subscription, ${m}` : `${sub.plan} subscription, ${m} (${activeDays} of ${dim} days)`, quantity: 1, unitMinor: price, amountMinor: baseAmount });
  const extra = Math.max(0, smsSent - sub.sms_included);
  if (extra > 0 && Number(sub.sms_rate_minor) > 0) lines.push({ description: `Resident texts beyond the ${sub.sms_included} included (${smsSent} sent)`, quantity: extra, unitMinor: Number(sub.sms_rate_minor), amountMinor: extra * Number(sub.sms_rate_minor) });
  const subtotal = lines.reduce((s, l) => s + l.amountMinor, 0);
  const taxMinor = sub.tax_percent == null ? 0 : Math.round((subtotal * Number(sub.tax_percent)) / 100);
  return { lines, subtotalMinor: subtotal, taxMinor, totalMinor: subtotal + taxMinor };
}

/** Platform staff only: register inbound numbers, set subscriptions, run the monthly invoicing. */
export function serviceAdminRoutes(deps: Deps) {
  const r = Router();
  const { pool } = deps;
  r.use(requireUser(deps));
  r.use((req, _res, next) => (req.user!.wes ? next() : next(new HttpError(403, 'FORBIDDEN'))));

  // ----- numbers people text or call -----
  r.get('/service-numbers', ah(async (req, res) => {
    const tenantId = uuid.parse(req.query.tenantId);
    res.json(await withTenant(pool, tenantId, (db) => db.select().from(schema.serviceNumbers)));
  }));

  r.post('/service-numbers', ah(async (req, res) => {
    const b = z.object({ tenantId: uuid, kind: z.enum(['sms', 'voice']), identifier: z.string().min(3).max(80), provider: z.string().min(2).max(40) }).strict().parse(req.body);
    try {
      const row = await withTenant(pool, b.tenantId, async (db) => {
        const [t] = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, b.tenantId));
        if (!t) throw new HttpError(404, 'TENANT_NOT_FOUND');
        const [n] = await db.insert(schema.serviceNumbers).values({ tenantId: b.tenantId, kind: b.kind, identifier: b.identifier.trim(), provider: b.provider }).returning();
        await db.insert(schema.auditLog).values({ tenantId: b.tenantId, actorId: req.user!.id, action: 'register_service_number', entity: 'service_number', entityId: n!.id, after: { kind: b.kind, provider: b.provider }, ip: req.ip });
        return n!;
      });
      res.status(201).json(row);
    } catch (e: any) {
      if ((e?.cause ?? e)?.code === '23505') throw new HttpError(409, 'NUMBER_ALREADY_REGISTERED', 'This number already belongs to an office.');
      throw e;
    }
  }));

  r.delete('/service-numbers/:id', ah(async (req, res) => {
    const tenantId = uuid.parse(req.query.tenantId);
    const out = await withTenant(pool, tenantId, (db) => db.delete(schema.serviceNumbers).where(eq(schema.serviceNumbers.id, uuid.parse(req.params.id))).returning());
    if (!out.length) throw new HttpError(404, 'NOT_FOUND');
    res.json({ ok: true });
  }));

  // ----- subscriptions and invoices -----
  r.put('/tenants/:tenantId/subscription', ah(async (req, res) => {
    const tenantId = uuid.parse(req.params.tenantId);
    const b = z.object({
      plan: z.string().min(2).max(60), priceMinor: z.number().int().min(0), smsRateMinor: z.number().int().min(0).default(0), smsIncluded: z.number().int().min(0).default(0),
      taxPercent: z.number().min(0).max(100).nullable().default(null), status: z.enum(['trial', 'active', 'past_due', 'cancelled']).default('active'),
      startedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).strict().parse(req.body);
    const row = await withTenant(pool, tenantId, async (db) => {
      const [t] = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
      if (!t) throw new HttpError(404, 'TENANT_NOT_FOUND');
      const v = { plan: b.plan, priceMinor: b.priceMinor, smsRateMinor: b.smsRateMinor, smsIncluded: b.smsIncluded, taxPercent: b.taxPercent == null ? null : String(b.taxPercent), status: b.status, startedOn: b.startedOn, updatedAt: now(deps) };
      const [s] = await db.insert(schema.subscriptions).values({ tenantId, ...v }).onConflictDoUpdate({ target: schema.subscriptions.tenantId, set: v }).returning();
      await db.insert(schema.auditLog).values({ tenantId, actorId: req.user!.id, action: 'set_subscription', entity: 'subscription', entityId: tenantId, after: v, ip: req.ip });
      return s!;
    });
    res.json(row);
  }));

  /** Issues the invoice for a month for every active subscription. Safe to run twice: a month already invoiced is skipped. */
  r.post('/invoices/generate', ah(async (req, res) => {
    const m = month.parse(req.body?.month);
    const monthStart = `${m}-01`;
    const { rows } = await pool.query('SELECT * FROM billing_tenants()');
    const created: { tenantId: string; number: string; totalMinor: number; currency: string }[] = [];
    const skipped: { tenantId: string; reason: string }[] = [];
    for (const sub of rows as BillingRow[]) {
      if (sub.status !== 'active') { skipped.push({ tenantId: sub.tenant_id, reason: `subscription is ${sub.status}` }); continue; }
      if (ymd(sub.started_on) > `${m}-${String(daysInMonth(m)).padStart(2, '0')}`) { skipped.push({ tenantId: sub.tenant_id, reason: 'starts after this month' }); continue; }
      const out = await withTenant(pool, sub.tenant_id, async (db) => {
        const [existing] = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(and(eq(schema.invoices.tenantId, sub.tenant_id), eq(schema.invoices.periodStart, monthStart)));
        if (existing) return 'exists' as const;
        const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, sub.tenant_id));
        const from = sql`(${monthStart}::date)::timestamp AT TIME ZONE ${t!.timeZone}`;
        const to = sql`((${monthStart}::date + interval '1 month')::timestamp AT TIME ZONE ${t!.timeZone})`;
        const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.interactions)
          .where(and(eq(schema.interactions.channel, 'sms'), eq(schema.interactions.direction, 'outbound'), eq(schema.interactions.status, 'completed'), gte(schema.interactions.startedAt, sql`${from}`), lt(schema.interactions.startedAt, sql`${to}`)));
        const inv = buildInvoice(sub, m, c?.n ?? 0);
        if (!inv.lines.length) return 'empty' as const;
        const [row] = await db.insert(schema.invoices).values({
          tenantId: sub.tenant_id, number: `INV-${m}-${sub.tenant_id.slice(0, 8).toUpperCase()}`, periodStart: monthStart, periodEnd: `${m}-${String(daysInMonth(m)).padStart(2, '0')}`,
          currency: sub.region === 'IN' ? 'INR' : 'CAD', ...inv, status: 'issued',
        }).returning();
        await db.insert(schema.auditLog).values({ tenantId: sub.tenant_id, actorId: req.user!.id, action: 'issue_invoice', entity: 'invoice', entityId: row!.id, after: { number: row!.number, total: inv.totalMinor }, ip: req.ip });
        return row!;
      });
      if (out === 'exists') skipped.push({ tenantId: sub.tenant_id, reason: 'already invoiced' });
      else if (out === 'empty') skipped.push({ tenantId: sub.tenant_id, reason: 'nothing to invoice' });
      else created.push({ tenantId: sub.tenant_id, number: out.number, totalMinor: out.totalMinor, currency: out.currency });
    }
    res.status(201).json({ month: m, created, skipped });
  }));

  r.post('/invoices/:tenantId/:invoiceId/:action(paid|void)', ah(async (req, res) => {
    const tenantId = uuid.parse(req.params.tenantId);
    const row = await withTenant(pool, tenantId, async (db) => {
      const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, uuid.parse(req.params.invoiceId)));
      if (!inv) throw new HttpError(404, 'NOT_FOUND');
      if (inv.status !== 'issued') throw new HttpError(409, 'ALREADY_SETTLED', `This invoice is already ${inv.status}.`);
      const paid = req.params.action === 'paid';
      const [u] = await db.update(schema.invoices).set({ status: paid ? 'paid' : 'void', paidAt: paid ? now(deps) : null }).where(eq(schema.invoices.id, inv.id)).returning();
      await db.insert(schema.auditLog).values({ tenantId, actorId: req.user!.id, action: paid ? 'invoice_paid' : 'invoice_void', entity: 'invoice', entityId: inv.id, ip: req.ip });
      return u!;
    });
    res.json(row);
  }));

  r.get('/invoices', ah(async (req, res) => {
    const m = month.optional().parse(req.query.month);
    const { rows } = await pool.query('SELECT tenant_id, campaign_name FROM billing_tenants()');
    const out: unknown[] = [];
    for (const t of rows as { tenant_id: string; campaign_name: string }[]) {
      const list = await withTenant(pool, t.tenant_id, (db) => db.select().from(schema.invoices).where(m ? eq(schema.invoices.periodStart, `${m}-01`) : undefined));
      for (const i of list) out.push({ ...i, campaign: t.campaign_name });
    }
    res.json(out);
  }));

  return r;
}
