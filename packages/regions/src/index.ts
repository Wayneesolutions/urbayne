import { IN } from './in.js';
import { CA } from './ca.js';
import type { RegionCode, RegionConfig } from './types.js';

export * from './types.js';
export { IN, CA };

const REGIONS: Record<RegionCode, RegionConfig> = { IN, CA };

export function getRegion(code: RegionCode): RegionConfig {
  const r = REGIONS[code];
  if (!r) throw new Error(`Unknown region: ${code}`);
  return r;
}
