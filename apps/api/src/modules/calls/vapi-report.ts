/**
 * Turns a Vapi end-of-call report (webhook `message`, or the call object from GET /call/{id}) into what the platform stores.
 * Pure functions, so the same code is used by the webhook, the cost reconciliation job and `pnpm vapi:verify`.
 * Field names follow Vapi's public docs; everything is read defensively because Vapi adds fields over time.
 */
import type { schema } from '@cs/db';

type SurveyQuestion = schema.SurveyQuestion;

export type CallStatus = 'completed' | 'no_answer' | 'failed';

// Reasons from Vapi's "call ended reason" list, grouped by what they mean for a voter campaign.
const NO_ANSWER = new Set([
  'customer-did-not-answer', 'customer-busy', 'voicemail', 'silence-timed-out', 'assistant-join-timed-out',
  'call.in-progress.error-assistant-did-not-receive-customer-audio',
]);
const COMPLETED = new Set([
  'hangup', 'customer-ended-call', 'assistant-ended-call', 'assistant-ended-call-after-message-spoken',
  'assistant-ended-call-with-hangup-task', 'assistant-said-end-call-phrase', 'exceeded-max-duration', 'assistant-forwarded-call',
]);

/**
 * Maps Vapi's endedReason to our status. Reasons that mean the call never properly started (wrong config, limits, provider
 * errors) are `failed` so they show up in the run instead of looking like unanswered phones. Unknown reasons are `failed`
 * too, unless the person clearly took part (they gave answers), because guessing "completed" would hide a problem.
 */
export function mapEndedReason(reason: unknown, gaveAnswers = false): CallStatus {
  const r = typeof reason === 'string' ? reason : '';
  if (NO_ANSWER.has(r)) return 'no_answer';
  if (COMPLETED.has(r)) return 'completed';
  if (r && !r.includes('error') && !r.startsWith('call.start') && gaveAnswers) return 'completed';
  return 'failed';
}

/** Keeps only answers that match the survey that was actually asked: a known question key and one of its option values. */
export function sanitizeAnswers(survey: SurveyQuestion[] | null | undefined, raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!survey || !raw || typeof raw !== 'object') return out;
  for (const q of survey) {
    const v = (raw as Record<string, unknown>)[q.key];
    if (typeof v === 'string' && q.options.some((o) => o.value === v)) out[q.key] = v;
  }
  return out;
}

export interface ParsedReport {
  tenantId?: string;
  interactionId?: string;
  providerRef?: string;
  endedReason?: string;
  status: CallStatus;
  durationSec: number;
  transcript: string | null;
  answers: Record<string, string>;
  optOut: boolean;
  consent?: { purposes: unknown; textVersion: unknown };
  locale?: string;
  /** Provider cost in USD micro-dollars, or null when Vapi has not reported a (non-zero) cost yet. */
  costUsdMicros: number | null;
  hasRecording: boolean;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export function parseEndOfCall(msg: any, survey?: SurveyQuestion[] | null): ParsedReport {
  const call = msg?.call ?? msg ?? {};
  const meta = (call.metadata ?? call.assistantOverrides?.metadata ?? msg?.metadata ?? {}) as { tenantId?: string; interactionId?: string };
  const analysis = msg?.analysis ?? call.analysis ?? {};
  const sd = (analysis.structuredData ?? {}) as Record<string, unknown>;
  const artifact = msg?.artifact ?? call.artifact ?? {};

  const answers = sanitizeAnswers(survey, sd.answers);
  const endedReason = (msg?.endedReason ?? call.endedReason) as string | undefined;

  // Vapi does not always send a duration: fall back to start/end times, then to the last message's offset.
  let durationSec = num(msg?.durationSeconds) ?? num(call.durationSeconds);
  if (durationSec == null) {
    const s = Date.parse(call.startedAt ?? msg?.startedAt ?? ''), e = Date.parse(call.endedAt ?? msg?.endedAt ?? '');
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) durationSec = (e - s) / 1000;
  }
  if (durationSec == null && Array.isArray(artifact.messages)) {
    durationSec = Math.max(0, ...artifact.messages.map((m: any) => num(m?.secondsFromStart) ?? 0));
  }

  const cost = num(msg?.cost) ?? num(call.cost);
  const consent = sd.consent && typeof sd.consent === 'object' ? (sd.consent as { purposes: unknown; textVersion: unknown }) : undefined;
  const transcript = typeof msg?.transcript === 'string' ? msg.transcript : typeof artifact.transcript === 'string' ? artifact.transcript : null;

  return {
    tenantId: meta.tenantId,
    interactionId: meta.interactionId,
    providerRef: typeof call.id === 'string' ? call.id : undefined,
    endedReason,
    status: mapEndedReason(endedReason, Object.keys(answers).length > 0),
    durationSec: Math.round(durationSec ?? 0),
    transcript,
    answers,
    optOut: sd.optOut === true,
    consent,
    locale: typeof sd.locale === 'string' ? sd.locale : undefined,
    // A cost of 0 usually means "not final yet" (Vapi's webhook copy can be sent before billing is computed).
    costUsdMicros: cost != null && cost > 0 ? Math.round(cost * 1_000_000) : null,
    hasRecording: Boolean(artifact.recording ?? msg?.recordingUrl ?? call.recordingUrl),
  };
}
