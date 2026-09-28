import { MockSms, MockVoice } from './mock.js';
import { VapiVoice, type VapiConfig } from './vapi.js';
import { TwilioSms, type TwilioSmsConfig } from './twilio-sms.js';
import type { SmsChannel, VoiceChannel } from './types.js';

export * from './types.js';
export { MockVoice, MockSms, VapiVoice, TwilioSms };

export interface ChannelEnv {
  vapi?: VapiConfig | null;
  twilioSms?: TwilioSmsConfig | null;
}

/**
 * Demo tenants ALWAYS get simulated channels, whatever keys are configured:
 * a demo can never dial a real person. Live tenants need real provider config.
 */
export function voiceFor(tenant: { isDemo: boolean; region: 'IN' | 'CA' }, env: ChannelEnv): VoiceChannel {
  if (tenant.isDemo) return new MockVoice();
  if (!env.vapi) throw new Error('VOICE_PROVIDER_NOT_CONFIGURED');
  return new VapiVoice(env.vapi);
}

export function smsFor(tenant: { isDemo: boolean; region: 'IN' | 'CA' }, env: ChannelEnv): SmsChannel {
  if (tenant.isDemo) return new MockSms();
  if (tenant.region === 'CA' && env.twilioSms) return new TwilioSms(env.twilioSms);
  // India DLT provider adapter lands once the provider is chosen.
  throw new Error('SMS_PROVIDER_NOT_CONFIGURED');
}
