import { describe, it, expect } from 'vitest';
import { parseAmount, parseBankCsv, parseCsv, parseDate, matchLines, type EntryLite, type LineLite } from '../src/modules/finance/reconcile.js';

describe('parseAmount', () => {
  it('reads Indian and Canadian number styles exactly, to the paisa or cent', () => {
    expect(parseAmount('1,00,000.50')?.minor).toBe(10_000_050);
    expect(parseAmount('₹ 2,500')?.minor).toBe(250_000);
    expect(parseAmount('$1,234.5')?.minor).toBe(123_450);
    expect(parseAmount('0.10')?.minor).toBe(10);
    expect(parseAmount('19.99')?.minor).toBe(1999);
  });
  it('reads signs: brackets, a leading or trailing minus, Dr / Cr', () => {
    expect(parseAmount('(500.00)')).toEqual({ minor: 50_000, negative: true });
    expect(parseAmount('-500')).toEqual({ minor: 50_000, negative: true });
    expect(parseAmount('500.00-')).toEqual({ minor: 50_000, negative: true });
    expect(parseAmount('500.00 Dr')).toEqual({ minor: 50_000, negative: true });
    expect(parseAmount('500.00 Cr')).toEqual({ minor: 50_000, negative: false });
  });
  it('returns null for blanks and non-numbers', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
  });
});

describe('parseDate', () => {
  it('reads day-first for India and month-first for Canada', () => {
    expect(parseDate('03/04/2027', 'dmy')).toBe('2027-04-03');
    expect(parseDate('03/04/2027', 'mdy')).toBe('2027-03-04');
  });
  it('reads ISO dates, month names and two-digit years; rejects impossible dates', () => {
    expect(parseDate('2027-02-20', 'dmy')).toBe('2027-02-20');
    expect(parseDate('20-Feb-2027', 'dmy')).toBe('2027-02-20');
    expect(parseDate('Feb 20, 2027', 'mdy')).toBe('2027-02-20');
    expect(parseDate('20/02/27', 'dmy')).toBe('2027-02-20');
    expect(parseDate('31/02/2027', 'dmy')).toBeNull();
    expect(parseDate('hello', 'dmy')).toBeNull();
  });
});

describe('parseCsv', () => {
  it('handles quotes, embedded delimiters, doubled quotes and a BOM', () => {
    const rows = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', 'x, y', 'say "hi"']]);
  });
  it('guesses a semicolon delimiter', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('parseBankCsv', () => {
  it('skips lines above the table and reads separate debit and credit columns', () => {
    const csv = [
      'Account Statement,,,,', 'Account: 1234,,,,',
      'Txn Date,Description,Chq/Ref No,Withdrawal,Deposit,Balance',
      '03/04/2027,UPI/Sharma Printers/9988,UTR1,"12,500.00",,87500.00',
      '04/04/2027,NEFT from A Kumar,UTR2,,"5,000.00",92500.00',
      'Total,,,"12,500.00","5,000.00",',
    ].join('\n');
    const r = parseBankCsv(csv, 'dmy');
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ date: '2027-04-03', direction: 'debit', amountMinor: 1_250_000, reference: 'UTR1' });
    expect(r.lines[1]).toMatchObject({ date: '2027-04-04', direction: 'credit', amountMinor: 500_000 });
    expect(r.periodFrom).toBe('2027-04-03');
    expect(r.periodTo).toBe('2027-04-04');
    expect(r.skipped.some((s) => s.reason === 'BAD_DATE')).toBe(true); // the "Total" line is reported, not guessed at
  });
  it('reads a single signed Amount column and a Dr/Cr type column', () => {
    const a = parseBankCsv('Date,Details,Amount\n2027-03-01,Rent,-1200.00\n2027-03-02,Donation,300.00', 'mdy');
    expect(a.lines.map((l) => l.direction)).toEqual(['debit', 'credit']);
    const b = parseBankCsv('Date,Narration,Amount,Dr/Cr\n01/03/2027,Fuel,800,DR\n02/03/2027,Gift,200,CR', 'dmy');
    expect(b.lines.map((l) => [l.direction, l.amountMinor])).toEqual([['debit', 80_000], ['credit', 20_000]]);
  });
  it('says so when it cannot find a table', () => {
    expect(parseBankCsv('hello\nworld', 'dmy').skipped[0]?.reason).toBe('NO_HEADER_ROW');
  });
});

const E = (id: string, date: string, amt: number, party: string, extra: Partial<EntryLite> = {}): EntryLite => ({ id, kind: 'expense', entryDate: date, amountMinor: amt, partyName: party, paymentMode: 'bank', ...extra });
const L = (id: string, date: string, amt: number, desc: string, extra: Partial<LineLite> = {}): LineLite => ({ id, date, direction: 'debit', amountMinor: amt, description: desc, reference: null, ...extra });

describe('matchLines', () => {
  it('matches a line to the one entry with the same amount close in date', () => {
    const m = matchLines([L('l1', '2027-04-05', 50_000, 'UPI payment')], [E('e1', '2027-04-03', 50_000, 'Sharma Printers'), E('e2', '2027-04-03', 60_000, 'Other')]);
    expect(m.get('l1')).toMatchObject({ status: 'matched', entryId: 'e1' });
  });
  it('does not match across directions, other amounts, far dates, or cash entries', () => {
    const lines = [L('a', '2027-04-05', 50_000, 'x'), L('b', '2027-04-05', 50_000, 'y', { direction: 'credit' }), L('c', '2027-06-30', 70_000, 'z')];
    const entries = [E('e1', '2027-04-05', 50_000, 'P', { paymentMode: 'cash' }), E('e2', '2027-04-05', 70_000, 'Q')];
    const m = matchLines(lines, entries);
    expect(m.get('a')?.status).toBe('unmatched'); // only a cash entry has that amount
    expect(m.get('b')?.status).toBe('unmatched'); // wrong direction
    expect(m.get('c')?.status).toBe('unmatched'); // two months apart
  });
  it('uses the party name in the bank description to choose between equal amounts', () => {
    const entries = [E('e1', '2027-04-03', 10_000, 'Sharma Printers'), E('e2', '2027-04-03', 10_000, 'Gill Transport')];
    const m = matchLines([L('l1', '2027-04-04', 10_000, 'IMPS GILL TRANSPORT'), L('l2', '2027-04-04', 10_000, 'IMPS SHARMA PRINTERS')], entries);
    expect(m.get('l1')).toMatchObject({ status: 'matched', entryId: 'e2' });
    expect(m.get('l2')).toMatchObject({ status: 'matched', entryId: 'e1' });
  });
  it('only suggests when nothing tells equal candidates apart, and never uses one entry twice', () => {
    const entries = [E('e1', '2027-04-03', 10_000, 'A'), E('e2', '2027-04-03', 10_000, 'B')];
    const m = matchLines([L('l1', '2027-04-04', 10_000, 'transfer')], entries);
    expect(m.get('l1')?.status).toBe('suggested');
    expect(m.get('l1')?.candidates.sort()).toEqual(['e1', 'e2']);
    const one = matchLines([L('l1', '2027-04-04', 10_000, 'x'), L('l2', '2027-04-05', 10_000, 'x')], [E('e1', '2027-04-03', 10_000, 'A')]);
    expect([...one.values()].filter((v) => v.status === 'matched')).toHaveLength(1);
  });
  it('matches contributions to money in', () => {
    const m = matchLines([L('l1', '2027-04-05', 25_000, 'NEFT A Kumar', { direction: 'credit' })], [E('c1', '2027-04-04', 25_000, 'A Kumar', { kind: 'contribution' })]);
    expect(m.get('l1')).toMatchObject({ status: 'matched', entryId: 'c1' });
  });
});
