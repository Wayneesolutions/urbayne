import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';

/**
 * Fonts served from this server, not from Google. A voter's phone never contacts a third party just to show the page, and the
 * page still works when Google Fonts is slow or blocked. Noto Sans covers Latin (English, French, Tagalog), Gurmukhi (Punjabi) and
 * Devanagari (Hindi). Each script is split into subsets, so a phone only downloads the ones the text on screen needs.
 */
const FAMILIES = ['@fontsource/noto-sans', '@fontsource/noto-sans-gurmukhi', '@fontsource/noto-sans-devanagari'];
const WEIGHTS = [400, 600];
const require_ = createRequire(import.meta.url);

function packageDir(name: string): string {
  return path.dirname(require_.resolve(`${name}/${WEIGHTS[0]}.css`));
}

export function fontsRouter(): Router {
  const dirs = FAMILIES.map(packageDir);
  const css = dirs.flatMap((dir) => WEIGHTS.map((w) => readFileSync(path.join(dir, `${w}.css`), 'utf8')))
    .join('\n')
    // woff2 only (every phone that can run this page supports it), served from /fonts/files/
    .replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, '')
    .replace(/url\(\.\/files\//g, 'url(/fonts/files/')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const r = Router();
  r.get('/fonts.css', (_req, res) => {
    res.type('text/css').setHeader('Cache-Control', 'public, max-age=86400');
    res.send(css);
  });
  r.get('/files/:name', (req, res, next) => {
    const name = req.params.name!;
    if (!/^[a-z0-9-]+\.woff2$/.test(name)) return next();
    const file = dirs.map((d) => path.join(d, 'files', name)).find((f) => existsSync(f));
    if (!file) return next();
    res.type('font/woff2').setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(file);
  });
  return r;
}
