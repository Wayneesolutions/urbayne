import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import pino, { type DestinationStream, type Logger } from 'pino';

export type { Logger };

/** Phone numbers (E.164-looking) are never written to logs or error reports. */
export const maskPhones = (s: string) => s.replace(/\+\d{10,15}/g, '[phone]');

/** Fields that must never reach a log line, wherever they appear (pino path syntax). */
export const REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-vapi-secret"]',
  '*.authorization', '*.password', '*.token', '*.accessToken', '*.refreshToken', '*.code', '*.otp',
  '*.phone', '*.phoneEnc', '*.phoneHash', '*.transcript', '*.secret', '*.apiKey',
];

/** Structured JSON logs (one object per line) so CloudWatch / any log tool can search them. */
export function createLogger(opts: { level?: string; destination?: DestinationStream } = {}): Logger {
  return pino({
    level: opts.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'campaign-suite-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    hooks: {
      // Mask phone numbers inside message strings too (for example in an error message from a provider).
      logMethod(args, method) {
        const masked = args.map((a) => (typeof a === 'string' ? maskPhones(a) : a)) as unknown as Parameters<typeof method>;
        return method.apply(this, masked);
      },
    },
  }, opts.destination);
}

/**
 * One log line per request: id, method, path (no query string, no body), status, time taken, who and which campaign.
 * The id is also returned as X-Request-Id and attached to error reports, so a candidate's "it broke at 3pm" can be traced.
 */
export function requestLogger(log: Logger): RequestHandler {
  return (req, res, next) => {
    const given = req.headers['x-request-id'];
    const id = typeof given === 'string' && /^[\w-]{8,64}$/.test(given) ? given : randomUUID();
    req.id = id;
    res.setHeader('X-Request-Id', id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
      const status = res.statusCode;
      const line = {
        reqId: id, method: req.method, path: req.originalUrl.split('?')[0], status, ms,
        tenantId: req.tenant?.id ?? req.params?.tenantId, userId: req.user?.id,
      };
      if (req.path === '/health' || req.path === '/ready') return; // load balancer pings are noise
      if (status >= 500) log.error(line, 'request failed');
      else if (status >= 400) log.warn(line, 'request rejected');
      else log.info(line, 'request');
    });
    next();
  };
}
