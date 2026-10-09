/** Phase 4: recorded audio for voter pages, self-hosted fonts, and the French / Tagalog pages. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/lib/storage.js';
import { bodyHash, serveAudio } from '../src/modules/audio/audio.js';
import { answer } from '../src/modules/assistant/answer.js';
import { testEnv } from './env.js';
import { ensureUser, tokenFor } from './auth-helper.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

const MP3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256))]);
const MP3_2 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(120, 9)]);

describe('serveAudio', () => {
  const fake = (headers: Record<string, string> = {}) => {
    const out: { status: number; headers: Record<string, string>; body?: Buffer } = { status: 200, headers: {} };
    const res: any = { setHeader: (k: string, v: string) => { out.headers[k.toLowerCase()] = v; return res; }, status: (s: number) => { out.status = s; return res; }, end: (b?: Buffer) => { out.body = b; return res; } };
    return { req: { headers } as any, res, out };
  };
  it('sends the whole file, or the byte range an iPhone asks for', () => {
    let f = fake(); serveAudio(f.req, f.res, MP3, 'audio/mpeg', 'abc');
    expect(f.out.status).toBe(200); expect(f.out.body).toEqual(MP3); expect(f.out.headers['accept-ranges']).toBe('bytes');
    f = fake({ range: 'bytes=0-1' }); serveAudio(f.req, f.res, MP3, 'audio/mpeg', 'abc');
    expect(f.out.status).toBe(206); expect(f.out.headers['content-range']).toBe(`bytes 0-1/${MP3.length}`); expect(f.out.body?.length).toBe(2);
    f = fake({ range: 'bytes=10-' }); serveAudio(f.req, f.res, MP3, 'audio/mpeg', 'abc');
    expect(f.out.body?.length).toBe(MP3.length - 10);
    f = fake({ range: 'bytes=-5' }); serveAudio(f.req, f.res, MP3, 'audio/mpeg', 'abc');
    expect(f.out.body).toEqual(MP3.subarray(MP3.length - 5));
    f = fake({ range: 'bytes=9999-' }); serveAudio(f.req, f.res, MP3, 'audio/mpeg', 'abc');
    expect(f.out.status).toBe(416);
    f = fake({ 'if-none-match': '"abc"' }); serveAudio(f.req, f.res, MP3, 'audio/mpeg', 'abc');
    expect(f.out.status).toBe(304);
  });
  it('a recording is tied to the exact text', () => {
    expect(bodyHash('ਸਤ ਸ੍ਰੀ ਅਕਾਲ')).toBe(bodyHash('ਸਤ ਸ੍ਰੀ ਅਕਾਲ'));
    expect(bodyHash('a')).not.toBe(bodyHash('b'));
  });
});

describe('French and Tagalog assistant', () => {
  it('answers voting questions with the official link, in either language', async () => {
    const llm = { model: 'x' };
    const fr = await answer('Où voter le jour du scrutin ?', 'fr', [], 'https://elections.example', llm);
    expect(fr.outcome).toBe('official_link'); expect(fr.answer).toContain('site officiel');
    const tl = await answer('Saan ang presinto ko?', 'tl', [], 'https://elections.example', llm);
    expect(tl.outcome).toBe('official_link'); expect(tl.answer).toContain('opisyal');
    const handoff = await answer('Quelle est votre position ?', 'fr', [], null, llm);
    expect(handoff.outcome).toBe('handoff'); expect(handoff.answer).toContain('rappellera');
  });
});

run('Recorded audio and fonts (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>, caApp: ReturnType<typeof createApp>;
  const store = new MemoryStore();
  let token = '', tenantId = '', areaId = '', pageId = '', otherToken = '';
  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  const put = (id: string, body: Buffer, qs = '', tk = token) => request(app).put(`/api/t/${tenantId}/content/${id}/audio${qs}`).set(auth(tk)).set('Content-Type', 'audio/mpeg').send(body);
  const area = () => request(app).get(`/api/public/voice-test/areas/${areaId}?locale=pa`);

  async function signIn(a: typeof app, phone: string) {
    const r = await ensureUser(a, phone);
    return (await tokenFor(a, phone)).body.accessToken as string;
  }

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, audio_clips, content_items, stored_files, geo_areas, memberships, tenants, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env: testEnv(), pool, store });
    caApp = createApp({ env: testEnv({ DEPLOY_REGION: 'CA' }), pool, store });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    token = await signIn(app, '+919800000901');
    otherToken = await signIn(app, '+919800000902');
    tenantId = (await request(app).post('/api/tenants').set(auth()).send({ raceType: 'assembly', seatCode: 'AUD-1', electionDate: '2027-02-20', campaignName: 'Audio Test' })).body.id;
    await request(app).patch(`/api/tenants/${tenantId}/settings`).set(auth()).send({ slug: 'voice-test', candidateName: 'Test Candidate' }).expect(200);
    areaId = (await request(app).post(`/api/t/${tenantId}/geo`).set(auth()).send({ level: 'locality', nameEn: 'Test Village' })).body.id;
    pageId = (await request(app).post(`/api/t/${tenantId}/content`).set(auth()).send({ kind: 'page', locale: 'pa', title: 'ਸਾਡੀ ਯੋਜਨਾ', body: 'ਪਿੰਡ ਲਈ ਪਾਣੀ ਅਤੇ ਸੜਕਾਂ।' })).body.id;
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  it('a page without a recording has no audio, and shows up as needing one', async () => {
    await request(app).post(`/api/t/${tenantId}/content/${pageId}/approve`).set(auth()).send({}).expect(200);
    expect((await area().expect(200)).body.pages[0].audioUrl).toBeNull();
    const cov = (await request(app).get(`/api/t/${tenantId}/content/audio-coverage`).set(auth()).expect(200)).body;
    expect(cov.needRecording).toBe(1);
    expect(cov.pages[0]).toMatchObject({ audio: 'none', locale: 'pa' });
  });

  it('stores a recording, and the public page then offers it with range support', async () => {
    const r = await put(pageId, MP3, '?artist=Harpreet&durationMs=8000').expect(201);
    expect(r.body).toMatchObject({ contentType: 'audio/mpeg', durationMs: 8000, recordedBy: 'Harpreet' });
    const url = (await area().expect(200)).body.pages[0].audioUrl as string;
    expect(url).toBe(`/api/public/voice-test/audio/${pageId}`);
    const full = await request(app).get(url).buffer().parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(full.status).toBe(200); expect((full.body as Buffer).equals(MP3)).toBe(true);
    const part = await request(app).get(url).set('Range', 'bytes=0-9').buffer().parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(part.status).toBe(206); expect(part.headers['content-range']).toBe(`bytes 0-9/${MP3.length}`);
    expect((await request(app).get(`/api/t/${tenantId}/content/audio-coverage`).set(auth())).body.pages[0].audio).toBe('ready');
  });

  it('a changed page text makes the recording stale: it is not played until re-recorded', async () => {
    await request(app).patch(`/api/t/${tenantId}/content/${pageId}`).set(auth()).send({ body: 'ਪਿੰਡ ਲਈ ਪਾਣੀ, ਸੜਕਾਂ ਅਤੇ ਸਕੂਲ।' }).expect(200);
    // Back to draft: not public at all.
    expect((await area().expect(200)).body.pages).toHaveLength(0);
    await request(app).get(`/api/public/voice-test/audio/${pageId}`).expect(404);
    await request(app).post(`/api/t/${tenantId}/content/${pageId}/approve`).set(auth()).send({}).expect(200);
    // Approved again, but the voice still says the old text.
    expect((await area().expect(200)).body.pages[0].audioUrl).toBeNull();
    await request(app).get(`/api/public/voice-test/audio/${pageId}`).expect(404);
    expect((await request(app).get(`/api/t/${tenantId}/content/audio-coverage`).set(auth())).body.pages[0].audio).toBe('stale');
    await put(pageId, MP3_2, '?artist=Harpreet').expect(201);
    expect((await area().expect(200)).body.pages[0].audioUrl).toBeTruthy();
    // The old file is gone from storage.
    expect((await q("SELECT 1 FROM stored_files WHERE purpose = 'audio' AND deleted_at IS NULL")).length).toBe(1);
  });

  it('only accepts audio, only for pages, and only from the content team', async () => {
    const r = await put(pageId, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)])).expect(415);
    expect(r.body.error).toBe('FILE_TYPE_NOT_ALLOWED');
    const script = (await request(app).post(`/api/t/${tenantId}/content`).set(auth()).send({ kind: 'faq', locale: 'en', title: 'Q', body: 'A' })).body.id;
    expect((await put(script, MP3).expect(409)).body.error).toBe('AUDIO_ONLY_FOR_PAGES');
    await put(pageId, MP3, '', otherToken).expect(404);
  });

  it('a recording can be removed', async () => {
    await request(app).delete(`/api/t/${tenantId}/content/${pageId}/audio`).set(auth()).expect(200);
    expect((await area().expect(200)).body.pages[0].audioUrl).toBeNull();
    await request(app).delete(`/api/t/${tenantId}/content/${pageId}/audio`).set(auth()).expect(404);
  });

  describe('self-hosted fonts', () => {
    it('serves the stylesheet and font files from this server', async () => {
      const css = await request(app).get('/fonts/fonts.css').expect(200);
      expect(css.headers['content-type']).toContain('text/css');
      expect(css.text).toContain("font-family: 'Noto Sans Gurmukhi'");
      expect(css.text).toContain("font-family: 'Noto Sans Devanagari'");
      expect(css.text).toContain('url(/fonts/files/');
      expect(css.text).not.toMatch(/https?:\/\//);
      const file = css.text.match(/url\((\/fonts\/files\/[a-z0-9-]+\.woff2)\)/)![1]!;
      const f = await request(app).get(file).expect(200);
      expect(f.headers['content-type']).toBe('font/woff2');
      expect(f.headers['cache-control']).toContain('immutable');
    });
    it('does not serve anything else from disk', async () => {
      await request(app).get('/fonts/files/..%2F..%2Fpackage.json').expect(404);
      await request(app).get('/fonts/files/nothing.woff2').expect(404);
      await request(app).get('/fonts/files/x.txt').expect(404);
    });
    it('the voter and help pages call no third party at all', async () => {
      for (const p of ['/v/voice-test', '/help/voice-test']) {
        const r = await request(app).get(p).expect(200);
        expect(r.text).not.toMatch(/googleapis|gstatic/);
        expect(r.text).toContain('/fonts/fonts.css');
        const csp = r.headers['content-security-policy']!;
        expect(csp).toContain("font-src 'self'");
        expect(csp).not.toMatch(/googleapis|gstatic|https:/);
      }
    });
  });

  describe('French and Tagalog (Canada)', () => {
    it('a Canadian campaign offers all five languages on its public page, and the page has French and Tagalog text', async () => {
      const t = await signIn(caApp, '+14165550101');
      const id = (await request(caApp).post('/api/tenants').set(auth(t)).send({ raceType: 'municipal', seatCode: 'MB-WARD-1', electionDate: '2027-10-05', campaignName: 'Winnipeg Test' })).body.id;
      await request(caApp).patch(`/api/tenants/${id}/settings`).set(auth(t)).send({ slug: 'mb-test' }).expect(200);
      const p = (await request(caApp).get('/api/public/mb-test').expect(200)).body;
      expect(p.locales).toEqual(['en', 'pa', 'hi', 'tl', 'fr']);
      expect(p.assistantDisclosure.fr).toContain('assistant IA');
      expect(p.assistantDisclosure.tl).toContain('AI assistant');
      const page = (await request(caApp).get('/v/mb-test').expect(200)).text;
      expect(page).toContain('data-lang="fr"');
      expect(page).toContain('Rappelez-moi');
      expect(page).toContain('Tawagan ako');
      // Content can be written in both languages.
      await request(caApp).post(`/api/t/${id}/content`).set(auth(t)).send({ kind: 'page', locale: 'fr', title: 'Notre plan', body: 'Des rues sûres.' }).expect(201);
      await request(caApp).post(`/api/t/${id}/content`).set(auth(t)).send({ kind: 'page', locale: 'tl', title: 'Ang aming plano', body: 'Ligtas na mga kalsada.' }).expect(201);
    });
    it('an Indian campaign still offers only Punjabi, Hindi and English', async () => {
      expect((await request(app).get('/api/public/voice-test').expect(200)).body.locales).toEqual(['pa', 'hi', 'en']);
    });
  });
});
