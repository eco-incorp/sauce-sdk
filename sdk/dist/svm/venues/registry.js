import { deriverseLadder } from './deriverse/ladder.js';
import { meteoraDammV1Stable } from './meteora-damm-v1-stable/index.js';
import { meteoraDammV1StableLadder } from './meteora-damm-v1-stable/ladder.js';
import { meteoraDammV2 } from './meteora-damm-v2/index.js';
import { meteoraDammV2Ladder } from './meteora-damm-v2/ladder.js';
import { meteoraDlmmLadder } from './meteora-dlmm/ladder.js';
import { manifestLadder } from './manifest/ladder.js';
import { obricV2Ladder } from './obric-v2/ladder.js';
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
// Adapter table. Keys MUST equal adapter.slug — venueAdapter reports them as
// the known-venue list. Constant-product venues first, then the sqrt-price
// and stable ones (the venue-matrix order in the solswap README).
const adapters = {
    [raydiumCpSwap.slug]: raydiumCpSwap,
    [raydiumAmmV4.slug]: raydiumAmmV4,
    [pumpswapAdapter.slug]: pumpswapAdapter,
    [orcaLegacyTokenSwap.slug]: orcaLegacyTokenSwap,
    [meteoraDammV2.slug]: meteoraDammV2,
    [saberStableswap.slug]: saberStableswap,
    [meteoraDammV1Stable.slug]: meteoraDammV1Stable,
};
/** Known venue slugs, in table order. */
export function listVenues() {
    return Object.keys(adapters);
}
/** Looks up a venue adapter by slug; throws listing the known slugs. */
export function venueAdapter(slug) {
    const adapter = adapters[slug];
    if (adapter === undefined) {
        const known = listVenues();
        throw new Error(`unknown venue '${slug}' (known venues: ${known.length > 0 ? known.join(', ') : 'none'})`);
    }
    return adapter;
}
/**
 * The FULL adapter-contract v2 (EcoSwapSVM ladder) registry — every family
 * that implements SvmVenueLadderV2, keyed by slug. This is the single source
 * of truth the ladder-contract guard (test/svm/venues/ladder-contract.test.ts)
 * enumerates with a COUNT ASSERTION: a new family added to sdk/src/svm/venues/
 * without a corresponding entry here gets ZERO contract coverage, silently —
 * the count assertion is what turns that into a loud CI failure instead.
 * Distinct from `adapters` above (the v1 SvmVenueAdapter registry, a strict
 * SUBSET — 7 of these 15 families also implement the v1 surface; manifest/
 * orca-whirlpool/raydium-clmm/meteora-dlmm/obric-v2/solfi-v2/quantum/deriverse
 * are ladder-only).
 */
const ladderAdapters = {
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
    [solfiV2Ladder.slug]: solfiV2Ladder,
    [quantumLadder.slug]: quantumLadder,
    [deriverseLadder.slug]: deriverseLadder,
};
/** Known ladder-family slugs, in table order. */
export function listLadderVenues() {
    return Object.keys(ladderAdapters);
}
/** Looks up a ladder-adapter (v2) by slug; throws listing the known slugs. */
export function ladderVenueAdapter(slug) {
    const adapter = ladderAdapters[slug];
    if (adapter === undefined) {
        const known = listLadderVenues();
        throw new Error(`unknown ladder venue '${slug}' (known venues: ${known.length > 0 ? known.join(', ') : 'none'})`);
    }
    return adapter;
}
//# sourceMappingURL=registry.js.map