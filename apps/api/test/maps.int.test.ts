/** Phase 4: map tiles and road routing for turfs and lawn signs. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { roadTrip, MAX_ROAD_STOPS } from '../src/lib/routing.js';
import { dashboardCsp } from '../src/lib/security.js';
import { testEnv } from './env.js';
import { ensureUser, tokenFor } from './auth-helper.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

const start = { lat: 49.9, lng: -97.1 };
const stops = [{ id: 'a', lat: 49.91, lng: -97.11 }, { id: 'b', lat: 49.95, lng: -97.2 }, { id: 'c', lat: 49.92, lng: -97.12 }];
/** What an OSRM /trip answer looks like: waypoint_index is where each INPUT point lands in the trip. */
const osrm = (over: object = {}) => ({
  code: 'Ok',
  waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }, { waypoint_index: 3 }, { waypoint_index: 2 }],
  trips: [{ distance: 12_345, duration: 1_500, geometry: { coordinates: [[-97.1, 49.9], [-97.11, 49.91], [-97.12, 49.92], [-97.2, 49.95]] } }],
  ...over,
});
const stub = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('roadTrip', () => {
  it('orders the stops by the road trip, and returns the road line as [lat, lng]', async () => {
    const f = stub(osrm());
    const r = await roadTrip('https://osrm.example/', start, stops, f);
    expect(r).toEqual({ order: ['a', 'c', 'b'], km: 12.3, minutes: 25, geometry: [[49.9, -97.1], [49.91, -97.11], [49.92, -97.12], [49.95, -97.2]] });
    const url = (f as any).mock.calls[0][0] as string;
    expect(url).toContain('/trip/v1/driving/-97.100000,49.900000;-97.110000,49.910000;');
    expect(url).toContain('roundtrip=false&source=first');
  });
  it('gives up (null) instead of guessing when anything is off, so callers fall back to straight lines', async () => {
    expect(await roadTrip(undefined, start, stops, stub(osrm()))).toBeNull();
    expect(await roadTrip('https://x', start, [], stub(osrm()))).toBeNull();
    expect(await roadTrip('https://x', start, Array.from({ length: MAX_ROAD_STOPS + 1 }, (_, i) => ({ id: String(i), lat: 1, lng: 1 })), stub(osrm()))).toBeNull();
    expect(await roadTrip('https://x', start, stops, stub({}, false))).toBeNull();
    expect(await roadTrip('https://x', start, stops, stub(osrm({ code: 'NoTrips' })))).toBeNull();
    expect(await roadTrip('https://x', start, stops, stub(osrm({ waypoints: [{ waypoint_index: 0 }] })))).toBeNull(); // wrong number of points
    expect(await roadTrip('https://x', start, stops, stub(osrm({ waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }, { waypoint_index: 1 }, { waypoint_index: 2 }] })))).toBeNull(); // duplicate positions
    expect(await roadTrip('https://x', start, stops, stub(osrm({ waypoints: [{ waypoint_index: 2 }, { waypoint_index: 1 }, { waypoint_index: 0 }, { waypoint_index: 3 }] })))).toBeNull(); // does not start at the start
    expect(await roadTrip('https://x', start, stops, (async () => { throw new Error('down'); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe('dashboard CSP', () => {
  const csp = (url: string) => { let v = ''; dashboardCsp(url)({} as any, { setHeader: (_k: string, x: string) => { v = x; } } as any, () => {}); return v; };
  it('allows pictures only from the configured tile server', () => {
    expect(csp('https://tile.openstreetmap.org/{z}/{x}/{y}.png')).toContain('img-src \'self\' data: blob: https://tile.openstreetmap.org;');
    expect(csp('https://{s}.tiles.example.com/{z}/{x}/{y}.png')).toContain('https://*.tiles.example.com');
    expect(csp('not a url')).toContain("img-src 'self' data: blob:;");
    expect(csp('https://tile.openstreetmap.org/{z}/{x}/{y}.png')).toContain("script-src 'self'");
  });
});

run('Maps and routes (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  let token = '', tenantId = '', areaId = '';
  const auth = () => ({ Authorization: `Bearer ${token}` });
  let osrmFetch = stub(osrm());

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, signs, turfs, geo_areas, memberships, tenants, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env: testEnv({ ROUTING_BASE_URL: 'https://osrm.example', MAP_TILE_URL: 'https://tiles.example/{z}/{x}/{y}.png' }), pool, fetch: ((...a: unknown[]) => (osrmFetch as any)(...a)) as typeof fetch });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await ensureUser(app, '+919800001401');
    token = (await tokenFor(app, '+919800001401')).body.accessToken;
    tenantId = (await request(app).post('/api/tenants').set(auth()).send({ raceType: 'assembly', seatCode: 'MAP-1', electionDate: '2027-02-20', campaignName: 'Map Test' })).body.id;
    await request(app).patch(`/api/tenants/${tenantId}/settings`).set(auth()).send({ officeLat: 49.9, officeLng: -97.1 }).expect(200);
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  it('tells the dashboard where to get map pictures from, and its CSP allows only that', async () => {
    expect((await request(app).get('/api/region').expect(200)).body.map).toEqual({ tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' });
  });

  it('puts areas on the map as a point or an outline, and refuses nonsense', async () => {
    areaId = (await request(app).post(`/api/t/${tenantId}/geo`).set(auth()).send({ level: 'locality', nameEn: 'Ward 1', shape: { type: 'Point', coordinates: [-97.12, 49.91] } }).expect(201)).body.id;
    const ring = [[-97.2, 49.9], [-97.1, 49.9], [-97.1, 50], [-97.2, 50], [-97.2, 49.9]];
    const r = await request(app).patch(`/api/t/${tenantId}/geo/${areaId}`).set(auth()).send({ shape: { type: 'Polygon', coordinates: [ring] } }).expect(200);
    expect(r.body.polygon.type).toBe('Polygon');
    await request(app).patch(`/api/t/${tenantId}/geo/${areaId}`).set(auth()).send({ shape: { type: 'Point', coordinates: [200, 49] } }).expect(400); // longitude out of range
    await request(app).patch(`/api/t/${tenantId}/geo/${areaId}`).set(auth()).send({ shape: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } }).expect(400); // not a closed ring
    await request(app).patch(`/api/t/${tenantId}/geo/${areaId}`).set(auth()).send({ shape: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }).expect(400);
    const turf = await request(app).post(`/api/t/${tenantId}/field/turfs`).set(auth()).send({ geoAreaId: areaId, name: 'Ward 1 list' }).expect(201);
    const turfs = (await request(app).get(`/api/t/${tenantId}/field/turfs`).set(auth()).expect(200)).body;
    expect(turfs.find((x: any) => x.id === turf.body.id).shape.type).toBe('Polygon'); // the map page draws it
  });

  it('sign route follows the roads when a routing server answers', async () => {
    for (const [i, [lat, lng]] of [[49.91, -97.11], [49.95, -97.2], [49.92, -97.12]].entries()) {
      await request(app).post(`/api/t/${tenantId}/ops/signs`).set(auth()).send({ address: `${i + 1} Main St`, lat, lng }).expect(201);
    }
    osrmFetch = stub(osrm({ waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }, { waypoint_index: 3 }, { waypoint_index: 2 }] }));
    const r = (await request(app).get(`/api/t/${tenantId}/ops/signs/route`).set(auth()).expect(200)).body;
    expect(r).toMatchObject({ routing: 'road', km: 12.3, minutes: 25 });
    expect(r.order.map((o: any) => o.address)).toEqual(['1 Main St', '3 Main St', '2 Main St']);
    expect(r.geometry).toHaveLength(4);
  });

  it('falls back to straight-line ordering when the routing server is down', async () => {
    osrmFetch = stub({}, false);
    const r = (await request(app).get(`/api/t/${tenantId}/ops/signs/route`).set(auth()).expect(200)).body;
    expect(r).toMatchObject({ routing: 'straight_line', geometry: null, minutes: null });
    expect(r.order).toHaveLength(3);
    expect(r.km).toBeGreaterThan(0);
  });
});
