/**
 * EcoSwap off-chain preparation.
 *
 * Builds the per-pool NET CACHE (the SWAP-drift-invariant tick depth the on-chain unified
 * walk reuses — liquidityNet survives any price move, but an LP mint/burn inside the scanned
 * window between prepare and cook goes stale: see EcoPool.windowTopShifted) for BOTH direct
 * pools and multi-hop route-leg pools. Every pool — direct
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
import { runLens, LENS_MAX_TICKS, LENS_BAND_TICKS, type LensPool, type LensResult } from "./lens.js";
import {
  discoverKyberClassicPools,
  discoverAlgebraPoolAddresses,
  discoverSolidlyVolatilePoolsTyped,
  discoverCurvePoolsTyped,
  discoverTraderJoeLBPoolsTyped,
  discoverDodoV2PoolsTyped,
  discoverSolidlyStablePoolsTyped,
  discoverWombatPoolsTyped,
  discoverBalancerStablePoolsTyped,
  discoverEulerSwapPoolsTyped,
  discoverMaverickV2PoolsTyped,
  discoverCryptoSwapPoolsTyped,
  discoverWooFiPoolsTyped,
  discoverFermiPoolsTyped,
  discoverFluidPoolsTyped,
  discoverMentoPoolsTyped,
  discoverBalancerV3PoolsTyped,
} from "../shared/pool-discovery.js";
import { buildCurveSegments, type CurvePool } from "../shared/curve-math.js";
import { buildCryptoSwapSegments, type CryptoSwapPool } from "../shared/cryptoswap-math.js";
import { buildLbSegments, lbFeeToPpm, type LbPool } from "../shared/lb-math.js";
import { buildDodoSegments, type DodoPool } from "../shared/dodo-math.js";
import { buildSolidlyStableSegments, type SolidlyStablePool } from "../shared/solidly-stable-math.js";
import { buildWombatSegments, type WombatPool } from "../shared/wombat-math.js";
import { buildWooFiSegments, type WooFiPool } from "../shared/woofi-math.js";
import { buildFermiSegments, type FermiPool } from "../shared/fermi-math.js";
import { buildFluidSegments, type FluidPool } from "../shared/fluid-math.js";
import { buildMentoSegments, type MentoPool } from "../shared/mento-math.js";
import { buildBalancerV3QLLadder, type BalancerV3Pool } from "../shared/balancer-v3-math.js";
import { buildEulerSwapSegments, type EulerSwapPool } from "../shared/eulerswap-math.js";
import { buildMaverickWalkLadder, type MaverickPool } from "../shared/maverick-math.js";
import { buildBalancerStableQLLadder, type BalancerStablePool } from "../shared/balancer-stable-math.js";
import { estimateExpectedOutput } from "./expected-output.js";
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
  type EcoWooFi,
  type EcoFermi,
  type EcoFluid,
  type EcoMento,
  type EcoBalancerV3,
  type EcoLegQlVenue,
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
 * HARD per-pool gas ceiling on the tick boundaries the lens scans per V3 pool in the swap
 * direction (the cache window's max size = the clamp HI). Per-pool the lens actually scans
 * effTicks = clamp(bandTicks/max(1,ts), 96, V3_TICK_STEPS) boundaries — a FIXED PRICE BAND,
 * not a fixed COUNT — so a tight ts=1 (0.01% stable tier) pool scans MANY boundaries to
 * cover the same % band a wide-ts pool covers in a few, while a wide-ts pool floors at 96
 * (byte-identical to the prior fixed window). Scanned in one eth_call; the on-chain solver
 * walks each pool's frontier from the LIVE spot and reuses the swap-drift-invariant net for
 * boundaries inside this window, staticcalling any boundary past it — so this only bounds
 * how much net the cache ships, not how far the walk reaches. Mirrors lens.ts LENS_MAX_TICKS.
 */
const V3_TICK_STEPS = LENS_MAX_TICKS;
/**
 * Target survivorship PRICE BAND in RAW ticks (the band the in-range-capacity metric + the
 * deactivation window cover per pool). effTicks = clamp(V3_BAND_TICKS/max(1,ts), 96,
 * V3_TICK_STEPS). 256 raw ticks ≈ a 2.6% band. Mirrors lens.ts LENS_BAND_TICKS. Override via
 * ECO_BAND_TICKS; 0 ⇒ every pool floors at 96 (the legacy fixed-96 window).
 */
const V3_BAND_TICKS = Number(process.env.ECO_BAND_TICKS ?? LENS_BAND_TICKS);
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
 * Default whole-trade slippage tolerance (bps) for the internal amountOutMin FLOOR the solver
 * self-enforces (defense-in-depth). `minOut = expectedTotalOut * (10000 - slipBps) / 10000`,
 * where `expectedTotalOut` is a CONSERVATIVE (lower-bound) off-chain estimate of the split's
 * whole-trade output (estimateExpectedOutput) — so the floor sits strictly below any legitimate
 * wei-exact fill and only fires on a genuine shortfall. Default 50 bps (0.5%); override with
 * ECO_SLIPPAGE_BPS, or per-call via prepareEcoSwap `opts.slippageBps`.
 *
 * NOTE: `slipBps` is the band around the ESTIMATE, not a guaranteed band around the realized
 * fill. Because the estimate is a conservative lower bound (and much looser in the common
 * no-net-window live-walk path — see estimateExpectedOutput's TIGHTNESS CAVEAT), the effective
 * floor is often well below `expected*(1 - slipBps)`. This internal floor is defense-in-depth
 * against a GROSS shortfall; integrators wanting a tight whole-trade minimum should enforce their
 * own around cook() (or pass an explicit `opts.minOut`).
 */
const DEFAULT_SLIPPAGE_BPS = Number(process.env.ECO_SLIPPAGE_BPS ?? 50);
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

// (fee → tickSpacing lives in shared/constants.ts TICK_SPACING_BY_FEE — the single source;
// prepare consumes tickSpacing from the lens rows and keeps no local copy.)

// ── Unified-walk per-pool net cache (the only per-pool prepare-time output) ──

const MOD128 = 1n << 128n;

/**
 * Stamp a V3/V4 EcoPool with the unified-walk per-pool cache from its lens read. The on-chain
 * solver walks each pool's live frontier from the LIVE spot and reuses the SWAP-drift-invariant NET
 * for the scanned window (an in-window staticcall avoided — so an LP mint/burn in the window after
 * prepare is NOT re-read; see EcoPool.windowTopShifted); it computes ALL sqrt/price on the
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
function lensToEcoPool(
  p: LensPool,
  zHop: boolean,
  sourceLabel: string,
  isDirect: boolean,
  isAlgebra = false,
): EcoPool {
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
    // Algebra dynamic-fee CL forks surface as UniV3 rows (lens); the solver reads globalState() (not
    // slot0()) for their spot — a real Algebra pool has NO slot0(). V4 is never Algebra.
    isAlgebra: isAlgebra && !isV4,
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
      worstMarginalOI: sm.worstMarginalOI,
    });
  }
  return brackets;
}

/**
 * Sample a Curve CryptoSwap pool via the bounded-Newton A-gamma replay (NO extra RPC — pure bigint on
 * the read A/gamma/price_scale/D/balances/fee params). Used ONLY as a LIVENESS PROBE now: CryptoSwap is
 * a QUOTE-LADDER (QL) venue (see index.ts buildQLVenues), so the on-chain solver builds its price ladder
 * live from get_dy and prepare ships only the descriptor — a pool that quotes no valid segment here is
 * dropped, but the returned brackets are NOT pushed to the segment stream. The on-chain solver executes
 * CALLBACK-FREE (get_dy staticcall for min_dy + approve + exchange(uint256,...) — crypto pools use
 * uint256 coin indices the engine's int128 _swapCurve does NOT match).
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
      worstMarginalOI: sm.worstMarginalOI,
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
      worstMarginalOI: sm.worstMarginalOI,
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
      worstMarginalOI: sm.worstMarginalOI,
    });
  }
  return brackets;
}

/**
 * Sample a Solidly STABLE (sAMM) pool via the bigint replay (NO extra RPC — pure bigint on the read
 * reserves/decimals/fee). Used ONLY as a LIVENESS PROBE now: Solidly STABLE is a QUOTE-LADDER (QL) venue
 * (see index.ts buildQLVenues), so the on-chain solver builds its price ladder live from getAmountOut and
 * prepare ships only the descriptor — a pool that quotes no valid segment here is dropped, but the
 * returned brackets are NOT pushed to the segment stream. The on-chain solver executes CALLBACK-FREE
 * (getAmountOut staticcall + transfer + pool.swap; the stable curve is x3y+y3x, NOT xy=k).
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
      worstMarginalOI: sm.worstMarginalOI,
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
      worstMarginalOI: sm.worstMarginalOI,
    });
  }
  return brackets;
}

/**
 * Sample a WOOFi (WooPPV2 sPMM) pool via the closed-form oracle-price replay at the snapshot (NO extra RPC
 * — pure bigint on the read price/spread/coeff/decimals/feeRate). Used ONLY as a LIVENESS PROBE now: WOOFi
 * is a QUOTE-LADDER (QL) venue (see index.ts buildQLVenues), so the on-chain solver builds its price ladder
 * live from tryQuery and prepare ships only the descriptor — a pool the snapshot sampler cannot quote is
 * dropped, but the returned brackets are NOT pushed to the segment stream. The on-chain solver executes
 * CALLBACK-FREE (query for minToAmount + transfer + pool.swap — WooPPV2 is transfer-first, oracle-priced).
 * Because the ladder is built live at cook time it re-anchors to the LIVE WooracleV2 (no snapshot).
 */
function buildWooFiBrackets(pool: WooFiPool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildWooFiSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.WOOFi,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the WOOFi swap fee (post-fee dy)
      sqrtAdjFar: sm.marginalOI,
      worstMarginalOI: sm.worstMarginalOI,
    });
  }
  return brackets;
}

/**
 * Build Fermi / propAMM (gattaca-com/propamm FermiSwapper — Obric-style proactive AMM) segments for one pool
 * by DIFFERENCING the LIVE quote ladder discovery sampled (NO extra RPC — the (cumIn, cumOut) points are on
 * the descriptor). Each (Δinput, Δoutput) slice becomes a STATIC segment (kind Fermi) in unified out/in
 * space, refIdx → the Fermi venue index. The marginal is the POST-FEE execution price (the router folds the
 * fee into the quote), so it enters the descending-price merge directly as both sqrtAdjNear and sqrtAdjFar.
 * The split is priced at the sampled SNAPSHOT ladder; the on-chain solver executes CALLBACK-FREE (a LIVE
 * quoteAmounts staticcall for amountCheck + approve + fermiSwapWithAllowances — propAMM PULLS via
 * transferFrom). The executed out re-reads the live quote at exec (see fermi-math.ts for the class).
 */
function buildFermiBrackets(pool: FermiPool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildFermiSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.Fermi,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the Fermi swap fee (post-fee dy)
      sqrtAdjFar: sm.marginalOI,
      worstMarginalOI: sm.worstMarginalOI,
    });
  }
  return brackets;
}

/**
 * Build Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — Liquidity-Layer-backed re-centering AMM)
 * segments for one pool by DIFFERENCING the LIVE estimateSwapIn ladder discovery sampled (NO extra RPC —
 * the (cumIn, cumOut) points are on the descriptor). Each (Δinput, Δoutput) slice becomes a STATIC segment
 * (kind Fluid) in unified out/in space, refIdx → the Fluid venue index. The marginal is the POST-FEE +
 * POST-CAP execution price (the pool folds fee + utilization into the resolver estimate), so it enters the
 * descending-price merge directly as both sqrtAdjNear and sqrtAdjFar. The split is priced at the sampled
 * SNAPSHOT ladder; the on-chain solver executes CALLBACK-FREE (a LIVE resolver estimateSwapIn staticcall
 * for amountOutMin + approve + pool.swapIn — Fluid PULLS via safeTransferFrom). The executed out re-reads
 * the live estimate at exec (see fluid-math.ts for the SNAPSHOTTED-QUOTE class).
 */
function buildFluidBrackets(pool: FluidPool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildFluidSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.Fluid,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the Fluid fee + cap (post-fee dy)
      sqrtAdjFar: sm.marginalOI,
      worstMarginalOI: sm.worstMarginalOI,
    });
  }
  return brackets;
}

/**
 * Build Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager) segments for one venue by
 * DIFFERENCING the LIVE Broker getAmountOut ladder discovery sampled (NO extra RPC — the (cumIn, cumOut)
 * points are on the descriptor). Each (Δinput, Δoutput) slice becomes a STATIC segment (kind Mento) in
 * unified out/in space, refIdx → the Mento venue index. The marginal is the POST-SPREAD execution price (the
 * exchange folds the spread into getAmountOut), so it enters the descending-price merge directly as both
 * sqrtAdjNear and sqrtAdjFar. The split is priced at the sampled bucket SNAPSHOT ladder; the on-chain solver
 * executes CALLBACK-FREE (a LIVE Broker getAmountOut staticcall for amountOutMin + approve the BROKER +
 * broker.swapIn — Mento PULLS via transferFrom into the reserve). The executed out re-reads the live quote
 * at exec (see mento-math.ts for the SNAPSHOTTED-QUOTE class).
 */
function buildMentoBrackets(pool: MentoPool, refIdx: number, amountIn: bigint): EcoBracket[] {
  const segs = buildMentoSegments(pool, amountIn);
  const brackets: EcoBracket[] = [];
  for (const sm of segs) {
    brackets.push({
      kind: EcoBracketKind.Mento,
      refIdx,
      sqrtNear: sm.marginalOI,
      sqrtFar: sm.marginalOI,
      liquidity: 0n,
      capacity: sm.capacity,
      sqrtAdjNear: sm.marginalOI, // marginalOI already nets the Mento spread (post-spread dy)
      sqrtAdjFar: sm.marginalOI,
      worstMarginalOI: sm.worstMarginalOI,
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
      worstMarginalOI: sm.worstMarginalOI,
    });
  }
  return brackets;
}

/** Round a Balancer swap fee (1e18-WAD) to ppm (the price-ordering coordinate / diagnostics). */
function balancerFeeToPpm(swapFeeWad: bigint): number {
  return Number((swapFeeWad * 1_000_000n + 5n * 10n ** 17n) / 10n ** 18n);
}

// ── Shared per-pair QL venue discovery (the DIRECT pair AND every route-leg edge) ──

/**
 * One discovered QUOTE-LADDER venue for a (pairIn → pairOut) token pair: the DIRECTION-STAMPED
 * per-family descriptor tagged with its family (the `EcoLegQlVenue` shape — for the DIRECT pair
 * the same descriptors are split back into the per-family `prepared` lists), plus the venue's
 * liveness-probe FIRST-SLICE head (post-fee out/in sqrt Q96). The head feeds the route DFS's
 * `estIn` fold when an upstream leg has NO pools (an all-QL leg) — prepare-time sizing only,
 * never a merge input (the on-chain ladders re-size from live state at cook).
 */
interface EdgeQlVenue {
  venue: EcoLegQlVenue;
  headOI: bigint;
}

/**
 * Discover every QUOTE-LADDER (QL) venue serving ONE token pair — the 13 leg-capable families
 * (Curve StableSwap, Curve CryptoSwap, Solidly STABLE, WOOFi, Trader Joe LB, Mento V2, DODO V2,
 * Wombat, Fermi, EulerSwap, Balancer V3, Balancer V2 ComposableStable, Maverick V2), run in the
 * canonical family-concatenation order (the same order index.ts buildQLVenues emits rows in).
 * This is the SINGLE discovery path for QL venues: the DIRECT (tokenIn, tokenOut) pair calls it
 * with `probeAmount = amountIn`, and every route-leg EDGE calls it with the edge pair + the
 * DFS-folded `estIn` — so a leg venue descriptor is built by EXACTLY the code (and direction
 * stamping: i/j coin indices, isSellBase, swapForY, tokenAIn, inIdx/outIdx, rate/decScale
 * columns) a direct venue would be. Fluid is deliberately ABSENT: it is a static-sampled-segment
 * venue (segKind 12) the solver cannot ladder on-chain, so it stays DIRECT-only (prepare keeps
 * its own block).
 *
 * Each family block is gated on the chain config carrying that FactoryType — a family absent
 * from ChainPoolConfig costs ZERO RPC. Each discovered pool runs its family's existing LIVENESS
 * probe (the build*Brackets / build*QLLadder replay at `probeAmount`): a venue that quotes no
 * valid slice is dropped (born-dead at this size). The probe output is ONLY a gate + the fold
 * head — no sampled segments ship (prepare-optional: the on-chain solver builds every ladder
 * live from its quote view / bin-walk at cook).
 */
async function discoverQlVenuesForPair(
  pairIn: Hex,
  pairOut: Hex,
  probeAmount: bigint,
  client: PublicClient,
  poolConfig: ChainPoolConfig,
  dodoCaller: Hex,
): Promise<EdgeQlVenue[]> {
  const out: EdgeQlVenue[] = [];

  // Curve StableSwap — registry find_pool_for_coins → get_coin_indices (int128 i,j — DIRECTIONAL,
  // so the edge orientation falls out of the registry read). The on-chain solver builds the ladder
  // from LIVE get_dy; the descriptor ships address + i/j + fee only.
  const curveRegistries = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.CurveRegistry,
  );
  if (curveRegistries.length > 0) {
    const curveRaw = await discoverCurvePoolsTyped(pairIn, pairOut, client, curveRegistries);
    for (const c of curveRaw) {
      // Liveness probe only — the QL ladder is built on-chain, not from these brackets.
      const cb = buildCurveBrackets(c, 0, probeAmount);
      if (cb.length === 0) continue;
      out.push({
        venue: {
          family: "curve",
          desc: {
            address: c.address,
            i: c.i,
            j: c.j,
            feePpm: curveFeeToPpm(c.feePpm10),
            source: `${c.source} (Curve)`,
          },
        },
        headOI: cb[0].sqrtAdjNear,
      });
    }
  }

  // Curve CryptoSwap — crypto Metaregistry lookup (uint256 i,j; A-gamma invariant + dynamic fee).
  // Executed CALLBACK-FREE (uint256-index exchange — the engine's int128 _swapCurve does not match).
  const cryptoRegistries = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.CurveCryptoRegistry,
  );
  if (cryptoRegistries.length > 0) {
    const cryptoRaw = await discoverCryptoSwapPoolsTyped(pairIn, pairOut, client, cryptoRegistries);
    for (const cp of cryptoRaw) {
      const cb = buildCryptoSwapBrackets(cp, 0, probeAmount);
      if (cb.length === 0) continue;
      out.push({
        venue: {
          family: "cryptoSwap",
          desc: {
            address: cp.address,
            i: cp.i,
            j: cp.j,
            feePpm: cp.feePpm,
            source: `${cp.source} (Curve CryptoSwap)`,
          },
        },
        headOI: cb[0].sqrtAdjNear,
      });
    }
  }

  // Solidly STABLE (sAMM — x3y+y3x, NOT xy=k) — the on-chain ladder reads LIVE getAmountOut;
  // executed callback-free (getAmountOut + transfer + pool.swap). inIsToken0 is per-edge.
  const solidlyFactories = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.SolidlyV2,
  );
  if (solidlyFactories.length > 0) {
    const stableRaw = await discoverSolidlyStablePoolsTyped(pairIn, pairOut, client, solidlyFactories);
    for (const sp of stableRaw) {
      const sb = buildSolidlyStableBrackets(sp, 0, probeAmount);
      if (sb.length === 0) continue;
      out.push({
        venue: {
          family: "solidlyStable",
          desc: {
            address: sp.address,
            inIsToken0: sp.inIsToken0,
            feePpm: sp.feePpm,
            source: sp.source,
          },
        },
        headOI: sb[0].sqrtAdjNear,
      });
    }
  }

  // WOOFi (WooPPV2 sPMM, oracle-priced) — only a DIRECT base↔quote pair is in scope (discovery
  // self-gates); the on-chain ladder reads LIVE tryQuery and re-anchors to the live oracle.
  const woofiConfigs = poolConfig.factories.filter((f) => f.factoryType === FactoryType.WOOFi);
  if (woofiConfigs.length > 0) {
    const wooRaw = await discoverWooFiPoolsTyped(pairIn, pairOut, client, woofiConfigs);
    for (const wp of wooRaw) {
      const wb = buildWooFiBrackets(wp, 0, probeAmount);
      if (wb.length === 0) continue;
      out.push({
        venue: {
          family: "wooFi",
          desc: {
            address: wp.address,
            fromToken: wp.tokenIn,
            toToken: wp.tokenOut,
            feePpm: wp.feePpm,
            source: wp.source,
          },
        },
        headOI: wb[0].sqrtAdjNear,
      });
    }
  }

  // Trader Joe LB (discrete-bin constant-sum) — the on-chain ladder reads the LIVE graceful
  // getSwapOut view; swapForY = (pairIn == pair.getTokenX()) is per-edge.
  const lbFactories = poolConfig.factories.filter((f) => f.factoryType === FactoryType.TraderJoeLB);
  if (lbFactories.length > 0) {
    const lbRaw = await discoverTraderJoeLBPoolsTyped(pairIn, pairOut, client, lbFactories);
    for (const lb of lbRaw) {
      const lbb = buildLbBrackets(lb, 0, probeAmount);
      if (lbb.length === 0) continue;
      out.push({
        venue: {
          family: "lb",
          desc: {
            address: lb.address,
            binStep: lb.binStep,
            feePpm: lbFeeToPpm(lb.binStep, lb.baseFactor),
            swapForY: lb.swapForY,
            source: lb.source,
          },
        },
        headOI: lbb[0].sqrtAdjNear,
      });
    }
  }

  // Mento V2 (Broker + BiPoolManager, oracle-priced buckets) — two-step enumeration maps the
  // pair → (exchangeProvider, exchangeId); the on-chain ladder reads the LIVE Broker getAmountOut.
  const mentoConfigs = poolConfig.factories.filter((f) => f.factoryType === FactoryType.Mento);
  if (mentoConfigs.length > 0) {
    const mentoRaw = await discoverMentoPoolsTyped(pairIn, pairOut, client, mentoConfigs, probeAmount);
    for (const mp of mentoRaw) {
      const mb = buildMentoBrackets(mp, 0, probeAmount);
      if (mb.length === 0) continue;
      out.push({
        venue: {
          family: "mento",
          desc: {
            broker: mp.broker,
            exchangeProvider: mp.exchangeProvider,
            exchangeId: mp.exchangeId,
            fromToken: mp.tokenIn,
            toToken: mp.tokenOut,
            feePpm: mp.feePpm,
            source: mp.source,
          },
        },
        headOI: mb[0].sqrtAdjNear,
      });
    }
  }

  // DODO V2 PMM — the on-chain ladder reads LIVE querySellBase/querySellQuote; sellBase =
  // (pairIn == _BASE_TOKEN_()) is per-edge.
  const dodoZoos = poolConfig.factories.filter((f) => f.factoryType === FactoryType.DODOZoo);
  if (dodoZoos.length > 0) {
    const dodoRaw = await discoverDodoV2PoolsTyped(pairIn, pairOut, client, dodoZoos, dodoCaller);
    for (const d of dodoRaw) {
      const db = buildDodoBrackets(d, 0, probeAmount);
      if (db.length === 0) continue;
      out.push({
        venue: {
          family: "dodo",
          desc: {
            address: d.address,
            sellBase: d.sellBase,
            feePpm: d.feePpm,
            source: `${d.source} (DODO V2)`,
          },
        },
        headOI: db[0].sqrtAdjNear,
      });
    }
  }

  // Wombat (single-sided stableswap; multi-ASSET pool — one pool can serve several pairs, which
  // is exactly why leg admission claims by pool ADDRESS) — LIVE quotePotentialSwap ladder.
  const wombatPools = poolConfig.factories.filter((f) => f.factoryType === FactoryType.Wombat);
  if (wombatPools.length > 0) {
    const wombatRaw = await discoverWombatPoolsTyped(pairIn, pairOut, client, wombatPools);
    for (const wp of wombatRaw) {
      const wb = buildWombatBrackets(wp, 0, probeAmount);
      if (wb.length === 0) continue;
      out.push({
        venue: {
          family: "wombat",
          desc: {
            address: wp.address,
            fromToken: wp.tokenIn,
            toToken: wp.tokenOut,
            feePpm: wp.feePpm,
            source: wp.source,
          },
        },
        headOI: wb[0].sqrtAdjNear,
      });
    }
  }

  // Fermi / propAMM (FermiSwapper router) — LIVE quoteAmounts ladder; the descriptor address is
  // the ROUTER (the quote/exec target — Fermi exposes no per-pair pool contract).
  const fermiConfigs = poolConfig.factories.filter((f) => f.factoryType === FactoryType.Fermi);
  if (fermiConfigs.length > 0) {
    const fermiRaw = await discoverFermiPoolsTyped(pairIn, pairOut, client, fermiConfigs, probeAmount);
    for (const fp of fermiRaw) {
      const fb = buildFermiBrackets(fp, 0, probeAmount);
      if (fb.length === 0) continue;
      out.push({
        venue: {
          family: "fermi",
          desc: {
            address: fp.address,
            fromToken: fp.tokenIn,
            toToken: fp.tokenOut,
            feePpm: fp.feePpm,
            source: fp.source,
          },
        },
        headOI: fb[0].sqrtAdjNear,
      });
    }
  }

  // EulerSwap — known-pool-address discovery (per-config eulerSwapPools); the on-chain ladder
  // reads LIVE computeQuote (self-truncating at the vault cap). inIsToken0 is per-edge.
  const eulerFactories = poolConfig.factories.filter((f) => f.factoryType === FactoryType.EulerSwap);
  if (eulerFactories.length > 0) {
    const eulerRaw = await discoverEulerSwapPoolsTyped(pairIn, pairOut, client, eulerFactories);
    for (const ep of eulerRaw) {
      const eb = buildEulerSwapBrackets(ep, 0, probeAmount);
      if (eb.length === 0) continue;
      out.push({
        venue: {
          family: "euler",
          desc: {
            address: ep.address,
            inIsToken0: ep.inIsToken0,
            feePpm: ep.feePpm,
            source: ep.source,
          },
        },
        headOI: eb[0].sqrtAdjNear,
      });
    }
  }

  // Balancer V3 — known-pool-address discovery; the on-chain solver REPLAYS StableMath from the
  // LIVE Vault state (querySwapSingleTokenExactIn is eth_call-only). inIdx/outIdx + rpIn/rpOut +
  // decScaleIn/decScaleOut are the per-edge orientation columns; the surge cross-check runs per
  // edge inside the discovery.
  const balancerV3Configs = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.BalancerV3,
  );
  if (balancerV3Configs.length > 0) {
    const b3Raw = await discoverBalancerV3PoolsTyped(pairIn, pairOut, client, balancerV3Configs, probeAmount);
    for (const bp of b3Raw) {
      const qb = buildBalancerV3QLLadder(bp, probeAmount);
      if (qb.length === 0) continue;
      out.push({
        venue: {
          family: "balancerV3",
          desc: {
            address: bp.address,
            router: bp.router,
            fromToken: bp.tokenIn,
            toToken: bp.tokenOut,
            feePpm: bp.feePpm,
            source: bp.source,
            vault: bp.vault!,
            inIdx: bp.inIdx!,
            outIdx: bp.outIdx!,
            rpIn: bp.rpIn!,
            rpOut: bp.rpOut!,
            decScaleIn: bp.decScaleIn!,
            decScaleOut: bp.decScaleOut!,
          },
        },
        headOI: qb[0].marginalOI,
      });
    }
  }

  // Balancer V2 ComposableStable (multi-TOKEN pool — address-claimed for the same reason as
  // Wombat) — the on-chain solver replays StableMath from the LIVE Vault scalars; the qd[6..9]
  // block (non-BPT i/j + poolId + third token + regPos) is computed against the EDGE pair.
  const balancerVaults = poolConfig.factories.filter((f) => f.factoryType === FactoryType.BalancerV2);
  if (balancerVaults.length > 0) {
    const balRaw = await discoverBalancerStablePoolsTyped(pairIn, pairOut, client, balancerVaults);
    for (const bp of balRaw) {
      const qb = buildBalancerStableQLLadder(bp, probeAmount);
      if (qb.length === 0) continue;
      out.push({
        venue: {
          family: "balancerV2",
          desc: {
            address: bp.address,
            i: bp.i,
            j: bp.j,
            feePpm: balancerFeeToPpm(bp.swapFeeWad),
            source: bp.source,
            poolId: bp.poolId!,
            nonBptTokens: bp.tokens!,
            nonBptRegPos: bp.regPos!,
            vault: bp.vault!,
          },
        },
        headOI: qb[0].marginalOI,
      });
    }
  }

  // Maverick V2 (bin-based directional AMM; a CALLBACK pool executed through the engine) — the
  // on-chain solver WALKS the live bin book; tokenAIn = (pairIn == tokenA) is per-edge. Discovery
  // skips mixed-decimal pairs (maverick-math is D18-normalized).
  const maverickFactories = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.MaverickV2Factory,
  );
  if (maverickFactories.length > 0) {
    const maverickRaw = await discoverMaverickV2PoolsTyped(pairIn, pairOut, client, maverickFactories);
    for (const mp of maverickRaw) {
      const ml = buildMaverickWalkLadder(mp, probeAmount);
      if (ml.length === 0) continue;
      out.push({
        venue: {
          family: "maverick",
          desc: {
            address: mp.address,
            tokenAIn: mp.tokenAIn,
            tickSpacing: mp.tickSpacing,
            feePpm: mp.feePpm,
            source: `${mp.source} (Maverick V2)`,
          },
        },
        headOI: ml[0].marginalOI,
      });
    }
  }

  return out;
}

/**
 * The claim-set identity of a QL venue — the venue's POOL address for 12 families; Mento (whose
 * venues all share the chain-wide Broker/provider contracts) claims by `provider|exchangeId`.
 * Lowercased so it unions safely with the pool-address claim set (one shared mechanism — a UniV3
 * address never collides with a Curve address). Claiming by POOL address (not by pair) is the
 * multi-coin rule: a 3-coin Curve/CryptoSwap pool, a 3-token Balancer pool or a multi-asset
 * Wombat pool holding {A, X, B} is discoverable on BOTH legs of one route A→X→B (and as a direct
 * (A,B) venue) — every instance prices ladders over the SAME pool inventory, so at most ONE may
 * be admitted. (For Fermi the address is the ROUTER — two pairs through one router claim-collide;
 * deliberately conservative: an excluded second instance forgoes a venue, never double-counts.)
 */
function mentoClaimKey(exchangeProvider: string, exchangeId: string): string {
  return `${exchangeProvider.toLowerCase()}|${exchangeId.toLowerCase()}`;
}

function qlVenueClaimKey(v: EcoLegQlVenue): string {
  if (v.family === "mento") {
    return mentoClaimKey(v.desc.exchangeProvider, v.desc.exchangeId);
  }
  return v.desc.address.toLowerCase();
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
   * Override the lens HARD forward-tick gas ceiling (the clamp HI + outer loop bound;
   * default V3_TICK_STEPS = LENS_MAX_TICKS). Per-pool the lens scans effTicks =
   * clamp(bandTicks/max(1,ts), 96, maxTicks). Lets the adaptive EVM test deliberately
   * prepare a NARROW window so the prepared brackets under-fill amountIn — then the
   * always-on streaming walk resumes from the frontier seed to close the gap.
   */
  maxTicks?: number;
  /**
   * Override the target survivorship PRICE BAND in RAW ticks (default V3_BAND_TICKS =
   * LENS_BAND_TICKS). effTicks = clamp(bandTicks/max(1,ts), 96, maxTicks): a tight ts=1
   * (0.01% stable tier) pool gets many boundaries to cover the same % band a wide-ts pool
   * covers in a few, so its in-range-capacity survivorship metric + deactivation window is
   * a fixed price band. 0 ⇒ every pool floors at 96 (legacy fixed window).
   */
  bandTicks?: number;
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
  /**
   * Whole-trade slippage tolerance (bps) for the solver's INTERNAL amountOutMin floor
   * (defense-in-depth; the caller should still enforce its own min around cook()). The
   * floor is `minOut = expectedTotalOut * (10000 - slippageBps) / 10000`, where
   * expectedTotalOut is a CONSERVATIVE lower-bound estimate of the split's output — so it
   * NEVER false-reverts a legitimate wei-exact fill. Default DEFAULT_SLIPPAGE_BPS
   * (ECO_SLIPPAGE_BPS env or 50 = 0.5%). Set 0 to disable the internal floor (minOut 0 ⇒
   * byte-identical to the pre-floor solver behavior).
   */
  slippageBps?: number;
  /**
   * EXPLICIT whole-trade amountOutMin floor (wei of tokenOut) — when set, it OVERRIDES the
   * `slippageBps`-derived estimate entirely and is used as `minOut` verbatim. For a caller
   * that already computed its own minimum (e.g. from an external quote), or a test asserting
   * the floor fires. Unset ⇒ the estimate path (the normal defense-in-depth floor).
   */
  minOut?: bigint;
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
  const bandTicks = opts.bandTicks ?? V3_BAND_TICKS;
  const slippageBps = opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
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
    bandTicks,
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
  // Algebra survivors: the lens emits an Algebra pool as a UniV3 row (indistinguishable downstream),
  // so resolve which survivor addresses are Algebra via a light off-chain poolByPair lookup on the
  // Algebra factories, then stamp EcoPool.isAlgebra on them so the solver reads globalState() (not
  // slot0()) for their spot. Empty set when the chain carries no Algebra factory (zero extra RPC).
  const algebraFactories = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.AlgebraV3,
  );
  const algebraAddrs =
    algebraFactories.length > 0
      ? await discoverAlgebraPoolAddresses(tokenIn, tokenOut, client, algebraFactories)
      : new Set<string>();
  const isAlgebraPool = (p: LensPool): boolean =>
    algebraAddrs.size > 0 && algebraAddrs.has(p.address.toLowerCase());

  const v3Raw = usableDirect.filter((p) => p.poolType === SwapPoolType.UniV3);
  const v4Raw = usableDirect.filter((p) => p.poolType === SwapPoolType.UniV4);
  // Constant-product (Uniswap-V2-style) pools execute via the unified
  // swap(SwapParams) entry (poolType=UniV2); the on-chain solver streams them
  // from live reserves. The engine's _swapV2 hardcodes the 0.3% fee.
  const v2Raw = usableDirect.filter((p) => p.poolType === SwapPoolType.UniV2);

  // ── Build DIRECT pool descriptors + per-pool net caches ──
  // Every direct pool ships only its swap-drift-invariant NET cache (no prepared sqrt edges): the
  // on-chain solver walks each pool's LIVE frontier and reuses the net. V2 streams constant-L
  // from live reserves (no tick cache). The single lensToEcoPool builder is reused for routes.
  const pools: EcoPool[] = [];
  for (const p of v3Raw) pools.push(lensToEcoPool(p, zeroForOne, "lens V3", true, isAlgebraPool(p)));
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

  // ── Solidly VOLATILE (vAMM) pools (off-chain discovery — NOT in the lens) ──
  // A vAMM is a plain xy=k V2 curve with a PER-POOL fee — some of the deepest constant-product venues
  // on Solidly chains (Aerodrome/Velodrome/Thena/Ramses/SwapX/Shadow). The on-chain lens structurally
  // EXCLUDES Solidly factories (they expose getPool(a,b,bool), not the getPair(a,b) the lens's V2 path
  // calls — feeding one to the lens would revert the whole eth_call), so they are discovered here (like
  // Kyber) via getPool(a,b,false) and appended to the DIRECT V2-family set: each seeds the SAME
  // constant-L V2 stream the solver/oracle/reference walk (L = √(rIn·rOut), spot out/in = √(rOut/rIn))
  // from LIVE getReserves, carries its per-pool fee, and executes via the existing callback-free V2
  // path. Aliveness is the `>0` reserve gate (the lens's relative-depth survivor filter is V2/V3/V4 —
  // getPair — only; Kyber and Solidly-volatile survive on liveness, matching the Kyber convention).
  const solidlyVolFactories = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.SolidlyV2,
  );
  if (solidlyVolFactories.length > 0) {
    const volRaw = await discoverSolidlyVolatilePoolsTyped(tokenIn, tokenOut, client, solidlyVolFactories);
    for (const v of volRaw) {
      if (v.reserveIn <= 0n || v.reserveOut <= 0n) continue;
      const synthL = isqrt(v.reserveIn * v.reserveOut); // √(rIn·rOut)
      const spotOI = isqrt((v.reserveOut * Q192) / v.reserveIn); // out/in spot from live reserves
      pools.push({
        poolType: SwapPoolType.UniV2,
        address: v.address,
        fee: v.feePpm,
        tickSpacing: 0,
        hooks: ZERO_ADDRESS,
        feePpm: v.feePpm,
        isV2: true,
        inIsToken0: v.inIsToken0,
        stateView: ZERO_ADDRESS,
        poolId: ZERO_BYTES32,
        spotNearReal: spotOI, // out/in spot (V2 frontier seed)
        spotActiveL: synthL, // √(rIn·rOut)
        source: v.source,
      });
    }
  }

  // ── QUOTE-LADDER (QL) venue discovery for the DIRECT pair (the 13 leg-capable families) ──
  // Runs the SHARED per-pair discovery (discoverQlVenuesForPair — the exact path every route-leg
  // EDGE runs below), then splits the tagged descriptors back into the per-family prepared lists
  // (family order preserved: the shared function emits families in the canonical buildQLVenues
  // concatenation order, discovery order within each family). These are all QL venues: the
  // on-chain solver builds each price ladder LIVE at cook from the venue's own quote view /
  // state replay / bin-walk, so prepare ships ONLY direction-stamped descriptors — the
  // build*Brackets / build*QLLadder replays ran inside the shared discovery as pure LIVENESS
  // probes at amountIn (a venue quoting no valid slice was dropped). `brackets` now carries
  // ONLY Fluid sampled segments (Fluid is the one static-sampled-segment source left — it is
  // NOT leg-capable and keeps its own direct-only block below).
  const brackets: EcoBracket[] = [];
  const directQl = await discoverQlVenuesForPair(
    tokenIn,
    tokenOut,
    amountIn,
    client,
    poolConfig,
    caller ?? ZERO_ADDRESS,
  );
  const qlFamilyDescs = <T,>(family: EcoLegQlVenue["family"]): T[] =>
    directQl.filter((e) => e.venue.family === family).map((e) => e.venue.desc as T);
  const curves = qlFamilyDescs<EcoCurve>("curve");
  const cryptoSwaps = qlFamilyDescs<EcoCryptoSwap>("cryptoSwap");
  const solidlyStables = qlFamilyDescs<EcoSolidlyStable>("solidlyStable");
  const wooFiPools = qlFamilyDescs<EcoWooFi>("wooFi");
  const lbs = qlFamilyDescs<EcoLb>("lb");
  const mentoPools = qlFamilyDescs<EcoMento>("mento");
  const dodos = qlFamilyDescs<EcoDodo>("dodo");
  const wombats = qlFamilyDescs<EcoWombat>("wombat");
  const fermiPools = qlFamilyDescs<EcoFermi>("fermi");
  const eulerSwaps = qlFamilyDescs<EcoEulerSwap>("euler");
  const balancerV3Pools = qlFamilyDescs<EcoBalancerV3>("balancerV3");
  const balancerStables = qlFamilyDescs<EcoBalancerStable>("balancerV2");
  const maverickPools = qlFamilyDescs<EcoMaverick>("maverick");

  const fluidPools: EcoFluid[] = [];
  const fluidBracketSets: EcoBracket[][] = [];
  // Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — Liquidity-Layer-backed re-centering AMM) —
  // KNOWN-POOL-ADDRESS discovery (FactoryConfig.fluidPools + FactoryConfig.fluidResolver). Fluid prices off
  // the Liquidity-Layer supply/borrow exchange prices + a center price + utilization caps (canonical
  // on-chain state, NOT xy=k), so it is a SAMPLED-SEGMENT source. The DexT1 pool exposes NO getAmountOut
  // view (its own estimate is a REVERT), so `discoverFluidPoolsTyped` orients the pair via the resolver's
  // getDexTokens (the pool has NO token0()/token1() getters — token0/token1 live only inside
  // constantsView()'s struct) and SAMPLES a LIVE ladder via the periphery RESOLVER's estimateSwapIn over
  // [0, amountIn]; the split is
  // built from that ladder (no closed form). Executed CALLBACK-FREE (a live resolver estimateSwapIn
  // staticcall for amountOutMin + approve + pool.swapIn — Fluid PULLS via safeTransferFrom, so approve-
  // first, unlike WOOFi's transfer-first path). NO engine change. SNAPSHOTTED-QUOTE class: the split is
  // exact-on-grid vs the oracle on the shared sampled ladder; the exec re-reads the live estimate
  // (amountOutMin bounds a bad fill). The layer prices accrue every block + caps can shrink between prepare
  // and cook — the same snapshot assumption the recipe documents for Fermi / WOOFi / V3 fee, plus the
  // EulerSwap-style cap bound (the sampler stops at the first 0-quote slice; the terminal refund covers a
  // cap that shrank before cook).
  const fluidConfigs = poolConfig.factories.filter((f) => f.factoryType === FactoryType.Fluid);
  if (fluidConfigs.length > 0) {
    const fluidRaw = await discoverFluidPoolsTyped(tokenIn, tokenOut, client, fluidConfigs, amountIn);
    for (const fp of fluidRaw) {
      const refIdx = fluidPools.length;
      const fb = buildFluidBrackets(fp, refIdx, amountIn);
      if (fb.length === 0) continue;
      fluidPools.push({
        address: fp.address,
        resolver: fp.resolver,
        swap0to1: fp.swap0to1,
        fromToken: fp.tokenIn,
        toToken: fp.tokenOut,
        feePpm: fp.feePpm,
        source: fp.source,
      });
      fluidBracketSets.push(fb);
    }
  }
  for (const set of fluidBracketSets) brackets.push(...set);

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
  // DIRECTED memo key (hopIn→hopOut). Under driftTicks:0 the lens walks + emits net rows ONLY on
  // the SWAP-DIRECTION (deep) side of spot, and stampPoolCache windows that SAME side (per the
  // leg's zHop). An UNORDERED key would let the REVERSE hop reuse a forward read whose net rows lie
  // on the opposite side of spot, so stampPoolCache's in-window precondition (a reversed window
  // holding none of those rows) throws → the whole prepareEcoSwap rejects (a default mainnet config
  // with ≥2 interior base tokens reads at least one interior↔interior edge in both directions and
  // hits this). Keying by DIRECTION runs one lens read per hop direction, each walking the correct
  // side, so a reverse edge stamps in-window. One extra lens read per reversed edge — an RPC cost,
  // not a correctness one; a same-direction shared edge (WETH↔X used by several paths) still reads
  // once.
  const edgeKey = (a: Hex, b: Hex): string => `${a.toLowerCase()}|${b.toLowerCase()}`;
  // Algebra survivors on a route edge: like direct pools, an Algebra leg pool surfaces as a UniV3 row
  // and MUST be stamped isAlgebra so the solver reads globalState() (not slot0()) for it — else the
  // route cook reverts on the leg's slot0() call. Resolved per edge (memoized), zero RPC when the
  // chain carries no Algebra factory. Keyed by the SAME directed edgeKey as readEdge.
  const algebraEdgeCache = new Map<string, Promise<Set<string>>>();
  const readEdgeAlgebra = (hopIn: Hex, hopOut: Hex): Promise<Set<string>> => {
    if (algebraFactories.length === 0) return Promise.resolve(new Set<string>());
    const key = edgeKey(hopIn, hopOut);
    let pending = algebraEdgeCache.get(key);
    if (!pending) {
      pending = discoverAlgebraPoolAddresses(hopIn, hopOut, client, algebraFactories);
      algebraEdgeCache.set(key, pending);
    }
    return pending;
  };
  const readEdge = (hopIn: Hex, hopOut: Hex): Promise<LensResult> => {
    const key = edgeKey(hopIn, hopOut);
    let pending = edgeCache.get(key);
    if (!pending) {
      // The lens read is walked in THIS hop's swap direction (zeroForOne below), so it emits net
      // rows on the deep side stampPoolCache windows for the same direction — the reverse hop keys
      // a SEPARATE read (see edgeKey). Every path touching this edge in the SAME direction reuses it.
      pending = runLens(client, lensCookEntry, poolConfig, {
        tokenIn: hopIn,
        tokenOut: hopOut,
        zeroForOne: BigInt(hopIn) < BigInt(hopOut),
        amountIn,
        driftTicks: 0, // like direct pools — the solver reads drift LIVE.
        minRelBps,
        maxTicks,
        bandTicks,
        target,
        account: caller,
        includeAlgebra: true, // Algebra is executable (engine services algebraSwapCallback, sauce#186).
      });
      edgeCache.set(key, pending);
    }
    return pending;
  };
  // QL venue discovery per edge — the SAME per-family typed discovery + liveness probes the
  // DIRECT pair ran (discoverQlVenuesForPair), called with the EDGE pair so every descriptor is
  // direction-stamped for the leg (i/j, isSellBase, swapForY, tokenAIn, inIdx/outIdx, …).
  // MEMOIZED per DIRECTED edge with the SAME edgeKey as readEdge (direction matters: every
  // orientation field above is per-direction). A family absent from ChainPoolConfig costs 0 RPC.
  //
  // SESSION-LEAD DECISION — the liveness-probe amount `estIn` rides the memo: the FIRST DFS path
  // to touch a directed edge fixes the probe amount every later path sharing that edge reuses
  // (two paths reaching the same edge through different upstream legs would fold different
  // estimates). Accepted deliberately: the probe gates LIVENESS ONLY (is the venue quotable at
  // roughly this size?) — the merge NEVER consumes probe output, since the on-chain ladders are
  // re-sized and re-built from LIVE state at cook. A pathological shared edge with wildly
  // different upstream estimates could at worst mis-drop (or keep) a borderline venue — a
  // split-quality tail effect, never a correctness one.
  const qlEdgeCache = new Map<string, Promise<EdgeQlVenue[]>>();
  const readEdgeQl = (hopIn: Hex, hopOut: Hex, estIn: bigint): Promise<EdgeQlVenue[]> => {
    const key = edgeKey(hopIn, hopOut);
    let pending = qlEdgeCache.get(key);
    if (!pending) {
      pending = discoverQlVenuesForPair(hopIn, hopOut, estIn, client, poolConfig, caller ?? ZERO_ADDRESS);
      qlEdgeCache.set(key, pending);
    }
    return pending;
  };
  // Fold a leg's best-member head into the DFS's downstream probe estimate: the leg converts
  // `est` of its hopIn into ≈ est · h²/2^192 of its hopOut (h = post-fee out/in sqrt Q96), the
  // same two-step floor fold the on-chain sizing prelude computes from live setup heads. h==0
  // (an empty leg cannot happen — buildLeg returns null) would fold to 0, which simply probes
  // downstream venues at 0 ⇒ they drop (a dead upstream ⇒ the venue could never be fed anyway).
  const foldEstIn = (est: bigint, headOI: bigint): bigint =>
    (((est * headOI) / Q96) * headOI) / Q96;

  /**
   * Build a leg from a memoized edge read, keeping EVERY survivor pool the lens returned for the
   * edge — V2, V3 and hookless V4 alike (the leg-internal merge + N-hop chain are type-agnostic)
   * — PLUS every live QL venue the shared per-edge discovery surfaced (the leg's quote-ladder
   * members, direction-stamped for this edge). Each leg pool is stamped with the LEG's hop
   * direction zHop exactly like a direct pool of its type (V2 via the live-reserves seed, V3/V4
   * via the net cache). Returns null only when the edge has NO members at all (no pools AND no
   * venues — a venue-only leg is a valid leg). A V4 survivor WITH hooks is excluded (the unified
   * swap path is hookless-V4 only). `estIn` is the DFS-folded prepare-time estimate of the
   * tokenIn flow reaching this edge — the venue liveness-probe amount (see readEdgeQl).
   *
   * Also returns the leg's best-member HEAD (post-fee out/in sqrt Q96) for the DFS fold: the max
   * over the leg pools' fee-adjusted live spots (the lens read), falling back to the venues'
   * probe-ladder first-slice heads only when the leg has no pools (the all-QL-leg case).
   */
  const buildLeg = async (
    hopIn: Hex,
    hopOut: Hex,
    estIn: bigint,
  ): Promise<{ leg: EcoLeg; headOI: bigint } | null> => {
    const zHop = hopIn.toLowerCase() < hopOut.toLowerCase(); // THIS leg's hop direction
    const [lens, legAlgebra, edgeQl] = await Promise.all([
      readEdge(hopIn, hopOut),
      readEdgeAlgebra(hopIn, hopOut),
      readEdgeQl(hopIn, hopOut, estIn),
    ]);
    const legPools: EcoPool[] = [];
    for (const p of lens.pools) {
      if (p.poolType === SwapPoolType.UniV2) {
        // V2 leg pool: constant-L stream from the live reserves; its own reserve orientation is the
        // lens-reported inIsToken0 (hopIn-is-token0 for this leg), NOT the leg's address-sort zHop.
        legPools.push(lensToEcoPool(p, p.inIsToken0, "lens route leg V2", false));
      } else if (p.poolType === SwapPoolType.UniV3) {
        legPools.push(
          lensToEcoPool(p, zHop, "lens route leg V3", false, legAlgebra.has(p.address.toLowerCase())),
        );
      } else if (p.poolType === SwapPoolType.UniV4) {
        // Hookless V4 only — the unified swap(SwapParams) leg execution builds a hookless PoolKey.
        const hooks = p.hooks ?? ZERO_ADDRESS;
        if (hooks.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) continue;
        legPools.push(lensToEcoPool(p, zHop, "lens route leg V4", false));
      }
    }
    if (legPools.length + edgeQl.length === 0) return null;
    // Best-member head for the downstream fold: pools carry the lens's live spot (V2's
    // spotNearReal is ALREADY the out/in seed; V3/V4's is the real sqrt → orient by zHop),
    // fee-adjusted; an all-QL leg falls back to the venues' probe-ladder first-slice heads.
    let headOI = 0n;
    for (const lp of legPools) {
      const spotOI = lp.isV2 ? lp.spotNearReal! : toOutIn(lp.spotNearReal!, zHop);
      const h = feeAdjust(spotOI, lp.feePpm);
      if (h > headOI) headOI = h;
    }
    if (legPools.length === 0) {
      for (const e of edgeQl) if (e.headOI > headOI) headOI = e.headOI;
    }
    const leg: EcoLeg = { hopIn, hopOut, zeroForOne: zHop, pools: legPools };
    if (edgeQl.length > 0) leg.qlVenues = edgeQl.map((e) => e.venue);
    return { leg, headOI };
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
  // edge with no member simply prunes that branch (a dead edge ⇒ no route through it). `estIn`
  // is the prepare-time estimate of the tokenIn-equivalent flow REACHING this node — amountIn
  // folded through each upstream leg's best-member head (foldEstIn) — the per-edge QL venue
  // liveness-probe amount (see readEdgeQl; sizing only, never merge data).
  const dfs = async (
    token: Hex,
    legsSoFar: EcoLeg[],
    interSoFar: Hex[],
    visited: Set<string>,
    estIn: bigint,
  ): Promise<void> => {
    const hopsUsed = legsSoFar.length;
    // Close the path: hop directly to tokenOut. A path needs ≥2 legs to be a route (a direct
    // 1-leg in→out is a DIRECT pool, already covered by the universe), so only emit when
    // hopsUsed ≥ 1 (this closing leg makes ≥ 2).
    if (hopsUsed >= 1 && token.toLowerCase() !== outLower) {
      if (routes.length >= MAX_ROUTES) {
        routesTruncated++;
      } else {
        const closing = await buildLeg(token, tokenOut, estIn);
        if (closing) {
          routes.push({ legs: [...legsSoFar, closing.leg], intermediateTokens: [...interSoFar] });
        }
      }
    }
    // Branch deeper: only if another interior hop still leaves room for the closing leg to out.
    if (hopsUsed + 2 > MAX_HOPS) return;
    // ROUTE-CAP PRUNE: once MAX_ROUTES routes are admitted, deeper exploration can only
    // produce paths the closing-leg gate above would truncate anyway — but each branch
    // step below still costs a buildLeg → readEdge → runLens eth_call (an expensive
    // on-chain edge read). Stop the whole subtree instead: the admitted route set is
    // IDENTICAL (routes are only ever admitted in DFS order until the cap), only the
    // pointless edge reads are skipped. routesTruncated then reports the prune points
    // reached (a lower bound on dropped paths), not an exact dropped-path count.
    if (routes.length >= MAX_ROUTES) {
      routesTruncated++;
      return;
    }
    for (const next of interiorTokens) {
      // Re-check the cap PER SIBLING: a child subtree may have admitted the final route,
      // and the dfs()-entry check alone would still lens-read every remaining sibling
      // edge here (buildLeg → readEdge → runLens) before its recursion could prune.
      if (routes.length >= MAX_ROUTES) {
        routesTruncated++;
        return;
      }
      const nl = next.toLowerCase();
      if (visited.has(nl)) continue; // no cycles — each token at most once per path
      const built = await buildLeg(token, next, estIn);
      if (!built) continue; // dead edge — prune
      visited.add(nl);
      await dfs(
        next,
        [...legsSoFar, built.leg],
        [...interSoFar, next],
        visited,
        foldEstIn(estIn, built.headOI),
      );
      visited.delete(nl);
    }
  };
  // ECO_MAX_ROUTES=0 disables routes OUTRIGHT — including the DFS's per-edge lens reads.
  // The closing-leg gate alone is NOT enough: with a zero cap the DFS would admit nothing
  // yet still buildLeg→readEdge→runLens every interior edge first (each a heavy on-chain
  // eth_call), i.e. pay the full route-discovery cost for a result known to be empty.
  if (MAX_ROUTES > 0) {
    await dfs(tokenIn, [], [], new Set<string>([inLower]), amountIn);
  }

  if (routesTruncated > 0) {
    console.log(
      `  EcoSwap capped routes to ${MAX_ROUTES} (ECO_MAX_ROUTES); pruned exploration at ` +
        `${routesTruncated} point(s) past the cap — a calldata/loop bound, not a liquidity gate`,
    );
  }

  // ── DISJOINT ROUTE SELECTION (the documented FIRST-LANDING bound) ──
  // MAX_HOPS ≥ 3 emits routes that SHARE a leg pool: two paths reuse the same WETH↔X pool (same
  // direction), and both A→X→Y→B and A→Y→X→B traverse the X↔Y pool in OPPOSITE directions. The
  // universe build (index.ts) dedups leg pools by ADDRESS into ONE universe slot, but the on-chain
  // route execution accrues per-universe-pool `inp[a]` and reads the whole realized intermediate
  // balance PER ROUTE — so a shared leg pool double-spends its `inp[a]` (once per route) and a
  // reversed reuse inverts its V4 PoolKey / reciprocal-prices it in the merge. The neutral oracle
  // AND the cursor-faithful reference give EACH route-leg pool its OWN independent frontier, so a
  // shared pool is inconsistent in the MERGE too, not only at exec. Enforce that every leg pool
  // address is claimed by AT MOST ONE execution context: claim the DIRECT pools first, then walk
  // routes SHORTEST-HOP-FIRST (DFS order within a hop count) and, per leg, DROP any pool already
  // claimed; a route whose leg becomes empty is DROPPED, else it is admitted and its surviving pools
  // are claimed. The universe dedup then never fires (no address appears twice), exec cannot
  // double-spend or invert, and solver == oracle == reference for routes BY CONSTRUCTION. (Shared-
  // pool routes with per-route shared-frontier accounting are a later phase — not attempted here.)
  //
  // QL VENUES join the SAME claim discipline, keyed by qlVenueClaimKey (pool address; Mento
  // provider|exchangeId) in ONE shared set with the pool addresses (namespaces never collide).
  // Two ladders over one pool's liquidity double-count its depth no matter WHICH coin pair each
  // prices (a direct (A,B) instance and a leg (A,X) instance of a 3-coin pool assume the same
  // untouched inventory; the second exec realizes less than modeled — no revert, the callback-free
  // execs re-quote live, but the split is economically wrong). So, unlike 2-token pools — which
  // cannot serve two edges of one cycle-free path — a MULTI-COIN venue (3-coin Curve/CryptoSwap,
  // 3-token BalancerV2, multi-asset Wombat) holding {A, X, B} IS discoverable on BOTH legs of one
  // route: claim-after-admission alone is NOT sufficient. The filter therefore claims WITHIN the
  // route as it walks (tentative `routeClaims`, merged into the global set only on admission):
  //   1. DIRECT venues claim first (a pool serving the overall pair directly is excluded from
  //      every leg — one shared inventory cannot serve both).
  //   2. Within a route, an earlier leg's admitted venue excludes the same venue from later legs.
  //   3. Across routes, first (shortest) route wins — mirroring the pools' first-landing bound.
  // A leg is dead only when pools AND venues are BOTH empty; a dead leg drops the route.
  //
  // NOTE: address-disjointness does NOT cover a shared intermediate TOKEN — two admitted disjoint-
  // POOL routes can still transit the same token X via different edges (P: A→X→Y→B, Q: A→Z→X→B share
  // token X with NO common pool, both survive this filter). That case is safe by the on-chain exec
  // ORDER, not by this filter: routes run fully sequentially (`for r { for leg }`) and each route
  // both produces AND immediately consumes its intermediate within its own contiguous run, so the
  // leg>0 whole-balance drain reads balanceOf(X) to 0 before the next route deposits X. A future
  // exec reorder (e.g. batching all leg0s then all leg1s for gas) would reintroduce the double-read
  // — the per-route produce-then-consume order in ecoswap.sauce.ts is the load-bearing guarantee.
  const claimed = new Set<string>();
  for (const p of pools) claimed.add(p.address.toLowerCase());
  // Direct QL venue identities (rule 1). Fluid joins for uniformity (direct-only anyway — no leg
  // instance can exist, but the one-inventory argument is family-agnostic and the union is free).
  for (const c of curves) claimed.add(c.address.toLowerCase());
  for (const cp of cryptoSwaps) claimed.add(cp.address.toLowerCase());
  for (const sp of solidlyStables) claimed.add(sp.address.toLowerCase());
  for (const wp of wooFiPools) claimed.add(wp.address.toLowerCase());
  for (const lb of lbs) claimed.add(lb.address.toLowerCase());
  for (const mp of mentoPools) {
    claimed.add(mentoClaimKey(mp.exchangeProvider, mp.exchangeId));
  }
  for (const d of dodos) claimed.add(d.address.toLowerCase());
  for (const wp of wombats) claimed.add(wp.address.toLowerCase());
  for (const fp of fermiPools) claimed.add(fp.address.toLowerCase());
  for (const ep of eulerSwaps) claimed.add(ep.address.toLowerCase());
  for (const bp of balancerV3Pools) claimed.add(bp.address.toLowerCase());
  for (const bp of balancerStables) claimed.add(bp.address.toLowerCase());
  for (const mp of maverickPools) claimed.add(mp.address.toLowerCase());
  for (const fp of fluidPools) claimed.add(fp.address.toLowerCase());
  const orderedRoutes = routes
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.legs.length - b.r.legs.length || a.i - b.i)
    .map((x) => x.r);
  const disjointRoutes: EcoRoute[] = [];
  let droppedRouteCount = 0;
  let droppedLegPoolCount = 0;
  let droppedLegVenueCount = 0;
  for (const route of orderedRoutes) {
    const survivingLegs: EcoLeg[] = [];
    // Tentative intra-route claims (rule 2) — discarded whole if the route is rejected, merged
    // into the global set on admission (rule 3). Pools ride the same set: a 2-token pool cannot
    // collide across a cycle-free path's edges, so this is a no-op for them (kept uniform).
    const routeClaims = new Set<string>();
    let admit = true;
    for (const leg of route.legs) {
      const keepPools = leg.pools.filter((lp) => {
        const k = lp.address.toLowerCase();
        return !claimed.has(k) && !routeClaims.has(k);
      });
      droppedLegPoolCount += leg.pools.length - keepPools.length;
      const legVenues = leg.qlVenues ?? [];
      // legSeen: dedupe SAME-LEG duplicate instances of one venue (e.g. one Curve pool surfaced
      // by two configured registries) — claimed/routeClaims only see venues from EARLIER legs,
      // so intra-leg duplicates would otherwise both survive and double-count one inventory.
      const legSeen = new Set<string>();
      const keepVenues = legVenues.filter((v) => {
        const k = qlVenueClaimKey(v);
        if (claimed.has(k) || routeClaims.has(k) || legSeen.has(k)) return false;
        legSeen.add(k);
        return true;
      });
      droppedLegVenueCount += legVenues.length - keepVenues.length;
      if (keepPools.length + keepVenues.length === 0) {
        admit = false;
        break;
      }
      for (const lp of keepPools) routeClaims.add(lp.address.toLowerCase());
      for (const v of keepVenues) routeClaims.add(qlVenueClaimKey(v));
      const survLeg: EcoLeg = { ...leg, pools: keepPools };
      if (keepVenues.length > 0) survLeg.qlVenues = keepVenues;
      else delete survLeg.qlVenues; // a venue-free leg carries NO qlVenues key (shape-stable)
      survivingLegs.push(survLeg);
    }
    if (!admit) {
      droppedRouteCount++;
      continue;
    }
    for (const k of routeClaims) claimed.add(k);
    disjointRoutes.push({ ...route, legs: survivingLegs });
  }
  if (droppedRouteCount > 0 || droppedLegPoolCount > 0 || droppedLegVenueCount > 0) {
    console.log(
      `  EcoSwap disjoint-route filter: dropped ${droppedRouteCount} route(s) + ${droppedLegPoolCount} ` +
        `already-claimed leg pool(s) + ${droppedLegVenueCount} already-claimed leg QL venue(s) — ` +
        `first-landing bound (a shared member would double-spend/double-count its inventory)`,
    );
  }
  routes.length = 0;
  routes.push(...disjointRoutes);

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
    balancerStables.length === 0 &&
    maverickPools.length === 0 &&
    cryptoSwaps.length === 0 &&
    eulerSwaps.length === 0 &&
    wooFiPools.length === 0 &&
    fermiPools.length === 0 &&
    fluidPools.length === 0 &&
    mentoPools.length === 0 &&
    balancerV3Pools.length === 0
  ) {
    throw new Error(`No usable pools/routes for ${tokenIn} -> ${tokenOut}`);
  }

  const nV4 = pools.filter((p) => p.poolType === SwapPoolType.UniV4).length;
  const nV3 = pools.filter((p) => p.poolType === SwapPoolType.UniV3).length;
  const nKyber = pools.filter((p) => p.isKyber).length;
  const nV2 = pools.filter((p) => p.isV2 && !p.isKyber).length;
  const directNetRows = pools.reduce((s, p) => s + (p.netRows?.length ?? 0), 0);
  const legPoolCount = routes.reduce((s, r) => s + r.legs.reduce((t, l) => t + l.pools.length, 0), 0);
  const legQlvCount = routes.reduce(
    (s, r) => s + r.legs.reduce((t, l) => t + (l.qlVenues?.length ?? 0), 0),
    0,
  );
  // Curve StableSwap, Curve CryptoSwap, Solidly STABLE, WOOFi, Trader Joe LB, Mento V2, DODO V2, Wombat,
  // Fermi, EulerSwap AND Maverick V2 ship as QL (Quote-Ladder) DESCRIPTORS (the .length of each list), NOT
  // sampled segments — the on-chain solver builds each ladder live from its quote view / bin-walk — so they
  // are reported below as "QL", not a seg count.
  const nFluidSegs = brackets.filter((b) => b.kind === EcoBracketKind.Fluid).length;
  console.log(
    `  EcoSwap prepared: ${nV3} V3, ${nV4} V4, ${nV2} V2 direct, ${nKyber} Kyber, ` +
      `${balancerStables.length} Balancer-stable, ` +
      `${routes.length} routes (${legPoolCount} leg pools, ${legQlvCount} leg QL venues), ${directNetRows} direct net-cache rows ` +
      `(all pools walked live), ${curves.length} Curve QL, ${cryptoSwaps.length} CryptoSwap QL, ` +
      `${solidlyStables.length} Solidly-stable QL, ${wooFiPools.length} WOOFi QL, ${lbs.length} LB QL, ` +
      `${mentoPools.length} Mento QL, ${dodos.length} DODO QL, ${wombats.length} Wombat QL, ` +
      `${fermiPools.length} Fermi QL, ${eulerSwaps.length} Euler QL, ${maverickPools.length} Maverick QL, ` +
      `${balancerV3Pools.length} Balancer-V3 QL, ` +
      `${brackets.length} sampled segments (${nFluidSegs} Fluid)`,
  );

  const prepared: EcoSwapPrepared = {
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
    wooFiPools,
    fermiPools,
    fluidPools,
    mentoPools,
    balancerV3Pools,
    brackets,
    zeroForOne,
    priceLimit,
    expectedInputCovered: 0n,
    slippageBps,
    // The internal whole-trade amountOutMin FLOOR (cfg[9]) the on-chain solver self-enforces.
    // expectedTotalOut is a CONSERVATIVE (lower-bound) off-chain estimate of the split's output
    // (estimateExpectedOutput walks each pool's frontier over the shipped net window + values the
    // sampled brackets exactly, omitting deeper-than-window liquidity and routes ⇒ never over-
    // counts). So `minOut = expectedTotalOut * (10000 - slippageBps) / 10000` sits strictly below
    // any legitimate wei-exact fill and only fires on a genuine shortfall. slippageBps 0 ⇒ minOut
    // 0 ⇒ the floor is disabled (byte-identical to the pre-floor solver). When the estimate is 0
    // (no estimable venue) minOut is 0 too — the safe (no-floor) default.
    minOut: 0n,
  };
  if (opts.minOut !== undefined) {
    // Explicit override — used verbatim (a caller-supplied min, or a test forcing the floor).
    prepared.minOut = opts.minOut;
  } else if (slippageBps > 0) {
    const expectedTotalOut = estimateExpectedOutput(prepared, amountIn);
    prepared.minOut = (expectedTotalOut * BigInt(10_000 - slippageBps)) / 10_000n;
  }
  return prepared;
}
