import type { RegionConfig } from './types.js';

const min = (h: number, m = 0) => h * 60 + m;

export const CA: RegionConfig = {
  code: 'CA',
  locales: ['en', 'pa', 'hi', 'tl', 'fr'],
  defaultLocale: 'en',
  defaultTimeZone: 'America/Winnipeg',
  currency: 'CAD',
  dataRegion: 'ca-central-1',
  voiceProvider: 'twilio',
  smsProvider: 'twilio',
  approvalGate: { type: 'owner_approval', requiredFor: ['call', 'bulk_sms', 'ad'] },
  smsTemplateIdRequired: false,
  silenceWindowHours: 0, // configurable per jurisdiction; confirm with counsel
  // Draft values: confirm against the CRTC Unsolicited Telecommunications Rules.
  callingHours: {
    weekday: { start: min(9), end: min(21, 30) },
    weekend: { start: min(10), end: min(18) },
  },
  aiDisclosure: {
    audio: 'at_start',
    visualLabel: null,
    // The campaign name is appended at render time.
    spoken: {
      en: 'This is an automated call on behalf of',
      pa: 'ਇਹ ਇੱਕ ਆਟੋਮੈਟਿਕ ਕਾਲ ਹੈ, ਜੋ ਇਹਨਾਂ ਵੱਲੋਂ ਹੈ',
      hi: 'यह एक स्वचालित कॉल है, जो इनकी ओर से है',
    },
  },
  automatedDonationAsk: 'express_consent_only',
  geographyLevels: ['province', 'city', 'ward', 'voting_place', 'street'],
  confirmWithCounsel: ['callingHours', 'silenceWindowHours', 'aiDisclosure.spoken'],
};
