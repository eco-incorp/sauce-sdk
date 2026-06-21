/**
 * EcoSwap off-chain preparation.
 *
 * Reconstructs each pool's liquidity curve as per-tick "brackets" in a unified
 * out/in sqrt-price space, then builds a single global ladder sorted by
 * fee-adjusted marginal price. The on-chain solver walks that ladder once to
 * find the common marginal-price cut and executes one swap per pool.
 *
 * Pipeline:
 *   1. Discover pools (reuse shared/pool-discovery) + multi-hop routes.
 *   2. Classify: V3 concentrated (read slot0/ticks) vs V2 constant-product
 *      (read reserves). Algebra/stable/exotic pools are skipped (bespoke math).
 *   3. V3: scan a window of ticks in ONE multicall, reconstruct per-bracket L
 *      from active liquidity() + liquidityNet. V2: one wide bracket discretised
 *      into geometric steps (a V2 pool == a single V3 range with L = sqrt(k)).
 *   4. Routes: sample input sizes, quote each hop, derive route segments.
 *   5. Fee-adjust, compute per-bracket gross input capacity, sort the ladder.
 *
 * RPC efficiency: tick reads for ALL V3 pools are batched into a single
 * Multicall3 round-trip (the client is created with multicall3 configured).
 */

import type { PublicClient, Hex } from "viem";
import { parseAbi } from "viem";
import { discoverPools } from "./../shared/pool-discovery";
import { quotePool } from "./../shared/quoting";
import {
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  SwapPoolType,
  BASE_CHAIN_POOL_CONFIG,
  type ChainPoolConfig,
} from "./../shared/constants";
import {
  EcoBracketKind,
  type EcoSwapConfig,
  type EcoSwapPrepared,
  type EcoBracket,
  type EcoPool,
  type EcoRoute,
  type PoolInfo,
  type DiscoveredMultiHopRoute,
} from "./../shared/types";

// ── Tunables ─────────────────────────────────────────────────

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const FEE_DENOM = 1_000_000n; // ppm

/** Absolute floor: pools below this liquidity contribute negligibly; excluded. */
const MIN_LIQUIDITY = 10n ** 13n;
/**
 * RELATIVE-depth floor (bps of TOTAL discovered liquidity). For one token pair,
 * raw active-L at spot is comparable across V2 (≡ a V3 range with L=√k), V3 and
 * V4, so a pool holding < this fraction of the combined marginal depth would only
 * ever get a dust slice — not worth a swap's gas. Default 100 bps (1%); override
 * with ECO_MIN_REL_BPS, or per-call via prepareEcoSwap opts. 0 disables.
 */
const DEFAULT_MIN_REL_BPS = Number(process.env.ECO_MIN_REL_BPS ?? 100);
/**
 * Tick boundaries scanned per V3 pool in the swap direction (fetch window).
 * Fetched generously in one multicall; the ladder is then TRIMMED to the ticks
 * the trade actually crosses (see SAFETY_TICKS), so on-chain gas/calldata scale
 * with trade size, not with this window. Must be wide enough to reach the cut
 * for the largest expected trade.
 */
const V3_TICK_STEPS = 96;
/** Geometric brackets emitted per V2 pool (also trimmed to crossed + safety). */
const V2_BRACKETS = 16;
/** Cap on direct pools (top-N by liquidity) — bounds on-chain loop + calldata. */
const MAX_DIRECT_POOLS = Number(process.env.ECO_MAX_POOLS ?? 12);
/**
 * Per-pool safety margin: after the off-chain water-fill determines how many
 * brackets each pool crosses, keep this many EXTRA brackets just past the cut so
 * a pool can fill slightly deeper than estimated if live prices drift at runtime.
 */
const SAFETY_TICKS = 2;
/** Always keep at least this many brackets (so tiny trades still split sensibly). */
const MIN_BRACKETS = 8;
/** Per-bracket price step for V2 discretisation (~0.5% per bracket in sqrt). */
const V2_SQRT_STEP_BPS = 25n; // 0.25% of sqrt → ~0.5% price per bracket
/** Input samples used to profile each multi-hop route. */
const ROUTE_SAMPLES = 6;
/** Keep at most this many routes (bytecode/gas bound). */
const MAX_ROUTES = Number(process.env.ECO_MAX_ROUTES ?? 2);
/**
 * Engine `_swapV2` hardcodes the constant-product fee at 0.3% (997/1000) for
 * EVERY V2 pool, ignoring the discovered fee tier. So all V2 brackets are pinned
 * to this fee so the off-chain capacity/marginal ladder matches what executes.
 */
const V2_FEE_PPM = 3000;

// ── ABIs (tick-level reads not in the shared minimal pool ABI) ──

const v3PoolAbi = parseAbi([
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
  "function tickSpacing() external view returns (int24)",
  "function ticks(int24 tick) external view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
]);

const v2PairAbi = parseAbi([
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
]);

// V4 StateView lens: pool state is keyed by poolId on the singleton, read here.
const v4StateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getTickLiquidity(bytes32 poolId, int24 tick) external view returns (uint128 liquidityGross, int128 liquidityNet)",
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

// ── Math helpers ─────────────────────────────────────────────

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/** Integer square root (Babylonian). */
function isqrt(x: bigint): bigint {
  if (x <= 0n) return 0n;
  let z = x;
  let y = (z + 1n) / 2n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

/** sqrt(1 - fee) scaled by 1e6, i.e. round(sqrt((1e6 - feePpm)/1e6) * 1e6). */
function sqrtOneMinusFeeScaled(feePpm: number): bigint {
  return isqrt(BigInt(1_000_000 - feePpm) * FEE_DENOM);
}

/** Apply the fee-adjustment to a spot out/in sqrt price. */
function feeAdjust(sqrtSpot: bigint, feePpm: number): bigint {
  return (sqrtSpot * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}

/**
 * Gross input (tokenIn units incl. fee) to traverse a bracket [sqrtFar, sqrtNear]
 * of constant liquidity L, in unified out/in space:
 *   effIn = L * 2^96 * (1/sqrtFar - 1/sqrtNear);  grossIn = effIn / (1 - fee)
 */
function bracketCapacity(L: bigint, sqrtNear: bigint, sqrtFar: bigint, feePpm: number): bigint {
  if (L <= 0n || sqrtFar <= 0n || sqrtNear <= sqrtFar) return 0n;
  const effIn = (L * Q96) / sqrtFar - (L * Q96) / sqrtNear;
  if (effIn <= 0n) return 0n;
  return (effIn * FEE_DENOM) / BigInt(1_000_000 - feePpm);
}

/** Exact Uniswap V3 TickMath.getSqrtRatioAtTick (real token1/token0 sqrt, Q96). */
function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const mul = (m: bigint) => {
    ratio = (ratio * m) >> 128n;
  };
  if (absTick & 0x2n) mul(0xfff97272373d413259a46990580e213an);
  if (absTick & 0x4n) mul(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if (absTick & 0x8n) mul(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if (absTick & 0x10n) mul(0xffcb9843d60f6159c9db58835c926644n);
  if (absTick & 0x20n) mul(0xff973b41fa98c081472e6896dfb254c0n);
  if (absTick & 0x40n) mul(0xff2ea16466c96a3843ec78b326b52861n);
  if (absTick & 0x80n) mul(0xfe5dee046a99a2a811c461f1969c3053n);
  if (absTick & 0x100n) mul(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if (absTick & 0x200n) mul(0xf987a7253ac413176f2b074cf7815e54n);
  if (absTick & 0x400n) mul(0xf3392b0822b70005940c7a398e4b70f3n);
  if (absTick & 0x800n) mul(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if (absTick & 0x1000n) mul(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if (absTick & 0x2000n) mul(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if (absTick & 0x4000n) mul(0x70d869a156d2a1b890bb3df62baf32f7n);
  if (absTick & 0x8000n) mul(0x31be135f97d08fd981231505542fcfa6n);
  if (absTick & 0x10000n) mul(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if (absTick & 0x20000n) mul(0x5d6af8dedb81196699c329225ee604n);
  if (absTick & 0x40000n) mul(0x2216e584f5fa1ea926041bedfe98n);
  if (absTick & 0x80000n) mul(0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  // sqrtPriceX96 = ratio >> 32, rounding up
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Convert a real pool sqrt (token1/token0) into unified out/in sqrt. */
function toOutIn(sqrtReal: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? sqrtReal : Q192 / sqrtReal;
}

// ── Classification ───────────────────────────────────────────

function isUsableV2(p: PoolInfo): boolean {
  // Constant-product only; Solidly *stable* pools use a different invariant.
  return p.poolType === SwapPoolType.UniV2 && !/stable/i.test(p.source);
}

function isV3Candidate(p: PoolInfo): boolean {
  return p.poolType === SwapPoolType.UniV3;
}

function isV4Candidate(p: PoolInfo): boolean {
  // Only hookless V4 pools with a StateView lens + poolId are reconstructable here.
  return p.poolType === SwapPoolType.UniV4 && !!p.poolId && !!p.stateView;
}

// ── V3 bracket construction ──────────────────────────────────

interface V3Read {
  pool: PoolInfo;
  tick: number;
  tickSpacing: number;
  activeLiquidity: bigint;
  /** liquidityNet keyed by tick index, for the scanned window. */
  net: Map<number, bigint>;
}

/** Standard Uniswap-V3 fee → tickSpacing mapping (covers the discovered V3 forks). */
const TICK_SPACING_BY_FEE: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };
function feeToTickSpacing(fee: number): number {
  return TICK_SPACING_BY_FEE[fee] ?? 60;
}

/** Approximate current tick from sqrtPriceX96: tick = log_1.0001(price), price = (sqrtP/2^96)^2. */
function approxTickFromSqrtPriceX96(sqrtP: bigint): number {
  const ratio = Number(sqrtP) / 2 ** 96; // sqrt(price); double precision is ample for ±1-tick centering
  return Math.floor((2 * Math.log(ratio)) / Math.log(1.0001));
}

/**
 * Read the windowed ticks() for every V3 pool in a SINGLE Multicall3 round-trip.
 *
 * Current tick (from `sqrtPriceX96`) and tickSpacing (from `fee`) are derived
 * off-chain from data discovery already returned, and `liquidity()` is the active
 * liquidity carried on PoolInfo — so no extra state read is needed. The only RPC
 * here is the one batched `ticks()` multicall across all pools.
 */
async function readV3Pools(
  pools: PoolInfo[],
  zeroForOne: boolean,
  client: PublicClient,
): Promise<V3Read[]> {
  if (pools.length === 0) return [];

  const usable = pools
    .filter((p) => p.liquidity > 0n && p.sqrtPriceX96 > 0n)
    .map((p) => {
      const tickSpacing = feeToTickSpacing(p.fee);
      const tick = approxTickFromSqrtPriceX96(p.sqrtPriceX96);
      const base = Math.floor(tick / tickSpacing) * tickSpacing;
      const boundaries: number[] = [];
      for (let k = 0; k <= V3_TICK_STEPS; k++) {
        boundaries.push(zeroForOne ? base - k * tickSpacing : base + (k + 1) * tickSpacing);
      }
      return { pool: p, tick, tickSpacing, activeLiquidity: p.liquidity, boundaries };
    });

  // Every ticks() for every pool — ONE multicall round-trip.
  const tickCalls = usable.flatMap((u) =>
    u.boundaries.map((b) => ({
      address: u.pool.address,
      abi: v3PoolAbi,
      functionName: "ticks" as const,
      args: [b] as const,
    })),
  );
  if (tickCalls.length === 0) return [];

  const tickResults = await client.multicall({ contracts: tickCalls, allowFailure: true });

  const out: V3Read[] = [];
  let cursor = 0;
  for (const u of usable) {
    const net = new Map<number, bigint>();
    for (const b of u.boundaries) {
      const r = tickResults[cursor++];
      if (r.status === "success") {
        const liquidityNet = (r.result as unknown as [bigint, bigint, ...unknown[]])[1];
        if (liquidityNet !== 0n) net.set(b, liquidityNet);
      }
    }
    out.push({ pool: u.pool, tick: u.tick, tickSpacing: u.tickSpacing, activeLiquidity: u.activeLiquidity, net });
  }
  return out;
}

/**
 * Build out/in brackets for one V3 pool from its tick window.
 *
 * Walks boundaries in the swap direction. The first bracket's near edge is the
 * LIVE current price; each subsequent edge is an initialized-tick boundary.
 * Crossing a boundary updates active liquidity by ±liquidityNet (− when the
 * price moves down for zeroForOne, + when it moves up for oneForZero).
 */
function buildV3Brackets(r: V3Read, refIdx: number, zeroForOne: boolean): EcoBracket[] {
  const brackets: EcoBracket[] = [];
  const feePpm = r.pool.fee;
  const base = Math.floor(r.tick / r.tickSpacing) * r.tickSpacing;

  let L = r.activeLiquidity;
  let nearReal = r.pool.sqrtPriceX96; // real sqrt at the near edge (starts live)
  let b = zeroForOne ? base : base + r.tickSpacing; // first boundary tick in swap dir
  const step = zeroForOne ? -r.tickSpacing : r.tickSpacing;

  for (let k = 0; k < V3_TICK_STEPS; k++) {
    const farReal = getSqrtRatioAtTick(b);
    const near = toOutIn(nearReal, zeroForOne);
    const far = toOutIn(farReal, zeroForOne);
    if (L > 0n && far > 0n && near > far) {
      brackets.push(makeBracket(EcoBracketKind.V3, refIdx, near, far, L, feePpm));
    }
    const net = r.net.get(b) ?? 0n;
    L = zeroForOne ? L - net : L + net;
    if (L < 0n) L = 0n;
    nearReal = farReal;
    b += step;
  }
  return brackets;
}

// ── V4 reads (StateView, singleton) ──────────────────────────

/**
 * Read the windowed tick liquidity for every V4 pool via its StateView lens,
 * batched into a SINGLE Multicall3 round-trip. Produces the same `V3Read` shape
 * as readV3Pools so the identical bracket builder reconstructs the curve — V4's
 * concentrated-liquidity geometry is the same as V3's, only the read path (poolId
 * on the singleton, not slot0()/ticks() on a pool contract) differs.
 */
async function readV4Pools(
  pools: PoolInfo[],
  zeroForOne: boolean,
  client: PublicClient,
): Promise<V3Read[]> {
  if (pools.length === 0) return [];

  const usable = pools
    .filter((p) => p.liquidity > 0n && p.sqrtPriceX96 > 0n && p.poolId && p.stateView)
    .map((p) => {
      const tickSpacing = p.tickSpacing ?? feeToTickSpacing(p.fee);
      const tick = approxTickFromSqrtPriceX96(p.sqrtPriceX96);
      const base = Math.floor(tick / tickSpacing) * tickSpacing;
      const boundaries: number[] = [];
      for (let k = 0; k <= V3_TICK_STEPS; k++) {
        boundaries.push(zeroForOne ? base - k * tickSpacing : base + (k + 1) * tickSpacing);
      }
      return { pool: p, tick, tickSpacing, activeLiquidity: p.liquidity, boundaries };
    });

  const tickCalls = usable.flatMap((u) =>
    u.boundaries.map((b) => ({
      address: u.pool.stateView as Hex,
      abi: v4StateViewAbi,
      functionName: "getTickLiquidity" as const,
      args: [u.pool.poolId as Hex, b] as const,
    })),
  );
  if (tickCalls.length === 0) return [];

  const tickResults = await client.multicall({ contracts: tickCalls, allowFailure: true });

  const out: V3Read[] = [];
  let cursor = 0;
  for (const u of usable) {
    const net = new Map<number, bigint>();
    for (const b of u.boundaries) {
      const r = tickResults[cursor++];
      if (r.status === "success") {
        const liquidityNet = (r.result as unknown as [bigint, bigint])[1];
        if (liquidityNet !== 0n) net.set(b, liquidityNet);
      }
    }
    out.push({ pool: u.pool, tick: u.tick, tickSpacing: u.tickSpacing, activeLiquidity: u.activeLiquidity, net });
  }
  return out;
}

// ── V2 bracket construction ──────────────────────────────────

/** Build discretised out/in brackets for one constant-product pool. */
function buildV2Brackets(pool: PoolInfo, refIdx: number, feePpm: number): EcoBracket[] {
  const brackets: EcoBracket[] = [];
  const L = pool.liquidity; // synthetic sqrt(k); recomputed live on-chain
  let near = pool.sqrtPriceX96; // already out/in for V2

  for (let i = 0; i < V2_BRACKETS; i++) {
    const far = near - (near * V2_SQRT_STEP_BPS) / 10_000n;
    if (far <= 0n || far >= near) break;
    brackets.push(makeBracket(EcoBracketKind.V2, refIdx, near, far, L, feePpm));
    near = far;
  }
  return brackets;
}

// ── Bracket factory (fee-adjust + capacity) ──────────────────

function makeBracket(
  kind: EcoBracketKind,
  refIdx: number,
  sqrtNear: bigint,
  sqrtFar: bigint,
  liquidity: bigint,
  feePpm: number,
): EcoBracket {
  return {
    kind,
    refIdx,
    sqrtNear,
    sqrtFar,
    liquidity,
    capacity: bracketCapacity(liquidity, sqrtNear, sqrtFar, feePpm),
    sqrtAdjNear: feeAdjust(sqrtNear, feePpm),
    sqrtAdjFar: feeAdjust(sqrtFar, feePpm),
  };
}

// ── Multi-hop route brackets ─────────────────────────────────

/**
 * Profile a route by quoting increasing input sizes and turning each increment
 * into a segment (capacity, marginal price). Routes are STATIC: their on-chain
 * allocation uses these precomputed capacities (composed two-curve paths are too
 * expensive to re-anchor live).
 */
async function buildRouteBrackets(
  route: DiscoveredMultiHopRoute,
  refIdx: number,
  amountIn: bigint,
  sauceRouterAddress: Hex,
  client: PublicClient,
): Promise<EcoBracket[]> {
  const { hop1Pool, hop2Pool, intermediateToken } = route;
  const limit1 = limitFor(hop1Pool.tokenIn, intermediateToken);
  const limit2 = limitFor(intermediateToken, hop2Pool.tokenOut);

  // Cumulative samples 1/N .. N/N of amountIn.
  const samples: { input: bigint; out: bigint }[] = [];
  for (let s = 1; s <= ROUTE_SAMPLES; s++) {
    const input = (amountIn * BigInt(s)) / BigInt(ROUTE_SAMPLES);
    const q1 = await quotePool(hop1Pool, input, limit1, sauceRouterAddress, client);
    if (q1.amountOut === 0n) break;
    const q2 = await quotePool(hop2Pool, q1.amountOut, limit2, sauceRouterAddress, client);
    if (q2.amountOut === 0n) break;
    samples.push({ input, out: q2.amountOut });
  }
  if (samples.length === 0) return [];

  const brackets: EcoBracket[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (const sm of samples) {
    const dIn = sm.input - prevIn;
    const dOut = sm.out - prevOut;
    if (dIn > 0n && dOut > 0n) {
      // marginal price (out/in) over this segment → sqrt-equivalent in Q96.
      // sqrtAdj = sqrt(dOut/dIn) * 2^96 = sqrt(dOut * 2^192 / dIn)
      const sqrtAdj = isqrt((dOut * Q192) / dIn);
      brackets.push({
        kind: EcoBracketKind.Route,
        refIdx,
        sqrtNear: sqrtAdj, // routes carry their marginal directly in *Adj fields
        sqrtFar: sqrtAdj,
        liquidity: 0n,
        capacity: dIn,
        sqrtAdjNear: sqrtAdj,
        sqrtAdjFar: sqrtAdj,
      });
    }
    prevIn = sm.input;
    prevOut = sm.out;
  }
  return brackets;
}

function limitFor(tokenA: Hex, tokenB: Hex): bigint {
  return tokenA.toLowerCase() < tokenB.toLowerCase() ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
}

// ── Main preparation ─────────────────────────────────────────

/** Tuning knobs for off-chain preparation (overridable per call; mainly for tests). */
export interface EcoSwapPrepareOpts {
  /**
   * Drop pools whose liquidity is below this many bps of TOTAL discovered
   * liquidity (default DEFAULT_MIN_REL_BPS = ECO_MIN_REL_BPS env or 100 = 1%).
   * Set 0 to keep every pool above the absolute floor (used by cross-version
   * split tests that intentionally mix shallow-but-distinct AMM versions).
   */
  minRelBps?: number;
}

export async function prepareEcoSwap(
  config: EcoSwapConfig,
  client: PublicClient,
  sauceRouterAddress: Hex,
  poolConfig: ChainPoolConfig = BASE_CHAIN_POOL_CONFIG,
  opts: EcoSwapPrepareOpts = {},
): Promise<EcoSwapPrepared> {
  const minRelBps = opts.minRelBps ?? DEFAULT_MIN_REL_BPS;
  const { tokenIn, tokenOut, amountIn } = config;
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();
  const zeroForOne = inLower < outLower;
  const priceLimit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

  // ── Discover direct pools ──
  const allDirect = await discoverPools(tokenIn, tokenOut, client, poolConfig);

  // Absolute floor + usable-type gate (V3/V4 concentrated, V2 constant-product).
  const candidates = allDirect.filter(
    (p) => p.liquidity >= MIN_LIQUIDITY && (isV3Candidate(p) || isV4Candidate(p) || isUsableV2(p)),
  );

  // RELATIVE-depth gate: drop pools below minRelBps of the COMBINED liquidity so
  // we swap against deep pools and don't waste gas on shallow ones (dust slices).
  const totalLiquidity = candidates.reduce((s, p) => s + p.liquidity, 0n);
  const relFloor = minRelBps > 0 ? (totalLiquidity * BigInt(minRelBps)) / 10_000n : 0n;
  const deepEnough = candidates.filter((p) => p.liquidity >= relFloor);
  const droppedShallow = candidates.filter((p) => p.liquidity < relFloor);

  // Keep the deepest pools only — bounds on-chain loop size and calldata.
  const usableDirect = deepEnough
    .slice()
    .sort((a, b) => (a.liquidity < b.liquidity ? 1 : a.liquidity > b.liquidity ? -1 : 0))
    .slice(0, MAX_DIRECT_POOLS);

  // No silent caps: surface what relative-depth dropped and any top-N truncation.
  if (droppedShallow.length > 0) {
    console.log(
      `  EcoSwap dropped ${droppedShallow.length} shallow pool(s) (< ${minRelBps}bps of Σliquidity): ` +
        droppedShallow.map((p) => `${p.source}/${p.fee}(L=${p.liquidity})`).join(", "),
    );
  }
  if (deepEnough.length > MAX_DIRECT_POOLS) {
    console.log(
      `  EcoSwap capped to deepest ${MAX_DIRECT_POOLS} of ${deepEnough.length} pools (ECO_MAX_POOLS)`,
    );
  }
  const v3Raw = usableDirect.filter(isV3Candidate);
  const v4Raw = usableDirect.filter(isV4Candidate);
  // Constant-product (Uniswap-V2-style) pools execute via the unified
  // swap(SwapParams) entry (poolType=UniV2); the on-chain solver re-anchors them
  // to live reserves. The engine's _swapV2 hardcodes the 0.3% fee, so every V2
  // pool's bracket math is pinned to feePpm=3000 below regardless of the
  // discovered fee tier (keeps the off-chain ladder consistent with execution).
  const v2Raw = usableDirect.filter(isUsableV2);

  // ── Discover multi-hop routes (best pool per leg) ──
  const routesRaw: DiscoveredMultiHopRoute[] = [];
  for (const baseToken of poolConfig.baseTokens) {
    const bl = baseToken.toLowerCase();
    if (bl === inLower || bl === outLower) continue;
    const [hop1, hop2] = await Promise.all([
      discoverPools(tokenIn, baseToken, client, poolConfig),
      discoverPools(baseToken, tokenOut, client, poolConfig),
    ]);
    if (hop1.length === 0 || hop2.length === 0) continue;
    const bestHop1 = hop1.reduce((a, b) => (a.liquidity > b.liquidity ? a : b));
    const bestHop2 = hop2.reduce((a, b) => (a.liquidity > b.liquidity ? a : b));
    routesRaw.push({ intermediateToken: baseToken, hop1Pool: bestHop1, hop2Pool: bestHop2 });
  }

  // ── Build pool descriptors + brackets ──
  const pools: EcoPool[] = [];
  const brackets: EcoBracket[] = [];

  // V3 (tick reads batched into one multicall)
  const v3Reads = await readV3Pools(v3Raw, zeroForOne, client);
  for (const r of v3Reads) {
    const refIdx = pools.length;
    pools.push({
      poolType: r.pool.poolType,
      address: r.pool.address,
      fee: r.pool.fee,
      tickSpacing: r.tickSpacing,
      hooks: ZERO_ADDRESS,
      feePpm: r.pool.fee,
      isV2: false,
      inIsToken0: zeroForOne, // V3 PoolKey orientation = token sort order
      stateView: ZERO_ADDRESS,
      poolId: ZERO_BYTES32,
      source: r.pool.source,
    });
    brackets.push(...buildV3Brackets(r, refIdx, zeroForOne));
  }

  // V4 (singleton; tick reads via StateView, batched into one multicall)
  const v4Reads = await readV4Pools(v4Raw, zeroForOne, client);
  for (const r of v4Reads) {
    const refIdx = pools.length;
    pools.push({
      poolType: r.pool.poolType,
      address: r.pool.address, // PoolManager singleton
      fee: r.pool.fee,
      tickSpacing: r.tickSpacing,
      hooks: r.pool.hooks ?? ZERO_ADDRESS,
      feePpm: r.pool.fee,
      isV2: false,
      inIsToken0: zeroForOne,
      stateView: r.pool.stateView as Hex,
      poolId: r.pool.poolId as Hex,
      source: r.pool.source,
    });
    brackets.push(...buildV3Brackets(r, refIdx, zeroForOne));
  }

  // V2 (need token0 to orient live reserves on-chain)
  if (v2Raw.length > 0) {
    const token0Results = await client.multicall({
      contracts: v2Raw.map((p) => ({ address: p.address, abi: v2PairAbi, functionName: "token0" as const })),
      allowFailure: true,
    });
    for (let i = 0; i < v2Raw.length; i++) {
      const t0 = token0Results[i];
      if (t0.status !== "success") continue;
      const inIsToken0 = (t0.result as string).toLowerCase() === inLower;
      const refIdx = pools.length;
      pools.push({
        poolType: v2Raw[i].poolType,
        address: v2Raw[i].address,
        fee: V2_FEE_PPM, // engine _swapV2 uses 0.3% regardless of discovered tier
        tickSpacing: 0,
        hooks: ZERO_ADDRESS,
        feePpm: V2_FEE_PPM,
        isV2: true,
        inIsToken0,
        stateView: ZERO_ADDRESS,
        poolId: ZERO_BYTES32,
        source: v2Raw[i].source,
      });
      brackets.push(...buildV2Brackets(v2Raw[i], refIdx, V2_FEE_PPM));
    }
  }

  // Routes (sampled). Keep the deepest few.
  const routes: EcoRoute[] = [];
  const routeBracketSets: EcoBracket[][] = [];
  for (const r of routesRaw) {
    if (routes.length >= MAX_ROUTES) break;
    const refIdx = routes.length;
    const rb = await buildRouteBrackets(r, refIdx, amountIn, sauceRouterAddress, client);
    if (rb.length === 0) continue;
    routes.push({ route: r });
    routeBracketSets.push(rb);
  }
  for (const set of routeBracketSets) brackets.push(...set);

  if (brackets.length === 0) {
    throw new Error(`No usable pools/brackets for ${tokenIn} -> ${tokenOut}`);
  }

  // ── Sort the global ladder DESC by fee-adjusted near price ──
  brackets.sort((a, b) => (a.sqrtAdjNear < b.sqrtAdjNear ? 1 : a.sqrtAdjNear > b.sqrtAdjNear ? -1 : 0));

  // ── Off-chain water-fill pre-run → trim to crossed ticks + safety ──
  // Walk the sorted ladder accumulating capacity until amountIn is covered. Every
  // bracket up to that cut is a tick the trade crosses; keep them all, then keep
  // SAFETY_TICKS extra brackets per crossing pool/route for live-price drift.
  let covered = 0n;
  let cutIdx = brackets.length - 1;
  for (let i = 0; i < brackets.length; i++) {
    covered += brackets[i].capacity;
    if (covered >= amountIn) {
      cutIdx = i;
      break;
    }
  }

  const refKey = (b: EcoBracket) => `${b.kind}:${b.refIdx}`;
  const crossed = new Set<string>();
  for (let i = 0; i <= cutIdx; i++) crossed.add(refKey(brackets[i]));

  const extra = new Map<string, number>();
  const kept: EcoBracket[] = [];
  for (let i = 0; i < brackets.length; i++) {
    if (i <= cutIdx) {
      kept.push(brackets[i]);
      continue;
    }
    const k = refKey(brackets[i]);
    if (!crossed.has(k)) continue; // don't extend pools the trade never reaches
    const n = extra.get(k) ?? 0;
    if (n < SAFETY_TICKS) {
      kept.push(brackets[i]);
      extra.set(k, n + 1);
    }
  }

  const trimmed =
    kept.length >= MIN_BRACKETS ? kept : brackets.slice(0, Math.min(brackets.length, MIN_BRACKETS));

  const nV4 = pools.filter((p) => p.poolType === SwapPoolType.UniV4).length;
  const nV3 = pools.filter((p) => p.poolType === SwapPoolType.UniV3).length;
  const nV2 = pools.filter((p) => p.isV2).length;
  console.log(
    `  EcoSwap prepared: ${nV3} V3, ${nV4} V4, ${nV2} V2, ${routes.length} routes, ` +
      `${trimmed.length}/${brackets.length} brackets kept (crossed+${SAFETY_TICKS}), ` +
      `coverage=${covered >= amountIn ? "full" : "partial"}`,
  );

  return {
    pools,
    routes,
    brackets: trimmed,
    zeroForOne,
    priceLimit,
    expectedInputCovered: covered,
  };
}
