import { readSheet } from 'read-excel-file/node';
import { schema, withTenant } from '@cs/db';
import { HttpError } from '../../lib/http.js';
import { looksLikeText } from '../files/files.js';
import { parseCsv } from '../finance/reconcile.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

/** Columns that must never be in a list we hold. A file with one of these is refused, not trimmed. */
const FORBIDDEN = /caste|jati|jaati|religion|dharm|community|creed|\bsc\s*\/?\s*st\b|\bobc\b/i;
const HOUSE = /house|h\.?\s?no|door|ghar|makan|building|flat|ਮਕਾਨ|ਘਰ|मकान|घर/i;
const ADDRESS = /address|street|locality|village|ward|colony|mohalla|gali|pata|ਪਤਾ|पता/i;
const ELECTORS = /^(no\.?\s*of\s*)?(electors|voters|members|persons|inmates|count|total)$/i;

export interface RollHousehold { houseNo: string; address: string | null; electors: number | null }
export interface RollParse { households: RollHousehold[]; total: number; rejected: number; duplicateRows: number; ignoredColumns: string[] }

export const normHouseNo = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 40);

/**
 * Turns the rows of a roll copy (one row per elector, or one per household) into households. Only house number, address and
 * the number of electors are read; every other column (names, ages, relatives, ...) is dropped and listed as ignored.
 */
export function parseRollRows(table: unknown[][]): RollParse {
  const rows = table.filter((r) => r.some((c) => c != null && String(c).trim() !== ''));
  const hi = rows.findIndex((r) => r.some((c) => HOUSE.test(String(c ?? ''))));
  if (hi < 0) throw new HttpError(422, 'ROLL_NO_HOUSE_COLUMN', 'The file needs a column with the house number (for example "House No").');
  const head = rows[hi]!.map((c) => String(c ?? '').trim());
  const bad = head.filter((h) => h && FORBIDDEN.test(h));
  if (bad.length) throw new HttpError(422, 'ROLL_FORBIDDEN_COLUMN', `This platform does not hold caste, religion or community data. Remove the column(s) and upload again: ${bad.join(', ')}`);
  const cHouse = head.findIndex((h) => HOUSE.test(h));
  const cAddr = head.findIndex((h, i) => i !== cHouse && ADDRESS.test(h));
  const cElec = head.findIndex((h, i) => i !== cHouse && ELECTORS.test(h));
  const ignoredColumns = head.filter((h, i) => h && ![cHouse, cAddr, cElec].includes(i));

  const byHouse = new Map<string, { address: string | null; rows: number; explicit: number | null }>();
  let rejected = 0, duplicateRows = 0;
  for (const r of rows.slice(hi + 1)) {
    const raw = r[cHouse];
    const houseNo = raw == null ? '' : normHouseNo(String(raw));
    if (!houseNo) { rejected++; continue; }
    const addr = cAddr >= 0 && r[cAddr] != null ? String(r[cAddr]).replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;
    const ev = cElec >= 0 ? Number(String(r[cElec] ?? '').replace(/[^\d]/g, '')) : NaN;
    const cur = byHouse.get(houseNo);
    if (cur) {
      cur.rows++; duplicateRows++;
      if (!cur.address && addr) cur.address = addr;
      if (Number.isFinite(ev) && ev > 0) cur.explicit = Math.max(cur.explicit ?? 0, ev);
    } else byHouse.set(houseNo, { address: addr, rows: 1, explicit: Number.isFinite(ev) && ev > 0 ? ev : null });
  }
  // With no "electors" column the roll lists one elector per row, so the household's electors are its rows.
  const households = [...byHouse].map(([houseNo, h]) => ({ houseNo, address: h.address, electors: cElec >= 0 ? h.explicit : h.rows }));
  return { households, total: rows.length - hi - 1, rejected, duplicateRows, ignoredColumns };
}

/** Reads a CSV or Excel upload into rows. */
export async function readTable(buf: Buffer, type: string): Promise<unknown[][]> {
  if (type === 'text/csv') return looksLikeText(buf) ? parseCsv(buf.toString('utf8')) : [];
  if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    try { return (await readSheet(buf)) as unknown[][]; } catch { throw new HttpError(422, 'ROLL_NOT_READABLE', 'The Excel file could not be read. Save it again as .xlsx or export it as CSV.'); }
  }
  throw new HttpError(415, 'ROLL_FORMAT', 'Upload the roll copy as an Excel (.xlsx) or CSV file. For a PDF, upload it as proof and type or paste the households in.');
}

export const MAX_ROLL_ROWS = 20_000;

/** Saves households for one area. Houses already on file for the area are left as they are and counted as duplicates. */
export async function saveHouseholds(db: Db, tenantId: string, areaId: string, importId: string, list: RollHousehold[]) {
  let imported = 0, existing = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const out = await db.insert(schema.households).values(chunk.map((h) => ({ tenantId, geoAreaId: areaId, rollImportId: importId, houseNo: h.houseNo, address: h.address, electors: h.electors })))
      .onConflictDoNothing().returning({ id: schema.households.id });
    imported += out.length; existing += chunk.length - out.length;
  }
  return { imported, existing };
}

export const householdLabel = (h: { houseNo: string; address: string | null }) => (h.address ? `${h.houseNo}, ${h.address}` : h.houseNo).slice(0, 200);
