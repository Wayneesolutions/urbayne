import type { CallRequest, CallResult, VoiceChannel } from './types.js';

export interface VapiConfig {
  apiKey: string;
  /** Vapi phone number id: a Twilio number (CA) or a Plivo/140-series number (IN) imported into Vapi. */
  phoneNumberId: string;
  /** Pre-built Vapi assistant used as the base; script and survey are passed as overrides. */
  assistantId: string;
  baseUrl?: string;
  /**
   * Where Vapi reports each finished call, and the secret it sends back (X-Vapi-Secret). Set per call so the report always
   * reaches this deployment (the right region) whatever the assistant itself is configured with.
   */
  serverUrl?: string;
  webhookSecret?: string;
  /** Keep Vapi's audio recording. Default false: a voter's voice is personal data, and nothing here needs it. */
  recording?: boolean;
}

/** Shape the webhook parser expects in `analysis.structuredData` (and that the per-call analysis plan asks Vapi to produce). */
export interface StructuredCallData {
  answers: Record<string, string>;
  optOut: boolean;
  consent?: { purposes: string[]; textVersion: string };
}

/**
 * Real outbound calls through Vapi.
 *
 * Verified against Vapi's public docs (POST /call fields, analysisPlan, artifactPlan, DELETE /call/{id}, end-of-call-report):
 * see docs/vapi-setup.md. A real call has NOT been placed from this code: run `pnpm --filter @cs/api vapi:verify` with your
 * keys (and your own phone number) before the first live campaign.
 */
export class VapiVoice implements VoiceChannel {
  readonly name = 'vapi';
  readonly simulated = false;
  constructor(private cfg: VapiConfig, private fetchImpl: typeof fetch = fetch) {}

  private get base() { return this.cfg.baseUrl ?? 'https://api.vapi.ai'; }
  private get headers() { return { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' }; }

  /** JSON schema that tells Vapi's analysis step exactly which structured data to extract after the call. */
  analysisSchema(req: Pick<CallRequest, 'survey' | 'consent'>) {
    const answers = Object.fromEntries((req.survey ?? []).map((q) => [q.key, {
      type: 'string', enum: q.options.map((o) => o.value),
      description: `${q.question} Leave out if the person did not answer. Keypad digits: ${q.options.map((o) => `${o.dtmf}=${o.value}`).join(', ')}.`,
    }]));
    const properties: Record<string, unknown> = {
      answers: { type: 'object', properties: answers, additionalProperties: false },
      optOut: { type: 'boolean', description: 'True if the person asked to stop receiving calls (for example said stop, band karo, do not call).' },
    };
    if (req.consent) {
      properties.consent = {
        type: 'object',
        properties: {
          purposes: { type: 'array', items: { type: 'string', enum: req.consent.purposes }, description: 'Only the purposes the person clearly agreed to.' },
          textVersion: { type: 'string', enum: [req.consent.textVersion] },
        },
      };
    }
    return { type: 'object', properties, required: ['answers', 'optOut'] };
  }

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
        variableValues: { locale: req.locale, survey: surveyText, ...(req.consent && { consentTextVersion: req.consent.textVersion }) },
        metadata: req.metadata,
        ...(this.cfg.serverUrl && { server: { url: this.cfg.serverUrl, ...(this.cfg.webhookSecret && { secret: this.cfg.webhookSecret }) } }),
        artifactPlan: { recordingEnabled: this.cfg.recording === true },
        analysisPlan: {
          structuredDataPlan: {
            structuredDataPrompt: 'Extract the survey answers the person gave (by speech or keypad), whether they asked to stop being called, and any consent they clearly gave. Never guess: leave an answer out if it was not given.',
            structuredDataSchema: this.analysisSchema(req),
          },
        },
      },
      metadata: req.metadata,
    };
  }

  async startCall(req: CallRequest): Promise<CallResult> {
    try {
      const res = await this.fetchImpl(`${this.base}/call`, { method: 'POST', headers: this.headers, body: JSON.stringify(this.buildRequest(req)) });
      if (!res.ok) return { provider: this.name, providerRef: '', status: 'failed' };
      const body = (await res.json()) as { id?: string };
      if (!body.id) return { provider: this.name, providerRef: '', status: 'failed' };
      return { provider: this.name, providerRef: body.id, status: 'queued' };
    } catch {
      return { provider: this.name, providerRef: '', status: 'failed' };
    }
  }

  /** The call as Vapi has it now (cost is final here, which the webhook's copy may not be). Null when it cannot be read. */
  async getCall(id: string): Promise<Record<string, any> | null> {
    try {
      const res = await this.fetchImpl(`${this.base}/call/${encodeURIComponent(id)}`, { headers: this.headers });
      return res.ok ? ((await res.json()) as Record<string, any>) : null;
    } catch {
      return null;
    }
  }

  /** Deletes the call at Vapi (recording, transcript, messages). Used when a campaign's retention period ends. A 404 counts as deleted. */
  async deleteCall(id: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base}/call/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }
}
