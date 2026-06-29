/**
 * EcoSwap NEUTRAL optimal-split oracle (the strict measuring stick).
 *
 * Engine- AND solver-INDEPENDENT. Unlike `ecoswap.reference.ts` (which mirrors the
 * on-chain solver's data flow: prepared brackets, the K-way / pre-fill / sweep / walk
 * structure, the off-chain `liveCurRealOverride` modeling), THIS oracle takes the TRUE
 * LIVE pool state directly — per pool: live tick + active L + the full initialized-tick
 * liquidityNet curve over the relevant range (incl. BEYOND any prepared window), fee,
 * type, and for V2 the live reserves — and computes the OPTIMAL price-ordered water-fill
 * split from scratch.
 *
 * It knows NOTHING about prepared brackets, the cache, drift overrides, or pass
 * structure. It is purely: "given the real curves, what is the optimal equalized split
 * down to the common marginal-price cut?" That makes it the independent truth the solver
 * (and the reference) must match to the wei.
 *
 * EXACTNESS — same integer math as the solver:
 *   - V3/V4 segment frontier walks the REAL sqrt MULTIPLICATIVELY via `stepReal`
 *     (NOT getSqrtRatioAtTick) — the SAME convention the on-chain solver + lens use, so
 *     multiplicative drift accrues identically over many steps.
 *   - integration in unified out/in space: effIn = L·Q96/farOI − L·Q96/nearOI (mulDiv),
 *     grossed up by FEE_DENOM/(FEE_DENOM − feePpm) PER SEGMENT (per-segment rounding).
 *   - crossing an initialized tick updates active L by ±liquidityNet (the raw-uint128
 *     sign/clamp branches copied bit-for-bit from the solver).
 *   - V2 constant-L geometric slices: far = near − near·V2_STEP_BPS/V2_STEP_DEN at √k.
 *   - the cross-pool sort key is the fee-adjusted out/in price of the segment's NEAR
 *     (entry) edge: feeAdjOI(nearOI, feePpm) — the same coordinate prepare.ts sorts on.
 *
 * GLOBAL WATER-FILL: every pool's walk is decomposed into price-monotone SEGMENTS (each
 * a [nearOI, farOI] span of constant L with a precomputed gross). All segments across all
 * pools are merged in DESCENDING fee-adjusted-near-price order; we consume each segment's
 * gross into its pool until cum reaches amountIn (the crossing segment takes the exact
 * remainder). Because segments are emitted in each pool's natural price-descending order
 * AND the merge is globally price-ordered, this is exactly the optimal equalized split:
 * the marginal (post-fee) price at the cut is the same across every engaged pool.
 *
 * Drift is handled WITHOUT any special case: the caller passes the TRUE live tick / price,
 * so a pool whose live price sits above, within, or entirely past the prepared window is
 * simply walked from its true live spot. No-bracket pools, against-swap drift, with-swap
 * drift, fully-out-of-range — all are the same code path here (walk from live spot down).
 */

import {
  Q96,
  Q192,
  FEE_DENOM,
  mulDiv,
  isqrt,
  stepReal,
  toOutIn,
  HALF128,
  MOD128,
  sqrtOneMinusFeeScaled,
  getSqrtRatioAtTick,
  V2_STEP_BPS,
  V2_STEP_DEN,
} from "./ecoswap.math";

// ── Input: the TRUE live pool state ──────────────────────────

/** V3/V4 pool kind (true-state oracle). */
/**
 * TRUE live state for one pool. This is what an honest observer reads on-chain right
 * before the swap — NOT prepared brackets. V3 and V4 integrate identically (StateView is
 * just a different read path), so both use `isV2: false`.
 */
export interface OptimalPool {
  /** false = V3/V4 concentrated liquidity (live ticks); true = V2 constant product. */
  isV2: boolean;
  /** parts-per-million fee (e.g. 3000 = 0.30%). V2 is pinned to 3000 (engine _swapV2). */
  feePpm: number;

  // ── V3/V4 live state ──
  /** Live REAL sqrtPriceX96 (token1/token0), Q96. Required for V3/V4. */
  sqrtPriceX96?: bigint;
  /** Live (exact) current tick. Required for V3/V4. */
  tick?: number;
  /** tickSpacing. Required for V3/V4. */
  tickSpacing?: number;
  /** Live active liquidity L at the current tick. Required for V3/V4. */
  liquidity?: bigint;
  /**
   * Full initialized-tick liquidityNet curve over the relevant range, keyed by SIGNED
   * tick (NOT shifted). Must cover every initialized boundary the trade could cross,
   * INCLUDING beyond any prepared window. Missing key ⇒ liquidityNet 0 (L unchanged).
   * Values are signed int128 (positive on add-from-below, negative on the upper edge).
   */
  net?: Map<number, bigint>;

  // ── V2 live state ──
  /** Live tokenIn-side reserve (constant product). Required for V2. */
  reserveIn?: bigint;
  /** Live tokenOut-side reserve. Required for V2. */
  reserveOut?: bigint;
}

export interface OptimalInput {
  pools: OptimalPool[];
  amountIn: bigint;
  zeroForOne: boolean;
  /**
   * REAL-sqrt-space price limit (direction-dependent). A V3/V4 pool's walk stops once a
   * step would cross it. 0 / undefined ⇒ no limit (walk to liquidity exhaustion / cap).
   */
  priceLimit?: bigint;
}

export interface OptimalResult {
  /** Gross tokenIn assigned to pools[i] (same indexing as input.pools). */
  perPoolInput: bigint[];
  /** Σ perPoolInput (≤ amountIn; == amountIn when liquidity allows). */
  totalInput: bigint;
  /**
   * The common fee-adjusted out/in marginal price at the cut — the price below which no
   * pool was funded. Diagnostic / used by the equalization assertion.
   */
  cutAdjPrice: bigint;
  /** Per-pool fee-adjusted out/in marginal price reached (the cut edge each pool stopped at). */
  perPoolMarginalAdj: bigint[];
}

// ── Step / cap constants ─────────────────────────────────────

/**
 * Hard PER-POOL step budget — walked per V3/V4 pool (and, as MAX_V2_SLICES, per V2 pool).
 *
 * This is the MEASURING-STICK side of the B2 run-until-filled budget: it MUST equal the
 * on-chain solver's PER_POOL (ecoswap.sauce.ts) and the reference's PER_POOL
 * (ecoswap.kway.reference.ts) EXACTLY, so the oracle and the solver agree to the wei EVEN
 * WHEN THE CAP BINDS (a price excursion deeper than the budget truncates BOTH identically).
 *
 * 2048 ts=10 steps ≈ a 7.75× price excursion per pool — far past any realistic out-of-range
 * case — while a single pool walking the full budget on anvil costs ≈1.15e9 gas (measured),
 * comfortably under the 1.9e9 anvil cook ceiling (per-step ≈419K shallow, rising to ≈640K
 * at depth via memory/larger-value arithmetic). Larger budgets (≥3000) hit the ceiling, so
 * 2048 is the largest budget where a single pool can reach the cap and still cook.
 */
const MAX_V3_STEPS = 2048;
/** Hard safety cap on V2 geometric slices per pool — same PER_POOL budget. */
const MAX_V2_SLICES = 2048;

// ── Fee-adjust on a raw out/in price (segment sort key) ──────
//
// The cross-pool comparison key. Matches prepare.ts feeAdjust EXACTLY:
//   feeAdjust(sqrtSpot, feePpm) = sqrtSpot * sqrtOneMinusFeeScaled(feePpm) / FEE_DENOM
// (sqrtOneMinusFeeScaled = isqrt((1e6 - feePpm) * 1e6)). This is the SAME number the
// brackets carry as sqrtAdjNear, so the oracle's price ordering is bit-identical to the
// ladder the solver consumes.
function feeAdjOI(oi: bigint, feePpm: number): bigint {
  return (oi * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}

// ── A price-ordered candidate segment ────────────────────────
//
// One constant-L span of one pool: [nearOI (entry, higher price), farOI (exit, lower)]
// with the gross tokenIn (incl. fee) to traverse it fully. `adjNear` is the fee-adjusted
// near price — the sort key. Segments are produced in each pool's natural descending-price
// order, so the per-pool list is already sorted; the global merge interleaves pools.
interface Segment {
  pool: number;
  /** fee-adjusted out/in price at the near (entry) edge — DESC sort key. */
  adjNear: bigint;
  /** fee-adjusted out/in price at the far (exit) edge — the marginal if fully consumed. */
  adjFar: bigint;
  /** gross tokenIn (incl. fee) to traverse the whole segment. */
  gross: bigint;
}

/**
 * Enumerate one V3/V4 pool's segments by walking initialized ticks in the swap direction
 * from the live spot, EXACTLY as the on-chain forward walk does (multiplicative stepReal,
 * out/in integration, per-segment fee-grossup, ±liquidityNet on each crossing).
 *
 * The first segment's near edge is the LIVE spot real sqrt; each subsequent near edge is
 * the previous far. Crossing the boundary tick updates L. Stops at the price limit, when L
 * stays 0 with no further initialized ticks reachable within the cap, or at MAX_V3_STEPS.
 */
function v3Segments(p: OptimalPool, poolIdx: number, zeroForOne: boolean, priceLimit: bigint): Segment[] {
  const segs: Segment[] = [];
  const feePpm = p.feePpm;
  // multiplicative step ratio = getSqrtRatioAtTick(tickSpacing); the solver uses the
  // SAME stepReal walk seeded from this (== prepare's adaptiveStepRatio).
  const stepRatio = getSqrtRatioAtTick(p.tickSpacing!);

  let L = p.liquidity!;
  let nearReal = p.sqrtPriceX96!; // live spot real sqrt
  const base = Math.floor(p.tick! / p.tickSpacing!) * p.tickSpacing!;
  // first boundary tick in the swap direction (signed, NOT shifted): mirrors
  // buildV3Brackets / the solver — zeroForOne crosses base first, oneForZero base+ts.
  let boundary = zeroForOne ? base : base + p.tickSpacing!;

  // The extreme initialized tick in the walk direction — once the boundary passes it AND L
  // has gone to 0, the pool can produce no further capacity, so the walk terminates early
  // (instead of spinning out the full step cap). Empty net ⇒ no boundaries ⇒ a single
  // constant-L curve, which still terminates via the L>0 / step-cap conditions.
  const netTicks = p.net ? [...p.net.keys()] : [];
  const haveTicks = netTicks.length > 0;
  const extremeTick = haveTicks
    ? zeroForOne
      ? Math.min(...netTicks)
      : Math.max(...netTicks)
    : 0;

  for (let k = 0; k < MAX_V3_STEPS; k++) {
    // Exhaustion: L drained to 0 and no initialized tick remains ahead → done.
    if (L === 0n && haveTicks) {
      const past = zeroForOne ? boundary < extremeTick : boundary > extremeTick;
      if (past) break;
    }
    const farReal = stepReal(nearReal, stepRatio, zeroForOne);
    // price-limit guard (REAL-sqrt space) — stop before crossing a binding limit.
    if (priceLimit > 0n) {
      if (zeroForOne) {
        if (farReal <= priceLimit) break;
      } else {
        if (farReal >= priceLimit) break;
      }
    }
    const nearOI = toOutIn(nearReal, zeroForOne);
    const farOI = toOutIn(farReal, zeroForOne);
    if (L > 0n && nearOI > farOI && farOI > 0n) {
      const effIn = mulDiv(L, Q96, farOI) - mulDiv(L, Q96, nearOI);
      if (effIn > 0n) {
        const gross = mulDiv(effIn, FEE_DENOM, FEE_DENOM - BigInt(feePpm));
        if (gross > 0n) {
          segs.push({
            pool: poolIdx,
            adjNear: feeAdjOI(nearOI, feePpm),
            adjFar: feeAdjOI(farOI, feePpm),
            gross,
          });
        }
      }
    }
    // cross the boundary tick: update L by ±liquidityNet (raw-uint128 sign branches).
    const signedNet = (p.net?.get(boundary)) ?? 0n;
    const raw = signedNet >= 0n ? signedNet : signedNet + MOD128;
    const neg = raw >= HALF128;
    if (zeroForOne) {
      if (neg) L = L + (MOD128 - raw);
      else L = L >= raw ? L - raw : 0n;
      boundary -= p.tickSpacing!;
    } else {
      if (neg) {
        const mag = MOD128 - raw;
        L = L >= mag ? L - mag : 0n;
      } else {
        L = L + raw;
      }
      boundary += p.tickSpacing!;
    }
    nearReal = farReal;
  }
  return segs;
}

/**
 * Enumerate one V2 pool's segments as constant-L geometric out/in slices from the live
 * spot. L = √(reserveIn·reserveOut); spot out/in = √(reserveOut/reserveIn). Slices step
 * far = near − near·V2_STEP_BPS/V2_STEP_DEN at constant L, mirroring buildV2Brackets and
 * the on-chain V2 stream EXACTLY.
 */
function v2Segments(p: OptimalPool, poolIdx: number): Segment[] {
  const segs: Segment[] = [];
  const reserveIn = p.reserveIn!;
  const reserveOut = p.reserveOut!;
  if (reserveIn <= 0n || reserveOut <= 0n) return segs;
  const L = isqrt(reserveIn * reserveOut);
  const feePpm = p.feePpm;
  let near = isqrt((reserveOut * Q192) / reserveIn); // out/in spot sqrt
  for (let i = 0; i < MAX_V2_SLICES; i++) {
    const far = near - mulDiv(near, V2_STEP_BPS, V2_STEP_DEN);
    if (far <= 0n || far >= near) break;
    if (L > 0n) {
      const effIn = mulDiv(L, Q96, far) - mulDiv(L, Q96, near);
      if (effIn > 0n) {
        const gross = mulDiv(effIn, FEE_DENOM, FEE_DENOM - BigInt(feePpm));
        if (gross > 0n) {
          segs.push({
            pool: poolIdx,
            adjNear: feeAdjOI(near, feePpm),
            adjFar: feeAdjOI(far, feePpm),
            gross,
          });
        }
      }
    }
    near = far;
  }
  return segs;
}

/**
 * The neutral optimal split. Enumerate every pool's price-monotone segments from TRUE live
 * state, merge globally in DESCENDING fee-adjusted-near-price order, and water-fill to the
 * common cut (cum == amountIn; crossing segment takes the exact remainder).
 */
export function optimalSplit(input: OptimalInput): OptimalResult {
  const { pools, amountIn, zeroForOne } = input;
  const priceLimit = input.priceLimit ?? 0n;

  const perPoolInput: bigint[] = new Array(pools.length).fill(0n);
  const perPoolMarginalAdj: bigint[] = new Array(pools.length).fill(0n);

  // Enumerate all candidate segments across all pools.
  const allSegs: Segment[] = [];
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    if (p.isV2) {
      allSegs.push(...v2Segments(p, i));
    } else {
      allSegs.push(...v3Segments(p, i, zeroForOne, priceLimit));
    }
  }

  // Global price-descending merge. A stable sort on adjNear DESC realises the optimal
  // water-fill: the best-priced segment across ALL pools is consumed first, ties broken by
  // farther (deeper) edge so a contiguous pool keeps its natural order.
  allSegs.sort((a, b) => {
    if (a.adjNear !== b.adjNear) return a.adjNear < b.adjNear ? 1 : -1;
    // tie on near price: prefer the segment with the higher far (shallower) so a pool's
    // own contiguous chain stays in order; cross-pool ties are price-equivalent anyway.
    if (a.adjFar !== b.adjFar) return a.adjFar < b.adjFar ? 1 : -1;
    return a.pool - b.pool;
  });

  let cum = 0n;
  let cutAdjPrice = 0n;
  for (const seg of allSegs) {
    if (cum >= amountIn) break;
    let take = seg.gross;
    let crossed = false;
    if (cum + seg.gross >= amountIn) {
      take = amountIn - cum;
      crossed = true;
    }
    perPoolInput[seg.pool] += take;
    cum += take;
    // The marginal each engaged pool reaches: if the segment was fully consumed, the pool
    // has moved to (at least) the far edge; if it is the crossing segment, the cut sits
    // somewhere inside it — record adjFar as the conservative marginal (the pool's price
    // after fully draining the segment is adjFar; a partial fill lands between near & far).
    perPoolMarginalAdj[seg.pool] = seg.adjFar;
    if (crossed) {
      cutAdjPrice = seg.adjFar;
      break;
    }
  }

  const totalInput = perPoolInput.reduce((a, b) => a + b, 0n);
  return { perPoolInput, totalInput, cutAdjPrice, perPoolMarginalAdj };
}
