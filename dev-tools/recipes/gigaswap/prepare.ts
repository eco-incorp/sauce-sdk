/**
 * GigaSwap off-chain preparation.
 *
 * Discovers ALL liquidity sources (V3 + V2), measures depth via quoting,
 * and separates pools into two execution categories:
 *
 * Price-limited pools (V3/V4): No pre-split needed. On-chain, each gets
 *   the full remaining balance + globalPriceLimit. The limit naturally
 *   caps fill — deeper pools absorb more. Positive slippage absorbed.
 *
 * No-limit pools (V2/Solidly): Pre-computed depth-proportional splits
 *   based on full-amount quote simulation.
 *
 * Global price limit derived from V3 pool with lowest delta (tightest).
 *
 * On-chain:
 *   Series 1: V3 pools sequential (full balance + limit), then V2 (splits)
 *   Series 2: Sweep leftovers with inverse-delta depth weighting
 */

import type { PublicClient, Hex } from "viem";
import { discoverPools } from "../shared/pool-discovery";
import { quotePool } from "../shared/quoting";
import { BASE_TOKENS, MIN_SQRT_RATIO, MAX_SQRT_RATIO, BASE_CHAIN_POOL_CONFIG, type ChainPoolConfig } from "../shared/constants";
import type {
  GigaSwapConfig,
  GigaSwapPrepared,
  GigaSwapDirectPool,
  GigaSwapMultiHopRoute,
  PoolInfo,
  DiscoveredMultiHopRoute,
} from "../shared/types";

const MIN_LIQUIDITY = 10n ** 13n;

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function maxPriceLimitForPair(tokenA: Hex, tokenB: Hex): bigint {
  return tokenA.toLowerCase() < tokenB.toLowerCase()
    ? MIN_SQRT_RATIO + 1n
    : MAX_SQRT_RATIO - 1n;
}

interface QuotedPool {
  pool: PoolInfo;
  amountOut: bigint;
  delta: bigint;
}

interface QuotedMultiHop {
  route: DiscoveredMultiHopRoute;
  finalOut: bigint;
}

/**
 * Discover pools, measure depth via quoting, separate by price-limit support,
 * compute optimal splits for no-limit pools, and derive global price limit.
 */
export async function prepareGigaSwap(
  config: GigaSwapConfig,
  client: PublicClient,
  sauceRouterAddress: Hex,
  poolConfig: ChainPoolConfig = BASE_CHAIN_POOL_CONFIG,
): Promise<GigaSwapPrepared> {
  const { tokenIn, tokenOut, amountIn } = config;
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();
  const zeroForOne = inLower < outLower;

  // ── Step 1: Discover all direct pools across all protocols ──
  const allDirect = await discoverPools(tokenIn, tokenOut, client, poolConfig);
  const directPools = allDirect.filter((p) => p.liquidity >= MIN_LIQUIDITY);

  // Separate by price limit support
  const priceLimitedRaw = directPools.filter((p) => p.priceLimited);
  const noLimitRaw = directPools.filter((p) => !p.priceLimited);

  // ── Step 2: Discover multi-hop routes (best pool per leg) ──
  const multiHopRoutes: DiscoveredMultiHopRoute[] = [];
  for (const baseToken of poolConfig.baseTokens) {
    const baseLower = baseToken.toLowerCase();
    if (baseLower === inLower || baseLower === outLower) continue;

    const [hop1Pools, hop2Pools] = await Promise.all([
      discoverPools(tokenIn, baseToken, client, poolConfig),
      discoverPools(baseToken, tokenOut, client, poolConfig),
    ]);
    if (hop1Pools.length === 0 || hop2Pools.length === 0) continue;

    const bestHop1 = hop1Pools.reduce((a, b) =>
      a.liquidity > b.liquidity ? a : b,
    );
    const bestHop2 = hop2Pools.reduce((a, b) =>
      a.liquidity > b.liquidity ? a : b,
    );
    multiHopRoutes.push({
      intermediateToken: baseToken,
      hop1Pool: bestHop1,
      hop2Pool: bestHop2,
    });
  }

  if (priceLimitedRaw.length === 0 && noLimitRaw.length === 0 && multiHopRoutes.length === 0) {
    throw new Error(`No pools found for ${tokenIn} -> ${tokenOut}`);
  }

  // ── Step 3: Quote every pool with full amount to measure depth ──
  const limit = maxPriceLimitForPair(tokenIn, tokenOut);

  // Quote price-limited pools
  const quotedPriceLimited: QuotedPool[] = [];
  for (const pool of priceLimitedRaw) {
    const quote = await quotePool(pool, amountIn, limit, sauceRouterAddress, client);
    if (quote.amountOut === 0n) continue;
    quotedPriceLimited.push({
      pool,
      amountOut: quote.amountOut,
      delta: abs(quote.sqrtPriceAfter - pool.sqrtPriceX96),
    });
  }

  // Quote no-limit pools
  const quotedNoLimit: QuotedPool[] = [];
  for (const pool of noLimitRaw) {
    const quote = await quotePool(pool, amountIn, limit, sauceRouterAddress, client);
    if (quote.amountOut === 0n) continue;
    quotedNoLimit.push({
      pool,
      amountOut: quote.amountOut,
      delta: abs(quote.sqrtPriceAfter - pool.sqrtPriceX96),
    });
  }

  // Quote multi-hop routes
  const quotedMultiHop: QuotedMultiHop[] = [];
  for (const route of multiHopRoutes) {
    const hop1Limit = maxPriceLimitForPair(tokenIn, route.intermediateToken);
    const hop1Quote = await quotePool(
      route.hop1Pool, amountIn, hop1Limit, sauceRouterAddress, client,
    );
    if (hop1Quote.amountOut === 0n) continue;

    const hop2Limit = maxPriceLimitForPair(route.intermediateToken, tokenOut);
    const hop2Quote = await quotePool(
      route.hop2Pool, hop1Quote.amountOut, hop2Limit, sauceRouterAddress, client,
    );
    if (hop2Quote.amountOut === 0n) continue;

    quotedMultiHop.push({ route, finalOut: hop2Quote.amountOut });
  }

  if (quotedPriceLimited.length === 0 && quotedNoLimit.length === 0 && quotedMultiHop.length === 0) {
    throw new Error("No pools returned valid quotes");
  }

  // ── Step 4: Price-limited pools don't need splits ──
  // They get full remaining balance on-chain with globalPriceLimit.
  // Sort by depth (lowest delta = deepest = executes first).
  const priceLimitedPools: GigaSwapDirectPool[] = quotedPriceLimited
    .sort((a, b) => (a.delta < b.delta ? -1 : a.delta > b.delta ? 1 : 0))
    .map((q) => ({ pool: q.pool, splitAmount: 0n })); // splitAmount=0 signals "use full remaining"

  // ── Step 5: Split amountIn for no-limit pools + multi-hop proportionally ──
  // These share whatever the V3 pools don't consume.
  // We estimate that as: amountIn * (noLimitOutput / totalOutput)
  const totalOutput = [
    ...quotedPriceLimited.map((q) => q.amountOut),
    ...quotedNoLimit.map((q) => q.amountOut),
    ...quotedMultiHop.map((q) => q.finalOut),
  ].reduce((a, b) => a + b, 0n);

  const noLimitTotalOutput = [
    ...quotedNoLimit.map((q) => q.amountOut),
    ...quotedMultiHop.map((q) => q.finalOut),
  ].reduce((a, b) => a + b, 0n);

  // Estimated share of amountIn for no-limit pools (V3 pools consume the rest via price limit)
  const noLimitBudget = totalOutput > 0n
    ? (amountIn * noLimitTotalOutput) / totalOutput
    : amountIn;

  const noLimitEntries = quotedNoLimit.length + quotedMultiHop.length;
  let allocated = 0n;
  let idx = 0;

  const noLimitPools: GigaSwapDirectPool[] = [];
  for (const qd of quotedNoLimit) {
    idx++;
    const isLast = idx === noLimitEntries;
    const split = isLast
      ? noLimitBudget - allocated
      : noLimitTotalOutput > 0n
        ? (noLimitBudget * qd.amountOut) / noLimitTotalOutput
        : 0n;
    allocated += split;
    noLimitPools.push({ pool: qd.pool, splitAmount: split });
  }

  const multiHopSplits: GigaSwapMultiHopRoute[] = [];
  for (const qm of quotedMultiHop) {
    idx++;
    const isLast = idx === noLimitEntries;
    const split = isLast
      ? noLimitBudget - allocated
      : noLimitTotalOutput > 0n
        ? (noLimitBudget * qm.finalOut) / noLimitTotalOutput
        : 0n;
    allocated += split;
    multiHopSplits.push({ route: qm.route, splitAmount: split });
  }

  // ── Step 6: Global price limit from V3 pools ──
  // Re-quote each V3 pool with full amount to find the tightest one.
  let globalPriceLimit = 0n;
  let minDelta = 0n;
  let foundLimit = false;

  for (const qp of quotedPriceLimited) {
    if (qp.delta > 0n && (!foundLimit || qp.delta < minDelta)) {
      minDelta = qp.delta;
      // Re-quote to get sqrtPriceAfter at a reasonable fill amount
      const quote = await quotePool(qp.pool, amountIn, limit, sauceRouterAddress, client);
      if (quote.amountOut > 0n) {
        globalPriceLimit = quote.sqrtPriceAfter;
        foundLimit = true;
      }
    }
  }

  if (!foundLimit) globalPriceLimit = 0n;

  // ── Step 7: Cross-filter multi-hop by relative depth ──
  const allOutputs = [
    ...quotedPriceLimited.map((q) => q.amountOut),
    ...quotedNoLimit.map((q) => q.amountOut),
    ...quotedMultiHop.map((q) => q.finalOut),
  ];
  const maxOutput = allOutputs.reduce((a, b) => (a > b ? a : b), 0n);
  const relThreshold = maxOutput / 1000n;

  const filteredMultiHop = multiHopSplits
    .filter((ms) => {
      const qm = quotedMultiHop.find((q) => q.route === ms.route);
      return qm && qm.finalOut >= relThreshold;
    })
    .slice(0, 2);

  // Redistribute dropped multi-hop allocations to no-limit pools
  const droppedAmount = multiHopSplits
    .filter((ms) => !filteredMultiHop.includes(ms))
    .reduce((sum, ms) => sum + ms.splitAmount, 0n);

  if (droppedAmount > 0n && noLimitPools.length > 0) {
    const nlTotal = noLimitPools.reduce((sum, p) => sum + p.splitAmount, 0n);
    if (nlTotal > 0n) {
      let redistAllocated = 0n;
      for (let i = 0; i < noLimitPools.length; i++) {
        const isLast = i === noLimitPools.length - 1;
        const extra = isLast
          ? droppedAmount - redistAllocated
          : (droppedAmount * noLimitPools[i].splitAmount) / nlTotal;
        noLimitPools[i] = { ...noLimitPools[i], splitAmount: noLimitPools[i].splitAmount + extra };
        redistAllocated += extra;
      }
    }
  }

  console.log(
    `  GigaSwap prepared: ${priceLimitedPools.length} V3 (price-limited), ` +
    `${noLimitPools.length} V2 (no-limit), ${filteredMultiHop.length} multi-hop, ` +
    `priceLimit=${globalPriceLimit}`,
  );
  for (const p of priceLimitedPools) {
    console.log(`    [V3] ${p.pool.source} ${p.pool.address.slice(0, 10)}... fee=${p.pool.fee}`);
  }
  for (const p of noLimitPools) {
    console.log(`    [V2] ${p.pool.source} ${p.pool.address.slice(0, 10)}... split=${p.splitAmount}`);
  }

  return {
    priceLimitedPools,
    noLimitPools,
    multiHopRoutes: filteredMultiHop,
    globalPriceLimit,
    zeroForOne,
  };
}
