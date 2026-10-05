import { randomBytes } from 'node:crypto';
import type { Deps } from '../types.js';
import type { ChannelEnv } from '@cs/channels';

export const now = (deps: Deps) => (deps.now ? deps.now() : new Date());

export const maskPhone = (p: string) => (p.length > 6 ? `${p.slice(0, p.length - 7)}*****${p.slice(-2)}` : '****');

const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
export const shortCode = (n = 7) => Array.from(randomBytes(n), (b) => ALPHA[b % ALPHA.length]).join('');

export function channelEnv(deps: Deps): ChannelEnv {
  if (deps.channels) return deps.channels;
  const e = deps.env;
  return {
    vapi: e.VAPI_API_KEY && e.VAPI_PHONE_NUMBER_ID && e.VAPI_ASSISTANT_ID
      ? {
        apiKey: e.VAPI_API_KEY, phoneNumberId: e.VAPI_PHONE_NUMBER_ID, assistantId: e.VAPI_ASSISTANT_ID,
        // Every call reports back to this deployment, with the shared secret, and is not recorded unless VAPI_RECORDING=true.
        serverUrl: `${e.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhooks/vapi`, webhookSecret: e.VAPI_WEBHOOK_SECRET, recording: e.VAPI_RECORDING === 'true',
      } : null,
    twilioSms: e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_MESSAGING_SERVICE_SID
      ? { accountSid: e.TWILIO_ACCOUNT_SID, authToken: e.TWILIO_AUTH_TOKEN, messagingServiceSid: e.TWILIO_MESSAGING_SERVICE_SID } : null,
    dltSms: e.DLT_AUTH_KEY && e.DLT_SENDER_ID ? { authKey: e.DLT_AUTH_KEY, senderId: e.DLT_SENDER_ID, baseUrl: e.DLT_BASE_URL } : null,
  };
}
