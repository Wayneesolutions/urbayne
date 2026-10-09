import { IN } from './in.js';
import { CA, CA_PROVINCES } from './ca.js';
import type { RegionCode, RegionConfig } from './types.js';

export * from './types.js';
export { IN, CA, CA_PROVINCES };
export * from './filing.js';
export * from './packs.js';

const REGIONS: Record<RegionCode, RegionConfig> = { IN, CA };

export function getRegion(code: RegionCode): RegionConfig {
  const r = REGIONS[code];
  if (!r) throw new Error(`Unknown region: ${code}`);
  return r;
}

/** Provincial rules for a Canadian campaign, or undefined (India, or no province chosen). */
export const getProvince = (region: RegionCode, code: string | null | undefined) => (region === 'CA' && code ? CA_PROVINCES[code] : undefined);
