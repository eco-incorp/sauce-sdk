import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3PoolFull } from "./IUniswapV3PoolFull.json";
import { IStateViewFull } from "./IStateViewFull.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";

// EcoSwap on-chain solver — K-WAY-LAZY price-ordered merge (the canonical solver).
//
// One price-ordered merge over two candidate streams splits ONE swap across the engaged
// AMM pools (Uniswap V2/V3/V4) so the POST-FEE MARGINAL price equalizes across every pool
// that receives input:
//   - the off-chain-sorted prepared brackets[] (a flat cursor `bc`; the CACHE),
//   - each pool's `dn` frontier (its live deeper region, walked run-until-filled).
// Each step picks the highest fee-adjusted out/in head among {brackets[bc], all active
// dn[]}, consumes its segment into inp[pool]/cum, and advances ONLY that stream. The result
// is the optimal equalized split: exact (global price order), lazy (only reconstructs as cum
// needs), and bit-for-bit with the neutral optimal oracle (a continuous from-live-spot
// water-fill) — see recipes/test/ecoswap.optimal.ts + ecoswap.kway.reference.ts.
//
// ONE WALK MODEL (drift re-anchoring, both directions symmetric):
//   - NO drift: consume the prepared cache from the window top + the prepare-time-anchored
//     dn frontier seed below it (the contiguous deeper walk).
//   - ANY drift (UP against the swap, or DOWN with it): the spot-anchored prepared brackets
//     are stale (they price a grid the pool's live price no longer sits on), so the merge
//     SKIPS the whole cache for that pool and RE-ANCHORS its dn frontier to the LIVE read —
//     live tick / sqrt / active L — and walks ONE continuous tick-lattice grid from the true
//     live spot. That single from-live-spot walk is byte-identical to the optimal oracle's
//     v3Segments (which never clamps), so the split is wei-exact for drift in EITHER direction
//     and for both swap directions, cap-binding or not. (There is no separate `up` frontier:
//     an earlier drift-UP clamp-and-splice — walk down, clamp the final segment to the tick-
//     aligned window top, hand off to brackets anchored at a different sqrt — spliced two grids
//     that don't share a boundary and mis-priced the handoff heads; re-anchoring removes it.)
//
// prepare.ts is a GAS-OPTIMIZATION CACHE, not a correctness dependency: the solver is exact
// from LIVE DATA ALONE (run-until-filled past any prepared window, even fully out of range);
// a quote runs with an empty cache (brackets:[]). The cache only saves the on-chain tick walk
// for the in-window region.
//
// COMPUTE-THEN-PULL: the merge is read-only (slot0 / getReserves / ticks / getTickLiquidity
// staticcalls only), so we first compute exactly how much tokenIn the swaps will consume
// (cum), then transferFrom the caller EXACTLY that — no upfront over-pull, no refund round-
// trip. The only leftover possible is the limit-price edge (a binding priceLimit makes a V3
// swap consume less than its assigned input); one guarded terminal refund returns it.
//
// Inputs (precomputed off-chain in prepare.ts; pool tuple built by index.ts buildPoolTuple):
//   pools[i]    = [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0, stateView, poolId,
//                  adaptiveStartShifted, adaptiveNearReal, adaptiveStartL, adaptiveStepRatio,
//                  topNearReal, bracketCount]
//                 [10..13] are the dn frontier seeds. V3/V4: [10]=next un-walked boundary
//                 (shifted), [11]=near REAL sqrt, [12]=active L, [13]=tick step ratio. V2:
//                 [10]=1 (walk flag), [11]=deepest prepared far (out/in); L is read LIVE (√k).
//                 [14]=topNearReal (window-top seed: V3/V4 REAL sqrt at the top bracket near =
//                 the prepare-time spot, used as the drift gate; V2 OUT/IN spot). [15]=bracketCount.
//   routes[r]   = [inter, h1Type,h1Pool,h1Fee,h1TS,h1Hooks, h2Type,h2Pool,h2Fee,h2TS,h2Hooks]
//   brackets[b] = [kind, refIdx, sqrtNear, sqrtFar, liquidity, capacity, sqrtAdjNear, sqrtAdjFar]
//                 kind: 0=V3 direct, 1=V2 direct, 2=route ; sorted DESC by sqrtAdjNear.
// All sqrt values are unified out/in Q96. Routes (kind===2) are STATIC by design (no live
// re-price) — out of the per-wei exactness gate.


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

// Fee-adjusted out/in head price, for the cross-pool max comparison. MUST mirror the
// off-chain feeAdjust used to build brackets[].sqrtAdjNear EXACTLY (prepare.ts
// feeAdjust + ecoswap.math.ts feeAdjust): sqrt(1-fee) scaling, NOT a linear (1-fee)
// factor. Math.sqrt is the engine integer sqrt == TS isqrt bit-for-bit, so
// sf = sqrt((FEE_DENOM - feePpm) * FEE_DENOM) and adj = mulDiv(oi, sf, FEE_DENOM)
// reproduce sqrtAdjNear to the wei (the lens encodes the same at feeAdj()).
function feeAdj(oi: Uint256, feePpm: Uint256, FEE_DENOM: Uint256): Uint256 {
  const sf: Uint256 = Math.sqrt((FEE_DENOM - feePpm) * FEE_DENOM);
  return Math.mulDiv(oi, sf, FEE_DENOM);
}

function main(
  tokenIn: Address, tokenOut: Address, amountIn: Uint256, caller: Address,
  zeroForOne: Uint256, priceLimit: Uint256,
  pools: Tuple, routes: Tuple, brackets: Tuple
): Uint256 {
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
  // Run-until-filled budget (B2). The merge terminates correctly on cum==amountIn, on the
  // price-limit / all-streams-dead early-out, and on stale-bracket skips. Two bounds:
  //   • PER_POOL — ONE SHARED per-pool step budget (dnSteps[] below) counted on EVERY consumed
  //     segment of that pool's single from-live-spot walk: the prepared window-bracket consume AND
  //     the dn-frontier step. This is the true run-until-filled governor: a pool walks its live
  //     tick lattice (window→dn at no drift, or a single re-anchored dn walk on ANY drift —
  //     contiguous from the live spot) until it fills, exhausts, or hits PER_POOL. It MUST equal
  //     the optimal oracle's MAX_V3_STEPS (ecoswap.optimal.ts) and the reference's PER_POOL
  //     EXACTLY — and because the SHARED counter bounds window+dn by the SAME PER_POOL the
  //     oracle's SINGLE from-live-spot MAX_V3_STEPS loop uses, a drifted pool reaches EXACTLY the
  //     oracle's reach at the cap. solver==oracle to the wei EVEN WHEN THE CAP BINDS, for every
  //     drift direction and cache depth.
  //   • SAFETY — the outer merge-loop bound = brackets.length + pools.length*PER_POOL*2
  //     (×2 keeps generous slack for dn scan churn per pool). It dominates the SUM of all
  //     per-pool reaches, so once every stream has spent its shared PER_POOL budget (or
  //     filled/exhausted) the outer loop is guaranteed to have terminated; it never itself
  //     truncates a fill the per-pool caps would have completed.
  // 2048 ts=10 steps ≈ a 7.75× price excursion per pool — far past any realistic out-of-range
  // case — while a single pool walking the full PER_POOL budget costs ≈1.15e9 gas on anvil
  // (measured: per-step ≈419K shallow, ≈640K at depth), comfortably under the 1.9e9 cook
  // ceiling. Larger budgets (≥3000) hit the ceiling, so 2048 is the largest budget at which a
  // single pool can reach the cap and still cook. (The old fixed 1024-style cap truncated
  // large/fine-grid run-until-filled trades; this per-pool budget is trade-size-INDEPENDENT.)
  const PER_POOL: Uint256 = 2048;
  const SAFETY: Uint256 = brackets.length + pools.length * PER_POOL * 2;

  // Per-pool accumulators + live caches + the two live frontier states.
  let inp: Tuple = new Array(pools.length);
  let curArr: Tuple = new Array(pools.length); // live out/in price
  let lArr: Tuple = new Array(pools.length); // V2 live √k
  let dnOn: Tuple = new Array(pools.length); // deeper frontier active flag
  let dnNear: Tuple = new Array(pools.length); // dn: real sqrt (V3/V4) or out/in (V2) near edge
  let dnL: Tuple = new Array(pools.length); // dn: active L
  let dnShift: Tuple = new Array(pools.length); // dn: next boundary (shifted)
  let dnSteps: Tuple = new Array(pools.length); // SHARED per-pool step budget (up + window + dn)
  let rinp: Tuple = new Array(routes.length);

  let cum: Uint256 = 0;

  // ── SETUP: read live state once per pool, seed both frontiers ──
  for (let i = 0; i < pools.length; i = i + 1) {
    const pd: Tuple = pools[i];
    const isV2: Uint256 = pd[6];
    const pType: Uint256 = pd[0];
    let cl: Uint256 = 0;
    let ll: Uint256 = 0;
    if (isV2 === 1) {
      const r0: Uint256 = IUniswapV2Pair.at(pd[1]).getReserves()[0];
      const r1: Uint256 = IUniswapV2Pair.at(pd[1]).getReserves()[1];
      const inIsToken0: Uint256 = pd[7];
      const resIn: Uint256 = inIsToken0 === 1 ? r0 : r1;
      const resOut: Uint256 = inIsToken0 === 1 ? r1 : r0;
      ll = Math.sqrt(resIn * resOut);
      cl = Math.sqrt(Math.mulDiv(resOut, Q192, resIn));
    } else {
      if (pType === 2) {
        cl = IStateViewFull.at(pd[8]).getSlot0(pd[9])[0];
        if (zeroForOne === 0) { cl = Q192 / cl; }
      } else {
        cl = IUniswapV3PoolFull.at(pd[1]).slot0()[0];
        if (zeroForOne === 0) { cl = Q192 / cl; }
      }
    }
    curArr[i] = cl;
    lArr[i] = ll;

    // dn (deeper) frontier seed: V3/V4 [10]=next boundary,[11]=near real,[12]=L; V2 [10]=1,[11]=far out/in
    const dnFlag: Uint256 = pd[10] > 0 ? 1 : 0;
    dnOn[i] = dnFlag;
    dnNear[i] = pd[11];
    dnL[i] = pd[12];
    dnShift[i] = pd[10];

    dnSteps[i] = 0;
    if (isV2 === 0) {
      // V3/V4: window top is a REAL sqrt (pd[14]). ANY live drift — UP (against the swap)
      // or DOWN (with the swap) — RE-ANCHORS the SINGLE dn frontier to the LIVE read, so the
      // whole walk is ONE continuous tick-lattice grid from the true live spot (== the optimal
      // oracle's v3Segments, which never clamps). This makes drift-UP byte-identical to the
      // proven-exact drift-DOWN path: the old up-frontier clamp-and-splice (walk the live grid
      // down, CLAMP the final segment to the tick-aligned window top, hand off to the prepared
      // window brackets anchored at a DIFFERENT sqrt) spliced two grids that don't share a
      // boundary → mis-priced handoff heads → under-fill (oneForZero cap-binding) / mis-routed
      // merge ties (equal-fee multi-pool). Re-anchoring eliminates the splice entirely. The
      // merge SKIPS this pool's prepared brackets on ANY drift (cur != window top; the stale-
      // skip gate), so the re-anchored live frontier and the cache never double-count. No drift
      // (cl == topNearOI): neither branch fires, the prepared cache + prepare-time dn seed run
      // unchanged ⇒ continuity (0 misallocation at 0% drift).
      const topNearReal: Uint256 = pd[14];
      if (topNearReal > 0) {
        const topNearOI: Uint256 = toOutIn(topNearReal, zeroForOne);
        if (cl !== topNearOI) {
          let liveTickD: Uint256 = 0;
          let liveLD: Uint256 = 0;
          let srRealD: Uint256 = 0;
          if (pType === 2) {
            srRealD = IStateViewFull.at(pd[8]).getSlot0(pd[9])[0];
            liveTickD = IStateViewFull.at(pd[8]).getSlot0(pd[9])[1];
            liveLD = IStateViewFull.at(pd[8]).getLiquidity(pd[9]);
          } else {
            srRealD = IUniswapV3PoolFull.at(pd[1]).slot0()[0];
            liveTickD = IUniswapV3PoolFull.at(pd[1]).slot0()[1];
            liveLD = IUniswapV3PoolFull.at(pd[1]).liquidity();
          }
          const tsD: Uint256 = pd[3];
          const baseD: Uint256 = tickShiftedBase(liveTickD, OFFSET, tsD);
          let shD: Uint256 = baseD;
          if (zeroForOne === 0) { shD = baseD + tsD; }
          dnOn[i] = 1;
          dnNear[i] = srRealD; // real sqrt at the LIVE price (dn stores real for V3/V4)
          dnL[i] = liveLD;
          dnShift[i] = shD;
        }
      }
    } else {
      // V2: window top is an OUT/IN sqrt (pd[14] = the shallowest kept V2 bracket's
      // sqrtNear = prepare-time V2 spot out/in). V2 is constant-L over the WHOLE range
      // (one geometric grid), so ANY live drift — UP or DOWN — RE-ANCHORS the single dn
      // frontier to the LIVE out/in spot (cl), consuming ONE continuous V2 stream from the
      // true live price (matching the oracle's single from-live-spot grid v2Segments, NO
      // clamp). This is symmetric to the V3/V4 re-anchor above. The merge SKIPS this pool's
      // prepared brackets whenever cur != topV2OI (any drift; see the stale-skip gate), so
      // the cache and the live walk never double-count. No drift (cl == topV2OI): neither
      // branch fires, the prepared cache + prepare-time dn seed run unchanged ⇒ continuity
      // (0 misallocation at 0% drift).
      const topV2OI: Uint256 = pd[14];
      if (topV2OI > 0) {
        if (cl !== topV2OI) {
          dnOn[i] = 1;
          dnNear[i] = cl; // V2 dn stores OUT/IN directly; re-anchor to the live spot
          dnL[i] = ll; // unused by the V2 dn step (it reads lArr) but kept consistent
          dnShift[i] = 0; // unused for V2
        }
      }
    }
  }

  // ── MERGE: each step, pick the best-priced candidate head and advance it ──
  let bc: Uint256 = 0;
  for (let s = 0; s < SAFETY; s = s + 1) {
    if (cum < amountIn) {
      // STALE-BRACKET SKIP (re-anchor gate): if the cursor bracket belongs to a pool whose
      // live price has drifted away from its prepared window top, the bracket is stale — the
      // live dn frontier (re-seeded from the live price in SETUP) covers that region. Skip it
      // (advance bc, consume nothing) so the cache and the live walk never double-count.
      // The drifted pool re-anchors its SINGLE walk to the live spot for BOTH drift directions
      // (UP and DOWN), so on ANY drift the whole prepare-time-anchored cache is on a different
      // grid and must be skipped — the re-anchored dn frontier covers the live grid alone:
      //   - V3/V4 (window top sd[14] is a REAL sqrt → toOutIn): stale on ANY drift (cur != top).
      //   - V2 (window top sd[14] is already an OUT/IN sqrt → compared directly): stale on ANY
      //     drift (cur != top).
      // Route brackets are never skipped.
      //
      // BUDGET SKIP (D2): a prepared window bracket is one step of its pool's from-spot walk,
      // so it must count against the SAME SHARED per-pool budget (dnSteps) as the dn frontier —
      // window + dn together are bounded by ONE PER_POOL == the oracle's single MAX_V3_STEPS
      // total-from-live-spot loop. So a cursor bracket whose pool has ALREADY spent its PER_POOL
      // budget is skip-advanced (consume nothing), exactly as the dn frontier deactivates at the
      // cap.
      let staleSkip: Uint256 = 0;
      if (bc < brackets.length) {
        const sb: Tuple = brackets[bc];
        if (sb[0] !== 2) {
          const spidx: Uint256 = sb[1];
          const sd: Tuple = pools[spidx];
          const sTop: Uint256 = sd[14];
          if (dnSteps[spidx] >= PER_POOL) { staleSkip = 1; }
          if (sTop > 0) {
            if (sd[6] === 0) {
              // V3/V4: REAL sqrt at [14] → out/in; stale on ANY drift (re-anchored single grid).
              const sTopOI: Uint256 = toOutIn(sTop, zeroForOne);
              if (curArr[spidx] !== sTopOI) { staleSkip = 1; }
            } else {
              // V2: OUT/IN directly; stale on ANY drift (re-anchored single grid).
              if (curArr[spidx] !== sTop) { staleSkip = 1; }
            }
          }
        }
      }
      if (staleSkip === 1) {
        bc = bc + 1;
      } else {
      // 1. find the highest fee-adjusted head among {prepared cursor, dn[*]}
      let bestKind: Uint256 = 0; // 0=none 1=prepared 3=dn
      let bestPool: Uint256 = 0;
      let bestPrice: Uint256 = 0;
      if (bc < brackets.length) {
        const bb: Tuple = brackets[bc];
        // Prepared-bracket competition key (B1): the bracket is integrated at
        // hi=min(cur,near), so its TRUE head price is feeAdj(min(cur,near)) — NOT the
        // static spot sqrtAdjNear (bb[6]). When cur has drifted below near the bracket
        // truly enters at the lower live price, so it must compete at that price (else it
        // wins the scan too early and is consumed ahead of pools whose head is between
        // feeAdj(cur) and feeAdj(near)). Routes (kind===2) have no live re-price → bb[6].
        let bp: Uint256 = bb[6];
        if (bb[0] !== 2) {
          const bpidx: Uint256 = bb[1];
          const bpd: Tuple = pools[bpidx];
          const bcur: Uint256 = curArr[bpidx];
          const bnear: Uint256 = bb[2];
          const bhiOI: Uint256 = bcur < bnear ? bcur : bnear;
          bp = feeAdj(bhiOI, bpd[5], FEE_DENOM);
        }
        if (bp > bestPrice) { bestPrice = bp; bestKind = 1; }
      }
      for (let j = 0; j < pools.length; j = j + 1) {
        const jd: Tuple = pools[j];
        const jfee: Uint256 = jd[5];
        if (dnOn[j] === 1) {
          const doi: Uint256 = jd[6] === 1 ? dnNear[j] : toOutIn(dnNear[j], zeroForOne);
          const dadj: Uint256 = feeAdj(doi, jfee, FEE_DENOM);
          if (dadj > bestPrice) { bestPrice = dadj; bestKind = 3; bestPool = j; }
        }
      }

      // Early-out: no active stream produced a head with price > 0 (all streams
      // exhausted). SauceScript has no break — terminate the run-until-filled loop by
      // jumping the counter to the bound. Without this the loop spins the full SAFETY
      // iterations doing nothing once all streams die.
      if (bestKind === 0) { s = SAFETY; }

      // 2. consume + advance the winner
      if (bestKind === 1) {
        // prepared bracket: integrate hi=min(cur,near) → far, live-clamped.
        const bb: Tuple = brackets[bc];
        const kind: Uint256 = bb[0];
        if (kind === 2) {
          const rdx: Uint256 = bb[1];
          const cap: Uint256 = bb[5];
          let rtake: Uint256 = cap;
          if (cum + cap >= amountIn) { rtake = amountIn - cum; }
          rinp[rdx] = rinp[rdx] + rtake;
          cum = cum + rtake;
        } else {
          const pidx: Uint256 = bb[1];
          const near: Uint256 = bb[2];
          const far: Uint256 = bb[3];
          const Lstat: Uint256 = bb[4];
          const dp: Tuple = pools[pidx];
          const feePpm: Uint256 = dp[5];
          const isV2b: Uint256 = dp[6];
          const cur: Uint256 = curArr[pidx];
          const Lb: Uint256 = isV2b === 1 ? lArr[pidx] : Lstat;
          const hi: Uint256 = cur < near ? cur : near;
          if (hi > far) { if (Lb > 0) { if (far > 0) {
            const effIn: Uint256 = Math.mulDiv(Lb, Q96, far) - Math.mulDiv(Lb, Q96, hi);
            if (effIn > 0) {
              const gross: Uint256 = Math.mulDiv(effIn, FEE_DENOM, FEE_DENOM - feePpm);
              let take: Uint256 = gross;
              if (cum + gross >= amountIn) { take = amountIn - cum; }
              inp[pidx] = inp[pidx] + take;
              cum = cum + take;
            }
          } } }
          // BUDGET (D2): a consumed window bracket is one step of this pool's single from-live-
          // spot walk, so it counts against the SAME SHARED per-pool budget (dnSteps) as the dn
          // frontier. At the cap deactivate the dn frontier (the budget-skip gate above skip-
          // advances any remaining window brackets) so window+dn reach EXACTLY PER_POOL.
          dnSteps[pidx] = dnSteps[pidx] + 1;
          if (dnSteps[pidx] >= PER_POOL) { dnOn[pidx] = 0; }
        }
        bc = bc + 1;
      } else {
          if (bestKind === 3) {
            const dd: Tuple = pools[bestPool];
            const dfee: Uint256 = dd[5];
            if (dd[6] === 1) {
              // dn frontier step (V2 constant-L slice)
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
              // SHARED PER_POOL budget (B2): bound the V2 dn slice walk by the SAME per-pool cap
              // the oracle uses (MAX_V2_SLICES == PER_POOL), shared with the window brackets, so
              // window+dn truncate identically at the cap.
              dnSteps[bestPool] = dnSteps[bestPool] + 1;
              if (dnSteps[bestPool] >= PER_POOL) { dnOn[bestPool] = 0; }
            } else {
              // dn frontier step (V3/V4 tick walk)
              let dL: Uint256 = dnL[bestPool];
              // Exhaustion early-out (oracle mirror, ecoswap.optimal.ts:197-200): a step
              // whose ENTRY liquidity is 0 can produce no take. For the (no-interior-gap)
              // pools the solver targets, L drops to 0 only at the extreme initialized
              // tick, so entry dL==0 == "past the extreme tick" — deactivate so the drained
              // pool stops competing in the max-scan (else it spins, starving live streams).
              if (dL === 0) {
                dnOn[bestPool] = 0;
              } else {
              const dts: Uint256 = dd[3];
              const dstep: Uint256 = dd[13];
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
              const darg: Uint256 = tickArg(dsh, OFFSET);
              let dnet: Uint256 = 0;
              if (dd[0] === 2) { dnet = IStateViewFull.at(dd[8]).getTickLiquidity(dd[9], darg)[1]; }
              else { dnet = IUniswapV3PoolFull.at(dd[1]).ticks(darg)[1]; }
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
              if (dlim === 1) { dnOn[bestPool] = 0; }
              // SHARED PER_POOL run-until-filled budget (B2): this dn walk has taken one more step
              // of the pool's single from-live-spot walk (shared with the window brackets).
              // Deactivate dn at the cap so the pool's TOTAL reach (window+dn) is bounded by ONE
              // PER_POOL EXACTLY as the oracle's single MAX_V3_STEPS loop bounds its from-live-spot
              // segment walk — solver==oracle even at the cap, every drift direction.
              dnSteps[bestPool] = dnSteps[bestPool] + 1;
              if (dnSteps[bestPool] >= PER_POOL) { dnOn[bestPool] = 0; }
              }
            }
          }
        }
      } // end else (non-stale step: scan + consume)
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
      if (isV2 === 1) {
        const cc0: Address = zeroForOne === 1 ? tokenIn : tokenOut;
        const cc1: Address = zeroForOne === 1 ? tokenOut : tokenIn;
        router.swap({
          poolType: 0, pool: dp[1],
          poolKey: { currency0: cc0, currency1: cc1, fee: 0, tickSpacing: 0, hooks: 0 },
          tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(amt),
          sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
        });
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
  const leftover: Uint256 = token.balanceOf(address.self);
  if (leftover > 0) {
    token.transfer(caller, leftover);
  }
  const outToken = IERC20.at(tokenOut);
  const outBal: Uint256 = outToken.balanceOf(address.self);
  outToken.transfer(caller, outBal);
  return outBal;
}
