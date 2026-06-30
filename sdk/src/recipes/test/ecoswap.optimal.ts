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
  routeHeadFold,
  routeEventN,
  type RouteLeg,
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

/**
 * A multi-hop route leg — ONE hop of a route, as TRUE live state. A leg is (for the
 * foundation) ONE pool of either kind; the leg's own swap direction is `zeroForOne`
 * (a route can change direction per hop). N-leg-internal-split is a later workflow; the
 * shape already carries a single pool but the route walk treats each leg as a frontier of
 * constant-L brackets, so adding an internal merge later only changes how the leg's
 * bracket list is produced, not the route event loop.
 */
export interface OptimalRouteLeg extends OptimalPool {
  /** This hop's swap direction (leg input → leg output). May differ per hop. */
  zeroForOne: boolean;
}

/**
 * A multi-hop route as a chain of LEGS, built from TRUE LIVE leg state — the oracle's
 * own route input, INDEPENDENT of EcoSwapPrepared. The route competes in the global merge
 * as ONE venue whose head is the LEFT-TO-RIGHT product fold (`routeHeadFold`) of its legs'
 * fee-adjusted out/in heads; advancing the route binds whichever leg crosses its tick first
 * (conservation: leg i output == leg i+1 input). N legs (k >= 2); the event loop (`routeSegments`)
 * is arbitrary-k via `routeEventN` (3-hop lands concretely, 2-hop bit-identical).
 */
export interface OptimalRoute {
  legs: OptimalRouteLeg[];
}

export interface OptimalInput {
  pools: OptimalPool[];
  /** Multi-hop routes — extra venues composed from TRUE live leg state. Optional. */
  routes?: OptimalRoute[];
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
  /** Gross route input (leg-1 input) assigned to routes[i] (same indexing as input.routes). */
  perRouteInput: bigint[];
  /** Σ perPoolInput + Σ perRouteInput (≤ amountIn; == amountIn when liquidity allows). */
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
  /** "pool" ⇒ index into perPoolInput; "route" ⇒ index into perRouteInput. */
  venue: "pool" | "route";
  idx: number;
  /** fee-adjusted out/in price at the near (entry) edge — DESC sort key. */
  adjNear: bigint;
  /** fee-adjusted out/in price at the far (exit) edge — the marginal if fully consumed. */
  adjFar: bigint;
  /**
   * gross tokenIn (incl. fee) to traverse the whole segment. For a route this is the
   * route-level input (leg-1 gross input) over the event — what the merge consumes.
   */
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
            venue: "pool",
            idx: poolIdx,
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
            venue: "pool",
            idx: poolIdx,
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

// ── Route-leg frontier enumeration + route event walk ────────
//
// A route leg's frontier is the SAME constant-L bracket chain a direct pool walks — we reuse
// the exact per-step integer math (stepReal / toOutIn / ±liquidityNet for V3-V4, the geometric
// V2 step), but emit the RAW [nearOI, farOI, L, feePpm] brackets (RouteLeg) instead of priced
// Segments, because the route composes brackets across legs before pricing. legBrackets is the
// leg-level analogue of v3Segments/v2Segments and shares their loop structure verbatim.

/** Enumerate one route leg's constant-L brackets (out/in space) from its TRUE live spot. */
function legBrackets(leg: OptimalRouteLeg, priceLimit: bigint): RouteLeg[] {
  const out: RouteLeg[] = [];
  const feePpm = BigInt(leg.feePpm);
  const z = leg.zeroForOne;

  if (leg.isV2) {
    const reserveIn = leg.reserveIn!;
    const reserveOut = leg.reserveOut!;
    if (reserveIn <= 0n || reserveOut <= 0n) return out;
    const L = isqrt(reserveIn * reserveOut);
    let near = isqrt((reserveOut * Q192) / reserveIn); // out/in spot sqrt
    for (let i = 0; i < MAX_V2_SLICES; i++) {
      const far = near - mulDiv(near, V2_STEP_BPS, V2_STEP_DEN);
      if (far <= 0n || far >= near) break;
      if (L > 0n) out.push({ nearOI: near, farOI: far, L, feePpm });
      near = far;
    }
    return out;
  }

  // V3/V4 leg — identical walk to v3Segments, emitting raw brackets.
  const stepRatio = getSqrtRatioAtTick(leg.tickSpacing!);
  let L = leg.liquidity!;
  let nearReal = leg.sqrtPriceX96!;
  const base = Math.floor(leg.tick! / leg.tickSpacing!) * leg.tickSpacing!;
  let boundary = z ? base : base + leg.tickSpacing!;
  const netTicks = leg.net ? [...leg.net.entries()].filter(([, n]) => n !== 0n).map(([t]) => t) : [];
  const haveTicks = netTicks.length > 0;
  const extremeTick = haveTicks ? (z ? Math.min(...netTicks) : Math.max(...netTicks)) : 0;

  for (let k = 0; k < MAX_V3_STEPS; k++) {
    if (L === 0n && haveTicks) {
      const past = z ? boundary < extremeTick : boundary > extremeTick;
      if (past) break;
    }
    const farReal = stepReal(nearReal, stepRatio, z);
    if (priceLimit > 0n) {
      if (z) {
        if (farReal <= priceLimit) break;
      } else {
        if (farReal >= priceLimit) break;
      }
    }
    const nearOI = toOutIn(nearReal, z);
    const farOI = toOutIn(farReal, z);
    if (L > 0n && nearOI > farOI && farOI > 0n) {
      out.push({ nearOI, farOI, L, feePpm });
    }
    const signedNet = leg.net?.get(boundary) ?? 0n;
    const raw = signedNet >= 0n ? signedNet : signedNet + MOD128;
    const neg = raw >= HALF128;
    if (z) {
      if (neg) L = L + (MOD128 - raw);
      else L = L >= raw ? L - raw : 0n;
      boundary -= leg.tickSpacing!;
    } else {
      if (neg) {
        const mag = MOD128 - raw;
        L = L >= mag ? L - mag : 0n;
      } else {
        L = L + raw;
      }
      boundary += leg.tickSpacing!;
    }
    nearReal = farReal;
  }
  return out;
}

/**
 * Enumerate one ROUTE's price-monotone segments by walking a price-ordered k-way merge across
 * its legs' frontiers (`legBrackets`). N-LEG (k >= 2, `routeEventN`): at each event every leg sits
 * on its current constant-L bracket; the BINDING leg (the one whose full tick-cross maps to the
 * smallest token-A input when back-propagated through the chain) crosses its own tick first, every
 * other leg partially fills (conservation: leg i out == leg i+1 in at every intermediate). The
 * bound leg advances to its next bracket; each partial leg's near becomes its event new far. The
 * route's segment carries the route-level input as `gross` and the fee-adjusted route head
 * (LEFT-TO-RIGHT product fold of the legs' fee-adjusted near / far heads via routeHeadFold) as
 * adjNear / adjFar — directly comparable to a direct pool's adjNear, so the route competes in the
 * SAME global merge.
 *
 * Reduces EXACTLY to the prior 2-hop walk at k=2 (routeEventN is a bit-identical superset of
 * routeEvent2; the per-leg cursor advance below specializes to the old `i1/i2` advance for two
 * legs — the binding leg's cursor steps, every other leg's near moves to its new far and its
 * cursor advances past any fully-crossed bracket). 3-hop lands concretely; the loop is arbitrary-k.
 */
function routeSegments(route: OptimalRoute, routeIdx: number): Segment[] {
  const segs: Segment[] = [];
  const k = route.legs.length;
  if (k < 2) return segs; // a route is at least 2 hops

  // Per-leg fixed bracket lists (walked once from each leg's true live spot), fees, and the
  // fee-adjusted out/in coordinate map. All indexed by leg.
  //
  // NO per-leg priceLimit: the swap's REAL-sqrt priceLimit is a bound on the OVERALL swap (it
  // gates the DIRECT pools via v3Segments). A route's legs are NOT individually limited by it —
  // the on-chain solver's route advance (ecoswap.sauce.ts Phase D) crosses a binding leg's tick
  // with NO dlim check; a route is bounded only by conservation + its participation in the global
  // merge cut (the route stops winning once its product head dips below the cut). Threading the
  // overall limit into a per-leg break would (a) wrongly truncate a same-direction leg the solver
  // walks unbounded and (b) for an opposite-direction leg (zHop != overall) compare against a
  // value in the wrong half-space, killing its bracket list. Pass 0n (no per-leg limit) to gate
  // the oracle bit-identically to the solver/reference.
  const brks = route.legs.map((leg) => legBrackets(leg, 0n));
  const fees = route.legs.map((leg) => BigInt(leg.feePpm));
  const adj = route.legs.map((leg) => (oi: bigint) => feeAdjOI(oi, leg.feePpm));

  // Per-leg cursor + CURRENT bracket near (a partial leg carries an advanced near after an event).
  const cur: number[] = new Array(k).fill(0);
  const near: bigint[] = brks.map((b) => (b.length ? b[0].nearOI : 0n));

  const anyExhausted = () => cur.some((c, i) => c >= brks[i].length);

  for (let step = 0; step < MAX_V3_STEPS && !anyExhausted(); step++) {
    // Build each leg's current RouteLeg [near, far, L, fee] on the FIXED live grid.
    const legs: RouteLeg[] = new Array(k);
    let degenerate = false;
    for (let i = 0; i < k; i++) {
      const b = brks[i][cur[i]];
      legs[i] = { nearOI: near[i], farOI: b.farOI, L: b.L, feePpm: fees[i] };
      if (legs[i].nearOI <= legs[i].farOI) degenerate = true;
    }
    if (degenerate) break;

    // Route head at the segment edges: product fold of the per-leg fee-adjusted out/in heads.
    const adjNear = routeHeadFold(legs.map((l, i) => adj[i](l.nearOI)));
    const ev = routeEventN(legs);
    const adjFar = routeHeadFold(ev.newFars.map((f, i) => adj[i](f)));

    if (ev.routeIn > 0n && adjNear > 0n) {
      segs.push({ venue: "route", idx: routeIdx, adjNear, adjFar, gross: ev.routeIn });
    }

    // Advance: the BOUND leg crosses its tick (next bracket); every OTHER leg's near moves to its
    // event new far. routeEventN guarantees the partial fill fits WITHIN each partial leg's current
    // bracket, so the partial near lands inside [farOI, nearOI]. But once it reaches that bracket's
    // far it has crossed the bracket entirely — advance the partial leg's cursor past every bracket
    // whose far the new near has reached, so its NEXT event sits on the bracket that actually
    // contains the near (its far stays strictly below the near). Without this a partial leg
    // re-processes a degenerate sliver of an already-crossed bracket while the bound leg marches on,
    // mis-pricing the route. (At k=2 this is the old `i1++ / partial-near = newF / skip` advance.)
    for (let i = 0; i < k; i++) {
      if (i === ev.bindLeg) {
        cur[i]++;
        near[i] = cur[i] < brks[i].length ? brks[i][cur[i]].nearOI : 0n;
      } else {
        near[i] = ev.newFars[i];
        while (cur[i] < brks[i].length && near[i] <= brks[i][cur[i]].farOI) cur[i]++;
      }
    }
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
  const routes = input.routes ?? [];
  const priceLimit = input.priceLimit ?? 0n;

  const perPoolInput: bigint[] = new Array(pools.length).fill(0n);
  const perRouteInput: bigint[] = new Array(routes.length).fill(0n);
  const perPoolMarginalAdj: bigint[] = new Array(pools.length).fill(0n);

  // Enumerate all candidate segments across all pools AND routes — both produce price-monotone
  // segments tagged by venue, so they compete in ONE global price-descending merge.
  const allSegs: Segment[] = [];
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    if (p.isV2) {
      allSegs.push(...v2Segments(p, i));
    } else {
      allSegs.push(...v3Segments(p, i, zeroForOne, priceLimit));
    }
  }
  for (let i = 0; i < routes.length; i++) {
    allSegs.push(...routeSegments(routes[i], i));
  }

  // Global price-descending merge. A stable sort on adjNear DESC realises the optimal
  // water-fill: the best-priced segment across ALL venues is consumed first, ties broken by
  // farther (deeper) edge so a contiguous venue keeps its natural order.
  allSegs.sort((a, b) => {
    if (a.adjNear !== b.adjNear) return a.adjNear < b.adjNear ? 1 : -1;
    // tie on near price: prefer the segment with the higher far (shallower) so a venue's
    // own contiguous chain stays in order; cross-venue ties are price-equivalent anyway.
    if (a.adjFar !== b.adjFar) return a.adjFar < b.adjFar ? 1 : -1;
    // final tie: deterministic by venue then index (pools before routes).
    if (a.venue !== b.venue) return a.venue === "pool" ? -1 : 1;
    return a.idx - b.idx;
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
    if (seg.venue === "pool") {
      perPoolInput[seg.idx] += take;
      // The marginal each engaged pool reaches: if the segment was fully consumed, the pool
      // has moved to (at least) the far edge; if it is the crossing segment, the cut sits
      // somewhere inside it — record adjFar as the conservative marginal (the pool's price
      // after fully draining the segment is adjFar; a partial fill lands between near & far).
      perPoolMarginalAdj[seg.idx] = seg.adjFar;
    } else {
      perRouteInput[seg.idx] += take;
    }
    cum += take;
    if (crossed) {
      cutAdjPrice = seg.adjFar;
      break;
    }
  }

  const totalInput =
    perPoolInput.reduce((a, b) => a + b, 0n) + perRouteInput.reduce((a, b) => a + b, 0n);
  return { perPoolInput, perRouteInput, totalInput, cutAdjPrice, perPoolMarginalAdj };
}
