import { pgTable, uuid, text, timestamp, boolean, integer, bigint, jsonb, date, bigserial, doublePrecision, numeric } from 'drizzle-orm/pg-core';

// Mirrors migrations/0001_init.sql. The SQL file is the source of truth for
// constraints and RLS; this file gives typed queries.

const stamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  region: text('region', { enum: ['IN', 'CA'] }).notNull(),
  raceType: text('race_type').notNull(),
  seatCode: text('seat_code').notNull(),
  electionDate: date('election_date').notNull(),
  campaignName: text('campaign_name').notNull(),
  timeZone: text('time_zone').notNull(),
  pollCloseAt: timestamp('poll_close_at', { withTimezone: true }),
  enabledModules: text('enabled_modules').array().notNull().default([]),
  callingHoursOverride: jsonb('calling_hours_override'),
  spendLimitMinor: bigint('spend_limit_minor', { mode: 'number' }),
  status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
  overrideReason: text('override_reason'),
  isDemo: boolean('is_demo').notNull().default(false),
  slug: text('slug'),
  candidateName: text('candidate_name'),
  tagline: text('tagline'),
  officialInfoUrl: text('official_info_url'),
  financeLockedUntil: date('finance_locked_until'),
  contributionLimitMinor: bigint('contribution_limit_minor', { mode: 'number' }),
  officeLat: doublePrecision('office_lat'),
  officeLng: doublePrecision('office_lng'),
  /** 'office' = a sitting representative's service office: not deleted on an election date. */
  kind: text('kind', { enum: ['campaign', 'office'] }).notNull().default('campaign'),
  ticketSeq: integer('ticket_seq').notNull().default(0),
  serviceSlaDays: integer('service_sla_days').notNull().default(7),
  /** Personal details on closed tickets are removed this many days after closing. null = kept until the owner sets it. */
  ticketRetentionDays: integer('ticket_retention_days'),
  /** Personal data is deleted this many days after the election. null = not set, nothing is deleted automatically. */
  retentionDays: integer('retention_days'),
  purgedAt: timestamp('purged_at', { withTimezone: true }),
  /** Set when the results were frozen into the archive after the election: no more reports are accepted. */
  resultsArchivedAt: timestamp('results_archived_at', { withTimezone: true }),
  ...stamps,
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phoneHash: text('phone_hash').notNull().unique(),
  phoneEnc: text('phone_enc').notNull(),
  name: text('name'),
  locale: text('locale').notNull().default('en'),
  isWesAdmin: boolean('is_wes_admin').notNull().default(false),
  ...stamps,
});

export const otpCodes = pgTable('otp_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  phoneHash: text('phone_hash').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ROLES = ['owner', 'manager', 'finance_agent', 'coordinator', 'field_worker', 'agent_reporter', 'service_staff'] as const;
export type Role = (typeof ROLES)[number];

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  role: text('role', { enum: ROLES }).notNull(),
  ...stamps,
});

export const geoAreas = pgTable('geo_areas', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  parentId: uuid('parent_id'),
  level: text('level').notNull(),
  code: text('code'),
  nameEn: text('name_en').notNull(),
  namePa: text('name_pa'),
  nameHi: text('name_hi'),
  polygon: jsonb('polygon'),
  ...stamps,
});

export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  phoneHash: text('phone_hash').notNull(),
  phoneEnc: text('phone_enc').notNull(),
  name: text('name'),
  geoAreaId: uuid('geo_area_id'),
  timeZone: text('time_zone'),
  source: text('source', { enum: ['form', 'missed_call', 'roll', 'import'] }).notNull(),
  sourceProofFile: text('source_proof_file'),
  optedOut: boolean('opted_out').notNull().default(false),
  tags: text('tags').array().notNull().default([]),
  ...stamps,
});

export const consents = pgTable('consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  purpose: text('purpose', { enum: ['info', 'survey', 'reminder', 'donation', 'service'] }).notNull(),
  channel: text('channel', { enum: ['voice', 'sms', 'ai_answer'] }).notNull(),
  textVersion: text('text_version').notNull(),
  locale: text('locale').notNull(),
  capturedVia: text('captured_via').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  /** Paper: the form / sheet serial number. IVR: the call (interaction) id. */
  evidenceRef: text('evidence_ref'),
  capturedBy: uuid('captured_by'),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  ...stamps,
});

export const contentItems = pgTable('content_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ['script', 'sms_template', 'page', 'faq', 'ad'] }).notNull(),
  locale: text('locale').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status', { enum: ['draft', 'approved', 'certified'] }).notNull().default('draft'),
  certificateNo: text('certificate_no'),
  dltTemplateId: text('dlt_template_id'),
  /** India DLT: not_registered -> submitted -> registered | rejected. Only a registered template can be sent. */
  dltStatus: text('dlt_status', { enum: ['not_registered', 'submitted', 'registered', 'rejected'] }).notNull().default('not_registered'),
  dltHeader: text('dlt_header'),
  dltSubmittedAt: timestamp('dlt_submitted_at', { withTimezone: true }),
  dltRejectionReason: text('dlt_rejection_reason'),
  /** Which platform message this template is for (reminders need one registered 'shift_reminder' template). */
  templateKey: text('template_key', { enum: ['shift_reminder', 'ticket_ack', 'ticket_status'] }),
  approvedBy: uuid('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  geoAreaId: uuid('geo_area_id'),
  survey: jsonb('survey').$type<SurveyQuestion[] | null>(),
  ...stamps,
});

export interface SurveyQuestion {
  key: string;
  question: string;
  options: { value: string; label: string; dtmf: string }[];
}

export const campaignRuns = pgTable('campaign_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  channel: text('channel', { enum: ['voice', 'sms'] }).notNull(),
  contentItemId: uuid('content_item_id').notNull(),
  purpose: text('purpose', { enum: ['info', 'survey', 'reminder', 'donation'] }).notNull(),
  audience: jsonb('audience').$type<{ geoAreaIds?: string[]; tags?: string[] }>().notNull().default({}),
  status: text('status', { enum: ['draft', 'running', 'paused', 'completed', 'blocked'] }).notNull().default('draft'),
  gateResult: jsonb('gate_result'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  ...stamps,
});

export const interactions = pgTable('interactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  runId: uuid('run_id'),
  contactId: uuid('contact_id'),
  channel: text('channel').notNull(),
  direction: text('direction', { enum: ['outbound', 'inbound'] }).notNull(),
  contentItemId: uuid('content_item_id'),
  provider: text('provider'),
  providerRef: text('provider_ref'),
  status: text('status', { enum: ['queued', 'blocked', 'in_progress', 'completed', 'no_answer', 'failed'] }).notNull().default('queued'),
  blockReasons: jsonb('block_reasons'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSec: integer('duration_sec'),
  transcript: text('transcript'),
  aiDisclosed: boolean('ai_disclosed').notNull().default(false),
  optedOut: boolean('opted_out').notNull().default(false),
  followUp: boolean('follow_up').notNull().default(false),
  /** Provider-reported cost in millionths of a US dollar (null until the provider reports it). */
  costUsdMicros: bigint('cost_usd_micros', { mode: 'number' }),
  /** Set once the voice provider's copy of this call (transcript, recording) has been deleted. */
  providerDataDeletedAt: timestamp('provider_data_deleted_at', { withTimezone: true }),
  ...stamps,
});

export const surveyResponses = pgTable('survey_responses', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  interactionId: uuid('interaction_id').notNull(),
  questionKey: text('question_key').notNull(),
  answerValue: text('answer_value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shareLinks = pgTable('share_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  label: text('label').notNull(),
  geoAreaId: uuid('geo_area_id'),
  workerUserId: uuid('worker_user_id'),
  clicks: integer('clicks').notNull().default(0),
  signups: integer('signups').notNull().default(0),
  ...stamps,
});

export const assistantQuestions = pgTable('assistant_questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  question: text('question').notNull(),
  locale: text('locale').notNull(),
  outcome: text('outcome', { enum: ['answered', 'handoff', 'official_link'] }).notNull(),
  citedContentId: uuid('cited_content_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id'),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: text('ip'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------- Phase 2 ----------------

export const turfs = pgTable('turfs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  geoAreaId: uuid('geo_area_id').notNull(),
  name: text('name').notNull(),
  assignedUserId: uuid('assigned_user_id'),
  status: text('status', { enum: ['active', 'done'] }).notNull().default('active'),
  ...stamps,
});

export const VISIT_RESULTS = ['supporter', 'undecided', 'not_interested', 'not_home', 'needs_help', 'wants_sign'] as const;
export const doorVisits = pgTable('door_visits', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  turfId: uuid('turf_id').notNull(),
  contactId: uuid('contact_id'),
  household: text('household'),
  result: text('result', { enum: VISIT_RESULTS }).notNull(),
  note: text('note'),
  workerId: uuid('worker_id'),
  visitedAt: timestamp('visited_at', { withTimezone: true }).notNull(),
  clientUuid: uuid('client_uuid').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const EVENT_KINDS = ['sabha', 'rally', 'vehicle', 'door_knock', 'meeting', 'office_hours'] as const;
export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: EVENT_KINDS }).notNull(),
  title: text('title').notNull(),
  geoAreaId: uuid('geo_area_id'),
  location: text('location'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  permissionStatus: text('permission_status', { enum: ['not_needed', 'not_applied', 'applied', 'granted', 'refused'] }).notNull().default('not_applied'),
  permissionRef: text('permission_ref'),
  status: text('status', { enum: ['planned', 'confirmed', 'done', 'cancelled'] }).notNull().default('planned'),
  costMinor: bigint('cost_minor', { mode: 'number' }),
  ...stamps,
});

export const shifts = pgTable('shifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  eventId: uuid('event_id'),
  title: text('title').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  needed: integer('needed').notNull().default(1),
  ...stamps,
});

export const shiftAssignments = pgTable('shift_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  shiftId: uuid('shift_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const signs = pgTable('signs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  contactId: uuid('contact_id'),
  address: text('address').notNull(),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  status: text('status', { enum: ['requested', 'placed', 'collected'] }).notNull().default('requested'),
  ...stamps,
});

export const rateList = pgTable('rate_list', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  item: text('item').notNull(),
  unit: text('unit').notNull(),
  rateMinor: bigint('rate_minor', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const financeEntries = pgTable('finance_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ['contribution', 'expense'] }).notNull(),
  entryDate: date('entry_date').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  category: text('category').notNull(),
  description: text('description').notNull(),
  partyName: text('party_name').notNull(),
  partyAddress: text('party_address'),
  billNo: text('bill_no'),
  quantity: numeric('quantity'),
  unitRateMinor: bigint('unit_rate_minor', { mode: 'number' }),
  rateListId: uuid('rate_list_id'),
  paymentMode: text('payment_mode', { enum: ['cash', 'cheque', 'bank', 'upi', 'card', 'other'] }),
  eligibleAttested: boolean('eligible_attested').notNull().default(false),
  receiptNo: text('receipt_no'),
  receiptFile: text('receipt_file'),
  /** The uploaded receipt photo or PDF (stored_files). */
  receiptFileId: uuid('receipt_file_id'),
  source: text('source', { enum: ['manual', 'event', 'call_run'] }).notNull().default('manual'),
  sourceRef: uuid('source_ref'),
  flags: jsonb('flags').$type<{ code: string; message: string }[]>().notNull().default([]),
  createdBy: uuid('created_by'),
  ...stamps,
});

export const financeSignoffs = pgTable('finance_signoffs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  periodTo: date('period_to').notNull(),
  expenseMinor: bigint('expense_minor', { mode: 'number' }).notNull(),
  contributionMinor: bigint('contribution_minor', { mode: 'number' }).notNull(),
  entries: integer('entries').notNull(),
  signedBy: uuid('signed_by').notNull(),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Keyed phone hashes of people who must never be contacted again. Survives deletion of the contact itself. */
export const suppressions = pgTable('suppressions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  phoneHash: text('phone_hash').notNull(),
  reason: text('reason', { enum: ['opted_out', 'erasure_request'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A record of every deletion (counts only, never personal data). */
export const dataPurges = pgTable('data_purges', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ['retention', 'owner_request', 'contact_erasure'] }).notNull(),
  counts: jsonb('counts').$type<Record<string, number>>().notNull(),
  requestedBy: uuid('requested_by'),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
});
export const evidenceSeals = pgTable('evidence_seals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  runId: uuid('run_id').notNull(),
  sha256: text('sha256').notNull(),
  signature: text('signature').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const TICKET_CATEGORIES = ['water', 'roads', 'electricity', 'sanitation', 'health', 'welfare', 'education', 'safety', 'other'] as const;
export const TICKET_STATUSES = ['new', 'assigned', 'in_progress', 'resolved', 'closed', 'rejected'] as const;
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export const tickets = pgTable('tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  seq: integer('seq').notNull(),
  ref: text('ref').notNull(),
  channel: text('channel', { enum: ['web', 'sms', 'voice', 'office'] }).notNull(),
  category: text('category', { enum: TICKET_CATEGORIES }).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  geoAreaId: uuid('geo_area_id'),
  areaText: text('area_text'),
  contactId: uuid('contact_id'),
  requesterName: text('requester_name'),
  language: text('language'),
  status: text('status', { enum: TICKET_STATUSES }).notNull().default('new'),
  priority: text('priority', { enum: TICKET_PRIORITIES }).notNull().default('normal'),
  assignedTo: uuid('assigned_to'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  resolutionNote: text('resolution_note'),
  scrubbedAt: timestamp('scrubbed_at', { withTimezone: true }),
  sourceRef: text('source_ref'),
  createdBy: uuid('created_by'),
  ...stamps,
});

export const ticketEvents = pgTable('ticket_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  kind: text('kind', { enum: ['created', 'assigned', 'status', 'note', 'edited', 'ack_sent', 'update_sent', 'sms_failed'] }).notNull(),
  visibility: text('visibility', { enum: ['internal', 'public'] }).notNull().default('internal'),
  actorId: uuid('actor_id'),
  body: text('body'),
  meta: jsonb('meta'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const serviceRoutes = pgTable('service_routes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  geoAreaId: uuid('geo_area_id').notNull(),
  userId: uuid('user_id').notNull(),
});

export const serviceNumbers = pgTable('service_numbers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ['sms', 'voice'] }).notNull(),
  identifier: text('identifier').notNull(),
  provider: text('provider').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable('subscriptions', {
  tenantId: uuid('tenant_id').primaryKey(),
  plan: text('plan').notNull(),
  priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
  smsRateMinor: bigint('sms_rate_minor', { mode: 'number' }).notNull().default(0),
  smsIncluded: integer('sms_included').notNull().default(0),
  taxPercent: numeric('tax_percent', { precision: 5, scale: 2 }),
  status: text('status', { enum: ['trial', 'active', 'past_due', 'cancelled'] }).notNull().default('active'),
  startedOn: date('started_on').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export interface InvoiceLine { description: string; quantity: number; unitMinor: number; amountMinor: number }
export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  number: text('number').notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  currency: text('currency').notNull(),
  subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull(),
  taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
  totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
  lines: jsonb('lines').$type<InvoiceLine[]>().notNull(),
  status: text('status', { enum: ['issued', 'paid', 'void'] }).notNull().default('issued'),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------------------------------------------------
// Tool 7: poll day and counting day results. Reported by the campaign's own agents; official figures are typed in by the team.

export const pollingStations = pgTable('polling_stations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  geoAreaId: uuid('geo_area_id').notNull(),
  electors: integer('electors'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const resultAgents = pgTable('result_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  scope: text('scope', { enum: ['station', 'counting'] }).notNull(),
  geoAreaId: uuid('geo_area_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const candidates = pgTable('candidates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  party: text('party'),
  isOurs: boolean('is_ours').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const turnoutReports = pgTable('turnout_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  geoAreaId: uuid('geo_area_id').notNull(),
  agentId: uuid('agent_id'),
  clientUuid: uuid('client_uuid').notNull(),
  votesCast: integer('votes_cast').notNull(),
  asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  channel: text('channel', { enum: ['app', 'sms', 'office'] }).notNull(),
  flags: text('flags').array().notNull().default([]),
  meta: jsonb('meta'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by'),
});

const countCols = {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ['round', 'station'] }).notNull(),
  roundNo: integer('round_no'),
  geoAreaId: uuid('geo_area_id'),
  candidateId: uuid('candidate_id').notNull(),
  votes: integer('votes').notNull(),
};

export const countReports = pgTable('count_reports', {
  ...countCols,
  agentId: uuid('agent_id'),
  clientUuid: uuid('client_uuid').notNull(),
  channel: text('channel', { enum: ['app', 'sms', 'office'] }).notNull(),
  asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  flags: text('flags').array().notNull().default([]),
  meta: jsonb('meta'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by'),
});

export const officialCounts = pgTable('official_counts', {
  ...countCols,
  source: text('source', { enum: ['manual', 'csv'] }).notNull(),
  sourceNote: text('source_note').notNull(),
  enteredBy: uuid('entered_by'),
  enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
});

export const resultsArchives = pgTable('results_archives', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
  takenBy: uuid('taken_by'),
  summary: jsonb('summary').notNull(),
});

// ---------------------------------------------------------------------------------------------------------------------
// Phase 4: stored files and bank reconciliation.

export const FILE_PURPOSES = ['receipt', 'bank_statement', 'roll_proof', 'audio'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export const storedFiles = pgTable('stored_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  purpose: text('purpose', { enum: FILE_PURPOSES }).notNull(),
  storageKey: text('storage_key').notNull(),
  contentType: text('content_type').notNull(),
  bytes: integer('bytes').notNull(),
  sha256: text('sha256').notNull(),
  originalName: text('original_name'),
  uploadedBy: uuid('uploaded_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const rollImports = pgTable('roll_imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  geoAreaId: uuid('geo_area_id').notNull(),
  proofFileId: uuid('proof_file_id').notNull(),
  sourceKind: text('source_kind', { enum: ['electoral_roll_copy', 'other_legal_list'] }).notNull(),
  sourceDescription: text('source_description').notNull(),
  format: text('format', { enum: ['csv', 'xlsx', 'rows'] }).notNull(),
  rowsTotal: integer('rows_total').notNull(),
  rowsImported: integer('rows_imported').notNull(),
  rowsDuplicate: integer('rows_duplicate').notNull().default(0),
  rowsRejected: integer('rows_rejected').notNull().default(0),
  ignoredColumns: text('ignored_columns').array().notNull().default([]),
  importedBy: uuid('imported_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const households = pgTable('households', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  geoAreaId: uuid('geo_area_id').notNull(),
  rollImportId: uuid('roll_import_id').notNull(),
  houseNo: text('house_no').notNull(),
  address: text('address'),
  electors: integer('electors'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const bankStatements = pgTable('bank_statements', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  fileId: uuid('file_id'),
  label: text('label').notNull(),
  periodFrom: date('period_from'),
  periodTo: date('period_to'),
  lineCount: integer('line_count').notNull().default(0),
  uploadedBy: uuid('uploaded_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const bankLines = pgTable('bank_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  statementId: uuid('statement_id').notNull(),
  lineNo: integer('line_no').notNull(),
  lineDate: date('line_date').notNull(),
  description: text('description').notNull().default(''),
  reference: text('reference'),
  direction: text('direction', { enum: ['debit', 'credit'] }).notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  matchStatus: text('match_status', { enum: ['unmatched', 'suggested', 'matched', 'ignored'] }).notNull().default('unmatched'),
  matchedEntryId: uuid('matched_entry_id'),
  matchNote: text('match_note'),
  matchedBy: uuid('matched_by'),
  matchedAt: timestamp('matched_at', { withTimezone: true }),
});
