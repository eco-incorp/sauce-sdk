/**
 * EcoSwap off-chain preparation.
 *
 * Builds the per-pool NET CACHE (the drift-invariant tick depth the on-chain unified
 * walk reuses) for BOTH direct pools and multi-hop route-leg pools. Every pool — direct
 * or leg — ships NO prepare-time sqrt edges: the on-chain solver walks each pool's single
 * frontier from its LIVE spot and computes all sqrt/price on the live grid, consulting the
 * cache only for the net at each scanned boundary (a staticcall avoided). The cache is a
 * pure gas optimization. A multi-hop route is a first-class live-walk venue: each leg is a
 * SET of leg pools (themselves full EcoPools with their own net caches) the leg splits
 * across; the on-chain solver composes the legs live, so prepare ships NO static route
 * segments (prepared.brackets is always []).
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
 *   4. Routes: for each base token X (≠ in/out), one lens eth_call per edge —
 *      (in→X) and (X→out) — keeping ALL V3 survivor pools per leg (no best-pool
 *      reduce, no route cap). Each leg pool is stamped with its OWN net cache via
 *      stampPoolCache (using the LEG's hop direction zHop), so a leg pool is
 *      byte-identical on-chain to a direct pool and is walked LIVE by the solver.
 *      runLens is MEMOIZED per unordered token pair so shared edges read once.
 *
 * RPC efficiency: the entire direct-pool discovery + state + tick read is ONE
 * eth_call (the lens); multi-hop routes add at most one eth_call per distinct
 * (unordered) token-pair edge (memoized).
 */

import type { PublicClient, Hex } from "viem";
import { runLens, type LensPool, type LensResult } from "./lens.js";
import {
  discoverKyberClassicPools,
  discoverCurvePoolsTyped,
  discoverTraderJoeLBPoolsTyped,
  discoverDodoV2PoolsTyped,
  discoverSolidlyStablePoolsTyped,
  discoverWombatPoolsTyped,
  discoverBalancerStablePoolsTyped,
  discoverEulerSwapPoolsTyped,
  discoverMaverickV2PoolsTyped,
  discoverCryptoSwapPoolsTyped,
} from "../shared/pool-discovery.js";
import { buildCurveSegments, type CurvePool } from "../shared/curve-math.js";
import { buildCryptoSwapSegments, type CryptoSwapPool } from "../shared/cryptoswap-math.js";
import { buildLbSegments, lbFeeToPpm, type LbPool } from "../shared/lb-math.js";
import { buildDodoSegments, type DodoPool } from "../shared/dodo-math.js";
import { buildSolidlyStableSegments, type SolidlyStablePool } from "../shared/solidly-stable-math.js";
import { buildWombatSegments, type WombatPool } from "../shared/wombat-math.js";
import { buildEulerSwapSegments, type EulerSwapPool } from "../shared/eulerswap-math.js";
import { buildMaverickSegments, type MaverickPool } from "../shared/maverick-math.js";
import { buildBalancerStableSegments, type BalancerStablePool } from "../shared/balancer-stable-math.js";
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
  type EcoLeg,
  type EcoRoute,
  type EcoCurve,
  type EcoLb,
  type EcoDodo,
  type EcoSolidlyStable,
  type EcoWombat,
  type EcoBalancerStable,
  type EcoEulerSwap,
  type EcoMaverick,
  type EcoCryptoSwap,
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
/** Cap on direct pools (top-N by liquidity) — bounds on-chain loop + calldata. */
const MAX_DIRECT_POOLS = Number(process.env.ECO_MAX_POOLS ?? 12);
/**
 * Max number of LEGS (hops) in a discovered route — the depth bound of the path DFS over the
 * base-token graph. A route always has ≥2 legs (a 1-leg in→out is a direct pool). Default 3
 * (tokenIn → T1 → T2 → tokenOut at most one interior pair); set to 2 to reproduce the prior
 * single-intermediate behavior. Override with ECO_MAX_HOPS.
 */
const MAX_HOPS = Math.max(2, Number(process.env.ECO_MAX_HOPS ?? 3));
/**
 * Cap on total discovered routes — a calldata/loop bound (each route is one `routing` tuple +
 * its leg pools in the on-chain universe), NOT a liquidity gate. Paths beyond this are dropped
 * and logged. Override with ECO_MAX_ROUTES.
 */
const MAX_ROUTES = Number(process.env.ECO_MAX_ROUTES ?? 8);
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

// ── Lens-read adapter (feeds the per-pool net cache stamp) ───

interface V3Read {
  pool: PoolInfo;
  tick: number;
  tickSpacing: number;
  activeLiquidity: bigint;
  /** liquidityNet keyed by tick index, for the scanned window. */
  net: Map<number, bigint>;
  /**
   * Forward tick boundaries the LAZY lens actually walked. stampPoolCache uses this
   * to size the cache window (windowBot = windowTop ∓ (scannedForward-1)*ts) so the
   * cache never claims net past the lens's scanned data. 0 → no scan (the quote /
   * 1-RPC path: the on-chain walk staticcalls every boundary).
   */
  scannedForward: number;
}

/**
 * Adapt a lens-decoded V3/V4 pool into the V3Read shape `stampPoolCache`
 * consumes. The lens already returned slot0 (sqrtPriceX96 + EXACT current tick),
 * active liquidity, and a windowed liquidityNet map keyed by signed tick — so no
 * RPC, and the cache window bounds (base = floor(tick/ts)*ts, stepping ±ts) line
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

// ── Unified-walk per-pool net cache (the only per-pool prepare-time output) ──

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

/**
 * Build a full live-walk EcoPool from a decoded lens pool, stamping its per-pool net cache
 * (V3/V4) or the constant-L spot seed (V2). `zHop` is the swap direction for THIS pool's hop
 * (== the pool's `zeroForOne` / `inIsToken0`): for a direct pool it is the overall swap's
 * `zeroForOne`; for a route-leg pool it is the LEG's hop direction. The resulting EcoPool is
 * byte-identical on-chain whether it is a direct venue or a leg pool — both are walked LIVE by
 * the solver — so this single builder serves both. `sourceLabel` is a human-readable tag.
 *
 * `isDirect` distinguishes a DIRECT venue from a route LEG pool for the V2 fee: a direct V2 pool
 * carries the REAL lens-reported per-pool fee (the oracle, the reference and the on-chain stream
 * all gross by it, staying wei-exact for any V2-class fee) and executes callback-free when that
 * fee != V2_FEE_PPM. A route LEG V2 pool stays pinned to V2_FEE_PPM (0.30%) because the chain-order
 * leg block executes V2 legs via the engine's hardcoded-0.30% router swap (poolType:0), so the
 * leg geometry must match what executes. V3/V4 (incl. Algebra mapped to V3) always carry p.fee.
 */
function lensToEcoPool(p: LensPool, zHop: boolean, sourceLabel: string, isDirect: boolean): EcoPool {
  if (p.poolType === SwapPoolType.UniV2) {
    // Constant-product: no tick cache (the solver streams constant-L geometric slices from the
    // LIVE out/in spot; on-chain reads getReserves live). inIsToken0 is the pool's own reserve
    // orientation — for a leg pool, hopIn-is-token0, which the lens already reported as p.inIsToken0.
    // Direct pools use the REAL fee; leg pools stay 0.30% (engine _swapV2 honors only that tier).
    const v2Fee = isDirect ? p.fee || V2_FEE_PPM : V2_FEE_PPM;
    return {
      poolType: p.poolType,
      address: p.address,
      fee: v2Fee,
      tickSpacing: 0,
      hooks: ZERO_ADDRESS,
      feePpm: v2Fee,
      isV2: true,
      inIsToken0: p.inIsToken0,
      stateView: ZERO_ADDRESS,
      poolId: ZERO_BYTES32,
      spotNearReal: p.sqrtPriceX96, // out/in spot (V2 frontier seed)
      spotActiveL: p.liquidity, // √k
      source: sourceLabel,
    };
  }
  const isV4 = p.poolType === SwapPoolType.UniV4;
  const pool: EcoPool = {
    poolType: p.poolType,
    address: p.address, // V4: PoolManager singleton
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    hooks: isV4 ? p.hooks ?? ZERO_ADDRESS : ZERO_ADDRESS,
    feePpm: p.fee,
    isV2: false,
    inIsToken0: zHop, // V3/V4 PoolKey orientation = this hop's token sort order (zHop)
    stateView: isV4 ? p.stateView : ZERO_ADDRESS,
    poolId: isV4 ? p.poolId : ZERO_BYTES32,
    source: sourceLabel,
  };
  // The net cache is built in THIS hop's swap direction (zHop): the net-row sort, the window
  // bounds and the extreme/terminate gate are all swap-direction-oriented, so a leg pool whose
  // zHop differs from the overall swap is stamped leg-oriented (matching its inIsToken0).
  stampPoolCache(lensToV3Read(p), zHop, pool);
  return pool;
}

// ── Sampled-segment venue bracket builders (Curve / LB / DODO) ──────────────
//
// Curve, LB and DODO are SAMPLED-SEGMENT venues: their curve math is OFF-CHAIN ONLY (no Newton /
// PMM integral / per-bin walk in SauceScript). prepare samples (or, for LB, EXACTLY enumerates)
// each into STATIC segments emitted as EcoBrackets (kinds Curve/LB/DODO) carrying the post-fee
// marginal price as both sqrtAdjNear and sqrtAdjFar (a flat segment, like a route segment). The
// on-chain solver consumes those through a static-segment cursor (bestKind===1) alongside the
// live direct pools + live routes, accumulates the awarded Σ per venue, and executes via the
// engine swap (poolType 3 Curve / 6 LB / 5 DODO). The split equalizes marginals on the sampled
// grid; the per-venue out for the awarded Σ share is re-evaluated wei-exact by ONE atomic engine
// swap (exact-on-grid for Curve/DODO, EXACT for LB — a bin is a flat constant-sum slice).

/**
 * Build Curve StableSwap segments for one pool by sampling the bigint replay (NO extra RPC — pure
 * bigint on the read pool state). Each sampled (Δinput, Δoutput) increment becomes a STATIC
 * segment (kind Curve) in unified out/in space, refIdx → the curve venue index. The marginal is
 * the POST-FEE execution price (get_dy already nets the fee), so it enters the descending-price
 * merge directly as both sqrtAdjNear and sqrtAdjFar.
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

/**
 * Build Curve CryptoSwap segments for one pool by sampling the bounded-Newton A-gamma replay (NO
 * extra RPC — pure bigint on the read A/gamma/price_scale/D/balances/fee params). Each sampled
 * (Δinput, Δoutput) increment becomes a STATIC segment (kind CryptoSwap) in unified out/in space,
 * refIdx → the CryptoSwap venue index. The marginal is the POST-FEE execution price (getDyCrypto
 * already nets the dynamic fee), so it enters the descending-price merge directly as both
 * sqrtAdjNear and sqrtAdjFar. The CryptoSwap curve is OFF-CHAIN ONLY for the split; the on-chain
 * solver executes CALLBACK-FREE (get_dy staticcall for min_dy + approve + exchange(uint256,...) —
 * crypto pools use uint256 coin indices the engine's int128 _swapCurve does NOT match).
 */
function buildCryptoSwapBrackets(pool: CryptoSwapPool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildCryptoSwapSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.CryptoSwap,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the CryptoSwap dynamic fee (post-fee dy)
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
 * descending-price merge directly as both sqrtAdjNear and sqrtAdjFar. LB segments are EXACT (no
 * grid error), so the split is wei-exact vs the oracle (not merely exact-on-grid).
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
 * descending-price merge directly as both sqrtAdjNear and sqrtAdjFar. DODO's curve math is
 * OFF-CHAIN ONLY (the on-chain solver does NOT recompute the PMM integral).
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

/**
 * Build Solidly STABLE (sAMM) segments for one pool by sampling the bigint replay (NO extra RPC — pure
 * bigint on the read reserves/decimals/fee). Each sampled (Δinput, Δoutput) increment becomes a STATIC
 * segment (kind SolidlyStable) in unified out/in space, refIdx → the stable venue index. The marginal
 * is the POST-FEE execution price (getAmountOutStable already nets the fee), so it enters the
 * descending-price merge directly as both sqrtAdjNear and sqrtAdjFar. The stable curve (x3y+y3x) is
 * OFF-CHAIN ONLY for the split; the on-chain solver executes CALLBACK-FREE (getAmountOut staticcall +
 * transfer + pool.swap).
 */
function buildSolidlyStableBrackets(pool: SolidlyStablePool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildSolidlyStableSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.SolidlyStable,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the stable fee (post-fee dy)
      sqrtAdjFar: sm.marginalOI,
    });
  }
  return brackets;
}

/**
 * Build Wombat segments for one pool by sampling the closed-form coverage-ratio replay (NO extra RPC —
 * pure bigint on the read from/to asset cash/liability + amp + haircut). Each sampled (Δinput, Δoutput)
 * increment becomes a STATIC segment (kind Wombat) in unified out/in space, refIdx → the Wombat venue
 * index. The marginal is the POST-HAIRCUT execution price (quotePotentialSwap already nets the
 * haircut), so it enters the descending-price merge directly as both sqrtAdjNear and sqrtAdjFar. The
 * Wombat curve is OFF-CHAIN ONLY for the split; the on-chain solver executes CALLBACK-FREE
 * (quotePotentialSwap staticcall + approve + pool.swap — Wombat PULLS via transferFrom).
 */
function buildWombatBrackets(pool: WombatPool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildWombatSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.Wombat,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the Wombat haircut (post-fee dy)
      sqrtAdjFar: sm.marginalOI,
    });
  }
  return brackets;
}

/**
 * Build EulerSwap segments for one pool by sampling the closed-form f/fInverse curve replay (NO extra RPC
 * — pure bigint on the read reserves + static curve params + fee, BOUNDED by the vault inLimit). Each
 * sampled (Δinput, Δoutput) increment becomes a STATIC segment (kind EulerSwap) in unified out/in space,
 * refIdx → the EulerSwap venue index. The marginal is the POST-FEE execution price (computeQuote nets the
 * fee), so it enters the descending-price merge directly as both sqrtAdjNear and sqrtAdjFar. The EulerSwap
 * curve is OFF-CHAIN ONLY for the split; the on-chain solver executes CALLBACK-FREE (computeQuote staticcall
 * + transfer + pool.swap(...,"") — EulerSwap's swap is V2-shaped, empty data ⇒ no flash callback).
 */
function buildEulerSwapBrackets(pool: EulerSwapPool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildEulerSwapSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.EulerSwap,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the EulerSwap fee (post-fee dy)
      sqrtAdjFar: sm.marginalOI,
    });
  }
  return brackets;
}

/**
 * Build Maverick V2 segments for one pool by sampling the bin swap-math replay (NO extra RPC — pure
 * bigint on the read tick book + directional fee, BOUNDED by the engine tickLimit=0 depth). Each sampled
 * (Δinput, Δoutput) increment becomes a STATIC segment (kind MaverickV2) in unified out/in space, refIdx →
 * the Maverick venue index. The marginal is the POST-FEE execution price (buildMaverickSegments nets the
 * directional fee), so it enters the descending-price merge directly as both sqrtAdjNear and sqrtAdjFar.
 * Maverick's bin math is OFF-CHAIN ONLY for the split; the on-chain solver EXECUTES the awarded Σ share
 * through the engine (swap poolType 7 → _swapMaverickV2 → the pool's maverickV2SwapCallback pulls the input
 * mid-swap — Maverick is a CALLBACK pool, so it CANNOT be executed callback-free).
 */
function buildMaverickBrackets(pool: MaverickPool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildMaverickSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.MaverickV2,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the Maverick directional fee (post-fee dy)
      sqrtAdjFar: sm.marginalOI,
    });
  }
  return brackets;
}

/**
 * Build Balancer V2 ComposableStable segments for one pool by sampling the bigint StableMath replay (NO
 * extra RPC — pure bigint on the read invariant state). Each sampled (Δinput, Δoutput) increment becomes
 * a STATIC segment (kind BalancerStable) in unified out/in space, refIdx → the Balancer venue index. The
 * marginal is the POST-FEE execution price (getDy nets the swap fee), so it enters the descending-price
 * merge directly as both sqrtAdjNear and sqrtAdjFar. The stable math (A-invariant + BPT exclusion +
 * scaling factors) is OFF-CHAIN ONLY for the split; the on-chain solver executes via the EXISTING engine
 * BalancerV2 dispatch swap(SwapParams{poolType:4}) → _swapBalancerV2 → Vault.swap(GIVEN_IN).
 */
function buildBalancerStableBrackets(pool: BalancerStablePool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildBalancerStableSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.BalancerStable,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the Balancer swap fee (post-fee dy)
      sqrtAdjFar: sm.marginalOI,
    });
  }
  return brackets;
}

/** Round a Balancer swap fee (1e18-WAD) to ppm (the price-ordering coordinate / diagnostics). */
function balancerFeeToPpm(swapFeeWad: bigint): number {
  return Number((swapFeeWad * 1_000_000n + 5n * 10n ** 17n) / 10n ** 18n);
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
    includeAlgebra: true, // Algebra is executable (engine services algebraSwapCallback, sauce#186).
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

  // ── Build DIRECT pool descriptors + per-pool net caches ──
  // Every direct pool ships only its drift-invariant NET cache (no prepared sqrt edges): the
  // on-chain solver walks each pool's LIVE frontier and reuses the net. V2 streams constant-L
  // from live reserves (no tick cache). The single lensToEcoPool builder is reused for routes.
  const pools: EcoPool[] = [];
  for (const p of v3Raw) pools.push(lensToEcoPool(p, zeroForOne, "lens V3", true));
  for (const p of v4Raw) pools.push(lensToEcoPool(p, zeroForOne, "lens V4", true));
  for (const p of v2Raw) pools.push(lensToEcoPool(p, p.inIsToken0, "lens V2", true));

  // ── KyberSwap Classic / DMM (off-chain discovery — NOT in the lens) ──
  // Kyber is a V2-shaped pool on VIRTUAL reserves; the lens only understands V2/V3/V4
  // getReserves/slot0/StateView, so Kyber is discovered separately via getPools →
  // getTradeInfo and appended to the DIRECT survivor set. Each Kyber pool seeds the SAME
  // constant-L V2 stream the solver/oracle/reference walk — but from the VIRTUAL reserves
  // (L = √(vIn·vOut), spot out/in = √(vOut/vIn)) — and carries the rounded per-pool fee
  // (the same ppm the oracle grosses by). It executes callback-free (transfer + pool.swap),
  // computing the output on the virtual reserves with the live feeInPrecision. The relative-
  // depth survivor filter is applied ON-CHAIN by the lens for V2/V3/V4 only; Kyber pools
  // survive on the `>0` aliveness gate (virtual reserves present).
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

  // ── Sampled-segment venues: Curve / Trader Joe LB / DODO V2 (off-chain — NOT in the lens) ──
  // These venues' curve math is OFF-CHAIN ONLY (no Newton / per-bin walk / PMM integral in
  // SauceScript). Each is discovered separately, its curve sampled (or, for LB, EXACTLY
  // enumerated) into STATIC segments emitted as EcoBrackets (kinds Curve/LB/DODO), and the venue
  // metadata collected into prepared.curves/lbs/dodos (indexed by the bracket's refIdx). The
  // on-chain solver competes these segments in the SAME price-ordered merge as the live direct
  // pools + live routes via a static-segment cursor (bestKind===1), and executes the awarded Σ
  // per venue through the engine swap (poolType 3 Curve / 6 LB / 5 DODO).
  const brackets: EcoBracket[] = [];

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

  const dodos: EcoDodo[] = [];
  const dodoBracketSets: EcoBracket[][] = [];
  const dodoZoos = poolConfig.factories.filter((f) => f.factoryType === FactoryType.DODOZoo);
  if (dodoZoos.length > 0) {
    const dodoRaw = await discoverDodoV2PoolsTyped(
      tokenIn,
      tokenOut,
      client,
      dodoZoos,
      caller ?? ZERO_ADDRESS,
    );
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

  const solidlyStables: EcoSolidlyStable[] = [];
  const solidlyBracketSets: EcoBracket[][] = [];
  const solidlyFactories = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.SolidlyV2,
  );
  if (solidlyFactories.length > 0) {
    const stableRaw = await discoverSolidlyStablePoolsTyped(tokenIn, tokenOut, client, solidlyFactories);
    for (const sp of stableRaw) {
      const refIdx = solidlyStables.length;
      const sb = buildSolidlyStableBrackets(sp, refIdx, amountIn);
      if (sb.length === 0) continue;
      solidlyStables.push({
        address: sp.address,
        inIsToken0: sp.inIsToken0,
        feePpm: sp.feePpm,
        source: sp.source,
      });
      solidlyBracketSets.push(sb);
    }
  }
  for (const set of solidlyBracketSets) brackets.push(...set);

  const wombats: EcoWombat[] = [];
  const wombatBracketSets: EcoBracket[][] = [];
  const wombatPools = poolConfig.factories.filter((f) => f.factoryType === FactoryType.Wombat);
  if (wombatPools.length > 0) {
    const wombatRaw = await discoverWombatPoolsTyped(tokenIn, tokenOut, client, wombatPools);
    for (const wp of wombatRaw) {
      const refIdx = wombats.length;
      const wb = buildWombatBrackets(wp, refIdx, amountIn);
      if (wb.length === 0) continue;
      wombats.push({
        address: wp.address,
        fromToken: wp.tokenIn,
        toToken: wp.tokenOut,
        feePpm: wp.feePpm,
        source: wp.source,
      });
      wombatBracketSets.push(wb);
    }
  }
  for (const set of wombatBracketSets) brackets.push(...set);

  const balancerStables: EcoBalancerStable[] = [];
  const balancerBracketSets: EcoBracket[][] = [];
  // Balancer V2 — known-pool-address discovery (the FactoryConfig.address is the Vault; the per-config
  // balancerStablePools carries the candidate ComposableStable pools). Sampled like Curve; executed via
  // the EXISTING engine BalancerV2 dispatch (poolType 4 → _swapBalancerV2 → Vault.swap). NO engine change.
  const balancerVaults = poolConfig.factories.filter((f) => f.factoryType === FactoryType.BalancerV2);
  if (balancerVaults.length > 0) {
    const balRaw = await discoverBalancerStablePoolsTyped(tokenIn, tokenOut, client, balancerVaults);
    for (const bp of balRaw) {
      const refIdx = balancerStables.length;
      const bb = buildBalancerStableBrackets(bp, refIdx, amountIn);
      if (bb.length === 0) continue;
      balancerStables.push({
        address: bp.address,
        i: bp.i,
        j: bp.j,
        feePpm: balancerFeeToPpm(bp.swapFeeWad),
        source: bp.source,
      });
      balancerBracketSets.push(bb);
    }
  }
  for (const set of balancerBracketSets) brackets.push(...set);

  const eulerSwaps: EcoEulerSwap[] = [];
  const eulerBracketSets: EcoBracket[][] = [];
  // EulerSwap — known-pool-address discovery (the EulerSwap factory has NO pool enumeration, only a
  // `deployedPools` mapping + PoolDeployed events, so the candidate pool addresses are carried per-config
  // like Balancer; `discoverEulerSwapPoolsTyped` reads each pool's reserves + curve params + fee + the
  // vault getLimits inLimit). Sampled OFF-CHAIN (bounded by the vault cap); executed CALLBACK-FREE
  // (computeQuote + transfer + pool.swap(...,"")). NO engine change.
  const eulerFactories = poolConfig.factories.filter((f) => f.factoryType === FactoryType.EulerSwap);
  if (eulerFactories.length > 0) {
    const eulerRaw = await discoverEulerSwapPoolsTyped(tokenIn, tokenOut, client, eulerFactories);
    for (const ep of eulerRaw) {
      const refIdx = eulerSwaps.length;
      const eb = buildEulerSwapBrackets(ep, refIdx, amountIn);
      if (eb.length === 0) continue;
      eulerSwaps.push({
        address: ep.address,
        inIsToken0: ep.inIsToken0,
        feePpm: ep.feePpm,
        source: ep.source,
      });
      eulerBracketSets.push(eb);
    }
  }
  for (const set of eulerBracketSets) brackets.push(...set);

  const maverickPools: EcoMaverick[] = [];
  const maverickBracketSets: EcoBracket[][] = [];
  // Maverick V2 — factory lookup discovery (lookup(tokenA, tokenB, idx) over both orderings). Maverick is
  // a BIN-based directional AMM: the bin curve does NOT map to the drift-invariant liquidityNet tick walk,
  // so it is a SAMPLED-SEGMENT source (like DODO). `discoverMaverickV2PoolsTyped` reads the tick book around
  // the active tick + the directional fee + tickSpacing (and GATES a pool OUT when its live active tick sits
  // on the wrong side of tick 0 for its direction — the engine hardcodes tickLimit=0). Sampled OFF-CHAIN;
  // EXECUTED through the engine (swap poolType 7 → _swapMaverickV2 → maverickV2SwapCallback). NO engine change.
  const maverickFactories = poolConfig.factories.filter((f) => f.factoryType === FactoryType.MaverickV2Factory);
  if (maverickFactories.length > 0) {
    const maverickRaw = await discoverMaverickV2PoolsTyped(tokenIn, tokenOut, client, maverickFactories);
    for (const mp of maverickRaw) {
      const refIdx = maverickPools.length;
      const mb = buildMaverickBrackets(mp, refIdx, amountIn);
      if (mb.length === 0) continue;
      maverickPools.push({
        address: mp.address,
        tokenAIn: mp.tokenAIn,
        feePpm: mp.feePpm,
        source: `${mp.source} (Maverick V2)`,
      });
      maverickBracketSets.push(mb);
    }
  }
  for (const set of maverickBracketSets) brackets.push(...set);

  const cryptoSwaps: EcoCryptoSwap[] = [];
  const cryptoBracketSets: EcoBracket[][] = [];
  // Curve CryptoSwap — crypto/tricrypto Metaregistry lookup (find_pool_for_coins → get_coin_indices,
  // UINT256 i,j). CryptoSwap pools trade on the A-gamma invariant with a dynamic fee AND use uint256
  // coin indices, so the engine `_swapCurve` (exchange(int128,...)) does NOT match — a SAMPLED-SEGMENT
  // source executed CALLBACK-FREE (get_dy staticcall for min_dy + approve + exchange(uint256,...)).
  // Sampled OFF-CHAIN via the bounded-Newton replay; NO engine change. LOW priority (volatile-asset).
  const cryptoRegistries = poolConfig.factories.filter((f) => f.factoryType === FactoryType.CurveCryptoRegistry);
  if (cryptoRegistries.length > 0) {
    const cryptoRaw = await discoverCryptoSwapPoolsTyped(tokenIn, tokenOut, client, cryptoRegistries);
    for (const cp of cryptoRaw) {
      const refIdx = cryptoSwaps.length;
      const cb = buildCryptoSwapBrackets(cp, refIdx, amountIn);
      if (cb.length === 0) continue;
      cryptoSwaps.push({
        address: cp.address,
        i: cp.i,
        j: cp.j,
        feePpm: cp.feePpm,
        source: `${cp.source} (Curve CryptoSwap)`,
      });
      cryptoBracketSets.push(cb);
    }
  }
  for (const set of cryptoBracketSets) brackets.push(...set);

  // ── Discover multi-hop ROUTES — N-hop, every survivor pool per leg, walked LIVE ──
  // A k-hop route A→T1→…→B is k legs; each leg is a SET of pools the leg splits across (NOT one
  // best pool) — a first-class live-walk venue held to the same wei-exact standard as a direct
  // pool. We enumerate paths by a BOUNDED, CYCLE-AVOIDING DFS over the base-token graph: nodes are
  // {tokenIn, tokenOut} ∪ baseTokens, an edge is any (unordered) token pair carrying ≥1 V3 survivor
  // pool, and a path is tokenIn → (interior base tokens) → tokenOut of length 2..MAX_HOPS legs. The
  // path's token set is the DFS visited set, so no token repeats within a path (no cycles). Each
  // edge is read via the LENS with driftTicks:0 (like direct pools — the solver reads drift live),
  // keeping ALL survivors per leg (V2, V3 and hookless V4 alike), stamping each with the LEG's hop
  // direction zHop so its on-chain inIsToken0 / net-row sort / window math are leg-oriented. runLens
  // is MEMOIZED per UNORDERED token pair so a shared edge (e.g. WETH↔X used by several paths) reads
  // ONCE. The on-chain route execution dispatches per leg pool by type (swapV3 / swap(poolType:0) /
  // swap(poolType:2)) exactly like the direct-pool execution. MAX_HOPS=2 reproduces the prior 2-hop
  // behavior exactly (single interior base token).
  const edgeCache = new Map<string, Promise<LensResult>>();
  const edgeKey = (a: Hex, b: Hex): string => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    return al < bl ? `${al}|${bl}` : `${bl}|${al}`;
  };
  const readEdge = (hopIn: Hex, hopOut: Hex): Promise<LensResult> => {
    const key = edgeKey(hopIn, hopOut);
    let pending = edgeCache.get(key);
    if (!pending) {
      // The lens read is direction-agnostic in VALUE for survivorship/state (it returns each
      // pool's slot0 + windowed net regardless of swap orientation; the per-pool zeroForOne only
      // re-orients the net-row sort + window, which stampPoolCache redoes per leg). So one read
      // per unordered pair is sufficient; every path touching this edge reuses it.
      pending = runLens(client, lensCookEntry, poolConfig, {
        tokenIn: hopIn,
        tokenOut: hopOut,
        zeroForOne: BigInt(hopIn) < BigInt(hopOut),
        amountIn,
        driftTicks: 0, // like direct pools — the solver reads drift LIVE.
        minRelBps,
        maxTicks: V3_TICK_STEPS,
        target,
        account: caller,
        includeAlgebra: true, // Algebra is executable (engine services algebraSwapCallback, sauce#186).
      });
      edgeCache.set(key, pending);
    }
    return pending;
  };

  /**
   * Build a leg from a memoized edge read, keeping EVERY survivor pool the lens returned for the
   * edge — V2, V3 and hookless V4 alike (the leg-internal merge + N-hop chain are type-agnostic).
   * Each leg pool is stamped with the LEG's hop direction zHop exactly like a direct pool of its
   * type (V2 via the live-reserves seed, V3/V4 via the net cache). Returns null if the edge has no
   * survivor. A V4 survivor WITH hooks is excluded (the unified swap path is hookless-V4 only).
   */
  const buildLeg = async (hopIn: Hex, hopOut: Hex): Promise<EcoLeg | null> => {
    const zHop = hopIn.toLowerCase() < hopOut.toLowerCase(); // THIS leg's hop direction
    const lens = await readEdge(hopIn, hopOut);
    const legPools: EcoPool[] = [];
    for (const p of lens.pools) {
      if (p.poolType === SwapPoolType.UniV2) {
        // V2 leg pool: constant-L stream from the live reserves; its own reserve orientation is the
        // lens-reported inIsToken0 (hopIn-is-token0 for this leg), NOT the leg's address-sort zHop.
        legPools.push(lensToEcoPool(p, p.inIsToken0, "lens route leg V2", false));
      } else if (p.poolType === SwapPoolType.UniV3) {
        legPools.push(lensToEcoPool(p, zHop, "lens route leg V3", false));
      } else if (p.poolType === SwapPoolType.UniV4) {
        // Hookless V4 only — the unified swap(SwapParams) leg execution builds a hookless PoolKey.
        const hooks = p.hooks ?? ZERO_ADDRESS;
        if (hooks.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) continue;
        legPools.push(lensToEcoPool(p, zHop, "lens route leg V4", false));
      }
    }
    if (legPools.length === 0) return null;
    return {
      hopIn,
      hopOut,
      zeroForOne: zHop,
      pools: legPools,
    };
  };

  // Interior nodes the DFS may transit through: base tokens that are neither endpoint.
  const interiorTokens = poolConfig.baseTokens.filter((t) => {
    const tl = t.toLowerCase();
    return tl !== inLower && tl !== outLower;
  });

  const routes: EcoRoute[] = [];
  let routesTruncated = 0;
  // DFS frame: the path of TOKENS so far (starts [tokenIn]), the EcoLegs built between them, and
  // the visited token set (lowercased) to forbid revisiting any token on the same path (no cycles).
  // At each node we may close the path by hopping to tokenOut (emit a route), and — if we have
  // hop budget left — branch into each unvisited interior token. Legs are built lazily, so an
  // edge with no V3 survivor simply prunes that branch (a dead edge ⇒ no route through it).
  const dfs = async (
    token: Hex,
    legsSoFar: EcoLeg[],
    interSoFar: Hex[],
    visited: Set<string>,
  ): Promise<void> => {
    const hopsUsed = legsSoFar.length;
    // Close the path: hop directly to tokenOut. A path needs ≥2 legs to be a route (a direct
    // 1-leg in→out is a DIRECT pool, already covered by the universe), so only emit when
    // hopsUsed ≥ 1 (this closing leg makes ≥ 2).
    if (hopsUsed >= 1 && token.toLowerCase() !== outLower) {
      if (routes.length >= MAX_ROUTES) {
        routesTruncated++;
      } else {
        const closing = await buildLeg(token, tokenOut);
        if (closing) {
          routes.push({ legs: [...legsSoFar, closing], intermediateTokens: [...interSoFar] });
        }
      }
    }
    // Branch deeper: only if another interior hop still leaves room for the closing leg to out.
    if (hopsUsed + 2 > MAX_HOPS) return;
    for (const next of interiorTokens) {
      const nl = next.toLowerCase();
      if (visited.has(nl)) continue; // no cycles — each token at most once per path
      const leg = await buildLeg(token, next);
      if (!leg) continue; // dead edge — prune
      visited.add(nl);
      await dfs(next, [...legsSoFar, leg], [...interSoFar, next], visited);
      visited.delete(nl);
    }
  };
  await dfs(tokenIn, [], [], new Set<string>([inLower]));

  if (routesTruncated > 0) {
    console.log(
      `  EcoSwap capped routes to ${MAX_ROUTES} (ECO_MAX_ROUTES); dropped ${routesTruncated} ` +
        `additional path(s) — a calldata/loop bound, not a liquidity gate`,
    );
  }

  // The per-pool net cache is an optimization, not a correctness dependency: the on-chain
  // solver reconstructs everything LIVE from each pool's spot read even with no cache (the
  // 1-RPC quote path, opts.maxTicks:0). So an empty universe (no pools AND no routes) is the
  // only error.
  if (
    pools.length === 0 &&
    routes.length === 0 &&
    curves.length === 0 &&
    lbs.length === 0 &&
    dodos.length === 0 &&
    solidlyStables.length === 0 &&
    wombats.length === 0 &&
    balancerStables.length === 0
  ) {
    throw new Error(`No usable pools/routes for ${tokenIn} -> ${tokenOut}`);
  }

  const nV4 = pools.filter((p) => p.poolType === SwapPoolType.UniV4).length;
  const nV3 = pools.filter((p) => p.poolType === SwapPoolType.UniV3).length;
  const nKyber = pools.filter((p) => p.isKyber).length;
  const nV2 = pools.filter((p) => p.isV2 && !p.isKyber).length;
  const directNetRows = pools.reduce((s, p) => s + (p.netRows?.length ?? 0), 0);
  const legPoolCount = routes.reduce((s, r) => s + r.legs.reduce((t, l) => t + l.pools.length, 0), 0);
  const nCurveSegs = brackets.filter((b) => b.kind === EcoBracketKind.Curve).length;
  const nLbSegs = brackets.filter((b) => b.kind === EcoBracketKind.LB).length;
  const nDodoSegs = brackets.filter((b) => b.kind === EcoBracketKind.DODO).length;
  const nSolidlySegs = brackets.filter((b) => b.kind === EcoBracketKind.SolidlyStable).length;
  const nWombatSegs = brackets.filter((b) => b.kind === EcoBracketKind.Wombat).length;
  const nBalancerSegs = brackets.filter((b) => b.kind === EcoBracketKind.BalancerStable).length;
  const nMaverickSegs = brackets.filter((b) => b.kind === EcoBracketKind.MaverickV2).length;
  const nCryptoSegs = brackets.filter((b) => b.kind === EcoBracketKind.CryptoSwap).length;
  console.log(
    `  EcoSwap prepared: ${nV3} V3, ${nV4} V4, ${nV2} V2 direct, ${nKyber} Kyber, ` +
      `${curves.length} Curve, ${lbs.length} LB, ${dodos.length} DODO, ${solidlyStables.length} Solidly-stable, ` +
      `${wombats.length} Wombat, ${balancerStables.length} Balancer-stable, ` +
      `${routes.length} routes (${legPoolCount} leg pools), ${directNetRows} direct net-cache rows ` +
      `(all pools walked live), ${brackets.length} sampled segments (${nCurveSegs} Curve, ${nLbSegs} LB, ` +
      `${nDodoSegs} DODO, ${nSolidlySegs} Solidly-stable, ${nWombatSegs} Wombat, ${nBalancerSegs} Balancer-stable, ` +
      `${nMaverickSegs} Maverick, ${nCryptoSegs} CryptoSwap)`,
  );

  return {
    pools,
    routes,
    // Curve/LB/DODO are SAMPLED-SEGMENT venues — their curve math is off-chain only, sampled (LB:
    // EXACTLY enumerated) into the static segments below. The merge competes them via the
    // static-segment cursor (bestKind===1); curves/lbs/dodos carry the per-venue execution
    // metadata (refIdx-keyed). Direct pools + routes remain LIVE-walk venues with no static
    // segments, so every bracket here is a Curve/LB/DODO segment.
    curves,
    lbs,
    dodos,
    solidlyStables,
    wombats,
    balancerStables,
    eulerSwaps,
    maverickPools,
    cryptoSwaps,
    brackets,
    zeroForOne,
    priceLimit,
    expectedInputCovered: 0n,
  };
}
