/**
 * MegaSwap off-chain preparation.
 *
 * 1. Discover pools for the token pair across protocols and fee tiers
 * 2. Quote each pool with max slippage price limit
 * 3. Calculate adaptive slippage: stepSize = minDelta / 2
 * 4. Filter shallow pools (delta > 10x minDelta)
 * 5. Return prepared pool data for codegen
 */
import { discoverPools } from "../shared/pool-discovery.js";
import { quotePool } from "../shared/quoting.js";
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO } from "../shared/constants.js";
function abs(x) {
    return x < 0n ? -x : x;
}
/**
 * Prepare a MegaSwap: discover pools, quote, calculate slippage parameters.
 */
export async function prepareMegaSwap(config, client, sauceRouterAddress) {
    const { tokenIn, tokenOut, amountIn } = config;
    // Determine swap direction
    const zeroForOne = tokenIn.toLowerCase() < tokenOut.toLowerCase();
    // Max slippage price limit for quoting (essentially unlimited)
    const maxPriceLimit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
    // Step 1: Discover pools
    const pools = await discoverPools(tokenIn, tokenOut, client);
    if (pools.length === 0) {
        throw new Error(`No pools found for ${tokenIn} -> ${tokenOut}`);
    }
    // Step 2: Quote each pool
    const quotedPools = [];
    for (const pool of pools) {
        const quote = await quotePool(pool, amountIn, maxPriceLimit, sauceRouterAddress, client);
        if (quote.amountOut === 0n)
            continue;
        const delta = abs(quote.sqrtPriceAfter - pool.sqrtPriceX96);
        quotedPools.push({
            pool,
            quote,
            delta,
            feeAdjustedLimit: 0n, // calculated below
        });
    }
    if (quotedPools.length === 0) {
        throw new Error("No pools returned valid quotes");
    }
    // Step 3: Find deepest pool (smallest delta) and calculate step size
    const minDelta = quotedPools.reduce((min, p) => (p.delta < min ? p.delta : min), quotedPools[0].delta);
    const stepSize = minDelta / 2n;
    // Step 4: Filter shallow pools (delta > 10x minDelta)
    const filteredPools = quotedPools.filter((p) => p.delta <= minDelta * 10n);
    // Step 5: Calculate fee-adjusted price limits
    // Initial price limit starts from current price of the deepest pool
    const deepestPool = filteredPools.reduce((best, p) => p.delta < best.delta ? p : best);
    const initialPriceLimit = deepestPool.pool.sqrtPriceX96;
    for (const p of filteredPools) {
        // Adjust limit by fee: limit * (1 + fee / 2e6)
        // For zeroForOne: we want a lower limit, so subtract the fee adjustment
        // For oneForZero: we want a higher limit, so add the fee adjustment
        const feeAdj = (initialPriceLimit * BigInt(p.pool.fee)) / 2000000n;
        p.feeAdjustedLimit = zeroForOne
            ? initialPriceLimit - feeAdj
            : initialPriceLimit + feeAdj;
    }
    // Calculate total expected output
    const expectedOutput = filteredPools.reduce((sum, p) => sum + p.quote.amountOut, 0n);
    return {
        pools: filteredPools,
        stepSize,
        initialPriceLimit,
        zeroForOne,
        expectedOutput,
    };
}
//# sourceMappingURL=prepare.js.map