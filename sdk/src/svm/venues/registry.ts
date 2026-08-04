import type { SvmVenueAdapter, SvmVenueLadder } from './types.js';
import { meteoraDammV1Stable } from './meteora-damm-v1-stable/index.js';
import { meteoraDammV2 } from './meteora-damm-v2/index.js';
import { meteoraDbc } from './meteora-dbc/index.js';
import { orcaLegacyTokenSwap } from './orca-legacy-token-swap/index.js';
import { pumpswapAdapter } from './pumpswap/index.js';
import { raydiumAmmV4 } from './raydium-amm-v4/index.js';
import { raydiumCpSwap } from './raydium-cp-swap/index.js';
import { saberStableswap } from './saber-stableswap/index.js';
import { stabbleStableSwap } from './stabble-stable-swap/index.js';
import { stabbleWeightedSwap } from './stabble-weighted-swap/index.js';

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
  [meteoraDbc.slug]: meteoraDbc,
  [stabbleStableSwap.slug]: stabbleStableSwap,
  [stabbleWeightedSwap.slug]: stabbleWeightedSwap,
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

/**
 * The adapter-contract v2 (SvmRoute ladder) registry, keyed by slug.
 *
 * EMPTY BY DESIGN. The eco-swap merge-decomposition ladders this table used to
 * register were relocated to the consuming recipes package, which defines and
 * registers them itself; the SDK keeps only the generic venue integration
 * (pool-account adapters, program ids, pool-config types, AMM/tick math). The
 * few `<venue>/ladder.ts` files still present here were never registered in
 * this table either, so nothing that used to resolve through it does today.
 *
 * The accessors below are retained so the barrel surface does not change shape
 * for downstream consumers; `ladderVenueAdapter` throws for every slug.
 */
const ladderAdapters: Record<string, SvmVenueLadder> = {};

/** Known ladder-family slugs, in table order. */
export function listLadderVenues(): string[] {
  return Object.keys(ladderAdapters);
}

/** Looks up a ladder-adapter (v2) by slug; throws listing the known slugs. */
export function ladderVenueAdapter(slug: string): SvmVenueLadder {
  const adapter = ladderAdapters[slug];
  if (adapter === undefined) {
    const known = listLadderVenues();
    throw new Error(`unknown ladder venue '${slug}' (known venues: ${known.length > 0 ? known.join(', ') : 'none'})`);
  }
  return adapter;
}
