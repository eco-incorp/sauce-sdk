/**
 * Balancer V2 ComposableStable — VERBATIM bigint replay + off-chain segment sampler.
 *
 * THE SINGLE SOURCE for Balancer StableMath. Imported by BOTH:
 *   - the production `prepare.ts` (buildBalancerStableSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (balancerStableSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the
 * per-pool executed out == calcOutGivenIn(awarded share) to the wei (one atomic Vault.swap).
 *
 * THE STABLE MATH IS OFF-CHAIN ONLY (for the SPLIT). The on-chain solver does NOT recompute the
 * A-invariant Newton — it samples the curve OFF-CHAIN into (capacity, effOut, marginalOI) SEGMENTS
 * via this exact replay, consumes them as STATIC segments through the existing static-segment cursor
 * (the same machinery the merge uses for route / Curve / LB / DODO segments), and EXECUTES each
 * Balancer pool via the ENGINE: swap(SwapParams{poolType:4=BalancerV2, pool, tokenIn, tokenOut,
 * amountSpecified}) → live _swapBalancerV2, which derives poolId via pool.getPoolId() and calls
 * Vault.swap(SingleSwap{GIVEN_IN}). No engine change (the BalancerV2 dispatch already exists).
 *
 * SOURCE MIRRORED — the canonical balancer-v2-monorepo `pkg/pool-stable/contracts/StableMath.sol`
 * (used by ComposableStablePool). Reproduced bit-for-bit:
 *   - `_calculateInvariant(amp, balances)`                     — Newton on D, bounded 255 iterations,
 *     ±1 convergence. `_AMP_PRECISION = 1e3`, `ampTimesTotal = amp·numTokens` (amp = A·AMP_PRECISION,
 *     read from getAmplificationParameter()[0]).
 *   - `_getTokenBalanceGivenInvariantAndAllOtherBalances(...)` — Newton on the out-token balance,
 *     bounded 255 iterations, ±1 convergence, with `divUp` on the final ratio (round in the pool's
 *     favor — the canonical StableMath rounding).
 *   - `_calcOutGivenIn(amp, balances, in, out, amountIn, inv)` — add amountIn to balances[in], solve
 *     for balances[out], return `balances[out] - finalBalanceOut - 1` (the `-1` is StableMath's
 *     round-down-in-pool-favor).
 *
 * COMPOSABLE-STABLE SPECIFICS (the BPT-index handling — see the wei-exact header below):
 *   - the pool's registered token list (Vault.getPoolTokens) INCLUDES the BPT (the pool token itself)
 *     at `bptIndex`. The BPT MUST be EXCLUDED from the StableMath balances + indices. We pass `balances`
 *     and the token indices ALREADY EXCLUDING the BPT (the off-chain CurvePool-analogue stores the
 *     non-BPT registered tokens only), so the replay operates exactly on the StableMath token set.
 *   - balances are UPSCALED by getScalingFactors() (decimals + rate-provider rates, all 1e18-WAD) BEFORE
 *     the math and the OUTPUT is DOWNSCALED after — exactly as ComposableStablePool._onSwapGivenIn does.
 *   - the swap fee (getSwapFeePercentage, 1e18-WAD) is taken on the UPSCALED amountIn FIRST (mulUp),
 *     before the invariant math, matching `_subtractSwapFeeAmount` + `_upscale`.
 *
 * WEI-EXACT BOUND. The SPLIT (per-pool awarded input) is EXACT-ON-GRID vs the oracle (both replay the
 * SAME buildBalancerStableSegments grid — one source — so the awarded share matches the oracle
 * bit-for-bit). The realized dy is EXACT-IN-DY: the per-pool out for the awarded slice is re-evaluated
 * by ONE atomic Vault.swap(GIVEN_IN) at execution, whose StableMath IS the math this replay mirrors —
 * so awarded-input == oracle (exact-on-grid) and received-dy == Vault.swap(awarded) (exact-in-dy), the
 * same standard as Curve/DODO. (Exact-in-dy holds to the wei when the off-chain rate/scaling factors
 * snapshot the live ones — the standard Balancer-integration snapshot assumption, as for Curve's A/fee.)
 *
 * The replay is BOUNDED (255-iteration Newton, exactly StableMath's loop bound) — no unbounded loops.
 * It runs purely on the read pool state (balances/scaling/amp/fee); buildBalancerStableSegments makes
 * NO extra RPC.
 *
 * Source:
 *   https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/pool-stable/contracts/StableMath.sol
 *   https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/pool-stable/contracts/ComposableStablePool.sol
 */

import { pushMonotoneSegment } from "./segment-merge.js";

/** 2^192 — the unified out/in sqrt fixed-point scale (matches curve-math / ecoswap.math Q192). */
export const Q192 = 1n << 192n;

/** Integer square root (Babylonian) — bit-identical to curve-math / ecoswap.math `isqrt`. */
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

/** Balancer StableMath amplification precision (`_AMP_PRECISION`). amp = A·AMP_PRECISION. */
export const AMP_PRECISION = 1_000n;
/** Balancer FixedPoint ONE — 1e18 WAD (scaling factors, rates, the swap fee are all WAD). */
export const WAD = 10n ** 18n;

// ── Balancer FixedPoint helpers (mulUp / mulDown / divUp / divDown) ──
// Mirror balancer-v2-monorepo `pkg/solidity-utils/contracts/math/FixedPoint.sol` + `Math.sol`.

/** mulDown(a,b) = a·b/1e18 (floor) — FixedPoint.mulDown. */
function mulDown(a: bigint, b: bigint): bigint {
  return (a * b) / WAD;
}
/** mulUp(a,b) = ceil(a·b/1e18) — FixedPoint.mulUp (0 when product is 0). */
function mulUp(a: bigint, b: bigint): bigint {
  const product = a * b;
  if (product === 0n) return 0n;
  return (product - 1n) / WAD + 1n;
}
/** divDown(a,b) = a·1e18/b (floor) — FixedPoint.divDown (0 when a is 0). */
function divDownWad(a: bigint, b: bigint): bigint {
  if (a === 0n) return 0n;
  return (a * WAD) / b;
}
/** divUp(a,b) = ceil(a·1e18/b) — FixedPoint.divUp (0 when a is 0). */
function divUpWad(a: bigint, b: bigint): bigint {
  if (a === 0n) return 0n;
  return (a * WAD - 1n) / b + 1n;
}
/** Math.divUp(a,b) = ceil(a/b) — the integer (non-WAD) divUp StableMath uses. */
function divUpInt(a: bigint, b: bigint): bigint {
  if (a === 0n) return 0n;
  return 1n + (a - 1n) / b;
}

/**
 * One discovered Balancer V2 ComposableStable pool, oriented for a tokenIn → tokenOut swap.
 *
 * The on-chain execution goes through the ENGINE (poolType 4 → _swapBalancerV2 → Vault.swap), so the
 * fields here are OFF-CHAIN ONLY — they feed buildBalancerStableSegments (the price/capacity replay).
 * `balances`/`scalingFactors` are the NON-BPT registered token arrays (the BPT already excluded), in
 * the pool's registered (non-BPT) token order; `i`/`j` index into them (tokenIn/tokenOut). `amp` is the
 * raw getAmplificationParameter()[0] value (= A·AMP_PRECISION). `swapFeeWad` is getSwapFeePercentage()
 * (1e18-WAD). `address` is the POOL address (the swap(SwapParams{poolType:4, pool}) target — the engine
 * derives the poolId).
 */
export interface BalancerStablePool {
  /** Always SwapPoolType.BalancerV2 (=4) — execution dispatches via swap(SwapParams{poolType:4}). */
  poolType: number;
  /** Pool address (the ComposableStablePool — getPoolId()/Vault.swap target). */
  address: `0x${string}`;
  /** Index of tokenIn into the NON-BPT balances/scalingFactors arrays. */
  i: number;
  /** Index of tokenOut into the NON-BPT balances/scalingFactors arrays. */
  j: number;
  /** Raw amplification (getAmplificationParameter()[0] = A·AMP_PRECISION). */
  amp: bigint;
  /** NON-BPT registered token balances (native decimals, the Vault.getPoolTokens balances sans BPT). */
  balances: bigint[];
  /**
   * Per-token scaling factor (length == balances.length, NON-BPT). scalingFactors[k] UPSCALES token k's
   * balance to the common 1e18 unit: upscaled = balance·scalingFactor[k]/1e18. It folds BOTH the
   * decimal scale (10**(18-decimals)·1e18) AND the rate-provider rate, exactly as
   * ComposableStablePool.getScalingFactors returns (the BPT's own scaling factor is dropped with it).
   */
  scalingFactors: bigint[];
  /** Swap fee percentage in 1e18-WAD (getSwapFeePercentage(); e.g. 1e15 = 0.1%). */
  swapFeeWad: bigint;
  /** Discovery source label. */
  source: string;
}

/**
 * _calculateInvariant(amplificationParameter, balances) — the StableMath D for the UPSCALED balances
 * and `amp` (= A·AMP_PRECISION). Newton iteration, bounded 255 steps, ±1 convergence. Mirrors
 * balancer-v2 StableMath._calculateInvariant bit-for-bit:
 *
 *   ampTimesTotal = amp · n
 *   D_P = D ; for each b in balances: D_P = divDown(D_P·D, b·n)
 *   D = divDown( (divDown(ampTimesTotal·sum, AMP_PRECISION) + D_P·n) · D ,
 *                divDown((ampTimesTotal - AMP_PRECISION)·D, AMP_PRECISION) + (n+1)·D_P )
 */
export function calculateInvariant(amp: bigint, balances: bigint[]): bigint {
  const n = BigInt(balances.length);
  let sum = 0n;
  for (const b of balances) sum += b;
  if (sum === 0n) return 0n;

  let invariant = sum;
  const ampTimesTotal = amp * n;
  for (let it = 0; it < 255; it++) {
    let D_P = invariant;
    for (const b of balances) {
      D_P = (D_P * invariant) / (b * n); // divDown(Math.mul(D_P, inv), Math.mul(b, n))
    }
    const prev = invariant;
    invariant =
      (((ampTimesTotal * sum) / AMP_PRECISION + D_P * n) * invariant) /
      (((ampTimesTotal - AMP_PRECISION) * invariant) / AMP_PRECISION + (n + 1n) * D_P);
    if (invariant > prev) {
      if (invariant - prev <= 1n) break;
    } else {
      if (prev - invariant <= 1n) break;
    }
  }
  return invariant;
}

/**
 * _getTokenBalanceGivenInvariantAndAllOtherBalances — solve for `balances[tokenIndex]` that holds the
 * invariant constant given all OTHER balances. Newton iteration, bounded 255 steps, ±1 convergence.
 * Mirrors balancer-v2 StableMath bit-for-bit (Math.divUp on the final ratio):
 *
 *   ampTimesTotal = amp·n ; sum = b[0] ; P_D = n·b[0]
 *   for j in 1..n: P_D = divDown(P_D·b[j]·n, invariant) ; sum += b[j]
 *   sum -= b[tokenIndex]
 *   inv2 = invariant²
 *   c = divUp(inv2, ampTimesTotal·P_D) · AMP_PRECISION · b[tokenIndex]
 *   b = sum + divDown(invariant, ampTimesTotal)·AMP_PRECISION
 *   y = divUp(inv2 + c, invariant + b)
 *   loop: y = divUp(y² + c, 2y + b - invariant)   (until ±1)
 */
export function getTokenBalanceGivenInvariant(
  amp: bigint,
  balances: bigint[],
  invariant: bigint,
  tokenIndex: number,
): bigint {
  const n = BigInt(balances.length);
  const ampTimesTotal = amp * n;
  let sum = balances[0];
  let P_D = n * balances[0];
  for (let k = 1; k < balances.length; k++) {
    P_D = (P_D * balances[k] * n) / invariant; // divDown(Math.mul(Math.mul(P_D, b[k]), n), invariant)
    sum += balances[k];
  }
  sum -= balances[tokenIndex];

  const inv2 = invariant * invariant;
  // c = Math.mul(Math.mul(Math.divUp(inv2, ampTimesTotal·P_D), AMP_PRECISION), b[tokenIndex])
  const c = divUpInt(inv2, ampTimesTotal * P_D) * AMP_PRECISION * balances[tokenIndex];
  // b = sum + Math.mul(Math.divDown(invariant, ampTimesTotal), AMP_PRECISION)
  const b = sum + (invariant / ampTimesTotal) * AMP_PRECISION;

  let tokenBalance = divUpInt(inv2 + c, invariant + b);
  for (let it = 0; it < 255; it++) {
    const prev = tokenBalance;
    tokenBalance = divUpInt(tokenBalance * tokenBalance + c, tokenBalance * 2n + b - invariant);
    if (tokenBalance > prev) {
      if (tokenBalance - prev <= 1n) break;
    } else {
      if (prev - tokenBalance <= 1n) break;
    }
  }
  return tokenBalance;
}

/**
 * _calcOutGivenIn on the UPSCALED balances — the exact UPSCALED tokens-out for an UPSCALED
 * `tokenAmountIn` (no fee handled here — the fee is netted by getDy before upscaling). Mirrors
 * StableMath._calcOutGivenIn bit-for-bit:
 *   balances[in] += amountIn ; out = balances[out] - getTokenBalanceGivenInvariant(...) - 1
 */
function calcOutGivenInUpscaled(
  amp: bigint,
  balances: bigint[],
  i: number,
  j: number,
  amountInUp: bigint,
  invariant: bigint,
): bigint {
  const work = balances.slice();
  work[i] = work[i] + amountInUp;
  const finalOut = getTokenBalanceGivenInvariant(amp, work, invariant, j);
  // balances[out] - finalOut - 1 (round down in the pool's favor). Guard underflow.
  const diff = balances[j] - finalOut;
  if (diff <= 1n) return 0n;
  return diff - 1n;
}

/**
 * getDy — the exact tokens-out (tokenOut native decimals) for `dx` tokenIn (native decimals),
 * INCLUDING the swap fee, the BPT exclusion, and the scaling-factor up/downscale. Mirrors
 * ComposableStablePool._onSwapGivenIn → StableMath._calcOutGivenIn:
 *
 *   amountIn  = dx − mulUp(dx, swapFeeWad)              # input-side fee (subtractSwapFeeAmount)
 *   inUp      = mulDown(amountIn, scalingFactor[i])     # upscale net input
 *   balUp[k]  = mulDown(balances[k], scalingFactor[k])  # upscale every balance
 *   inv       = calculateInvariant(amp, balUp)
 *   outUp     = calcOutGivenIn(amp, balUp, i, j, inUp, inv)
 *   return divDown(outUp, scalingFactor[j])             # downscale to tokenOut decimals
 *
 * The `mulUp` fee + `divDown` downscale are Balancer's canonical roundings; reproduced exactly so the
 * off-chain dy equals the Vault.swap(GIVEN_IN) output to the wei (under the rate/fee snapshot).
 */
export function getDy(pool: BalancerStablePool, dx: bigint): bigint {
  if (dx <= 0n) return 0n;
  // Input-side swap fee (FixedPoint.mulUp), then upscale the net input.
  const fee = mulUp(dx, pool.swapFeeWad);
  const amountIn = dx - fee;
  if (amountIn <= 0n) return 0n;
  const inUp = mulDown(amountIn, pool.scalingFactors[pool.i]);
  if (inUp <= 0n) return 0n;

  const balUp = pool.balances.map((b, k) => mulDown(b, pool.scalingFactors[k]));
  const invariant = calculateInvariant(pool.amp, balUp);
  const outUp = calcOutGivenInUpscaled(pool.amp, balUp, pool.i, pool.j, inUp, invariant);
  if (outUp <= 0n) return 0n;
  // Downscale to tokenOut native decimals (FixedPoint.divDown).
  return divDownWad(outUp, pool.scalingFactors[pool.j]);
}

/**
 * One sampled Balancer-stable segment in unified out/in price space — identical shape to a Curve /
 * Solidly / LB / DODO / route segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput
 * (tokenIn) for this slice, `effOut` the Δoutput, and `marginalOI` the unified out/in sqrt =
 * isqrt(effOut·2^192/capacity) — the price-ordering coordinate. Segments are emitted in DESCENDING
 * `marginalOI` order (the natural order of a convex stable curve: the first marginal slice is the
 * best-priced).
 *
 * fee-adjust: marginalOI is computed from the POST-FEE dy (getDy already nets the swap fee), so it is
 * ALREADY the fee-adjusted execution price — it enters the merge's descending-price sort directly (no
 * extra sqrtOneMinusFee multiply, the fee is baked into dy), exactly like Curve / Solidly / DODO.
 */
export interface BalancerStableSegment {
  /** Δinput (tokenIn) to traverse this slice. */
  capacity: bigint;
  /** Δoutput (tokenOut) over this slice. */
  effOut: bigint;
  /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
  marginalOI: bigint;
}

/** Default sample count per Balancer-stable pool (M). Tunable; M≈24 tightens the grid bound. */
export const BALANCER_STABLE_SAMPLES = Number(process.env.ECO_BALANCER_SAMPLES ?? 24);

/**
 * Sample a Balancer ComposableStable pool into M descending-marginal segments over [0, amountIn].
 *
 * Geometric-ish cumulative inputs (∝ s^2 — denser near 0 where the stable curve is flattest then
 * bends), each replayed through getDy on the READ state (NO extra RPC — pure bigint, bounded Newton).
 * Each increment becomes a (capacity=Δin, effOut=Δout, marginalOI) segment. The samples are monotone in
 * input so the marginals are naturally descending (a convex out(in)); a non-descending slice
 * (rounding noise near saturation, or a non-convex region past the pool's effective depth) is FOLDED
 * into the last segment (isotonic backward-merge — capacity + effOut conserved, blended marginal
 * recomputed) so the merge stays monotone price-ordered without discarding liquidity. See
 * shared/segment-merge.ts.
 *
 * Exact-on-grid: the split equalizes marginals on THIS sampled grid; the per-pool out for the awarded
 * Σ share is re-evaluated wei-exact by one atomic engine Vault.swap(Σ share) at execution. M≈24
 * (default) keeps the grid bound `O(curvature·maxSlice)` negligible near peg. Mirrors
 * `buildCurveSegments` / `buildSolidlyStableSegments` (same squared-index geometric grid + isotonic
 * backward-merge).
 */
export function buildBalancerStableSegments(
  pool: BalancerStablePool,
  amountIn: bigint,
  samples: number = BALANCER_STABLE_SAMPLES,
): BalancerStableSegment[] {
  if (amountIn <= 0n) return [];
  const M = BigInt(samples);
  const segs: BalancerStableSegment[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (let s = 1; s <= samples; s++) {
    // cumulative input ∝ s^2 (fine slices near 0, coarse near amountIn).
    const ss = BigInt(s);
    const input = (amountIn * ss * ss) / (M * M);
    if (input <= prevIn) continue;
    const out = getDy(pool, input);
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
