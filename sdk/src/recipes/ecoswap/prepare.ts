/**
 * EcoSwap off-chain preparation.
 *
 * Builds the per-pool NET CACHE (the drift-invariant tick depth the on-chain unified
 * walk reuses) and the static route segments. Direct pools ship NO prepare-time sqrt
 * edges: the on-chain solver walks each pool's single frontier from its LIVE spot and
 * computes all sqrt/price on the live grid, consulting the cache only for the net at
 * each scanned boundary (a staticcall avoided). The cache is a pure gas optimization.
 *
 * Pipeline:
 *   1. Discover + read ALL direct pools via the on-chain LENS (ecoswap.lens.sauce.ts)
 *      in ONE read-only eth_call cook(): factory getPool/getPair discovery, live
 *      slot0/getReserves/StateView reads, and a windowed ticks()/getTickLiquidity
 *      scan — returned as raw words (see lens.ts). v1 covers V2Standard, V3Standard
 *      and hookless UniswapV4 only. The lens is the SINGLE SOURCE OF TRUTH for
 *      survivorship: it measures each pool's IN-RANGE capacity across the crossed
 *      ticks (not spot active-L), applies the relative-depth filter on-chain, and
 *      returns ONLY survivors (no absolute floor) — prepare never re-filters.
 *   2. Apply the top-N (deepest) cap — a calldata/loop bound, not a liquidity gate.
 *   3. Stamp each V3/V4 survivor's per-pool net cache from the lens reads
 *      (stampPoolCache): the stepRatio, the scanned-window bounds, the deepest
 *      initialized tick, and one [shiftedTick, rawNet] row per initialized tick.
 *      V2 needs no tick cache (the solver streams constant-L from live reserves).
 *   4. Routes: one lens eth_call per hop pair, then compose the two hops OFF-CHAIN
 *      via localQuote (no on-chain quote()) into route segments (still bracket-based,
 *      since routes are static — composed and sorted off-chain).
 *
 * RPC efficiency: the entire direct-pool discovery + state + tick read is ONE
 * eth_call (the lens); multi-hop routes add one eth_call per hop pair.
 */

import type { PublicClient, Hex } from "viem";
import { runLens, type LensPool } from "./lens.js";
import {
  discoverKyberClassicPools,
  discoverCurvePoolsTyped,
  discoverTraderJoeLBPoolsTyped,
  discoverDodoV2PoolsTyped,
} from "../shared/pool-discovery.js";
import { buildCurveSegments, type CurvePool } from "../shared/curve-math.js";
import { buildLbSegments, lbFeeToPpm, type LbPool } from "../shared/lb-math.js";
import { buildDodoSegments, type DodoPool } from "../shared/dodo-math.js";
import {
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  SwapPoolType,
  FactoryType,
  BASE_CHAIN_POOL_CONFIG,
  kyberFeeToPpm,
  type ChainPoolConfig,
} from "../shared/constants.js";
import {
  EcoBracketKind,
  type EcoSwapConfig,
  type EcoSwapPrepared,
  type EcoBracket,
  type EcoPool,
  type EcoRoute,
  type EcoCurve,
  type EcoLb,
  type EcoDodo,
  type PoolInfo,
} from "../shared/types.js";

// ── Tunables ─────────────────────────────────────────────────

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const FEE_DENOM = 1_000_000n; // ppm
/**
 * Tick shift used to carry signed ticks as non-negative "shifted" values throughout the
 * per-pool net cache (matches the lens OFFSET = 888000; multiple of LCM(3000) and >
 * max|tick| 887272 so shifted stays ≥0). The universal shift applied to every shifted
 * scalar prepare ships — windowTop/windowBot/extreme + the per-tick netRows.
 */
const OFFSET_TICK = 888000;

/**
 * RELATIVE-depth floor (bps of TOTAL IN-RANGE capacity across crossed ticks) — the
 * SOLE liquidity gate (no absolute floor). A pool's in-range capacity is the gross
 * tokenIn it can absorb walking from spot to the trade's price floor (NOT its spot
 * active-L): this is comparable across V2 (≡ a V3 range with L=√k), V3 and V4, and
 * — unlike spot-L — does not reward a narrow band of huge liquidity concentrated
 * right at spot that the trade immediately walks out of. A pool below this fraction
 * of the combined in-range depth would only ever get a dust slice — not worth a
 * swap's gas. The on-chain LENS measures this capacity and applies the filter; it is
 * the single source of truth for survivorship (prepare never re-filters). Default
 * 100 bps (1%); override with ECO_MIN_REL_BPS, or per-call via prepareEcoSwap opts.
 * 0 disables.
 */
const DEFAULT_MIN_REL_BPS = Number(process.env.ECO_MIN_REL_BPS ?? 100);
/**
 * Tick boundaries the lens scans per V3 pool in the swap direction (the cache window).
 * Scanned in one eth_call; the on-chain solver walks each pool's frontier from the LIVE
 * spot and reuses the drift-invariant net for boundaries inside this window, staticcalling
 * any boundary past it — so this only bounds how much net the cache ships, not how far the
 * walk reaches. Must be wide enough to cover the cut for the largest expected trade.
 */
const V3_TICK_STEPS = 96;
/** Geometric brackets emitted per V2 pool (also trimmed to exactly the crossed range). */
const V2_BRACKETS = 16;
/** Cap on direct pools (top-N by liquidity) — bounds on-chain loop + calldata. */
const MAX_DIRECT_POOLS = Number(process.env.ECO_MAX_POOLS ?? 12);
/**
 * Forward drift buffer (extra lens tick boundaries) for ROUTE hops ONLY. Direct pools use
 * 0 (the on-chain solver walks each pool's frontier from the LIVE spot, reading drift live),
 * but routes compose off-chain via localQuote and execute in one flat swapV3 per hop with no
 * live walk, so their prepared bracket curve must extend slightly past the sampled amountIn.
 */
const ROUTE_DRIFT_TICKS = 2;
/** Per-bracket price step for V2 discretisation (~0.5% per bracket in sqrt). */
const V2_SQRT_STEP_BPS = 25n; // 0.25% of sqrt → ~0.5% price per bracket
/** Input samples used to profile each multi-hop route. */
const ROUTE_SAMPLES = 6;
/** Keep at most this many routes (bytecode/gas bound). */
const MAX_ROUTES = Number(process.env.ECO_MAX_ROUTES ?? 2);
/**
 * Fallback constant-product fee (ppm) for a route-leg V2 pool whose lens row predates
 * the per-pool fee field (always set today). Direct V2 pools carry the REAL lens-reported
 * fee through to the oracle / reference / on-chain stream; the engine's hardcoded-0.30%
 * _swapV2 is bypassed (callback-free path) for any pool whose fee != this default.
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

/**
 * Next REAL sqrt one tickSpacing step in the swap direction (MULTIPLICATIVE) — the
 * exact mirror of the on-chain solver/lens `stepReal` and the oracle's `stepReal`:
 *   zeroForOne (price down): sqrt' = mulDiv(sqrt, 2^96, stepRatio)
 *   oneForZero (price up):   sqrt' = mulDiv(sqrt, stepRatio, 2^96)
 * (stepRatio = getSqrtRatioAtTick(tickSpacing).) Used to build the prepared V3/V4
 * bracket far edges so the prepared geometry == the live-walk/oracle geometry.
 */
function stepRealTs(sqrtReal: bigint, stepRatio: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? (sqrtReal * Q96) / stepRatio : (sqrtReal * stepRatio) / Q96;
}

// ── V3 bracket construction ──────────────────────────────────

interface V3Read {
  pool: PoolInfo;
  tick: number;
  tickSpacing: number;
  activeLiquidity: bigint;
  /** liquidityNet keyed by tick index, for the scanned window. */
  net: Map<number, bigint>;
  /**
   * Forward tick boundaries the LAZY lens actually walked. buildV3Brackets STOPS
   * here so it never fabricates phantom brackets past the lens's scanned data
   * (which would assume L unchanged where the lens never read). 0 → no brackets.
   */
  scannedForward: number;
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
    scannedForward: p.scannedForward,
  };
}

/** Standard Uniswap-V3 fee → tickSpacing mapping (covers the discovered V3 forks). */
const TICK_SPACING_BY_FEE: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };
function feeToTickSpacing(fee: number): number {
  return TICK_SPACING_BY_FEE[fee] ?? 60;
}

/**
 * Build out/in brackets for one V3 pool from its tick window, in the swap direction:
 * the first bracket's near edge is the current price; each subsequent edge is an
 * initialized-tick boundary. Crossing a boundary updates active liquidity by
 * ±liquidityNet (− when the price moves down for zeroForOne, + when it moves up for
 * oneForZero). The walk STOPS at the lens's scannedForward count so it never
 * fabricates brackets past the data the lens actually read.
 *
 * Used ONLY for ROUTE legs (direct pools carry a per-pool net cache built by
 * stampPoolCache and are walked LIVE on-chain — they ship no prepare-time sqrt edges).
 * Routes are composed off-chain via localQuote, so a route leg's liquidity curve must
 * be materialized as brackets for the local two-hop composition.
 */
function buildV3Brackets(
  r: V3Read,
  refIdx: number,
  zeroForOne: boolean,
): EcoBracket[] {
  const brackets: EcoBracket[] = [];
  const feePpm = r.pool.fee;
  const ts = r.tickSpacing;
  const base = Math.floor(r.tick / ts) * ts;
  const spotReal = r.pool.sqrtPriceX96;

  // Forward brackets (swap direction). Step nearReal MULTIPLICATIVELY via stepReal so the route
  // leg's geometry matches the live-walk/oracle geometry. STOP at the lens's scanned boundary.
  const stepRatio = getSqrtRatioAtTick(ts);
  let L = r.activeLiquidity;
  let nearReal = spotReal;
  let b = zeroForOne ? base : base + ts;
  const step = zeroForOne ? -ts : ts;
  for (let k = 0; k < r.scannedForward; k++) {
    const farReal = stepRealTs(nearReal, stepRatio, zeroForOne);
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

// ── Unified-walk per-pool net cache (replaces the direct-pool bracket build) ──

const MOD128 = 1n << 128n;

/**
 * Stamp a V3/V4 EcoPool with the unified-walk per-pool cache from its lens read. The on-chain
 * solver walks each pool's live frontier from the LIVE spot and reuses the drift-invariant NET
 * for the scanned window (an in-window staticcall avoided); it computes ALL sqrt/price on the
 * live grid. So prepare ships only the NET — never a prepare-time sqrt edge:
 *   - stepRatio        = getSqrtRatioAtTick(ts) (the multiplicative one-ts step).
 *   - windowTopShifted = the shallowest scanned boundary (shifted): the swap-direction first
 *                        boundary (zeroForOne base; oneForZero base+ts). 0 ⇒ no scan.
 *   - windowBotShifted = the deepest scanned boundary = windowTop ∓ scannedForward*ts.
 *   - extremeShifted   = the deepest INITIALIZED tick (shifted) in the swap direction, or 0.
 *   - spotTickShifted / spotNearReal / spotActiveL = the prepare-time spot seed (the no-drift
 *                        walk start; the on-chain solver reads the LIVE spot instead).
 *   - netRows          = [shiftedTick, rawNet] for every initialized tick (net != 0), sorted
 *                        SWAP DIRECTION; rawNet = signed >= 0 ? signed : signed + 2^128 (the
 *                        raw uint128 ticks() returns). index.ts flattens these into netCache.
 *   - adaptiveNet      = the full SIGNED net map (off-chain only — the reference/oracle mirror).
 */
function stampPoolCache(r: V3Read, zeroForOne: boolean, seed: EcoPool): void {
  const ts = r.tickSpacing;
  const base = Math.floor(r.tick / ts) * ts;
  const spotBoundary = zeroForOne ? base : base + ts; // shallowest scanned boundary (signed)
  const step = zeroForOne ? -ts : ts;
  const scanned = r.scannedForward;

  seed.stepRatio = getSqrtRatioAtTick(ts);
  seed.spotNearReal = r.pool.sqrtPriceX96;
  seed.spotActiveL = r.activeLiquidity;
  seed.spotTickShifted = BigInt(spotBoundary + OFFSET_TICK);
  seed.adaptiveNet = r.net;

  if (scanned > 0) {
    seed.windowTopShifted = BigInt(spotBoundary + OFFSET_TICK);
    seed.windowBotShifted = BigInt(spotBoundary + step * (scanned - 1) + OFFSET_TICK);
  } else {
    // No scan (the no-cache / 1-RPC quote path) — the walk staticcalls every boundary live.
    seed.windowTopShifted = 0n;
    seed.windowBotShifted = 0n;
  }

  // Net rows: only INITIALIZED ticks (net != 0), shifted + RAW uint128, sorted swap-direction.
  const rows: { shiftedTick: bigint; rawNet: bigint }[] = [];
  for (const [tick, signed] of r.net) {
    if (signed === 0n) continue;
    const raw = signed >= 0n ? signed : signed + MOD128;
    rows.push({ shiftedTick: BigInt(tick + OFFSET_TICK), rawNet: raw });
  }
  // swap direction: zeroForOne walks DOWN (ticks descending); oneForZero UP (ascending).
  rows.sort((a, b) =>
    zeroForOne
      ? a.shiftedTick < b.shiftedTick ? 1 : a.shiftedTick > b.shiftedTick ? -1 : 0
      : a.shiftedTick < b.shiftedTick ? -1 : a.shiftedTick > b.shiftedTick ? 1 : 0,
  );

  // Documenting precondition (no-op on producible data; catches a future contract change):
  // under driftTicks:0 the lens emits rows ONLY on the forward/deep side of windowTop, so every
  // emitted netRow MUST lie within the cache window [min(wTop,wBot), max(wTop,wBot)]. The on-chain
  // solver's cursor advances through these rows in swap-direction assuming exactly that — a row
  // outside the window would be unreachable (the order-agnostic in-window test would skip it) and
  // silently corrupt the cursor alignment. Enforce it here so a lens change that emits an
  // out-of-window row fails loudly at prepare rather than mis-filling on-chain.
  if (scanned > 0) {
    const wTop = seed.windowTopShifted!;
    const wBot = seed.windowBotShifted!;
    const wLo = wTop <= wBot ? wTop : wBot;
    const wHi = wTop <= wBot ? wBot : wTop;
    for (const row of rows) {
      if (row.shiftedTick < wLo || row.shiftedTick > wHi) {
        throw new Error(
          `EcoSwap stampPoolCache: net row shiftedTick ${row.shiftedTick} outside cache window ` +
            `[${wLo}, ${wHi}] (windowTop=${wTop}, windowBot=${wBot}) — cursor precondition violated`,
        );
      }
    }
  }
  seed.netRows = rows;

  // extremeShifted = the deepest INITIALIZED tick (shifted) in the swap direction.
  const initTicks = [...r.net.entries()].filter(([, n]) => n !== 0n).map(([t]) => t);
  if (initTicks.length === 0) {
    seed.extremeShifted = 0n;
  } else {
    const extremeTick = zeroForOne ? Math.min(...initTicks) : Math.max(...initTicks);
    seed.extremeShifted = BigInt(extremeTick + OFFSET_TICK);
  }
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
      p.fee || V2_FEE_PPM,
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
    fee: p.poolType === SwapPoolType.UniV2 ? p.fee || V2_FEE_PPM : p.fee,
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
  hop1Fee: number,
  hop2Fee: number,
): EcoBracket[] {
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

/**
 * Build Curve StableSwap segments for one pool by sampling the bigint replay (NO extra RPC —
 * pure bigint on the read pool state). Each sampled (Δinput, Δoutput) increment becomes a
 * STATIC segment (kind Curve) in unified out/in space, refIdx → the curve venue index. The
 * marginal is the POST-FEE execution price (get_dy already nets the fee), so it enters the
 * descending-price merge directly as both sqrtAdjNear and sqrtAdjFar (a flat segment, like a
 * route segment). Mirrors `buildRouteBracketsLocal` — the on-chain solver's static-segment
 * handling is unchanged.
 *
 * Exact-on-grid: the split equalizes marginals on this sampled grid; the per-pool dy for the
 * awarded Σ share is re-evaluated wei-exact by ONE atomic exchange() at execution time.
 */
function buildCurveBrackets(pool: CurvePool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildCurveSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.Curve,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the Curve fee (post-fee dy)
      sqrtAdjFar: sm.marginalOI,
    });
  }
  return brackets;
}

/** Round a Curve 1e10-scaled fee to ppm (the price-ordering coordinate / diagnostics). */
function curveFeeToPpm(feePpm10: bigint): number {
  return Number((feePpm10 * 1_000_000n + 5_000_000_000n) / 10_000_000_000n);
}

/**
 * Build Trader Joe LB segments for one pair by EXACT per-bin enumeration (NO sampling — LB is a
 * discrete-bin constant-sum AMM, so each bin is ONE flat segment at its fixed price). Each bin
 * becomes a STATIC segment (kind LB) in unified out/in space, refIdx → the LB venue index. The
 * marginal is the POST-FEE bin price (buildLbSegments nets the base fee), so it enters the
 * descending-price merge directly as both sqrtAdjNear and sqrtAdjFar (a flat segment, like a
 * Curve / route segment). Mirrors `buildCurveBrackets` — the on-chain solver's static-segment
 * handling is unchanged; the difference is LB segments are EXACT (no grid error), so the split
 * is wei-exact vs the oracle (not merely exact-on-grid).
 */
function buildLbBrackets(pool: LbPool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildLbSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.LB,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the LB base fee (post-fee out/in)
      sqrtAdjFar: sm.marginalOI,
    });
  }
  return brackets;
}

/**
 * Build DODO V2 PMM segments for one pool by sampling the closed-form replay (NO extra RPC — pure
 * bigint querySell* on the read PMM state). Each sampled (Δinput, Δoutput) increment becomes a
 * STATIC segment (kind DODO) in unified out/in space, refIdx → the DODO venue index. The marginal
 * is the POST-FEE execution price (buildDodoSegments nets the LP+MT fee), so it enters the
 * descending-price merge directly as both sqrtAdjNear and sqrtAdjFar (a flat segment, like a
 * Curve / LB / route segment). Mirrors `buildCurveBrackets` — the on-chain solver's static-segment
 * handling is unchanged; DODO's curve math is OFF-CHAIN ONLY (the on-chain solver does NOT recompute
 * the PMM integral).
 *
 * Exact-on-grid: the split equalizes marginals on this sampled grid; the per-pool dy for the awarded
 * Σ share is re-evaluated wei-exact by ONE atomic querySell*() at execution time (the engine
 * `_swapDODOV2`).
 */
function buildDodoBrackets(pool: DodoPool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildDodoSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.DODO,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the DODO LP+MT fee (post-fee dy)
      sqrtAdjFar: sm.marginalOI,
    });
  }
  return brackets;
}

// ── Main preparation ─────────────────────────────────────────

/** Tuning knobs for off-chain preparation (overridable per call; mainly for tests). */
export interface EcoSwapPrepareOpts {
  /**
   * Drop pools whose IN-RANGE (windowed) capacity is below this many bps of the
   * Σ in-range capacity across alive pools (default DEFAULT_MIN_REL_BPS =
   * ECO_MIN_REL_BPS env or 100 = 1%). Set 0 to disable the filter and keep every
   * alive pool (used by cross-version split tests that intentionally mix
   * shallow-but-distinct AMM versions).
   */
  minRelBps?: number;
  /**
   * Override the lens forward tick window (default V3_TICK_STEPS = 96). Lets the
   * adaptive EVM test deliberately prepare a NARROW window so the prepared brackets
   * under-fill amountIn — then the always-on streaming walk resumes from the frontier
   * seed to close the gap.
   */
  maxTicks?: number;
  /**
   * Engine target for the on-chain LENS read (the discovery/state/tick eth_call cook).
   * DEFAULT "v12" — the production engine; the lens is now v12-native (its MEASURE-B
   * computation + return decode are verified on v12). The lens read is engine-agnostic in
   * VALUE (same survivors/header on either engine), so this only selects which engine the
   * read runs on; it MUST match the engine deployed at `lensCookEntry`. Set "v1" for the
   * legacy SauceRouter path.
   */
  lensTarget?: "v1" | "v12";
  /**
   * The account to simulate the read-only lens cook from. v1's SauceRouter.cook is open,
   * so the default sentinel works. On v12 the V12Pot.cook is owner-gated, so the read
   * MUST originate from the Pot owner — callers pass the cook caller here.
   */
  caller?: Hex;
}

export async function prepareEcoSwap(
  config: EcoSwapConfig,
  client: PublicClient,
  // The LENS cook entrypoint — the engine address the read-only discovery/state/tick
  // cook() runs against (matches lensTarget): the v1 SauceRouter on v1, the owner's
  // V12Pot on v12 (the lens is the only on-chain call prepare makes — no separate quote RPC).
  lensCookEntry: Hex,
  poolConfig: ChainPoolConfig = BASE_CHAIN_POOL_CONFIG,
  opts: EcoSwapPrepareOpts = {},
): Promise<EcoSwapPrepared> {
  const minRelBps = opts.minRelBps ?? DEFAULT_MIN_REL_BPS;
  const maxTicks = opts.maxTicks ?? V3_TICK_STEPS;
  const target = opts.lensTarget ?? "v12";
  const caller = opts.caller;
  const { tokenIn, tokenOut, amountIn } = config;
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();
  const zeroForOne = inLower < outLower;
  const priceLimit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

  // ── Discover + read direct pools via the on-chain LENS (ONE eth_call) ──
  // Replaces ~all direct-pool discovery/state/tick/token0 RPCs: the lens runs
  // discovery + slot0/getReserves/StateView + a windowed tick scan inside ONE
  // read-only cook() eth_call and returns raw reads, decoded into LensPool[]. The
  // lens program is compiled to `target` and cooked through `lensCookEntry` (the
  // matching engine), simulated from `caller` (the Pot owner on v12).
  const lensResult = await runLens(client, lensCookEntry, poolConfig, {
    tokenIn,
    tokenOut,
    zeroForOne,
    amountIn,
    driftTicks: 0, // WS2 §3.3: no reverse/forward drift scan — the solver reads drift LIVE.
    minRelBps,
    maxTicks,
    target,
    account: caller,
  });

  // The LENS is the single source of truth for survivorship: it already applied
  // the relative-depth IN-RANGE-capacity floor on-chain and returns ONLY survivors
  // (every returned pool is a usable type — V2Standard sans Solidly-stable,
  // V3Standard, hookless V4). So prepare does NOT re-filter; it just keeps the
  // deepest top-N by spot liquidity (a calldata/loop bound, not a liquidity gate).
  const survivors = lensResult.pools;
  const usableDirect = survivors
    .slice()
    .sort((a, b) => (a.liquidity < b.liquidity ? 1 : a.liquidity > b.liquidity ? -1 : 0))
    .slice(0, MAX_DIRECT_POOLS);

  // No silent caps: surface what the lens dropped (relative-depth) and any top-N
  // truncation. Per-pool droppee detail lives on-chain now — report counts.
  const droppedByLens = lensResult.discoveredCount - lensResult.survivorCount;
  if (droppedByLens > 0) {
    console.log(
      `  EcoSwap lens dropped ${droppedByLens} shallow pool(s) (< ${minRelBps}bps of Σ in-range ` +
        `capacity, floor=${lensResult.capacityFloor} of Σ${lensResult.totalInRangeCapacity})`,
    );
  }
  if (survivors.length > MAX_DIRECT_POOLS) {
    console.log(
      `  EcoSwap capped to deepest ${MAX_DIRECT_POOLS} of ${survivors.length} survivor pools (ECO_MAX_POOLS)`,
    );
  }
  const v3Raw = usableDirect.filter((p) => p.poolType === SwapPoolType.UniV3);
  const v4Raw = usableDirect.filter((p) => p.poolType === SwapPoolType.UniV4);
  // Constant-product (Uniswap-V2-style) pools execute via the unified
  // swap(SwapParams) entry (poolType=UniV2); the on-chain solver streams them
  // from live reserves. The engine's _swapV2 hardcodes the 0.3% fee.
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
    // ROUTE hops keep a small forward drift buffer (ROUTE_DRIFT_TICKS): unlike DIRECT
    // pools, routes execute off-chain-composed in ONE flat swapV3 per hop with NO
    // on-chain live walk to compensate for an under-reaching window — so the prepared
    // bracket curve must extend slightly past the sampled amountIn for the off-chain
    // localQuote composition to track the real two-hop swap to truncation. (Direct
    // pools use driftTicks:0 because the solver walks from the live spot and reads drift live.)
    const [hop1, hop2] = await Promise.all([
      runLens(client, lensCookEntry, poolConfig, {
        tokenIn, tokenOut: baseToken, zeroForOne: z1,
        amountIn, driftTicks: ROUTE_DRIFT_TICKS, minRelBps, maxTicks: V3_TICK_STEPS,
        target, account: caller,
      }),
      runLens(client, lensCookEntry, poolConfig, {
        tokenIn: baseToken, tokenOut, zeroForOne: z2,
        amountIn, driftTicks: ROUTE_DRIFT_TICKS, minRelBps, maxTicks: V3_TICK_STEPS,
        target, account: caller,
      }),
    ]);
    // The on-chain route handler executes BOTH hops via flat swapV3, so only V3
    // pools are valid route legs. (V2/V4 route hops would need per-hop type
    // dispatch + a richer route tuple on-chain — a documented follow-up.) Pick the
    // deepest V3 pool per hop; skip the route if either hop has no V3 pool.
    const v3Hop1 = hop1.pools.filter((p) => p.poolType === SwapPoolType.UniV3);
    const v3Hop2 = hop2.pools.filter((p) => p.poolType === SwapPoolType.UniV3);
    if (v3Hop1.length === 0 || v3Hop2.length === 0) continue;
    const best1 = v3Hop1.reduce((a, b) => (a.liquidity > b.liquidity ? a : b));
    const best2 = v3Hop2.reduce((a, b) => (a.liquidity > b.liquidity ? a : b));
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

  // ── Build pool descriptors + per-pool net caches ──
  // Direct pools no longer carry prepared bracket sqrt edges: the on-chain solver walks each
  // pool's LIVE frontier and reuses only the drift-invariant NET. `brackets` holds ROUTE
  // segments only (routes are static, composed off-chain). V2 needs no tick cache.
  const pools: EcoPool[] = [];
  const brackets: EcoBracket[] = [];

  // V3 (lens already returned slot0 + windowed ticks() per pool)
  for (const p of v3Raw) {
    const pool: EcoPool = {
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
    };
    stampPoolCache(lensToV3Read(p), zeroForOne, pool);
    pools.push(pool);
  }

  // V4 (singleton; lens read StateView slot0 + windowed getTickLiquidity)
  for (const p of v4Raw) {
    const pool: EcoPool = {
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
    };
    stampPoolCache(lensToV3Read(p), zeroForOne, pool);
    pools.push(pool);
  }

  // V2 (lens returned synthetic out/in sqrt + synthetic L + inIsToken0 + the REAL per-pool
  // fee). No tick cache: the solver streams constant-L geometric slices from the LIVE out/in
  // spot. The spot fields seed the no-drift walk (off-chain reference); on-chain reads
  // getReserves live. feePpm is the lens-reported fee (3000 for canonical UniswapV2; a
  // configured non-3000 V2-class fee otherwise) — the oracle, the reference and the on-chain
  // stream all gross by THIS fee, so they stay wei-exact for any V2-class fee. A pool whose
  // fee != V2_DEFAULT_FEE_PPM cannot use the engine's hardcoded-0.30% _swapV2, so the solver
  // executes it via the callback-free path (transfer + pair.swap) — see ecoswap.sauce.ts.
  for (const p of v2Raw) {
    pools.push({
      poolType: p.poolType,
      address: p.address,
      fee: p.fee,
      tickSpacing: 0,
      hooks: ZERO_ADDRESS,
      feePpm: p.fee,
      isV2: true,
      inIsToken0: p.inIsToken0,
      stateView: ZERO_ADDRESS,
      poolId: ZERO_BYTES32,
      spotNearReal: p.sqrtPriceX96, // out/in spot (V2 frontier seed)
      spotActiveL: p.liquidity, // √k
      source: "lens V2",
    });
  }

  // ── KyberSwap Classic / DMM (off-chain discovery — NOT in the lens) ──
  // Kyber is a V2-shaped pool on VIRTUAL reserves; the lens only understands V2/V3/V4
  // getReserves/slot0/StateView, so Kyber is discovered separately via getPools →
  // getTradeInfo and appended to the survivor set. Each Kyber pool seeds the SAME
  // constant-L V2 stream the solver/oracle/reference walk — but from the VIRTUAL reserves
  // (L = √(vIn·vOut), spot out/in = √(vOut/vIn)) — and carries the rounded per-pool fee
  // (the same ppm the oracle grosses by). It executes callback-free (transfer + pool.swap),
  // computing the output on the virtual reserves with the live feeInPrecision. The relative-
  // depth survivor filter is applied ON-CHAIN by the lens for V2/V3/V4 only; Kyber pools
  // survive on the `>0` aliveness gate (virtual reserves present) and the shared top-N cap.
  const kyberFactories = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.KyberClassic,
  );
  if (kyberFactories.length > 0) {
    const kyberRaw = await discoverKyberClassicPools(tokenIn, tokenOut, client, kyberFactories);
    for (const k of kyberRaw) {
      if (k.vReserveIn <= 0n || k.vReserveOut <= 0n) continue;
      const feePpm = kyberFeeToPpm(k.feeInPrecision);
      const synthL = isqrt(k.vReserveIn * k.vReserveOut); // √(vIn·vOut)
      const spotOI = isqrt((k.vReserveOut * Q192) / k.vReserveIn); // out/in spot from VIRTUAL reserves
      pools.push({
        poolType: SwapPoolType.UniV2,
        address: k.address,
        fee: feePpm,
        tickSpacing: 0,
        hooks: ZERO_ADDRESS,
        feePpm,
        isV2: true,
        isKyber: true,
        inIsToken0: k.inIsToken0,
        stateView: ZERO_ADDRESS,
        poolId: ZERO_BYTES32,
        spotNearReal: spotOI, // out/in spot (virtual-reserve frontier seed)
        spotActiveL: synthL, // √(vIn·vOut)
        source: `${k.source} (Kyber Classic)`,
      });
    }
  }

  // ── Curve StableSwap (off-chain discovery + bigint replay — NOT in the lens) ──
  // Curve is a static segment venue: the curve math is OFF-CHAIN ONLY (no Newton in
  // SauceScript). discoverCurvePoolsTyped reads the live invariant state (A, balances[],
  // rates[], fee, int128 i/j); buildCurveSegments samples get_dy at M geometric cumulative
  // inputs (no extra RPC) into (capacity, marginalOI) segments in descending-price order;
  // the on-chain solver consumes those through the EXISTING static-segment cursor and
  // executes the awarded Σ share via swap(SwapParams{poolType:3}) → live _swapCurve. The
  // marginal is post-fee (get_dy nets the fee), so it competes in the merge directly.
  const curves: EcoCurve[] = [];
  const curveBracketSets: EcoBracket[][] = [];
  const curveRegistries = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.CurveRegistry,
  );
  if (curveRegistries.length > 0) {
    const curveRaw = await discoverCurvePoolsTyped(tokenIn, tokenOut, client, curveRegistries);
    for (const c of curveRaw) {
      const refIdx = curves.length;
      const cb = buildCurveBrackets(c, refIdx, amountIn);
      if (cb.length === 0) continue;
      curves.push({
        address: c.address,
        i: c.i,
        j: c.j,
        feePpm: curveFeeToPpm(c.feePpm10),
        source: `${c.source} (Curve)`,
      });
      curveBracketSets.push(cb);
    }
  }
  for (const set of curveBracketSets) brackets.push(...set);

  // ── Trader Joe LB (off-chain discovery + EXACT per-bin enumeration — NOT in the lens) ──
  // LB is a static-segment venue: each active bin is a CONSTANT-SUM slice at a FIXED price, so
  // discovery reads the live per-bin reserves around the active bin and buildLbSegments emits
  // ONE EXACT flat segment per bin (no sampling, no grid error). The on-chain solver consumes
  // those through the EXISTING static-segment cursor and executes the awarded Σ share via
  // swap(SwapParams{poolType:6, pool}) → live _swapTraderJoeLB (one atomic pool.swap(swapForY,
  // to); the engine resolves swapForY on-chain from getTokenX()). The marginal is post-fee
  // (buildLbSegments nets the base fee), so it competes in the merge directly.
  const lbs: EcoLb[] = [];
  const lbBracketSets: EcoBracket[][] = [];
  const lbFactories = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.TraderJoeLB,
  );
  if (lbFactories.length > 0) {
    const lbRaw = await discoverTraderJoeLBPoolsTyped(tokenIn, tokenOut, client, lbFactories);
    for (const lb of lbRaw) {
      const refIdx = lbs.length;
      const lbb = buildLbBrackets(lb, refIdx, amountIn);
      if (lbb.length === 0) continue;
      lbs.push({
        address: lb.address,
        binStep: lb.binStep,
        feePpm: lbFeeToPpm(lb.binStep, lb.baseFactor),
        source: lb.source,
      });
      lbBracketSets.push(lbb);
    }
  }
  for (const set of lbBracketSets) brackets.push(...set);

  // ── DODO V2 PMM (off-chain discovery + closed-form replay — NOT in the lens) ──
  // DODO V2 is a static-segment venue: the PMM curve is a CLOSED-FORM integral parameterised by a
  // GUIDE PRICE `i` that is POOL STATE (read live from getPMMStateForCall), not an exogenous oracle
  // feed — so it is wei-exact-on-grid under the charter (unlike WOOFi/Fermi). discoverDodoV2PoolsTyped
  // reads the live PMM state (i, K, B, Q, B0, Q0, R + LP/MT fee); buildDodoSegments samples querySell*
  // at M geometric cumulative inputs (no extra RPC) into (capacity, marginalOI) segments in
  // descending-price order; the on-chain solver consumes those through the EXISTING static-segment
  // cursor and executes the awarded Σ share via swap(SwapParams{poolType:5}) → live _swapDODOV2 (it
  // resolves base/quote orientation on-chain from _BASE_TOKEN_()). The marginal is post-fee
  // (buildDodoSegments nets the LP+MT fee), so it competes in the merge directly.
  const dodos: EcoDodo[] = [];
  const dodoBracketSets: EcoBracket[][] = [];
  const dodoZoos = poolConfig.factories.filter((f) => f.factoryType === FactoryType.DODOZoo);
  if (dodoZoos.length > 0) {
    const dodoRaw = await discoverDodoV2PoolsTyped(tokenIn, tokenOut, client, dodoZoos, caller);
    for (const d of dodoRaw) {
      const refIdx = dodos.length;
      const db = buildDodoBrackets(d, refIdx, amountIn);
      if (db.length === 0) continue;
      dodos.push({
        address: d.address,
        sellBase: d.sellBase,
        feePpm: d.feePpm,
        source: `${d.source} (DODO V2)`,
      });
      dodoBracketSets.push(db);
    }
  }
  for (const set of dodoBracketSets) brackets.push(...set);

  // Routes (sampled). Keep the deepest few. Segments composed via localQuote.
  const routes: EcoRoute[] = [];
  const routeBracketSets: EcoBracket[][] = [];
  for (const r of routesRaw) {
    if (routes.length >= MAX_ROUTES) break;
    const refIdx = routes.length;
    const rb = buildRouteBracketsLocal(
      r.hop1Brackets,
      r.hop2Brackets,
      refIdx,
      amountIn,
      r.hop1Pool.fee,
      r.hop2Pool.fee,
    );
    if (rb.length === 0) continue;
    routes.push({ route: { intermediateToken: r.intermediateToken, hop1Pool: r.hop1Pool, hop2Pool: r.hop2Pool } });
    routeBracketSets.push(rb);
  }
  for (const set of routeBracketSets) brackets.push(...set);

  // The per-pool net cache is an optimization, not a correctness dependency: the on-chain
  // solver reconstructs everything LIVE from each pool's spot read even with no cache (the
  // 1-RPC quote path, opts.maxTicks:0). So an empty universe (no pools AND no routes) is the
  // only error.
  if (
    pools.length === 0 &&
    routes.length === 0 &&
    curves.length === 0 &&
    lbs.length === 0 &&
    dodos.length === 0
  ) {
    throw new Error(`No usable pools/routes for ${tokenIn} -> ${tokenOut}`);
  }

  // ── Sort the route segments DESC by fee-adjusted near price ──
  // `brackets` now holds ROUTE segments only (direct pools carry per-pool net caches instead).
  // Tie-break adjNear DESC, then adjFar DESC, then routeIdx ASC — bit-identical to the merge's
  // route-cursor order (index.ts buildRouteSegs sorts the same way).
  brackets.sort((a, b) => {
    if (a.sqrtAdjNear !== b.sqrtAdjNear) return a.sqrtAdjNear < b.sqrtAdjNear ? 1 : -1;
    if (a.sqrtAdjFar !== b.sqrtAdjFar) return a.sqrtAdjFar < b.sqrtAdjFar ? 1 : -1;
    return a.refIdx - b.refIdx;
  });

  // Diagnostic: rough coverage = Σ route segment capacity (direct-pool depth is now read live,
  // so this is only the static route contribution — informational, not a correctness gate).
  const covered = brackets.reduce((s, b) => s + b.capacity, 0n);

  const nV4 = pools.filter((p) => p.poolType === SwapPoolType.UniV4).length;
  const nV3 = pools.filter((p) => p.poolType === SwapPoolType.UniV3).length;
  const nKyber = pools.filter((p) => p.isKyber).length;
  const nV2 = pools.filter((p) => p.isV2 && !p.isKyber).length;
  const netRows = pools.reduce((s, p) => s + (p.netRows?.length ?? 0), 0);
  const nCurveSegs = brackets.filter((b) => b.kind === EcoBracketKind.Curve).length;
  const nLbSegs = brackets.filter((b) => b.kind === EcoBracketKind.LB).length;
  const nDodoSegs = brackets.filter((b) => b.kind === EcoBracketKind.DODO).length;
  console.log(
    `  EcoSwap prepared: ${nV3} V3, ${nV4} V4, ${nV2} V2, ${nKyber} Kyber, ${curves.length} Curve, ` +
      `${lbs.length} LB, ${dodos.length} DODO, ${routes.length} routes, ${netRows} net-cache rows ` +
      `(direct pools walked live), ${brackets.length} static segments ` +
      `(${nCurveSegs} Curve, ${nLbSegs} LB, ${nDodoSegs} DODO)`,
  );

  return {
    pools,
    routes,
    curves,
    lbs,
    dodos,
    brackets,
    zeroForOne,
    priceLimit,
    expectedInputCovered: covered,
  };
}
