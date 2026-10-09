/** Phase 4: household import from electoral roll copies, with source proof. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import writeExcelFile from 'write-excel-file/node';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/lib/storage.js';
import { parseRollRows } from '../src/modules/field/roll.js';
import { purgeTenantData } from '../src/modules/privacy/purge.js';
import { resolveDeps } from '../src/app.js';
import { testEnv } from './env.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

describe('parseRollRows', () => {
  const T = [['S.No', 'Elector Name', 'Relative Name', 'House No', 'Age', 'Gender'], [1, 'A', 'B', '12', 40, 'M'], [2, 'C', 'D', ' 12 ', 38, 'F'], [3, 'E', 'F', '7A', 22, 'F'], [4, 'G', 'H', '', 30, 'M']];
  it('groups one-row-per-elector lists into households and keeps no personal columns', () => {
    const r = parseRollRows(T);
    expect(r.households).toEqual([{ houseNo: '12', address: null, electors: 2 }, { houseNo: '7A', address: null, electors: 1 }]);
    expect(r.rejected).toBe(1);
    expect(r.duplicateRows).toBe(1);
    expect(r.ignoredColumns).toEqual(['S.No', 'Elector Name', 'Relative Name', 'Age', 'Gender']);
  });
  it('uses an electors column and an address column when the list has them', () => {
    const r = parseRollRows([['House', 'Address', 'No. of electors'], ['4', 'Gali 2', 3], ['5', 'Gali 3', '1']]);
    expect(r.households).toEqual([{ houseNo: '4', address: 'Gali 2', electors: 3 }, { houseNo: '5', address: 'Gali 3', electors: 1 }]);
  });
  it('skips lines printed above the table', () => {
    expect(parseRollRows([['Part 14 - Ward 3'], [], ['House No'], ['9']]).households).toHaveLength(1);
  });
  it('refuses a file with caste, religion or community data, and a file with no house column', () => {
    expect(() => parseRollRows([['House No', 'Caste'], ['1', 'x']])).toThrow(/caste, religion or community/);
    expect(() => parseRollRows([['House No', 'Religion'], ['1', 'x']])).toThrow(/caste, religion or community/);
    expect(() => parseRollRows([['Name', 'Age'], ['x', 1]])).toThrow(/house number/);
  });
});

run('Roll import (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  const store = new MemoryStore();
  let token = '', tenantId = '', areaId = '', turfId = '', workerToken = '', outsiderToken = '';
  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  const env = testEnv();
  const csv = 'S.No,Name,House No,Address\n1,A,12,Gali 1\n2,B,12,Gali 1\n3,C,14,Gali 1\n';
  const sheet = (qs: string, body: Buffer | string, type = 'text/csv', tk = token) => request(app).post(`/api/t/${tenantId}/field/roll-imports/spreadsheet?${qs}`).set(auth(tk)).set('Content-Type', type).set('X-File-Name', 'roll.csv').send(body);
  const desc = encodeURIComponent('Certified roll copy, Part 14, received from ERO 3 Jan 2027 under Rule 22');

  async function signIn(phone: string) {
    const r = await request(app).post('/api/auth/otp/request').send({ phone });
    return (await request(app).post('/api/auth/otp/verify').send({ phone, code: r.body.devCode })).body.accessToken as string;
  }

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, households, roll_imports, door_visits, turfs, stored_files, geo_areas, memberships, tenants, otp_codes, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env, pool, store });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    token = await signIn('+919800000801');
    workerToken = await signIn('+919800000802');
    outsiderToken = await signIn('+919800000803');
    tenantId = (await request(app).post('/api/tenants').set(auth()).send({ raceType: 'assembly', seatCode: 'ROLL-1', electionDate: '2027-02-20', campaignName: 'Roll Test' })).body.id;
    const m = (await request(app).post(`/api/t/${tenantId}/members`).set(auth()).send({ phone: '+919800000802', role: 'field_worker' }));
    expect([200, 201]).toContain(m.status);
    areaId = (await request(app).post(`/api/t/${tenantId}/geo`).set(auth()).send({ level: 'locality', nameEn: 'Gali Area' })).body.id;
    const [w] = await q("SELECT id FROM users WHERE phone_hash IS NOT NULL ORDER BY created_at LIMIT 1 OFFSET 1");
    turfId = (await request(app).post(`/api/t/${tenantId}/field/turfs`).set(auth()).send({ geoAreaId: areaId, name: 'Turf A', assignedUserId: w.id })).body.id;
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  it('needs proof of where the list came from, and a real description of the source', async () => {
    await sheet(`areaId=${areaId}&sourceDescription=short`, csv).expect(400);
    const r = await request(app).post(`/api/t/${tenantId}/field/roll-imports`).set(auth()).send({ areaId, sourceDescription: 'Typed from the printed roll, Part 14', rows: [{ houseNo: '1' }] }).expect(400);
    expect(r.body.error).toBe('VALIDATION'); // proofFileId is required for typed-in rows
  });

  it('imports a CSV roll: households only, the roll copy itself kept as proof', async () => {
    const r = await sheet(`areaId=${areaId}&sourceDescription=${desc}`, csv).expect(201);
    expect(r.body).toMatchObject({ households: 2, alreadyOnFile: 0, rejected: 0, rowsTotal: 3 });
    expect(r.body.ignoredColumns).toEqual(['S.No', 'Name']);
    const hs = await q('SELECT house_no, address, electors FROM households ORDER BY house_no');
    expect(hs).toEqual([{ house_no: '12', address: 'Gali 1', electors: 2 }, { house_no: '14', address: 'Gali 1', electors: 1 }]);
    const [imp] = await q('SELECT * FROM roll_imports');
    expect(imp.source_kind).toBe('electoral_roll_copy');
    const [f] = await q('SELECT * FROM stored_files WHERE id = $1', [imp.proof_file_id]);
    expect(f.purpose).toBe('roll_proof');
    expect(store.blobs.get(f.storage_key)?.body.toString()).toBe(csv);
    // No name column from the file reached the database.
    expect(JSON.stringify(await q('SELECT * FROM households'))).not.toMatch(/"A"|"B"|"C"/);
  });

  it('importing the same list again adds nothing new', async () => {
    const r = await sheet(`areaId=${areaId}&sourceDescription=${desc}`, csv).expect(201);
    expect(r.body).toMatchObject({ households: 0, alreadyOnFile: 2 });
    expect((await q('SELECT 1 FROM households')).length).toBe(2);
  });

  it('imports an Excel roll copy', async () => {
    const xlsx = await writeExcelFile([[{ value: 'House No' }, { value: 'Name' }], [{ value: '20' }, { value: 'X' }], [{ value: '21' }, { value: 'Y' }]]).toBuffer();
    const r = await sheet(`areaId=${areaId}&sourceDescription=${desc}`, xlsx, 'application/octet-stream').expect(201);
    expect(r.body).toMatchObject({ households: 2 });
    expect((await q("SELECT format FROM roll_imports ORDER BY created_at DESC LIMIT 1"))[0].format).toBe('xlsx');
  });

  it('a PDF roll goes in as proof, with the households typed in', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    const proof = (await request(app).post(`/api/t/${tenantId}/field/roll-proofs`).set(auth()).set('Content-Type', 'application/pdf').send(pdf).expect(201)).body;
    const r = await request(app).post(`/api/t/${tenantId}/field/roll-imports`).set(auth()).send({
      areaId, proofFileId: proof.fileId, sourceDescription: 'Typed from the printed roll, Part 14, ERO copy', rows: [{ houseNo: '30', electors: 4 }, { houseNo: ' 30 ' }, { houseNo: '31', address: 'Gali 9' }],
    }).expect(201);
    expect(r.body).toMatchObject({ households: 2, rowsTotal: 3 });
    await sheet(`areaId=${areaId}&sourceDescription=${desc}`, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(80)]), 'application/octet-stream').expect(415);
  });

  it('refuses a roll with caste or religion data', async () => {
    const r = await sheet(`areaId=${areaId}&sourceDescription=${desc}`, 'House No,Caste\n1,x\n').expect(422);
    expect(r.body.error).toBe('ROLL_FORBIDDEN_COLUMN');
  });

  it('is limited to the area manager team, and to campaigns the caller belongs to', async () => {
    await sheet(`areaId=${areaId}&sourceDescription=${desc}`, csv, 'text/csv', workerToken).expect(403);
    await sheet(`areaId=${areaId}&sourceDescription=${desc}`, csv, 'text/csv', outsiderToken).expect(404);
  });

  it('shows the houses to the assigned worker as doors, with no names or numbers', async () => {
    const turfs = (await request(app).get(`/api/t/${tenantId}/field/my-turfs`).set(auth(workerToken)).expect(200)).body;
    const doors = turfs[0].households.map((h: any) => h.name);
    expect(doors).toContain('12, Gali 1');
    expect(doors).toContain('14, Gali 1');
    expect(turfs[0].households.find((h: any) => h.name === '12, Gali 1')).toMatchObject({ electors: 2, lastResult: null });
    // A visit to a roll house shows up as its result, and the house is not duplicated in the "extra doors".
    await request(app).post(`/api/t/${tenantId}/field/visits/batch`).set(auth(workerToken)).send({ visits: [{ clientUuid: '7b2f8f0a-3f3b-4d6f-9d57-0c1e1f6c1a01', turfId, household: '12, Gali 1', result: 'supporter', visitedAt: '2027-01-20T10:00:00Z' }] }).expect(200);
    const again = (await request(app).get(`/api/t/${tenantId}/field/my-turfs`).set(auth(workerToken))).body;
    expect(again[0].households.find((h: any) => h.name === '12, Gali 1').lastResult).toBe('supporter');
    expect(again[0].extraDoors).not.toContain('12, Gali 1');
    const manager = (await request(app).get(`/api/t/${tenantId}/field/turfs`).set(auth())).body;
    expect(manager[0].households).toBe(6); // 2 + 2 + 2 roll houses in this area
  });

  it('is deleted with the rest of the personal data after the election', async () => {
    const deps = resolveDeps({ env, pool, store });
    const out = await purgeTenantData(deps, tenantId, { kind: 'owner_request' });
    expect(out && !('alreadyPurged' in out && out.alreadyPurged) && (out as any).counts).toMatchObject({ households: 6 });
    expect(await q('SELECT 1 FROM households')).toHaveLength(0);
    expect(await q('SELECT 1 FROM roll_imports')).toHaveLength(0);
    const files = await q("SELECT deleted_at, storage_key FROM stored_files WHERE purpose = 'roll_proof'");
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) { expect(f.deleted_at).toBeTruthy(); expect(store.blobs.has(f.storage_key)).toBe(false); }
  });
});
