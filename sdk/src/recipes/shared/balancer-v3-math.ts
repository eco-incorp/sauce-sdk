/**
 * Balancer V3 (balancer/balancer-v3-monorepo — Vault singleton + per-chain Router) — off-chain segment
 * builder over a LIVE on-chain quote ladder.
 *
 * THE SINGLE SOURCE for how a Balancer V3 pool is turned into split segments. Imported by BOTH:
 *   - the production `prepare.ts` (buildBalancerV3Segments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (balancerV3Segments),
 * so the split is exact-on-grid vs the oracle by construction (one shared ladder → one segmentation).
 *
 * REAL ON-CHAIN SURFACE (VERIFIED against the live Base pool 0x7ab1… + balancer-v3-monorepo — no
 * fabricated getters). Balancer V3 is the successor to V2: a single CREATE2 Vault
 * (0xbA1333333333a1BA1108E8412f11850A5C319bA9, SAME address on every chain) holds all pool balances +
 * transient accounting; a per-chain periphery Router (RouterCommon-based) drives single-token swaps and
 * pulls the input via Permit2. The verified surface is:
 *   Router (per-chain — Base 0x3f17…DC10, Ethereum 0xAE56…8Ea2, Arbitrum 0xEAed…CF2E, Sonic 0x93db…Dae5):
 *     querySwapSingleTokenExactIn(address pool, IERC20 tokenIn, IERC20 tokenOut, uint256 exactAmountIn,
 *                                 address sender, bytes userData) returns (uint256 amountOut)
 *       — declared `external` (NOT view): it routes through the Vault's `quote()`, which unlock()s the Vault
 *         in QUERY mode and rolls back. It is eth_call-ONLY (off-chain prepare/discovery): quote() demands a
 *         static-call context (reverts NotStaticCall 0x67f84ab2 under a plain CALL) yet its unlock() is a
 *         state write (reverts under a STATICCALL), so it is NOT callable on-chain in a cook — see the
 *         IBalancerV3Router.json `_note`. Off-chain it needs no tokens/approvals and INCLUDES the rate
 *         providers AND any dynamic hook fee (e.g. the StableSurgeHook on the deep pools) automatically — the
 *         most robust quote surface. Cast-verified on the Base waBasUSDC↔waBasGHO pool: 100e6 waUSDC → 107.79
 *         waGHO; 1000e6 → 1077.86 (linear).
 *     swapSingleTokenExactIn(address pool, IERC20 tokenIn, IERC20 tokenOut, uint256 exactAmountIn,
 *                            uint256 minAmountOut, uint256 deadline, bool wethIsEth, bytes userData)
 *         payable returns (uint256 amountOut)
 *       — the execution leg. Internally Router.unlock()s the Vault, which re-enters the ROUTER's
 *         swapSingleTokenHook (msg.sender == the Router), calls IBasePool(pool).onSwap under nonReentrant,
 *         and settles via RouterCommon._takeTokenIn = `_permit2.transferFrom(sender, vault, amountIn,
 *         tokenIn); _vault.settle(...)` + _sendTokenOut = `_vault.sendTo(sender, tokenOut, amountOut)`.
 *         THE EXTERNAL CALLER (our cooking contract) IS NEVER RE-ENTERED — it only supplies the Permit2
 *         allowance and receives the output (contrast the V4 unlockCallback path the engine MUST service).
 *     getPermit2() view returns (address) — the Permit2 the Router consumes (canonical Uniswap singleton
 *         0x000000000022D473030F116dDEE9F6B43aC78BA3 on every chain; cast-verified on Base/ETH/Arb/Sonic).
 *   Vault (singleton):
 *     isPoolRegistered(address pool) view returns (bool)  — confirms a candidate is a live V3 pool.
 *     getPoolTokens(address pool) view returns (address[]) — the registered token set (V3 has NO BPT in the
 *         swappable token list, unlike V2 ComposableStable — cast-verified: the Base pool returns exactly
 *         [waGHO, waUSDC]). Discovery keeps a pool trading BOTH tokenIn and tokenOut.
 *   Permit2 (canonical, SAME on all chains):
 *     approve(address token, address spender, uint160 amount, uint48 expiration) — the Router-facing
 *         allowance the swap consumes (set once per token after ERC20.approve(PERMIT2, ...)).
 *
 * WHY THE RECIPE QUOTES VIA THE ROUTER, NOT AN OFF-CHAIN StableMath REPLAY. V3 StableMath is byte-for-byte
 * the SAME amplified StableSwap invariant as V2 (AMP_PRECISION = 1e3), so a plain V3 stable pool COULD be
 * replayed off-chain exactly like the V2 ComposableStable source. BUT the deep production V3 pools are
 * StableSurge-HOOKED (dynamic fee: the hook adds fee when a swap unbalances the pool) AND their tokens are
 * rate-scaled ERC4626 wrappers (WITH_RATE rate providers) — the dynamic fee CANNOT be replayed from the
 * static swap fee alone, and the rate scaling would need a per-block rate snapshot. The Router's
 * `querySwapSingleTokenExactIn` bakes in BOTH (rate providers + the dynamic hook fee) automatically, so it
 * is the robust surface for plain AND surge pools uniformly. Discovery samples that view over [0, amountIn]
 * (same class as Fluid's resolver estimateSwapIn / Mento's Broker getAmountOut); buildBalancerV3Segments
 * differences the ladder into descending-marginal slices with NO further RPC (so the oracle shares them).
 *
 * `querySwapSingleTokenExactIn` IS eth_call-ONLY (off-chain discovery + prepare sampling): it CANNOT be
 * called on-chain inside a cook — it demands a static-call context via the Vault's `quote()` (reverts
 * NotStaticCall 0x67f84ab2 under a plain CALL) yet internally unlock()s the Vault, a state write (reverts
 * under a STATICCALL). See the IBalancerV3Router.json `_note` (the canonical statement).
 *
 * ON-CHAIN EXECUTION is CALLBACK-FREE (the reentrancy is fully contained inside Balancer's own Router +
 * Vault; our cooking contract sees a single external call that returns — like V2/Curve/DODO/Fluid/Mento, and
 * UNLIKE the V3/V4 pool-callback path that the engine must service). The ONE operational difference from V2
 * is the Permit2 approval: the input is pulled via Permit2, so the solver (a) ERC20.approve(PERMIT2, share)
 * then (b) Permit2.approve(tokenIn, ROUTER, uint160(share), expiration), then (c) calls
 * `Router.swapSingleTokenExactIn(pool, tokenIn, tokenOut, +share, minAmountOut=0, deadline, false, "")`
 * with minAmountOut HARDCODED 0 (the query above is uncallable on-chain, so there is no per-leg on-chain
 * minOut — unlike Fluid/Mento, whose self-reverting quote views ARE callable and DO seed a per-leg minOut).
 * wethIsEth=false keeps it pure-ERC20 (no native-ETH edge); the deadline is a large constant.
 *
 * WEI-EXACTNESS CLASS — SNAPSHOTTED-QUOTE (interval-updated hook state; same family as Fluid/Mento/WOOFi).
 * The split is priced off the LIVE `querySwapSingleTokenExactIn` ladder sampled at prepare time (a SNAPSHOT
 * of the pool balances + rate providers + surge-hook state), so:
 *   - the SPLIT is EXACT-ON-GRID-AT-SNAPSHOT — the oracle segments the SAME sampled ladder, so solver ==
 *     oracle bit-for-bit on that grid;
 *   - per-pool EXECUTION passes minAmountOut = 0 (the query is uncallable on-chain), so a Balancer V3 leg
 *     has NO per-leg on-chain floor. The solver's whole-trade amountOutMin FLOOR (cfg[9], derived off a
 *     CONSERVATIVE expected-output estimate via `slippageBps`) is the on-chain guard — it bounds a GROSS
 *     total-output shortfall, but the estimate is loose, so per-leg drift inside that envelope is uncapped;
 *     a tight bound is still the integrator's transaction-level slippage around cook(). When the pool state
 *     is unchanged between prepare and cook, exactIn reproduces the snapshot out exactly.
 * The residual is EXOGENOUS: rate-provider rates accrue and the surge fee moves as the pool re-balances
 * between prepare and cook — bounded on-chain only by the LOOSE whole-trade floor (cfg[9]), never per leg.
 * The split is optimal at the snapshot; the exec reproduces the live query for the awarded share at whatever
 * the live state is (the state-moves cell proves received == the LIVE query at the moved state, with
 * minAmountOut=0).
 *
 * Sources (VERIFIED):
 *   https://github.com/balancer/balancer-v3-monorepo/blob/main/pkg/interfaces/contracts/vault/IRouter.sol  (swapSingleTokenExactIn / querySwapSingleTokenExactIn verbatim)
 *   https://github.com/balancer/balancer-v3-monorepo/blob/main/pkg/vault/contracts/RouterCommon.sol         (_takeTokenIn: _permit2.transferFrom(sender, vault, …) — no callback into sender)
 *   https://github.com/balancer/balancer-v3-monorepo/blob/main/pkg/vault/contracts/Vault.sol                (unlock callback target = unlock() caller; _swap calls IBasePool.onSwap itself, nonReentrant)
 *   https://github.com/balancer/balancer-v3-monorepo/blob/main/pkg/solidity-utils/contracts/math/StableMath.sol  (AMP_PRECISION=1e3 — identical amplified StableSwap to V2)
 *   cast (Foundry) against Base/ETH/Arbitrum/Sonic: Vault singleton on all 4; Router.getPermit2() = the
 *   canonical Permit2; Vault.isPoolRegistered/getPoolTokens; querySwapSingleTokenExactIn live quotes both
 *   directions on the Base pool 0x7ab124ec4029316c2a42f713828ddf2a192b36db.
 */

import { pushMonotoneSegment, type MergeSegment } from "./segment-merge.js";
import { buildQLLadder } from "./curve-math.js";

/** 2^192 — the unified out/in sqrt fixed-point scale (matches the other *-math modules' Q192). */
export const Q192 = 1n << 192n;

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

/**
 * One discovered Balancer V3 venue (a Vault pool + a direct tokenIn→tokenOut leg), oriented for the swap.
 * A V3 stable/surge pool prices off the Vault balances + rate providers + a possibly-dynamic hook fee — not
 * a simple pair→pool getter and not (for surge pools) a static-fee closed form — so this descriptor carries
 * a LIVE QUOTE LADDER sampled at discovery: cumulative (cumIn, cumOut) points from
 * `Router.querySwapSingleTokenExactIn(pool, tokenIn, tokenOut, +cumIn, sender, "")`, ascending in cumIn.
 * `buildBalancerV3Segments` differences the ladder into descending-marginal segments with NO further RPC (so
 * the oracle shares them). All fields are OFF-CHAIN ONLY (the split); the on-chain execution runs the awarded
 * share as a straight exact-in swap with minAmountOut=0 (the Router query is eth_call-only, so it is NOT
 * re-read on-chain).
 */
export interface BalancerV3Pool {
  /** Vault pool address — the swapSingleTokenExactIn / querySwapSingleTokenExactIn `pool` arg. */
  address: `0x${string}`;
  /** The per-chain V3 Router — the query + swap + Permit2.approve spender target (chain-wide via cfg). */
  router: `0x${string}`;
  /** The venue's tokenIn (the from-token the swap call needs) == the EcoSwap tokenIn. */
  tokenIn: `0x${string}`;
  /** The venue's tokenOut (the to-token the swap call needs) == the EcoSwap tokenOut. */
  tokenOut: `0x${string}`;
  /** LIVE quote ladder: ascending cumulative input samples (native tokenIn decimals). Sampled at discovery for
   *  the surge cross-check + diagnostics; the QL split no longer differences it (the ladder is the on-chain
   *  StableMath replay via `buildBalancerV3QLLadder`). Optional (the QL path does not need it). */
  cumIn?: bigint[];
  /** LIVE quote ladder: the `querySwapSingleTokenExactIn(pool, tokenIn, tokenOut, +cumIn[i], …)` for each cumIn[i]. */
  cumOut?: bigint[];
  /**
   * Effective per-pool fee in ppm, DERIVED from the sampled ladder for price-ordering / diagnostics only
   * (the pool folds its static swap fee + any dynamic surge hook fee + rate scaling into the query — there
   * is no single fee() on the swap path for a hooked pool). 0 when unknown / non-par. Best-effort only —
   * the real merge coordinate is `marginalOI` from the ladder dy in buildBalancerV3QLLadder.
   */
  feePpm: number;
  /** Discovery source label. */
  source: string;

  // ── QUOTE-LADDER (QL) StableMath live state ──────────────────────────────────────────────────────────
  // The on-chain solver reads these LIVE at cook (getCurrentLiveBalances / getAmplificationParameter /
  // getStaticSwapFeePercentage / each rate provider's getRate) and replays the amplified StableSwap invariant
  // (V3 rounding) to build its price ladder; the oracle mirrors that ladder BIT-FOR-BIT via
  // `buildBalancerV3QLLadder` off THESE fields (populated live, at the SAME block, so oracle == solver by
  // construction — even after adverse drift). All optional so the legacy sampled-ladder literals still typecheck;
  // the QL functions require them.
  /** CREATE2 Vault singleton address (chain-wide; threaded to the solver as cfg[10]). */
  vault?: `0x${string}`;
  /** tokenIn's Vault token index (the getCurrentLiveBalances slot the input balance lives at). */
  inIdx?: number;
  /** tokenOut's Vault token index. */
  outIdx?: number;
  /** LIVE amplification parameter A·AMP_PRECISION (getAmplificationParameter()[0] — passed directly to StableMath). */
  amp?: bigint;
  /** LIVE static swap fee, 1e18-scaled (getStaticSwapFeePercentage). Netted on the input (mulUp). */
  staticFeeWad?: bigint;
  /** LIVE per-token balances in scaled-18 (rate+decimal-scaled) space (getCurrentLiveBalances). */
  liveBalances?: bigint[];
  /** LIVE tokenIn rate (rpIn.getRate(), 1e18-scaled). */
  rateIn?: bigint;
  /** LIVE tokenOut rate (rpOut.getRate(), 1e18-scaled). */
  rateOut?: bigint;
  /** CONST tokenIn decimal scaling factor = 10^(18 − tokenIn.decimals). */
  decScaleIn?: bigint;
  /** CONST tokenOut decimal scaling factor = 10^(18 − tokenOut.decimals). */
  decScaleOut?: bigint;
  /** tokenIn rate provider address (the solver's on-chain getRate() target; shipped in the qlv descriptor). */
  rpIn?: `0x${string}`;
  /** tokenOut rate provider address. */
  rpOut?: `0x${string}`;
}

/** Balancer V3 fee scale — feePpm is 1e6-scaled (0.01% = 100). */
export const BALANCER_V3_FEE_SCALE = 10n ** 6n;

/**
 * Default sample count per Balancer V3 pool (M) — the number of `querySwapSingleTokenExactIn` eth_calls the
 * discovery sampler issues per pool. Tunable; M≈24 tightens the grid bound at the cost of M RPCs. Also the
 * segment count cap.
 */
export const BALANCER_V3_SAMPLES = Number(process.env.ECO_BALANCER_V3_SAMPLES ?? 24);

/**
 * Geometric-ish cumulative sample inputs over [0, amountIn] (∝ s^2 — denser near 0 where the stable curve
 * is flattest). These are the ladder points prepare's discovery sampler feeds to
 * `querySwapSingleTokenExactIn`; sharing this grid keeps the oracle and prepare on the SAME cumIn points.
 * Strictly ascending, ≤ amountIn.
 */
export function balancerV3SampleInputs(amountIn: bigint, samples: number = BALANCER_V3_SAMPLES): bigint[] {
  if (amountIn <= 0n) return [];
  const M = BigInt(samples);
  const inputs: bigint[] = [];
  let prev = 0n;
  for (let s = 1; s <= samples; s++) {
    const ss = BigInt(s);
    const input = (amountIn * ss * ss) / (M * M);
    if (input > prev) {
      inputs.push(input);
      prev = input;
    }
  }
  return inputs;
}

/**
 * getAmountOut(pool, dx) — the sampled out for cumulative input `dx` by LINEAR INTERPOLATION on the pool's
 * live quote ladder (the ladder is the only V3 surge/rate state we have off-chain — a hooked pool exposes no
 * static-fee closed form). Exact at a ladder point; interpolated between points. Returns 0 for dx<=0 or an
 * empty ladder. This is a diagnostic / segment-partition helper, NOT a wei-exact swap-math replay — the
 * realized out is whatever `Router.swapSingleTokenExactIn` computes exactIn from the awarded input at the
 * live pool state (equal to the sampled ladder when the state is unchanged between prepare and cook).
 */
export function getAmountOut(pool: BalancerV3Pool, dx: bigint): bigint {
  if (dx <= 0n) return 0n;
  if (!pool.cumIn || !pool.cumOut) return 0n;
  const n = pool.cumIn.length;
  if (n === 0) return 0n;
  if (dx <= pool.cumIn[0]) {
    // Linear from origin to the first ladder point.
    return (pool.cumOut[0] * dx) / pool.cumIn[0];
  }
  for (let i = 1; i < n; i++) {
    if (dx <= pool.cumIn[i]) {
      const inLo = pool.cumIn[i - 1];
      const inHi = pool.cumIn[i];
      const outLo = pool.cumOut[i - 1];
      const outHi = pool.cumOut[i];
      const span = inHi - inLo;
      if (span <= 0n) return outHi;
      return outLo + ((outHi - outLo) * (dx - inLo)) / span;
    }
  }
  // Beyond the sampled range — clamp to the last (the marginal flattens; the split never awards past amountIn).
  return pool.cumOut[n - 1];
}

/**
 * One sampled Balancer V3 segment in unified out/in price space — identical shape to a Fluid / Mento /
 * Curve / DODO segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput (tokenIn) for this
 * slice, `effOut` the Δoutput, and `marginalOI` the unified out/in sqrt = isqrt(effOut·2^192/capacity) — the
 * price-ordering coordinate. Segments are emitted DESCENDING in `marginalOI` (a stable/surge AMM's price
 * worsens with size, so the first slice is best-priced).
 *
 * fee-adjust: marginalOI is computed from the ladder dy, which is the Router's POST-FEE + POST-RATE quote
 * (the Vault folds the static fee + any dynamic surge hook fee + rate scaling into the query), so it is
 * ALREADY the fee-adjusted execution price — it enters the merge's descending-price sort directly, exactly
 * like Fluid / Mento / Curve / DODO segments.
 */
export interface BalancerV3Segment extends MergeSegment {
  /** Δinput (tokenIn) to traverse this slice. */
  capacity: bigint;
  /** Δoutput (tokenOut) over this slice. */
  effOut: bigint;
  /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
  marginalOI: bigint;
}

/**
 * Build Balancer V3 segments by DIFFERENCING the pool's pre-sampled live quote ladder (cumIn, cumOut) into
 * descending-marginal (capacity=Δin, effOut=Δout, marginalOI) slices. NO RPC (the ladder was sampled at
 * discovery) — a pure function over the descriptor, so prepare and the oracle produce identical segments
 * from the same ladder. `amountIn` caps the range (the ladder is already sampled over [0, amountIn]). A
 * non-descending slice (rounding noise, or the surge fee kicking down the marginal then recovering) is
 * FOLDED into the last segment (isotonic backward-merge — capacity + effOut conserved, blended marginal
 * recomputed) so the merge stays monotone price-ordered without discarding liquidity. Mirrors
 * `buildFluidSegments` / `buildMentoSegments` (same isotonic backward-merge). See shared/segment-merge.ts.
 */
export function buildBalancerV3Segments(
  pool: BalancerV3Pool,
  amountIn: bigint,
  _samples: number = BALANCER_V3_SAMPLES,
): BalancerV3Segment[] {
  if (amountIn <= 0n) return [];
  if (!pool.cumIn || !pool.cumOut) return [];
  const n = pool.cumIn.length;
  if (n === 0) return [];
  const segs: BalancerV3Segment[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (let i = 0; i < n; i++) {
    const input = pool.cumIn[i] < amountIn ? pool.cumIn[i] : amountIn;
    if (input <= prevIn) continue;
    const out = getAmountOut(pool, input);
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
    if (pool.cumIn[i] >= amountIn) break;
  }
  return segs;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE-LADDER (QL) — the LIVE-WALK Balancer V3 venue (ON-CHAIN StableMath).
//
// Balancer V3's querySwapSingleTokenExactIn is eth_call-ONLY (it demands a static-call context via the Vault's
// quote() yet does a state write — uncallable on-chain in a cook), so V3 CANNOT quote-ladder off a live view
// like Curve/DODO/etc. Instead the on-chain solver reads the LIVE Vault state (getCurrentLiveBalances / amp /
// static fee / each token's rateProvider.getRate) and REPLAYS the amplified StableSwap invariant (the V3
// rounding) in SauceScript to build the SAME geometric QL ladder. This module mirrors that replay BIT-FOR-BIT
// so the oracle/reference stay wei-exact with the solver by construction. Verified wei-exact vs the REAL
// querySwapSingleTokenExactIn on both engines (Lane-9 spike): diff=0 at every probe size on v1 AND v12.
//
// EXACT V3 CONVENTION (verified against balancer-v3-monorepo StableMath + ScalingHelpers, not guessed):
//   - getCurrentLiveBalances already returns rate+decimal-scaled 18-dec balances → StableMath runs on them
//     directly (NO balance re-scaling).
//   - INPUT upscale: givenScaled18 = toScaled18ApplyRateRoundDown(dxRaw, decScaleIn, rateIn)
//                                  = (dxRaw · decScaleIn · rateIn) / 1e18   (mulDown; rate NOT rounded).
//   - FEE (EXACT_IN): netIn = givenScaled18 − mulUp(givenScaled18, staticFee)  (subtracted from the input).
//   - StableMath uses the V3 rounding (divUpRaw for c/y, NOT the V2 form).
//   - OUTPUT downscale: amountOut = toRawUndoRateRoundDown(outScaled18, decScaleOut, computeRateRoundUp(rateOut))
//                                 = outScaled18 · 1e18 / (decScaleOut · computeRateRoundUp(rateOut)).
//     The output rate is rounded UP (+1 unless already a WAD multiple) — this is the key to wei-exactness.
// The StableMath below is the 2-token specialization in the SOLVER's exact product order (bIn then bOut) so
// the oracle's Newton sequence is bit-identical to ecoswap.sauce.ts's inlined stableOut.
// ─────────────────────────────────────────────────────────────────────────────

/** 1e18 (WAD) — the scaled-18 fixed point Balancer StableMath runs in. */
export const BALANCER_V3_WAD = 10n ** 18n;
/** Amplification precision (AMP_PRECISION) — amp is A·1000, passed directly to StableMath. */
export const BALANCER_V3_AMP_PRECISION = 1000n;

/**
 * computeRateRoundUp — the Balancer V3 ScalingHelpers rate round-up used on the OUTPUT undo-rate:
 * (rate % 1e18 == 0) ? rate : rate + 1. Rounding the out-rate UP makes the downscale wei-exact vs the pool.
 */
export function computeRateRoundUp(rate: bigint): bigint {
  return rate % BALANCER_V3_WAD === 0n ? rate : rate + 1n;
}

/**
 * 2-token Balancer V3 StableMath out — BIT-IDENTICAL to ecoswap.sauce.ts `stableOut` (same divUpRaw V3
 * rounding, same bIn-then-bOut invariant product order, same 64-iter Newton with a converged-flag guard).
 * `amp` = A·AMP_PRECISION; `feeWad` = static swap fee (1e18); `bIn`/`bOut` = LIVE scaled-18 balances of the
 * IN/OUT token; `dxScaled` = the UPSCALED (rate+decimal) input. Returns the scaled-18 out (pre-downscale).
 * The static fee is netted on the input (mulUp). Returns 0 on a degenerate/zero out.
 * (NOTE: Solidity computeInvariant iterates D_P in REGISTERED array order balances[0..n-1]; matching that for a
 * registered-token1 tokenIn diverges on the v12 engine at prod scale, so the solver + this oracle both keep
 * bIn-then-bOut — a ≤1-2 wei difference vs the pool's own query is possible only on thin/low-amp inIdx=1 pools,
 * a documented follow-up.)
 */
export function balancerV3StableOut2(
  amp: bigint,
  feeWad: bigint,
  bIn: bigint,
  bOut: bigint,
  dxScaled: bigint,
): bigint {
  if (dxScaled <= 0n || bIn <= 0n || bOut <= 0n) return 0n;
  const AMP = BALANCER_V3_AMP_PRECISION;
  const WAD = BALANCER_V3_WAD;
  let fee = 0n;
  if (feeWad > 0n) {
    const prod = dxScaled * feeWad;
    fee = (prod - 1n) / WAD + 1n; // mulUp
  }
  const inUp = dxScaled - fee;
  const att = amp * 2n; // ampTimesTotal = amp · n
  const sumB = bIn + bOut;

  // Newton for the invariant D (computeInvariant, ROUND_DOWN).
  let D = sumB;
  let doneD = false;
  for (let i = 0; i < 64; i++) {
    if (!doneD) {
      let DP = D;
      DP = (DP * D) / (bIn * 2n);
      DP = (DP * D) / (bOut * 2n);
      const prevD = D;
      const numD = ((att * sumB) / AMP + DP * 2n) * D;
      const denD = ((att - AMP) * D) / AMP + 3n * DP;
      D = numD / denD;
      if (D > prevD) {
        if (D - prevD <= 1n) doneD = true;
      } else {
        if (prevD - D <= 1n) doneD = true;
      }
    }
  }

  // Newton for the out-token balance y (computeBalance, V3 divUpRaw rounding).
  const w0 = bIn + inUp; // in balance after adding net amountIn
  const w1 = bOut; // out balance
  let PD = 2n * w0;
  PD = (PD * w1 * 2n) / D;
  const inv2 = D * D;
  const c = (1n + (inv2 * AMP - 1n) / (att * PD)) * w1; // divUpRaw(inv2·AMP, att·PD) · bOut
  const bb = w0 + (D * AMP) / att; // sum + (D·AMP)/att
  let y = 1n + (inv2 + c - 1n) / (D + bb); // divUpRaw(inv2 + c, D + bb)
  let doneY = false;
  for (let j = 0; j < 64; j++) {
    if (!doneY) {
      const prevY = y;
      const numY = y * y + c;
      const denY = 2n * y + bb - D;
      y = 1n + (numY - 1n) / denY; // divUpRaw(numY, denY)
      if (y > prevY) {
        if (y - prevY <= 1n) doneY = true;
      } else {
        if (prevY - y <= 1n) doneY = true;
      }
    }
  }

  if (bOut <= y + 1n) return 0n;
  return bOut - y - 1n;
}

/**
 * getDy(dxRaw) for a Balancer V3 QL venue — the FULLY RATE-SCALED StableMath out for a RAW tokenIn amount,
 * matching the on-chain solver's compute step exactly: upscale the input (decimal + live rate, mulDown), net
 * the static fee (mulUp on the input), run `balancerV3StableOut2`, then downscale the output (decimal +
 * computeRateRoundUp(rateOut)). Reads the LIVE state carried on the descriptor (populated at the SAME block the
 * solver reads on-chain), so the oracle's ladder == the solver's ladder to the wei.
 */
export function balancerV3StableGetDy(pool: BalancerV3Pool, dxRaw: bigint): bigint {
  if (dxRaw <= 0n) return 0n;
  const bal = pool.liveBalances!;
  const bIn = bal[pool.inIdx!];
  const bOut = bal[pool.outIdx!];
  const givenScaled = (dxRaw * pool.decScaleIn! * pool.rateIn!) / BALANCER_V3_WAD; // toScaled18ApplyRateRoundDown
  const outScaled = balancerV3StableOut2(pool.amp!, pool.staticFeeWad!, bIn, bOut, givenScaled);
  if (outScaled <= 0n) return 0n;
  const rateUp = computeRateRoundUp(pool.rateOut!);
  return (outScaled * BALANCER_V3_WAD) / (pool.decScaleOut! * rateUp); // toRawUndoRateRoundDown
}

/**
 * Build one Balancer V3 pool's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence driven by
 * the rate-scaled StableMath `balancerV3StableGetDy`, so the oracle/reference stay wei-exact with the on-chain
 * solver by construction (the solver builds the IDENTICAL geometric ladder from the SAME live state). The
 * StableMath out is already post-fee + post-rate, so marginalOI IS the execution price (adjNear == adjFar ==
 * marginalOI). No prepared segments — prepare ships only the descriptor.
 */
export function buildBalancerV3QLLadder(pool: BalancerV3Pool, amountIn: bigint): BalancerV3Segment[] {
  return buildQLLadder((dx) => balancerV3StableGetDy(pool, dx), amountIn) as BalancerV3Segment[];
}
