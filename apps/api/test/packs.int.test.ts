/** Phase 5: election packages (Punjab 2027, Manitoba 2027), provincial rules and filing formats. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { readSheet } from 'read-excel-file/node';
import { PACKS, BLANK_OPEN, FILING_FORMATS, filingFormat, filingFormatsFor, getProvince, getRegion } from '@cs/regions';
import { renderDisclosure } from '@cs/compliance';
import { createApp } from '../src/app.js';
import { testEnv } from './env.js';
import { ensureUser, tokenFor } from './auth-helper.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

describe('pack and format definitions', () => {
  it('every pack has content in each of its languages and a checklist that makes sense', () => {
    for (const p of PACKS) {
      const region = getRegion(p.region);
      for (const l of p.locales) expect(p.content.some((c) => c.locale === l), `${p.id} has ${l} content`).toBe(true);
      expect(new Set(p.checklist.map((c) => c.id)).size).toBe(p.checklist.length);
      for (const c of p.content) {
        expect(p.locales).toContain(c.locale);
        if (c.kind === 'script') {
          expect(region.aiDisclosure.spoken[c.locale], `${p.id} script ${c.locale} has a disclosure`).toBeTruthy();
          expect(c.body.startsWith('{DISCLOSURE}')).toBe(true);
          expect(c.survey?.[0]?.options.map((o) => o.dtmf)).toEqual(['1', '2', '3', '4', '5', '6']);
        } else expect(c.body.includes(BLANK_OPEN), `${p.id} ${c.kind} ${c.locale} must be a template with blanks`).toBe(true);
      }
    }
  });
  it('the survey asks about issues only: nothing on caste, religion or community', () => {
    const text = JSON.stringify(PACKS.flatMap((p) => p.content)).toLowerCase();
    for (const w of ['caste', 'religion', 'community', 'jati', 'dharm']) expect(text).not.toContain(w);
  });
  it('Manitoba does not guess legal figures', () => {
    const mb = getProvince('CA', 'MB')!;
    expect(mb.spendLimitMinor).toBeNull();
    expect(mb.contributionLimitMinor).toBeNull();
    expect(mb.silenceWindowHours).toBeNull();
    expect(mb.confirmWithCounsel).toEqual(expect.arrayContaining(['spendLimitMinor', 'contributionLimitMinor']));
    expect(getProvince('CA', 'ZZ')).toBeUndefined();
    expect(getProvince('IN', 'MB')).toBeUndefined();
  });
  it('official-looking layouts are drafts until someone confirms them; the platform layout is the default', () => {
    for (const f of FILING_FORMATS) expect(f.confirmed, f.id).toBe(f.id.startsWith('register-'));
    expect(filingFormatsFor('CA', 'expense', 'MB').map((f) => f.id)).toEqual(['register-expense', 'ca-mb-expense-schedule', 'ca-city-expense-schedule']);
    expect(filingFormatsFor('CA', 'expense', null).map((f) => f.id)).toEqual(['register-expense', 'ca-city-expense-schedule']);
    expect(filingFormat('ca-mb-expense-schedule', 'IN', 'expense')).toBeUndefined();
    expect(filingFormatsFor('IN', 'contribution').map((f) => f.id)).toEqual(['register-contribution', 'in-contributions-received']);
  });
});

run('Election packs (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool, inApp: ReturnType<typeof createApp>, caApp: ReturnType<typeof createApp>;
  const tok: Record<string, string> = {};
  const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  let inTenant = '', mbTenant = '';

  async function login(a: typeof inApp, phone: string) {
    const r = await ensureUser(a, phone);
    return (await tokenFor(a, phone)).body.accessToken as string;
  }
  const bin = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, finance_signoffs, finance_entries, content_items, memberships, tenants, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    inApp = createApp({ env: testEnv(), pool });
    caApp = createApp({ env: testEnv({ DEPLOY_REGION: 'CA' }), pool });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tok.in = await login(inApp, '+919800001301');
    tok.inOther = await login(inApp, '+919800001302');
    tok.ca = await login(caApp, '+14165550201');
    inTenant = (await request(inApp).post('/api/tenants').set(as('in')).send({ raceType: 'assembly', seatCode: 'PB-1', electionDate: '2027-02-20', campaignName: 'Punjab Test' })).body.id;
    mbTenant = (await request(caApp).post('/api/tenants').set(as('ca')).send({ raceType: 'municipal', seatCode: 'MB-1', electionDate: '2027-10-05', campaignName: 'Manitoba Test', province: 'MB' })).body.id;
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  it('lists only the packs for this deployment', async () => {
    expect((await request(inApp).get('/api/packs').set(as('in')).expect(200)).body.map((p: any) => p.id)).toEqual(['in-punjab-2027']);
    expect((await request(caApp).get('/api/packs').set(as('ca')).expect(200)).body.map((p: any) => p.id)).toEqual(['ca-mb-2027']);
    await request(inApp).get('/api/packs').expect(401);
  });

  describe('Punjab 2027', () => {
    it('applies as drafts: scripts open with the AI disclosure, nothing is public, pages still have blanks', async () => {
      await request(inApp).post(`/api/t/${inTenant}/pack/apply`).set(as('inOther')).send({ packId: 'in-punjab-2027' }).expect(404);
      await request(inApp).post(`/api/t/${inTenant}/pack/apply`).set(as('in')).send({ packId: 'ca-mb-2027' }).expect(404);
      const r = (await request(inApp).post(`/api/t/${inTenant}/pack/apply`).set(as('in')).send({ packId: 'in-punjab-2027' }).expect(201)).body;
      expect(r.created).toHaveLength(10); // 3 pages + 3 faqs + 3 scripts + the shift reminder text
      expect(r.modules).toEqual(expect.arrayContaining(['calls', 'field', 'finance', 'results']));
      await request(inApp).post(`/api/t/${inTenant}/pack/apply`).set(as('in')).send({ packId: 'in-punjab-2027' }).expect(409);
      const items = await q('SELECT * FROM content_items WHERE tenant_id = $1', [inTenant]);
      expect(items.every((i) => i.status === 'draft')).toBe(true);
      const pa = items.find((i) => i.kind === 'script' && i.locale === 'pa');
      expect(pa.body.startsWith('ਇਹ ਇੱਕ AI ਦੁਆਰਾ ਬਣਾਈ ਗਈ ਕਾਲ ਹੈ।')).toBe(true);
      expect(pa.body).toContain('Punjab Test');
      expect(pa.survey[0].options).toHaveLength(6);
      expect(items.find((i) => i.kind === 'sms_template').template_key).toBe('shift_reminder');
    });

    it('a page with blanks cannot be approved until it is filled in; a script needs only its certificate', async () => {
      const page = (await q("SELECT id FROM content_items WHERE tenant_id = $1 AND kind = 'page' AND locale = 'pa'", [inTenant]))[0];
      const blank = await request(inApp).post(`/api/t/${inTenant}/content/${page.id}/approve`).set(as('in')).send({}).expect(422);
      expect(blank.body.error).toBe('TEMPLATE_NOT_FILLED');
      await request(inApp).patch(`/api/t/${inTenant}/content/${page.id}`).set(as('in')).send({ body: 'ਪਿੰਡ ਲਈ ਪਾਣੀ ਅਤੇ ਸੜਕਾਂ।' }).expect(200);
      await request(inApp).post(`/api/t/${inTenant}/content/${page.id}/approve`).set(as('in')).send({}).expect(200);
      const script = (await q("SELECT id FROM content_items WHERE tenant_id = $1 AND kind = 'script' AND locale = 'hi'", [inTenant]))[0];
      expect((await request(inApp).post(`/api/t/${inTenant}/content/${script.id}/approve`).set(as('in')).send({}).expect(422)).body.error).toBe('CERTIFICATE_REQUIRED');
      await request(inApp).post(`/api/t/${inTenant}/content/${script.id}/approve`).set(as('in')).send({ certificateNo: 'MCMC/PB/2027/001' }).expect(200);
    });

    it('the checklist follows the campaign: system facts tick themselves, the rest are ticked by hand', async () => {
      let p = (await request(inApp).get(`/api/t/${inTenant}/pack`).set(as('in')).expect(200)).body;
      expect(p.applied.id).toBe('in-punjab-2027');
      expect(p.available).toEqual([]);
      const by = (id: string) => p.progress.items.find((i: any) => i.id === id);
      expect(by('content').done).toBe(true); // a page was approved above
      expect(by('profile').done).toBe(false);
      expect(by('poll-close').done).toBe(false);
      expect(by('calling-hours').done).toBe(false); // India's calling hours are not confirmed
      expect(by('mcmc')).toMatchObject({ done: false, manual: true });
      await request(inApp).patch(`/api/tenants/${inTenant}/settings`).set(as('in')).send({ slug: 'punjab-test', spendLimitMinor: 4_000_000_00, pollCloseAt: '2027-02-20T12:30:00Z' }).expect(200);
      await request(inApp).post(`/api/t/${inTenant}/pack/checks/mcmc`).set(as('in')).send({ done: true }).expect(200);
      await request(inApp).post(`/api/t/${inTenant}/pack/checks/profile`).set(as('in')).send({ done: true }).expect(409); // automatic items cannot be ticked by hand
      await request(inApp).post(`/api/t/${inTenant}/pack/checks/nope`).set(as('in')).send({ done: true }).expect(404);
      p = (await request(inApp).get(`/api/t/${inTenant}/pack`).set(as('in')).expect(200)).body;
      expect(['profile', 'poll-close', 'spend-limit', 'mcmc'].map((id) => by(id).done)).toEqual([true, true, true, true]);
      expect(p.progress.done).toBe(p.progress.items.filter((i: any) => i.done).length);
      await request(inApp).post(`/api/t/${inTenant}/pack/checks/mcmc`).set(as('in')).send({ done: false }).expect(200);
      expect((await request(inApp).get(`/api/t/${inTenant}/pack`).set(as('in'))).body.progress.items.find((i: any) => i.id === 'mcmc').done).toBe(false);
    });
  });

  describe('Manitoba 2027', () => {
    it('knows its province, and says which legal figures still need to be entered', async () => {
      const p = (await request(caApp).get(`/api/t/${mbTenant}/pack`).set(as('ca')).expect(200)).body;
      expect(p.province).toMatchObject({ code: 'MB', electionBody: 'Elections Manitoba', unset: ['spendLimitMinor', 'contributionLimitMinor', 'silenceWindowHours'] });
      expect(p.available.map((x: any) => x.id)).toEqual(['ca-mb-2027']);
      await request(caApp).post('/api/tenants').set(as('ca')).send({ raceType: 'municipal', seatCode: 'X-1', electionDate: '2027-10-05', campaignName: 'Bad', province: 'ZZ' }).expect(422);
      await request(caApp).post('/api/tenants').set(as('ca')).send({ raceType: 'municipal', seatCode: 'X-1', electionDate: '2027-10-05', campaignName: 'Bad', province: 'mb' }).expect(400);
    });

    it('applies with English, French, Punjabi and Tagalog content, and French/Tagalog scripts carry their own disclosure', async () => {
      await request(caApp).post(`/api/t/${mbTenant}/pack/apply`).set(as('ca')).send({ packId: 'in-punjab-2027' }).expect(404);
      const r = (await request(caApp).post(`/api/t/${mbTenant}/pack/apply`).set(as('ca')).send({ packId: 'ca-mb-2027' }).expect(201)).body;
      expect(r.created).toHaveLength(9);
      const fr = (await q("SELECT body FROM content_items WHERE tenant_id = $1 AND kind = 'script' AND locale = 'fr'", [mbTenant]))[0];
      const region = getRegion('CA');
      expect(fr.body.startsWith(renderDisclosure({ region, tenant: { id: mbTenant, campaignName: 'Manitoba Test', timeZone: 'America/Winnipeg', pollCloseAt: null, callingHoursOverride: null } }, 'fr'))).toBe(true);
      // The script is approvable as it stands (an owner approval is the Canadian gate): its disclosure is exactly what the engine expects.
      const id = (await q("SELECT id FROM content_items WHERE tenant_id = $1 AND kind = 'script' AND locale = 'tl'", [mbTenant]))[0].id;
      await request(caApp).post(`/api/t/${mbTenant}/content/${id}/approve`).set(as('ca')).send({}).expect(200);
    });

    it('uses the province\'s expense categories', async () => {
      const s = (await request(caApp).get(`/api/t/${mbTenant}/finance/summary`).set(as('ca')).expect(200)).body;
      expect(s.categories).toEqual(getProvince('CA', 'MB')!.expenseCategories);
    });
  });

  describe('filing formats', () => {
    it('lists the layouts and says which are drafts', async () => {
      const f = (await request(caApp).get(`/api/t/${mbTenant}/finance/formats`).set(as('ca')).expect(200)).body;
      expect(f.expense.map((x: any) => [x.id, x.confirmed])).toEqual([['register-expense', true], ['ca-mb-expense-schedule', false], ['ca-city-expense-schedule', false]]);
      expect(f.contribution.map((x: any) => x.id)).toEqual(['register-contribution', 'ca-mb-contributions-list']);
    });

    it('exports in a chosen layout, marking an unconfirmed one as a draft, as CSV or Excel', async () => {
      const e = { entryDate: '2027-09-01', category: 'Signs', description: 'Lawn signs', partyName: 'Print Co', partyAddress: '1 Main St', billNo: 'B-9', paymentMode: 'bank' };
      await request(caApp).post(`/api/t/${mbTenant}/finance/entries`).set(as('ca')).send({ kind: 'expense', amountMinor: 250_000, ...e }).expect(201);
      await request(caApp).post(`/api/t/${mbTenant}/finance/entries`).set(as('ca')).send({ kind: 'contribution', amountMinor: 10_000, entryDate: '2027-09-02', category: 'Donation', description: 'Donation', partyName: 'A Donor', partyAddress: '2 Main St', paymentMode: 'bank', eligibleAttested: true }).expect(201);
      await request(caApp).get(`/api/t/${mbTenant}/finance/export.csv`).set(as('ca')).expect(409); // sign off first
      await request(caApp).post(`/api/t/${mbTenant}/finance/signoff`).set(as('ca')).send({ periodTo: '2027-09-30' }).expect(201);

      const def = (await request(caApp).get(`/api/t/${mbTenant}/finance/export.csv?kind=expense`).set(as('ca')).expect(200)).text.split('\n');
      expect(def[1]).toBe('Date,Category,Description,Paid to,Address,Bill / invoice no.,Quantity,Rate,Amount,Mode,Source,Flags');
      expect(def.join('\n')).not.toContain('DRAFT LAYOUT');

      const mb = (await request(caApp).get(`/api/t/${mbTenant}/finance/export.csv?kind=expense&format=ca-mb-expense-schedule`).set(as('ca')).expect(200)).text.split('\n');
      expect(mb[0]).toContain('Candidate election expenses schedule (Manitoba)');
      expect(mb[1]).toContain('DRAFT LAYOUT');
      expect(mb[1]).toContain('Elections Manitoba');
      expect(mb[2]).toBe('Sl. No.,Date,Nature of expenditure,Particulars,Voucher / bill no.,Supplier,Supplier address,Amount,Mode of payment');
      expect(mb[3]).toBe('1,2027-09-01,Signs,Lawn signs,B-9,Print Co,1 Main St,2500.00,bank');

      const x = await request(caApp).get(`/api/t/${mbTenant}/finance/export.csv?kind=contribution&format=ca-mb-contributions-list&as=xlsx`).set(as('ca')).buffer().parse(bin);
      expect(x.status).toBe(200);
      expect(x.headers['content-type']).toContain('spreadsheetml');
      const rows = (await readSheet(x.body as Buffer)) as unknown[][];
      expect(rows.some((r) => String(r[0]).includes('DRAFT LAYOUT'))).toBe(true);
      expect(rows.find((r) => r[0] === 'Date received')).toBeTruthy();
      expect(rows.find((r) => r[2] === 'A Donor')?.[4]).toBe('100.00');

      await request(caApp).get(`/api/t/${mbTenant}/finance/export.csv?kind=expense&format=in-day-to-day-account`).set(as('ca')).expect(422); // an Indian layout is not offered here
    });
  });
});
