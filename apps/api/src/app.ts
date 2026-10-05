import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { getRegion } from '@cs/regions';
import { errorHandlerFor } from './lib/http.js';
import { createLogger, requestLogger } from './lib/logger.js';
import { securityHeaders, strictCsp, voterPage } from './lib/security.js';
import { NoopReporter } from './lib/observability.js';
import { costRoutes, adminCostRoutes } from './modules/observability/costs.js';
import { requireUser } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { tenantRoutes } from './routes/tenants.js';
import { contentRoutes } from './routes/content.js';
import { contactRoutes } from './routes/contacts.js';
import { complianceRoutes } from './routes/compliance.js';
import { geoRoutes } from './routes/geo.js';
import { assistantLogRoutes } from './routes/assistant-log.js';
import { callRoutes } from './modules/calls/routes.js';
import { vapiWebhook } from './modules/calls/webhook.js';
import { publicRoutes } from './modules/public/routes.js';
import { shareRoutes, shortLinkRedirect } from './modules/share/routes.js';
import { memberRoutes } from './routes/members.js';
import { fieldRoutes } from './modules/field/routes.js';
import { opsRoutes } from './modules/ops/routes.js';
import { financeRoutes } from './modules/finance/routes.js';
import { privacyRoutes } from './modules/privacy/routes.js';
import { serviceRoutes } from './modules/service/routes.js';
import { servicePublicRoutes } from './modules/service/public.js';
import { inboundSmsRoutes } from './modules/service/inbound.js';
import { serviceAdminRoutes } from './modules/service/admin.js';
import { resultsRoutes } from './modules/results/routes.js';
import { MemoryRateStore, RedisRateStore } from './lib/rate-limit.js';
import { MemorySessions, RedisSessions } from './lib/sessions.js';
import type { Deps, DepsInit } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Fills in rate limits and sessions: Redis-backed when Redis is configured, in-memory otherwise (one server only). */
export function resolveDeps(init: DepsInit): Deps {
  return {
    ...init,
    rateStore: init.rateStore ?? (init.redis ? new RedisRateStore(init.redis) : new MemoryRateStore()),
    sessions: init.sessions ?? (init.redis ? new RedisSessions(init.redis) : new MemorySessions()),
    log: init.log ?? createLogger({ level: init.env.LOG_LEVEL ?? (init.env.NODE_ENV === 'test' ? 'silent' : 'info') }),
    reporter: init.reporter ?? new NoopReporter(),
  };
}

export function createApp(init: DepsInit) {
  const deps = resolveDeps(init);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestLogger(deps.log));
  app.use(securityHeaders({ production: deps.env.NODE_ENV === 'production' }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, region: deps.env.DEPLOY_REGION }));
  // Readiness for the load balancer: can this server reach its database (and Redis)? No details are exposed.
  app.get('/ready', async (_req, res) => {
    const checks: Record<string, boolean> = {};
    try { await deps.pool.query('SELECT 1'); checks.database = true; } catch { checks.database = false; }
    if (deps.redis) { try { checks.redis = (await deps.redis.ping()) === 'PONG'; } catch { checks.redis = false; } }
    const ok = Object.values(checks).every(Boolean);
    res.status(ok ? 200 : 503).json({ ok, checks });
  });
  app.get('/api/region', (_req, res) => {
    const r = getRegion(deps.env.DEPLOY_REGION);
    res.json({ code: r.code, locales: r.locales, defaultLocale: r.defaultLocale, currency: r.currency, geographyLevels: r.geographyLevels });
  });

  // Public (no login)
  app.use('/api/public', servicePublicRoutes(deps));
  app.use('/api/public', publicRoutes(deps));
  app.use('/s', shortLinkRedirect(deps));
  app.use('/webhooks', vapiWebhook(deps));
  app.use('/webhooks/sms', inboundSmsRoutes(deps));
  app.get('/v/:slug', voterPage(path.join(here, 'public', 'voter.html')));
  // Residents' page for constituent service: report a problem and check its progress.
  app.get('/help/:slug', voterPage(path.join(here, 'public', 'help.html')));
  // Booth worker / canvasser app (installable, works offline).
  // Results reporter for polling and counting agents (installable, works offline).
  app.use('/r', strictCsp, express.static(path.join(here, 'public', 'report'), { index: 'index.html' }));
  app.use('/w', strictCsp, express.static(path.join(here, 'public', 'worker'), { index: 'index.html' }));

  // Signed-in
  app.use('/api/auth', authRoutes(deps));
  const authed = requireUser(deps);
  app.use('/api/tenants', authed, tenantRoutes(deps));
  app.use('/api/t/:tenantId/content', authed, contentRoutes(deps));
  app.use('/api/t/:tenantId/contacts', authed, contactRoutes(deps));
  app.use('/api/t/:tenantId/geo', authed, geoRoutes(deps));
  app.use('/api/t/:tenantId/compliance', authed, complianceRoutes(deps));
  app.use('/api/t/:tenantId/calls', authed, callRoutes(deps));
  app.use('/api/t/:tenantId/share-links', authed, shareRoutes(deps));
  app.use('/api/t/:tenantId/assistant', authed, assistantLogRoutes(deps));
  app.use('/api/t/:tenantId/members', authed, memberRoutes(deps));
  app.use('/api/t/:tenantId/field', authed, fieldRoutes(deps));
  app.use('/api/t/:tenantId/ops', authed, opsRoutes(deps));
  app.use('/api/t/:tenantId/finance', authed, financeRoutes(deps));
  app.use('/api/t/:tenantId/privacy', authed, privacyRoutes(deps));
  app.use('/api/t/:tenantId/costs', authed, costRoutes(deps));
  app.use('/api/t/:tenantId/service', authed, serviceRoutes(deps));
  app.use('/api/t/:tenantId/results', authed, resultsRoutes(deps));
  app.use('/api/admin', adminCostRoutes(deps));
  app.use('/api/admin', serviceAdminRoutes(deps));

  // Built dashboard (apps/dashboard/dist), if present.
  const dash = path.resolve(here, '../../dashboard/dist');
  if (existsSync(dash)) {
    app.use('/admin', strictCsp, express.static(dash));
    app.get('/admin/*', strictCsp, (_req, res) => res.sendFile(path.join(dash, 'index.html')));
  }

  app.use(errorHandlerFor(deps.log, deps.reporter));
  return app;
}
