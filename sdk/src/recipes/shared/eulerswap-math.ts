/**
 * EulerSwap (Euler vault-backed AMM, v1+v2) — VERBATIM bigint replay + off-chain segment sampler.
 *
 * THE SINGLE SOURCE for EulerSwap swap math. Imported by BOTH:
 *   - the production `prepare.ts` (buildEulerSwapSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (eulerSwapSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the per-pool
 * executed output == computeQuote(awarded share) to the wei (one atomic pool.swap with EMPTY data).
 *
 * THE EULER CURVE IS OFF-CHAIN ONLY (for the SPLIT). The on-chain solver does NOT recompute the
 * asymmetric concentrated-liquidity curve (f / fInverse) or its closed-form sqrt — it samples the
 * curve OFF-CHAIN into (capacity, effOut, marginalOI) SEGMENTS via this exact replay, consumes them
 * as STATIC segments through the existing static-segment cursor (the same machinery the merge uses
 * for Curve / LB / DODO / Solidly / Wombat segments), and EXECUTES each EulerSwap pool CALLBACK-FREE:
 * an on-chain `pool.computeQuote(tokenIn, tokenOut, awardedShare, true)` staticcall yields the EXACT
 * amountOut (the periphery `quoteExactInput` delegates to this view, and the view IS the swap math),
 * the awarded input is transferred to the pool, and `pool.swap(amount0Out, amount1Out, to, "")` lands
 * the swap. EulerSwap's `swap` is Uniswap-V2-shaped: with EMPTY `data` it does NO flash callback —
 * it optimistically transfers the output, sweeps `balanceOf(this)` for the pre-transferred input, and
 * VERIFIES the curve invariant. So it is callback-free (the proven Solidly/Wombat pattern) and needs
 * NO engine SwapPoolType (it is NOT xy=k — it is the asymmetric Euler curve — so _swapV2 would
 * mis-price it). The only re-entry on the empty-data path is internal to Euler (the `callThroughEVC`
 * self-wrap pool→EVC→pool, and the vault deposit/withdraw pool→EVault) — it never re-enters the
 * cooking contract, so the V3/V4-callback barrier does not apply.
 *
 * SOURCE MIRRORED — the canonical euler-xyz/euler-swap `CurveLib.f` + `QuoteLib.computeQuote` /
 * `findCurvePoint` (whitepaper eqs 23-27). Reproduced bit-for-bit (all curve params are 1e18 fixed
 * point: priceX/priceY, concentrationX/concentrationY; reserves and equilibrium reserves are RAW token
 * units; fee is 1e18-scaled):
 *   QuoteLib.computeQuote(exactIn=true):
 *     amount      = amount - amount·fee/1e18                          # net the fee off the INPUT
 *     output      = findCurvePoint(reserves, amount, exactIn=true, asset0IsInput)
 *   findCurvePoint(exactIn, asset0IsInput=true):                      # tokenIn == asset0 (reserve0)
 *     xNew = reserve0 + amount
 *     yNew = xNew <= x0 ? f(xNew, px, py, x0, y0, cx)                 # in-region (still left of equilibrium)
 *                       : fInverse(xNew, py, px, y0, x0, cy)          # out-region (right of equilibrium)
 *     output = reserve1 > yNew ? reserve1 - yNew : 0
 *   CurveLib.f(x, px, py, x0, y0, c):                                 # y on the curve at reserve x (x <= x0)
 *     c == 1e18 : output = y0 + ceil((x0 - x)·px / py)                # the linear (full-range) limit
 *     else      : a = px·(x0 - x); b = c·x + (1e18 - c)·x0; d = 1e18·x·py
 *                 output = y0 + ceilDiv(a·b, d)                       # saturatingMulDivUp (rounds UP)
 *
 * Symmetric for asset1IsInput (px/py and cx/cy swapped, reserves mirrored) — exactly the contract's
 * branch. We sample EXACT-IN (positive amount), which uses only the f() in-region branch when the
 * pool stays left of equilibrium (the deep-liquidity regime EcoSwap discovers), and fInverse past it.
 * fInverse is the closed-form whitepaper sqrt (NO Newton, expressible with isqrt/mulDiv) — but for the
 * SPLIT sampler we only need computeQuote(dx), so we replay the contract's `findCurvePoint` directly.
 *
 * The replay is CLOSED-FORM (one ceil-div per f, or one isqrt per fInverse) — NO unbounded loop. It
 * runs purely on the read pool state (reserve0/reserve1, the curve params, fee); buildEulerSwapSegments
 * makes NO extra RPC.
 *
 * VAULT-CAP BOUND. EulerSwap depth is gated by the Euler vault available cash / borrow cap, NOT only by
 * the curve: `EulerSwapPeriphery.getLimits(pool, tokenIn, tokenOut)` returns (inLimit, outLimit). prepare
 * BOUNDS each pool's sampled amountIn by `min(amountIn, inLimit)` so no segment promises depth the vault
 * cannot service. Between prepare and cook the cap can shrink (another swap drew the vault down); the
 * on-chain `computeQuote` view re-reads the LIVE limits and reverts `SwapLimitExceeded` if the awarded
 * share now exceeds them — so the recipe reads `computeQuote` at execution (the exec lever), and the
 * solver's existing GUARDED TERMINAL REFUND (the global leftover sweep) returns any input whose pool
 * declined to fill, leaving the swap atomic and safe. This is the vault-cap guard.
 *
 * WEI-EXACT BOUND. The SPLIT (per-pool awarded input) is EXACT-ON-GRID vs the oracle (both replay the
 * SAME buildEulerSwapSegments grid — one source — so the awarded share matches the oracle bit-for-bit).
 * The realized dy is EXACT-IN-DY: the per-pool out for the awarded slice is re-evaluated wei-exact by ONE
 * atomic on-chain computeQuote(Σ share) at execution, because the pool's `computeQuote` view IS the math
 * its `swap` enforces (swap optimistically pays out and then verifies the SAME curve the quote walked).
 * So awarded-input == oracle (exact-on-grid) and received-dy == computeQuote(awarded) (exact-in-dy) — the
 * same standard as Curve / DODO / Solidly / Wombat. Marginal equalization across pools is a DIAGNOSTIC
 * (a grid bound), not the wei gate.
 *
 * Sources:
 *   https://github.com/euler-xyz/euler-swap/blob/master/src/libraries/CurveLib.sol  (f / fInverse / verify)
 *   https://github.com/euler-xyz/euler-swap/blob/master/src/libraries/QuoteLib.sol  (computeQuote / findCurvePoint / calcLimits)
 *   https://github.com/euler-xyz/euler-swap/blob/master/src/EulerSwapPeriphery.sol  (quoteExactInput / getLimits)
 */

import { pushMonotoneSegment } from "./segment-merge.js";

/** 2^192 — the unified out/in sqrt fixed-point scale (matches the other *-math modules' Q192). */
export const Q192 = 1n << 192n;

/** EulerSwap curve fixed-point ONE — 1e18 (prices, concentrations, fee). */
export const EULER_ONE = 10n ** 18n;

/**
 * Round an EulerSwap fee (1e18-scaled, e.g. 1e15 = 0.1%) to a ppm fee (the price-ordering coordinate /
 * diagnostic) — ROUND-HALF-UP. THE SINGLE SOURCE: discovery (`discoverEulerSwapPoolsTyped`), the prod-mirror
 * `offPool` descriptor, and the known-answer test descriptors ALL build `feePpm` through this one helper, so
 * the ordering coordinate matches bit-for-bit (a truncating vs round-half-up mismatch could order-differ a
 * higher-fee pool between the oracle-under-test and the production descriptor — see the review finding).
 */
export function eulerFeeToPpm(feeWad: bigint): number {
  return Number((feeWad * 1_000_000n + EULER_ONE / 2n) / EULER_ONE);
}

/** Integer square root (Babylonian) — bit-identical to the other *-math modules' `isqrt`. */
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

/** Ceil-div (a/b rounded UP) — the jslib `ceilDiv`. */
function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  return (a + b - 1n) / b;
}

/** mulDivCeil(x,y,d) = ceil(x·y/d) — the jslib `mulDivCeil`. */
function mulDivCeil(x: bigint, y: bigint, d: bigint): bigint {
  if (d === 0n) return 0n;
  return (x * y + d - 1n) / d;
}

/** Bit-length of x (>= 1 for x>0), used by the absB² overflow scale (jslib computeScale). */
function bitLength(x: bigint): bigint {
  let bits = 0n;
  let r = x;
  while (r > 0n) {
    r >>= 1n;
    bits++;
  }
  return bits;
}

/** computeScale(x) — 2^(bits-128) when x exceeds 128 bits, else 1 (jslib overflow guard). */
function computeScale(x: bigint): bigint {
  const bits = bitLength(x);
  if (bits > 128n) return 1n << (bits - 128n);
  return 1n;
}

/** Integer square root rounded UP (the jslib `sqrtCeil`). */
function sqrtCeil(x: bigint): bigint {
  if (x < 2n) return x;
  const r = isqrt(x);
  return r * r < x ? r + 1n : r;
}

/**
 * One discovered EulerSwap pool, oriented for a tokenIn → tokenOut swap.
 *
 * EulerSwap pools are single-LP vault-backed AMMs with an ASYMMETRIC concentrated-liquidity curve. A
 * 2-token swap reads the LIVE reserves (reserve0/reserve1, uint112) + the static curve params
 * (equilibrium reserves x0/y0, prices px/py, concentrations cx/cy, all 1e18) + the directional fee
 * (1e18) + the vault `inLimit` (the input cap from getLimits). The on-chain execution is CALLBACK-FREE
 * (computeQuote staticcall + transfer + pool.swap(...,"")), so the fields here are OFF-CHAIN ONLY — they
 * feed buildEulerSwapSegments (the price/capacity replay).
 *
 * `inIsToken0` orients the curve (tokenIn is asset0 ⇒ x is the in-side) AND the swap's output slot
 * (tokenIn==token0 ⇒ out is amount1Out). `reserveIn`/`reserveOut` are the LIVE reserves oriented by
 * tokenIn. The curve params are stored in the pool's CANONICAL (asset0/asset1) orientation; `inIsToken0`
 * selects which f/fInverse branch and which (px,py)/(cx,cy) pairing the replay uses.
 */
export interface EulerSwapPool {
  /** Pool address — the computeQuote/getLimits/swap target. */
  address: `0x${string}`;
  /** true => tokenIn is the pool's token0/asset0 (output is amount1Out); false => output is amount0Out. */
  inIsToken0: boolean;
  /** LIVE tokenIn-side reserve (== reserve0 when inIsToken0, else reserve1). */
  reserveIn: bigint;
  /** LIVE tokenOut-side reserve. */
  reserveOut: bigint;
  /** Equilibrium reserve on the tokenIn side (x0 when inIsToken0, else y0). */
  equilIn: bigint;
  /** Equilibrium reserve on the tokenOut side. */
  equilOut: bigint;
  /** Price of the IN asset (px when inIsToken0, else py), 1e18. */
  priceIn: bigint;
  /** Price of the OUT asset (py when inIsToken0, else px), 1e18. */
  priceOut: bigint;
  /** Concentration of the IN asset (cx when inIsToken0, else cy), 1e18. The f() c argument. */
  concIn: bigint;
  /** Concentration of the OUT asset (cy when inIsToken0, else cx), 1e18. The fInverse cy argument. */
  concOut: bigint;
  /** Directional swap fee (1e18-scaled; e.g. 1e15 = 0.1%). The fee charged when tokenIn is the input. */
  feeWad: bigint;
  /** Vault input cap (from getLimits — supplyVault.maxDeposit + borrow debt). Bounds the sampler. 0 ⇒ uncapped. */
  inLimit: bigint;
  /** Rounded ppm fee (the price-ordering coordinate / diagnostic). */
  feePpm: number;
  /** Discovery source label. */
  source: string;
}

/**
 * CurveLib.f(x, px, py, x0, y0, c) — the y-reserve on the curve at the IN-side reserve `x` (x <= x0),
 * mirroring the canonical euler-swap-jslib `f` bit-for-bit (the GENERAL form — it handles c == 1e18 as a
 * special case automatically, no separate branch). Two ceil-divides:
 *   v   = px·(x0 - x)·(c·x + (1e18 - c)·x0)
 *   v   = ceil(v / (x·1e18))
 *   out = y0 + ceil(v / py)
 */
function f(x: bigint, px: bigint, py: bigint, x0: bigint, y0: bigint, c: bigint): bigint {
  if (x >= x0) return y0; // at/past equilibrium on this side ⇒ the curve's y floor (f domain is x <= x0)
  let v = px * (x0 - x) * (c * x + (EULER_ONE - c) * x0);
  const denom = x * EULER_ONE;
  v = (v + (denom - 1n)) / denom;
  return y0 + (v + (py - 1n)) / py;
}

/**
 * fInverse(y, px, py, x0, y0, cx) — the IN-side reserve `x` that holds the curve at OUT-side reserve `y`
 * (the out-region, past equilibrium), the closed-form whitepaper root (eqs 23-27), mirroring the canonical
 * euler-swap-jslib `fInverse` bit-for-bit (dimensionally-scaled — every product is reduced by 1e18 to keep
 * magnitudes bounded; the absB² overflow uses computeScale exactly like the contract):
 *   term1 = ceil(py·1e18·(y - y0) / px) ; term2 = (2·cx - 1e18)·x0
 *   B     = (term1 - term2) / 1e18
 *   C     = ceil((1e18 - cx)·x0² / 1e18) ; fourAC = ceil(4·cx·C / 1e18)
 *   sqrt  = sqrtCeil(B² + fourAC)   (B² via computeScale when |B| >= 1e36)
 *   x     = B <= 0 ? ceil((|B| + sqrt)·1e18 / (2·cx)) + 1 : ceil(2·C / (|B| + sqrt)) + 1
 * Returns x (clamped to x0 when x >= x0 — the f domain boundary).
 */
function fInverse(y: bigint, px: bigint, py: bigint, x0: bigint, y0: bigint, cx: bigint): bigint {
  const term1 = mulDivCeil(py * EULER_ONE, y - y0, px);
  const term2 = (2n * cx - EULER_ONE) * x0;
  const B = (term1 - term2) / EULER_ONE;
  const C = mulDivCeil(EULER_ONE - cx, x0 * x0, EULER_ONE);
  const fourAC = mulDivCeil(4n * cx, C, EULER_ONE);
  const absB = B >= 0n ? B : -B;

  let sqrt: bigint;
  if (absB < 10n ** 36n) {
    sqrt = sqrtCeil(absB * absB + fourAC);
  } else {
    const scale = computeScale(absB);
    const squaredB = mulDivCeil(absB / scale, absB, scale);
    sqrt = sqrtCeil(squaredB + fourAC / (scale * scale)) * scale;
  }

  let x: bigint;
  if (B <= 0n) {
    x = mulDivCeil(absB + sqrt, EULER_ONE, 2n * cx) + 1n;
  } else {
    x = ceilDiv(2n * C, absB + sqrt) + 1n;
  }
  if (x >= x0) return x0;
  return x;
}

/**
 * findCurvePoint(pool, dx, exactIn=true) for the IN side — the EXACT out for `dx` tokenIn of net input
 * (AFTER the fee has been deducted), mirroring QuoteLib.findCurvePoint(exactIn=true, asset0IsInput) on the
 * tokenIn-oriented reserves (x is the IN reserve, y the OUT reserve):
 *   xNew = reserveIn + dxNet
 *   yNew = xNew <= equilIn ? f(xNew, pIn, pOut, equilIn, equilOut, concIn)        # in-region
 *                          : fInverse(xNew, pOut, pIn, equilOut, equilIn, concOut) # out-region
 *   out  = reserveOut > yNew ? reserveOut - yNew : 0
 * NOTE the param mirroring: in the contract's asset0-input branch the in-region calls f(x, px, py, x0,
 * y0, cx) and the out-region calls fInverse(x, py, px, y0, x0, cy) — so on our tokenIn-oriented view
 * (pIn=px-of-in-asset, equilIn=x0-of-in-asset) the f() takes (pIn, pOut, equilIn, equilOut, concIn) and
 * the fInverse takes (pOut, pIn, equilOut, equilIn, concOut). The orientation is folded into the pool
 * descriptor by `inIsToken0` at discovery, so this one function serves both swap directions.
 */
function findCurvePointIn(pool: EulerSwapPool, dxNet: bigint): bigint {
  const xNew = pool.reserveIn + dxNet;
  let yNew: bigint;
  if (xNew <= pool.equilIn) {
    yNew = f(xNew, pool.priceIn, pool.priceOut, pool.equilIn, pool.equilOut, pool.concIn);
  } else {
    yNew = fInverse(xNew, pool.priceOut, pool.priceIn, pool.equilOut, pool.equilIn, pool.concOut);
  }
  return pool.reserveOut > yNew ? pool.reserveOut - yNew : 0n;
}

/**
 * computeQuote(pool, dx) — the EXACT actual tokens-out for `dx` tokenIn (native units), INCLUDING the
 * swap fee. Mirrors QuoteLib.computeQuote(exactIn=true) bit-for-bit:
 *   amount = dx - dx·fee/1e18                       # net the fee off the input (DSMath floor)
 *   out    = findCurvePoint(reserves, amount, exactIn=true, asset0IsInput)
 * The realized swap output equals this to the wei (EulerSwap.swap optimistically pays out then verifies
 * the SAME curve the quote walked). The exact-IN path only (positive amount); the exact-out branch
 * (inflating the input by 1/(1-fee)) is unused here.
 */
export function computeQuote(pool: EulerSwapPool, dx: bigint): bigint {
  if (dx <= 0n) return 0n;
  const fee = (dx * pool.feeWad) / EULER_ONE;
  const net = dx - fee;
  if (net <= 0n) return 0n;
  return findCurvePointIn(pool, net);
}

/**
 * One sampled EulerSwap segment in unified out/in price space — identical shape to a Curve / LB / DODO /
 * Solidly / Wombat / route segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput
 * (tokenIn) for this slice, `effOut` the Δoutput, and `marginalOI` the unified out/in sqrt =
 * isqrt(effOut·2^192/capacity) — the price-ordering coordinate. Segments are emitted in DESCENDING
 * `marginalOI` order (the natural order of a convex curve: the first marginal slice is the best-priced).
 *
 * fee-adjust: marginalOI is computed from the POST-FEE dy (computeQuote already nets the fee), so it is
 * ALREADY the fee-adjusted execution price — it enters the merge's descending-price sort directly (no
 * extra sqrtOneMinusFee multiply), exactly like Curve / LB / DODO / Solidly / Wombat segments.
 */
export interface EulerSwapSegment {
  /** Δinput (tokenIn) to traverse this slice. */
  capacity: bigint;
  /** Δoutput (tokenOut) over this slice. */
  effOut: bigint;
  /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
  marginalOI: bigint;
}

/** Default sample count per EulerSwap pool (M). Tunable; M≈24 tightens the grid bound. */
export const EULERSWAP_SAMPLES = Number(process.env.ECO_EULERSWAP_SAMPLES ?? 24);

/**
 * Sample an EulerSwap pool into M descending-marginal segments over [0, min(amountIn, inLimit)].
 *
 * BOUND BY THE VAULT CAP: the sampled range is capped at the pool's vault `inLimit` (from getLimits) so
 * no segment promises depth the Euler vault cannot service. If `inLimit` is 0 it is treated as uncapped
 * (the test path / a pool whose limit was not read).
 *
 * Geometric-ish cumulative inputs (∝ s^2 — denser near 0 where the curve is flattest near equilibrium,
 * then bends), each replayed through computeQuote on the READ state (NO extra RPC — pure closed-form
 * bigint). Each increment becomes a (capacity=Δin, effOut=Δout, marginalOI) segment. The samples are
 * monotone in input so the marginals are naturally descending (a convex out(in)); a non-descending
 * slice (rounding noise near saturation, or a non-convex region past the pool's effective depth) is
 * FOLDED into the last segment (isotonic backward-merge — capacity + effOut conserved, blended marginal
 * recomputed) so the merge stays monotone price-ordered without discarding liquidity. See
 * shared/segment-merge.ts.
 *
 * Exact-on-grid: the split equalizes marginals on THIS sampled grid; the per-pool out for the awarded Σ
 * share is re-evaluated wei-exact by one atomic on-chain computeQuote(Σ share) at execution. Mirrors
 * `buildWombatSegments` / `buildSolidlyStableSegments` (same squared-index geometric grid + isotonic
 * backward-merge).
 */
export function buildEulerSwapSegments(
  pool: EulerSwapPool,
  amountIn: bigint,
  samples: number = EULERSWAP_SAMPLES,
): EulerSwapSegment[] {
  if (amountIn <= 0n) return [];
  const cap = pool.inLimit > 0n && pool.inLimit < amountIn ? pool.inLimit : amountIn;
  if (cap <= 0n) return [];
  const M = BigInt(samples);
  const segs: EulerSwapSegment[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (let s = 1; s <= samples; s++) {
    // cumulative input ∝ s^2 (fine slices near 0, coarse near cap).
    const ss = BigInt(s);
    const input = (cap * ss * ss) / (M * M);
    if (input <= prevIn) continue;
    const out = computeQuote(pool, input);
    if (out <= 0n) continue;
    const dIn = input - prevIn;
    const dOut = out - prevOut;
    if (dIn > 0n && dOut > 0n) {
      const marginalOI = isqrt((dOut * Q192) / dIn);
      // Isotonic backward-merge (liquidity-preserving) — a non-descending slice is FOLDED into the
      // last segment, not dropped, so no liquidity is discarded. See shared/segment-merge.ts.
      pushMonotoneSegment(segs, dIn, dOut, marginalOI);
    }
    prevIn = input;
    prevOut = out;
  }
  return segs;
}
