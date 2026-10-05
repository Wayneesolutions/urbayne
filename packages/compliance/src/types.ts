import type { Channel, Locale, RegionConfig, CallingHours } from '@cs/regions';

export type Purpose = 'info' | 'survey' | 'reminder' | 'donation' | 'service';
export type ContentKind = 'script' | 'sms_template' | 'page' | 'faq' | 'ad';
export type ContentStatus = 'draft' | 'approved' | 'certified';

export interface ContentItem {
  id: string;
  kind: ContentKind;
  locale: Locale;
  body: string;
  status: ContentStatus;
  /** MCMC certificate number (IN). */
  certificateNo?: string | null;
  /** DLT template id (IN SMS). */
  dltTemplateId?: string | null;
}

export interface Consent {
  purpose: Purpose;
  channel: Channel;
  withdrawnAt?: Date | null;
}

export interface Contact {
  id: string;
  timeZone?: string | null;
  optedOut: boolean;
  consents: Consent[];
}

export interface TenantCtx {
  id: string;
  /** Campaign name as spoken in disclosures, e.g. "Jane Doe for Ward 3". */
  campaignName: string;
  timeZone: string;
  pollCloseAt: Date | null;
  /** Counsel-confirmed override when the region default is not set. */
  callingHoursOverride?: CallingHours | null;
}

export interface OutboundCtx {
  tenant: TenantCtx;
  region: RegionConfig;
  channel: Channel;
  contentItem: ContentItem;
  contact?: Contact;
  purpose: Purpose;
  sendAt: Date;
  /**
   * 'run'  = check when a campaign run is started (content, timing, disclosure).
   * 'send' = check right before one call/SMS to one contact (everything, incl. consent).
   * Default 'send'.
   */
  scope?: 'run' | 'send';
  hourlySentCount?: number;
  hourlyCap?: number;
  /** Money in minor units (paise / cents). */
  estimatedCostMinor?: number;
  spentMinor?: number;
  spendLimitMinor?: number | null;
}

export type ReasonCode =
  | 'CONTENT_NOT_APPROVED'
  | 'CERTIFICATE_MISSING'
  | 'DLT_TEMPLATE_MISSING'
  | 'POLL_CLOSE_NOT_SET'
  | 'SILENCE_WINDOW'
  | 'CALLING_HOURS_NOT_CONFIGURED'
  | 'OUTSIDE_CALLING_HOURS'
  | 'CONTACT_REQUIRED'
  | 'OPTED_OUT'
  | 'NO_CONSENT'
  | 'DONATION_BLOCKED'
  | 'DISCLOSURE_TEXT_MISSING_FOR_LOCALE'
  | 'DISCLOSURE_MISSING'
  | 'CAMPAIGN_NOT_IDENTIFIED'
  | 'RATE_LIMIT'
  | 'SPEND_OVER_LIMIT'
  | 'SPEND_NEAR_LIMIT';

export interface Reason {
  code: ReasonCode;
  message: string;
}

export interface CheckResult {
  allowed: boolean;
  reasons: Reason[];
  warnings: Reason[];
}
