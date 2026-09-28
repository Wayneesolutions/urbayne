export type RegionCode = 'IN' | 'CA';
export type Locale = 'pa' | 'hi' | 'en' | 'tl' | 'fr';
export type Channel = 'voice' | 'sms' | 'ai_answer';
export type OutboundKind = 'call' | 'bulk_sms' | 'ad';

/** Calling window in the called party's local time, as minutes after midnight. */
export interface CallingHours {
  weekday: { start: number; end: number };
  weekend: { start: number; end: number };
}

export interface RegionConfig {
  code: RegionCode;
  locales: Locale[];
  defaultLocale: Locale;
  defaultTimeZone: string;
  currency: 'INR' | 'CAD';
  dataRegion: 'ap-south-1' | 'ca-central-1';
  voiceProvider: 'plivo' | 'twilio';
  smsProvider: 'dlt' | 'twilio';
  /**
   * How content is cleared before release.
   * IN: an MCMC certificate number is required.
   * CA: approval by the campaign owner is required.
   */
  approvalGate: { type: 'mcmc_certificate' | 'owner_approval'; requiredFor: OutboundKind[] };
  /** SMS templates must carry a DLT template id (IN). */
  smsTemplateIdRequired: boolean;
  /** Hours before poll close in which bulk calls and SMS are blocked. 0 = none. */
  silenceWindowHours: number;
  /**
   * null = NOT YET CONFIRMED. The compliance engine blocks voice calls
   * until a value is configured, rather than guessing.
   */
  callingHours: CallingHours | null;
  aiDisclosure: {
    audio: 'at_start';
    /** Label required on AI images and video, if any. */
    visualLabel: string | null;
    /** Spoken disclosure per locale. Voice scripts must begin with it. */
    spoken: Partial<Record<Locale, string>>;
  };
  /** Automated calls that ask for money. */
  automatedDonationAsk: 'blocked' | 'express_consent_only';
  geographyLevels: string[];
  /** Settings that are drafts until counsel confirms them. */
  confirmWithCounsel: string[];
}
