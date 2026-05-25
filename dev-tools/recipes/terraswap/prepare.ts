/**
 * TerraSwap off-chain preparation.
 *
 * Per-chain: discover pools, separate by price-limit support, quote, split.
 * Cross-chain: derive a single global price limit from deepest V3 pool.
 *
 * Price-limited pools (V3/V4): get full remaining balance + globalPriceLimit.
 *   The price limit naturally caps fill — deeper pools absorb more.
 *   No pre-computed split needed.
 *
 * No-limit pools (V2/Solidly): get pre-computed depth-proportional splits.
 *   Depth measured via full-amount quote simulation.
 */

import type { PublicClient, Hex } from "viem";
import { createPublicClient, http, parseAbi } from "viem";
import { discoverPools } from "../shared/pool-discovery";
import { quotePool } from "../shared/quoting";
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO, BASE_CHAIN_POOL_CONFIG, CHAIN_POOL_CONFIGS, type ChainPoolConfig } from "../shared/constants";
import type {
  TerraSwapChainConfig,
  TerraSwapConfig,
  TerraSwapPrepared,
  TerraSwapChainPrepared,
  GigaSwapDirectPool,
  GigaSwapMultiHopRoute,
  DiscoveredMultiHopRoute,
  PoolInfo,
} from "../shared/types";

const MIN_LIQUIDITY = 10n ** 13n;
const SCALE = 10n ** 18n;

const poolAbi = parseAbi([
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
]);

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function maxPriceLimitForPair(tokenA: Hex, tokenB: Hex): bigint {
  return tokenA.toLowerCase() < tokenB.toLowerCase()
    ? MIN_SQRT_RATIO + 1n
    : MAX_SQRT_RATIO - 1n;
}

function makeClient(rpcUrl: string) {
  return createPublicClient({ transport: http(rpcUrl, { timeout: 120_000 }) });
}

// ── Per-chain preparation (discover + quote + split) ─────────

function resolvePoolConfig(chainConfig: TerraSwapChainConfig): ChainPoolConfig {
  if (chainConfig.poolConfig) return chainConfig.poolConfig;
  return CHAIN_POOL_CONFIGS[chainConfig.name] ?? BASE_CHAIN_POOL_CONFIG;
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

async function prepareChain(
  chainConfig: TerraSwapChainConfig,
): Promise<TerraSwapChainPrepared> {
  const client = makeClient(chainConfig.rpcUrl);
  const { tokenIn, tokenOut, amountIn, sauceRouterAddress } = chainConfig;
  const poolConfig = resolvePoolConfig(chainConfig);
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();
  const zeroForOne = inLower < outLower;

  // ── Step 1: Discover all direct pools ──
  const allDirect = await discoverPools(tokenIn, tokenOut, client, poolConfig);
  const directPools = allDirect.filter((p) => p.liquidity >= MIN_LIQUIDITY);

  // Separate by price limit support
  const priceLimitedRaw = directPools.filter((p) => p.priceLimited);
  const noLimitRaw = directPools.filter((p) => !p.priceLimited);

  // ── Step 2: Discover multi-hop routes ──
  const multiHopRoutes: DiscoveredMultiHopRoute[] = [];
  for (const baseToken of poolConfig.baseTokens) {
    const baseLower = baseToken.toLowerCase();
    if (baseLower === inLower || baseLower === outLower) continue;
    const [hop1Pools, hop2Pools] = await Promise.all([
      discoverPools(tokenIn, baseToken, client, poolConfig),
      discoverPools(baseToken, tokenOut, client, poolConfig),
    ]);
    if (hop1Pools.length === 0 || hop2Pools.length === 0) continue;
    const bestHop1 = hop1Pools.reduce((a, b) => (a.liquidity > b.liquidity ? a : b));
    const bestHop2 = hop2Pools.reduce((a, b) => (a.liquidity > b.liquidity ? a : b));
    multiHopRoutes.push({ intermediateToken: baseToken, hop1Pool: bestHop1, hop2Pool: bestHop2 });
  }

  if (priceLimitedRaw.length === 0 && noLimitRaw.length === 0 && multiHopRoutes.length === 0) {
    throw new Error(`[${chainConfig.name}] No pools found for ${tokenIn} -> ${tokenOut}`);
  }

  // ── Step 3: Quote every pool with full amount ──
  const limit = maxPriceLimitForPair(tokenIn, tokenOut);

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

  const quotedMultiHop: QuotedMultiHop[] = [];
  for (const route of multiHopRoutes) {
    const hop1Limit = maxPriceLimitForPair(tokenIn, route.intermediateToken);
    const hop1Quote = await quotePool(route.hop1Pool, amountIn, hop1Limit, sauceRouterAddress, client);
    if (hop1Quote.amountOut === 0n) continue;
    const hop2Limit = maxPriceLimitForPair(route.intermediateToken, tokenOut);
    const hop2Quote = await quotePool(route.hop2Pool, hop1Quote.amountOut, hop2Limit, sauceRouterAddress, client);
    if (hop2Quote.amountOut === 0n) continue;
    quotedMultiHop.push({ route, finalOut: hop2Quote.amountOut });
  }

  if (quotedPriceLimited.length === 0 && quotedNoLimit.length === 0 && quotedMultiHop.length === 0) {
    throw new Error(`[${chainConfig.name}] No pools returned valid quotes`);
  }

  // ── Step 4: Price-limited pools — no splits needed ──
  const priceLimitedPools: GigaSwapDirectPool[] = quotedPriceLimited
    .sort((a, b) => (a.delta < b.delta ? -1 : a.delta > b.delta ? 1 : 0))
    .map((q) => ({ pool: q.pool, splitAmount: 0n }));

  // ── Step 5: Split amountIn for no-limit pools + multi-hop ──
  const totalOutput = [
    ...quotedPriceLimited.map((q) => q.amountOut),
    ...quotedNoLimit.map((q) => q.amountOut),
    ...quotedMultiHop.map((q) => q.finalOut),
  ].reduce((a, b) => a + b, 0n);

  const noLimitTotalOutput = [
    ...quotedNoLimit.map((q) => q.amountOut),
    ...quotedMultiHop.map((q) => q.finalOut),
  ].reduce((a, b) => a + b, 0n);

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

  // ── Step 6: Multi-hop splits ──
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
    `  [${chainConfig.name}] ${priceLimitedPools.length} V3 (price-limited), ` +
    `${noLimitPools.length} V2 (no-limit), ${filteredMultiHop.length} multi-hop`,
  );

  return {
    config: chainConfig,
    priceLimitedPools,
    noLimitPools,
    multiHopRoutes: filteredMultiHop,
    zeroForOne,
  };
}

// ── Cross-chain global price limit ───────────────────────────

async function findGlobalPriceLimit(
  chains: TerraSwapChainPrepared[],
): Promise<bigint> {
  let globalPriceLimit = 0n;
  let minDelta = 0n;
  let found = false;

  for (const chain of chains) {
    const client = makeClient(chain.config.rpcUrl);
    const { tokenIn, tokenOut, amountIn, sauceRouterAddress } = chain.config;
    const limit = maxPriceLimitForPair(tokenIn, tokenOut);

    // Only V3 pools have meaningful price limits
    for (const dp of chain.priceLimitedPools) {
      const quote = await quotePool(dp.pool, amountIn, limit, sauceRouterAddress, client);
      if (quote.amountOut === 0n) continue;
      const delta = abs(quote.sqrtPriceAfter - dp.pool.sqrtPriceX96);
      if (delta > 0n && (!found || delta < minDelta)) {
        minDelta = delta;
        globalPriceLimit = quote.sqrtPriceAfter;
        found = true;
      }
    }
  }

  return found ? globalPriceLimit : 0n;
}

// ── Initial preparation ──────────────────────────────────────

export async function prepareTerraSwap(
  config: TerraSwapConfig,
): Promise<TerraSwapPrepared> {
  const chains = await Promise.all(config.chains.map(prepareChain));
  const globalPriceLimit = await findGlobalPriceLimit(chains);

  console.log(
    `  TerraSwap prepared: ${chains.length} chains, globalPriceLimit=${globalPriceLimit}`,
  );
  for (const c of chains) {
    console.log(
      `    [${c.config.name}] ${c.priceLimitedPools.length} V3, ${c.noLimitPools.length} V2, ${c.multiHopRoutes.length} multi-hop`,
    );
  }

  return { chains, globalPriceLimit };
}

// ── Subsequent series preparation (from post-swap state) ─────

export async function prepareNextSeries(
  previousChains: TerraSwapChainPrepared[],
  leftovers: Map<string, bigint>,
): Promise<TerraSwapPrepared> {
  const newChains: TerraSwapChainPrepared[] = [];

  for (const chain of previousChains) {
    const leftover = leftovers.get(chain.config.name) ?? 0n;
    if (leftover <= 0n) continue;

    const client = makeClient(chain.config.rpcUrl);

    // Read post-swap slot0 for V3 pools, compute inverse-delta depth weights
    let totalWeight = 0n;
    const priceLimitedWeights: { dp: GigaSwapDirectPool; weight: bigint }[] = [];

    for (const dp of chain.priceLimitedPools) {
      const [sqrtPriceX96] = (await client.readContract({
        address: dp.pool.address,
        abi: poolAbi,
        functionName: "slot0",
      })) as [bigint, ...unknown[]];

      const delta = abs(sqrtPriceX96 - dp.pool.sqrtPriceX96);
      const weight = delta > 0n ? SCALE / delta : 0n;
      totalWeight += weight;
      priceLimitedWeights.push({ dp, weight });
    }

    const multiHopWeights: { mr: GigaSwapMultiHopRoute; weight: bigint }[] = [];
    for (const mr of chain.multiHopRoutes) {
      const [sqrtPriceX96] = (await client.readContract({
        address: mr.route.hop1Pool.address,
        abi: poolAbi,
        functionName: "slot0",
      })) as [bigint, ...unknown[]];

      const delta = abs(sqrtPriceX96 - mr.route.hop1Pool.sqrtPriceX96);
      const weight = delta > 0n ? SCALE / delta : 0n;
      totalWeight += weight;
      multiHopWeights.push({ mr, weight });
    }

    if (totalWeight === 0n) continue;

    // Split leftover proportionally to depth weights
    let allocated = 0n;
    const totalEntries = priceLimitedWeights.length + multiHopWeights.length;
    let idx = 0;

    const newPriceLimitedPools: GigaSwapDirectPool[] = [];
    for (const { dp, weight } of priceLimitedWeights) {
      idx++;
      const isLast = idx === totalEntries;
      const amt = isLast ? leftover - allocated : (leftover * weight) / totalWeight;
      allocated += amt;
      const [currentPrice] = (await client.readContract({
        address: dp.pool.address,
        abi: poolAbi,
        functionName: "slot0",
      })) as [bigint, ...unknown[]];
      newPriceLimitedPools.push({
        pool: { ...dp.pool, sqrtPriceX96: currentPrice },
        splitAmount: amt,
      });
    }

    const newMultiHopRoutes: GigaSwapMultiHopRoute[] = [];
    for (const { mr, weight } of multiHopWeights) {
      idx++;
      const isLast = idx === totalEntries;
      const amt = isLast ? leftover - allocated : (leftover * weight) / totalWeight;
      allocated += amt;
      newMultiHopRoutes.push({ route: mr.route, splitAmount: amt });
    }

    // V2 pools don't participate in series 2+ (no slot0 for depth measurement)
    newChains.push({
      config: { ...chain.config, amountIn: leftover },
      priceLimitedPools: newPriceLimitedPools,
      noLimitPools: [],
      multiHopRoutes: newMultiHopRoutes,
      zeroForOne: chain.zeroForOne,
    });
  }

  const globalPriceLimit = newChains.length > 0
    ? await findGlobalPriceLimit(newChains)
    : 0n;

  return { chains: newChains, globalPriceLimit };
}
