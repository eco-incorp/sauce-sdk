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
// Curve StableSwap replay — the SINGLE source shared with prepare.ts (buildCurveSegments).
// The oracle enumerates the SAME segments from true live state, so the split is exact-on-grid.
import { buildCurveSegments, type CurvePool } from "../shared/curve-math.js";
import { buildLbSegments, type LbPool } from "../shared/lb-math.js";
import { buildDodoSegments, type DodoPool } from "../shared/dodo-math.js";

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
  /**
   * KyberSwap Classic / DMM only: the VIRTUAL reserves the amplified constant-product curve
   * trades on. When present they OVERRIDE reserveIn/reserveOut for the V2 segment geometry
   * (L = isqrt(vReserveIn·vReserveOut), spot out/in = sqrt(vReserveOut/vReserveIn)) — a Kyber
   * pool is a V2 range on the virtual reserves. The per-pool `feePpm` is the rounded Kyber
   * fee, the SAME ppm the on-chain merge grosses by, so the split stays wei-exact. (This is
   * the "thin v2Segments variant carrying the virtual reserves" — it reuses the V2 stream
   * verbatim with the virtual reserves substituted in.)
   */
  vReserveIn?: bigint;
  /** KyberSwap Classic / DMM only: the tokenOut-side VIRTUAL reserve. */
  vReserveOut?: bigint;

  // ── Curve StableSwap live state ──
  /**
   * Curve StableSwap pool — when present this pool is a CURVE venue (NOT V2/V3). The oracle
   * enumerates its segments via the SHARED bigint replay (buildCurveSegments) from the live
   * invariant state (A, balances[], rates[], fee, int128 i/j), so the split is exact-on-grid
   * vs prepare's segments (one replay). The marginal is post-fee (get_dy nets the fee); the
   * per-pool dy for the awarded share is wei-exact by one atomic get_dy(Σ share). `isV2` is
   * ignored when `curve` is set.
   */
  curve?: CurvePool;

  // ── Trader Joe LB live state ──
  /**
   * Trader Joe LB pair — when present this pool is an LB venue (NOT V2/V3/Curve). The oracle
   * enumerates its segments via the SHARED exact per-bin enumerator (buildLbSegments) from the
   * live bin reserves, so the split is EXACT (no grid error — discrete constant-sum bins have no
   * intra-bin curvature, so the segments ARE the curve). The marginal is post-fee (buildLbSegments
   * nets the base fee); the per-pool out for the awarded share is wei-exact by one atomic
   * pool.swap(swapForY, to). `isV2`/`curve` are ignored when `lb` is set.
   */
  lb?: LbPool;

  // ── DODO V2 PMM live state ──
  /**
   * DODO V2 PMM pool — when present this pool is a DODO venue (NOT V2/V3/Curve/LB). The oracle
   * enumerates its segments via the SHARED closed-form replay (buildDodoSegments) from the live PMM
   * state (i, K, B, Q, B0, Q0, R + LP/MT fee), so the split is exact-on-grid vs prepare's segments
   * (one replay). The guide price `i` is POOL STATE (read live, not an exogenous feed), so the curve
   * is deterministic — that is why DODO meets the wei-exact-on-grid bar. The marginal is post-fee
   * (querySell* nets the LP+MT fee); the per-pool dy for the awarded share is wei-exact by one atomic
   * querySell*(Σ share). `isV2`/`curve`/`lb` are ignored when `dodo` is set.
   */
  dodo?: DodoPool;
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
 * (ecoswap.solver-reference.ts) EXACTLY, so the oracle and the solver agree to the wei EVEN
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
  // Only INITIALIZED ticks (net != 0) gate exhaustion — a deep zero-net key would never
  // change L, so it must not extend the walk past the last real boundary. (No-op on
  // producible data, where every net key is nonzero; hardens the gate against a fixture
  // injecting a zero-net key.)
  const netTicks = p.net ? [...p.net.entries()].filter(([, n]) => n !== 0n).map(([t]) => t) : [];
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
  // KyberSwap Classic / DMM trades on VIRTUAL reserves: when present they replace the real
  // reserves for the constant-L geometry (L = √(vIn·vOut), spot out/in = √(vOut/vIn)). The
  // step, fee-grossup and integration are byte-identical to a plain V2 pool — only the
  // reserves seeding L and the spot differ.
  const reserveIn = p.vReserveIn ?? p.reserveIn!;
  const reserveOut = p.vReserveOut ?? p.reserveOut!;
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
 * Enumerate one Curve StableSwap pool's segments via the SHARED bigint replay
 * (buildCurveSegments) from the live invariant state. The amountIn caps the sampled range —
 * the same bound prepare uses — so the oracle and prepare emit the IDENTICAL segment grid
 * (single source), making the split exact-on-grid. The Curve marginalOI is ALREADY the
 * post-fee execution price (get_dy nets the fee), so adjNear == adjFar == marginalOI: it
 * enters the descending-price merge directly with no extra fee-adjust multiply. The per-pool
 * dy for the awarded share is wei-exact by one atomic get_dy(Σ share) (one exchange).
 */
function curveSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  const cs = buildCurveSegments(p.curve!, amountIn);
  for (const s of cs) {
    segs.push({
      pool: poolIdx,
      adjNear: s.marginalOI,
      adjFar: s.marginalOI,
      gross: s.capacity,
    });
  }
  return segs;
}

/**
 * Enumerate one Trader Joe LB pair's segments via the SHARED exact per-bin enumerator
 * (buildLbSegments) from the live bin reserves. The amountIn bounds the outward bin walk — the
 * same bound prepare uses — so the oracle and prepare emit the IDENTICAL segment set (single
 * enumerator), making the split EXACT (not merely exact-on-grid: a bin is a flat constant-sum
 * slice with no intra-bin curvature, so the segment IS the curve). The LB marginalOI is ALREADY
 * the post-fee execution price (buildLbSegments nets the base fee), so adjNear == adjFar ==
 * marginalOI: it enters the descending-price merge directly with no extra fee-adjust multiply.
 * The per-pool out for the awarded share is wei-exact by one atomic pool.swap(swapForY, to).
 */
function lbSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  const ls = buildLbSegments(p.lb!, amountIn);
  for (const s of ls) {
    segs.push({
      pool: poolIdx,
      adjNear: s.marginalOI,
      adjFar: s.marginalOI,
      gross: s.capacity,
    });
  }
  return segs;
}

/**
 * Enumerate one DODO V2 PMM pool's segments via the SHARED closed-form replay (buildDodoSegments)
 * from the live PMM state. The amountIn caps the sampled range — the same bound prepare uses — so
 * the oracle and prepare emit the IDENTICAL segment grid (single source), making the split
 * exact-on-grid. The DODO marginalOI is ALREADY the post-fee execution price (querySell* nets the
 * LP+MT fee), so adjNear == adjFar == marginalOI: it enters the descending-price merge directly with
 * no extra fee-adjust multiply. The per-pool dy for the awarded share is wei-exact by one atomic
 * querySell*(Σ share). The guide price `i` is read pool state (not an exogenous feed), which is what
 * makes this oracle well-defined (a true neutral curve, unlike WOOFi/Fermi).
 */
function dodoSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  const ds = buildDodoSegments(p.dodo!, amountIn);
  for (const s of ds) {
    segs.push({
      pool: poolIdx,
      adjNear: s.marginalOI,
      adjFar: s.marginalOI,
      gross: s.capacity,
    });
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
    if (p.dodo) {
      // DODO V2 PMM venue: sampled-segment enumeration via the shared closed-form replay (capped at
      // amountIn — the same bound prepare samples → identical grid → exact-on-grid split). The guide
      // price `i` is read pool state, so the curve is deterministic (in charter, unlike WOOFi/Fermi).
      allSegs.push(...dodoSegments(p, i, amountIn));
    } else if (p.lb) {
      // LB venue: EXACT per-bin enumeration via the shared enumerator (capped at amountIn —
      // the same bound prepare uses → identical segment set → EXACT split, no grid error).
      allSegs.push(...lbSegments(p, i, amountIn));
    } else if (p.curve) {
      // Curve venue: sampled-segment enumeration via the shared bigint replay (capped at
      // amountIn — the same bound prepare samples → identical grid → exact-on-grid split).
      allSegs.push(...curveSegments(p, i, amountIn));
    } else if (p.isV2) {
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
