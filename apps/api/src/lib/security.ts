import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RequestHandler } from 'express';

/** Headers every response gets. */
export function securityHeaders(opts: { production: boolean }): RequestHandler {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), payment=()');
    if (opts.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // API answers can hold personal data: nothing in a shared or browser cache.
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhooks/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

const FONTS_STYLE = "https://fonts.googleapis.com";
const FONTS_FILES = "https://fonts.gstatic.com";

/** CSP for the dashboard and the booth-worker app: scripts only from this server. */
export const strictCsp: RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", `style-src 'self' 'unsafe-inline' ${FONTS_STYLE}`, `font-src ${FONTS_FILES}`,
    "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join('; '));
  next();
};

/**
 * The voter page has one inline script. It is allowed by a fresh nonce on every response (not by 'unsafe-inline'),
 * so an injected script would not run.
 */
export function voterPage(file: string): RequestHandler {
  const html = readFileSync(file, 'utf8');
  return (_req, res) => {
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', [
      // Nothing from a third party: fonts come from this server (see lib/fonts.ts), so a voter's phone contacts only the campaign's own address.
      "default-src 'self'", `script-src 'nonce-${nonce}'`, "style-src 'self' 'unsafe-inline'", "font-src 'self'",
      "img-src 'self' data:", "connect-src 'self'", "media-src 'self' blob:", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
    ].join('; '));
    res.type('html').send(html.replace(/<script>/g, `<script nonce="${nonce}">`));
  };
}
