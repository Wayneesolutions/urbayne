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
  purpose: text('purpose', { enum: ['info', 'survey', 'reminder', 'donation'] }).notNull(),
  channel: text('channel', { enum: ['voice', 'sms', 'ai_answer'] }).notNull(),
  textVersion: text('text_version').notNull(),
  locale: text('locale').notNull(),
  capturedVia: text('captured_via').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
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
