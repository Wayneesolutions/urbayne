import { describe, it, expect } from 'vitest';
import { canonicalJson, sha256Hex, signHash, verifySignature } from '../src/lib/seal.js';
import { scriptRuns } from '../src/lib/evidence-pdf.js';

describe('seal', () => {
  it('hashes the same data identically whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
    expect(sha256Hex(canonicalJson({ a: 1 }))).not.toBe(sha256Hex(canonicalJson({ a: 2 })));
  });
  it('signature verifies only with the right key and hash', () => {
    const h = sha256Hex('x');
    const sig = signHash(h, 'k'.repeat(32));
    expect(verifySignature(h, sig, 'k'.repeat(32))).toBe(true);
    expect(verifySignature(h, sig, 'j'.repeat(32))).toBe(false);
    expect(verifySignature(sha256Hex('y'), sig, 'k'.repeat(32))).toBe(false);
    expect(verifySignature(h, 'short', 'k'.repeat(32))).toBe(false);
  });
});

describe('scriptRuns', () => {
  it('assigns Gurmukhi and Devanagari text to their own fonts', () => {
    const runs = scriptRuns('Hello ਸਤ ਸ੍ਰੀ ਅਕਾਲ and नमस्ते');
    expect(runs.map((r) => r.face)).toEqual(['latin', 'guru', 'latin', 'deva']);
    expect(runs.map((r) => r.text).join('')).toBe('Hello ਸਤ ਸ੍ਰੀ ਅਕਾਲ and नमस्ते');
  });
});
