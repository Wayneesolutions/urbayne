import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { Logger } from 'pino';
import type { ErrorReporter } from './observability.js';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);

/**
 * Turns errors into JSON answers. Expected errors (HttpError, validation) are the caller's problem and are not reported;
 * anything else is a bug: it is logged with the request id and sent to the error reporter, and the caller only sees INTERNAL.
 */
export function errorHandlerFor(log: Logger, reporter: ErrorReporter) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      if (err.status >= 500) log.error({ reqId: req.id, code: err.code }, 'request failed');
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) return res.status(400).json({ error: 'VALIDATION', issues: err.issues });
    const kind = (err as { type?: string } | null)?.type;
    if (kind === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_JSON' });
    if (kind === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
    log.error({ reqId: req.id, err }, 'unhandled error');
    reporter.capture(err, { reqId: req.id, tenantId: req.params?.tenantId, userId: req.user?.id, route: `${req.method} ${req.baseUrl}${req.route?.path ?? ''}` });
    return res.status(500).json({ error: 'INTERNAL', requestId: req.id });
  };
}
