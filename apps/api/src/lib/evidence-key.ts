import { createHmac } from 'node:crypto';
import type { Env } from '../env.js';

/** Key that signs evidence PDFs. Production must set EVIDENCE_SIGNING_KEY; development derives one from JWT_SECRET. */
export function evidenceKey(env: Pick<Env, 'EVIDENCE_SIGNING_KEY' | 'JWT_SECRET'>): string {
  return env.EVIDENCE_SIGNING_KEY ?? createHmac('sha256', env.JWT_SECRET).update('evidence-seal-dev-key').digest('hex');
}
