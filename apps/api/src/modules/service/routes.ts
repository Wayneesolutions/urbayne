import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { decrypt } from '../../lib/crypto.js';
import { maskPhone, now } from '../../lib/util.js';
import { loadTenant, requireRole } from '../../middleware/auth.js';
import { CATEGORIES, CATEGORY_LABELS, guessCategory, type Status } from './categories.js';
import { personForTicket } from './people.js';
import { queueTicketSms } from './sms.js';
import { addNote, changeTicket, createTicket, resolveArea, SERVICE_ROLES, type Ticket } from './tickets.js';
import { reportRoutes } from './reports.js';
import type { Deps } from '../../types.js';

const STAFF = ['owner', 'manager', 'service_staff'] as const;
const CLOSED: Status[] = ['resolved', 'closed', 'rejected'];

/** Constituent service: the office team's view of requests from residents. */
export function serviceRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool, env } = deps;
  r.use(loadTenant(deps));
  r.use(requireRole(...STAFF));

  r.get('/categories', (_req, res) => res.json(CATEGORIES.map((key) => ({ key, ...CATEGORY_LABELS[key] }))));

  /** People a ticket can be given to. */
  r.get('/team', ah(async (req, res) => {
    const rows = await withTenant(pool, req.tenant!.id, (db) => db.select({ id: schema.users.id, name: schema.users.name, role: schema.memberships.role })
      .from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(inArray(schema.memberships.role, [...SERVICE_ROLES])));
    res.json(rows);
  }));

  r.get('/tickets', ah(async (req, res) => {
    const t = req.tenant!;
    const q = z.object({
      status: z.enum(schema.TICKET_STATUSES).optional(), open: z.enum(['1']).optional(), category: z.enum(CATEGORIES).optional(), area: z.string().uuid().optional(),
      assigned: z.string().optional(), overdue: z.enum(['1']).optional(), q: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const tk = schema.tickets;
    const conds = [
      q.status && eq(tk.status, q.status), q.open && notInArray(tk.status, CLOSED), q.category && eq(tk.category, q.category), q.area && eq(tk.geoAreaId, q.area),
      q.assigned === 'me' ? eq(tk.assignedTo, req.user!.id) : q.assigned === 'unassigned' ? isNull(tk.assignedTo) : q.assigned ? eq(tk.assignedTo, z.string().uuid().parse(q.assigned)) : undefined,
      q.overdue && and(lt(tk.dueAt, now(deps)), notInArray(tk.status, CLOSED)),
      q.q && or(ilike(tk.title, `%${q.q.replace(/[%_\\]/g, '\\$&')}%`), ilike(tk.ref, `%${q.q.replace(/[%_\\]/g, '\\$&')}%`), ilike(tk.requesterName, `%${q.q.replace(/[%_\\]/g, '\\$&')}%`)),
    ].filter(Boolean) as ReturnType<typeof eq>[];
    const out = await withTenant(pool, t.id, async (db) => {
      const where = conds.length ? and(...conds) : undefined;
      const rows = await db.select({ t: tk, area: schema.geoAreas.nameEn, assignee: schema.users.name, phoneEnc: schema.contacts.phoneEnc })
        .from(tk).leftJoin(schema.geoAreas, eq(schema.geoAreas.id, tk.geoAreaId)).leftJoin(schema.users, eq(schema.users.id, tk.assignedTo)).leftJoin(schema.contacts, eq(schema.contacts.id, tk.contactId))
        .where(where).orderBy(desc(tk.createdAt)).limit(q.limit).offset(q.offset);
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(tk).where(where) as [{ n: number }];
      return { rows, total: n };
    });
    const nowMs = now(deps).getTime();
    res.json({
      total: out.total,
      items: out.rows.map(({ t: x, area, assignee, phoneEnc }) => ({
        id: x.id, ref: x.ref, title: x.title, category: x.category, status: x.status, priority: x.priority, channel: x.channel, area: area ?? x.areaText, assignedTo: x.assignedTo, assignee,
        requesterName: x.requesterName, phone: phoneEnc ? maskPhone(decrypt(phoneEnc, env.PHONE_ENC_KEY)) : null, dueAt: x.dueAt, createdAt: x.createdAt,
        overdue: Boolean(x.dueAt && x.dueAt.getTime() < nowMs && !CLOSED.includes(x.status)),
      })),
    });
  }));

  /** A request taken by the office (walk-in, phone call, letter). */
  r.post('/tickets', ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({
      category: z.enum(CATEGORIES).optional(), title: z.string().min(3).max(200), description: z.string().max(4000).optional(),
      areaId: z.string().uuid().optional(), areaCode: z.string().max(40).optional(), areaText: z.string().max(200).optional(),
      name: z.string().max(120).optional(), phone: z.string().max(30).optional(), smsConsent: z.boolean().default(false),
      priority: z.enum(schema.TICKET_PRIORITIES).default('normal'), language: z.enum(['pa', 'hi', 'en']).optional(),
    }).strict().parse(req.body);
    if (b.smsConsent && !b.phone) throw new HttpError(422, 'PHONE_REQUIRED', 'A phone number is needed to send updates by text.');
    const out = await withTenant(pool, t.id, async (db) => {
      const geoAreaId = await resolveArea(db, { areaId: b.areaId, areaCode: b.areaCode, areaText: b.areaText });
      const person = await personForTicket(db, t.id, env, { phone: b.phone, name: b.name, geoAreaId, smsConsent: b.smsConsent, via: 'form', locale: b.language ?? 'en', actorId: req.user!.id });
      const { ticket } = await createTicket(db, t, {
        channel: 'office', category: b.category ?? guessCategory(`${b.title} ${b.description ?? ''}`) ?? 'other', title: b.title, description: b.description, geoAreaId,
        areaText: geoAreaId ? null : b.areaText, contactId: person.contactId, requesterName: b.name, language: b.language, priority: b.priority, createdBy: req.user!.id,
      }, now(deps));
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'create', entity: 'ticket', entityId: ticket.id, ip: req.ip });
      return { ticket, texts: person.contactId !== null && person.smsConsent, suppressed: person.contactId === null && 'reason' in person && person.reason === 'SUPPRESSED' };
    });
    if (out.texts) await queueTicketSms(deps, t.id, out.ticket.id, 'ack');
    res.status(201).json({ id: out.ticket.id, ref: out.ticket.ref, status: out.ticket.status, assignedTo: out.ticket.assignedTo, dueAt: out.ticket.dueAt, ...(out.suppressed && { noTexts: 'This number asked not to be contacted: no texts will be sent.' }) });
  }));

  r.get('/tickets/:id', ah(async (req, res) => {
    const t = req.tenant!;
    const id = z.string().uuid().parse(req.params.id);
    const out = await withTenant(pool, t.id, async (db) => {
      const [x] = await db.select({ t: schema.tickets, area: schema.geoAreas.nameEn, assignee: schema.users.name, phoneEnc: schema.contacts.phoneEnc, optedOut: schema.contacts.optedOut })
        .from(schema.tickets).leftJoin(schema.geoAreas, eq(schema.geoAreas.id, schema.tickets.geoAreaId)).leftJoin(schema.users, eq(schema.users.id, schema.tickets.assignedTo))
        .leftJoin(schema.contacts, eq(schema.contacts.id, schema.tickets.contactId)).where(eq(schema.tickets.id, id));
      if (!x) return null;
      const events = await db.select({ e: schema.ticketEvents, actor: schema.users.name }).from(schema.ticketEvents)
        .leftJoin(schema.users, eq(schema.users.id, schema.ticketEvents.actorId)).where(eq(schema.ticketEvents.ticketId, id)).orderBy(asc(schema.ticketEvents.id));
      return { x, events };
    });
    if (!out) throw new HttpError(404, 'NOT_FOUND');
    const { x, events } = out;
    res.json({
      ...x.t, area: x.area, assignee: x.assignee, phone: x.phoneEnc ? maskPhone(decrypt(x.phoneEnc, env.PHONE_ENC_KEY)) : null, optedOut: x.optedOut ?? false,
      events: events.map(({ e, actor }) => ({ id: e.id, kind: e.kind, visibility: e.visibility, body: e.body, meta: e.meta, actor, at: e.createdAt })),
    });
  }));

  const canActOn = (req: { role?: string; user?: { id: string } }, ticket: Ticket) => {
    if (req.role === 'service_staff' && ticket.assignedTo && ticket.assignedTo !== req.user!.id) throw new HttpError(403, 'NOT_YOUR_TICKET', 'This request is assigned to someone else.');
  };

  r.patch('/tickets/:id', ah(async (req, res) => {
    const t = req.tenant!;
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({
      status: z.enum(schema.TICKET_STATUSES).optional(), assignedTo: z.string().uuid().nullable().optional(), priority: z.enum(schema.TICKET_PRIORITIES).optional(),
      category: z.enum(CATEGORIES).optional(), areaId: z.string().uuid().nullable().optional(), resolutionNote: z.string().max(2000).optional(), notify: z.boolean().default(true),
    }).strict().parse(req.body);
    const out = await withTenant(pool, t.id, async (db) => {
      const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, id));
      if (!ticket) throw new HttpError(404, 'NOT_FOUND');
      if (ticket.scrubbedAt) throw new HttpError(409, 'TICKET_ARCHIVED', 'Personal details were removed from this request; it can no longer be changed.');
      canActOn(req, ticket);
      // Reassigning is for owner and manager; service staff can take an unassigned request for themselves.
      if (b.assignedTo !== undefined && req.role === 'service_staff' && !(ticket.assignedTo === null && b.assignedTo === req.user!.id)) {
        throw new HttpError(403, 'FORBIDDEN', 'Only the owner or a manager can reassign requests.');
      }
      if (b.areaId) await resolveArea(db, { areaId: b.areaId }).then((a) => { if (!a) throw new HttpError(422, 'AREA_NOT_FOUND'); });
      const changed = await changeTicket(db, t, ticket, { status: b.status, assignedTo: b.assignedTo, priority: b.priority, category: b.category, geoAreaId: b.areaId, resolutionNote: b.resolutionNote }, req.user!.id, now(deps));
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'update', entity: 'ticket', entityId: id, after: b, ip: req.ip });
      return changed;
    });
    if (b.notify && out.notifyStatus && out.notifyStatus !== 'closed' && out.ticket.contactId) await queueTicketSms(deps, t.id, out.ticket.id, 'status', out.notifyStatus);
    res.json(out.ticket);
  }));

  r.post('/tickets/:id/notes', ah(async (req, res) => {
    const t = req.tenant!;
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({ body: z.string().min(1).max(2000), visibility: z.enum(['internal', 'public']).default('internal') }).strict().parse(req.body);
    await withTenant(pool, t.id, async (db) => {
      const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, id));
      if (!ticket) throw new HttpError(404, 'NOT_FOUND');
      if (ticket.scrubbedAt) throw new HttpError(409, 'TICKET_ARCHIVED');
      canActOn(req, ticket);
      await addNote(db, t, ticket, req.user!.id, b.body, b.visibility, now(deps));
    });
    res.status(201).json({ ok: true });
  }));

  // ----- which team member gets requests from which area -----
  r.get('/routes', ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, (db) => db.select({ areaId: schema.serviceRoutes.geoAreaId, area: schema.geoAreas.nameEn, level: schema.geoAreas.level, userId: schema.serviceRoutes.userId, user: schema.users.name })
      .from(schema.serviceRoutes).innerJoin(schema.geoAreas, eq(schema.geoAreas.id, schema.serviceRoutes.geoAreaId)).innerJoin(schema.users, eq(schema.users.id, schema.serviceRoutes.userId)).orderBy(asc(schema.geoAreas.nameEn))));
  }));

  r.put('/routes', requireRole('owner', 'manager'), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({ areaId: z.string().uuid(), userId: z.string().uuid().nullable() }).strict().parse(req.body);
    await withTenant(pool, t.id, async (db) => {
      const area = await resolveArea(db, { areaId: b.areaId });
      if (!area) throw new HttpError(422, 'AREA_NOT_FOUND');
      if (b.userId) {
        const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, b.userId));
        if (!m || !(SERVICE_ROLES as readonly string[]).includes(m.role)) throw new HttpError(422, 'ASSIGNEE_NOT_SERVICE_STAFF');
        await db.insert(schema.serviceRoutes).values({ tenantId: t.id, geoAreaId: b.areaId, userId: b.userId }).onConflictDoUpdate({ target: [schema.serviceRoutes.tenantId, schema.serviceRoutes.geoAreaId], set: { userId: b.userId } });
      } else {
        await db.delete(schema.serviceRoutes).where(eq(schema.serviceRoutes.geoAreaId, b.areaId));
      }
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'set_service_route', entity: 'geo_area', entityId: b.areaId, after: { userId: b.userId }, ip: req.ip });
    });
    res.json({ ok: true });
  }));

  /** The owner's own subscription and invoices. */
  r.get('/billing', requireRole('owner'), ah(async (req, res) => {
    const out = await withTenant(pool, req.tenant!.id, async (db) => ({
      subscription: (await db.select().from(schema.subscriptions))[0] ?? null,
      invoices: await db.select().from(schema.invoices).orderBy(desc(schema.invoices.periodStart)),
    }));
    res.json(out);
  }));

  /** Numbers registered for this office (people text or call these). Registered by platform staff. */
  r.get('/numbers', requireRole('owner', 'manager'), ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, (db) => db.select({ id: schema.serviceNumbers.id, kind: schema.serviceNumbers.kind, identifier: schema.serviceNumbers.identifier, provider: schema.serviceNumbers.provider }).from(schema.serviceNumbers)));
  }));

  r.use('/reports', reportRoutes(deps));
  return r;
}
