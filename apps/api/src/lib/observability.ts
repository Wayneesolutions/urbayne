import * as Sentry from '@sentry/node';
import type { Env } from '../env.js';
import { maskPhones } from './logger.js';

export interface ErrorContext { reqId?: string; tenantId?: string; userId?: string; route?: string; job?: string }

/** Where unexpected errors go. Nothing here ever receives request bodies, tokens or phone numbers. */
export interface ErrorReporter {
  readonly name: string;
  capture(err: unknown, ctx?: ErrorContext): void;
  flush(timeoutMs?: number): Promise<void>;
}

export class NoopReporter implements ErrorReporter {
  readonly name = 'none';
  capture() { /* no DSN configured: errors are only in the logs */ }
  async flush() { /* nothing to send */ }
}

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'x-vapi-secret', 'x-forwarded-for', 'x-real-ip'];

/** Removes anything personal from a Sentry event before it leaves the server. Exported for tests. */
export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  if (event.request) {
    delete event.request.data;           // request bodies carry phone numbers, OTP codes, voter answers
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.headers) for (const h of SENSITIVE_HEADERS) delete event.request.headers[h];
  }
  delete event.user;                     // no ids, emails or IPs: we tag the request id and campaign id instead
  if (event.message) event.message = maskPhones(event.message);
  for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = maskPhones(ex.value);
  for (const b of event.breadcrumbs ?? []) {
    if (b.message) b.message = maskPhones(b.message);
    delete b.data;
  }
  return event;
}

export class SentryReporter implements ErrorReporter {
  readonly name = 'sentry';
  capture(err: unknown, ctx: ErrorContext = {}) {
    Sentry.withScope((scope) => {
      for (const [k, v] of Object.entries(ctx)) if (v) scope.setTag(k, String(v));
      Sentry.captureException(err);
    });
  }
  flush(timeoutMs = 2000) { return Sentry.flush(timeoutMs).then(() => undefined); }
}

/** Starts Sentry when SENTRY_DSN is set; otherwise a no-op reporter. */
export function createReporter(env: Pick<Env, 'SENTRY_DSN' | 'SENTRY_ENVIRONMENT' | 'NODE_ENV' | 'DEPLOY_REGION' | 'SENTRY_TRACES_SAMPLE_RATE'>): ErrorReporter {
  if (!env.SENTRY_DSN) return new NoopReporter();
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    initialScope: { tags: { region: env.DEPLOY_REGION } },
    beforeSend: (event) => scrubEvent(event),
  });
  return new SentryReporter();
}
