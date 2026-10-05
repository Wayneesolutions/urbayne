import { createHmac } from 'node:crypto';
import type { Env } from '../env.js';

/** Key that signs evidence PDFs. Production must set EVIDENCE_SIGNING_KEY; development derives one from JWT_SECRET. */
/** Keys to try when verifying a seal: the current one, then the previous one during a rotation. */
export function evidenceKeys(env: Pick<Env, 'EVIDENCE_SIGNING_KEY' | 'EVIDENCE_SIGNING_KEY_PREVIOUS' | 'JWT_SECRET'>): string[] {
  return [evidenceKey(env), ...(env.EVIDENCE_SIGNING_KEY_PREVIOUS ? [env.EVIDENCE_SIGNING_KEY_PREVIOUS] : [])];
}

export function evidenceKey(env: Pick<Env, 'EVIDENCE_SIGNING_KEY' | 'JWT_SECRET'>): string {
  return env.EVIDENCE_SIGNING_KEY ?? createHmac('sha256', env.JWT_SECRET).update('evidence-seal-dev-key').digest('hex');
}
