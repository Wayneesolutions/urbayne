import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import { HttpError } from './http.js';
import type { Deps } from '../types.js';
import type { ChannelEnv } from '@cs/channels';

export const now = (deps: Deps) => (deps.now ? deps.now() : new Date());

export const maskPhone = (p: string) => (p.length > 6 ? `${p.slice(0, p.length - 7)}*****${p.slice(-2)}` : '****');

const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
export const shortCode = (n = 7) => Array.from(randomBytes(n), (b) => ALPHA[b % ALPHA.length]).join('');

export function channelEnv(deps: Deps): ChannelEnv {
  if (deps.channels) return deps.channels;
  const e = deps.env;
  return {
    vapi: e.VAPI_API_KEY && e.VAPI_PHONE_NUMBER_ID && e.VAPI_ASSISTANT_ID
      ? { apiKey: e.VAPI_API_KEY, phoneNumberId: e.VAPI_PHONE_NUMBER_ID, assistantId: e.VAPI_ASSISTANT_ID } : null,
    twilioSms: e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_MESSAGING_SERVICE_SID
      ? { accountSid: e.TWILIO_ACCOUNT_SID, authToken: e.TWILIO_AUTH_TOKEN, messagingServiceSid: e.TWILIO_MESSAGING_SERVICE_SID } : null,
  };
}

/** Small in-memory rate limiter for public endpoints (per process; use Redis in production). */
export function rateLimit(max: number, windowMs: number): RequestHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req, _res, next) => {
    const k = `${req.ip}:${req.baseUrl}${req.path}`;
    const t = Date.now();
    const h = hits.get(k);
    if (!h || h.reset < t) { hits.set(k, { n: 1, reset: t + windowMs }); return next(); }
    if (++h.n > max) return next(new HttpError(429, 'RATE_LIMITED'));
    next();
  };
}
