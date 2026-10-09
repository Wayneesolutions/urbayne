/**
 * Bank statement reconciliation: reads a bank's CSV export and pairs each line with the register entry it belongs to,
 * so money that moved without an entry (or an entry the bank never shows) is found before the return is filed.
 * Pure functions; the routes in routes.ts do the saving.
 */

export interface ParsedLine { lineNo: number; date: string; description: string; reference: string | null; direction: 'debit' | 'credit'; amountMinor: number }
export interface ParseResult { lines: ParsedLine[]; skipped: { row: number; reason: string }[]; periodFrom: string | null; periodTo: string | null }

/** RFC 4180 CSV with a guessed delimiter (comma, semicolon, tab). Quoted fields may contain delimiters and line breaks. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const count = (c: string) => first.split(c).length - 1;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0]!;
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y: number, m: number, d: number) => {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; // 31 February
  return dt.toISOString().slice(0, 10);
};

/** A date as YYYY-MM-DD. `order` says how 03/04/2027 reads: dmy (India) or mdy (Canada). */
export function parseDate(s: string, order: 'dmy' | 'mdy'): string | null {
  const t = s.trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?$/i, '');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/.exec(t);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    const [a, b] = [+m[1]!, +m[2]!];
    return order === 'dmy' ? iso(y, b, a) : iso(y, a, b);
  }
  m = /^(\d{1,2})[-/. ]([A-Za-z]{3})[a-z]*[-/. ,]*(\d{2}|\d{4})$/.exec(t);
  if (m && MONTHS[m[2]!.toLowerCase()]) return iso(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, MONTHS[m[2]!.toLowerCase()]!, +m[1]!);
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(t);
  if (m && MONTHS[m[1]!.toLowerCase()]) return iso(+m[3]!, MONTHS[m[1]!.toLowerCase()]!, +m[2]!);
  return null;
}

/** An amount in minor units (paise or cents), exact: 1,00,000.50 -> 10000050. Brackets or a leading minus mean negative. Blank -> null. */
export function parseAmount(s: string): { minor: number; negative: boolean } | null {
  let t = s.trim();
  if (!t) return null;
  let negative = false;
  if (/^\(.*\)$/.test(t)) { negative = true; t = t.slice(1, -1); }
  const suffix = /\s*(dr|cr)\.?$/i.exec(t);
  if (suffix) { if (suffix[1]!.toLowerCase() === 'dr') negative = true; t = t.slice(0, suffix.index); }
  if (t.startsWith('-')) { negative = true; t = t.slice(1); } else if (t.endsWith('-')) { negative = true; t = t.slice(0, -1); }
  t = t.replace(/[^\d.,]/g, '');
  if (!t) return null;
  // The last separator is the decimal point only if it is followed by 1 or 2 digits.
  const m = /^(.*?)[.,](\d{1,2})$/.exec(t);
  const whole = (m ? m[1]! : t).replace(/[.,]/g, '');
  const frac = m ? m[2]!.padEnd(2, '0') : '00';
  if (!/^\d*$/.test(whole)) return null;
  return { minor: Number(whole || '0') * 100 + Number(frac), negative };
}

const HEAD = {
  date: [/^(transaction|txn|posting|booking)\s*date$/i, /^date$/i, /^value\s*date$/i, /date/i],
  desc: [/description|narration|particulars|details|memo|remarks|payee/i],
  ref: [/utr|cheque|chq|check\s*(no|number)|ref(erence)?(\s*(no|number))?$|transaction\s*id|txn\s*id/i],
  debit: [/debit|withdraw|paid\s*out|money\s*out|^dr$/i],
  credit: [/credit|deposit|paid\s*in|money\s*in|^cr$/i],
  amount: [/^amount/i, /^(txn|transaction)\s*amount/i],
  type: [/^(dr\s*\/?\s*cr|type|cr\s*\/?\s*dr|debit\s*\/?\s*credit)$/i],
};
const findCol = (headers: string[], pats: RegExp[], not: number[] = []) => {
  for (const p of pats) { const i = headers.findIndex((h, k) => !not.includes(k) && p.test(h)); if (i >= 0) return i; }
  return -1;
};

/** Reads a bank's CSV export. Skips any lines the bank prints above the table; rows it cannot read are listed, not guessed. */
export function parseBankCsv(text: string, order: 'dmy' | 'mdy'): ParseResult {
  const rows = parseCsv(text);
  const hi = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /debit|credit|withdraw|deposit|amount/i.test(c)));
  if (hi < 0) return { lines: [], skipped: [{ row: 0, reason: 'NO_HEADER_ROW' }], periodFrom: null, periodTo: null };
  const h = rows[hi]!;
  const cDate = findCol(h, HEAD.date), cDesc = findCol(h, HEAD.desc), cDebit = findCol(h, HEAD.debit), cCredit = findCol(h, HEAD.credit);
  const cAmount = cDebit < 0 && cCredit < 0 ? findCol(h, HEAD.amount) : findCol(h, HEAD.amount, [cDebit, cCredit]);
  const cRef = findCol(h, HEAD.ref, [cDesc]), cType = findCol(h, HEAD.type);
  if (cDate < 0 || (cDebit < 0 && cCredit < 0 && cAmount < 0)) return { lines: [], skipped: [{ row: hi + 1, reason: 'MISSING_COLUMNS' }], periodFrom: null, periodTo: null };

  const lines: ParsedLine[] = [];
  const skipped: ParseResult['skipped'] = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const date = parseDate(r[cDate] ?? '', order);
    if (!date) { if (r.some((c) => c)) skipped.push({ row: i + 1, reason: 'BAD_DATE' }); continue; } // totals and footers land here too
    let dir: 'debit' | 'credit' | null = null, minor = 0;
    const dv = cDebit >= 0 ? parseAmount(r[cDebit] ?? '') : null;
    const cv = cCredit >= 0 ? parseAmount(r[cCredit] ?? '') : null;
    if (dv && dv.minor > 0) { dir = 'debit'; minor = dv.minor; }
    else if (cv && cv.minor > 0) { dir = 'credit'; minor = cv.minor; }
    else if (cAmount >= 0) {
      const a = parseAmount(r[cAmount] ?? '');
      if (a && a.minor > 0) {
        const t = cType >= 0 ? (r[cType] ?? '').toLowerCase() : '';
        dir = /^(dr|debit|d)\b/.test(t) ? 'debit' : /^(cr|credit|c)\b/.test(t) ? 'credit' : a.negative ? 'debit' : 'credit';
        minor = a.minor;
      }
    }
    if (!dir) { skipped.push({ row: i + 1, reason: 'NO_AMOUNT' }); continue; }
    lines.push({ lineNo: lines.length + 1, date, description: cDesc >= 0 ? (r[cDesc] ?? '').slice(0, 500) : '', reference: cRef >= 0 && r[cRef] ? r[cRef]!.slice(0, 80) : null, direction: dir, amountMinor: minor });
  }
  const dates = lines.map((l) => l.date).sort();
  return { lines, skipped, periodFrom: dates[0] ?? null, periodTo: dates[dates.length - 1] ?? null };
}

// ---------------------------------------------------------------------------------------------------------------------

export interface EntryLite { id: string; kind: 'expense' | 'contribution'; entryDate: string; amountMinor: number; partyName: string; paymentMode: string | null; billNo?: string | null }
export interface LineLite { id: string; date: string; direction: 'debit' | 'credit'; amountMinor: number; description: string; reference: string | null }
export interface Match { status: 'matched' | 'suggested' | 'unmatched'; entryId?: string; candidates: string[] }

/** Payment modes that pass through a bank account. Cash never does, so cash entries are not expected on a statement. */
export const BANK_MODES = new Set(['bank', 'cheque', 'upi', 'card']);

const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/**
 * Pairs bank lines with register entries: same direction, same amount to the paisa, dated within `windowDays` of each other
 * (cheques and transfers clear after the entry date). A line with exactly one possible entry is matched. When several fit,
 * a party name that appears in the bank's description breaks the tie; otherwise the line is only "suggested" for a person to pick.
 */
export function matchLines(lines: LineLite[], entries: EntryLite[], opts: { windowDays?: number } = {}): Map<string, Match> {
  const win = opts.windowDays ?? 10;
  const pool = entries.filter((e) => e.paymentMode == null || BANK_MODES.has(e.paymentMode) || e.paymentMode === 'other');
  const cand = new Map<string, string[]>();
  for (const l of lines) {
    const kind = l.direction === 'debit' ? 'expense' : 'contribution';
    cand.set(l.id, pool.filter((e) => e.kind === kind && e.amountMinor === l.amountMinor && days(e.entryDate, l.date) <= win).map((e) => e.id));
  }
  const out = new Map<string, Match>();
  const taken = new Set<string>();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const score = (l: LineLite, id: string) => {
    const e = byId.get(id)!;
    const text = `${l.description} ${l.reference ?? ''}`.toLowerCase();
    const named = words(e.partyName).filter((w) => text.includes(w)).length;
    const billed = e.billNo && text.includes(e.billNo.toLowerCase()) ? 2 : 0;
    return named + billed - days(e.entryDate, l.date) / 100;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of lines) {
      if (out.has(l.id)) continue;
      const open = cand.get(l.id)!.filter((id) => !taken.has(id));
      let pick: string | null = open.length === 1 ? open[0]! : null;
      if (!pick && open.length > 1) {
        const ranked = open.map((id) => ({ id, s: score(l, id) })).sort((a, b) => b.s - a.s);
        // A clear winner on name or bill number (at least one whole point ahead) is accepted.
        if (ranked[0]!.s >= 1 && ranked[0]!.s - ranked[1]!.s >= 1) pick = ranked[0]!.id;
      }
      if (pick) { taken.add(pick); out.set(l.id, { status: 'matched', entryId: pick, candidates: [pick] }); changed = true; }
    }
  }
  for (const l of lines) {
    if (out.has(l.id)) continue;
    const open = cand.get(l.id)!.filter((id) => !taken.has(id)).sort((a, b) => score(l, b) - score(l, a)).slice(0, 5);
    out.set(l.id, open.length ? { status: 'suggested', candidates: open } : { status: 'unmatched', candidates: [] });
  }
  return out;
}
