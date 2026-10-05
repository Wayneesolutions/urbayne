import { TwilioSms, DltSms, fillDltTemplate } from '@cs/channels';
import type { Env } from '../env.js';

/** Delivers a login code to a phone. Returns false when delivery failed (never throws provider details). */
export interface OtpSender {
  readonly name: string;
  send(phone: string, code: string): Promise<boolean>;
}

export const otpMessage = (code: string, ttlMinutes: number) =>
  `Your login code is ${code}. It is valid for ${ttlMinutes} minutes. Do not share it with anyone.`;

/** Development only: prints the code to the server log. Refused in production by env validation. */
export class ConsoleOtp implements OtpSender {
  readonly name = 'console';
  async send(phone: string, code: string) {
    console.log(`[otp] ${phone.slice(0, -4)}**** -> ${code}`);
    return true;
  }
}

/** Canada: real SMS through the Twilio Messaging Service. */
export class TwilioOtp implements OtpSender {
  readonly name = 'twilio';
  constructor(private sms: TwilioSms, private ttlMinutes: number) {}
  async send(phone: string, code: string) {
    try {
      const r = await this.sms.send({ to: phone, body: otpMessage(code, this.ttlMinutes), metadata: { tenantId: '', interactionId: '' } });
      return r.status !== 'failed';
    } catch {
      return false;
    }
  }
}

/** India: login code through the DLT-registered OTP template (the sent text must match what was registered). */
export class DltOtp implements OtpSender {
  readonly name = 'dlt';
  constructor(private sms: DltSms, private templateId: string, private templateText: string) {}
  async send(phone: string, code: string) {
    try {
      const body = fillDltTemplate(this.templateText, [code]);
      const r = await this.sms.send({ to: phone, body, templateId: this.templateId, templateBody: this.templateText, metadata: { tenantId: '', interactionId: '' } });
      return r.status !== 'failed';
    } catch {
      return false;
    }
  }
}

export function otpSenderFor(env: Env, ttlMinutes: number): OtpSender {
  if (env.OTP_PROVIDER === 'twilio') {
    return new TwilioOtp(
      new TwilioSms({ accountSid: env.TWILIO_ACCOUNT_SID!, authToken: env.TWILIO_AUTH_TOKEN!, messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID! }),
      ttlMinutes,
    );
  }
  if (env.OTP_PROVIDER === 'dlt') {
    return new DltOtp(
      new DltSms({ authKey: env.DLT_AUTH_KEY!, senderId: env.DLT_SENDER_ID!, baseUrl: env.DLT_BASE_URL }),
      env.DLT_OTP_TEMPLATE_ID!, env.DLT_OTP_TEMPLATE_TEXT!,
    );
  }
  return new ConsoleOtp();
}
