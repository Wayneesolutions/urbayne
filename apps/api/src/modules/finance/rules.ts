/**
 * Pure finance checks. They flag, they never silently fix: the campaign's
 * official / election agent decides, and flags stay visible until resolved.
 */
export interface Flag { code: string; message: string }

export interface ExpenseInput { amountMinor: number; billNo?: string | null; quantity?: number | null; unitRateMinor?: number | null; listRateMinor?: number | null }
export interface ContributionInput { amountMinor: number; eligibleAttested: boolean; partyName: string; paymentMode?: string | null }

export function expenseFlags(e: ExpenseInput, ctx: { region: 'IN' | 'CA'; spentMinor: number; limitMinor: number | null }): Flag[] {
  const f: Flag[] = [];
  if (!e.billNo) f.push({ code: 'MISSING_BILL', message: 'No bill or invoice number recorded.' });
  if (ctx.region === 'IN' && e.listRateMinor != null && e.unitRateMinor != null && e.unitRateMinor < e.listRateMinor) {
    f.push({ code: 'BELOW_RATE_LIST', message: 'Rate is below the district rate list; observers may value it at the list rate.' });
  }
  if (e.quantity != null && e.unitRateMinor != null && Math.round(Number(e.quantity) * e.unitRateMinor) !== e.amountMinor) {
    f.push({ code: 'AMOUNT_MISMATCH', message: 'Amount does not equal quantity × rate.' });
  }
  if (ctx.limitMinor && ctx.spentMinor + e.amountMinor > ctx.limitMinor) {
    f.push({ code: 'OVER_SPENDING_LIMIT', message: 'Total spending would exceed the limit.' });
  }
  return f;
}

export function contributionFlags(c: ContributionInput, ctx: { region: 'IN' | 'CA'; priorFromSameMinor: number; perContributorLimitMinor: number | null }): Flag[] {
  const f: Flag[] = [];
  if (ctx.region === 'CA' && !c.eligibleAttested) f.push({ code: 'ELIGIBILITY_NOT_CONFIRMED', message: 'Contributor eligibility has not been confirmed.' });
  if (ctx.perContributorLimitMinor && ctx.priorFromSameMinor + c.amountMinor > ctx.perContributorLimitMinor) {
    f.push({ code: 'OVER_CONTRIBUTION_LIMIT', message: 'This contributor would exceed the per-contributor limit.' });
  }
  if (c.paymentMode === 'cash' && c.amountMinor >= 1_000_000) f.push({ code: 'LARGE_CASH', message: 'Large cash contribution: check the rules for cash limits.' });
  return f;
}

export const normaliseParty = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** CSV cell escaping (formula-injection safe). */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
