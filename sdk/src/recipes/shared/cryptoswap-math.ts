/**
 * Curve CryptoSwap (twocrypto-ng / tricrypto-ng volatile-asset pools) — VERBATIM bigint replay +
 * off-chain segment sampler.
 *
 * THE SINGLE SOURCE for Curve CryptoSwap math. Imported by BOTH:
 *   - the production `prepare.ts` (buildCryptoSwapSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (cryptoSwapSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the per-pool
 * executed dy == get_dy(awarded share) to the wei (one atomic exchange).
 *
 * CRYPTOSWAP vs STABLESWAP — this is the SIBLING of `curve-math.ts` (StableSwap). Same idea (a
 * Newton invariant D + Newton solve for the out-coin balance y, then dy = xp[j]-y-1 net a fee), but
 * the CryptoSwap invariant is the volatile-asset one (the A-gamma "K0"/reduction-coefficient
 * invariant with a price_scale internal repeg) and the fee is DYNAMIC (fee_gamma/mid_fee/out_fee
 * blend on the pool imbalance). The COIN INDICES are uint256 (exchange(uint256 i, uint256 j, ...)),
 * NOT the StableSwap int128 — so the engine `_swapCurve` (which calls exchange(int128,int128,...))
 * DOES NOT match a crypto pool. Therefore CryptoSwap is executed CALLBACK-FREE directly in
 * SauceScript (approve the pool + pool.exchange(uint256 i, uint256 j, dx, min_dy) — Curve exchange
 * PULLS dx via transferFrom), NOT through the engine. NO engine change.
 *
 * SCOPE: 2-COIN volatile pools (twocrypto-ng + the original 2-coin CryptoSwap; tricrypto reduces to
 * the same newton_D/newton_y with N=3, but EcoSwap swaps ONE pair so a 2-coin descriptor is what a
 * tokenIn→tokenOut swap reads). The Newton routines are the tricrypto-ng
 * `CurveCryptoMathOptimized`-family integer math specialized to N=2 (bounded 255 iterations, the
 * SAME loop bound + convergence tests as the canonical Vyper). NOTE (per directive) crypto pools are
 * a LOW-priority volatile-asset source — the stable sources (StableSwap/Wombat/Balancer) come first.
 *
 * SOURCE MIRRORED — curvefi/tricrypto-ng `CurveCryptoMathOptimized3.vy` (newton_D / newton_y) +
 * curvefi/twocrypto-ng `Twocrypto.vy` (get_dy: precisions[]/price_scale xp scaling; _fee dynamic
 * fee). Reproduced bit-for-bit (all internal math is 1e18 fixed point):
 *   newton_D(ANN, gamma, x[2]):
 *     K0 = 10^18 * N^N * x[0]/D * x[1]/D
 *     _g1k0 = |gamma + 10^18 - K0| + 1
 *     mul1 = 10^18 * D / gamma * _g1k0 / gamma * _g1k0 * A_MULTIPLIER / ANN
 *     mul2 = 2 * 10^18 * N * K0 / _g1k0
 *     neg_fprime = S + S*mul2/10^18 + mul1*N/K0 - mul2*D/10^18
 *     D_plus  = D*(neg_fprime + S)/neg_fprime
 *     D_minus = D*D/neg_fprime  ± D*(mul1/neg_fprime)/10^18 * |10^18 - K0| / K0
 *     D = D_plus > D_minus ? D_plus - D_minus : (D_minus - D_plus)/2
 *     converge: |D - D_prev| * 10^14 < max(10^16, D)
 *   newton_y(ANN, gamma, x[2], D, i):
 *     x_j = x[1-i]; y0 = D^2/(x_j*N^2); K0_i = 10^18*N*x_j/D; S_i = x_j
 *     conv_lim = max(x_j/10^14, D/10^14, 100)
 *     K0 = K0_i * y * N / D; S = S_i + y; _g1k0 = |gamma+10^18-K0|+1
 *     mul1 = 10^18 * D / gamma * _g1k0 / gamma * _g1k0 * A_MULTIPLIER / ANN
 *     mul2 = 10^18 + 2*10^18*K0/_g1k0
 *     yfprime = 10^18*y + S*mul2 + mul1 ; _dyfprime = D*mul2
 *     if yfprime < _dyfprime: y = y_prev/2; continue
 *     fprime = (yfprime - _dyfprime)/y
 *     y_minus = mul1/fprime ; y_plus = (yfprime-_dyfprime + 10^18*D)/fprime + y_minus*10^18/K0
 *     y_minus += 10^18*S/fprime
 *     y = y_plus < y_minus ? y_prev/2 : y_plus - y_minus
 *     converge: |y - y_prev| < max(conv_lim, y/10^14)
 *   get_dy(i, j, dx) (twocrypto-ng Twocrypto.vy):
 *     xp = [balances[0]*precisions[0], balances[1]*precisions[1]*price_scale/10^18]
 *     xp[i] += dx * (i==0 ? precisions[0] : precisions[1]*price_scale/10^18)
 *     y = newton_y(ANN, gamma, xp, D, j)
 *     dy = xp[j] - y - 1
 *     if j > 0: dy = dy * 10^18 / price_scale   ; dy /= precisions[j]
 *     dy -= _fee(xp) * dy / 10^10
 *   _fee(xp):
 *     S = xp[0] + xp[1]
 *     f = N^N * 10^18 * xp[0]/S * xp[1]/S
 *     f = fee_gamma * 10^18 / (fee_gamma + 10^18 - f)
 *     fee = (mid_fee*f + out_fee*(10^18 - f)) / 10^18
 *   ANN = A (the pool `A()` already the A_MULTIPLIER·N^N-scaled amplification the invariant uses;
 *   crypto pools report A pre-scaled, so the replay uses it directly as ANN — unlike StableSwap
 *   where A is raw and multiplied by A_PRECISION). precisions[k] = 10**(18 - decimals[k]).
 *
 * The replay is BOUNDED (255-iteration Newton, exactly the Vyper loop bound) — no unbounded loops.
 * It runs purely on the read pool state (balances/A/gamma/price_scale/D/fee params/precisions);
 * buildCryptoSwapSegments makes NO extra RPC.
 *
 * WEI-EXACT BOUND. The SPLIT (per-pool awarded input) is EXACT-ON-GRID vs the oracle (both replay the
 * SAME buildCryptoSwapSegments grid — one source — so the awarded share matches the oracle
 * bit-for-bit). The realized dy is EXACT-IN-DY: the per-pool out for the awarded slice is
 * re-evaluated wei-exact on-chain by the pool's own `get_dy(i, j, Σ share)` view at execution (the
 * min_dy for exchange), because get_dy IS the math exchange enforces. So awarded-input == oracle
 * (exact-on-grid) and received-dy == get_dy(awarded) (exact-in-dy) — the same standard as Curve
 * StableSwap / Wombat.
 */

import { pushMonotoneSegment } from "./segment-merge.js";

/** 2^192 — the unified out/in sqrt fixed-point scale (matches ecoswap.math Q192). */
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
  return y > z ? z : y;
}

/** 1e18 — the CryptoSwap internal fixed-point (all A-gamma math). */
const PRECISION = 10n ** 18n;
/** Curve dynamic-fee denominator (fee is 1e10-scaled, same as StableSwap). */
export const FEE_DENOMINATOR_CRYPTO = 10_000_000_000n;
/** A_MULTIPLIER — the crypto amplification multiplier baked into ANN. */
export const A_MULTIPLIER = 10_000n;
/** N_COINS for a 2-coin crypto pool. */
const N = 2n;

/**
 * One discovered Curve CryptoSwap 2-coin pool, oriented for a tokenIn → tokenOut swap.
 *
 * CryptoSwap uses uint256 coin indices (i = tokenIn coin, j = tokenOut coin) — NOT the engine's
 * int128 StableSwap ABI, so the recipe executes it callback-free (approve + exchange(uint256,...)),
 * bypassing the engine. `balances` are the FULL coin balances (length 2), native units, in the
 * pool's coin order; `i`/`j` index them. `A` is `ANN` (the pool `A()` — already A_MULTIPLIER·N^N
 * scaled, used directly as ANN). `gamma`, `priceScale`, `D` and the fee params come from the pool
 * live. `precisions[k]` = 10**(18 - decimals[k]).
 */
export interface CryptoSwapPool {
  /** Pool address — the exchange(i, j, dx, min_dy) / get_dy target (approve + call). */
  address: `0x${string}`;
  /** uint256 coin index of tokenIn. */
  i: number;
  /** uint256 coin index of tokenOut. */
  j: number;
  /** ANN — the pool `A()` (already A_MULTIPLIER·N^N scaled; used directly as ANN). */
  A: bigint;
  /** gamma (1e18-scaled). */
  gamma: bigint;
  /** price_scale (1e18-scaled) — coin1 quoted in coin0. */
  priceScale: bigint;
  /** The invariant D (1e18-scaled) as reported live by `D()` (avoids recomputing newton_D per quote). */
  D: bigint;
  /** Full coin balances (native order, length 2). */
  balances: bigint[];
  /** Per-coin precision multipliers (length 2): precisions[k] = 10**(18 - decimals[k]). */
  precisions: bigint[];
  /** mid_fee (1e10-scaled) — the balanced-pool fee. */
  midFee: bigint;
  /** out_fee (1e10-scaled) — the imbalanced-pool fee. */
  outFee: bigint;
  /** fee_gamma (1e18-scaled) — the imbalance sensitivity of the dynamic fee. */
  feeGamma: bigint;
  /** Rounded ppm fee (the price-ordering coordinate / diagnostic). */
  feePpm: number;
  /** Discovery source label. */
  source: string;
}

/** abs helper for the |a - b| + 1 forms. */
function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/**
 * newton_D — the CryptoSwap invariant D for the scaled balances `x` (length 2, 1e18 units), the
 * amplification `ANN` and `gamma`. Newton iteration, bounded to 255 steps. Mirrors tricrypto-ng
 * `newton_D` specialized to N=2 bit-for-bit (the K0/_g1k0/mul1/mul2/neg_fprime/D_plus/D_minus loop
 * + the |10^18-K0| D_minus adjustment + the `diff*10^14 < max(10^16, D)` convergence).
 *
 * Not needed at quote time (the pool ships D live), but kept as the SINGLE source for the invariant
 * (tests pin it; a pool without a live D() read can recompute here).
 */
export function newtonD(ANN: bigint, gamma: bigint, x: bigint[]): bigint {
  const S = x[0] + x[1];
  if (S === 0n) return 0n;
  // Initial guess D = N * isqrt(x0 * x1) (the geometric-mean seed).
  let D = N * isqrt(x[0] * x[1]);
  for (let it = 0; it < 255; it++) {
    const Dprev = D;
    // K0 = 10^18 * N^2 * x0/D * x1/D
    const K0 = (((PRECISION * N * N * x[0]) / D) * x[1]) / D;
    let g1k0 = gamma + PRECISION;
    g1k0 = absDiff(g1k0, K0) + 1n;
    // mul1 = 10^18 * D / gamma * _g1k0 / gamma * _g1k0 * A_MULTIPLIER / ANN
    const mul1 = ((((((PRECISION * D) / gamma) * g1k0) / gamma) * g1k0) * A_MULTIPLIER) / ANN;
    // mul2 = 2 * 10^18 * N * K0 / _g1k0
    const mul2 = (2n * PRECISION * N * K0) / g1k0;
    // neg_fprime = S + S*mul2/10^18 + mul1*N/K0 - mul2*D/10^18
    const negFprime = S + (S * mul2) / PRECISION + (mul1 * N) / K0 - (mul2 * D) / PRECISION;
    const Dplus = (D * (negFprime + S)) / negFprime;
    let Dminus = (D * D) / negFprime;
    if (PRECISION > K0) {
      Dminus += (((D * (mul1 / negFprime)) / PRECISION) * (PRECISION - K0)) / K0;
    } else {
      Dminus -= (((D * (mul1 / negFprime)) / PRECISION) * (K0 - PRECISION)) / K0;
    }
    D = Dplus > Dminus ? Dplus - Dminus : (Dminus - Dplus) / 2n;
    const diff = absDiff(D, Dprev);
    const bound = D > 10n ** 16n ? D : 10n ** 16n;
    if (diff * 10n ** 14n < bound) break;
  }
  return D;
}

/**
 * newton_y — given the scaled balances `x` (length 2) with coin i moved and D held, solve for coin
 * i's counterpart y = coin (1-i) new balance (1e18 units). Newton iteration, bounded 255 steps.
 * Mirrors tricrypto-ng `newton_y` specialized to N=2 bit-for-bit (K0/S/_g1k0/mul1/mul2 + the
 * yfprime/_dyfprime/fprime + y_plus/y_minus + the `diff < max(conv_lim, y/10^14)` convergence, incl.
 * the `y = y_prev/2` retract branches).
 *
 * `i` is the coin being solved FOR (in get_dy this is `j`, the tokenOut coin). x[i] on entry is the
 * pool's CURRENT balance of that coin (the seed); x[1-i] is the moved (post-dx) coin balance.
 */
export function newtonY(ANN: bigint, gamma: bigint, x: bigint[], D: bigint, i: number): bigint {
  const xj = x[1 - i]; // the moved counterpart coin balance
  const K0i = (PRECISION * N * xj) / D;
  const Si = xj;
  // Initial y = D^2 / (x_j * N^2)
  let y = (D * D) / (xj * N * N);
  const convLimA = xj / 10n ** 14n;
  const convLimB = D / 10n ** 14n;
  let convLim = convLimA > convLimB ? convLimA : convLimB;
  if (convLim < 100n) convLim = 100n;
  for (let it = 0; it < 255; it++) {
    const yPrev = y;
    const K0 = (K0i * y * N) / D;
    const S = Si + y;
    let g1k0 = gamma + PRECISION;
    g1k0 = absDiff(g1k0, K0) + 1n;
    const mul1 = ((((((PRECISION * D) / gamma) * g1k0) / gamma) * g1k0) * A_MULTIPLIER) / ANN;
    const mul2 = PRECISION + (2n * PRECISION * K0) / g1k0;
    let yfprime = PRECISION * y + S * mul2 + mul1;
    const dyfprime = D * mul2;
    if (yfprime < dyfprime) {
      y = yPrev / 2n;
      continue;
    }
    yfprime = yfprime - dyfprime;
    const fprime = yfprime / y;
    let yMinus = mul1 / fprime;
    const yPlus = (yfprime + PRECISION * D) / fprime + (yMinus * PRECISION) / K0;
    yMinus += (PRECISION * S) / fprime;
    y = yPlus < yMinus ? yPrev / 2n : yPlus - yMinus;
    const diff = absDiff(y, yPrev);
    const bound = convLim > y / 10n ** 14n ? convLim : y / 10n ** 14n;
    if (diff < bound) break;
  }
  return y;
}

/**
 * _fee(xp) — the CryptoSwap DYNAMIC fee (1e10 units) for the scaled balances `xp` (length 2). Blends
 * mid_fee (balanced) and out_fee (imbalanced) by the pool imbalance `f`. Mirrors twocrypto-ng `_fee`
 * bit-for-bit:
 *   S = xp[0] + xp[1]
 *   f = N^N * 10^18 * xp[0]/S * xp[1]/S     (== 10^18 at perfect balance, → 0 as imbalanced)
 *   f = fee_gamma * 10^18 / (fee_gamma + 10^18 - f)
 *   fee = (mid_fee*f + out_fee*(10^18 - f)) / 10^18
 */
export function cryptoFee(pool: CryptoSwapPool, xp: bigint[]): bigint {
  const S = xp[0] + xp[1];
  if (S === 0n) return pool.midFee;
  let f = (((N ** N * PRECISION * xp[0]) / S) * xp[1]) / S;
  f = (pool.feeGamma * PRECISION) / (pool.feeGamma + PRECISION - f);
  return (pool.midFee * f + pool.outFee * (PRECISION - f)) / PRECISION;
}

/**
 * get_dy — the exact tokens-out for `dx` tokenIn (i → j), INCLUDING the dynamic fee. Mirrors
 * twocrypto-ng `Twocrypto.get_dy` bit-for-bit (the precisions[]/price_scale-scaled, post-newton_y
 * form):
 *   xp = [balances[0]*precisions[0], balances[1]*precisions[1]*price_scale/10^18]
 *   xp[i] += dx * (i==0 ? precisions[0] : precisions[1]*price_scale/10^18)
 *   y   = newton_y(ANN, gamma, xp, D, j)
 *   dy  = xp[j] - y - 1                       # -1: round DOWN in the pool's favour
 *   if j > 0: dy = dy * 10^18 / price_scale
 *   dy /= precisions[j]
 *   dy -= _fee(xp) * dy / 10^10               # dynamic fee off the OUTPUT
 * The `-1` and the fee truncation are the canonical rounding; reproduced exactly so the off-chain dy
 * equals the pool's own get_dy(i,j,dx) view to the wei.
 *
 * NOTE the price_scale factor multiplies ONLY coin 1 (coin 0 is the numeraire); the `xp` scaling and
 * the final dy back-scaling both apply it to index-1 only — matching the Vyper `if j > 0` /
 * `precisions[1]*price_scale/10^18` conditioning bit-for-bit.
 */
export function getDyCrypto(pool: CryptoSwapPool, dx: bigint): bigint {
  if (dx <= 0n) return 0n;
  const p = pool.priceScale;
  const prec = pool.precisions;
  // Per-coin scaling factor into the 1e18 invariant space: coin0 = precisions[0]; coin1 folds price_scale.
  const scale0 = prec[0];
  const scale1 = (prec[1] * p) / PRECISION;
  // xp[k] = balances[k] * scale_k  (coin0 uses precisions[0] directly; coin1 folds precisions[1]*
  // price_scale/10^18) — matching the Vyper `_xp` grouping.
  const xp = [pool.balances[0] * scale0, pool.balances[1] * scale1];
  // Move coin i by dx (in the same scaled space).
  const scaleI = pool.i === 0 ? scale0 : scale1;
  xp[pool.i] = xp[pool.i] + dx * scaleI;
  const y = newtonY(pool.A, pool.gamma, xp, pool.D, pool.j);
  let dy = xp[pool.j] - y - 1n; // round down in the pool's favour
  if (dy <= 0n) return 0n;
  // Back-scale out of the invariant space: coin1 divides out price_scale, then divide by precisions[j].
  if (pool.j > 0) {
    dy = (dy * PRECISION) / p;
  }
  dy = dy / prec[pool.j];
  const fee = (cryptoFee(pool, xp) * dy) / FEE_DENOMINATOR_CRYPTO;
  return dy - fee;
}

/**
 * One sampled CryptoSwap segment in unified out/in price space — identical shape to a Curve /
 * Wombat / route segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput (tokenIn),
 * `effOut` the Δoutput, `marginalOI` the unified out/in sqrt = isqrt(effOut·2^192/capacity) — the
 * price-ordering coordinate. Emitted in DESCENDING `marginalOI` order (the natural order of a convex
 * curve).
 *
 * fee-adjust: marginalOI is computed from the POST-FEE dy (get_dy already nets the dynamic fee), so
 * it is ALREADY the fee-adjusted execution price — it enters the merge's descending-price sort
 * directly (no extra sqrtOneMinusFee multiply), exactly like Curve / Wombat.
 */
export interface CryptoSwapSegment {
  /** Δinput (tokenIn) to traverse this slice. */
  capacity: bigint;
  /** Δoutput (tokenOut) over this slice. */
  effOut: bigint;
  /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
  marginalOI: bigint;
}

/** Default sample count per CryptoSwap pool (M). Tunable; M≈24 tightens the grid bound. */
export const CRYPTOSWAP_SAMPLES = Number(process.env.ECO_CRYPTOSWAP_SAMPLES ?? 24);

/**
 * Sample a CryptoSwap pool into M descending-marginal segments over [0, amountIn].
 *
 * Geometric-ish cumulative inputs (∝ s^2 — denser near 0 where the curve bends most), each replayed
 * through getDyCrypto on the READ state (NO extra RPC — pure bounded-Newton bigint). Each increment
 * becomes a (capacity=Δin, effOut=Δout, marginalOI) segment. The samples are monotone in input so
 * the marginals are naturally descending (a convex out(in)); a non-descending slice (rounding noise
 * near saturation, or a non-convex region past an imbalance boundary) is FOLDED into the last segment
 * (isotonic backward-merge — capacity + effOut conserved, blended marginal recomputed) so the merge
 * stays monotone price-ordered without discarding liquidity. See shared/segment-merge.ts.
 *
 * Exact-on-grid: the split equalizes marginals on THIS sampled grid; the per-pool dy for the awarded
 * Σ share is re-evaluated wei-exact by one atomic on-chain get_dy(Σ share) at execution. Mirrors
 * `buildCurveSegments` / `buildWombatSegments` (same squared-index geometric grid + isotonic
 * backward-merge).
 */
export function buildCryptoSwapSegments(
  pool: CryptoSwapPool,
  amountIn: bigint,
  samples: number = CRYPTOSWAP_SAMPLES,
): CryptoSwapSegment[] {
  if (amountIn <= 0n) return [];
  const M = BigInt(samples);
  const segs: CryptoSwapSegment[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (let s = 1; s <= samples; s++) {
    const ss = BigInt(s);
    const input = (amountIn * ss * ss) / (M * M);
    if (input <= prevIn) continue;
    const out = getDyCrypto(pool, input);
    if (out <= 0n) continue;
    const dIn = input - prevIn;
    const dOut = out - prevOut;
    if (dIn > 0n && dOut > 0n) {
      const marginalOI = isqrt((dOut * Q192) / dIn);
      // Isotonic backward-merge (liquidity-preserving) — a non-descending slice (CryptoSwap near an
      // imbalance boundary can price a deeper region better than the last band) is FOLDED into the
      // last segment, not dropped, so the past-boundary liquidity survives. See shared/segment-merge.ts.
      pushMonotoneSegment(segs, dIn, dOut, marginalOI);
    }
    prevIn = input;
    prevOut = out;
  }
  return segs;
}
