/**
 * EcoSwap off-chain preparation.
 *
 * Reconstructs each pool's liquidity curve as per-tick "brackets" in a unified
 * out/in sqrt-price space, then builds a single global ladder sorted by
 * fee-adjusted marginal price. The on-chain solver walks that ladder once to
 * find the common marginal-price cut and executes one swap per pool.
 *
 * Pipeline:
 *   1. Discover + read ALL direct pools via the on-chain LENS (ecoswap.lens.sauce.ts)
 *      in ONE read-only eth_call cook(): factory getPool/getPair discovery, live
 *      slot0/getReserves/StateView reads, and a windowed ticks()/getTickLiquidity
 *      scan — returned as raw words (see lens.ts). v1 covers V2Standard, V3Standard
 *      and hookless UniswapV4 only.
 *   2. Apply the absolute + relative-depth liquidity filter and the top-N cap.
 *   3. Build brackets from the lens reads: V3/V4 from active L + liquidityNet
 *      (buildV3Brackets); V2 as one wide bracket discretised into geometric steps
 *      (a V2 pool == a single V3 range with L = sqrt(k)).
 *   4. Routes: one lens eth_call per hop pair, then compose the two hops OFF-CHAIN
 *      via localQuote (no on-chain quote()) into route segments.
 *   5. Fee-adjust, compute per-bracket gross input capacity, sort + trim the ladder.
 *
 * RPC efficiency: the entire direct-pool discovery + state + tick read is ONE
 * eth_call (the lens); multi-hop routes add one eth_call per hop pair.
 */

import type { PublicClient, Hex } from "viem";
import { runLens, type LensPool } from "./lens";
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
 * Fetched generously by the lens in one eth_call; the ladder is then TRIMMED to the ticks
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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

// ── Math helpers ─────────────────────────────────────────────

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

/**
 * Adapt a lens-decoded V3/V4 pool into the V3Read shape `buildV3Brackets`
 * consumes. The lens already returned slot0 (sqrtPriceX96 + EXACT current tick),
 * active liquidity, and a windowed liquidityNet map keyed by signed tick — so no
 * RPC, and the bracket boundaries (base = floor(tick/ts)*ts, stepping ±ts) line
 * up exactly with the ticks the lens scanned.
 */
function lensToV3Read(p: LensPool): V3Read {
  return {
    pool: {
      address: p.address,
      tokenIn: "0x" as Hex,
      tokenOut: "0x" as Hex,
      fee: p.fee,
      poolType: p.poolType,
      priceLimited: true,
      sqrtPriceX96: p.sqrtPriceX96,
      liquidity: p.liquidity,
      source: "lens",
    },
    tick: p.tick,
    tickSpacing: p.tickSpacing,
    activeLiquidity: p.liquidity,
    net: p.net,
  };
}

/** Standard Uniswap-V3 fee → tickSpacing mapping (covers the discovered V3 forks). */
const TICK_SPACING_BY_FEE: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };
function feeToTickSpacing(fee: number): number {
  return TICK_SPACING_BY_FEE[fee] ?? 60;
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

/** Build a single lens-pool's out/in brackets (V2 or V3/V4) for route quoting. */
function lensPoolBrackets(p: LensPool, zeroForOne: boolean, refIdx: number): EcoBracket[] {
  if (p.poolType === SwapPoolType.UniV2) {
    return buildV2Brackets(
      { sqrtPriceX96: p.sqrtPriceX96, liquidity: p.liquidity } as PoolInfo,
      refIdx,
      V2_FEE_PPM,
    );
  }
  return buildV3Brackets(lensToV3Read(p), refIdx, zeroForOne);
}

/** Adapt a LensPool to a minimal PoolInfo for the route descriptor (tokens set). */
function lensPoolToInfo(p: LensPool, tokenIn: Hex, tokenOut: Hex): PoolInfo {
  return {
    address: p.address,
    tokenIn,
    tokenOut,
    fee: p.poolType === SwapPoolType.UniV2 ? V2_FEE_PPM : p.fee,
    poolType: p.poolType,
    priceLimited: p.poolType !== SwapPoolType.UniV2,
    sqrtPriceX96: p.sqrtPriceX96,
    liquidity: p.liquidity,
    source: "lens",
    poolId: p.poolId,
    stateView: p.stateView,
    tickSpacing: p.tickSpacing,
    hooks: p.hooks,
  };
}

/**
 * Walk a single pool's out/in bracket curve consuming `amountIn` (gross tokenIn),
 * returning the tokenOut produced. Off-chain replacement for the on-chain quote()
 * RPC. Each bracket is [sqrtNear, sqrtFar] of constant L in unified out/in space;
 *   maxEffIn(bracket) = L*2^96*(1/sqrtFar - 1/sqrtNear), grossIn = effIn/(1-fee).
 * For a partial fill, solve the spot where the consumed effIn matches the budget.
 * tokenOut over a bracket from spot sNear→sLow: dOut = L*(sNear - sLow)/2^96.
 */
function localQuote(brackets: EcoBracket[], amountIn: bigint, feePpm: number): bigint {
  let budget = amountIn;
  let out = 0n;
  const oneMinusFee = BigInt(1_000_000 - feePpm);
  for (const b of brackets) {
    if (budget <= 0n) break;
    const L = b.liquidity;
    const near = b.sqrtNear;
    const far = b.sqrtFar;
    if (L <= 0n || far <= 0n || near <= far) continue;
    const grossCap = b.capacity; // gross tokenIn to traverse the whole bracket
    if (grossCap <= 0n) continue;
    if (budget >= grossCap) {
      // full bracket
      out += (L * (near - far)) / Q96;
      budget -= grossCap;
    } else {
      // partial: effIn = budget*(1-fee); solve sLow from
      //   effIn = L*2^96*(1/far' - 1/near) where far' is the partial far edge.
      const effIn = (budget * oneMinusFee) / FEE_DENOM;
      const invNear = (L * Q96) / near;
      const invLow = invNear + effIn;
      const sLow = invLow > 0n ? (L * Q96) / invLow : far;
      const clampedLow = sLow < far ? far : sLow;
      out += (L * (near - clampedLow)) / Q96;
      budget = 0n;
    }
  }
  return out;
}

/**
 * Build route segments by composing the two hops via localQuote (NO on-chain
 * quote()). Profiles cumulative input samples through hop1→hop2 and turns each
 * increment into a (capacity, marginal-sqrt) segment, mirroring the prior
 * sampled-quote shape so the on-chain solver's route handling is unchanged.
 */
function buildRouteBracketsLocal(
  hop1Brackets: EcoBracket[],
  hop2Brackets: EcoBracket[],
  refIdx: number,
  amountIn: bigint,
): EcoBracket[] {
  const hop1Fee = hop1Brackets.length > 0 ? feePpmOf(hop1Brackets[0]) : V2_FEE_PPM;
  const hop2Fee = hop2Brackets.length > 0 ? feePpmOf(hop2Brackets[0]) : V2_FEE_PPM;

  const samples: { input: bigint; out: bigint }[] = [];
  for (let s = 1; s <= ROUTE_SAMPLES; s++) {
    const input = (amountIn * BigInt(s)) / BigInt(ROUTE_SAMPLES);
    const mid = localQuote(hop1Brackets, input, hop1Fee);
    if (mid === 0n) break;
    const finalOut = localQuote(hop2Brackets, mid, hop2Fee);
    if (finalOut === 0n) break;
    samples.push({ input, out: finalOut });
  }
  if (samples.length === 0) return [];

  const brackets: EcoBracket[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (const sm of samples) {
    const dIn = sm.input - prevIn;
    const dOut = sm.out - prevOut;
    if (dIn > 0n && dOut > 0n) {
      const sqrtAdj = isqrt((dOut * Q192) / dIn);
      brackets.push({
        kind: EcoBracketKind.Route,
        refIdx,
        sqrtNear: sqrtAdj,
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

/** Recover a bracket's fee from its spot vs fee-adjusted sqrt (near edge). */
function feePpmOf(b: EcoBracket): number {
  // sqrtAdjNear = sqrtNear * sqrt(1-fee); recovering fee exactly is unnecessary —
  // the bracket capacities already embed the fee, so localQuote's partial-fill
  // fee term is a 2nd-order correction. Default to V2 fee if indeterminate.
  if (b.sqrtNear === b.sqrtAdjNear) return 0;
  return V2_FEE_PPM;
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

  // ── Discover + read direct pools via the on-chain LENS (ONE eth_call) ──
  // Replaces ~all direct-pool discovery/state/tick/token0 RPCs: the lens runs
  // discovery + slot0/getReserves/StateView + a windowed tick scan inside ONE
  // read-only cook() eth_call and returns raw reads, decoded into LensPool[].
  const lensResult = await runLens(client, sauceRouterAddress, poolConfig, {
    tokenIn,
    tokenOut,
    zeroForOne,
    tickSteps: V3_TICK_STEPS,
  });
  const allDirect = lensResult.pools;

  // Absolute floor + usable-type gate. The lens only discovers V2Standard (no
  // Solidly stable), V3Standard and hookless UniswapV4 — so every returned pool
  // is already a usable type; we just apply the liquidity floor.
  const candidates = allDirect.filter((p) => p.liquidity >= MIN_LIQUIDITY);

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
        droppedShallow.map((p) => `${SwapPoolType[p.poolType]}/${p.fee}(L=${p.liquidity})`).join(", "),
    );
  }
  if (deepEnough.length > MAX_DIRECT_POOLS) {
    console.log(
      `  EcoSwap capped to deepest ${MAX_DIRECT_POOLS} of ${deepEnough.length} pools (ECO_MAX_POOLS)`,
    );
  }
  const v3Raw = usableDirect.filter((p) => p.poolType === SwapPoolType.UniV3);
  const v4Raw = usableDirect.filter((p) => p.poolType === SwapPoolType.UniV4);
  // Constant-product (Uniswap-V2-style) pools execute via the unified
  // swap(SwapParams) entry (poolType=UniV2); the on-chain solver re-anchors them
  // to live reserves. The engine's _swapV2 hardcodes the 0.3% fee.
  const v2Raw = usableDirect.filter((p) => p.poolType === SwapPoolType.UniV2);

  // ── Discover multi-hop routes (best pool per leg) — via the LENS ──
  // Each hop pair gets its OWN lens eth_call (one pool pair is one cook()); the
  // deepest pool per hop is reconstructed into brackets, and route segments are
  // composed OFF-CHAIN via localQuote (no on-chain quote() RPC). Direct prepare is
  // still ONE eth_call; routes add one eth_call per (in→base) and (base→out) pair.
  interface RouteLens {
    intermediateToken: Hex;
    hop1Pool: PoolInfo;
    hop2Pool: PoolInfo;
    hop1Brackets: EcoBracket[];
    hop2Brackets: EcoBracket[];
  }
  const routesRaw: RouteLens[] = [];
  for (const baseToken of poolConfig.baseTokens) {
    const bl = baseToken.toLowerCase();
    if (bl === inLower || bl === outLower) continue;
    const z1 = inLower < bl;
    const z2 = bl < outLower;
    const [hop1, hop2] = await Promise.all([
      runLens(client, sauceRouterAddress, poolConfig, {
        tokenIn, tokenOut: baseToken, zeroForOne: z1, tickSteps: V3_TICK_STEPS,
      }),
      runLens(client, sauceRouterAddress, poolConfig, {
        tokenIn: baseToken, tokenOut, zeroForOne: z2, tickSteps: V3_TICK_STEPS,
      }),
    ]);
    if (hop1.pools.length === 0 || hop2.pools.length === 0) continue;
    const best1 = hop1.pools.reduce((a, b) => (a.liquidity > b.liquidity ? a : b));
    const best2 = hop2.pools.reduce((a, b) => (a.liquidity > b.liquidity ? a : b));
    const hop1Brackets = lensPoolBrackets(best1, z1, 0);
    const hop2Brackets = lensPoolBrackets(best2, z2, 0);
    if (hop1Brackets.length === 0 || hop2Brackets.length === 0) continue;
    routesRaw.push({
      intermediateToken: baseToken,
      hop1Pool: lensPoolToInfo(best1, tokenIn, baseToken),
      hop2Pool: lensPoolToInfo(best2, baseToken, tokenOut),
      hop1Brackets,
      hop2Brackets,
    });
  }

  // ── Build pool descriptors + brackets ──
  const pools: EcoPool[] = [];
  const brackets: EcoBracket[] = [];

  // V3 (lens already returned slot0 + windowed ticks() per pool)
  for (const p of v3Raw) {
    const refIdx = pools.length;
    pools.push({
      poolType: p.poolType,
      address: p.address,
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      hooks: ZERO_ADDRESS,
      feePpm: p.fee,
      isV2: false,
      inIsToken0: zeroForOne, // V3 PoolKey orientation = token sort order
      stateView: ZERO_ADDRESS,
      poolId: ZERO_BYTES32,
      source: "lens V3",
    });
    brackets.push(...buildV3Brackets(lensToV3Read(p), refIdx, zeroForOne));
  }

  // V4 (singleton; lens read StateView slot0 + windowed getTickLiquidity)
  for (const p of v4Raw) {
    const refIdx = pools.length;
    pools.push({
      poolType: p.poolType,
      address: p.address, // PoolManager singleton
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      hooks: p.hooks ?? ZERO_ADDRESS,
      feePpm: p.fee,
      isV2: false,
      inIsToken0: zeroForOne,
      stateView: p.stateView,
      poolId: p.poolId,
      source: "lens V4",
    });
    brackets.push(...buildV3Brackets(lensToV3Read(p), refIdx, zeroForOne));
  }

  // V2 (lens returned synthetic out/in sqrt + synthetic L + inIsToken0)
  for (const p of v2Raw) {
    const refIdx = pools.length;
    pools.push({
      poolType: p.poolType,
      address: p.address,
      fee: V2_FEE_PPM, // engine _swapV2 uses 0.3% regardless of discovered tier
      tickSpacing: 0,
      hooks: ZERO_ADDRESS,
      feePpm: V2_FEE_PPM,
      isV2: true,
      inIsToken0: p.inIsToken0,
      stateView: ZERO_ADDRESS,
      poolId: ZERO_BYTES32,
      source: "lens V2",
    });
    brackets.push(
      ...buildV2Brackets(
        { sqrtPriceX96: p.sqrtPriceX96, liquidity: p.liquidity } as PoolInfo,
        refIdx,
        V2_FEE_PPM,
      ),
    );
  }

  // Routes (sampled). Keep the deepest few. Segments composed via localQuote.
  const routes: EcoRoute[] = [];
  const routeBracketSets: EcoBracket[][] = [];
  for (const r of routesRaw) {
    if (routes.length >= MAX_ROUTES) break;
    const refIdx = routes.length;
    const rb = buildRouteBracketsLocal(r.hop1Brackets, r.hop2Brackets, refIdx, amountIn);
    if (rb.length === 0) continue;
    routes.push({ route: { intermediateToken: r.intermediateToken, hop1Pool: r.hop1Pool, hop2Pool: r.hop2Pool } });
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
