import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3PoolFull } from "./IUniswapV3PoolFull.json";
import { IStateViewFull } from "./IStateViewFull.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";
import { IKyberPool } from "./IKyberPool.json";

// EcoSwap on-chain solver — UNIFIED per-pool LIVE walk + per-pool net cache.
//
// One price-ordered k-way merge splits ONE swap across the engaged AMM pools (Uniswap
// V2/V3/V4) so the POST-FEE MARGINAL price equalizes across every pool that receives input.
// Every direct pool gets ONE frontier walked from its LIVE spot, deeper, one tickSpacing per
// step. Each merge step picks the highest fee-adjusted out/in head among {each active pool's
// walk head, each route segment head}, consumes its segment into inp[pool]/cum, and advances
// ONLY that stream. The result is the optimal equalized split — exact (global price order),
// lazy (only reconstructs as cum needs), and bit-for-bit with the neutral optimal oracle (a
// continuous from-live-spot water-fill) — see recipes/test/ecoswap.optimal.ts +
// ecoswap.solver-reference.ts.
//
// THE UNIFIED MODEL (one walk, no two-mode cache-vs-re-anchor split):
//   A tick's liquidityNet is DRIFT-INVARIANT: the absolute active-L of a tick range does not
//   change when the spot price moves. The prepare-time bracket SQRT edges are NOT (they are a
//   multiplicative grid anchored at the prepare-time spot; a walk from a different live spot
//   lands on different sqrt at the same ticks). So the solver ALWAYS computes sqrt/price on
//   the LIVE grid (stepReal from the live spot — identical to the oracle's v3Segments) and
//   reuses the cached NET only: a cache lookup for an in-window boundary, a ticks()/
//   getTickLiquidity() staticcall for an out-of-window boundary. Same grid, same nets ⇒ the
//   solver is wei-exact with the oracle BY CONSTRUCTION, for ANY drift in EITHER direction.
//   The cache is a pure gas optimization (it saves the staticcall for the scanned window).
//
//   There is no drift gate, no stale-skip, no re-anchor branch: ONE per-pool frontier
//   (dnNear/dnL/dnShift/dnOn/dnSteps + the per-pool net cursor netCur) always walks from the
//   live spot. prepare.ts is a GAS-OPTIMIZATION CACHE, not a correctness dependency: the
//   solver is exact from LIVE DATA ALONE (windowTop=0 ⇒ every boundary staticcalls ⇒ the
//   1-RPC quote path with no prepared ticks).
//
// WALK-THROUGH GAPS (interior L==0): a pool is NEVER deactivated while liquidity is known
//   ahead. A step deactivates ONLY on the price limit, the per-pool budget cap, or (dL==0 AND
//   the boundary is PAST the pool's deepest initialized tick extremeShifted). An interior
//   L==0 tick range therefore keeps walking, contributing 0, and resumes when net brings L
//   back — the oracle mirror (ecoswap.optimal.ts: break only when L===0 && past extremeTick).
//
// COMPUTE-THEN-PULL: the merge is read-only (slot0 / getReserves / ticks / getTickLiquidity
// staticcalls only), so we first compute exactly how much tokenIn the swaps will consume
// (cum), then transferFrom the caller EXACTLY that — no upfront over-pull, no refund round-
// trip. The only leftover possible is the limit-price edge (a binding priceLimit makes a V3
// swap consume less than its assigned input); one guarded terminal refund returns it.
//
// Inputs (precomputed off-chain in prepare.ts; pool tuple built by index.ts buildPoolTuple):
//   pools[i]    = [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0,
//                  stateView, poolId, stepRatio, windowTopShifted, windowBotShifted,
//                  extremeShifted, netStart, netCount, isKyber]
//                 [10] stepRatio = getSqrtRatioAtTick(ts); 0 for V2.
//                 [11] windowTopShifted = shallowest scanned tick (shifted); 0 ⇒ no cache.
//                 [12] windowBotShifted = deepest scanned tick (shifted).
//                 [13] extremeShifted   = deepest INITIALIZED tick (shifted); the terminate
//                                         gate; 0 ⇒ none.
//                 [14] netStart = start row index into netCache for this pool.
//                 [15] netCount = number of initialized-tick rows for this pool (0 ⇒ none).
//                 [16] isKyber  = 1 ⇒ KyberSwap Classic / DMM (V2-shaped on VIRTUAL reserves:
//                                 SETUP reads getTradeInfo() vReserves for the curve, and the
//                                 callback-free swap computes the output on the virtual
//                                 reserves with the live feeInPrecision). 0 ⇒ plain UniswapV2.
//                 V2: [10..15] = 0 (V2 reads live reserves; constant-L stream, no tick cache).
//   routes[r]   = [inter, h1Type,h1Pool,h1Fee,h1TS,h1Hooks, h2Type,h2Pool,h2Fee,h2TS,h2Hooks]
//   netCache[n] = [shiftedTick, rawNet] — per-pool grouped [netStart, netStart+netCount),
//                 sorted in SWAP DIRECTION; rawNet is the raw uint128 ticks() returns.
//   routeSegs[g]= [refIdx, capacity, sqrtAdjNear, sqrtAdjFar, segKind, venue] — the UNIFIED
//                 static-segment stream (route, Curve AND LB segments interleaved), sorted DESC
//                 sqrtAdjNear. segKind: 0 = multi-hop route (refIdx → routes[]), 1 = Curve
//                 StableSwap (refIdx → a per-curve accumulator; venue = the exchange() pool
//                 address → swap(poolType:3) → _swapCurve), 2 = Trader Joe LB (refIdx → a per-LB
//                 accumulator; venue = the pair address → swap(poolType:6) → _swapTraderJoeLB),
//                 3 = DODO V2 PMM (refIdx → a per-DODO accumulator; venue = the pool address →
//                 swap(poolType:5) → _swapDODOV2). Curve/LB/DODO marginal prices are supplied
//                 entirely as DATA (Curve: the off-chain bigint get_dy replay sampled into post-fee
//                 segments; LB: ONE exact flat segment per constant-sum bin; DODO: the off-chain
//                 closed-form querySell* replay sampled into post-fee segments) — the on-chain
//                 solver does NOT recompute either curve; the awarded Σ share executes via the
//                 engine swap (one atomic exchange / pair.swap(swapForY,to) / sellBase|sellQuote),
//                 so the executed out is wei-exact for the share. Route, Curve, LB and DODO are all
//                 STATIC by design (no live re-price) — out of the per-wei exactness gate (Curve
//                 and DODO are exact-in-dy / exact-on-grid; LB is EXACT — discrete constant-sum
//                 bins have no intra-bin curvature, so its segments ARE the curve).
// All sqrt values are unified out/in Q96. Routes are STATIC by design (no live re-price) —
// out of the per-wei exactness gate.


// int24 STATICCALL arg (signed tick) from a shifted tick — verbatim from the lens.
function tickArg(shifted: Uint256, OFFSET: Uint256): Uint256 {
  const HIGH: Uint256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000;
  if (shifted >= OFFSET) {
    const up: Uint256 = shifted - OFFSET;
    if (up >= 8388608) {
      return up | HIGH;
    }
    return up;
  }
  return Math.neg(OFFSET - shifted) | HIGH;
}

// ts-aligned SHIFTED base tick from a slot0/getSlot0 int24 tick READ.
//
// The engine decodes a signed intN CONTRACT-OUTPUT (slot0/getSlot0 tick, int24) by
// ZERO-extending it (not sign-extending) — a negative tick like -180 comes back as its
// raw 24-bit two's-complement 16777036 (= 2^24 - 180), NOT 2^256-180. So the naive
// `((tickRaw + OFFSET) / ts) * ts` produces a garbage (huge) shifted base for any pool
// below tick 0, and the frontier walk then reads ticks() at nonexistent boundaries (L
// never updates → mis-fill). Recover the true SHIFTED tick directly: a raw value with
// the int24 sign bit set (>= 2^23) is negative, so shift = rawTick + OFFSET - 2^24;
// otherwise shift = rawTick + OFFSET. Both are non-negative (OFFSET > max|tick|). Then
// floor to the tickSpacing lattice. Mirrors the off-chain BigInt.asIntN(24, tickRaw).
function tickShiftedBase(tickRaw: Uint256, OFFSET: Uint256, ts: Uint256): Uint256 {
  const INT24_SIGN: Uint256 = 8388608; // 2^23
  const INT24_MOD: Uint256 = 16777216; // 2^24
  let shifted: Uint256 = tickRaw + OFFSET;
  if (tickRaw >= INT24_SIGN) {
    shifted = tickRaw + OFFSET - INT24_MOD;
  }
  return (shifted / ts) * ts;
}

// KyberSwap Classic / DMM getAmountOut on the VIRTUAL reserves (the genuine on-curve output):
//   amountInWithFee = amt*(PRECISION - feeInPrecision)/PRECISION
//   amountOut       = amountInWithFee*vReserveOut / (vReserveIn + amountInWithFee)
// Extracted so the per-pool execution-dispatch branch stays under the compiler's 255-byte
// branch-body limit (the inline read + transfer + swap pushed it over).
function kyberOut(amt: Uint256, kfee: Uint256, kVin: Uint256, kVout: Uint256, PRECISION: Uint256): Uint256 {
  const inWithFee: Uint256 = Math.mulDiv(amt, PRECISION - kfee, PRECISION);
  const denom: Uint256 = kVin + inWithFee;
  if (denom > 0) {
    return Math.mulDiv(inWithFee, kVout, denom);
  }
  return 0;
}

function toOutIn(sqrtReal: Uint256, zeroForOne: Uint256): Uint256 {
  if (zeroForOne === 1) {
    return sqrtReal;
  }
  const Q192: Uint256 = 2 ** 192;
  return Q192 / sqrtReal;
}

function stepReal(sqrtReal: Uint256, stepRatio: Uint256, zeroForOne: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  if (zeroForOne === 1) {
    return Math.mulDiv(sqrtReal, Q96, stepRatio);
  }
  return Math.mulDiv(sqrtReal, stepRatio, Q96);
}

// Fee-adjusted out/in head price (the cross-pool max comparison coordinate) mirrors the
// off-chain feeAdjust (prepare.ts feeAdjust + ecoswap.math.ts feeAdjust): sqrt(1-fee) scaling,
// NOT a linear (1-fee) factor. Math.sqrt is the engine integer sqrt == TS isqrt bit-for-bit, so
// the factor sf = sqrt((FEE_DENOM - feePpm) * FEE_DENOM) and adj = mulDiv(oi, sf, FEE_DENOM)
// reproduce sqrtAdjNear to the wei (the oracle/reference encode the same). The factor depends
// ONLY on the (constant) pool fee, so the solver computes it ONCE per pool in SETUP (sfArr) and
// inlines mulDiv(oi, sfArr[j], FEE_DENOM) in the hot merge loop — no per-step sqrt.

function main(
  tokenIn: Address, tokenOut: Address, amountIn: Uint256, caller: Address,
  priceLimit: Uint256,
  pools: Tuple, routes: Tuple, netCache: Tuple, routeSegs: Tuple
): Uint256 {
  const router = ISauceRouter.at(address.self);
  const token = IERC20.at(tokenIn);

  // zeroForOne is the token sort order (== prepare.ts inLower < outLower) — derived here so the
  // solver keeps 9 params (the v12 arg-prologue SDUP16 window overflows at a 10th param).
  const zeroForOne: Uint256 = tokenIn < tokenOut ? 1 : 0;

  const Q96: Uint256 = 2 ** 96;
  const Q192: Uint256 = 2 ** 192;
  const FEE_DENOM: Uint256 = 1000000;
  const OFFSET: Uint256 = 888000;
  const HALF128: Uint256 = 2 ** 127;
  const MOD128: Uint256 = 2 ** 128;
  const V2_STEP_BPS: Uint256 = 25;
  const V2_STEP_DEN: Uint256 = 10000;
  // Canonical UniswapV2 fee (ppm). The engine's _swapV2 hardcodes this (997/1000), so a V2
  // pool charging EXACTLY this fee executes via the unified router swap(poolType:0). A V2
  // pool at any OTHER fee can't use _swapV2 — it executes callback-free (transfer to the
  // pair + pair.swap(amount0Out, amount1Out, recipient, "")), computing the output with the
  // pool's REAL fee so the executed dy matches the fee the merge/oracle grossed by (wei-exact).
  const V2_DEFAULT_FEE: Uint256 = 3000;
  // KyberSwap Classic / DMM fee precision (feeInPrecision is 1e18-scaled). The merge prices a
  // Kyber pool on its ROUNDED ppm (pd[5], wei-exact with the oracle), but the callback-free
  // execution computes the realized output on the VIRTUAL reserves with the LIVE feeInPrecision
  // at full 1e18 precision (the genuine Kyber getAmountOut), so the swap lands + conserves.
  const KYBER_PRECISION: Uint256 = 10 ** 18;
  // Run-until-filled budget. The merge terminates correctly on cum==amountIn and on the
  // price-limit / all-streams-dead early-out. Two bounds:
  //   • PER_POOL — ONE per-pool step budget (dnSteps[] below) counted on EVERY step of that
  //     pool's single from-live-spot walk. This is the run-until-filled governor: a pool walks
  //     its live tick lattice (window via the net cache, then staticcalls past the window)
  //     until it fills, exhausts, or hits PER_POOL. It MUST equal the optimal oracle's
  //     MAX_V3_STEPS (ecoswap.optimal.ts) and the reference's PER_POOL EXACTLY — because both
  //     bound the SINGLE from-live-spot walk by the same cap, the solver==oracle to the wei
  //     EVEN WHEN THE CAP BINDS, for every drift direction and cache depth.
  //   • SAFETY — the outer merge-loop bound = routeSegs.length + pools.length*PER_POOL*2
  //     (×2 keeps generous slack for per-pool scan churn). It dominates the SUM of all
  //     per-pool reaches, so once every stream has spent its PER_POOL budget (or filled/
  //     exhausted) the outer loop is guaranteed to have terminated; it never itself truncates
  //     a fill the per-pool caps would have completed.
  // 2048 ts=10 steps ≈ a 7.75× price excursion per pool — far past any realistic out-of-range
  // case — while a single pool walking the full PER_POOL budget costs ≈1.15e9 gas on anvil
  // (measured), comfortably under the 1.9e9 cook ceiling.
  const PER_POOL: Uint256 = 2048;
  const SAFETY: Uint256 = routeSegs.length + pools.length * PER_POOL * 2;

  // Per-pool accumulators + the single live frontier state (walked from the live spot).
  let inp: Tuple = new Array(pools.length);
  let lArr: Tuple = new Array(pools.length); // V2 live √k
  let dnOn: Tuple = new Array(pools.length); // frontier active flag
  let dnNear: Tuple = new Array(pools.length); // real sqrt (V3/V4) or out/in (V2) near edge
  let dnL: Tuple = new Array(pools.length); // active L
  let dnShift: Tuple = new Array(pools.length); // next boundary (shifted)
  let dnSteps: Tuple = new Array(pools.length); // per-pool step budget
  let netCur: Tuple = new Array(pools.length); // cursor into this pool's netCache rows
  let sfArr: Tuple = new Array(pools.length); // per-pool sqrt fee factor (constant) — see below
  let rinp: Tuple = new Array(routes.length);
  // Per-Curve-venue input accumulators + the venue addresses, both indexed by the static
  // segment's refIdx (multiple segments share one curve venue ⇒ accumulate). Sized by the
  // unified static-segment stream length (an upper bound on distinct curve venues). cven[r]
  // stays 0 for an unused slot; cinp[r] > 0 marks a curve venue to execute.
  let cinp: Tuple = new Array(routeSegs.length);
  let cven: Tuple = new Array(routeSegs.length);
  // Per-LB-venue input accumulators + the venue (pair) addresses, mirroring the Curve cinp/cven
  // but keyed independently by the LB refIdx (Curve and LB refIdx counters are SEPARATE, so they
  // must not share an array). linp[r] > 0 marks an LB pair to execute via swap(poolType:6).
  let linp: Tuple = new Array(routeSegs.length);
  let lven: Tuple = new Array(routeSegs.length);
  // Per-DODO-venue input accumulators + the venue (pool) addresses, mirroring the Curve/LB
  // accumulators but keyed independently by the DODO refIdx (the DODO refIdx counter is SEPARATE).
  // dinp[r] > 0 marks a DODO pool to execute via swap(poolType:5) → _swapDODOV2.
  let dinp: Tuple = new Array(routeSegs.length);
  let dven: Tuple = new Array(routeSegs.length);

  let cum: Uint256 = 0;

  // ── SETUP: read live state once per pool, seed the single frontier from the LIVE spot ──
  for (let i = 0; i < pools.length; i = i + 1) {
    const pd: Tuple = pools[i];
    const isV2: Uint256 = pd[6];
    const pType: Uint256 = pd[0];
    let ll: Uint256 = 0;
    dnSteps[i] = 0;
    // The per-pool fee factor sf = sqrt((FEE_DENOM - feePpm)*FEE_DENOM) depends ONLY on the
    // pool's (constant) fee, so compute the (expensive) integer sqrt ONCE here and reuse it in
    // the hot merge loop's head-price comparisons (feeAdj = mulDiv(oi, sf, FEE_DENOM)). Calling
    // Math.sqrt afresh on every head-selection step — 2 heads × every active pool × hundreds of
    // tick steps — dominated the deep-walk gas; caching it keeps a deep multi-pool fill bounded.
    sfArr[i] = Math.sqrt((FEE_DENOM - pd[5]) * FEE_DENOM);
    if (isV2 === 1) {
      // V2 reads getReserves; Kyber Classic (pd[16]==1) reads getTradeInfo's VIRTUAL reserves
      // (the curve geometry trades on vReserve*, NOT the real reserves). Both seed an identical
      // constant-L stream from the LIVE out/in spot — only the reserve source differs.
      let r0: Uint256 = 0;
      let r1: Uint256 = 0;
      if (pd[16] === 1) {
        r0 = IKyberPool.at(pd[1]).getTradeInfo()[2]; // vReserve0
        r1 = IKyberPool.at(pd[1]).getTradeInfo()[3]; // vReserve1
      } else {
        r0 = IUniswapV2Pair.at(pd[1]).getReserves()[0];
        r1 = IUniswapV2Pair.at(pd[1]).getReserves()[1];
      }
      const inIsToken0: Uint256 = pd[7];
      const resIn: Uint256 = inIsToken0 === 1 ? r0 : r1;
      const resOut: Uint256 = inIsToken0 === 1 ? r1 : r0;
      ll = Math.sqrt(resIn * resOut);
      // V2/Kyber: constant-L stream from the LIVE out/in spot (no ticks, no cache).
      dnOn[i] = 1;
      dnNear[i] = Math.sqrt(Math.mulDiv(resOut, Q192, resIn)); // live out/in spot sqrt
      dnL[i] = ll;
      dnShift[i] = 0; // unused for V2
      netCur[i] = 0;
    } else {
      // V3/V4: read live real sqrt + tick + active L; seed the frontier at the live spot.
      let srReal: Uint256 = 0;
      let liveTick: Uint256 = 0;
      let liveL: Uint256 = 0;
      if (pType === 2) {
        srReal = IStateViewFull.at(pd[8]).getSlot0(pd[9])[0];
        liveTick = IStateViewFull.at(pd[8]).getSlot0(pd[9])[1];
        liveL = IStateViewFull.at(pd[8]).getLiquidity(pd[9]);
      } else {
        srReal = IUniswapV3PoolFull.at(pd[1]).slot0()[0];
        liveTick = IUniswapV3PoolFull.at(pd[1]).slot0()[1];
        liveL = IUniswapV3PoolFull.at(pd[1]).liquidity();
      }
      const ts: Uint256 = pd[3];
      const base: Uint256 = tickShiftedBase(liveTick, OFFSET, ts);
      let sh: Uint256 = base;
      if (zeroForOne === 0) { sh = base + ts; }
      dnOn[i] = 1;
      dnNear[i] = srReal; // V3/V4 frontier stores the live real sqrt
      dnL[i] = liveL;
      dnShift[i] = sh;

      // Position the per-pool net cursor PAST any cached rows that lie ABOVE the first
      // boundary (the drift-down skip): the cache rows are sorted in swap direction, so any
      // initialized tick the live spot has already moved below must be skipped before the walk
      // begins (it never crosses them). netStart=[14], netCount=[15].
      const nStart: Uint256 = pd[14];
      const nCount: Uint256 = pd[15];
      let cur: Uint256 = nStart;
      const nEnd: Uint256 = nStart + nCount;
      if (nCount > 0) {
        for (let q = 0; q < nCount; q = q + 1) {
          if (cur < nEnd) {
            const row: Tuple = netCache[cur];
            const rt: Uint256 = row[0];
            // "above the first boundary" in swap-direction terms: zeroForOne walks down
            // (ticks descending) so a row above is rt > sh; oneForZero walks up so rt < sh.
            let skip: Uint256 = 0;
            if (zeroForOne === 1) { if (rt > sh) { skip = 1; } }
            else { if (rt < sh) { skip = 1; } }
            if (skip === 1) { cur = cur + 1; }
          }
        }
      }
      netCur[i] = cur;
    }
    lArr[i] = ll;
  }

  // ── MERGE: each step, pick the best-priced candidate head and advance it ──
  let rc: Uint256 = 0; // route-segment cursor
  for (let s = 0; s < SAFETY; s = s + 1) {
    // Terminate the run-until-filled loop the instant the trade is fully allocated — the
    // reference's `if (cum >= amountIn) break`. SauceScript has no break, so jump the counter
    // to the bound. (Without this the loop spins the remaining SAFETY iterations doing nothing
    // — ≈8192 empty passes — which on the interpreter costs ≈100M gas and, on a deep multi-pool
    // fill, pushes the cook past the gas ceiling. Skipping them is split-identical: the body is
    // gated on cum < amountIn anyway, so a spun iteration never changed any accumulator.)
    if (cum >= amountIn) { s = SAFETY; }
    if (cum < amountIn) {
      // 1. find the highest fee-adjusted head among {route cursor, dn[*]}. Ties on the near
      // (entry) price break by HIGHER far (shallower step) so a coarse segment never wins ahead
      // of a finer one — bit-identical to the optimal oracle's stable segment sort (adjNear
      // DESC, adjFar DESC) and the reference (ecoswap.solver-reference.ts).
      let bestKind: Uint256 = 0; // 0=none 2=route 3=pool frontier
      let bestPool: Uint256 = 0;
      let bestPrice: Uint256 = 0;
      let bestFar: Uint256 = 0;
      if (rc < routeSegs.length) {
        const rg: Tuple = routeSegs[rc];
        // route segment head price (static — no live re-price).
        const rp: Uint256 = rg[2];
        if (rp > bestPrice) { bestPrice = rp; bestFar = rg[3]; bestKind = 2; }
      }
      for (let j = 0; j < pools.length; j = j + 1) {
        const jd: Tuple = pools[j];
        if (dnOn[j] === 1) {
          // fee-adjust with the per-pool cached sqrt factor (sfArr[j]) — no per-step Math.sqrt.
          const jsf: Uint256 = sfArr[j];
          let doi: Uint256 = 0;
          if (jd[6] === 1) {
            doi = dnNear[j];
          } else {
            doi = toOutIn(dnNear[j], zeroForOne);
          }
          const dadj: Uint256 = Math.mulDiv(doi, jsf, FEE_DENOM);
          // LAZY far-adjust: the far (shallower-step) price is ONLY the tie-break when the near
          // price exactly equals the current best, so a pool whose near is strictly BELOW the
          // best can never win regardless of its far — skip its far entirely. A strictly-higher
          // near wins outright (and sets bestFar from ITS far); an equal near consults the far.
          // Computing far costs an extra stepReal + toOutIn + mulDiv (V3) or a V2 slice + mulDiv
          // — ~60% of the per-pool scan arithmetic — so gating it on dadj >= bestPrice is the hot
          // loop's biggest saving. This NEVER changes which pool wins a step ⇒ the split is
          // bit-identical to an eager far (the reference mirrors the same laziness).
          if (dadj >= bestPrice) {
            let dfarAdj: Uint256 = 0;
            if (jd[6] === 1) {
              const v2Far: Uint256 = dnNear[j] - Math.mulDiv(dnNear[j], V2_STEP_BPS, V2_STEP_DEN);
              dfarAdj = Math.mulDiv(v2Far, jsf, FEE_DENOM);
            } else {
              const farReal: Uint256 = stepReal(dnNear[j], jd[10], zeroForOne);
              dfarAdj = Math.mulDiv(toOutIn(farReal, zeroForOne), jsf, FEE_DENOM);
            }
            let win: Uint256 = 0;
            if (dadj > bestPrice) { win = 1; }
            if (dadj === bestPrice) { if (dfarAdj > bestFar) { win = 1; } }
            if (win === 1) { bestPrice = dadj; bestFar = dfarAdj; bestKind = 3; bestPool = j; }
          }
        }
      }

      // Early-out: no active stream produced a head with price > 0 (all streams
      // exhausted). SauceScript has no break — terminate the run-until-filled loop by
      // jumping the counter to the bound.
      if (bestKind === 0) { s = SAFETY; }

      // 2. consume + advance the winner
      if (bestKind === 2) {
        // static segment (route, Curve OR LB): a fixed capacity slice at a fixed post-fee price.
        // segKind 0 → multi-hop route (accumulate into rinp[refIdx]); 1 → Curve StableSwap
        // (accumulate into cinp[refIdx], stamp the venue → swap(poolType:3) → _swapCurve); 2 →
        // Trader Joe LB (accumulate into linp[refIdx], stamp the pair → swap(poolType:6) →
        // _swapTraderJoeLB); 3 → DODO V2 (accumulate into dinp[refIdx], stamp the pool →
        // swap(poolType:5) → _swapDODOV2). The awarded Σ executes below (compute-then-pull;
        // Curve/LB/DODO curve math is off-chain, these are pure data-driven slices).
        const rg: Tuple = routeSegs[rc];
        const rdx: Uint256 = rg[0];
        const cap: Uint256 = rg[1];
        let rtake: Uint256 = cap;
        if (cum + cap >= amountIn) { rtake = amountIn - cum; }
        if (rg[4] === 1) {
          cinp[rdx] = cinp[rdx] + rtake;
          cven[rdx] = rg[5];
        } else {
          if (rg[4] === 2) {
            linp[rdx] = linp[rdx] + rtake;
            lven[rdx] = rg[5];
          } else {
            if (rg[4] === 3) {
              dinp[rdx] = dinp[rdx] + rtake;
              dven[rdx] = rg[5];
            } else {
              rinp[rdx] = rinp[rdx] + rtake;
            }
          }
        }
        cum = cum + rtake;
        rc = rc + 1;
      } else {
        if (bestKind === 3) {
          const dd: Tuple = pools[bestPool];
          const dfee: Uint256 = dd[5];
          if (dd[6] === 1) {
            // V2 frontier step (constant-L geometric slice from the live spot).
            let v2L: Uint256 = lArr[bestPool];
            let v2Near: Uint256 = dnNear[bestPool];
            const v2Far: Uint256 = v2Near - Math.mulDiv(v2Near, V2_STEP_BPS, V2_STEP_DEN);
            if (v2L > 0) { if (v2Near > v2Far) { if (v2Far > 0) {
              const v2eff: Uint256 = Math.mulDiv(v2L, Q96, v2Far) - Math.mulDiv(v2L, Q96, v2Near);
              if (v2eff > 0) {
                const v2g: Uint256 = Math.mulDiv(v2eff, FEE_DENOM, FEE_DENOM - dfee);
                let v2t: Uint256 = v2g;
                if (cum + v2g >= amountIn) { v2t = amountIn - cum; }
                inp[bestPool] = inp[bestPool] + v2t;
                cum = cum + v2t;
              }
            } } }
            dnNear[bestPool] = v2Far;
            if (v2Far <= 0) { dnOn[bestPool] = 0; }
            dnSteps[bestPool] = dnSteps[bestPool] + 1;
            if (dnSteps[bestPool] >= PER_POOL) { dnOn[bestPool] = 0; }
          } else {
            // V3/V4 frontier step — tick walk on the LIVE grid, net from cache or staticcall.
            let dL: Uint256 = dnL[bestPool];
            const dts: Uint256 = dd[3];
            const dstep: Uint256 = dd[10];
            let dnear: Uint256 = dnNear[bestPool];
            let dsh: Uint256 = dnShift[bestPool];
            const dfarReal: Uint256 = stepReal(dnear, dstep, zeroForOne);
            const dnearOI: Uint256 = toOutIn(dnear, zeroForOne);
            const dfarOI: Uint256 = toOutIn(dfarReal, zeroForOne);
            let dlim: Uint256 = 0;
            if (zeroForOne === 1) { if (dfarReal <= priceLimit) { dlim = 1; } }
            else { if (dfarReal >= priceLimit) { dlim = 1; } }
            if (dL > 0) { if (dnearOI > dfarOI) { if (dfarOI > 0) {
              const deff: Uint256 = Math.mulDiv(dL, Q96, dfarOI) - Math.mulDiv(dL, Q96, dnearOI);
              if (deff > 0) {
                const dg: Uint256 = Math.mulDiv(deff, FEE_DENOM, FEE_DENOM - dfee);
                let dt: Uint256 = dg;
                if (cum + dg >= amountIn) { dt = amountIn - cum; }
                inp[bestPool] = inp[bestPool] + dt;
                cum = cum + dt;
              }
            } } }

            // Obtain the boundary net (raw uint128). In the cache window, read from the
            // per-pool netCache cursor (matching tick ⇒ consume + advance; in-window non-match
            // ⇒ net 0, NO staticcall). Out of the window ⇒ ticks()/getTickLiquidity staticcall.
            //
            // The window bounds are the SHALLOWEST [11] and DEEPEST [12] scanned boundaries in
            // SHIFTED-tick space. For zeroForOne the walk descends, so the deepest boundary has
            // the SMALLER shifted value ⇒ wBot <= wTop. For oneForZero the walk ascends, so the
            // deepest boundary has the LARGER shifted value ⇒ wBot >= wTop (prepare.ts stamps
            // windowBotShifted = spotBoundary + step*(scanned-1) with step = +ts). So the in-
            // window test must accept EITHER ordering: dsh lies within [min(wTop,wBot),
            // max(wTop,wBot)]. (A directional test `dsh<=wTop && dsh>=wBot` silently fails for
            // oneForZero — the cursor cache never engages and every boundary staticcalls; the
            // RESULT stays correct, but the gas-saving cache is dead. This order-agnostic test
            // restores the cursor cache for BOTH swap directions.)
            const wTop: Uint256 = dd[11];
            const wBot: Uint256 = dd[12];
            let inWindow: Uint256 = 0;
            if (wTop > 0) {
              const wLo: Uint256 = wTop <= wBot ? wTop : wBot;
              const wHi: Uint256 = wTop <= wBot ? wBot : wTop;
              if (dsh >= wLo) { if (dsh <= wHi) { inWindow = 1; } }
            }
            let dnet: Uint256 = 0;
            if (inWindow === 1) {
              const nStart: Uint256 = dd[14];
              const nCount: Uint256 = dd[15];
              const nEnd: Uint256 = nStart + nCount;
              const cc: Uint256 = netCur[bestPool];
              if (cc < nEnd) {
                const row: Tuple = netCache[cc];
                if (row[0] === dsh) { dnet = row[1]; netCur[bestPool] = cc + 1; }
              }
            } else {
              const darg: Uint256 = tickArg(dsh, OFFSET);
              if (dd[0] === 2) { dnet = IStateViewFull.at(dd[8]).getTickLiquidity(dd[9], darg)[1]; }
              else { dnet = IUniswapV3PoolFull.at(dd[1]).ticks(darg)[1]; }
            }
            const dneg: Uint256 = dnet >= HALF128 ? 1 : 0;
            if (zeroForOne === 1) {
              if (dneg === 1) { dL = dL + (MOD128 - dnet); } else { dL = dL >= dnet ? dL - dnet : 0; }
              dsh = dsh - dts;
            } else {
              if (dneg === 1) { const dm: Uint256 = MOD128 - dnet; dL = dL >= dm ? dL - dm : 0; } else { dL = dL + dnet; }
              dsh = dsh + dts;
            }
            dnNear[bestPool] = dfarReal;
            dnL[bestPool] = dL;
            dnShift[bestPool] = dsh;

            // TERMINATE (deactivate) only on: price limit, OR budget cap, OR (dL==0 AND the
            // boundary is PAST the pool's deepest initialized tick extremeShifted). Walk
            // THROUGH interior dL==0 gaps (boundary not yet past extreme → keep going, net
            // resumes L) — the oracle mirror. extremeShifted==0 (no initialized ticks) ⇒ no
            // gap gate (a constant-L curve terminates via fill / price-limit / the cap).
            if (dlim === 1) { dnOn[bestPool] = 0; }
            const ext: Uint256 = dd[13];
            if (dL === 0) { if (ext > 0) {
              let pastExt: Uint256 = 0;
              if (zeroForOne === 1) { if (dsh < ext) { pastExt = 1; } }
              else { if (dsh > ext) { pastExt = 1; } }
              if (pastExt === 1) { dnOn[bestPool] = 0; }
            } }
            dnSteps[bestPool] = dnSteps[bestPool] + 1;
            if (dnSteps[bestPool] >= PER_POOL) { dnOn[bestPool] = 0; }
          }
        }
      }
    }
  }

  // ── COMPUTE-THEN-PULL + execution ──
  if (cum > 0) {
    token.transferFrom(caller, address.self, cum);
  }
  for (let p = 0; p < pools.length; p = p + 1) {
    const amt: Uint256 = inp[p];
    if (amt > 0) {
      const dp: Tuple = pools[p];
      const isV2: Uint256 = dp[6];
      const pType: Uint256 = dp[0];
      if (dp[16] === 1) {
        // KyberSwap Classic / DMM — callback-free, output computed on the VIRTUAL reserves with
        // the LIVE feeInPrecision (the genuine Kyber getAmountOut), so the realized swap lands +
        // conserves on the amplified curve. The merge already grossed by the rounded ppm, so the
        // allocated `amt` matches the oracle to the wei; the executed dy is the true on-curve out.
        //   amountInWithFee = amt*(PRECISION - feeInPrecision)/PRECISION
        //   amountOut       = amountInWithFee*vReserveOut / (vReserveIn + amountInWithFee)
        const kpool: Address = dp[1];
        const kvr0: Uint256 = IKyberPool.at(kpool).getTradeInfo()[2]; // vReserve0
        const kvr1: Uint256 = IKyberPool.at(kpool).getTradeInfo()[3]; // vReserve1
        const kfee: Uint256 = IKyberPool.at(kpool).getTradeInfo()[4]; // feeInPrecision (1e18)
        const kIsT0: Uint256 = dp[7];
        const kVin: Uint256 = kIsT0 === 1 ? kvr0 : kvr1;
        const kVout: Uint256 = kIsT0 === 1 ? kvr1 : kvr0;
        const kOut: Uint256 = kyberOut(amt, kfee, kVin, kVout, KYBER_PRECISION);
        if (kOut > 0) {
          token.transfer(kpool, amt);
          const kEmpty: bytes = abi.encode(tokenIn).slice(0, 0);
          // Output sits in the pool's OUT-token slot (mirrors the V2 callback-free path).
          if (kIsT0 === 1) {
            IKyberPool.at(kpool).swap(0, kOut, address.self, kEmpty);
          } else {
            IKyberPool.at(kpool).swap(kOut, 0, address.self, kEmpty);
          }
        }
      } else {
      if (isV2 === 1) {
        const v2fee: Uint256 = dp[5];
        if (v2fee === V2_DEFAULT_FEE) {
          // 0.30% pool — the engine's _swapV2 honors exactly this fee, so use the
          // unified router swap (it pulls input + computes output at 997/1000).
          const cc0: Address = zeroForOne === 1 ? tokenIn : tokenOut;
          const cc1: Address = zeroForOne === 1 ? tokenOut : tokenIn;
          router.swap({
            poolType: 0, pool: dp[1],
            poolKey: { currency0: cc0, currency1: cc1, fee: 0, tickSpacing: 0, hooks: 0 },
            tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(amt),
            sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
          });
        } else {
          // Non-0.30% V2-class pool — the engine's _swapV2 would mis-fee it, so execute
          // CALLBACK-FREE in SauceScript with the pool's REAL fee: read live reserves,
          // compute the constant-product output grossing by feePpm EXACTLY as the merge/
          // oracle did, transfer the input to the pair, then call pair.swap(...) with the
          // computed output and empty data. No router, no callback, no engine change.
          //   amountInWithFee = amt*(FEE_DENOM - feePpm)
          //   amountOut = amountInWithFee*resOut / (resIn*FEE_DENOM + amountInWithFee)
          const pair: Address = dp[1];
          const r0v: Uint256 = IUniswapV2Pair.at(pair).getReserves()[0];
          const r1v: Uint256 = IUniswapV2Pair.at(pair).getReserves()[1];
          const inIsT0: Uint256 = dp[7];
          const resIn: Uint256 = inIsT0 === 1 ? r0v : r1v;
          const resOut: Uint256 = inIsT0 === 1 ? r1v : r0v;
          const amtInWithFee: Uint256 = amt * (FEE_DENOM - v2fee);
          const denom: Uint256 = resIn * FEE_DENOM + amtInWithFee;
          let amountOut: Uint256 = 0;
          if (denom > 0) {
            amountOut = Math.mulDiv(amtInWithFee, resOut, denom);
          }
          if (amountOut > 0) {
            token.transfer(pair, amt);
            const empty: bytes = abi.encode(tokenIn).slice(0, 0);
            // Output sits in the pool's OUT-token slot: tokenIn==token0 ⇒ out is token1
            // (amount1Out); tokenIn==token1 ⇒ out is token0 (amount0Out).
            if (inIsT0 === 1) {
              IUniswapV2Pair.at(pair).swap(0, amountOut, address.self, empty);
            } else {
              IUniswapV2Pair.at(pair).swap(amountOut, 0, address.self, empty);
            }
          }
        }
      } else {
        if (pType === 2) {
          const k0: Address = zeroForOne === 1 ? tokenIn : tokenOut;
          const k1: Address = zeroForOne === 1 ? tokenOut : tokenIn;
          router.swap({
            poolType: 2, pool: dp[1],
            poolKey: { currency0: k0, currency1: k1, fee: dp[2], tickSpacing: dp[3], hooks: dp[4] },
            tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(amt),
            sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
          });
        } else {
          router.swapV3(dp[1], tokenIn, tokenOut, amt, priceLimit, address.self, address.self);
        }
      }
      }
    }
  }
  for (let r = 0; r < routes.length; r = r + 1) {
    const ramt: Uint256 = rinp[r];
    if (ramt > 0) {
      const route: Tuple = routes[r];
      const inter: Address = route[0];
      router.swapV3(route[2], tokenIn, inter, ramt, 0, address.self, address.self);
      const interBal: Uint256 = IERC20.at(inter).balanceOf(address.self);
      if (interBal > 0) {
        router.swapV3(route[7], inter, tokenOut, interBal, 0, address.self, address.self);
      }
    }
  }
  // ── Curve StableSwap execution ──
  // Each engaged Curve venue executes its merged Σ share via ONE atomic engine swap with
  // poolType=3 (SwapPoolType.Curve) → _swapCurve, which forceApproves the pool and calls
  // exchange(i, j, amountIn, 0). The engine resolves the int128 coin indices i,j on-chain by
  // iterating coins() against tokenIn/tokenOut, so the SwapParams object literal carries no
  // i/j fields (the EcoCurve i/j are off-chain metadata). amountSpecified is NEGATIVE (the
  // unified-swap exact-in convention; _swapCurve takes abs()). payer == address.self because
  // compute-then-pull already transferred `cum` (incl. every curve share) here, so _swapCurve
  // pulls nothing and forwards the dy back to address.self (recipient). The realized dy is
  // wei-exact get_dy(share) (one exchange); the SPLIT equalizes marginals on the sampled grid
  // (exact-in-dy / exact-on-grid vs the neutral oracle). The poolKey is unused for Curve (V4
  // only) — kept zeroed to match the V2-path SwapParams shape.
  for (let c = 0; c < routeSegs.length; c = c + 1) {
    const camt: Uint256 = cinp[c];
    if (camt > 0) {
      const cpool: Address = cven[c];
      router.swap({
        poolType: 3, pool: cpool,
        poolKey: { currency0: 0, currency1: 0, fee: 0, tickSpacing: 0, hooks: 0 },
        tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(camt),
        sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
      });
    }
  }
  // ── Trader Joe LB execution ──
  // Each engaged LB pair executes its merged Σ share via ONE atomic engine swap with poolType=6
  // (SwapPoolType.TraderJoeLB) → _swapTraderJoeLB, which transfers the input to the pair and
  // calls pair.swap(swapForY, recipient). The engine resolves swapForY on-chain (tokenIn ==
  // getTokenX()), so the SwapParams object literal carries NO bin/price/direction data (the
  // EcoLb binStep/fee are off-chain metadata only — the segment merge already used them).
  // amountSpecified is NEGATIVE (the unified-swap exact-in convention; _swapTraderJoeLB takes
  // abs()). payer == address.self because compute-then-pull already transferred `cum` (incl.
  // every LB share) here, so _swapTraderJoeLB pulls from this contract and forwards the out to
  // address.self (recipient). LB bins are constant-sum at fixed prices, so the realized out is
  // EXACT for the share (no grid error). The poolKey is unused for LB (V4 only) — kept zeroed
  // to match the V2/Curve-path SwapParams shape.
  for (let l = 0; l < routeSegs.length; l = l + 1) {
    const lamt: Uint256 = linp[l];
    if (lamt > 0) {
      const lpool: Address = lven[l];
      router.swap({
        poolType: 6, pool: lpool,
        poolKey: { currency0: 0, currency1: 0, fee: 0, tickSpacing: 0, hooks: 0 },
        tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(lamt),
        sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
      });
    }
  }
  // ── DODO V2 PMM execution ──
  // Each engaged DODO pool executes its merged Σ share via ONE atomic engine swap with poolType=5
  // (SwapPoolType.DODOV2) → _swapDODOV2, which transfers the input to the pool and calls
  // sellBase(recipient) or sellQuote(recipient). The engine resolves the sell direction on-chain
  // (tokenIn == _BASE_TOKEN_() ⇒ sellBase, else sellQuote), so the SwapParams object literal
  // carries NO orientation/PMM-state data (the EcoDodo i/K/R/reserves are off-chain metadata only
  // — the segment merge already used them). amountSpecified is NEGATIVE (the unified-swap exact-in
  // convention; _swapDODOV2 takes abs()). payer == address.self because compute-then-pull already
  // transferred `cum` (incl. every DODO share) here, so _swapDODOV2 transfers from this contract
  // and forwards the out to address.self (recipient). The realized out is wei-exact querySell*(share)
  // (one atomic sellBase/sellQuote); the SPLIT equalizes post-fee marginals on the sampled grid
  // (exact-in-dy / exact-on-grid vs the neutral oracle). The poolKey is unused for DODO (V4 only) —
  // kept zeroed to match the V2/Curve/LB-path SwapParams shape.
  for (let d = 0; d < routeSegs.length; d = d + 1) {
    const damt: Uint256 = dinp[d];
    if (damt > 0) {
      const dpool: Address = dven[d];
      router.swap({
        poolType: 5, pool: dpool,
        poolKey: { currency0: 0, currency1: 0, fee: 0, tickSpacing: 0, hooks: 0 },
        tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(damt),
        sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
      });
    }
  }
  const leftover: Uint256 = token.balanceOf(address.self);
  if (leftover > 0) {
    token.transfer(caller, leftover);
  }
  const outToken = IERC20.at(tokenOut);
  const outBal: Uint256 = outToken.balanceOf(address.self);
  outToken.transfer(caller, outBal);
  return outBal;
}
