import type { FilingFormat, FilingField } from '@cs/regions';
import type { schema } from '@cs/db';

type Entry = typeof schema.financeEntries.$inferSelect;
const money = (m: number | null) => (m == null ? '' : (m / 100).toFixed(2));

const value: Record<FilingField, (e: Entry, i: number) => string | number | null> = {
  serial: (_e, i) => i + 1,
  date: (e) => e.entryDate,
  category: (e) => e.category,
  description: (e) => e.description,
  party: (e) => e.partyName,
  address: (e) => e.partyAddress,
  partyAndAddress: (e) => (e.partyAddress ? `${e.partyName}, ${e.partyAddress}` : e.partyName),
  billNo: (e) => e.billNo,
  quantity: (e) => e.quantity,
  rate: (e) => money(e.unitRateMinor),
  amount: (e) => money(e.amountMinor),
  mode: (e) => e.paymentMode,
  source: (e) => e.source,
  receiptNo: (e) => e.receiptNo,
  eligible: (e) => (e.eligibleAttested ? 'yes' : 'no'),
  flags: (e) => e.flags.map((f) => f.code).join(' '),
};

/** The register's entries laid out in one of the filing formats: a header row and one row per entry. */
export function renderFiling(fmt: FilingFormat, entries: Entry[]): { head: string[]; rows: (string | number | null)[][] } {
  return { head: fmt.columns.map((c) => c.header), rows: entries.map((e, i) => fmt.columns.map((c) => value[c.field](e, i))) };
}
