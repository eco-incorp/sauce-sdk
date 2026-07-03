/**
 * Curve Twocrypto (fxswap / "boom" twocrypto-ng, pool `version() == "v2.1.0d"`) — VERBATIM bigint
 * replay + off-chain segment sampler.
 *
 * THE SINGLE SOURCE for Curve CryptoSwap math. Imported by BOTH:
 *   - the production `prepare.ts` (buildCryptoSwapSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (cryptoSwapSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the per-pool
 * executed dy == get_dy(awarded share) to the wei (one atomic exchange).
 *
 * WHICH POOL FAMILY THIS MIRRORS — `version() == "v2.1.0d"` EXACTLY: the fxswap/"boom" Twocrypto
 * (Vyper 0.4.3) the canonical twocrypto-ng factory (`0x98EE851a…`, the CurveCryptoRegistry surface
 * production discovery queries) deployed as of the prod-mirror capture. Its periphery keeps the
 * crypto shape — `price_scale` internal repeg, the DYNAMIC mid/out/fee_gamma fee, uint256 coin
 * indices — but the INVARIANT is the STABLESWAP one: the pool's MATH is `StableswapMath.vy`
 * (curvefi/twocrypto-ng branch `invariant-change`, deployed unverified at the pool's `MATH()`),
 * whose `get_y`/`newton_D` are StableSwapNG's Newton solves with `Ann = A·N_COINS` (A_PRECISION ==
 * A_MULTIPLIER == 10000) and `gamma` accepted ONLY for ABI compatibility (ignored). NEITHER
 * neighbouring generation is modeled: the CLASSIC K0/A-gamma CryptoSwap (twocrypto-ng ≤ v2.0.0 /
 * tricrypto-ng) has a different invariant, and the `invariant-change` branch TIP is already
 * `version() == "v3.0.0"`, whose `_fee` adds a POLICY.get_fee hook plus a min(MAX_FEE, max(MIN_FEE,
 * fee)) clamp this replay omits (a no-op for v2.1.0d pools; a fee-policied v3.0.0 pool WOULD
 * diverge). A registry resolving either generation needs the version() family dispatch at
 * discovery (see the LIMITATIONS note).
 *
 * Verified WEI-EXACT against the REAL deployed contracts: the sourcify-verified crvUSD/WETH pool
 * `0x6e5492F8…` (Ethereum, the prod-mirror capture) — this replay reproduces BOTH captured mainnet
 * `get_dy` probes bit-for-bit, and the prod-mirror test re-asserts ladder parity against the etched
 * real bytecode on every run.
 *
 * CRYPTOSWAP vs STABLESWAP (the ENGINE split, unchanged): the COIN INDICES are uint256
 * (exchange(uint256 i, uint256 j, ...)), NOT the StableSwap int128 — so the engine `_swapCurve`
 * (which calls exchange(int128,int128,...)) DOES NOT match a crypto pool. Therefore CryptoSwap is
 * executed CALLBACK-FREE directly in SauceScript (approve the pool + pool.exchange(uint256 i,
 * uint256 j, dx, min_dy) — Curve exchange PULLS dx via transferFrom), NOT through the engine.
 * NO engine change.
 *
 * SCOPE: 2-COIN pools (a tokenIn→tokenOut swap reads exactly two coins; discovery skips n_coins
 * != 2). NOTE (per directive) crypto pools are a LOW-priority volatile-asset source — the stable
 * sources (StableSwap/Wombat/Balancer) come first.
 *
 * SOURCE MIRRORED — reproduced bit-for-bit, in the deployed contracts' operation ORDER (all
 * internal math is 1e18 fixed point; uint256 throughout, so `/` is a plain floor):
 *   TwocryptoView.get_dy(i, j, dx, swap)  (branch `invariant-change` TwocryptoView.vy — the
 *   `VIEW` the pool's own get_dy staticcalls):
 *     xp = balances (RAW, native units); xp[i] += dx        # dx joins the RAW balance FIRST
 *     xp = [xp[0]·prec0, xp[1]·price_scale·prec1 / 1e18]    # ONE floor per coin, RAW product
 *     y  = MATH.get_y(A, gamma, xp, D, j)[0]                # StableswapMath get_y (gamma unused)
 *     assert y < xp[j]                                      # else the view reverts
 *     dy = xp[j] - y - 1                                    # -1: round DOWN in the pool's favour
 *     xp[j] = y                                             # POST-swap xp — what _fee sees
 *     if j > 0: dy = dy·1e18 / price_scale
 *     dy /= prec[j]
 *     dy -= pool.fee_calc(xp)·dy / 10^10                    # dynamic fee, POST-swap xp
 *   D — the pool's live `D()` storage (the view recomputes newton_D ONLY while A/gamma are
 *   ramping: `future_A_gamma_time > last_timestamp`; discovery reads the live D, see LIMITATIONS).
 *   StableswapMath.get_y(A, gamma°, xp, D, i)  (° = unused):
 *     Ann = A·N ; c = D·D/(x_j·N)·D·A_MULTIPLIER/(Ann·N) ; b = x_j + D·A_MULTIPLIER/Ann
 *     y = D ; iterate y = (y² + c)/(2y + b - D) until |Δ| <= 1   (bounded 255)
 *   StableswapMath.newton_D(A, gamma°, xp, K0_prev°):
 *     Ann = A·N ; D = S = Σxp
 *     D_P = D·D/xp0·D/xp1 / N^N
 *     D = (Ann·S/A_MULTIPLIER + D_P·N)·D / ((Ann - A_MULTIPLIER)·D/A_MULTIPLIER + (N+1)·D_P)
 *     until |Δ| <= 1   (bounded 255)
 *   Twocrypto._fee(xp)  (the pool's `fee_calc`):
 *     B = xp[0] + xp[1]
 *     B = 1e18·N^N·xp[0]/B·xp[1]/B                          # 1e18 at balance → 0 imbalanced
 *     B = fee_gamma·B / (fee_gamma·B/1e18 + 1e18 - B)
 *     fee = (mid_fee·B + out_fee·(1e18 - B)) / 1e18
 *   A = the pool `A()` used DIRECTLY as the math `_amp` (the math scales by N internally:
 *   Ann = A·N; deployed bounds MIN_A = N·A_MULTIPLIER = 2e4, MAX_A = 1e4·A_MULTIPLIER = 1e8).
 *   precisions[k] = 10**(18 - decimals[k]).
 *
 * LIMITATIONS (documented, guarded at execution): (a) a MID-RAMP pool (future_A_gamma_time >
 * last_timestamp) recomputes D per call on-chain — this replay uses the read `D()`, so its ladder
 * drifts for the ramp's duration; the recipe re-reads the pool's OWN get_dy on-chain for min_dy at
 * execution, so a drifted ladder can only mis-split, never mis-execute. (b) a pool from ANOTHER
 * generation resolved by a registry would be mismodeled — a CLASSIC A-gamma pool (≤ v2.0.0) on the
 * invariant, a v3.0.0 pool with a fee POLICY on the fee — and discovery currently ships no version
 * probe; add a version()-keyed family tag at discovery before configuring any CurveCryptoRegistry
 * (no production chain config wires one today).
 *
 * The replay is BOUNDED (255-iteration Newton, exactly the Vyper loop bounds) — no unbounded
 * loops. ONE deliberate divergence: on 255-iteration NON-convergence the deployed get_y/newton_D
 * revert while this replay returns the last iterate — unreachable for a valid pool state, and a
 * drifted iterate can only mis-split, never mis-execute (min_dy still comes from the pool's own
 * get_dy at execution). It runs purely on the read pool state (balances/A/price_scale/D/fee
 * params/precisions); buildCryptoSwapSegments makes NO extra RPC.
 *
 * WEI-EXACT BOUND. The SPLIT (per-pool awarded input) is EXACT-ON-GRID vs the oracle (both replay
 * the SAME buildCryptoSwapSegments grid — one source — so the awarded share matches the oracle
 * bit-for-bit). The realized dy is EXACT-IN-DY: the per-pool out for the awarded slice is
 * re-evaluated wei-exact on-chain by the pool's own `get_dy(i, j, Σ share)` view at execution (the
 * min_dy for exchange), because get_dy IS the math exchange enforces. So awarded-input == oracle
 * (exact-on-grid) and received-dy == get_dy(awarded) (exact-in-dy) — the same standard as Curve
 * StableSwap / Wombat.
 */

import { pushMonotoneSegment, type MergeSegment } from "./segment-merge.js";

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

/** 1e18 — the Twocrypto internal fixed-point (all invariant math). */
const PRECISION = 10n ** 18n;
/** Curve dynamic-fee denominator (fee is 1e10-scaled, same as StableSwap). */
export const FEE_DENOMINATOR_CRYPTO = 10_000_000_000n;
/** A_MULTIPLIER — the amplification multiplier (== StableSwap A_PRECISION in this math). */
export const A_MULTIPLIER = 10_000n;
/** N_COINS for a 2-coin crypto pool. */
const N = 2n;

/**
 * One discovered Curve Twocrypto (fxswap/boom) 2-coin pool, oriented for a tokenIn → tokenOut swap.
 *
 * CryptoSwap uses uint256 coin indices (i = tokenIn coin, j = tokenOut coin) — NOT the engine's
 * int128 StableSwap ABI, so the recipe executes it callback-free (approve + exchange(uint256,...)),
 * bypassing the engine. `balances` are the FULL coin balances (length 2), native units, in the
 * pool's coin order; `i`/`j` index them. `A` is the pool `A()` (the math `_amp`; the math applies
 * `Ann = A·N` internally). `priceScale`, `D` and the fee params come from the pool live. `gamma` is
 * read live and carried for parity/diagnostics but is UNUSED by this pool family's math (the
 * deployed StableswapMath takes it only for ABI compatibility). `precisions[k]` =
 * 10**(18 - decimals[k]).
 */
export interface CryptoSwapPool {
  /** Pool address — the exchange(i, j, dx, min_dy) / get_dy target (approve + call). */
  address: `0x${string}`;
  /** uint256 coin index of tokenIn. */
  i: number;
  /** uint256 coin index of tokenOut. */
  j: number;
  /** The pool `A()` — the math `_amp` (Ann = A·N applied inside the math). */
  A: bigint;
  /** gamma (1e18-scaled) — read live; UNUSED by the fx/boom StableswapMath (ABI-compat only). */
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

/** abs helper for the convergence tests. */
function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/**
 * newton_D — the invariant D for the scaled balances `x` (length 2, 1e18 units) and the pool `A()`
 * (`_amp`; Ann = A·N inside). Mirrors the deployed `StableswapMath.newton_D` bit-for-bit (the
 * D_P/`(Ann·S/A_MULTIPLIER + D_P·N)·D / ((Ann-A_MULTIPLIER)·D/A_MULTIPLIER + (N+1)·D_P)` Newton
 * loop + the `|Δ| <= 1` convergence, bounded 255). `_gamma` is accepted only for ABI parity with
 * the deployed signature — it is IGNORED, exactly like the contract.
 *
 * Not needed at quote time (the pool ships D live), but kept as the SINGLE source for the invariant
 * (tests pin it; a pool without a live D() read can recompute here). Requires A >= MIN_A
 * (N·A_MULTIPLIER = 2e4, the deployed lower bound — below it `Ann - A_MULTIPLIER` underflows
 * on-chain).
 */
export function newtonD(A: bigint, _gamma: bigint, x: bigint[]): bigint {
  if (x[0] <= 0n || x[1] <= 0n) return 0n;
  const S = x[0] + x[1];
  if (S === 0n) return 0n;
  let D = S;
  const Ann = A * N;
  for (let it = 0; it < 255; it++) {
    let D_P = D;
    D_P = (D_P * D) / x[0];
    D_P = (D_P * D) / x[1];
    D_P = D_P / (N * N); // N**N for N=2
    const Dprev = D;
    D = (((Ann * S) / A_MULTIPLIER + D_P * N) * D) / (((Ann - A_MULTIPLIER) * D) / A_MULTIPLIER + (N + 1n) * D_P);
    if (absDiff(D, Dprev) <= 1n) return D;
  }
  return D; // deployed math REVERTS on non-convergence; unreachable for a valid pool state
}

/**
 * get_y — given the scaled balances `xp` (length 2) with the in-coin moved and D held, solve for
 * the out-coin i's new balance y (1e18 units). Mirrors the deployed `StableswapMath.get_y`
 * bit-for-bit: Ann = A·N; c = D·D/(x_j·N)·D·A_MULTIPLIER/(Ann·N); b = x_j + D·A_MULTIPLIER/Ann;
 * y = D iterated as y = (y² + c)/(2y + b - D) until |Δ| <= 1 (bounded 255). `gamma` does not
 * appear — the fx/boom math ignores it.
 *
 * `i` is the coin being solved FOR (in get_dy this is `j`, the tokenOut coin); xp[1-i] is the
 * moved (post-dx) counterpart balance.
 */
export function getY(A: bigint, xp: bigint[], D: bigint, i: number): bigint {
  const xj = xp[1 - i]; // the moved counterpart coin balance (N=2: the single other coin)
  const Ann = A * N;
  let c = (D * D) / (xj * N);
  c = (c * D * A_MULTIPLIER) / (Ann * N);
  const b = xj + (D * A_MULTIPLIER) / Ann;
  let y = D;
  for (let it = 0; it < 255; it++) {
    const yPrev = y;
    y = (y * y + c) / (2n * y + b - D);
    if (absDiff(y, yPrev) <= 1n) return y;
  }
  return y; // deployed math REVERTS on non-convergence; unreachable for a valid pool state
}

/**
 * _fee(xp) — the Twocrypto DYNAMIC fee (1e10 units) for the scaled balances `xp` (length 2).
 * Blends mid_fee (balanced) and out_fee (imbalanced) by the pool imbalance `B`. Mirrors the
 * deployed `Twocrypto._fee` (v2.1.0d — the `fee_gamma·B / (fee_gamma·B/1e18 + 1e18 - B)` slope,
 * which DIFFERS from the ≤ v2.0.0 `fee_gamma·1e18 / (fee_gamma + 1e18 - B)` form) bit-for-bit:
 *   B = xp[0] + xp[1]
 *   B = 1e18·N^N·xp[0]/B·xp[1]/B          (== 1e18 at perfect balance, → 0 as imbalanced)
 *   B = fee_gamma·B / (fee_gamma·B/1e18 + 1e18 - B)
 *   fee = (mid_fee·B + out_fee·(1e18 - B)) / 1e18
 * get_dy/exchange call this on the POST-swap xp (xp[j] already set to y) — mirrored in getDyCrypto.
 */
export function cryptoFee(pool: CryptoSwapPool, xp: bigint[]): bigint {
  const S = xp[0] + xp[1];
  if (S === 0n) return pool.midFee;
  let B = (((PRECISION * N * N * xp[0]) / S) * xp[1]) / S;
  B = (pool.feeGamma * B) / ((pool.feeGamma * B) / PRECISION + PRECISION - B);
  return (pool.midFee * B + pool.outFee * (PRECISION - B)) / PRECISION;
}

/**
 * get_dy — the exact tokens-out for `dx` tokenIn (i → j), INCLUDING the dynamic fee. Mirrors the
 * deployed `TwocryptoView.get_dy`/`_get_dy_nofee` bit-for-bit — see the module header for the
 * verbatim Vyper. The operation ORDER is load-bearing:
 *   - dx joins the RAW balance FIRST, then each coin is scaled as ONE raw product with ONE floor
 *     (`balances[1]·precisions[1]·price_scale / 1e18`). Pre-flooring a per-unit factor
 *     (`precisions[1]·price_scale/1e18`) truncates — for price_scale < 1e18 on an 18-dec coin it
 *     floors to ZERO, and for any price_scale it loses the fractional part on every unit — so it is
 *     NEVER computed as a standalone scale factor.
 *   - the dynamic fee is computed on the POST-swap xp (xp[j] = y), exactly like the contract.
 * The `-1` and the fee truncation are the canonical rounding; reproduced exactly so the off-chain
 * dy equals the pool's own get_dy(i,j,dx) view to the wei (probe-verified vs mainnet).
 *
 * Returns 0 where the view would revert (`y >= xp[j]` — no positive output): an unusable quote,
 * which the sampler skips.
 */
export function getDyCrypto(pool: CryptoSwapPool, dx: bigint): bigint {
  if (dx <= 0n) return 0n;
  const p = pool.priceScale;
  const prec = pool.precisions;
  // xp[i] += dx on the RAW balances, THEN scale (one floor per coin) — the view's exact order.
  const raw = [pool.balances[0], pool.balances[1]];
  raw[pool.i] = raw[pool.i] + dx;
  const xp = [raw[0] * prec[0], (raw[1] * prec[1] * p) / PRECISION];
  const y = getY(pool.A, xp, pool.D, pool.j);
  if (y + 1n >= xp[pool.j]) return 0n; // view: assert y < xp[j] (revert ⇒ unusable quote)
  let dy = xp[pool.j] - y - 1n; // round down in the pool's favour
  xp[pool.j] = y; // POST-swap xp — the state the dynamic fee is computed on
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
export interface CryptoSwapSegment extends MergeSegment {
  /** Δinput (tokenIn) to traverse this slice. */
  capacity: bigint;
  /** Δoutput (tokenOut) over this slice. */
  effOut: bigint;
  /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
  marginalOI: bigint;
  /** OFF-CHAIN-ONLY: worst folded sub-slice marginal (== marginalOI when never merged). */
  worstMarginalOI?: bigint;
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
