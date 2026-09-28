import { createHash } from 'node:crypto';
import type { CallRequest, CallResult, SmsChannel, SmsRequest, SmsResult, VoiceChannel } from './types.js';

/** Deterministic 0..1 from a string, so demo results are stable run to run. */
const rand = (seed: string) => parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) / 0xffffffff;

/**
 * Simulated voice channel for demos and tests. It never dials anyone.
 * Outcome mix: ~72% answered, ~20% no answer, ~3% failed; ~4% of answered say "stop".
 */
export class MockVoice implements VoiceChannel {
  readonly name = 'mock-voice';
  readonly simulated = true;

  async startCall(req: CallRequest): Promise<CallResult> {
    const seed = `${req.metadata.runId ?? ''}:${req.to}`;
    const r = rand(seed);
    const providerRef = `mock_${createHash('sha1').update(seed).digest('hex').slice(0, 12)}`;
    if (r < 0.03) return { provider: this.name, providerRef, status: 'failed' };
    if (r < 0.23) return { provider: this.name, providerRef, status: 'no_answer' };

    const optOut = rand(seed + ':stop') < 0.04;
    const lines = [`AI: ${req.script.slice(0, 160)}${req.script.length > 160 ? '…' : ''}`];
    const answers: Record<string, string> = {};
    if (!optOut && req.survey?.length) {
      for (const q of req.survey) {
        // Skewed pick so charts look like real data rather than uniform noise.
        const x = rand(`${seed}:${q.key}`);
        const idx = Math.min(q.options.length - 1, Math.floor(Math.pow(x, 1.6) * q.options.length));
        const opt = q.options[idx]!;
        answers[q.key] = opt.value;
        lines.push(`AI: ${q.question}`, `Voter: [${opt.dtmf}] ${opt.label}`);
      }
    }
    if (optOut) lines.push('Voter: stop / band karo', 'AI: Understood, we will not call you again.');
    return {
      provider: this.name,
      providerRef,
      status: 'completed',
      durationSec: 25 + Math.round(rand(seed + ':d') * 70),
      transcript: lines.join('\n'),
      answers,
      optOut,
      followUp: !optOut && rand(seed + ':f') < 0.08,
    };
  }
}

export class MockSms implements SmsChannel {
  readonly name = 'mock-sms';
  readonly simulated = true;
  async send(req: SmsRequest): Promise<SmsResult> {
    return { provider: this.name, providerRef: `mocksms_${req.metadata.interactionId.slice(0, 8)}`, status: 'sent' };
  }
}
