import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { schema, type withTenant } from '@cs/db';
import { HttpError } from '../../lib/http.js';
import { NEXT_STATUS, STATUS_WORDS, type Category, type Status } from './categories.js';
import type { TenantRow } from '../../types.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];
export type Ticket = typeof schema.tickets.$inferSelect;

/** Roles that can be given a ticket. */
export const SERVICE_ROLES = ['owner', 'manager', 'service_staff'] as const;

export interface NewTicket {
  channel: Ticket['channel'];
  category: Category;
  title: string;
  description?: string | null;
  geoAreaId?: string | null;
  areaText?: string | null;
  contactId?: string | null;
  requesterName?: string | null;
  language?: string | null;
  priority?: Ticket['priority'];
  /** Provider id (call id, message id): the same one again returns the existing ticket instead of a second one. */
  sourceRef?: string | null;
  createdBy?: string | null;
}

/** Days to resolve: the office's service level, shortened for urgent and high priority. */
export function dueDate(from: Date, slaDays: number, priority: Ticket['priority']): Date {
  const days = priority === 'urgent' ? Math.max(1, Math.ceil(slaDays / 3)) : priority === 'high' ? Math.max(1, Math.ceil(slaDays / 2)) : slaDays;
  return new Date(from.getTime() + days * 86_400_000);
}

/** The team member for an area: the route set on the area itself, else the nearest one up the tree. */
export async function routeFor(db: Db, geoAreaId: string | null | undefined): Promise<string | null> {
  let id = geoAreaId ?? null;
  for (let depth = 0; id && depth < 8; depth++) {
    const [route] = await db.select().from(schema.serviceRoutes).where(eq(schema.serviceRoutes.geoAreaId, id));
    if (route) return route.userId;
    const [area] = await db.select({ parentId: schema.geoAreas.parentId }).from(schema.geoAreas).where(eq(schema.geoAreas.id, id));
    id = area?.parentId ?? null;
  }
  return null;
}

/** Matches what a person said or typed to a known area: by code, then by exact name in any language. */
export async function resolveArea(db: Db, input: { areaId?: string | null; areaCode?: string | null; areaText?: string | null }): Promise<string | null> {
  if (input.areaId) {
    const [a] = await db.select({ id: schema.geoAreas.id }).from(schema.geoAreas).where(eq(schema.geoAreas.id, input.areaId));
    return a?.id ?? null;
  }
  const code = input.areaCode?.trim();
  if (code) {
    const [a] = await db.select({ id: schema.geoAreas.id }).from(schema.geoAreas).where(sql`lower(${schema.geoAreas.code}) = ${code.toLowerCase()}`);
    if (a) return a.id;
  }
  const text = input.areaText?.trim();
  if (text) {
    const [a] = await db.select({ id: schema.geoAreas.id }).from(schema.geoAreas)
      .where(or(ilike(schema.geoAreas.nameEn, text), ilike(schema.geoAreas.namePa, text), ilike(schema.geoAreas.nameHi, text), sql`lower(${schema.geoAreas.code}) = ${text.toLowerCase()}`));
    if (a) return a.id;
  }
  return null;
}

export async function addEvent(db: Db, tenantId: string, ticketId: string, e: { kind: typeof schema.ticketEvents.$inferInsert['kind']; visibility?: 'internal' | 'public'; actorId?: string | null; body?: string | null; meta?: unknown }) {
  await db.insert(schema.ticketEvents).values({ tenantId, ticketId, kind: e.kind, visibility: e.visibility ?? 'internal', actorId: e.actorId ?? null, body: e.body ?? null, meta: e.meta ?? null });
}

export async function createTicket(db: Db, tenant: TenantRow, input: NewTicket, now: Date): Promise<{ ticket: Ticket; duplicate: boolean }> {
  if (input.sourceRef) {
    const [existing] = await db.select().from(schema.tickets).where(and(eq(schema.tickets.channel, input.channel), eq(schema.tickets.sourceRef, input.sourceRef)));
    if (existing) return { ticket: existing, duplicate: true };
  }
  // The counter row is locked by this update, so two requests at the same moment get different numbers.
  const [seqRow] = await db.update(schema.tenants).set({ ticketSeq: sql`${schema.tenants.ticketSeq} + 1` }).where(eq(schema.tenants.id, tenant.id)).returning({ seq: schema.tenants.ticketSeq });
  const seq = seqRow!.seq;
  const priority = input.priority ?? 'normal';
  const assignedTo = await routeFor(db, input.geoAreaId);
  const [ticket] = await db.insert(schema.tickets).values({
    tenantId: tenant.id, seq, ref: `T-${String(seq).padStart(4, '0')}`, channel: input.channel, category: input.category,
    title: input.title, description: input.description ?? null, geoAreaId: input.geoAreaId ?? null, areaText: input.areaText ?? null,
    contactId: input.contactId ?? null, requesterName: input.requesterName ?? null, language: input.language ?? null,
    status: assignedTo ? 'assigned' : 'new', priority, assignedTo, dueAt: dueDate(now, tenant.serviceSlaDays, priority),
    sourceRef: input.sourceRef ?? null, createdBy: input.createdBy ?? null, createdAt: now, updatedAt: now,
  }).returning();
  await addEvent(db, tenant.id, ticket!.id, { kind: 'created', visibility: 'public', actorId: input.createdBy, body: STATUS_WORDS.new, meta: { channel: input.channel } });
  if (assignedTo) await addEvent(db, tenant.id, ticket!.id, { kind: 'assigned', visibility: 'internal', meta: { userId: assignedTo, auto: true } });
  return { ticket: ticket!, duplicate: false };
}

export interface TicketPatch {
  status?: Status;
  assignedTo?: string | null;
  priority?: Ticket['priority'];
  category?: Category;
  geoAreaId?: string | null;
  resolutionNote?: string;
}

/** Applies a staff change, checks it is allowed, and writes the timeline. Returns the ticket and whether the resident should get a status text. */
export async function changeTicket(db: Db, tenant: TenantRow, ticket: Ticket, patch: TicketPatch, actorId: string, now: Date): Promise<{ ticket: Ticket; notifyStatus: Status | null }> {
  const set: Partial<typeof schema.tickets.$inferInsert> = { updatedAt: now };
  let status: Status = ticket.status;
  let notifyStatus: Status | null = null;

  if (patch.assignedTo !== undefined && patch.assignedTo !== ticket.assignedTo) {
    if (patch.assignedTo) {
      const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, patch.assignedTo));
      if (!m || !(SERVICE_ROLES as readonly string[]).includes(m.role)) throw new HttpError(422, 'ASSIGNEE_NOT_SERVICE_STAFF', 'Tickets can only be assigned to the owner, a manager or service staff.');
    }
    set.assignedTo = patch.assignedTo;
    await addEvent(db, tenant.id, ticket.id, { kind: 'assigned', actorId, meta: { userId: patch.assignedTo, from: ticket.assignedTo } });
    if (patch.status === undefined && ticket.status === 'new' && patch.assignedTo) status = 'assigned';
    if (patch.status === undefined && ticket.status === 'assigned' && !patch.assignedTo) status = 'new';
  }
  if (patch.priority && patch.priority !== ticket.priority) {
    set.priority = patch.priority;
    set.dueAt = dueDate(ticket.createdAt, tenant.serviceSlaDays, patch.priority);
    await addEvent(db, tenant.id, ticket.id, { kind: 'edited', actorId, body: `priority ${ticket.priority} -> ${patch.priority}` });
  }
  if (patch.category && patch.category !== ticket.category) {
    set.category = patch.category;
    await addEvent(db, tenant.id, ticket.id, { kind: 'edited', actorId, body: `category ${ticket.category} -> ${patch.category}` });
  }
  if (patch.geoAreaId !== undefined && patch.geoAreaId !== ticket.geoAreaId) {
    set.geoAreaId = patch.geoAreaId;
    await addEvent(db, tenant.id, ticket.id, { kind: 'edited', actorId, body: 'area changed' });
  }
  if (patch.status && patch.status !== ticket.status) {
    if (!NEXT_STATUS[ticket.status].includes(patch.status)) {
      throw new HttpError(409, 'INVALID_TRANSITION', `A ticket that is ${ticket.status.replace('_', ' ')} cannot become ${patch.status.replace('_', ' ')}.`);
    }
    status = patch.status;
  }
  if (status !== ticket.status) {
    const note = (patch.resolutionNote ?? ticket.resolutionNote ?? '').trim();
    if ((status === 'resolved' || status === 'rejected') && note.length < 5) {
      throw new HttpError(422, 'NOTE_REQUIRED', status === 'resolved' ? 'Say what was done (at least 5 characters).' : 'Say why it was not accepted (at least 5 characters).');
    }
    set.status = status;
    if (patch.resolutionNote !== undefined) set.resolutionNote = patch.resolutionNote;
    if (status === 'resolved') set.resolvedAt = now;
    if (status === 'closed') set.closedAt = now;
    if (status === 'in_progress' && ticket.status === 'resolved') set.resolvedAt = null; // reopened
    await addEvent(db, tenant.id, ticket.id, { kind: 'status', visibility: 'public', actorId, body: STATUS_WORDS[status], meta: { from: ticket.status, to: status } });
    if (status === 'in_progress' || status === 'resolved' || status === 'rejected' || status === 'closed') notifyStatus = status;
  } else if (patch.resolutionNote !== undefined) {
    set.resolutionNote = patch.resolutionNote;
  }
  // A person on the team has now acted on it.
  if (!ticket.firstResponseAt) set.firstResponseAt = now;

  const [updated] = await db.update(schema.tickets).set(set).where(eq(schema.tickets.id, ticket.id)).returning();
  return { ticket: updated!, notifyStatus };
}

export async function addNote(db: Db, tenant: TenantRow, ticket: Ticket, actorId: string, body: string, visibility: 'internal' | 'public', now: Date) {
  await addEvent(db, tenant.id, ticket.id, { kind: 'note', visibility, actorId, body });
  if (!ticket.firstResponseAt) await db.update(schema.tickets).set({ firstResponseAt: now, updatedAt: now }).where(eq(schema.tickets.id, ticket.id));
}

export const SCRUBBED = '[removed]';

/** Removes what identifies the resident from a ticket and its timeline. Category, area, dates and status stay, for reports. */
export async function scrubTicket(db: Db, ticketId: string, now: Date) {
  await db.update(schema.tickets).set({
    title: SCRUBBED, description: null, areaText: null, requesterName: null, contactId: null, resolutionNote: null, scrubbedAt: now, updatedAt: now,
  }).where(eq(schema.tickets.id, ticketId));
  // The timeline is append-only for the app, so notes cannot be edited: scrubbing goes through a database function (see migration 0012).
  await db.execute(sql`SELECT scrub_ticket_events(${ticketId}::uuid)`);
}
