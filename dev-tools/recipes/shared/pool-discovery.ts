/**
 * Multi-protocol pool discovery.
 *
 * Supports four factory types:
 * - V3Standard:  Uniswap V3-style getPool(tokenA, tokenB, fee) across fee tiers
 * - AlgebraV3:   Algebra-style poolByPair(tokenA, tokenB) — single pool, dynamic fees
 * - V2Standard:  Uniswap V2-style getPair(tokenA, tokenB) — single pool, xy=k
 * - SolidlyV2:   Solidly-style getPool(tokenA, tokenB, stable) — volatile + stable pools
 *
 * All discovered pools include `priceLimited` flag for downstream routing.
 */

import type { PublicClient, Hex } from "viem";
import { parseAbi, keccak256, encodeAbiParameters } from "viem";
import {
  BASE_CHAIN_POOL_CONFIG,
  SwapPoolType,
  FactoryType,
  TRADER_JOE_BIN_STEPS,
  hasPriceLimit,
  type ChainPoolConfig,
  type FactoryConfig,
} from "./constants";
import type { PoolInfo } from "./types";

// ── ABIs ──────────────────────────────────────────────────────

const v3FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
]);

const algebraFactoryAbi = parseAbi([
  "function poolByPair(address tokenA, address tokenB) external view returns (address pool)",
]);

const v2FactoryAbi = parseAbi([
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
]);

const solidlyFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool)",
]);

const v3PoolAbi = parseAbi([
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
]);

const algebraPoolAbi = parseAbi([
  "function globalState() external view returns (uint160 price, int24 tick, uint16 feeZto, uint16 feeOtz, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
  "function liquidity() external view returns (uint128)",
]);

const v2PairAbi = parseAbi([
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
]);

const v4StateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity)",
]);

/** Standard Uniswap fee → tickSpacing map (covers V3 + V4 standard tiers). */
const TICK_SPACING_BY_FEE: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };
function feeToTickSpacing(fee: number): number {
  return TICK_SPACING_BY_FEE[fee] ?? 60;
}

/** V4 poolId = keccak256(abi.encode(PoolKey{currency0,currency1,fee,tickSpacing,hooks})). */
function computeV4PoolId(
  currency0: Hex,
  currency1: Hex,
  fee: number,
  tickSpacing: number,
  hooks: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, fee, tickSpacing, hooks],
    ),
  );
}

// ── New protocol ABIs ────────────────────────────────────────

const curveRegistryAbi = parseAbi([
  "function find_pool_for_coins(address from, address to) external view returns (address pool)",
]);

const curvePoolAbi = parseAbi([
  "function balances(uint256 i) external view returns (uint256)",
]);

const balancerPoolAbi = parseAbi([
  "function getPoolId() external view returns (bytes32)",
  "function totalSupply() external view returns (uint256)",
]);

const dodoZooAbi = parseAbi([
  "function getDODO(address baseToken, address quoteToken) external view returns (address[] pools)",
]);

const dodoPoolAbi = parseAbi([
  "function _BASE_TOKEN_() external view returns (address)",
  "function _BASE_RESERVE_() external view returns (uint256)",
  "function _QUOTE_RESERVE_() external view returns (uint256)",
]);

const traderJoeLBFactoryAbi = parseAbi([
  "function getLBPairInformation(address tokenX, address tokenY, uint256 binStep) external view returns (uint256 binStep2, address LBPair, bool createdByOwner, bool ignoredForRouting)",
]);

const traderJoeLBPairAbi = parseAbi([
  "function getReserves() external view returns (uint128 reserveX, uint128 reserveY)",
  "function getTokenX() external view returns (address)",
]);

const maverickFactoryAbi = parseAbi([
  "function lookup(address tokenA, address tokenB, uint256 startIndex, uint256 endIndex) external view returns (address[] pools)",
]);

const maverickPoolAbi = parseAbi([
  "function tokenA() external view returns (address)",
  "function getState() external view returns (int32 activeTick, uint8 status, uint256 binCounter, uint64 protocolFeeRatio, uint128 totalLiquidity)",
]);

const woofiAbi = parseAbi([
  "function query(address fromToken, address toToken, uint256 fromAmount) external view returns (uint256 toAmount)",
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── V3 Standard discovery ───────────────────────────────────

async function discoverV3Pools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
  feeTiers: number[],
): Promise<PoolInfo[]> {
  // Each factory is queried across ITS OWN fee tiers (FactoryConfig.feeTiers),
  // falling back to the chain-level list. Lets forks with different tiers — e.g.
  // PancakeSwap V3's 2500 vs Uniswap's 3000 — both be discovered in one pass.
  const getPoolCalls = factories.flatMap((f) =>
    (f.feeTiers ?? feeTiers).map((fee) => ({
      address: f.address,
      abi: v3FactoryAbi,
      functionName: "getPool" as const,
      args: [tokenIn, tokenOut, fee] as const,
      factory: f,
      fee,
    })),
  );

  if (getPoolCalls.length === 0) return [];

  const poolAddresses = await client.multicall({
    contracts: getPoolCalls.map((c) => ({
      address: c.address,
      abi: c.abi,
      functionName: c.functionName,
      args: c.args,
    })),
    allowFailure: true,
  });

  const validPools: { address: Hex; factory: FactoryConfig; fee: number }[] = [];
  for (let i = 0; i < poolAddresses.length; i++) {
    const result = poolAddresses[i];
    if (
      result.status === "success" &&
      result.result &&
      result.result !== ZERO_ADDRESS
    ) {
      validPools.push({
        address: result.result as Hex,
        factory: getPoolCalls[i].factory,
        fee: getPoolCalls[i].fee,
      });
    }
  }

  if (validPools.length === 0) return [];

  // Read slot0 + liquidity
  const [slot0Results, liquidityResults] = await Promise.all([
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: v3PoolAbi,
        functionName: "slot0" as const,
      })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: v3PoolAbi,
        functionName: "liquidity" as const,
      })),
      allowFailure: true,
    }),
  ]);

  const pools: PoolInfo[] = [];
  for (let i = 0; i < validPools.length; i++) {
    const slot0 = slot0Results[i];
    const liq = liquidityResults[i];
    if (slot0.status !== "success" || liq.status !== "success") continue;

    const [sqrtPriceX96] = slot0.result as [bigint, ...unknown[]];
    const liquidity = liq.result as bigint;
    if (sqrtPriceX96 === 0n || liquidity === 0n) continue;

    pools.push({
      address: validPools[i].address,
      tokenIn,
      tokenOut,
      fee: validPools[i].fee,
      poolType: validPools[i].factory.poolType,
      priceLimited: hasPriceLimit(validPools[i].factory.poolType),
      sqrtPriceX96,
      liquidity,
      source: validPools[i].factory.label,
    });
  }

  return pools;
}

// ── Algebra V3 discovery ────────────────────────────────────

async function discoverAlgebraPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (factories.length === 0) return [];

  const poolAddresses = await client.multicall({
    contracts: factories.map((f) => ({
      address: f.address,
      abi: algebraFactoryAbi,
      functionName: "poolByPair" as const,
      args: [tokenIn, tokenOut] as const,
    })),
    allowFailure: true,
  });

  const validPools: { address: Hex; factory: FactoryConfig }[] = [];
  for (let i = 0; i < poolAddresses.length; i++) {
    const result = poolAddresses[i];
    if (
      result.status === "success" &&
      result.result &&
      result.result !== ZERO_ADDRESS
    ) {
      validPools.push({ address: result.result as Hex, factory: factories[i] });
    }
  }

  if (validPools.length === 0) return [];

  // Read globalState + liquidity
  const [stateResults, liquidityResults] = await Promise.all([
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: algebraPoolAbi,
        functionName: "globalState" as const,
      })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: algebraPoolAbi,
        functionName: "liquidity" as const,
      })),
      allowFailure: true,
    }),
  ]);

  const pools: PoolInfo[] = [];
  for (let i = 0; i < validPools.length; i++) {
    const state = stateResults[i];
    const liq = liquidityResults[i];
    if (state.status !== "success" || liq.status !== "success") continue;

    const [price] = state.result as [bigint, ...unknown[]];
    const liquidity = liq.result as bigint;
    if (price === 0n || liquidity === 0n) continue;

    pools.push({
      address: validPools[i].address,
      tokenIn,
      tokenOut,
      fee: 0, // Algebra uses dynamic fees, not fixed tiers
      poolType: validPools[i].factory.poolType,
      priceLimited: hasPriceLimit(validPools[i].factory.poolType),
      sqrtPriceX96: price, // globalState.price is sqrtPriceX96-compatible
      liquidity,
      source: validPools[i].factory.label,
    });
  }

  return pools;
}

// ── V2 Standard discovery ───────────────────────────────────

async function discoverV2Pools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (factories.length === 0) return [];

  const pairAddresses = await client.multicall({
    contracts: factories.map((f) => ({
      address: f.address,
      abi: v2FactoryAbi,
      functionName: "getPair" as const,
      args: [tokenIn, tokenOut] as const,
    })),
    allowFailure: true,
  });

  const validPairs: { address: Hex; factory: FactoryConfig }[] = [];
  for (let i = 0; i < pairAddresses.length; i++) {
    const result = pairAddresses[i];
    if (
      result.status === "success" &&
      result.result &&
      result.result !== ZERO_ADDRESS
    ) {
      validPairs.push({ address: result.result as Hex, factory: factories[i] });
    }
  }

  if (validPairs.length === 0) return [];

  return readV2PoolState(tokenIn, tokenOut, client, validPairs);
}

// ── Solidly V2 discovery ────────────────────────────────────

async function discoverSolidlyV2Pools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (factories.length === 0) return [];

  // Query both volatile (stable=false) and stable (stable=true) pools
  const calls = factories.flatMap((f) => [
    {
      address: f.address,
      abi: solidlyFactoryAbi,
      functionName: "getPool" as const,
      args: [tokenIn, tokenOut, false] as const, // volatile
      factory: f,
      stable: false,
    },
    {
      address: f.address,
      abi: solidlyFactoryAbi,
      functionName: "getPool" as const,
      args: [tokenIn, tokenOut, true] as const, // stable
      factory: f,
      stable: true,
    },
  ]);

  const poolAddresses = await client.multicall({
    contracts: calls.map((c) => ({
      address: c.address,
      abi: c.abi,
      functionName: c.functionName,
      args: c.args,
    })),
    allowFailure: true,
  });

  const seen = new Set<string>();
  const validPairs: { address: Hex; factory: FactoryConfig }[] = [];
  for (let i = 0; i < poolAddresses.length; i++) {
    const result = poolAddresses[i];
    if (
      result.status === "success" &&
      result.result &&
      result.result !== ZERO_ADDRESS
    ) {
      const addr = (result.result as string).toLowerCase();
      if (!seen.has(addr)) {
        seen.add(addr);
        const label = calls[i].stable
          ? `${calls[i].factory.label} (stable)`
          : calls[i].factory.label;
        validPairs.push({
          address: result.result as Hex,
          factory: { ...calls[i].factory, label },
        });
      }
    }
  }

  if (validPairs.length === 0) return [];

  return readV2PoolState(tokenIn, tokenOut, client, validPairs);
}

// ── Shared V2 pool state reader ─────────────────────────────

async function readV2PoolState(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  validPairs: { address: Hex; factory: FactoryConfig }[],
): Promise<PoolInfo[]> {
  // Read getReserves + token0
  const [reserveResults, token0Results] = await Promise.all([
    client.multicall({
      contracts: validPairs.map((p) => ({
        address: p.address,
        abi: v2PairAbi,
        functionName: "getReserves" as const,
      })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: validPairs.map((p) => ({
        address: p.address,
        abi: v2PairAbi,
        functionName: "token0" as const,
      })),
      allowFailure: true,
    }),
  ]);

  const pools: PoolInfo[] = [];
  for (let i = 0; i < validPairs.length; i++) {
    const reserves = reserveResults[i];
    const t0 = token0Results[i];
    if (reserves.status !== "success" || t0.status !== "success") continue;

    const [reserve0, reserve1] = reserves.result as [bigint, bigint, number];
    const token0 = (t0.result as string).toLowerCase();
    if (reserve0 === 0n || reserve1 === 0n) continue;

    // Determine reserves relative to tokenIn/tokenOut
    const isToken0In = tokenIn.toLowerCase() === token0;
    const reserveIn = isToken0In ? reserve0 : reserve1;
    const reserveOut = isToken0In ? reserve1 : reserve0;

    // Derive synthetic sqrtPriceX96 from reserves for comparable depth measurement
    const syntheticLiquidity = sqrt(reserveIn * reserveOut);

    // Synthetic sqrtPriceX96: sqrt(reserve1/reserve0) * 2^96
    const Q96 = 1n << 96n;
    const syntheticSqrtPrice = (sqrt(reserveOut * Q96 * Q96) * Q96) / (sqrt(reserveIn * Q96 * Q96));

    pools.push({
      address: validPairs[i].address,
      tokenIn,
      tokenOut,
      fee: 3000, // V2 standard fee is 0.3% = 3000 bps
      poolType: validPairs[i].factory.poolType,
      priceLimited: false,
      sqrtPriceX96: syntheticSqrtPrice > 0n ? syntheticSqrtPrice : 1n,
      liquidity: syntheticLiquidity,
      source: validPairs[i].factory.label,
    });
  }

  return pools;
}

// ── Curve discovery ─────────────────────────────────────────

async function discoverCurvePools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  registries: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (registries.length === 0) return [];

  const pools: PoolInfo[] = [];
  for (const registry of registries) {
    try {
      const poolAddr = await client.readContract({
        address: registry.address,
        abi: curveRegistryAbi,
        functionName: "find_pool_for_coins",
        args: [tokenIn, tokenOut],
      }) as string;

      if (!poolAddr || poolAddr === ZERO_ADDRESS) continue;

      // Read reserves (balances[0] and balances[1]) to verify liquidity
      const [bal0, bal1] = await Promise.all([
        client.readContract({ address: poolAddr as Hex, abi: curvePoolAbi, functionName: "balances", args: [0n] }).catch(() => 0n) as Promise<bigint>,
        client.readContract({ address: poolAddr as Hex, abi: curvePoolAbi, functionName: "balances", args: [1n] }).catch(() => 0n) as Promise<bigint>,
      ]);

      if (bal0 === 0n || bal1 === 0n) continue;

      const syntheticLiquidity = sqrt(bal0 * bal1);
      const Q96 = 1n << 96n;
      const syntheticSqrtPrice = bal0 > 0n ? (sqrt(bal1 * Q96 * Q96) * Q96) / sqrt(bal0 * Q96 * Q96) : 1n;

      pools.push({
        address: poolAddr as Hex,
        tokenIn,
        tokenOut,
        fee: 400, // Curve typical fee ~0.04% = 400 bps (varies by pool)
        poolType: SwapPoolType.Curve,
        priceLimited: false,
        sqrtPriceX96: syntheticSqrtPrice > 0n ? syntheticSqrtPrice : 1n,
        liquidity: syntheticLiquidity,
        source: registry.label,
      });
    } catch {
      // Registry call failed, skip
    }
  }

  return pools;
}

// ── Balancer V2 discovery ───────────────────────────────────

async function discoverBalancerV2Pools(
  tokenIn: Hex,
  tokenOut: Hex,
  _client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  // Balancer V2 has no simple pair→pool lookup.
  // Discovery requires known pool addresses or a subgraph query.
  // For now, return empty — Balancer pools will be discovered via
  // external tooling and passed as explicit pool addresses in config.
  // The Router handler is ready; this is the discovery gap.
  if (factories.length === 0) return [];

  // TODO: Integrate Balancer V2 subgraph or known-pool list
  // The Vault at factories[0].address supports the swap, but pool discovery
  // requires getPoolTokens() with known poolIds.
  return [];
}

// ── DODO V2 discovery ───────────────────────────────────────

async function discoverDODOPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  zoos: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (zoos.length === 0) return [];

  const pools: PoolInfo[] = [];
  for (const zoo of zoos) {
    // DODO is order-dependent (base/quote), try both orderings
    for (const [base, quote] of [[tokenIn, tokenOut], [tokenOut, tokenIn]] as [Hex, Hex][]) {
      try {
        const addresses = await client.readContract({
          address: zoo.address,
          abi: dodoZooAbi,
          functionName: "getDODO",
          args: [base, quote],
        }) as string[];

        for (const addr of addresses) {
          if (!addr || addr === ZERO_ADDRESS) continue;

          try {
            const [baseReserve, quoteReserve] = await Promise.all([
              client.readContract({ address: addr as Hex, abi: dodoPoolAbi, functionName: "_BASE_RESERVE_" }) as Promise<bigint>,
              client.readContract({ address: addr as Hex, abi: dodoPoolAbi, functionName: "_QUOTE_RESERVE_" }) as Promise<bigint>,
            ]);

            if (baseReserve === 0n || quoteReserve === 0n) continue;

            const syntheticLiquidity = sqrt(baseReserve * quoteReserve);
            const Q96 = 1n << 96n;
            const syntheticSqrtPrice = baseReserve > 0n
              ? (sqrt(quoteReserve * Q96 * Q96) * Q96) / sqrt(baseReserve * Q96 * Q96)
              : 1n;

            pools.push({
              address: addr as Hex,
              tokenIn,
              tokenOut,
              fee: 0, // DODO uses dynamic fees
              poolType: SwapPoolType.DODOV2,
              priceLimited: false,
              sqrtPriceX96: syntheticSqrtPrice > 0n ? syntheticSqrtPrice : 1n,
              liquidity: syntheticLiquidity,
              source: zoo.label,
            });
          } catch {
            // Pool state read failed
          }
        }
      } catch {
        // getDODO call failed
      }
    }
  }

  // Deduplicate by address (both orderings may return the same pool)
  const seen = new Set<string>();
  return pools.filter((p) => {
    const key = p.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Trader Joe LB discovery ─────────────────────────────────

async function discoverTraderJoeLBPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (factories.length === 0) return [];

  const pools: PoolInfo[] = [];
  for (const factory of factories) {
    // Query each known bin step
    const calls = TRADER_JOE_BIN_STEPS.map((binStep) => ({
      address: factory.address,
      abi: traderJoeLBFactoryAbi,
      functionName: "getLBPairInformation" as const,
      args: [tokenIn, tokenOut, BigInt(binStep)] as const,
      binStep,
    }));

    const results = await client.multicall({
      contracts: calls.map((c) => ({
        address: c.address,
        abi: c.abi,
        functionName: c.functionName,
        args: c.args,
      })),
      allowFailure: true,
    });

    const validPairs: { address: Hex; binStep: number }[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status !== "success") continue;
      const [, pairAddr, , ignoredForRouting] = result.result as [bigint, string, boolean, boolean];
      if (pairAddr && pairAddr !== ZERO_ADDRESS && !ignoredForRouting) {
        validPairs.push({ address: pairAddr as Hex, binStep: calls[i].binStep });
      }
    }

    if (validPairs.length === 0) continue;

    // Read reserves and token0 for each pair
    const [reserveResults, tokenXResults] = await Promise.all([
      client.multicall({
        contracts: validPairs.map((p) => ({
          address: p.address,
          abi: traderJoeLBPairAbi,
          functionName: "getReserves" as const,
        })),
        allowFailure: true,
      }),
      client.multicall({
        contracts: validPairs.map((p) => ({
          address: p.address,
          abi: traderJoeLBPairAbi,
          functionName: "getTokenX" as const,
        })),
        allowFailure: true,
      }),
    ]);

    for (let i = 0; i < validPairs.length; i++) {
      const res = reserveResults[i];
      const txRes = tokenXResults[i];
      if (res.status !== "success" || txRes.status !== "success") continue;

      const [reserveX, reserveY] = res.result as [bigint, bigint];
      if (reserveX === 0n || reserveY === 0n) continue;

      const tokenX = (txRes.result as string).toLowerCase();
      const isTokenXIn = tokenIn.toLowerCase() === tokenX;
      const reserveIn = isTokenXIn ? reserveX : reserveY;
      const reserveOut = isTokenXIn ? reserveY : reserveX;

      const syntheticLiquidity = sqrt(reserveIn * reserveOut);
      const Q96 = 1n << 96n;
      const syntheticSqrtPrice = reserveIn > 0n
        ? (sqrt(reserveOut * Q96 * Q96) * Q96) / sqrt(reserveIn * Q96 * Q96)
        : 1n;

      pools.push({
        address: validPairs[i].address,
        tokenIn,
        tokenOut,
        fee: validPairs[i].binStep * 10, // bin step → approx fee in bps
        poolType: SwapPoolType.TraderJoeLB,
        priceLimited: false,
        sqrtPriceX96: syntheticSqrtPrice > 0n ? syntheticSqrtPrice : 1n,
        liquidity: syntheticLiquidity,
        source: `${factory.label} (bin ${validPairs[i].binStep})`,
      });
    }
  }

  return pools;
}

// ── Maverick V2 discovery ───────────────────────────────────

async function discoverMaverickV2Pools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (factories.length === 0) return [];

  const pools: PoolInfo[] = [];
  for (const factory of factories) {
    // Try both token orderings — Maverick's lookup is order-dependent
    for (const [tokenA, tokenB] of [[tokenIn, tokenOut], [tokenOut, tokenIn]] as [Hex, Hex][]) {
      try {
        const addresses = await client.readContract({
          address: factory.address,
          abi: maverickFactoryAbi,
          functionName: "lookup",
          args: [tokenA, tokenB, 0n, 10n],
        }) as string[];

        for (const addr of addresses) {
          if (!addr || addr === ZERO_ADDRESS) continue;

          try {
            const state = await client.readContract({
              address: addr as Hex,
              abi: maverickPoolAbi,
              functionName: "getState",
            }) as [number, number, bigint, bigint, bigint];

            const totalLiquidity = state[4];
            if (totalLiquidity === 0n) continue;

            pools.push({
              address: addr as Hex,
              tokenIn,
              tokenOut,
              fee: 0, // Maverick uses dynamic fees
              poolType: SwapPoolType.MaverickV2,
              priceLimited: false,
              sqrtPriceX96: 1n, // No meaningful sqrt price for Maverick
              liquidity: totalLiquidity,
              source: factory.label,
            });
          } catch {
            // Pool state read failed
          }
        }
      } catch {
        // Factory lookup failed
      }
    }
  }

  // Deduplicate by address
  const seen = new Set<string>();
  return pools.filter((p) => {
    const key = p.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── WOOFi discovery ─────────────────────────────────────────

async function discoverWOOFiPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  woofiConfigs: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (woofiConfigs.length === 0) return [];

  const pools: PoolInfo[] = [];
  for (const config of woofiConfigs) {
    try {
      // Verify the pool supports this pair by querying a small amount
      const testAmount = 10n ** 18n; // 1 token (approximate)
      const toAmount = await client.readContract({
        address: config.address,
        abi: woofiAbi,
        functionName: "query",
        args: [tokenIn, tokenOut, testAmount],
      }) as bigint;

      if (toAmount === 0n) continue;

      // Use the query result to derive synthetic liquidity
      // liquidity ≈ toAmount * testAmount (order of magnitude)
      const syntheticLiquidity = sqrt(testAmount * toAmount);

      pools.push({
        address: config.address,
        tokenIn,
        tokenOut,
        fee: 25, // WOOFi typical fee ~0.025% = 25 bps
        poolType: SwapPoolType.WOOFi,
        priceLimited: false,
        sqrtPriceX96: 1n, // No meaningful sqrt price
        liquidity: syntheticLiquidity,
        source: config.label,
      });
    } catch {
      // Pool doesn't support this pair
    }
  }

  return pools;
}

/** Integer square root (babylonian method) */
function sqrt(x: bigint): bigint {
  if (x <= 0n) return 0n;
  let z = x;
  let y = (z + 1n) / 2n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

// ── Uniswap V4 discovery ────────────────────────────────────

const ZERO_HOOKS = "0x0000000000000000000000000000000000000000" as Hex;

/**
 * Discover Uniswap V4 pools for the pair across the configured fee tiers.
 *
 * V4 is a singleton: there is no per-pool contract. Each (currency0, currency1,
 * fee, tickSpacing, hooks) combination has a `poolId = keccak256(abi.encode(key))`;
 * state is read from the StateView lens. We probe hookless pools at each standard
 * fee tier (one batched multicall of getSlot0 + getLiquidity) and keep the ones
 * that are initialised (sqrtPriceX96 > 0) and carry liquidity.
 */
async function discoverV4Pools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
  feeTiers: number[],
): Promise<PoolInfo[]> {
  if (factories.length === 0) return [];

  // V4 canonical ordering: currency0 < currency1 by address. Hookless pools only.
  const [currency0, currency1] =
    BigInt(tokenIn) < BigInt(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];

  type Candidate = { factory: FactoryConfig; fee: number; tickSpacing: number; poolId: Hex };
  const candidates: Candidate[] = [];
  for (const f of factories) {
    if (!f.stateView) continue;
    for (const fee of f.feeTiers ?? feeTiers) {
      const tickSpacing = feeToTickSpacing(fee);
      const poolId = computeV4PoolId(currency0, currency1, fee, tickSpacing, ZERO_HOOKS);
      candidates.push({ factory: f, fee, tickSpacing, poolId });
    }
  }
  if (candidates.length === 0) return [];

  const [slot0Results, liqResults] = await Promise.all([
    client.multicall({
      contracts: candidates.map((c) => ({
        address: c.factory.stateView as Hex,
        abi: v4StateViewAbi,
        functionName: "getSlot0" as const,
        args: [c.poolId] as const,
      })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: candidates.map((c) => ({
        address: c.factory.stateView as Hex,
        abi: v4StateViewAbi,
        functionName: "getLiquidity" as const,
        args: [c.poolId] as const,
      })),
      allowFailure: true,
    }),
  ]);

  const pools: PoolInfo[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const s = slot0Results[i];
    const l = liqResults[i];
    if (s.status !== "success" || l.status !== "success") continue;
    const sqrtPriceX96 = (s.result as readonly [bigint, number, number, number])[0];
    const liquidity = l.result as bigint;
    if (sqrtPriceX96 === 0n || liquidity === 0n) continue;
    pools.push({
      address: c.factory.address, // PoolManager singleton
      tokenIn,
      tokenOut,
      fee: c.fee,
      poolType: c.factory.poolType, // UniV4
      priceLimited: true,
      sqrtPriceX96,
      liquidity,
      source: c.factory.label,
      poolId: c.poolId,
      stateView: c.factory.stateView,
      currency0,
      currency1,
      tickSpacing: c.tickSpacing,
      hooks: ZERO_HOOKS,
    });
  }
  return pools;
}

// ── Unified discovery ───────────────────────────────────────

/**
 * Discover all pools for a token pair across all protocols and factory types.
 *
 * @param poolConfig - Chain-specific factory/fee config. Defaults to Base.
 */
export async function discoverPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  poolConfig: ChainPoolConfig = BASE_CHAIN_POOL_CONFIG,
): Promise<PoolInfo[]> {
  const { factories, feeTiers } = poolConfig;

  // Group factories by type
  const v3Factories = factories.filter((f) => f.factoryType === FactoryType.V3Standard);
  const v4Factories = factories.filter((f) => f.factoryType === FactoryType.UniswapV4);
  const algebraFactories = factories.filter((f) => f.factoryType === FactoryType.AlgebraV3);
  const v2Factories = factories.filter((f) => f.factoryType === FactoryType.V2Standard);
  const solidlyV2Factories = factories.filter((f) => f.factoryType === FactoryType.SolidlyV2);
  const curveRegistries = factories.filter((f) => f.factoryType === FactoryType.CurveRegistry);
  const balancerFactories = factories.filter((f) => f.factoryType === FactoryType.BalancerV2);
  const dodoZoos = factories.filter((f) => f.factoryType === FactoryType.DODOZoo);
  const traderJoeFactories = factories.filter((f) => f.factoryType === FactoryType.TraderJoeLB);
  const maverickFactories = factories.filter((f) => f.factoryType === FactoryType.MaverickV2Factory);
  const woofiConfigs = factories.filter((f) => f.factoryType === FactoryType.WOOFi);

  // Discover all in parallel
  const [v3Pools, v4Pools, algebraPools, v2Pools, solidlyV2Pools,
         curvePools, balancerPools, dodoPools, traderJoePools,
         maverickPools, woofiPools] = await Promise.all([
    discoverV3Pools(tokenIn, tokenOut, client, v3Factories, feeTiers),
    discoverV4Pools(tokenIn, tokenOut, client, v4Factories, feeTiers),
    discoverAlgebraPools(tokenIn, tokenOut, client, algebraFactories),
    discoverV2Pools(tokenIn, tokenOut, client, v2Factories),
    discoverSolidlyV2Pools(tokenIn, tokenOut, client, solidlyV2Factories),
    discoverCurvePools(tokenIn, tokenOut, client, curveRegistries),
    discoverBalancerV2Pools(tokenIn, tokenOut, client, balancerFactories),
    discoverDODOPools(tokenIn, tokenOut, client, dodoZoos),
    discoverTraderJoeLBPools(tokenIn, tokenOut, client, traderJoeFactories),
    discoverMaverickV2Pools(tokenIn, tokenOut, client, maverickFactories),
    discoverWOOFiPools(tokenIn, tokenOut, client, woofiConfigs),
  ]);

  return [
    ...v3Pools, ...v4Pools, ...algebraPools, ...v2Pools, ...solidlyV2Pools,
    ...curvePools, ...balancerPools, ...dodoPools, ...traderJoePools,
    ...maverickPools, ...woofiPools,
  ];
}
