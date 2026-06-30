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
  TRADER_JOE_BIN_WINDOW,
  TRADER_JOE_DEFAULT_BASE_FACTOR,
  hasPriceLimit,
  type ChainPoolConfig,
  type FactoryConfig,
} from "./constants.js";
import type { PoolInfo } from "./types.js";
import { A_PRECISION_DEFAULT, type CurvePool } from "./curve-math.js";
import type { LbPool } from "./lb-math.js";
import { dodoFeeToPpm, RState, type DodoPool } from "./dodo-math.js";
import type { SolidlyStablePool } from "./solidly-stable-math.js";

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
  "function getFee(address pool, bool stable) external view returns (uint256)",
]);

// Solidly STABLE (sAMM) pool surface — the Velodrome/Aerodrome stable Pair: token0/getReserves for
// the off-chain replay, decimals0/decimals1 for the 1e18 normalisation, stable() to confirm the
// branch, and getAmountOut(amountIn, tokenIn) for the on-chain (and cross-check) exact view.
const solidlyStablePoolAbi = parseAbi([
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function stable() external view returns (bool)",
  "function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)",
  "function decimals0() external view returns (uint256)",
  "function decimals1() external view returns (uint256)",
  "function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256)",
]);

const erc20DecimalsAbi = parseAbi([
  "function decimals() external view returns (uint8)",
]);

/**
 * Default Solidly STABLE swap fee (ppm) when the factory `getFee` read is unavailable. The canonical
 * sAMM tier (Velodrome/Aerodrome stable) is 0.01% = 100 ppm. Velodrome `getFee` returns the fee in
 * bps×... fork-dependent — we treat a successful `getFee(pool,true)` as already ppm if it is large
 * enough, else as bps (×100). When the read fails entirely we fall back to this default.
 */
const SOLIDLY_STABLE_DEFAULT_FEE_PPM = 100;

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
  "function get_coin_indices(address pool, address from, address to) external view returns (int128 i, int128 j, bool underlying)",
  "function get_n_coins(address pool) external view returns (uint256)",
  "function get_decimals(address pool) external view returns (uint256[8] decimals)",
]);

const curvePoolAbi = parseAbi([
  "function balances(uint256 i) external view returns (uint256)",
  "function A() external view returns (uint256)",
  "function fee() external view returns (uint256)",
  "function coins(uint256 i) external view returns (address)",
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

// DODO V2 PMM state + fee readers (the EcoSwap typed path — distinct from the legacy
// reserve-only dodoPoolAbi). `getPMMStateForCall()` returns the full PMM curve state
// (i, K, B, Q, B0, Q0, R) so the off-chain closed-form replay needs NO further RPC; the
// LP/MT fee rates net the gross receive amount as querySell* does.
const dodoPmmAbi = parseAbi([
  "function getPMMStateForCall() external view returns (uint256 i, uint256 K, uint256 B, uint256 Q, uint256 B0, uint256 Q0, uint256 R)",
  "function _BASE_TOKEN_() external view returns (address)",
  "function _QUOTE_TOKEN_() external view returns (address)",
  "function _LP_FEE_RATE_() external view returns (uint256)",
  "function _MT_FEE_RATE_MODEL_() external view returns (address)",
]);

// The MT fee-rate model resolves the maintainer fee for a given trader; the per-trader
// `getFeeRate(trader)` is the canonical reader (a flat-rate model ignores the argument).
const dodoMtFeeModelAbi = parseAbi([
  "function getFeeRate(address trader) external view returns (uint256)",
  "function _FEE_RATE_() external view returns (uint256)",
]);

const traderJoeLBFactoryAbi = parseAbi([
  "function getLBPairInformation(address tokenX, address tokenY, uint256 binStep) external view returns (uint256 binStep2, address LBPair, bool createdByOwner, bool ignoredForRouting)",
]);

const traderJoeLBPairAbi = parseAbi([
  "function getReserves() external view returns (uint128 reserveX, uint128 reserveY)",
  "function getTokenX() external view returns (address)",
  "function getTokenY() external view returns (address)",
  "function getActiveId() external view returns (uint24 activeId)",
  "function getBinStep() external view returns (uint16 binStep)",
  "function getBin(uint24 id) external view returns (uint128 binReserveX, uint128 binReserveY)",
  "function getNextNonEmptyBin(bool swapForY, uint24 id) external view returns (uint24 nextId)",
  "function getStaticFeeParameters() external view returns (uint16 baseFactor, uint16 filterPeriod, uint16 decayPeriod, uint16 reductionFactor, uint24 variableFeeControl, uint16 protocolShare, uint24 maxVolatilityAccumulator)",
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

// ── KyberSwap Classic / DMM ──────────────────────────────────
const kyberFactoryAbi = parseAbi([
  "function getPools(address token0, address token1) external view returns (address[] _pools)",
]);

const kyberPoolAbi = parseAbi([
  "function token0() external view returns (address)",
  "function getTradeInfo() external view returns (uint256 _reserve0, uint256 _reserve1, uint256 _vReserve0, uint256 _vReserve1, uint256 feeInPrecision)",
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

    const [sqrtPriceX96] = slot0.result as unknown as [bigint, ...unknown[]];
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

// ── Algebra V3 discovery (EXECUTABLE) ─────────────────────────────────────────
//
// Algebra forks (Camelot/QuickSwap V3, Ramses V2) are V3-shaped, so their state reads
// (globalState() → price/tick/dynamic-fee) map cleanly onto a UniV3 PoolInfo and PRICE
// wei-exact against the V3 oracle. The engine now EXECUTES an Algebra swap as well: the
// pool re-enters via algebraSwapCallback(int256,int256,bytes), and the Router implements
// that selector (a mirror of uniswapV3/pancakeV3 callbacks → _handleV3Callback) as of
// sauce#186. An Algebra pool's swap() is selector-identical to Uniswap V3, so _swapV3
// drives it and the new callback services the mid-swap input pull — so Algebra pools are
// INCLUDED in the executable set returned by discoverPools. See FactoryType.AlgebraV3 +
// LIQUIDITY_SOURCES_FEASIBILITY.md §3.

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

    const [price] = state.result as unknown as [bigint, ...unknown[]];
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
    if (result.status === "success" && result.result && result.result !== ZERO_ADDRESS) {
      const addr = (result.result as string).toLowerCase();
      if (!seen.has(addr)) {
        seen.add(addr);
        const label = calls[i].stable ? `${calls[i].factory.label} (stable)` : calls[i].factory.label;
        validPairs.push({ address: result.result as Hex, factory: { ...calls[i].factory, label } });
      }
    }
  }

  if (validPairs.length === 0) return [];

  // The legacy aggregator models BOTH Solidly volatile AND stable pools as xy=k V2 — the pre-existing
  // behaviour the other recipes (megaswap/alphaswap/gigaswap/terraswap) were tuned against; left
  // untouched so adding the stable source does not silently shift their routing. EcoSwap does NOT use
  // this path for stable pools — it discovers them precisely as typed SolidlyStablePool descriptors via
  // discoverSolidlyStablePoolsTyped (x3y+y3x sampled segments), so stable-curve fidelity lives there.
  return readV2PoolState(tokenIn, tokenOut, client, validPairs);
}

/** Interpret a Solidly factory `getFee` result as ppm (heuristic: a small value is bps → ×100). */
function solidlyFeeToPpm(fee: bigint | undefined): number {
  if (fee === undefined) return SOLIDLY_STABLE_DEFAULT_FEE_PPM;
  const n = Number(fee);
  if (n === 0) return SOLIDLY_STABLE_DEFAULT_FEE_PPM;
  // Velodrome/Aerodrome `getFee` returns bps (e.g. 1 = 0.01%); a value < 1000 is bps → ppm = bps×100.
  // A larger value is already ppm.
  return n < 1000 ? n * 100 : n;
}

/**
 * Discover Solidly STABLE (sAMM) pools for the pair AS TYPED `SolidlyStablePool` descriptors (the
 * EcoSwap path — distinct from the V2-tagged PoolInfo aggregator). Solidly stable pools (Aerodrome/
 * Velodrome/Thena/Ramses sAMM) trade on the x3y+y3x invariant, NOT xy=k, so they must NOT be priced
 * through the V2 synthetic-sqrt path. This reads token0/decimals/reserves + the per-pool fee so
 * prepare's `buildSolidlyStableSegments` can replay the curve with NO further RPC, and the on-chain
 * solver consumes the sampled segments statically + executes CALLBACK-FREE (getAmountOut staticcall +
 * transfer + pool.swap — NO engine SwapPoolType).
 *
 * Mirrors `discoverCurvePoolsTyped` / `discoverDodoV2PoolsTyped`: off-chain discovery + state reads,
 * returning the venue descriptor EcoSwap prepare consumes directly (the on-chain lens does not
 * understand Solidly stable pools). Factory path: getPool(tokenA, tokenB, true) per SolidlyV2 factory.
 * Decimals are read via erc20 `decimals()` (the normalisation factor); the fee via the factory
 * `getFee(pool, true)` (fork-default 0.01% on failure).
 */
export async function discoverSolidlyStablePoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<SolidlyStablePool[]> {
  if (factories.length === 0) return [];

  const addrResults = await client.multicall({
    contracts: factories.map((f) => ({
      address: f.address,
      abi: solidlyFactoryAbi,
      functionName: "getPool" as const,
      args: [tokenIn, tokenOut, true] as const, // stable
    })),
    allowFailure: true,
  });

  const seen = new Set<string>();
  const valid: { address: Hex; factory: FactoryConfig }[] = [];
  for (let i = 0; i < addrResults.length; i++) {
    const r = addrResults[i];
    if (r.status !== "success" || !r.result || r.result === ZERO_ADDRESS) continue;
    const key = (r.result as string).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ address: r.result as Hex, factory: factories[i] });
  }
  if (valid.length === 0) return [];

  const [token0Results, reserveResults, feeResults] = await Promise.all([
    client.multicall({
      contracts: valid.map((p) => ({ address: p.address, abi: solidlyStablePoolAbi, functionName: "token0" as const })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: valid.map((p) => ({ address: p.address, abi: solidlyStablePoolAbi, functionName: "getReserves" as const })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: valid.map((p) => ({ address: p.factory.address, abi: solidlyFactoryAbi, functionName: "getFee" as const, args: [p.address, true] as const })),
      allowFailure: true,
    }),
  ]);

  // Decimals: read the two tokens once (tokenIn + tokenOut).
  const [decInRaw, decOutRaw] = await Promise.all([
    client.readContract({ address: tokenIn, abi: erc20DecimalsAbi, functionName: "decimals" }).then((d) => Number(d)).catch(() => 18),
    client.readContract({ address: tokenOut, abi: erc20DecimalsAbi, functionName: "decimals" }).then((d) => Number(d)).catch(() => 18),
  ]);
  const decIn = 10n ** BigInt(decInRaw);
  const decOut = 10n ** BigInt(decOutRaw);

  const pools: SolidlyStablePool[] = [];
  for (let i = 0; i < valid.length; i++) {
    const t0 = token0Results[i];
    const reserves = reserveResults[i];
    if (t0.status !== "success" || reserves.status !== "success") continue;
    const [reserve0, reserve1] = reserves.result as [bigint, bigint, bigint];
    if (reserve0 === 0n || reserve1 === 0n) continue;
    const token0 = (t0.result as Hex);
    const inIsToken0 = tokenIn.toLowerCase() === token0.toLowerCase();
    pools.push({
      address: valid[i].address,
      reserveIn: inIsToken0 ? reserve0 : reserve1,
      reserveOut: inIsToken0 ? reserve1 : reserve0,
      decIn,
      decOut,
      token0,
      inIsToken0,
      feePpm: solidlyFeeToPpm(feeResults[i].status === "success" ? (feeResults[i].result as bigint) : undefined),
      source: `${valid[i].factory.label} (Solidly stable)`,
    });
  }
  return pools;
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

/**
 * Discover a Curve StableSwap plain pool for the pair AS A TYPED `CurvePool` descriptor
 * (the EcoSwap path — distinct from the legacy `discoverCurvePools` PoolInfo aggregator,
 * which mis-models a stable pool as a synthetic V2 sqrt). The curve math is OFF-CHAIN ONLY:
 * this reads the live invariant state (A, balances[], decimals→rates[], fee, coin indices)
 * so prepare's `buildCurveSegments` can replay get_dy with NO further RPC, and the on-chain
 * solver consumes the sampled segments statically + executes via swap(SwapParams{poolType:3}).
 *
 * Mirrors `discoverKyberClassicPools`: off-chain discovery + state reads, returns the venue
 * descriptor the EcoSwap prepare consumes directly (the on-chain lens does not understand
 * Curve). Registry path: find_pool_for_coins → get_coin_indices (int128 i,j) → get_n_coins /
 * get_decimals; pool path: A(), fee(), balances(k). rates[k] = 1e18 * 10**(18 - decimals[k]).
 *
 * SCOPE: StableSwap plain pools (int128 indices = the engine ABI). CryptoSwap / uint256-index
 * pools are OUT of scope (deferred). `aPrecision` defaults to the modern/NG A_PRECISION=100;
 * a legacy pre-A_PRECISION pool needs `aPrecision: 1n` (configured per registry if needed).
 */
export async function discoverCurvePoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  registries: FactoryConfig[],
): Promise<CurvePool[]> {
  if (registries.length === 0) return [];

  const pools: CurvePool[] = [];
  for (const registry of registries) {
    try {
      const poolAddr = (await client.readContract({
        address: registry.address,
        abi: curveRegistryAbi,
        functionName: "find_pool_for_coins",
        args: [tokenIn, tokenOut],
      })) as Hex;
      if (!poolAddr || poolAddr === ZERO_ADDRESS) continue;

      // Coin indices + coin count + decimals from the registry (int128 i,j = engine ABI).
      const [indices, nCoinsRaw, decimalsRaw] = await Promise.all([
        client.readContract({
          address: registry.address,
          abi: curveRegistryAbi,
          functionName: "get_coin_indices",
          args: [poolAddr, tokenIn, tokenOut],
        }) as Promise<readonly [bigint, bigint, boolean]>,
        client.readContract({
          address: registry.address,
          abi: curveRegistryAbi,
          functionName: "get_n_coins",
          args: [poolAddr],
        }).catch(() => 2n) as Promise<bigint>,
        client.readContract({
          address: registry.address,
          abi: curveRegistryAbi,
          functionName: "get_decimals",
          args: [poolAddr],
        }).catch(() => null) as Promise<readonly bigint[] | null>,
      ]);

      const i = Number(indices[0]);
      const j = Number(indices[1]);
      const underlying = indices[2];
      // Underlying (meta-pool lending) coins need a different exchange path; plain only.
      if (underlying) continue;
      const N = Number(nCoinsRaw) || 2;
      if (i < 0 || j < 0 || i >= N || j >= N) continue;

      // Pool state: A, fee, and the full balances array.
      const [A, feeRaw] = await Promise.all([
        client.readContract({ address: poolAddr, abi: curvePoolAbi, functionName: "A" }) as Promise<bigint>,
        client.readContract({ address: poolAddr, abi: curvePoolAbi, functionName: "fee" }) as Promise<bigint>,
      ]);
      const balances: bigint[] = await Promise.all(
        Array.from({ length: N }, (_, k) =>
          client.readContract({
            address: poolAddr,
            abi: curvePoolAbi,
            functionName: "balances",
            args: [BigInt(k)],
          }) as Promise<bigint>,
        ),
      );
      if (balances.some((b) => b <= 0n)) continue;

      // rates[k] = 1e18 * 10**(18 - decimals[k]) — scale each coin into the common 1e18 unit.
      // Registry get_decimals returns a uint256[8]; fall back to per-coin decimals() reads.
      let decimals: number[];
      if (decimalsRaw && decimalsRaw.length >= N) {
        decimals = Array.from({ length: N }, (_, k) => Number(decimalsRaw[k]));
      } else {
        const coinAddrs = await Promise.all(
          Array.from({ length: N }, (_, k) =>
            client.readContract({
              address: poolAddr,
              abi: curvePoolAbi,
              functionName: "coins",
              args: [BigInt(k)],
            }) as Promise<Hex>,
          ),
        );
        decimals = await Promise.all(
          coinAddrs.map((addr) =>
            client
              .readContract({
                address: addr,
                abi: parseAbi(["function decimals() view returns (uint8)"]),
                functionName: "decimals",
              })
              .then((d) => Number(d))
              .catch(() => 18),
          ),
        );
      }
      const rates = decimals.map((d) => 10n ** 18n * 10n ** BigInt(18 - d));

      pools.push({
        poolType: SwapPoolType.Curve,
        address: poolAddr,
        i,
        j,
        A,
        aPrecision: A_PRECISION_DEFAULT,
        balances,
        rates,
        feePpm10: feeRaw,
        source: registry.label,
      });
    } catch {
      // Registry / pool read failed — skip this registry.
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

/**
 * Discover DODO V2 PMM pools for the pair AS TYPED `DodoPool` descriptors (the EcoSwap path —
 * distinct from the legacy `discoverDODOPools` PoolInfo aggregator, which mis-models a PMM pool
 * as ONE synthetic V2 sqrt from raw reserves). DODO V2 is a Proactive Market Maker: the curve is a
 * closed-form integral parameterised by a GUIDE PRICE `i` (1e18-scaled), a slippage coefficient
 * `K`, the live reserves B/Q, the target reserves B0/Q0 and the R-state — ALL of which are POOL
 * STATE read live from `getPMMStateForCall()` (the guide price is NOT an exogenous oracle feed,
 * unlike WOOFi/Fermi — so DODO is wei-exact-on-grid under the charter). The curve math is OFF-CHAIN
 * ONLY: this reads the live PMM state so prepare's `buildDodoSegments` can replay querySell* with NO
 * further RPC, and the on-chain solver consumes the sampled segments statically + executes the
 * awarded Σ share via swap(SwapParams{poolType:5}) → live _swapDODOV2 (it resolves base/quote
 * orientation on-chain from `_BASE_TOKEN_()`).
 *
 * Mirrors `discoverCurvePoolsTyped`: off-chain discovery + state reads, returning the venue
 * descriptor EcoSwap prepare consumes directly (the on-chain lens does not understand DODO). Zoo
 * path: getDODO(base, quote) over BOTH orderings (DODO pools are base/quote-oriented, so the pair
 * may be registered either way); pool path: getPMMStateForCall() + _BASE_TOKEN_()/_QUOTE_TOKEN_() +
 * _LP_FEE_RATE_() + the MT fee-rate model getFeeRate(caller). The DODO registry/factory address is
 * the `DODOZoo` FactoryConfig entry (documented placeholders per chain in constants.ts).
 *
 * SCOPE: DVM/DSP/DPP pools exposing getPMMStateForCall (the standard V2 PMM surface). The caller's
 * MT fee rate is read once at quote time and treated as fixed over the trade (the snapshot
 * assumption the recipe makes for V3 tiers / Curve fee / LB base fee).
 */
export async function discoverDodoV2PoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  zoos: FactoryConfig[],
  caller: Hex = ZERO_ADDRESS,
): Promise<DodoPool[]> {
  if (zoos.length === 0) return [];

  const pools: DodoPool[] = [];
  const seen = new Set<string>();
  const inLower = tokenIn.toLowerCase();

  for (const zoo of zoos) {
    // DODO is base/quote-oriented — query both orderings; the pool's own _BASE_TOKEN_() is the
    // authoritative orientation (sellBase = tokenIn is the base).
    for (const [base, quote] of [
      [tokenIn, tokenOut],
      [tokenOut, tokenIn],
    ] as [Hex, Hex][]) {
      let addresses: string[];
      try {
        addresses = (await client.readContract({
          address: zoo.address,
          abi: dodoZooAbi,
          functionName: "getDODO",
          args: [base, quote],
        })) as string[];
      } catch {
        continue;
      }

      for (const addr of addresses) {
        if (!addr || addr === ZERO_ADDRESS) continue;
        const key = addr.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        try {
          const pool = addr as Hex;
          const [stateRaw, baseTokenRaw, quoteTokenRaw, lpFeeRaw, mtModelRaw] = await Promise.all([
            client.readContract({
              address: pool,
              abi: dodoPmmAbi,
              functionName: "getPMMStateForCall",
            }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint]>,
            client.readContract({ address: pool, abi: dodoPmmAbi, functionName: "_BASE_TOKEN_" }) as Promise<Hex>,
            client.readContract({ address: pool, abi: dodoPmmAbi, functionName: "_QUOTE_TOKEN_" }) as Promise<Hex>,
            client
              .readContract({ address: pool, abi: dodoPmmAbi, functionName: "_LP_FEE_RATE_" })
              .catch(() => 0n) as Promise<bigint>,
            client
              .readContract({ address: pool, abi: dodoPmmAbi, functionName: "_MT_FEE_RATE_MODEL_" })
              .catch(() => ZERO_ADDRESS as Hex) as Promise<Hex>,
          ]);

          const [i, K, B, Q, B0, Q0, Rraw] = stateRaw;
          // i is the guide price; a zero guide price / empty curve cannot trade.
          if (i <= 0n) continue;

          // Resolve the MT (maintainer) fee for the caller from the fee-rate model (a flat-rate
          // model ignores the trader; getFeeRate is the canonical per-trader reader).
          let mtFeeRate = 0n;
          if (mtModelRaw && mtModelRaw !== ZERO_ADDRESS) {
            mtFeeRate = (await client
              .readContract({
                address: mtModelRaw,
                abi: dodoMtFeeModelAbi,
                functionName: "getFeeRate",
                args: [caller],
              })
              .catch(async () =>
                client
                  .readContract({ address: mtModelRaw, abi: dodoMtFeeModelAbi, functionName: "_FEE_RATE_" })
                  .catch(() => 0n),
              )) as bigint;
          }

          const baseToken = baseTokenRaw;
          const quoteToken = quoteTokenRaw;
          const sellBase = inLower === baseToken.toLowerCase();
          // tokenIn must be one of the pool's two tokens.
          if (!sellBase && inLower !== quoteToken.toLowerCase()) continue;
          // An empty pool on the side being sold has no depth.
          if (sellBase ? Q <= 0n : B <= 0n) continue;

          const R =
            Number(Rraw) === 1 ? RState.ABOVE_ONE : Number(Rraw) === 2 ? RState.BELOW_ONE : RState.ONE;

          pools.push({
            poolType: SwapPoolType.DODOV2,
            address: pool,
            baseToken,
            quoteToken,
            sellBase,
            i,
            K,
            B,
            Q,
            B0,
            Q0,
            R,
            lpFeeRate: lpFeeRaw,
            mtFeeRate,
            feePpm: dodoFeeToPpm(lpFeeRaw, mtFeeRate),
            source: zoo.label,
          });
        } catch {
          // Pool state read failed (non-PMM surface / partial pool) — skip.
        }
      }
    }
  }

  return pools;
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

/**
 * Discover Trader Joe LB pairs for the swap AS TYPED `LbPool` descriptors (the EcoSwap path —
 * distinct from the legacy `discoverTraderJoeLBPools` PoolInfo aggregator, which mis-models an
 * LB pair as ONE synthetic V2 sqrt). LB is a DISCRETE-BIN constant-sum AMM: this reads the live
 * per-bin reserves around the active bin so prepare's `buildLbSegments` can emit ONE EXACT flat
 * segment per bin with NO sampling, and the on-chain solver consumes the segments statically +
 * executes the awarded Σ share via swap(SwapParams{poolType:6}) → live _swapTraderJoeLB (one
 * atomic `pool.swap(swapForY, to)`; the engine resolves swapForY on-chain from getTokenX()).
 *
 * Mirrors `discoverCurvePoolsTyped`: off-chain discovery + state reads, returning the venue
 * descriptor EcoSwap prepare consumes directly (the on-chain lens does not understand LB).
 * Factory path: getLBPairInformation(tokenX, tokenY, binStep) per known bin step → pair; pair
 * path: getActiveId / getBinStep / getStaticFeeParameters().baseFactor + getBin(id) over a
 * window of `TRADER_JOE_BIN_WINDOW` bins on each side of the active id (the swap walks outward
 * from active, so only bins in the swap direction matter — both sides are read so either swap
 * direction is covered without re-discovery).
 *
 * SCOPE: LB v2.1/v2.2 pairs (the getActiveId/getBin/getStaticFeeParameters surface). The base
 * fee (baseFactor·binStep) is the snapshot fee; the transient variable/volatility fee is omitted.
 */
export async function discoverTraderJoeLBPoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<LbPool[]> {
  if (factories.length === 0) return [];

  const pools: LbPool[] = [];
  const inLower = tokenIn.toLowerCase();
  for (const factory of factories) {
    // Find the pair for each known bin step (both token orderings resolve the same pair —
    // getLBPairInformation is order-independent on (tokenX, tokenY) within a binStep).
    const infoCalls = TRADER_JOE_BIN_STEPS.map((binStep) => ({
      address: factory.address,
      abi: traderJoeLBFactoryAbi,
      functionName: "getLBPairInformation" as const,
      args: [tokenIn, tokenOut, BigInt(binStep)] as const,
    }));
    let infos;
    try {
      infos = await client.multicall({ contracts: infoCalls, allowFailure: true });
    } catch {
      continue;
    }

    const validPairs: { address: Hex; binStep: number }[] = [];
    for (let i = 0; i < infos.length; i++) {
      const r = infos[i];
      if (r.status !== "success") continue;
      const [, pairAddr, , ignoredForRouting] = r.result as [bigint, string, boolean, boolean];
      if (pairAddr && pairAddr !== ZERO_ADDRESS && !ignoredForRouting) {
        validPairs.push({ address: pairAddr as Hex, binStep: TRADER_JOE_BIN_STEPS[i] });
      }
    }
    if (validPairs.length === 0) continue;

    for (const vp of validPairs) {
      try {
        // Pair-level state: tokenX (direction), active id, bin step, base-fee factor.
        const [tokenXRaw, activeIdRaw, binStepRaw, feeParamsRaw] = await Promise.all([
          client.readContract({ address: vp.address, abi: traderJoeLBPairAbi, functionName: "getTokenX" }) as Promise<string>,
          client.readContract({ address: vp.address, abi: traderJoeLBPairAbi, functionName: "getActiveId" }) as Promise<number>,
          client.readContract({ address: vp.address, abi: traderJoeLBPairAbi, functionName: "getBinStep" }) as Promise<number>,
          client
            .readContract({ address: vp.address, abi: traderJoeLBPairAbi, functionName: "getStaticFeeParameters" })
            .catch(() => null) as Promise<readonly [number, number, number, number, number, number, number] | null>,
        ]);

        const tokenX = tokenXRaw.toLowerCase();
        const swapForY = inLower === tokenX;
        const activeId = Number(activeIdRaw);
        const binStep = Number(binStepRaw) || vp.binStep;
        const baseFactor = feeParamsRaw ? Number(feeParamsRaw[0]) : TRADER_JOE_DEFAULT_BASE_FACTOR;

        // Read bins over the window on BOTH sides of the active id (one getBin per id).
        // Only bins in the swap direction are ever consumed, but reading both sides lets a
        // re-orientation reuse the descriptor; empty bins are dropped below.
        const lo = activeId - TRADER_JOE_BIN_WINDOW;
        const hi = activeId + TRADER_JOE_BIN_WINDOW;
        const ids: number[] = [];
        for (let id = lo; id <= hi; id++) if (id >= 0) ids.push(id);

        const binResults = await client.multicall({
          contracts: ids.map((id) => ({
            address: vp.address,
            abi: traderJoeLBPairAbi,
            functionName: "getBin" as const,
            args: [id] as const,
          })),
          allowFailure: true,
        });

        const bins: { id: number; reserveX: bigint; reserveY: bigint }[] = [];
        for (let i = 0; i < ids.length; i++) {
          const r = binResults[i];
          if (r.status !== "success") continue;
          const [reserveX, reserveY] = r.result as [bigint, bigint];
          if (reserveX === 0n && reserveY === 0n) continue; // uninitialized / empty bin
          bins.push({ id: ids[i], reserveX, reserveY });
        }
        if (bins.length === 0) continue;

        pools.push({
          poolType: SwapPoolType.TraderJoeLB,
          address: vp.address,
          binStep,
          baseFactor,
          activeId,
          swapForY,
          bins,
          source: `${factory.label} (bin ${binStep})`,
        });
      } catch {
        // Pair read failed (non-LB-v2.1 surface) — skip.
      }
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

// ── KyberSwap Classic / DMM discovery ───────────────────────

/**
 * One discovered KyberSwap Classic / DMM pool. Kyber is an amplified constant-product
 * AMM trading on VIRTUAL reserves: the curve geometry (sqrt/L) is keyed off vReserve*,
 * NOT the real reserves. A Kyber pool is mathematically a V2 range with
 * L = isqrt(vReserveIn·vReserveOut). The fee is per-pool and live (feeInPrecision, 1e18-scaled).
 * Execution is callback-free (transfer + pool.swap(a0, a1, to, "")), so no engine change.
 */
export interface KyberClassicPool {
  address: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  /** Real tokenIn-side reserve (used by execution's balance check, not the curve). */
  reserveIn: bigint;
  /** Real tokenOut-side reserve. */
  reserveOut: bigint;
  /** VIRTUAL tokenIn-side reserve — seeds the constant-L curve geometry. */
  vReserveIn: bigint;
  /** VIRTUAL tokenOut-side reserve. */
  vReserveOut: bigint;
  /** Live per-pool fee, scaled by 1e18 (PRECISION). */
  feeInPrecision: bigint;
  /** Is tokenIn the pool's token0 (orientation for getTradeInfo / swap output slot)? */
  inIsToken0: boolean;
  source: string;
}

/**
 * Discover KyberSwap Classic / DMM pools for the pair. getPools(token0, token1) returns
 * EVERY DMM pool for the unordered pair (one per amplification factor); per-pool
 * getTradeInfo() yields (reserve0, reserve1, vReserve0, vReserve1, feeInPrecision). The
 * virtual reserves seed the V2-shaped curve; the real reserves + fee are carried for
 * the callback-free execution.
 */
export async function discoverKyberClassicPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<KyberClassicPool[]> {
  if (factories.length === 0) return [];

  // getPools is order-insensitive in the DMM factory, but query each factory once.
  const listResults = await client.multicall({
    contracts: factories.map((f) => ({
      address: f.address,
      abi: kyberFactoryAbi,
      functionName: "getPools" as const,
      args: [tokenIn, tokenOut] as const,
    })),
    allowFailure: true,
  });

  const validPools: { address: Hex; factory: FactoryConfig }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < listResults.length; i++) {
    const r = listResults[i];
    if (r.status !== "success" || !r.result) continue;
    for (const addr of r.result as readonly Hex[]) {
      if (!addr || addr === ZERO_ADDRESS) continue;
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      validPools.push({ address: addr, factory: factories[i] });
    }
  }
  if (validPools.length === 0) return [];

  const [tradeInfoResults, token0Results] = await Promise.all([
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: kyberPoolAbi,
        functionName: "getTradeInfo" as const,
      })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: kyberPoolAbi,
        functionName: "token0" as const,
      })),
      allowFailure: true,
    }),
  ]);

  const pools: KyberClassicPool[] = [];
  for (let i = 0; i < validPools.length; i++) {
    const ti = tradeInfoResults[i];
    const t0 = token0Results[i];
    if (ti.status !== "success" || t0.status !== "success") continue;

    const [reserve0, reserve1, vReserve0, vReserve1, feeInPrecision] =
      ti.result as readonly [bigint, bigint, bigint, bigint, bigint];
    if (vReserve0 === 0n || vReserve1 === 0n) continue;

    const inIsToken0 = tokenIn.toLowerCase() === (t0.result as string).toLowerCase();
    pools.push({
      address: validPools[i].address,
      tokenIn,
      tokenOut,
      reserveIn: inIsToken0 ? reserve0 : reserve1,
      reserveOut: inIsToken0 ? reserve1 : reserve0,
      vReserveIn: inIsToken0 ? vReserve0 : vReserve1,
      vReserveOut: inIsToken0 ? vReserve1 : vReserve0,
      feeInPrecision,
      inIsToken0,
      source: validPools[i].factory.label,
    });
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

  // Algebra pools are EXECUTABLE: the engine implements algebraSwapCallback (sauce#186), so
  // a pool surfaced as a UniV3 row is cooked via swapV3 and the mid-swap input pull is
  // serviced. They are INCLUDED in the executable set returned to the recipes. See
  // discoverAlgebraPools' header + FactoryType.AlgebraV3 + LIQUIDITY_SOURCES_FEASIBILITY.md §3.
  return [
    ...v3Pools, ...v4Pools, ...algebraPools, ...v2Pools, ...solidlyV2Pools,
    ...curvePools, ...balancerPools, ...dodoPools, ...traderJoePools,
    ...maverickPools, ...woofiPools,
  ];
}
