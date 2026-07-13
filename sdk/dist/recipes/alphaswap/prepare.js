/**
 * AlphaSwap off-chain preparation.
 *
 * Only discovers pools — all runtime decisions (liquidity measurement,
 * amount splitting) happen on-chain in the generated SauceScript.
 *
 * Off-chain:  pool discovery via factory multicalls
 * On-chain:   read liquidity, split by depth, execute swaps
 */
import { discoverPools } from "../shared/pool-discovery.js";
import { BASE_TOKENS } from "../shared/constants.js";
// Pools below this threshold contribute negligibly and are excluded.
// Prevents MUL_DIV allocations from rounding to 0 for very small pools.
const MIN_LIQUIDITY = 10n ** 13n;
/**
 * Discover pools for an AlphaSwap. No quoting — all intelligence is on-chain.
 */
export async function prepareAlphaSwap(config, client) {
    const { tokenIn, tokenOut } = config;
    const inLower = tokenIn.toLowerCase();
    const outLower = tokenOut.toLowerCase();
    // Step 1: Discover direct pools (tokenIn → tokenOut)
    const allDirect = await discoverPools(tokenIn, tokenOut, client);
    const directPools = allDirect.filter((p) => p.liquidity >= MIN_LIQUIDITY);
    // Step 2: Discover multi-hop routes through base tokens
    const multiHopRoutes = [];
    for (const baseToken of BASE_TOKENS) {
        const baseLower = baseToken.toLowerCase();
        if (baseLower === inLower || baseLower === outLower)
            continue;
        const [hop1Pools, hop2Pools] = await Promise.all([
            discoverPools(tokenIn, baseToken, client),
            discoverPools(baseToken, tokenOut, client),
        ]);
        if (hop1Pools.length === 0 || hop2Pools.length === 0)
            continue;
        // Pick the deepest pool for each leg (highest liquidity at discovery time).
        // The actual split decision uses fresh liquidity reads on-chain.
        const bestHop1 = hop1Pools.reduce((a, b) => a.liquidity > b.liquidity ? a : b);
        const bestHop2 = hop2Pools.reduce((a, b) => a.liquidity > b.liquidity ? a : b);
        multiHopRoutes.push({
            intermediateToken: baseToken,
            hop1Pool: bestHop1,
            hop2Pool: bestHop2,
        });
    }
    if (directPools.length === 0 && multiHopRoutes.length === 0) {
        throw new Error(`No pools found for ${tokenIn} -> ${tokenOut}`);
    }
    // Filter multi-hop routes: only include routes where effective liquidity
    // (min of both legs) is at least MIN_LIQUIDITY. Sort by effective liquidity
    // descending and keep top 2 to avoid bytecode bloat.
    const filteredMultiHop = multiHopRoutes
        .filter((r) => {
        const effLiq = r.hop1Pool.liquidity < r.hop2Pool.liquidity
            ? r.hop1Pool.liquidity
            : r.hop2Pool.liquidity;
        return effLiq >= MIN_LIQUIDITY;
    })
        .sort((a, b) => {
        const effA = a.hop1Pool.liquidity < a.hop2Pool.liquidity
            ? a.hop1Pool.liquidity
            : a.hop2Pool.liquidity;
        const effB = b.hop1Pool.liquidity < b.hop2Pool.liquidity
            ? b.hop1Pool.liquidity
            : b.hop2Pool.liquidity;
        return effB > effA ? 1 : effB < effA ? -1 : 0;
    })
        .slice(0, 2);
    // Step 3: Cross-filter by relative liquidity.
    // When one route has massively higher liquidity (e.g., 3.6e20 vs 2e15),
    // the proportional split gives negligible allocations to small routes.
    // For multi-hop, tiny hop1 allocations produce 0 intermediate tokens,
    // causing hop2 to fail with amountSpecified=0.
    // Exclude any multi-hop route whose effective liquidity is < 0.1% of
    // the deepest route (direct or multi-hop).
    const effLiq = (r) => r.hop1Pool.liquidity < r.hop2Pool.liquidity
        ? r.hop1Pool.liquidity
        : r.hop2Pool.liquidity;
    const allLiqs = [
        ...directPools.map((p) => p.liquidity),
        ...filteredMultiHop.map(effLiq),
    ];
    const maxLiq = allLiqs.reduce((a, b) => (a > b ? a : b), 0n);
    const relativeThreshold = maxLiq / 1000n; // 0.1%
    const finalMultiHop = filteredMultiHop.filter((r) => effLiq(r) >= relativeThreshold);
    return { directPools, multiHopRoutes: finalMultiHop };
}
//# sourceMappingURL=prepare.js.map