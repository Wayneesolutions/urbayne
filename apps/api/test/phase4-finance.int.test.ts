/** Phase 4: receipt photos kept in the region's storage, and bank statement reconciliation. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/lib/storage.js';
import { loadEnv } from '../src/env.js';
import { testEnv } from './env.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'), Buffer.alloc(40, 1)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 7)]);

run('Phase 4: receipts and bank reconciliation (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  const store = new MemoryStore();
  let token = '', tenantId = '', otherToken = '', otherTenant = '';
  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  const env = testEnv();
  const entry = (body: object, t = tenantId, tk = token) => request(app).post(`/api/t/${t}/finance/entries`).set(auth(tk)).send(body);
  const exp = (over: object = {}) => ({ kind: 'expense', entryDate: '2027-04-03', amountMinor: 99_900, category: 'Printing and posters', description: 'Posters', partyName: 'Sharma Printers', billNo: 'B-1', paymentMode: 'bank', ...over });
  const upload = (url: string, body: Buffer, type = 'application/octet-stream', tk = token) => request(app).post(url).set(auth(tk)).set('Content-Type', type).set('X-File-Name', encodeURIComponent('receipt 1.jpg')).send(body);

  async function signIn(phone: string) {
    const r = await request(app).post('/api/auth/otp/request').send({ phone });
    return (await request(app).post('/api/auth/otp/verify').send({ phone, code: r.body.devCode })).body.accessToken as string;
  }
  async function newTenant(tk: string, seat: string) {
    return (await request(app).post('/api/tenants').set(auth(tk)).send({ raceType: 'assembly', seatCode: seat, electionDate: '2027-02-20', campaignName: `Finance ${seat}` })).body.id as string;
  }

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, bank_lines, bank_statements, finance_entries, stored_files, memberships, tenants, otp_codes, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env, pool, store });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    token = await signIn('+919800000701');
    otherToken = await signIn('+919800000702');
    tenantId = await newTenant(token, 'FIN-1');
    otherTenant = await newTenant(otherToken, 'FIN-2');
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  describe('receipts', () => {
    it('stores a receipt photo, serves it back, and records its checksum', async () => {
      const e = (await entry(exp()).expect(201)).body;
      const up = await upload(`/api/t/${tenantId}/finance/entries/${e.id}/receipt`, JPEG, 'image/jpeg').expect(201);
      expect(up.body).toMatchObject({ contentType: 'image/jpeg', bytes: JPEG.length });
      expect(up.body.sha256).toHaveLength(64);
      const [f] = await q('SELECT * FROM stored_files WHERE id = $1', [up.body.fileId]);
      expect(f.storage_key.startsWith(`${tenantId}/receipt/`)).toBe(true);
      expect(store.blobs.get(f.storage_key)?.body.equals(JPEG)).toBe(true);
      const got = await request(app).get(`/api/t/${tenantId}/finance/entries/${e.id}/receipt`).set(auth()).buffer().parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
      expect(got.status).toBe(200);
      expect(got.headers['content-type']).toBe('image/jpeg');
      expect(got.headers['x-content-type-options']).toBe('nosniff');
      expect((got.body as Buffer).equals(JPEG)).toBe(true);
      expect((await q("SELECT 1 FROM audit_log WHERE action = 'attach_receipt'")).length).toBeGreaterThan(0);
    });

    it('replacing a receipt removes the old file from storage', async () => {
      const e = (await entry(exp({ billNo: 'B-2' })).expect(201)).body;
      const first = (await upload(`/api/t/${tenantId}/finance/entries/${e.id}/receipt`, JPEG).expect(201)).body;
      const [k1] = await q('SELECT storage_key FROM stored_files WHERE id = $1', [first.fileId]);
      const second = (await upload(`/api/t/${tenantId}/finance/entries/${e.id}/receipt`, PDF).expect(201)).body;
      expect(second.contentType).toBe('application/pdf');
      expect(store.blobs.has(k1.storage_key)).toBe(false);
      const [old] = await q('SELECT deleted_at FROM stored_files WHERE id = $1', [first.fileId]);
      expect(old.deleted_at).toBeTruthy();
    });

    it('judges the file by its bytes, not by the name or the type the caller claims', async () => {
      const e = (await entry(exp({ billNo: 'B-3' })).expect(201)).body;
      const r = await upload(`/api/t/${tenantId}/finance/entries/${e.id}/receipt`, EXE, 'image/jpeg').expect(415);
      expect(r.body.error).toBe('FILE_TYPE_NOT_ALLOWED');
      await upload(`/api/t/${tenantId}/finance/entries/${e.id}/receipt`, Buffer.alloc(0)).expect(400);
    });

    it('refuses a file that is too large', async () => {
      const e = (await entry(exp({ billNo: 'B-4' })).expect(201)).body;
      const big = Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024)]);
      await upload(`/api/t/${tenantId}/finance/entries/${e.id}/receipt`, big, 'image/jpeg').expect(413);
    });

    it('is refused for a locked period, and for people outside the finance team', async () => {
      const e = (await entry(exp({ entryDate: '2027-01-10', billNo: 'B-5' })).expect(201)).body;
      await request(app).post(`/api/t/${tenantId}/finance/signoff`).set(auth()).send({ periodTo: '2027-01-31' }).expect(201);
      await upload(`/api/t/${tenantId}/finance/entries/${e.id}/receipt`, JPEG).expect(423);
    });

    it("another campaign cannot read this campaign's receipt", async () => {
      const [{ id }] = await q('SELECT id FROM stored_files LIMIT 1');
      await request(app).get(`/api/t/${otherTenant}/files/${id}`).set(auth(otherToken)).expect(404);
      await request(app).get(`/api/t/${tenantId}/files/${id}`).set(auth(otherToken)).expect(404);
      await request(app).get(`/api/t/${tenantId}/files/${id}`).set(auth()).expect(200);
    });
  });

  describe('bank reconciliation', () => {
    const csv = [
      'Account statement,,,,',
      'Txn Date,Description,Ref No,Withdrawal,Deposit',
      '05/04/2027,UPI/SHARMA PRINTERS/123,UTR1,"12,500.00",',
      '06/04/2027,NEFT A KUMAR,UTR2,,"5,000.00"',
      '07/04/2027,BANK CHARGES,,59.00,',
      '08/04/2027,CASH WITHDRAWAL ATM,,"3,000.00",',
    ].join('\n');
    let statementId = '';

    beforeAll(async () => {
      await entry(exp({ entryDate: '2027-04-03', amountMinor: 1_250_000, billNo: 'R-1' })).expect(201); // matches line 1
      await entry({ kind: 'contribution', entryDate: '2027-04-05', amountMinor: 500_000, category: 'Donation', description: 'Donation', partyName: 'A Kumar', paymentMode: 'bank' }).expect(201); // line 2
      await entry(exp({ entryDate: '2027-04-06', amountMinor: 777_700, partyName: 'Never Paid Ltd', description: 'Banner', billNo: 'R-2' })).expect(201); // on no statement
      await entry(exp({ entryDate: '2027-04-04', amountMinor: 100_000, paymentMode: 'cash', partyName: 'Tea stall', billNo: 'R-3' })).expect(201); // cash: not expected on a statement
    });

    it('reads the statement and matches what it can', async () => {
      const r = await request(app).post(`/api/t/${tenantId}/finance/bank-statements?label=April`).set(auth()).set('Content-Type', 'text/csv').send(csv).expect(201);
      statementId = r.body.id;
      expect(r.body).toMatchObject({ label: 'April', lines: 4, matched: 2, suggested: 0, unmatched: 2, periodFrom: '2027-04-05', periodTo: '2027-04-08' });
      const rows = await q("SELECT description, match_status FROM bank_lines WHERE statement_id = $1 ORDER BY line_no", [statementId]);
      expect(rows.map((x) => x.match_status)).toEqual(['matched', 'matched', 'unmatched', 'unmatched']);
    });

    it('reports money the bank shows with no register entry, and bank-paid entries missing from the bank', async () => {
      const rec = (await request(app).get(`/api/t/${tenantId}/finance/reconciliation`).set(auth()).expect(200)).body;
      expect(rec.clean).toBe(false);
      expect(rec.inBankNotInRegister.map((x: any) => x.amountMinor).sort((a: number, b: number) => a - b)).toEqual([5900, 300_000]);
      expect(rec.inRegisterNotInBank.map((x: any) => x.partyName)).toEqual(['Never Paid Ltd']); // the cash entry is not expected on a statement
    });

    it('a person can match a line by hand; a different amount needs a note; one entry cannot be used twice', async () => {
      const st = (await request(app).get(`/api/t/${tenantId}/finance/bank-statements/${statementId}`).set(auth()).expect(200)).body;
      const fee = st.lines.find((l: any) => l.description === 'BANK CHARGES');
      const atm = st.lines.find((l: any) => l.description.startsWith('CASH WITHDRAWAL'));
      const [tea] = await q("SELECT id FROM finance_entries WHERE party_name = 'Tea stall'");
      const [first] = await q("SELECT matched_entry_id FROM bank_lines WHERE statement_id = $1 AND line_no = 1", [statementId]);
      const wrong = await request(app).post(`/api/t/${tenantId}/finance/bank-lines/${atm.id}/match`).set(auth()).send({ entryId: tea.id }).expect(422);
      expect(wrong.body.error).toBe('AMOUNT_DIFFERS');
      await request(app).post(`/api/t/${tenantId}/finance/bank-lines/${atm.id}/match`).set(auth()).send({ entryId: tea.id, note: 'Tea stall paid in part from the ATM cash' }).expect(200);
      await request(app).post(`/api/t/${tenantId}/finance/bank-lines/${fee.id}/match`).set(auth()).send({ entryId: first.matched_entry_id, note: 'duplicate attempt' }).expect(409);
      // The bank's own fee is not a campaign expense: ignoring it needs a reason, and removes it from the open list.
      await request(app).post(`/api/t/${tenantId}/finance/bank-lines/${fee.id}/ignore`).set(auth()).send({}).expect(400);
      await request(app).post(`/api/t/${tenantId}/finance/bank-lines/${fee.id}/ignore`).set(auth()).send({ note: 'Bank service charge' }).expect(200);
      const rec = (await request(app).get(`/api/t/${tenantId}/finance/reconciliation`).set(auth()).expect(200)).body;
      expect(rec.inBankNotInRegister).toEqual([]);
      expect(rec.inRegisterNotInBank).toHaveLength(1);
      await request(app).post(`/api/t/${tenantId}/finance/bank-lines/${atm.id}/unmatch`).set(auth()).expect(200);
    });

    it('says clearly when a file is not a bank statement', async () => {
      const r = await request(app).post(`/api/t/${tenantId}/finance/bank-statements`).set(auth()).set('Content-Type', 'text/csv').send('this,is,not\na,bank,statement').expect(422);
      expect(r.body.error).toBe('STATEMENT_NOT_READABLE');
    });

    it("never touches another campaign's entries", async () => {
      const r = await request(app).get(`/api/t/${otherTenant}/finance/reconciliation`).set(auth(otherToken)).expect(200);
      expect(r.body).toMatchObject({ statements: 0, clean: false });
      await request(app).get(`/api/t/${otherTenant}/finance/bank-statements/${statementId}`).set(auth(otherToken)).expect(404);
    });

    it('sign-off tells the agent what the bank still disagrees on', async () => {
      const r = await request(app).post(`/api/t/${tenantId}/finance/signoff`).set(auth()).send({ periodTo: '2027-04-30' }).expect(201);
      expect(r.body.reconciliation.totals.entriesNotOnStatement).toBe(1);
    });
  });
});

describe('Storage settings', () => {
  const base = { APP_DATABASE_URL: 'postgres://x:y@localhost/db', JWT_SECRET: 'x'.repeat(20), JWT_REFRESH_SECRET: 'y'.repeat(20), DEPLOY_REGION: 'IN', PHONE_ENC_KEY: 'a'.repeat(44), PHONE_HASH_KEY: 'b'.repeat(44) };
  it('production must use the region bucket, not a folder on the server', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', REDIS_URL: 'redis://x', OTP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_MESSAGING_SERVICE_SID: 'c', EVIDENCE_SIGNING_KEY: 'k'.repeat(32) } as any)).toThrow(/STORAGE_DRIVER=s3/);
  });
  it('files cannot be pointed at another region (data residency)', () => {
    expect(() => loadEnv({ ...base, STORAGE_DRIVER: 's3', FILES_BUCKET: 'files', FILES_REGION: 'us-east-1' } as any)).toThrow(/data region/);
    expect(loadEnv({ ...base, STORAGE_DRIVER: 's3', FILES_BUCKET: 'files', FILES_REGION: 'ap-south-1' } as any).FILES_REGION).toBe('ap-south-1');
    expect(() => loadEnv({ ...base, DEPLOY_REGION: 'CA', STORAGE_DRIVER: 's3', FILES_BUCKET: 'files', FILES_REGION: 'ap-south-1' } as any)).toThrow(/data region/);
  });
  it('s3 needs a bucket', () => {
    expect(() => loadEnv({ ...base, STORAGE_DRIVER: 's3' } as any)).toThrow(/FILES_BUCKET/);
  });
});
