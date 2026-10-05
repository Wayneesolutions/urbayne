export interface SurveyOption { value: string; label: string; dtmf: string }
export interface SurveyQuestion { key: string; question: string; options: SurveyOption[] }

export interface CallRequest {
  to: string;              // E.164
  locale: string;
  script: string;          // approved text; already starts with the disclosure
  survey?: SurveyQuestion[] | null;
  metadata: { tenantId: string; interactionId: string; runId?: string };
}

/**
 * Mock providers finish synchronously ('completed' | 'no_answer' | 'failed').
 * Real providers return 'queued' and report the outcome later via webhook.
 */
export interface CallResult {
  provider: string;
  providerRef: string;
  status: 'queued' | 'completed' | 'no_answer' | 'failed';
  durationSec?: number;
  transcript?: string;
  answers?: Record<string, string>;
  optOut?: boolean;
  followUp?: boolean;
}

export interface VoiceChannel {
  readonly name: string;
  readonly simulated: boolean;
  startCall(req: CallRequest): Promise<CallResult>;
}

export interface SmsRequest { to: string; body: string; templateId?: string | null; /** Registered template text with {#var#} slots (India DLT): the body must match it. */ templateBody?: string | null; metadata: { tenantId: string; interactionId: string } }
export interface SmsResult { provider: string; providerRef: string; status: 'queued' | 'sent' | 'failed'; /** Why it failed, when known (never contains the message or the number). */ reason?: string }

export interface SmsChannel {
  readonly name: string;
  readonly simulated: boolean;
  send(req: SmsRequest): Promise<SmsResult>;
}
