import type { SvmVenueAdapter } from './types.js';
import { meteoraDammV1Stable } from './meteora-damm-v1-stable/index.js';
import { meteoraDammV2 } from './meteora-damm-v2/index.js';
import { orcaLegacyTokenSwap } from './orca-legacy-token-swap/index.js';
import { pumpswapAdapter } from './pumpswap/index.js';
import { raydiumAmmV4 } from './raydium-amm-v4/index.js';
import { raydiumCpSwap } from './raydium-cp-swap/index.js';
import { saberStableswap } from './saber-stableswap/index.js';

// Adapter table. Keys MUST equal adapter.slug — venueAdapter reports them as
// the known-venue list. Constant-product venues first, then the sqrt-price
// and stable ones (the venue-matrix order in the solswap README).
const adapters: Record<string, SvmVenueAdapter> = {
  [raydiumCpSwap.slug]: raydiumCpSwap,
  [raydiumAmmV4.slug]: raydiumAmmV4,
  [pumpswapAdapter.slug]: pumpswapAdapter,
  [orcaLegacyTokenSwap.slug]: orcaLegacyTokenSwap,
  [meteoraDammV2.slug]: meteoraDammV2,
  [saberStableswap.slug]: saberStableswap,
  [meteoraDammV1Stable.slug]: meteoraDammV1Stable,
};

/** Known venue slugs, in table order. */
export function listVenues(): string[] {
  return Object.keys(adapters);
}

/** Looks up a venue adapter by slug; throws listing the known slugs. */
export function venueAdapter(slug: string): SvmVenueAdapter {
  const adapter = adapters[slug];
  if (adapter === undefined) {
    const known = listVenues();
    throw new Error(`unknown venue '${slug}' (known venues: ${known.length > 0 ? known.join(', ') : 'none'})`);
  }
  return adapter;
}
