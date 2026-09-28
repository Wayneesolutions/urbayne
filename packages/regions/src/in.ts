import type { RegionConfig } from './types.js';

export const IN: RegionConfig = {
  code: 'IN',
  locales: ['pa', 'hi', 'en'],
  defaultLocale: 'pa',
  defaultTimeZone: 'Asia/Kolkata',
  currency: 'INR',
  dataRegion: 'ap-south-1',
  voiceProvider: 'plivo',
  smsProvider: 'dlt',
  approvalGate: { type: 'mcmc_certificate', requiredFor: ['call', 'bulk_sms', 'ad'] },
  smsTemplateIdRequired: true,
  silenceWindowHours: 48,
  callingHours: null, // set after telecom provider + TRAI confirmation
  aiDisclosure: {
    audio: 'at_start',
    visualLabel: 'AI-Generated',
    // Draft wording: final text to be approved by counsel and translators.
    spoken: {
      pa: 'ਇਹ ਇੱਕ AI ਦੁਆਰਾ ਬਣਾਈ ਗਈ ਕਾਲ ਹੈ।',
      hi: 'यह एक AI द्वारा बनाई गई कॉल है।',
      en: 'This is an AI-generated call.',
    },
  },
  automatedDonationAsk: 'blocked',
  geographyLevels: ['state', 'district', 'constituency', 'booth', 'locality'],
  confirmWithCounsel: ['callingHours', 'aiDisclosure.spoken', 'silenceWindowHours'],
};
