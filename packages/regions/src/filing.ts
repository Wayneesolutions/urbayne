import type { RegionCode } from './types.js';

/** What goes in a column of a filing layout. Each maps to one field of a finance register entry. */
export type FilingField =
  | 'serial' | 'date' | 'category' | 'description' | 'party' | 'address' | 'partyAndAddress' | 'billNo' | 'quantity' | 'rate' | 'amount' | 'mode' | 'source' | 'receiptNo' | 'eligible' | 'flags';

export interface FilingFormat {
  id: string;
  region: RegionCode;
  /** Only offered to campaigns in this province (Canada). */
  province?: string;
  kind: 'expense' | 'contribution';
  title: string;
  /** Who receives the filing, as named in the layout's heading. */
  authority: string;
  columns: { header: string; field: FilingField }[];
  /**
   * false = a working layout that has NOT been checked against the form the election authority requires. An export in it says so on its
   * first line, and the finance agent must compare it with the official form before filing. Set to true only after the election agent
   * (India) or the election office (Canada) has confirmed the layout. See docs/phase4-5.md.
   */
  confirmed: boolean;
}

const expenseCols = (extra: FilingFormat['columns'] = []): FilingFormat['columns'] => [
  { header: 'Sl. No.', field: 'serial' }, { header: 'Date', field: 'date' }, { header: 'Nature of expenditure', field: 'category' }, { header: 'Particulars', field: 'description' },
  { header: 'Voucher / bill no.', field: 'billNo' }, ...extra, { header: 'Amount', field: 'amount' }, { header: 'Mode of payment', field: 'mode' },
];

export const FILING_FORMATS: FilingFormat[] = [
  // The platform's own register layout: what the finance agent has been using, and the fallback for every campaign.
  {
    id: 'register-expense', region: 'IN', kind: 'expense', title: 'Expenditure register (platform layout)', authority: 'Election agent', confirmed: true,
    columns: [
      { header: 'Date', field: 'date' }, { header: 'Category', field: 'category' }, { header: 'Description', field: 'description' }, { header: 'Paid to', field: 'party' }, { header: 'Address', field: 'address' },
      { header: 'Bill / invoice no.', field: 'billNo' }, { header: 'Quantity', field: 'quantity' }, { header: 'Rate', field: 'rate' }, { header: 'Amount', field: 'amount' }, { header: 'Mode', field: 'mode' }, { header: 'Source', field: 'source' }, { header: 'Flags', field: 'flags' },
    ],
  },
  {
    id: 'in-day-to-day-account', region: 'IN', kind: 'expense', title: 'Day-to-day account of election expenditure', authority: 'District Election Officer / Expenditure Observer', confirmed: false,
    columns: expenseCols([{ header: 'Name and address of payee', field: 'partyAndAddress' }]),
  },
  {
    id: 'in-contributions-received', region: 'IN', kind: 'contribution', title: 'Funds received for the election', authority: 'District Election Officer / Expenditure Observer', confirmed: false,
    columns: [
      { header: 'Sl. No.', field: 'serial' }, { header: 'Date', field: 'date' }, { header: 'Receipt no.', field: 'receiptNo' }, { header: 'Received from (name and address)', field: 'partyAndAddress' },
      { header: 'Amount', field: 'amount' }, { header: 'Mode of payment', field: 'mode' }, { header: 'Particulars', field: 'description' },
    ],
  },
  {
    id: 'register-expense', region: 'CA', kind: 'expense', title: 'Expense register (platform layout)', authority: 'Official agent', confirmed: true,
    columns: [
      { header: 'Date', field: 'date' }, { header: 'Category', field: 'category' }, { header: 'Description', field: 'description' }, { header: 'Paid to', field: 'party' }, { header: 'Address', field: 'address' },
      { header: 'Bill / invoice no.', field: 'billNo' }, { header: 'Quantity', field: 'quantity' }, { header: 'Rate', field: 'rate' }, { header: 'Amount', field: 'amount' }, { header: 'Mode', field: 'mode' }, { header: 'Source', field: 'source' }, { header: 'Flags', field: 'flags' },
    ],
  },
  {
    id: 'register-contribution', region: 'CA', kind: 'contribution', title: 'Contributions register (platform layout)', authority: 'Official agent', confirmed: true,
    columns: [
      { header: 'Date', field: 'date' }, { header: 'Receipt no.', field: 'receiptNo' }, { header: 'Received from', field: 'party' }, { header: 'Address', field: 'address' }, { header: 'Description', field: 'description' },
      { header: 'Amount', field: 'amount' }, { header: 'Mode', field: 'mode' }, { header: 'Eligibility confirmed', field: 'eligible' }, { header: 'Flags', field: 'flags' },
    ],
  },
  {
    id: 'ca-mb-expense-schedule', region: 'CA', province: 'MB', kind: 'expense', title: 'Candidate election expenses schedule (Manitoba)', authority: 'Elections Manitoba', confirmed: false,
    columns: expenseCols([{ header: 'Supplier', field: 'party' }, { header: 'Supplier address', field: 'address' }]),
  },
  {
    id: 'ca-mb-contributions-list', region: 'CA', province: 'MB', kind: 'contribution', title: 'Contributions received (Manitoba)', authority: 'Elections Manitoba', confirmed: false,
    columns: [
      { header: 'Date received', field: 'date' }, { header: 'Receipt no.', field: 'receiptNo' }, { header: 'Contributor name', field: 'party' }, { header: 'Contributor address', field: 'address' },
      { header: 'Amount', field: 'amount' }, { header: 'Method', field: 'mode' },
    ],
  },
  {
    id: 'ca-city-expense-schedule', region: 'CA', kind: 'expense', title: 'Candidate expenses (municipal: the City election office)', authority: 'City election office', confirmed: false,
    columns: expenseCols([{ header: 'Supplier', field: 'party' }, { header: 'Supplier address', field: 'address' }]),
  },
];

// India has the same contributions layout as the platform default.
const caContrib = FILING_FORMATS.find((f) => f.id === "register-contribution" && f.region === "CA")!;
FILING_FORMATS.push({ ...caContrib, region: "IN", title: "Funds received register (platform layout)", authority: "Election agent" });

/** The layouts a campaign may export in: its region's, plus its province's. The platform's own layout comes first. */
export function filingFormatsFor(region: RegionCode, kind: 'expense' | 'contribution', province?: string | null): FilingFormat[] {
  return FILING_FORMATS.filter((f) => f.region === region && f.kind === kind && (!f.province || f.province === province))
    .sort((a, b) => Number(b.id.startsWith('register-')) - Number(a.id.startsWith('register-')));
}

export function filingFormat(id: string, region: RegionCode, kind: 'expense' | 'contribution', province?: string | null): FilingFormat | undefined {
  return filingFormatsFor(region, kind, province).find((f) => f.id === id);
}
