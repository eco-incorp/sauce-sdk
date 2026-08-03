import type { SvmVenueAdapter, SvmVenueLadder } from './types.js';
import { aldrinLadder } from './aldrin/index.js';
import { deriverseLadder } from './deriverse/ladder.js';
import { meteoraDammV1Stable } from './meteora-damm-v1-stable/index.js';
import { meteoraDammV1StableLadder } from './meteora-damm-v1-stable/ladder.js';
import { meteoraDammV2 } from './meteora-damm-v2/index.js';
import { meteoraDammV2Ladder } from './meteora-damm-v2/ladder.js';
import { meteoraDlmmLadder } from './meteora-dlmm/ladder.js';
import { manifestLadder } from './manifest/ladder.js';
import { juplendAmmLadder } from './juplend-amm/ladder.js';
import { obricV2Ladder } from './obric-v2/ladder.js';
import { meteoraDbc } from './meteora-dbc/index.js';
import { meteoraDbcLadder } from './meteora-dbc/ladder.js';
import { goonfiV2Ladder } from './goonfi-v2/ladder.js';
import { orcaLegacyTokenSwap } from './orca-legacy-token-swap/index.js';
import { orcaLegacyTokenSwapLadder } from './orca-legacy-token-swap/ladder.js';
import { orcaWhirlpoolLadder } from './orca-whirlpool/ladder.js';
import { pumpswapAdapter } from './pumpswap/index.js';
import { pumpswapLadder } from './pumpswap/ladder.js';
import { raydiumAmmV4 } from './raydium-amm-v4/index.js';
import { raydiumAmmV4Ladder } from './raydium-amm-v4/ladder.js';
import { raydiumClmmLadder } from './raydium-clmm/ladder.js';
import { raydiumCpSwap } from './raydium-cp-swap/index.js';
import { raydiumCpSwapLadder } from './raydium-cp-swap/ladder.js';
import { saberStableswap } from './saber-stableswap/index.js';
import { saberStableswapLadder } from './saber-stableswap/ladder.js';
import { quantumLadder } from './quantum/ladder.js';
import { solfiV2Ladder } from './solfi-v2/ladder.js';
import { stabbleStableSwap } from './stabble-stable-swap/index.js';
import { stabbleStableSwapLadder } from './stabble-stable-swap/ladder.js';
import { stabbleWeightedSwap } from './stabble-weighted-swap/index.js';
import { stabbleWeightedSwapLadder } from './stabble-weighted-swap/ladder.js';
import { tesseravLadder } from './tesserav/ladder.js';
import { woofiLadder } from './woofi/ladder.js';
import { perpsJlpLadder } from './perps-jlp/ladder.js';

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
 * The FULL adapter-contract v2 (SvmRoute ladder) registry — every family
 * that implements SvmVenueLadder, keyed by slug. This is the single source
 * of truth the ladder-contract guard (test/svm/venues/ladder-contract.test.ts)
 * enumerates with a COUNT ASSERTION: a new family added to sdk/src/svm/venues/
 * without a corresponding entry here gets ZERO contract coverage, silently —
 * the count assertion is what turns that into a loud CI failure instead.
 * Distinct from `adapters` above (the v1 SvmVenueAdapter registry, a strict
 * SUBSET — 10 of these 23 families also implement the v1 surface; manifest/
 * orca-whirlpool/raydium-clmm/meteora-dlmm/obric-v2/goonfi-v2/solfi-v2/
 * quantum/tesserav/woofi/deriverse/perps-jlp/juplend-amm are ladder-only).
 *
 * DELIBERATELY NOT YET EXTENDED: 54 more ladder families were migrated in
 * from sauce-recipes' `its SVM venue modules` in the same pass that added
 * this comment (see `sdk/src/svm/venues/index.ts`'s "migrated venue
 * adapters" barrel section for the full list) and are reachable from
 * `@eco-incorp/sauce-sdk/svm` today, but are INTENTIONALLY not added to
 * `ladderAdapters` here, and `sdk/test/svm/venues/ladder-contract.test.ts`'s
 * `FAMILIES`/count-assertion guard covers only the families actually
 * registered below — registering a family there requires a real fixture, a
 * `variants()` closure, and (per that file's strong structural check) a
 * harvested `declaredCliffs` entry for any family whose cold `referenceQuote`
 * has a finite cliff; doing that correctly for 54 families in one pass risks
 * fabricated/undertested coverage more than it's worth, so it is left as
 * NAMED, SEQUENCED follow-up work rather than rushed here. juplend-amm is not
 * one of those 54 — it is a genuinely new ladder family added with its own
 * fixture and contract coverage, hence its entry in `ladderAdapters` below.
 * This is the one hazard the migration itself does not close — every other
 * registration point (barrel exports, self-import rewrite, dedup, dist) is
 * complete and typechecks.
 *
 * `hadron` (salvaged from a sauce-recipes venue PR, oracle-anchored
 * inventory family — see `hadron/index.ts`/`hadron/ladder.ts`) is the SAME
 * "reachable via the barrel, not yet contract-registered" shape as the 54
 * above, for the identical reason: no LiteSVM fixture/`variants()`/
 * `declaredCliffs` harvesting has been done for it here. Follow-up, not a
 * gap this salvage pass closes.
 */
const ladderAdapters: Record<string, SvmVenueLadder> = {
  [aldrinLadder.slug]: aldrinLadder,
  [raydiumCpSwapLadder.slug]: raydiumCpSwapLadder,
  [raydiumAmmV4Ladder.slug]: raydiumAmmV4Ladder,
  [pumpswapLadder.slug]: pumpswapLadder,
  [orcaLegacyTokenSwapLadder.slug]: orcaLegacyTokenSwapLadder,
  [orcaWhirlpoolLadder.slug]: orcaWhirlpoolLadder,
  [raydiumClmmLadder.slug]: raydiumClmmLadder,
  [meteoraDlmmLadder.slug]: meteoraDlmmLadder,
  [manifestLadder.slug]: manifestLadder,
  [meteoraDammV2Ladder.slug]: meteoraDammV2Ladder,
  [saberStableswapLadder.slug]: saberStableswapLadder,
  [meteoraDammV1StableLadder.slug]: meteoraDammV1StableLadder,
  [obricV2Ladder.slug]: obricV2Ladder,
  [goonfiV2Ladder.slug]: goonfiV2Ladder,
  [solfiV2Ladder.slug]: solfiV2Ladder,
  [quantumLadder.slug]: quantumLadder,
  [meteoraDbcLadder.slug]: meteoraDbcLadder,
  [tesseravLadder.slug]: tesseravLadder,
  [woofiLadder.slug]: woofiLadder,
  [deriverseLadder.slug]: deriverseLadder,
  [perpsJlpLadder.slug]: perpsJlpLadder,
  [stabbleStableSwapLadder.slug]: stabbleStableSwapLadder,
  [stabbleWeightedSwapLadder.slug]: stabbleWeightedSwapLadder,
  [juplendAmmLadder.slug]: juplendAmmLadder,
};

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
