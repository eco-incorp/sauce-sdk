/**
 * Pure-bigint math helpers used by the EcoSwap unit tests and reference oracle.
 *
 * These are FAITHFUL COPIES of the (non-exported) helpers in
 * `recipes/ecoswap/prepare.ts`. They are duplicated here only so the
 * tests can exercise them directly without modifying prepare.ts. Any change to
 * the prepare.ts originals must be mirrored here. The integer operations and
 * truncation order are preserved EXACTLY so this module is a trustworthy oracle.
 */

export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const FEE_DENOM = 1_000_000n; // ppm

/** Integer square root (Babylonian). Mirrors prepare.ts `isqrt`. */
export function isqrt(x: bigint): bigint {
  if (x <= 0n) return 0n;
  let z = x;
  let y = (z + 1n) / 2n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

/** (a*b)/c with bigint truncation — matches Solidity/Sauce Math.mulDiv semantics. */
export function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  return (a * b) / c;
}

/** sqrt(1 - fee) scaled by 1e6, i.e. round(sqrt((1e6 - feePpm)/1e6) * 1e6). */
export function sqrtOneMinusFeeScaled(feePpm: number): bigint {
  return isqrt(BigInt(1_000_000 - feePpm) * FEE_DENOM);
}

/** Apply the fee-adjustment to a spot out/in sqrt price. */
export function feeAdjust(sqrtSpot: bigint, feePpm: number): bigint {
  return (sqrtSpot * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}

/**
 * Gross input (tokenIn units incl. fee) to traverse a bracket [sqrtFar, sqrtNear]
 * of constant liquidity L, in unified out/in space:
 *   effIn = L * 2^96 * (1/sqrtFar - 1/sqrtNear);  grossIn = effIn / (1 - fee)
 */
export function bracketCapacity(L: bigint, sqrtNear: bigint, sqrtFar: bigint, feePpm: number): bigint {
  if (L <= 0n || sqrtFar <= 0n || sqrtNear <= sqrtFar) return 0n;
  const effIn = (L * Q96) / sqrtFar - (L * Q96) / sqrtNear;
  if (effIn <= 0n) return 0n;
  return (effIn * FEE_DENOM) / BigInt(1_000_000 - feePpm);
}

/** Exact Uniswap V3 TickMath.getSqrtRatioAtTick (real token1/token0 sqrt, Q96). */
export function getSqrtRatioAtTick(tick: number): bigint {
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
export function toOutIn(sqrtReal: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? sqrtReal : Q192 / sqrtReal;
}

// ── Adaptive (WS4) streaming-walk helpers ────────────────────
// Faithful copies of the lens helpers (ecoswap.lens.sauce.ts) + constants, shared
// by the on-chain solver port and the oracle so both walk the frontier identically.

/** Tick shift (multiple of LCM(spacings)=3000, > max|tick| 887272 so shifted stays ≥0). */
export const OFFSET = 888000n;
/**
 * V2 constant-L geometric step (out/in space): far = near - near*V2_STEP_BPS/V2_STEP_DEN.
 * MUST equal prepare.ts's buildV2Brackets step (V2_SQRT_STEP_BPS=25/10000) AND the
 * solver's V2_STEP_BPS/V2_STEP_DEN bit-for-bit so the V2 forward-walk mirror is exact.
 */
export const V2_STEP_BPS = 25n;
export const V2_STEP_DEN = 10000n;
/** int128 sign bit. */
export const HALF128 = 1n << 127n;
/** int128 modulus. */
export const MOD128 = 1n << 128n;

/** int24 STATICCALL arg (signed tick) from a shifted tick. Mirrors lens `tickArg`. */
export function tickArg(shifted: bigint): bigint {
  return shifted >= OFFSET ? shifted - OFFSET : -(OFFSET - shifted);
}

/**
 * Next REAL sqrt one tickSpacing step in the swap direction (multiplicative).
 * Mirrors lens `stepReal` EXACTLY (NOT getSqrtRatioAtTick) so the oracle matches
 * the on-chain walk bit-for-bit as multiplicative drift accrues over many steps.
 *   zeroForOne (price down): sqrt' = mulDiv(sqrt, 2^96, stepRatio)
 *   oneForZero (price up):   sqrt' = mulDiv(sqrt, stepRatio, 2^96)
 */
export function stepReal(sqrtReal: bigint, stepRatio: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? mulDiv(sqrtReal, Q96, stepRatio) : mulDiv(sqrtReal, stepRatio, Q96);
}

/** One V2 constant-L geometric slice's gross input, in the solver's exact integer math.
 *  effIn = L*Q96/far - L*Q96/near (telescopes across a contiguous chain), grossed up by
 *  FEE_DENOM/(FEE_DENOM-feePpm). Mirrors ecoswap.sauce.ts's V2 forward branch and the
 *  oracle's V2 stream mirror bit-for-bit (per-slice mulDiv, so per-slice gross-up rounds
 *  independently — NOT one big mulDiv). */
export function v2SliceGross(L: bigint, near: bigint, far: bigint, feePpm: bigint): bigint {
  const effIn = mulDiv(L, Q96, far) - mulDiv(L, Q96, near);
  return mulDiv(effIn, FEE_DENOM, FEE_DENOM - feePpm);
}

/**
 * Analytic replay of the V2 constant-L forward walk (window brackets + WS2 #104 stream)
 * the oracle/solver performs: starting at out/in `spotNear`, take geometric slices
 * (`far = near - near*V2_STEP_BPS/V2_STEP_DEN`) at constant L, summing per-slice gross,
 * stopping when the running gross would cover `amountIn` (taking the exact remainder) or
 * after `maxSlices` (a >0 capacity floor). Returns the total gross spent and the running
 * out/in price reached. This is the KNOWN-ANSWER the V2-stream vector asserts against,
 * exact to the wei (same per-slice integer math as the oracle). With no `amountIn` cap
 * it sums the full `maxSlices` window+stream; the underlying effIn telescopes to one
 * L*Q96/farFinal - L*Q96/spotNear (interior boundaries cancel) — the constant-product
 * integral identity that justifies why the stream is path-additive past the window.
 */
export function v2WalkGross(
  L: bigint,
  spotNear: bigint,
  feePpm: bigint,
  maxSlices: number,
  amountIn?: bigint,
): { gross: bigint; near: bigint; slices: number } {
  let near = spotNear;
  let gross = 0n;
  let slices = 0;
  for (let i = 0; i < maxSlices; i++) {
    const far = near - mulDiv(near, V2_STEP_BPS, V2_STEP_DEN);
    if (far <= 0n || far >= near) break;
    const sliceGross = v2SliceGross(L, near, far, feePpm);
    if (sliceGross > 0n) {
      if (amountIn !== undefined && gross + sliceGross >= amountIn) {
        gross = amountIn; // take the exact remainder; the slice is partially consumed
        slices++;
        near = far;
        return { gross, near, slices };
      }
      gross += sliceGross;
    }
    slices++;
    near = far;
  }
  return { gross, near, slices };
}

// ── Multi-hop route composition (2-hop now; structured to extend to N) ──────
// PURE-VALUE helpers that compose a multi-leg route into a single out/in venue
// comparable to a direct pool in the price-ordered merge. A route A->X->B is a
// chain of LEGS; each leg is (currently) a constant-L bracket [nearOI > farOI]
// in unified out/in sqrt-Q96 space (nearOI > farOI as the bracket is traversed).
// The route head is the LEFT-TO-RIGHT product fold of per-leg fee-adjusted out/in
// sqrt heads, rescaled by Q96 each fold so it stays a comparable out/in sqrt.
//
// N-hop note: routeEvent generalizes by folding routeEvent across legs — find the
// BINDING leg (the one that crosses its tick first), then back-invert that leg's
// required input through the UPSTREAM legs (invertFarFromOut chained against each
// upstream leg) and forward-propagate through the DOWNSTREAM legs
// (invertFarFromGrossIn chained). The 2-hop forms below are the base case; keep
// the leg-tuple shape so the inversion chain extends without reshaping callers.

/**
 * Product fold of two out/in SQRT heads, rescaled by Q96 so the result is itself
 * a comparable out/in sqrt: sqrt(rateBA)*2^96 = (h1/2^96)*(h2/2^96)*2^96 = h1*h2/2^96.
 */
export function composeStep(accSqrtQ96: bigint, legSqrtQ96: bigint): bigint {
  return mulDiv(accSqrtQ96, legSqrtQ96, Q96);
}

/**
 * Fold per-leg out/in sqrt heads LEFT-TO-RIGHT via composeStep into one route head.
 * NOTE: integer mulDiv is NOT associative — the fold order is FIXED and MUST be
 * identical everywhere (solver, oracle, reference) or heads diverge by a wei.
 */
export function routeHeadFold(legSqrts: bigint[]): bigint {
  let acc = legSqrts[0];
  for (let i = 1; i < legSqrts.length; i++) acc = composeStep(acc, legSqrts[i]);
  return acc;
}

/**
 * Gross input (tokenIn units incl. fee) to traverse a constant-L bracket
 * [nearOI > farOI] in out/in space:
 *   effIn = L*2^96/farOI - L*2^96/nearOI;  grossIn = effIn * FEE_DENOM/(FEE_DENOM - fee).
 * Same integer form as bracketCapacity, kept as a route-leg primitive.
 */
export function bracketGross(L: bigint, nearOI: bigint, farOI: bigint, feePpm: bigint): bigint {
  const effIn = mulDiv(L, Q96, farOI) - mulDiv(L, Q96, nearOI);
  return mulDiv(effIn, FEE_DENOM, FEE_DENOM - feePpm);
}

/** Output produced over a constant-L bracket [nearOI > farOI]: L*(nearOI - farOI)/2^96. */
export function bracketOut(L: bigint, nearOI: bigint, farOI: bigint): bigint {
  return mulDiv(L, nearOI - farOI, Q96);
}

/**
 * The far OI after absorbing `grossIn` (incl. fee) within a constant-L bracket —
 * the localQuote partial inversion. effIn nets the fee; invLow = 1/nearOI + effIn/(L*2^96);
 * far = L*2^96/invLow (0 if degenerate).
 */
export function invertFarFromGrossIn(L: bigint, nearOI: bigint, grossIn: bigint, feePpm: bigint): bigint {
  // Zero input ⇒ zero movement: far == near EXACTLY. The reciprocal round-trip
  // mulDiv(L,Q96, mulDiv(L,Q96,near)) does NOT recover `near` (it rounds to far >= near, off by up
  // to ~1e5 wei), which would underflow bracketOut/bracketGross (near - far < 0) at the interior
  // L==0 gap events the routes feed 0 flow through. Special-case it so a gap event moves nothing.
  if (grossIn === 0n) return nearOI;
  const effIn = mulDiv(grossIn, FEE_DENOM - feePpm, FEE_DENOM);
  const invNear = mulDiv(L, Q96, nearOI);
  const invLow = invNear + effIn;
  return invLow > 0n ? mulDiv(L, Q96, invLow) : 0n;
}

/** The far OI after producing `outAmt` within a constant-L bracket: nearOI - outAmt*2^96/L. */
export function invertFarFromOut(L: bigint, nearOI: bigint, outAmt: bigint): bigint {
  return nearOI - mulDiv(outAmt, Q96, L);
}

/** One leg of a route: its CURRENT constant-L bracket plus fee. */
export interface RouteLeg {
  nearOI: bigint;
  farOI: bigint;
  L: bigint;
  feePpm: bigint;
}

/**
 * Token-A input required to FULLY cross leg `i` of a route, holding every other
 * leg at constant L and maintaining conservation. For leg 0 this is just leg 0's
 * full gross input; for a downstream leg it is its full gross input (token T_i)
 * back-propagated through the upstream legs — at each upstream leg j (from i-1
 * down to 0) the leg must PRODUCE the downstream's required input, so its far is
 * `invertFarFromOut(Lj, nj, need)` and its own required gross input becomes the
 * `need` of the next-upstream leg. The chain is monotone in routeIn, so the leg
 * with the smallest token-A crossing input crosses its own tick FIRST — it binds.
 *
 * The back-propagation is only physical while every upstream leg STAYS WITHIN its
 * current bracket: if supplying leg i's requirement would push an upstream leg past
 * its OWN far (the upstream leg crosses first), leg i cannot be the binding leg here
 * — we return `-1n` (sentinel "not binding"), and the argmin in routeEventN picks the
 * upstream leg that crosses first. Fixed truncation order (back-to-front); pure
 * bigint; bounded by `i`.
 */
function tokenAInputToCrossLeg(legs: RouteLeg[], i: number): bigint {
  const li = legs[i];
  let need = bracketGross(li.L, li.nearOI, li.farOI, li.feePpm); // leg i full-cross gross (token T_i)
  for (let j = i - 1; j >= 0; j--) {
    const lj = legs[j];
    // An upstream leg sitting at an interior L==0 gap (the walk-through-gap design leaves it active
    // with 0 liquidity) can PRODUCE nothing this bracket, so it must advance THROUGH its own gap
    // before leg i can bind — leg i is not binding through it. Treat it exactly like "upstream
    // crosses first" (the -1 sentinel), and bail BEFORE invertFarFromOut divides by lj.L (a 0
    // divisor Panics on-chain — this is the mirror of the solver Phase B lgL[j]==0 guard).
    if (lj.L === 0n) return -1n;
    const farj = invertFarFromOut(lj.L, lj.nearOI, need); // leg j far that PRODUCES `need`
    if (farj <= lj.farOI) return -1n; // upstream leg j would cross its OWN tick first ⇒ leg i not binding
    need = bracketGross(lj.L, lj.nearOI, farj, lj.feePpm); // leg j gross input → next-upstream need
  }
  return need; // == token-A gross input to fully cross leg i
}

/**
 * Resolve one route EVENT across `k` legs (k >= 2): advance the route until the
 * BINDING leg (the one whose full tick-cross maps to the SMALLEST token-A input
 * when propagated through the chain) fully crosses, with conservation at every
 * intermediate (leg i output == leg i+1 gross-in). The binding leg lands EXACTLY
 * on its bracket far; the upstream legs back-invert (`invertFarFromOut`) to produce
 * the binding leg's exact required input; the downstream legs forward-invert
 * (`invertFarFromGrossIn`) to absorb the upstream leg's exact output. Ties favor
 * the EARLIER (lower-index) leg — bit-identical to routeEvent2's `dXa <= dXb`.
 *
 * Returns route-level (routeIn, routeOut), the binding leg index `bindLeg`, the
 * per-leg new fars `newFars[i]` (the binding leg keeps its bracket far; the caller
 * crosses that tick + updates L via net), and `dX` (the binding leg's throughput at
 * its own boundary — its OUTPUT if it is the first leg, else its GROSS INPUT).
 *
 * Reduces EXACTLY to routeEvent2 at k=2 (see ecoswap.math.test.ts identity guard).
 */
export function routeEventN(
  legs: RouteLeg[],
): { routeIn: bigint; routeOut: bigint; bindLeg: number; newFars: bigint[]; dX: bigint } {
  const k = legs.length;
  // 1) Binding leg = argmin token-A crossing input over the REACHABLE legs (a `-1n` sentinel
  //    means an upstream leg crosses before this one — skip it). Leg 0 is always reachable, so
  //    there is always a binding leg; lowest index wins ties (strict `<` keeps the earlier leg).
  let bindLeg = 0;
  let routeIn = tokenAInputToCrossLeg(legs, 0);
  for (let i = 1; i < k; i++) {
    const cand = tokenAInputToCrossLeg(legs, i);
    if (cand >= 0n && cand < routeIn) {
      routeIn = cand;
      bindLeg = i;
    }
  }
  const newFars: bigint[] = new Array(k);
  // 2) Binding leg lands exactly on its bracket far (caller crosses the tick).
  const lb = legs[bindLeg];
  newFars[bindLeg] = lb.farOI;
  const bindGrossIn = bracketGross(lb.L, lb.nearOI, lb.farOI, lb.feePpm); // exact token-T_bind input
  const bindOut = bracketOut(lb.L, lb.nearOI, lb.farOI); // exact token-T_{bind+1} output
  // 3) Upstream legs (j < bindLeg): each PRODUCES the downstream leg's exact required input
  //    (back-invert via out). `need` starts as the binding leg's exact gross input.
  let need = bindGrossIn;
  for (let j = bindLeg - 1; j >= 0; j--) {
    const lj = legs[j];
    const farj = invertFarFromOut(lj.L, lj.nearOI, need);
    newFars[j] = farj;
    need = bracketGross(lj.L, lj.nearOI, farj, lj.feePpm);
  }
  routeIn = need; // token-A gross input (== the min for the binding leg, recomputed exactly)
  // 4) Downstream legs (j > bindLeg): each ABSORBS the upstream leg's exact output as gross-in
  //    (forward-invert). `flow` starts as the binding leg's exact output.
  let flow = bindOut;
  for (let j = bindLeg + 1; j < k; j++) {
    const lj = legs[j];
    const farj = invertFarFromGrossIn(lj.L, lj.nearOI, flow, lj.feePpm);
    newFars[j] = farj;
    flow = bracketOut(lj.L, lj.nearOI, farj);
  }
  const routeOut = flow; // exact output of the final leg
  const dX = bindLeg === 0 ? bindOut : bindGrossIn;
  return { routeIn, routeOut, bindLeg, newFars, dX };
}

/**
 * Forward-propagate a partial route input `targetRouteIn` through ALL `k` legs'
 * current brackets — used when the route is the crossing venue at the global cut
 * and takes the remainder. leg 0 absorbs `targetRouteIn` (gross) and produces its
 * output; that output is leg 1's gross-in; … ; the final leg's output is routeOut.
 * Returns `routeOut` and the per-leg new fars `newFars[i]`.
 *
 * Reduces EXACTLY to routePartial2 at k=2 (f1p/f2p == newFars[0]/newFars[1]).
 */
export function routePartialN(
  legs: RouteLeg[],
  targetRouteIn: bigint,
): { routeOut: bigint; newFars: bigint[] } {
  const k = legs.length;
  const newFars: bigint[] = new Array(k);
  let flow = targetRouteIn; // gross input into the current leg (token A at leg 0)
  for (let j = 0; j < k; j++) {
    const lj = legs[j];
    const farj = invertFarFromGrossIn(lj.L, lj.nearOI, flow, lj.feePpm);
    newFars[j] = farj;
    flow = bracketOut(lj.L, lj.nearOI, farj); // this leg's output → next leg's gross-in
  }
  return { routeOut: flow, newFars };
}

/**
 * Resolve one route EVENT across two legs. Thin k=2 wrapper over routeEventN so the
 * 2-hop path stays BIT-IDENTICAL to the general implementation by construction.
 *   bind=1: leg1 crosses fully, leg2 partial — absorb dXa into leg2 (forward).
 *   bind=2: leg2 crosses fully, leg1 partial to PRODUCE dXb (back-invert via out).
 * Returns route-level (routeIn, routeOut), the bound `dX`, and the new fars: the
 * crossed leg keeps its bracket far (caller crosses the tick + updates L via net),
 * the partial leg's near becomes its returned new far.
 */
export function routeEvent2(
  leg1: RouteLeg,
  leg2: RouteLeg,
): { routeIn: bigint; routeOut: bigint; bind: 1 | 2; newF1: bigint; newF2: bigint; dX: bigint } {
  const ev = routeEventN([leg1, leg2]);
  return {
    routeIn: ev.routeIn,
    routeOut: ev.routeOut,
    bind: ev.bindLeg === 0 ? 1 : 2,
    newF1: ev.newFars[0],
    newF2: ev.newFars[1],
    dX: ev.dX,
  };
}

/**
 * Forward-propagate a partial route input `targetRouteIn` through both legs. Thin
 * k=2 wrapper over routePartialN. leg1 absorbs targetRouteIn (gross), produces X1;
 * leg2 absorbs X1 (gross), produces routeOut.
 */
export function routePartial2(
  leg1: RouteLeg,
  leg2: RouteLeg,
  targetRouteIn: bigint,
): { routeOut: bigint; f1p: bigint; f2p: bigint; X1: bigint } {
  const r = routePartialN([leg1, leg2], targetRouteIn);
  const X1 = bracketOut(leg1.L, leg1.nearOI, r.newFars[0]);
  return { routeOut: r.routeOut, f1p: r.newFars[0], f2p: r.newFars[1], X1 };
}
