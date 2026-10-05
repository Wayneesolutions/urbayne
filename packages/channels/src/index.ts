import { MockSms, MockVoice } from './mock.js';
import { VapiVoice, type VapiConfig } from './vapi.js';
import { TwilioSms, type TwilioSmsConfig } from './twilio-sms.js';
import { DltSms, type DltSmsConfig } from './dlt.js';
import type { SmsChannel, VoiceChannel } from './types.js';

export * from './types.js';
export { MockVoice, MockSms, VapiVoice, TwilioSms, DltSms };
export * from './dlt.js';

export interface ChannelEnv {
  vapi?: VapiConfig | null;
  twilioSms?: TwilioSmsConfig | null;
  dltSms?: DltSmsConfig | null;
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
  if (tenant.region === 'IN' && env.dltSms) return new DltSms(env.dltSms);
  throw new Error('SMS_PROVIDER_NOT_CONFIGURED');
}
