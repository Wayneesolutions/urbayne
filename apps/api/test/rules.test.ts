import { describe, it, expect } from 'vitest';
import { expenseFlags, contributionFlags, csvCell } from '../src/modules/finance/rules.js';
import { planRoute, haversineKm } from '../src/modules/ops/route.js';

describe('finance rules', () => {
  it('flags spending below the district rate list (IN) and missing bills', () => {
    const f = expenseFlags({ amountMinor: 50_000, quantity: 100, unitRateMinor: 500, listRateMinor: 1000 }, { region: 'IN', spentMinor: 0, limitMinor: 4_000_000_00 });
    expect(f.map((x) => x.code)).toEqual(['MISSING_BILL', 'BELOW_RATE_LIST']);
  });
  it('flags a quantity × rate mismatch and going over the limit', () => {
    const f = expenseFlags({ amountMinor: 1_000, billNo: 'B1', quantity: 2, unitRateMinor: 400 }, { region: 'CA', spentMinor: 9_500, limitMinor: 10_000 });
    expect(f.map((x) => x.code)).toEqual(['AMOUNT_MISMATCH', 'OVER_SPENDING_LIMIT']);
  });
  it('CA contributions: eligibility and per-contributor limit', () => {
    const f = contributionFlags({ amountMinor: 50_000, eligibleAttested: false, partyName: 'A' }, { region: 'CA', priorFromSameMinor: 40_000, perContributorLimitMinor: 75_000 });
    expect(f.map((x) => x.code)).toEqual(['ELIGIBILITY_NOT_CONFIRMED', 'OVER_CONTRIBUTION_LIMIT']);
  });
  it('escapes CSV and blocks spreadsheet formula injection', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('a,b')).toBe('"a,b"');
  });
});

describe('sign route', () => {
  it('orders stops into a short loop', () => {
    const start = { lat: 49.95, lng: -97.2 };
    const pts = [
      { id: 'far', lat: 49.99, lng: -97.2 }, { id: 'near', lat: 49.951, lng: -97.2 }, { id: 'mid', lat: 49.97, lng: -97.2 },
    ];
    const r = planRoute(start, pts);
    expect(r.order.map((p) => p.id)).toEqual(['near', 'mid', 'far']);
    expect(r.km).toBeCloseTo(haversineKm(start, pts[0]!), 0);
  });
});
