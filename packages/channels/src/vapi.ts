import type { CallRequest, CallResult, VoiceChannel } from './types.js';

export interface VapiConfig {
  apiKey: string;
  /** Vapi phone number id: a Twilio number (CA) or a Plivo/140-series number (IN) imported into Vapi. */
  phoneNumberId: string;
  /** Pre-built Vapi assistant used as the base; script and survey are passed as overrides. */
  assistantId: string;
  baseUrl?: string;
}

/**
 * Real outbound calls through Vapi (existing WayneRing setup).
 * NOTE: verify request fields against the current Vapi API docs before the first live run;
 * this adapter is exercised only through its request builder in tests.
 */
export class VapiVoice implements VoiceChannel {
  readonly name = 'vapi';
  readonly simulated = false;
  constructor(private cfg: VapiConfig, private fetchImpl: typeof fetch = fetch) {}

  buildRequest(req: CallRequest) {
    const surveyText = (req.survey ?? [])
      .map((q) => `${q.question} ${q.options.map((o) => `${o.dtmf}: ${o.label}`).join(', ')}`)
      .join('\n');
    return {
      phoneNumberId: this.cfg.phoneNumberId,
      assistantId: this.cfg.assistantId,
      customer: { number: req.to },
      assistantOverrides: {
        // The first thing the caller hears is the approved script, which starts with the disclosure.
        firstMessage: req.script,
        variableValues: { locale: req.locale, survey: surveyText },
        metadata: req.metadata,
      },
      metadata: req.metadata,
    };
  }

  async startCall(req: CallRequest): Promise<CallResult> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl ?? 'https://api.vapi.ai'}/call`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildRequest(req)),
    });
    if (!res.ok) return { provider: this.name, providerRef: '', status: 'failed' };
    const body = (await res.json()) as { id?: string };
    return { provider: this.name, providerRef: body.id ?? '', status: 'queued' };
  }
}
