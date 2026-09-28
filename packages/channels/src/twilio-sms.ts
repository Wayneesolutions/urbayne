import type { SmsChannel, SmsRequest, SmsResult } from './types.js';

export interface TwilioSmsConfig { accountSid: string; authToken: string; messagingServiceSid: string }

/** Canada SMS via a Twilio Messaging Service (STOP handling enabled on the service). */
export class TwilioSms implements SmsChannel {
  readonly name = 'twilio-sms';
  readonly simulated = false;
  constructor(private cfg: TwilioSmsConfig, private fetchImpl: typeof fetch = fetch) {}

  async send(req: SmsRequest): Promise<SmsResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`;
    const form = new URLSearchParams({ To: req.to, Body: req.body, MessagingServiceSid: this.cfg.messagingServiceSid });
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    if (!res.ok) return { provider: this.name, providerRef: '', status: 'failed' };
    const body = (await res.json()) as { sid?: string };
    return { provider: this.name, providerRef: body.sid ?? '', status: 'queued' };
  }
}
