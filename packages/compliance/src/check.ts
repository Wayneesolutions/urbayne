import type { CheckResult, OutboundCtx, Reason, ReasonCode } from './types.js';
import { inSilenceWindow, withinCallingHours } from './time.js';

const r = (code: ReasonCode, message: string): Reason => ({ code, message });

/** Channel -> the kind of outbound release the approval gate covers. */
const releaseKind = { voice: 'call', sms: 'bulk_sms', ai_answer: null } as const;

/**
 * The single gate every outbound action passes. Call it when a run is scheduled
 * AND again immediately before each individual send. A failure blocks the send;
 * it is never a warning the user can click past. Warnings do not block.
 */
export function checkOutbound(ctx: OutboundCtx): CheckResult {
  const reasons: Reason[] = [];
  const warnings: Reason[] = [];
  const { region, tenant, channel, contentItem: item, contact } = ctx;
  const outbound = channel === 'voice' || channel === 'sms';

  // 1. Content approved / certified
  if (item.status === 'draft') {
    reasons.push(r('CONTENT_NOT_APPROVED', `Content ${item.id} is still a draft.`));
  }
  const kind = releaseKind[channel];
  if (kind && region.approvalGate.requiredFor.includes(kind)) {
    if (region.approvalGate.type === 'mcmc_certificate') {
      if (item.status !== 'certified' || !item.certificateNo) {
        reasons.push(r('CERTIFICATE_MISSING', 'An MCMC certificate number is required before release.'));
      }
    } else if (item.status === 'draft') {
      // owner_approval: already reported above
    }
  }
  if (channel === 'sms' && region.smsTemplateIdRequired && !item.dltTemplateId) {
    reasons.push(r('DLT_TEMPLATE_MISSING', 'SMS needs a registered DLT template id.'));
  }

  // 2. Silence window
  if (outbound && region.silenceWindowHours > 0) {
    if (!tenant.pollCloseAt) {
      reasons.push(r('POLL_CLOSE_NOT_SET', 'Set the poll close time before sending calls or SMS.'));
    } else if (inSilenceWindow(ctx.sendAt, tenant.pollCloseAt, region.silenceWindowHours)) {
      reasons.push(r('SILENCE_WINDOW', `Blocked: within ${region.silenceWindowHours} hours of poll close.`));
    }
  }

  // 3. Calling hours (voice)
  if (channel === 'voice') {
    const hours = tenant.callingHoursOverride ?? region.callingHours;
    if (!hours) {
      reasons.push(r('CALLING_HOURS_NOT_CONFIGURED', 'Calling hours are not confirmed for this region yet.'));
    } else {
      const tz = contact?.timeZone || tenant.timeZone;
      if (!withinCallingHours(ctx.sendAt, tz, hours)) {
        reasons.push(r('OUTSIDE_CALLING_HOURS', `Outside permitted calling hours in ${tz}.`));
      }
    }
  }

  // 4. Consent and opt-outs (per contact, so only at send time)
  if (outbound && ctx.scope !== 'run') {
    if (!contact) {
      reasons.push(r('CONTACT_REQUIRED', 'Outbound sends need a known contact.'));
    } else if (contact.optedOut) {
      reasons.push(r('OPTED_OUT', 'Contact has opted out.'));
    } else {
      const ok = contact.consents.some(
        (c) => c.purpose === ctx.purpose && c.channel === channel && !c.withdrawnAt,
      );
      if (!ok) reasons.push(r('NO_CONSENT', `No live consent for ${ctx.purpose} by ${channel}.`));
    }
  }

  // 5. Donation asks by automated call
  if (channel === 'voice' && ctx.purpose === 'donation' && region.automatedDonationAsk === 'blocked') {
    reasons.push(r('DONATION_BLOCKED', 'Automated donation calls are not offered in this region.'));
  }
  // (express_consent_only is enforced by gate 4: it needs a 'donation' consent for 'voice'.)

  // 6. AI disclosure at the start of every voice script
  if (channel === 'voice') {
    const spoken = region.aiDisclosure.spoken[item.locale];
    if (!spoken) {
      reasons.push(r('DISCLOSURE_TEXT_MISSING_FOR_LOCALE', `No disclosure text for locale ${item.locale}.`));
    } else {
      const body = item.body.trim();
      if (!body.startsWith(spoken)) {
        reasons.push(r('DISCLOSURE_MISSING', 'Voice scripts must begin with the disclosure text.'));
      } else if (region.code === 'CA' && !body.slice(0, spoken.length + 200).includes(tenant.campaignName)) {
        reasons.push(r('CAMPAIGN_NOT_IDENTIFIED', 'The campaign must be named right after the disclosure.'));
      }
    }
  }

  // 7. Rate limits
  if (ctx.hourlyCap != null && (ctx.hourlySentCount ?? 0) >= ctx.hourlyCap) {
    reasons.push(r('RATE_LIMIT', 'Hourly send cap reached for this tenant.'));
  }

  // 8. Spend
  if (ctx.spendLimitMinor != null && ctx.spendLimitMinor > 0) {
    const projected = (ctx.spentMinor ?? 0) + (ctx.estimatedCostMinor ?? 0);
    const share = projected / ctx.spendLimitMinor;
    if (share > 1) reasons.push(r('SPEND_OVER_LIMIT', 'This would exceed the spending limit.'));
    else if (share >= 0.9) warnings.push(r('SPEND_NEAR_LIMIT', 'Spending will pass 90% of the limit.'));
  }

  return { allowed: reasons.length === 0, reasons, warnings };
}

/** The exact opening line a voice script must start with. */
export function renderDisclosure(ctx: Pick<OutboundCtx, 'region' | 'tenant'>, locale: keyof OutboundCtx['region']['aiDisclosure']['spoken']): string {
  const spoken = ctx.region.aiDisclosure.spoken[locale];
  if (!spoken) throw new Error(`No disclosure text for ${String(locale)}`);
  return ctx.region.code === 'CA' ? `${spoken} ${ctx.tenant.campaignName}.` : spoken;
}
