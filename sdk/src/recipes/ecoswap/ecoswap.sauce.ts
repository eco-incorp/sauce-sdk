import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3PoolFull } from "./IUniswapV3PoolFull.json";
import { IStateViewFull } from "./IStateViewFull.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";
import { IKyberPool } from "./IKyberPool.json";

// EcoSwap on-chain solver — FLAT-UNIVERSE multihop LIVE walk (direct pools + routes).
//
// ONE price-ordered merge splits ONE swap across {direct pools} ∪ {multi-hop routes} so the
// POST-FEE MARGINAL out/in price equalizes across every venue that receives input. Every DIRECT
// pool (universe indices [0, directCount)) walks ONE frontier from its LIVE spot, deeper, one
// tickSpacing per step. A ROUTE (A→X→B) is a COMPOSITE venue: each LEG is a SET of leg pools
// (universe indices [base, base+count), appended after the direct pools), and the route head is
// the LEFT-TO-RIGHT product fold (composeStep) of the per-leg best fee-adjusted out/in heads, so
// it competes in the SAME bestPrice comparison as a direct pool. Advancing a route = the binding-
// leg event (routeEventN inlined over legCount): the binding leg's winning pool crosses one bracket
// (the existing per-pool tick step), every other leg partially fills with conservation at every
// intermediate (leg i out == leg i+1 in). N-hop (2-hop + 3-hop the same loop). The result is the
// optimal equalized split — exact (global price order), lazy (only
// reconstructs as cum needs), and wei-exact with the neutral optimal oracle (ecoswap.optimal.ts:
// pools + routeSegments in ONE descending-price merge) — see also ecoswap.solver-reference.ts.
//
// THE UNIFIED MODEL (one walk, no two-mode cache-vs-re-anchor split):
//   A tick's liquidityNet is DRIFT-INVARIANT: the absolute active-L of a tick range does not
//   change when the spot price moves. So the solver ALWAYS computes sqrt/price on the LIVE grid
//   (stepReal from the live spot — identical to the oracle's v3Segments/legBrackets) and reuses
//   the cached NET only: a cache lookup for an in-window boundary, a ticks()/getTickLiquidity()
//   staticcall for an out-of-window boundary. Same grid, same nets ⇒ wei-exact with the oracle BY
//   CONSTRUCTION, for ANY drift in EITHER direction. The cache is a pure gas optimization
//   (windowTop=0 ⇒ every boundary staticcalls ⇒ the 1-RPC quote path with no prepared ticks).
//
// PER-POOL SWAP DIRECTION FROM pd[7]: a route leg's hop direction (zHop) can differ from the
//   overall swap direction, so the solver drives toOutIn/stepReal/tickArg/seed PER POOL from that
//   pool's inIsToken0 field pd[7] (== that pool's zeroForOne) — NOT a top-level zeroForOne. A leg
//   pool is therefore byte-identical to a direct pool and reuses the per-pool frontier code.
//
// WALK-THROUGH GAPS (interior L==0): a pool is NEVER deactivated while liquidity is known ahead.
//   A step deactivates ONLY on the price limit, the per-pool budget cap, or (dL==0 AND past the
//   pool's deepest initialized tick extremeShifted). Interior L==0 gaps keep walking.
//
// COMPUTE-THEN-PULL: the merge is read-only (slot0 / getReserves / ticks / getTickLiquidity
//   staticcalls only), so we first compute exactly how much tokenIn the swaps will consume (cum),
//   then transferFrom the caller EXACTLY that. Direct pools swap their inp[]; routes swap their
//   rinp[] tokenIn->X then read the REALIZED intermediate balance and swap X->tokenOut. One
//   guarded terminal refund returns the only possible leftover (the limit-price edge).
//
// Inputs (precomputed off-chain in prepare.ts; layout built by index.ts buildPoolUniverseAndRouting):
//   cfg         = [tokenIn, tokenOut, amountIn, caller, priceLimit, directCount] — ONE scalar
//                 tuple (the lens trick: keeps main() at 4 params so the v12 arg-prologue SDUP
//                 window stays small). directCount = number of leading universe entries that are
//                 DIRECT venues (== prepared.pools.length); entries [directCount, …) are leg-only.
//   pools[i]    = [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0,
//                  stateView, poolId, stepRatio, windowTopShifted, windowBotShifted,
//                  extremeShifted, netStart, netCount, isKyber] — the FLAT POOL UNIVERSE
//                 ([...prepared.pools, ...legPools], leg pools deduped). pd[7] inIsToken0 IS that
//                 pool's zeroForOne (leg pools carry the LEG's zHop). V2: [10..15]=0.
//                 [16] isKyber = 1 ⇒ KyberSwap Classic / DMM (V2-shaped on VIRTUAL reserves: SETUP
//                 reads getTradeInfo() vReserves for the curve, and the callback-free swap computes
//                 the output on the virtual reserves with the live feeInPrecision). 0 ⇒ plain UniswapV2
//                 (or, for a leg pool, a canonical 0.30% V2). A DIRECT V2 pool whose feePpm != 3000
//                 executes callback-free at its REAL fee; route-leg V2 pools stay canonical 0.30%.
//   netCache[n] = [shiftedTick, rawNet] — per-pool grouped [netStart, netStart+netCount), sorted
//                 in SWAP DIRECTION; rawNet is the raw uint128 ticks() returns.
//   routing[r]  = [legCount, base0,count0,inter0, base1,count1,inter1, …] — one flat SCALAR tuple
//                 per route, uniform 3-field stride per leg (leg L at rt[1+3L],rt[2+3L],rt[3+3L]).
//                 Leg L pools = universe indices [baseL, baseL+countL); interL = intermediate token
//                 AFTER leg L (final leg → 0). The merge head fold, the route event, and the
//                 chain-order execution all loop over legCount, so N-hop needs no shape change.
//   segs[g]     = [refIdx, capacity, sqrtAdjNear, sqrtAdjFar, segKind, venue] — the SAMPLED-SEGMENT
//                 venue stream (Curve / Trader Joe LB / DODO V2 interleaved), sorted DESC sqrtAdjNear.
//                 These are STATIC venues: their curve math is OFF-CHAIN ONLY (prepare samples — LB
//                 EXACTLY enumerates — each into post-fee flat segments), so the solver does NOT
//                 recompute either curve. It consumes the rows in price order through ONE cursor
//                 (bestKind===1), accumulates the awarded Σ per venue (keyed by the row's venue
//                 address), and dispatches on segKind at execution: 1 = Curve (swap(poolType:3) →
//                 _swapCurve), 2 = LB (swap(poolType:6) → _swapTraderJoeLB), 3 = DODO (swap(poolType:5)
//                 → _swapDODOV2). The engine resolves coin indices / swapForY / base-quote orientation
//                 on-chain, so the SwapParams carry NO curve data — the segment merge already used it.
//                 Curve/DODO are exact-on-grid; LB is EXACT (a bin is a flat constant-sum slice).
// All sqrt values are unified out/in Q96.


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

// ── Pure-value route-composition helpers — mirror ecoswap.math.ts BIT-FOR-BIT ──
// These factor the route arithmetic out of main using ONLY Math.* intrinsics inline (so they
// never call another user helper, which the compiler forbids). The 2-hop routeEvent2/routePartial2
// LOGIC is inlined in main (it would otherwise be a helper calling these helpers), but each piece
// of its arithmetic is one of these primitives so the solver==oracle==reference to the wei.

/** Product fold of two out/in sqrt heads, rescaled by Q96: h1*h2/2^96 (mirrors composeStep). */
function composeStep(accSqrtQ96: Uint256, legSqrtQ96: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  return Math.mulDiv(accSqrtQ96, legSqrtQ96, Q96);
}

/** Gross input to traverse a constant-L bracket [nearOI > farOI]: effIn grossed up by fee. */
function bracketGross(L: Uint256, nearOI: Uint256, farOI: Uint256, feePpm: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  const FEE_DENOM: Uint256 = 1000000;
  const effIn: Uint256 = Math.mulDiv(L, Q96, farOI) - Math.mulDiv(L, Q96, nearOI);
  return Math.mulDiv(effIn, FEE_DENOM, FEE_DENOM - feePpm);
}

/** Output produced over a constant-L bracket [nearOI > farOI]: L*(nearOI - farOI)/2^96. */
function bracketOut(L: Uint256, nearOI: Uint256, farOI: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  return Math.mulDiv(L, nearOI - farOI, Q96);
}

/** The far OI after absorbing grossIn (incl. fee) within a constant-L bracket (localQuote inv). */
function invertFarFromGrossIn(L: Uint256, nearOI: Uint256, grossIn: Uint256, feePpm: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  const FEE_DENOM: Uint256 = 1000000;
  const effIn: Uint256 = Math.mulDiv(grossIn, FEE_DENOM - feePpm, FEE_DENOM);
  const invNear: Uint256 = Math.mulDiv(L, Q96, nearOI);
  const invLow: Uint256 = invNear + effIn;
  if (invLow > 0) {
    return Math.mulDiv(L, Q96, invLow);
  }
  return 0;
}

/** The far OI after producing outAmt within a constant-L bracket: nearOI - outAmt*2^96/L. */
function invertFarFromOut(L: Uint256, nearOI: Uint256, outAmt: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  return nearOI - Math.mulDiv(outAmt, Q96, L);
}

function main(
  cfg: Tuple,
  pools: Tuple, netCache: Tuple, routing: Tuple, segs: Tuple
): Uint256 {
  // cfg = [tokenIn, tokenOut, amountIn, caller, priceLimit, directCount]
  const tokenIn: Address = cfg[0];
  const tokenOut: Address = cfg[1];
  const amountIn: Uint256 = cfg[2];
  const caller: Address = cfg[3];
  const priceLimit: Uint256 = cfg[4];
  const directCount: Uint256 = cfg[5];

  const router = ISauceRouter.at(address.self);
  const token = IERC20.at(tokenIn);

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
  // Run-until-filled budget. PER_POOL bounds each pool's single from-live-spot walk (it MUST equal
  // the optimal oracle's MAX_V3_STEPS and the reference's PER_POOL EXACTLY, so the split is
  // wei-exact EVEN WHEN THE CAP BINDS). SAFETY dominates the SUM of all per-pool reaches plus the
  // route events (routing.length*PER_POOL extra) so the outer merge loop never itself truncates a
  // fill the per-pool caps would complete.
  const PER_POOL: Uint256 = 2048;
  // SAFETY dominates every per-pool reach + the route events + ONE merge step per sampled segment
  // (each static segment is consumed in exactly one step, so + segs.length covers the cursor).
  const SAFETY: Uint256 = pools.length * PER_POOL * 2 + routing.length * PER_POOL + segs.length;

  // Per-universe-pool accumulators + the single live frontier state (walked from the live spot).
  let inp: Tuple = new Array(pools.length);
  let lArr: Tuple = new Array(pools.length); // V2 live √k
  let dnOn: Tuple = new Array(pools.length); // frontier active flag
  let dnNear: Tuple = new Array(pools.length); // real sqrt (V3/V4) or out/in (V2) near edge
  let dnL: Tuple = new Array(pools.length); // active L
  let dnShift: Tuple = new Array(pools.length); // next boundary (shifted)
  let dnSteps: Tuple = new Array(pools.length); // per-pool step budget
  let netCur: Tuple = new Array(pools.length); // cursor into this pool's netCache rows
  let sfArr: Tuple = new Array(pools.length); // per-pool sqrt fee factor (constant)
  let zArr: Tuple = new Array(pools.length); // per-pool zeroForOne (== pd[7] inIsToken0)
  // Route-leg bracket far (real sqrt for V3/V4, out/in for V2): the FIXED far edge of the leg
  // pool's CURRENT bracket. A route PARTIAL fill moves the pool's near (dnNear) WITHIN the bracket
  // while keeping this far fixed; a FULL cross re-anchors it to one stepReal past the new near.
  // This mirrors the oracle's routeSegments, which holds b[i].farOI fixed across partial events.
  let brFar: Tuple = new Array(pools.length);
  let rinp: Tuple = new Array(routing.length);

  // Per-venue input accumulators for the SAMPLED-SEGMENT venues (Curve / LB / DODO), each keyed
  // by the static-segment INDEX (multiple segments can share one venue ⇒ accumulate; the venue
  // address is stamped from the row). Sized by the segment-stream length (an upper bound on
  // distinct venues per kind). The three kinds keep SEPARATE arrays (their refIdx counters are
  // independent). cven/lven/dven stay 0 for an unused slot; a >0 input marks a venue to execute.
  let cinp: Tuple = new Array(segs.length); // Curve per-venue Σ input
  let cven: Tuple = new Array(segs.length); // Curve venue (exchange() pool) address
  let linp: Tuple = new Array(segs.length); // LB per-venue Σ input
  let lven: Tuple = new Array(segs.length); // LB venue (pair) address
  let dinp: Tuple = new Array(segs.length); // DODO per-venue Σ input
  let dven: Tuple = new Array(segs.length); // DODO venue (pool) address
  // Static-segment cursor: segs is pre-sorted DESC by sqrtAdjNear (then adjFar, then refIdx — the
  // SAME order the merge tie-breaks on), so the cursor only ever advances; a segment is consumed
  // once. The head candidate for the merge is always segs[segCur] (the next-best-priced slice).
  let segCur: Uint256 = 0;

  // Per-leg scratch for the N-leg route event (sized to the universe — legCount <= pools.length
  // since route legs are disjoint pool slices). Reused across every route + step (allocated ONCE
  // here, never inside the hot loop). lgP = leg binding pool index; lgN/lgF = the leg's current
  // bracket near/far OI; lgL/lgFee = its L/fee; lgNF = the event's new far OI per leg; lgFR = the
  // leg pool's bracket far REAL sqrt (re-anchor source for a full cross / brFar latch).
  let lgP: Tuple = new Array(pools.length);
  let lgN: Tuple = new Array(pools.length);
  let lgF: Tuple = new Array(pools.length);
  let lgL: Tuple = new Array(pools.length);
  let lgFee: Tuple = new Array(pools.length);
  let lgNF: Tuple = new Array(pools.length);
  let lgFR: Tuple = new Array(pools.length);

  let cum: Uint256 = 0;

  // ── SETUP: read live state once per universe pool, seed the single frontier from the LIVE spot ──
  for (let i = 0; i < pools.length; i = i + 1) {
    const pd: Tuple = pools[i];
    const isV2: Uint256 = pd[6];
    const pType: Uint256 = pd[0];
    const zfo: Uint256 = pd[7]; // per-pool swap direction (leg pools carry the leg's zHop)
    zArr[i] = zfo;
    let ll: Uint256 = 0;
    dnSteps[i] = 0;
    brFar[i] = 0;
    // sf = sqrt((FEE_DENOM - feePpm)*FEE_DENOM) depends only on the constant pool fee — compute the
    // integer sqrt ONCE here and reuse it in the hot merge loop (feeAdj = mulDiv(oi, sf, FEE_DENOM)).
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
      const resIn: Uint256 = zfo === 1 ? r0 : r1;
      const resOut: Uint256 = zfo === 1 ? r1 : r0;
      ll = Math.sqrt(resIn * resOut);
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
      if (zfo === 0) { sh = base + ts; }
      dnOn[i] = 1;
      dnNear[i] = srReal; // V3/V4 frontier stores the live real sqrt
      dnL[i] = liveL;
      dnShift[i] = sh;

      // Position the per-pool net cursor PAST any cached rows above the first boundary (drift-down
      // skip). Rows are sorted in swap direction. netStart=[14], netCount=[15].
      const nStart: Uint256 = pd[14];
      const nCount: Uint256 = pd[15];
      let cur: Uint256 = nStart;
      const nEnd: Uint256 = nStart + nCount;
      if (nCount > 0) {
        for (let q = 0; q < nCount; q = q + 1) {
          if (cur < nEnd) {
            const row: Tuple = netCache[cur];
            const rt: Uint256 = row[0];
            let skip: Uint256 = 0;
            if (zfo === 1) { if (rt > sh) { skip = 1; } }
            else { if (rt < sh) { skip = 1; } }
            if (skip === 1) { cur = cur + 1; }
          }
        }
      }
      netCur[i] = cur;
    }
    lArr[i] = ll;
  }

  // ── MERGE: each step, pick the best-priced candidate head (direct pool OR route) and advance it ──
  for (let s = 0; s < SAFETY; s = s + 1) {
    // Terminate the run-until-filled loop the instant the trade is fully allocated. SauceScript has
    // no break — jump the counter to the bound (split-identical: the body is gated on cum<amountIn).
    if (cum >= amountIn) { s = SAFETY; }
    if (cum < amountIn) {
      // 1. find the highest fee-adjusted head among {each direct pool frontier, each route}. Ties on
      // the near (entry) price break by HIGHER far (shallower step). Bit-identical to the oracle's
      // segment sort (adjNear DESC, adjFar DESC) and the reference.
      let bestKind: Uint256 = 0; // 0=none 1=sampled segment 2=route 3=direct pool frontier
      let bestPool: Uint256 = 0;
      let bestRoute: Uint256 = 0;
      let bestPrice: Uint256 = 0;
      let bestFar: Uint256 = 0;

      // 1a. direct pools — universe indices [0, directCount).
      for (let j = 0; j < pools.length; j = j + 1) {
        if (j < directCount) {
          const jd: Tuple = pools[j];
          if (dnOn[j] === 1) {
            const jz: Uint256 = zArr[j];
            const jsf: Uint256 = sfArr[j];
            let doi: Uint256 = 0;
            if (jd[6] === 1) {
              doi = dnNear[j];
            } else {
              doi = toOutIn(dnNear[j], jz);
            }
            const dadj: Uint256 = Math.mulDiv(doi, jsf, FEE_DENOM);
            // LAZY far-adjust: the far price is ONLY the near-tie break, so a pool whose near is
            // strictly below the best can never win — skip its far. Bit-identical to an eager far.
            if (dadj >= bestPrice) {
              let dfarAdj: Uint256 = 0;
              if (jd[6] === 1) {
                const v2Far: Uint256 = dnNear[j] - Math.mulDiv(dnNear[j], V2_STEP_BPS, V2_STEP_DEN);
                dfarAdj = Math.mulDiv(v2Far, jsf, FEE_DENOM);
              } else {
                const farReal: Uint256 = stepReal(dnNear[j], jd[10], jz);
                dfarAdj = Math.mulDiv(toOutIn(farReal, jz), jsf, FEE_DENOM);
              }
              let win: Uint256 = 0;
              if (dadj > bestPrice) { win = 1; }
              if (dadj === bestPrice) { if (dfarAdj > bestFar) { win = 1; } }
              if (win === 1) { bestPrice = dadj; bestFar = dfarAdj; bestKind = 3; bestPool = j; }
            }
          }
        }
      }

      // 1b. routes — each route's head is the LEFT-TO-RIGHT product fold of its legs' best
      // fee-adjusted heads. For EACH leg L (slice [baseL, baseL+countL), fields at rt[1+3L],
      // rt[2+3L]) compute its internal best ACTIVE pool near/far adj, fold near→routeNear and
      // far→routeFar via composeStep. A route is dead if ANY leg has no active pool. N-leg loop
      // over legCount (rt[0]) — 2-hop and 3-hop are the same code.
      for (let r = 0; r < routing.length; r = r + 1) {
        const rt: Tuple = routing[r];
        const legCount: Uint256 = rt[0];
        let rNear: Uint256 = Q96; // fold accumulator seeded at 1.0 (Q96) ⇒ first composeStep == leg0
        let rFar: Uint256 = Q96;
        let rDead: Uint256 = 0;
        let firstLeg: Uint256 = 1;
        for (let L = 0; L < legCount; L = L + 1) {
          const baseL: Uint256 = rt[1 + 3 * L];
          const countL: Uint256 = rt[2 + 3 * L];
          const eL: Uint256 = baseL + countL;
          // leg L internal best (near adj, far adj) over its active pools.
          let lAdj: Uint256 = 0;
          let lFarAdj: Uint256 = 0;
          let lLive: Uint256 = 0;
          for (let a = baseL; a < eL; a = a + 1) {
            if (dnOn[a] === 1) {
              const ad: Tuple = pools[a];
              const az: Uint256 = zArr[a];
              const asf: Uint256 = sfArr[a];
              // V2 leg pool stores dnNear as out/in directly + steps a constant-L geometric slice;
              // V3/V4 store the real sqrt + step the tick grid via stepReal. Mirror the reference's
              // frontierNearOI/frontierFarOI per type so a V2 leg competes with the right geometry.
              let aoi: Uint256 = 0;
              let afarOI: Uint256 = 0;
              if (ad[6] === 1) {
                aoi = dnNear[a];
                afarOI = dnNear[a] - Math.mulDiv(dnNear[a], V2_STEP_BPS, V2_STEP_DEN);
              } else {
                aoi = toOutIn(dnNear[a], az);
                afarOI = toOutIn(stepReal(dnNear[a], ad[10], az), az);
              }
              const aadj: Uint256 = Math.mulDiv(aoi, asf, FEE_DENOM);
              if (aadj >= lAdj) {
                const afarAdj: Uint256 = Math.mulDiv(afarOI, asf, FEE_DENOM);
                let w0: Uint256 = 0;
                if (aadj > lAdj) { w0 = 1; }
                if (aadj === lAdj) { if (afarAdj > lFarAdj) { w0 = 1; } }
                if (w0 === 1) { lAdj = aadj; lFarAdj = afarAdj; lLive = 1; }
              }
            }
          }
          if (lLive === 0) { rDead = 1; }
          // composeStep fold (rescale by Q96). Seeded at Q96 ⇒ the first fold yields leg0's head.
          if (firstLeg === 1) { rNear = lAdj; rFar = lFarAdj; firstLeg = 0; }
          else { rNear = composeStep(rNear, lAdj); rFar = composeStep(rFar, lFarAdj); }
        }
        if (rDead === 0) {
          if (rNear >= bestPrice) {
            let rw: Uint256 = 0;
            if (rNear > bestPrice) { rw = 1; }
            if (rNear === bestPrice) { if (rFar > bestFar) { rw = 1; } }
            if (rw === 1) { bestPrice = rNear; bestFar = rFar; bestKind = 2; bestRoute = r; }
          }
        }
      }

      // 1c. sampled segments (Curve/LB/DODO) — ONE cursor over the pre-sorted (DESC adjNear, adjFar)
      // segs stream. The head is segs[segCur] (next-best slice); its near/far are ALREADY post-fee
      // out/in (prepare sets sqrtAdjNear==sqrtAdjFar to the post-fee marginal), so they compare
      // directly. Same tie-break as the pools/routes (near DESC, then far DESC).
      if (segCur < segs.length) {
        const sg: Tuple = segs[segCur];
        const sNear: Uint256 = sg[2];
        const sFar: Uint256 = sg[3];
        if (sNear >= bestPrice) {
          let sw: Uint256 = 0;
          if (sNear > bestPrice) { sw = 1; }
          if (sNear === bestPrice) { if (sFar > bestFar) { sw = 1; } }
          if (sw === 1) { bestPrice = sNear; bestFar = sFar; bestKind = 1; }
        }
      }

      // Early-out: no active stream produced a head with price > 0 (all exhausted).
      if (bestKind === 0) { s = SAFETY; }

      // 2. consume + advance the winner
      if (bestKind === 3) {
        // ── direct pool frontier step ──
        const dd: Tuple = pools[bestPool];
        const dfee: Uint256 = dd[5];
        const ddz: Uint256 = zArr[bestPool];
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
          const dfarReal: Uint256 = stepReal(dnear, dstep, ddz);
          const dnearOI: Uint256 = toOutIn(dnear, ddz);
          const dfarOI: Uint256 = toOutIn(dfarReal, ddz);
          let dlim: Uint256 = 0;
          if (ddz === 1) { if (dfarReal <= priceLimit) { dlim = 1; } }
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
          // Boundary net (raw uint128): cache window cursor, else ticks()/getTickLiquidity staticcall.
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
          if (ddz === 1) {
            if (dneg === 1) { dL = dL + (MOD128 - dnet); } else { dL = dL >= dnet ? dL - dnet : 0; }
            dsh = dsh - dts;
          } else {
            if (dneg === 1) { const dm: Uint256 = MOD128 - dnet; dL = dL >= dm ? dL - dm : 0; } else { dL = dL + dnet; }
            dsh = dsh + dts;
          }
          dnNear[bestPool] = dfarReal;
          dnL[bestPool] = dL;
          dnShift[bestPool] = dsh;
          // TERMINATE only on: price limit, OR budget cap, OR (dL==0 AND boundary PAST extreme).
          if (dlim === 1) { dnOn[bestPool] = 0; }
          const ext: Uint256 = dd[13];
          if (dL === 0) { if (ext > 0) {
            let pastExt: Uint256 = 0;
            if (ddz === 1) { if (dsh < ext) { pastExt = 1; } }
            else { if (dsh > ext) { pastExt = 1; } }
            if (pastExt === 1) { dnOn[bestPool] = 0; }
          } }
          dnSteps[bestPool] = dnSteps[bestPool] + 1;
          if (dnSteps[bestPool] >= PER_POOL) { dnOn[bestPool] = 0; }
        }
      } else {
        if (bestKind === 2) {
          // ── route event (N-leg, routeEventN/routePartialN inlined; helpers can't call helpers) ──
          // Resolve ONE route event across legCount legs: find the BINDING leg (the one whose full
          // tick-cross maps to the SMALLEST token-A input when back-propagated through the upstream
          // legs' current constant-L brackets), advance its winning pool ONE bracket (the existing
          // per-pool tick step), and PARTIAL-fill every other leg via the constant-L inversion with
          // conservation at every intermediate. 2-hop and 3-hop are the SAME loop. The per-leg
          // scratch (lgP/lgN/lgF/lgFR/lgL/lgFee/lgNF) is reused — written fresh each event. A leg
          // pool of any type participates: V2 legs use the constant-L geometric step (out/in near,
          // no real-sqrt grid) while V3/V4 step the tick grid; a V2 leg partial-fills but is sized
          // deep enough never to be the binding (tick-crossing) leg.
          const rt: Tuple = routing[bestRoute];
          const legCount: Uint256 = rt[0];

          // Phase A: per-leg binding pool (the leg's best ACTIVE fee-adjusted near, the SAME scan as
          // the head selection) + its CURRENT bracket [near, far] OI on the fixed live grid. brFar
          // (latched on a prior partial) holds the bracket's fixed far; else one stepReal ahead.
          for (let L = 0; L < legCount; L = L + 1) {
            const baseL: Uint256 = rt[1 + 3 * L];
            const eL: Uint256 = baseL + rt[2 + 3 * L];
            let pBest: Uint256 = baseL;
            let pAdj: Uint256 = 0;
            for (let a = baseL; a < eL; a = a + 1) {
              if (dnOn[a] === 1) {
                let aoi: Uint256 = 0;
                if (pools[a][6] === 1) { aoi = dnNear[a]; }
                else { aoi = toOutIn(dnNear[a], zArr[a]); }
                const aadj: Uint256 = Math.mulDiv(aoi, sfArr[a], FEE_DENOM);
                if (aadj > pAdj) { pAdj = aadj; pBest = a; }
              }
            }
            const zb: Uint256 = zArr[pBest];
            const db: Tuple = pools[pBest];
            lgP[L] = pBest;
            lgL[L] = dnL[pBest];
            lgFee[L] = db[5];
            // V2 leg pool: near is out/in directly + the far is a constant-L geometric slice (no real
            // sqrt grid; brFar latch is unused — V2 always recomputes from the current near). V3/V4:
            // near = toOutIn(real), far = one stepReal ahead (or the latched bracket far brFar).
            if (db[6] === 1) {
              lgN[L] = dnNear[pBest];
              const v2far: Uint256 = dnNear[pBest] - Math.mulDiv(dnNear[pBest], V2_STEP_BPS, V2_STEP_DEN);
              lgF[L] = v2far;
              lgFR[L] = v2far; // unused for a non-binding V2 leg (V2 never crosses a tick)
            } else {
              lgN[L] = toOutIn(dnNear[pBest], zb);
              let fReal: Uint256 = stepReal(dnNear[pBest], db[10], zb);
              if (brFar[pBest] > 0) { fReal = brFar[pBest]; }
              lgFR[L] = fReal;
              lgF[L] = toOutIn(fReal, zb);
            }
          }

          // Phase B: binding leg = argmin over REACHABLE legs of the token-A input to FULLY cross
          // leg i (back-propagate leg i's full-cross gross through the upstream legs' brackets via
          // invertFarFromOut→bracketGross). A `-1` sentinel (here cand==0 with crossed==1) means an
          // upstream leg would cross its OWN far first ⇒ leg i not binding; skip it. Lowest index
          // wins ties (strict <). Leg 0 is always reachable.
          let bindLeg: Uint256 = 0;
          let routeIn: Uint256 = 0;
          let haveBest: Uint256 = 0;
          for (let i = 0; i < legCount; i = i + 1) {
            // need = leg i full-cross gross (token T_i), then back-propagate through legs i-1..0.
            // SauceScript is uint256-only (no `j-- >= 0` — 0-1 underflows), so walk an ASCENDING
            // counter q over [0, i) and address leg j = i-1-q (legs i-1 down to 0).
            let need: Uint256 = bracketGross(lgL[i], lgN[i], lgF[i], lgFee[i]);
            let crossed: Uint256 = 0;
            for (let q = 0; q < i; q = q + 1) {
              const j: Uint256 = i - 1 - q;
              // farj that PRODUCES `need` of the downstream input out of leg j (invertFarFromOut).
              // If it lands at/below leg j's own far, leg j crosses first ⇒ leg i not binding.
              const prodOut: Uint256 = Math.mulDiv(need, Q96, lgL[j]);
              if (prodOut >= lgN[j]) { crossed = 1; }
              else {
                const farj: Uint256 = lgN[j] - prodOut;
                if (farj <= lgF[j]) { crossed = 1; }
                else { need = bracketGross(lgL[j], lgN[j], farj, lgFee[j]); }
              }
            }
            if (crossed === 0) {
              if (haveBest === 0) { bindLeg = i; routeIn = need; haveBest = 1; }
              else { if (need < routeIn) { bindLeg = i; routeIn = need; } }
            }
          }

          // Phase C: resolve the event from the binding leg. The binding leg lands EXACTLY on its
          // bracket far (lgNF[bindLeg] = its far); upstream legs back-invert (invertFarFromOut) to
          // PRODUCE the binding leg's exact gross input; downstream legs forward-invert
          // (invertFarFromGrossIn) to ABSORB the upstream leg's exact output. routeIn is recomputed
          // exactly here (the back-propagated leg-0 gross).
          lgNF[bindLeg] = lgF[bindLeg];
          const bindGrossIn: Uint256 = bracketGross(lgL[bindLeg], lgN[bindLeg], lgF[bindLeg], lgFee[bindLeg]);
          const bindOut: Uint256 = bracketOut(lgL[bindLeg], lgN[bindLeg], lgF[bindLeg]);
          // Upstream (j < bindLeg): each PRODUCES the downstream leg's exact required input. Walk
          // an ASCENDING counter q over [0, bindLeg) and address j = bindLeg-1-q (uint256-only).
          let need: Uint256 = bindGrossIn;
          for (let q = 0; q < bindLeg; q = q + 1) {
            const j: Uint256 = bindLeg - 1 - q;
            const farj: Uint256 = invertFarFromOut(lgL[j], lgN[j], need);
            lgNF[j] = farj;
            need = bracketGross(lgL[j], lgN[j], farj, lgFee[j]);
          }
          routeIn = need; // token-A gross input (the merged route input this event)
          // Downstream (j > bindLeg): each ABSORBS the upstream leg's exact output as gross-in.
          let flow: Uint256 = bindOut;
          for (let j = bindLeg + 1; j < legCount; j = j + 1) {
            const farj: Uint256 = invertFarFromGrossIn(lgL[j], lgN[j], flow, lgFee[j]);
            lgNF[j] = farj;
            flow = bracketOut(lgL[j], lgN[j], farj);
          }

          // Phase D: clamp to the remaining global budget. If clamped, the route is the crossing
          // venue: forward-propagate the remainder through ALL legs (routePartialN) WITHOUT crossing
          // any tick — every leg partial-fills interior to its bracket. Otherwise the BINDING leg
          // crosses its tick (full per-pool V3 step); every other leg moves its near to lgNF[L].
          let rtake: Uint256 = routeIn;
          let clamp: Uint256 = 0;
          if (cum + routeIn >= amountIn) { rtake = amountIn - cum; clamp = 1; }

          if (clamp === 1) {
            // routePartialN: forward-propagate rtake through all legs; near → partial far (interior).
            let pflow: Uint256 = rtake;
            for (let L = 0; L < legCount; L = L + 1) {
              const pI: Uint256 = lgP[L];
              const farL: Uint256 = invertFarFromGrossIn(lgL[L], lgN[L], pflow, lgFee[L]);
              // V2 leg pool stores near as out/in directly (no real-sqrt grid, no brFar latch);
              // V3/V4 convert the out/in partial far back to a real sqrt + latch the bracket far.
              if (pools[pI][6] === 1) {
                dnNear[pI] = farL;
              } else {
                dnNear[pI] = toOutIn(farL, zArr[pI]);
                if (brFar[pI] === 0) { brFar[pI] = lgFR[L]; }
              }
              const inAmt: Uint256 = L === 0 ? rtake : pflow;
              inp[pI] = inp[pI] + inAmt; // leg L's flow-in share (tokenIn for leg0, intermediate else)
              pflow = bracketOut(lgL[L], lgN[L], farL); // this leg's output → next leg's gross-in
            }
          } else {
            // Full event: cross the binding leg's tick; partial-fill the others to lgNF[L].
            for (let L = 0; L < legCount; L = L + 1) {
              const pI: Uint256 = lgP[L];
              // leg L's flow-in this event: leg0 = routeIn; leg L>0 = the gross input it absorbs
              // (== bracketGross over its current bracket to lgNF[L]). Conservation holds by
              // construction (downstream legs were forward-inverted from the upstream output).
              const inAmt: Uint256 = L === 0 ? routeIn : bracketGross(lgL[L], lgN[L], lgNF[L], lgFee[L]);
              inp[pI] = inp[pI] + inAmt;
              if (L === bindLeg) {
                // Advance the binding pool by ONE bracket: cross the boundary tick (net), re-anchor.
                const db: Tuple = pools[pI];
                const zb: Uint256 = zArr[pI];
                let dL: Uint256 = lgL[L];
                const dts: Uint256 = db[3];
                let dsh: Uint256 = dnShift[pI];
                const wTop: Uint256 = db[11];
                const wBot: Uint256 = db[12];
                let inWindow: Uint256 = 0;
                if (wTop > 0) {
                  const wLo: Uint256 = wTop <= wBot ? wTop : wBot;
                  const wHi: Uint256 = wTop <= wBot ? wBot : wTop;
                  if (dsh >= wLo) { if (dsh <= wHi) { inWindow = 1; } }
                }
                let dnet: Uint256 = 0;
                if (inWindow === 1) {
                  const nStart: Uint256 = db[14];
                  const nEnd: Uint256 = nStart + db[15];
                  const cc: Uint256 = netCur[pI];
                  if (cc < nEnd) {
                    const row: Tuple = netCache[cc];
                    if (row[0] === dsh) { dnet = row[1]; netCur[pI] = cc + 1; }
                  }
                } else {
                  const darg: Uint256 = tickArg(dsh, OFFSET);
                  if (db[0] === 2) { dnet = IStateViewFull.at(db[8]).getTickLiquidity(db[9], darg)[1]; }
                  else { dnet = IUniswapV3PoolFull.at(db[1]).ticks(darg)[1]; }
                }
                const dneg: Uint256 = dnet >= HALF128 ? 1 : 0;
                if (zb === 1) {
                  if (dneg === 1) { dL = dL + (MOD128 - dnet); } else { dL = dL >= dnet ? dL - dnet : 0; }
                  dsh = dsh - dts;
                } else {
                  if (dneg === 1) { const dm: Uint256 = MOD128 - dnet; dL = dL >= dm ? dL - dm : 0; } else { dL = dL + dnet; }
                  dsh = dsh + dts;
                }
                dnNear[pI] = lgFR[L];
                dnL[pI] = dL;
                dnShift[pI] = dsh;
                brFar[pI] = 0; // crossed fully ⇒ next bracket re-derives its far
                dnSteps[pI] = dnSteps[pI] + 1;
                if (dnSteps[pI] >= PER_POOL) { dnOn[pI] = 0; }
                const extB: Uint256 = db[13];
                if (dL === 0) { if (extB > 0) {
                  let pastExt: Uint256 = 0;
                  if (zb === 1) { if (dsh < extB) { pastExt = 1; } }
                  else { if (dsh > extB) { pastExt = 1; } }
                  if (pastExt === 1) { dnOn[pI] = 0; }
                } }
              } else {
                // Partial leg: near → lgNF[L] (interior, no cross), keep the bracket far fixed.
                // V2 leg pool stores near as out/in directly (no real-sqrt grid, no brFar latch).
                if (pools[pI][6] === 1) {
                  dnNear[pI] = lgNF[L];
                } else {
                  dnNear[pI] = toOutIn(lgNF[L], zArr[pI]);
                  if (brFar[pI] === 0) { brFar[pI] = lgFR[L]; }
                }
              }
            }
          }
          rinp[bestRoute] = rinp[bestRoute] + rtake;
          cum = cum + rtake;
        } else {
          if (bestKind === 1) {
            // ── sampled-segment slice (Curve / LB / DODO): a fixed capacity slice at a fixed
            // post-fee price. Consume segs[segCur], clamp to the remaining global budget, and
            // accumulate the take into the per-venue Σ keyed by segKind (1 Curve → cinp/cven,
            // 2 LB → linp/lven, 3 DODO → dinp/dven), stamping the venue address from the row. The
            // curve math is OFF-CHAIN — this is a pure data-driven slice; the awarded Σ executes
            // below via the engine swap. Advance the cursor past this segment.
            const sg: Tuple = segs[segCur];
            const sIdx: Uint256 = sg[0];
            const sCap: Uint256 = sg[1];
            const sKind: Uint256 = sg[4];
            const sVenue: Address = sg[5];
            let stake: Uint256 = sCap;
            if (cum + sCap >= amountIn) { stake = amountIn - cum; }
            if (sKind === 1) {
              cinp[sIdx] = cinp[sIdx] + stake;
              cven[sIdx] = sVenue;
            } else {
              if (sKind === 2) {
                linp[sIdx] = linp[sIdx] + stake;
                lven[sIdx] = sVenue;
              } else {
                dinp[sIdx] = dinp[sIdx] + stake;
                dven[sIdx] = sVenue;
              }
            }
            cum = cum + stake;
            segCur = segCur + 1;
          }
        }
      }
    }
  }

  // ── COMPUTE-THEN-PULL + execution ──
  if (cum > 0) {
    token.transferFrom(caller, address.self, cum);
  }
  // Direct pools: universe indices [0, directCount). Direction per pd[7].
  for (let p = 0; p < pools.length; p = p + 1) {
    if (p < directCount) {
      const amt: Uint256 = inp[p];
      if (amt > 0) {
        const dp: Tuple = pools[p];
        const isV2: Uint256 = dp[6];
        const pType: Uint256 = dp[0];
        const pz: Uint256 = dp[7];
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
            const cc0: Address = pz === 1 ? tokenIn : tokenOut;
            const cc1: Address = pz === 1 ? tokenOut : tokenIn;
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
            const k0: Address = pz === 1 ? tokenIn : tokenOut;
            const k1: Address = pz === 1 ? tokenOut : tokenIn;
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
  }
  // Routes: chain-order leg execution reading the REALIZED intermediate balance between legs.
  // N-hop, ANY leg-pool type: walk the route's legCount legs in order. Leg L's INPUT token is
  // tokenIn (L==0) else the previous intermediate (rt[3*L]); its OUTPUT token is tokenOut (final
  // leg) else this leg's intermediate (rt[3+3L]). Leg 0 swaps the route's COMPUTED tokenIn shares
  // (inp[a]); every later leg feeds the REALIZED input-token balance, distributed proportional to
  // inp[] across the leg's pools (the last funded pool takes the remainder to absorb multi-pool-leg
  // dust). Each leg pool is dispatched by type (pd[0]/pd[6]) — swapV3 for V3, swap(poolType:0) for
  // V2, swap(poolType:2) for V4 with the leg PoolKey — MIRRORING the direct-pool execution block.
  // 2-hop and 3-hop are the same loop.
  for (let r = 0; r < routing.length; r = r + 1) {
    const ramt: Uint256 = rinp[r];
    if (ramt > 0) {
      const rt: Tuple = routing[r];
      const legCount: Uint256 = rt[0];
      for (let L = 0; L < legCount; L = L + 1) {
        const baseL: Uint256 = rt[1 + 3 * L];
        const eL: Uint256 = baseL + rt[2 + 3 * L];
        // leg input token: tokenIn for leg0, else the previous leg's intermediate (rt[3*L]).
        let legIn: Address = tokenIn;
        if (L > 0) { legIn = rt[3 * L]; }
        // leg output token: this leg's intermediate (rt[3+3L]) unless this is the final leg.
        let legOut: Address = tokenOut;
        if (L + 1 < legCount) { legOut = rt[3 + 3 * L]; }
        if (L === 0) {
          // leg0: split the route's computed tokenIn share across its pools (tokenIn → legOut).
          for (let a = baseL; a < eL; a = a + 1) {
            const a0: Uint256 = inp[a];
            if (a0 > 0) {
              const lp: Tuple = pools[a];
              const lIsV2: Uint256 = lp[6];
              const lType: Uint256 = lp[0];
              const lz: Uint256 = lp[7]; // leg pool's inIsToken0 (legIn-is-currency0 when 1)
              if (lIsV2 === 1) {
                const c0: Address = lz === 1 ? legIn : legOut;
                const c1: Address = lz === 1 ? legOut : legIn;
                router.swap({
                  poolType: 0, pool: lp[1],
                  poolKey: { currency0: c0, currency1: c1, fee: 0, tickSpacing: 0, hooks: 0 },
                  tokenIn: legIn, tokenOut: legOut, amountSpecified: Math.neg(a0),
                  sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
                });
              } else {
                if (lType === 2) {
                  const k0: Address = lz === 1 ? legIn : legOut;
                  const k1: Address = lz === 1 ? legOut : legIn;
                  router.swap({
                    poolType: 2, pool: lp[1],
                    poolKey: { currency0: k0, currency1: k1, fee: lp[2], tickSpacing: lp[3], hooks: lp[4] },
                    tokenIn: legIn, tokenOut: legOut, amountSpecified: Math.neg(a0),
                    sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
                  });
                } else {
                  router.swapV3(lp[1], legIn, legOut, a0, 0, address.self, address.self);
                }
              }
            }
          }
        } else {
          // leg L>0: feed the REALIZED input-token balance across the leg's pools (legIn → legOut).
          const inBal: Uint256 = IERC20.at(legIn).balanceOf(address.self);
          if (inBal > 0) {
            let lTotal: Uint256 = 0;
            for (let b = baseL; b < eL; b = b + 1) { lTotal = lTotal + inp[b]; }
            if (lTotal > 0) {
              let spent: Uint256 = 0;
              let lastIdx: Uint256 = baseL;
              for (let b = baseL; b < eL; b = b + 1) {
                if (inp[b] > 0) { lastIdx = b; }
              }
              for (let b = baseL; b < eL; b = b + 1) {
                const w: Uint256 = inp[b];
                if (w > 0) {
                  let share: Uint256 = Math.mulDiv(inBal, w, lTotal);
                  if (b === lastIdx) { share = inBal - spent; }
                  if (share > 0) {
                    const lp: Tuple = pools[b];
                    const lIsV2: Uint256 = lp[6];
                    const lType: Uint256 = lp[0];
                    const lz: Uint256 = lp[7];
                    if (lIsV2 === 1) {
                      const c0: Address = lz === 1 ? legIn : legOut;
                      const c1: Address = lz === 1 ? legOut : legIn;
                      router.swap({
                        poolType: 0, pool: lp[1],
                        poolKey: { currency0: c0, currency1: c1, fee: 0, tickSpacing: 0, hooks: 0 },
                        tokenIn: legIn, tokenOut: legOut, amountSpecified: Math.neg(share),
                        sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
                      });
                    } else {
                      if (lType === 2) {
                        const k0: Address = lz === 1 ? legIn : legOut;
                        const k1: Address = lz === 1 ? legOut : legIn;
                        router.swap({
                          poolType: 2, pool: lp[1],
                          poolKey: { currency0: k0, currency1: k1, fee: lp[2], tickSpacing: lp[3], hooks: lp[4] },
                          tokenIn: legIn, tokenOut: legOut, amountSpecified: Math.neg(share),
                          sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
                        });
                      } else {
                        router.swapV3(lp[1], legIn, legOut, share, 0, address.self, address.self);
                      }
                    }
                    spent = spent + share;
                  }
                }
              }
            } else {
              router.swapV3(pools[baseL][1], legIn, legOut, inBal, 0, address.self, address.self);
            }
          }
        }
      }
    }
  }
  // ── Sampled-segment venue execution (Curve / LB / DODO) ──
  // Each engaged venue executes its merged Σ share via ONE atomic engine swap. The curve math is
  // OFF-CHAIN, so the SwapParams carry NO curve data — the engine resolves everything on-chain:
  // _swapCurve iterates coins() against tokenIn/tokenOut for the int128 i/j; _swapTraderJoeLB
  // resolves swapForY from getTokenX(); _swapDODOV2 resolves base/quote from _BASE_TOKEN_().
  // amountSpecified is NEGATIVE (the unified-swap exact-in convention; each _swapX takes abs()).
  // payer == address.self because compute-then-pull already transferred `cum` (incl. every venue
  // share) above, so each _swapX pulls from this contract and forwards the out back here
  // (recipient). The realized out is wei-exact for the share (one atomic exchange / pair.swap /
  // sellBase|sellQuote); the SPLIT equalizes post-fee marginals on the sampled grid (exact-on-grid
  // for Curve/DODO, EXACT for LB). The poolKey is unused for these poolTypes (V4 only) — zeroed to
  // match the V2-path SwapParams shape. One loop per kind over the segment-stream-sized accumulator.

  // Curve StableSwap → poolType 3 (SwapPoolType.Curve) → _swapCurve → exchange(i, j, dx, 0).
  for (let c = 0; c < segs.length; c = c + 1) {
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
  // Trader Joe LB → poolType 6 (SwapPoolType.TraderJoeLB) → _swapTraderJoeLB → pair.swap(swapForY, to).
  for (let l = 0; l < segs.length; l = l + 1) {
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
  // DODO V2 PMM → poolType 5 (SwapPoolType.DODOV2) → _swapDODOV2 → sellBase|sellQuote(to).
  for (let d = 0; d < segs.length; d = d + 1) {
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
