/**
 * EcoSwap K-WAY-LAZY reference (pure TypeScript bigint math, EVM-free).
 *
 * Faithfully mirrors the canonical on-chain K-way solver in `recipes/ecoswap/ecoswap.sauce.ts`:
 * ONE price-ordered merge over two candidate streams — the off-chain-sorted prepared
 * brackets[] (a flat cursor `bc`; the CACHE) and each pool's `dn` deeper frontier. Each step
 * picks the highest fee-adjusted out/in head among {brackets[bc], all active dn[]}, consumes
 * its segment into inp[pool]/cum, and advances ONLY that stream. On ANY live drift a pool
 * re-anchors its SINGLE walk to the live spot (dn frontier from the live tick) and its stale
 * prepared cache is skipped — one continuous from-live-spot grid, symmetric for drift UP and
 * DOWN (== the optimal oracle's v3Segments, which never clamps).
 *
 * It takes the SAME prepared dataset the on-chain solver reads (pools tuple fields via the
 * EcoPool fields, brackets[], the off-chain-only adaptiveNet map for tick walks) plus the
 * modeled LIVE state per pool (live out/in spot, live tick, live L for V3/V4; live reserves
 * for V2). In the deterministic no-drift case the modeled live == prepared spot.
 *
 * The integer math (mulDiv truncation), the int128 sign recovery, stepReal, toOutIn, tickArg
 * and the sqrt fee-adjust are all the shared copies in ./ecoswap.math, so this reference is
 * bit-for-bit with both the on-chain solver and the neutral optimal oracle (ecoswap.optimal).
 */

import { EcoBracketKind, type EcoSwapPrepared } from "../shared/types";
import {
  Q96,
  FEE_DENOM,
  OFFSET,
  mulDiv,
  stepReal,
  toOutIn,
  HALF128,
  MOD128,
  tickArg,
  sqrtOneMinusFeeScaled,
  V2_STEP_BPS,
  V2_STEP_DEN,
} from "./ecoswap.math";

/** Modeled LIVE state for one pool (what the on-chain SETUP reads). */
export interface KwayLivePool {
  /** Live out/in spot sqrt (curArr). V3/V4: toOutIn(liveRealSqrt); V2: sqrt(resOut*Q192/resIn). */
  curOI: bigint;
  // V3/V4 live state (for the dn re-anchor seed + read parity):
  liveRealSqrt?: bigint;
  liveTick?: number;
  liveL?: bigint;
  // V2 live state:
  liveV2L?: bigint; // sqrt(reserveIn*reserveOut)
}

export interface KwayReferenceResult {
  perPoolInput: bigint[];
  perRouteInput: bigint[];
  totalInput: bigint;
  /**
   * The fee-adjusted out/in marginal price at the cut — the fee-adjusted FAR edge of the
   * last segment the merge consumed (the deepest reached). Diagnostic only: the on-chain
   * solver carries no cut, but a price-ordered merge's last consumed far edge IS the common
   * marginal every engaged pool equalizes to. Used by the prod-mirror equalization asserts.
   */
  cutSqrtAdj: bigint;
}

/** fee-adjusted out/in head price (sqrt(1-fee) scaling) — matches the solver feeAdj. */
function feeAdj(oi: bigint, feePpm: number): bigint {
  return (oi * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}

/**
 * Per-pool frontier walk budget (B2) — MUST match the on-chain solver's PER_POOL
 * (ecoswap.sauce.ts) AND the optimal oracle's MAX_V3_STEPS (ecoswap.optimal.ts)
 * EXACTLY, so the reference and the oracle agree to the wei EVEN WHEN THE CAP BINDS. ONE
 * SHARED per-pool budget (dnSteps[]) is counted on EVERY consumed segment of that pool's
 * single from-live-spot walk — the prepared window-bracket consume AND the dn-frontier step.
 * So window+dn from the live spot are bounded by ONE PER_POOL == the oracle's single
 * MAX_V3_STEPS loop, and a drifted pool reaches EXACTLY the oracle's reach at the cap. The
 * outer merge bound is brackets.length + pools.length*PER_POOL*2 (generous slack for dn scan
 * churn per pool), which dominates the SUM of per-pool reaches so it never itself truncates a
 * fill the per-pool caps would complete. See the on-chain solver for the gas-budget
 * justification of 2048.
 */
const PER_POOL = 2048;

/**
 * K-way reference. `live[i]` is the modeled live state for pools[i]; default (omitted)
 * uses the prepared spot (no drift): V3/V4 curOI = toOutIn(topNearReal), V2 curOI =
 * topNearReal (out/in). `priceLimit` is the swap's real-sqrt price limit (dn guard).
 */
export function kwayReference(
  prepared: EcoSwapPrepared,
  amountIn: bigint,
  live?: (KwayLivePool | undefined)[],
): KwayReferenceResult {
  const { pools, routes, brackets } = prepared;
  const zeroForOne = prepared.zeroForOne;
  const priceLimit = prepared.priceLimit;
  // Run-until-filled bound (B2): dominate the oracle's total reach so the cap can never
  // truncate a trade the oracle fully fills (the old fixed 1024 capped large/fine-grid runs).
  const SAFETY = brackets.length + pools.length * PER_POOL * 2;
  const perPoolInput: bigint[] = new Array(pools.length).fill(0n);
  const perRouteInput: bigint[] = new Array(routes.length).fill(0n);

  // ── SETUP ──
  const curArr: bigint[] = new Array(pools.length).fill(0n);
  const lArr: bigint[] = new Array(pools.length).fill(0n);
  const dnOn: boolean[] = new Array(pools.length).fill(false);
  const dnNear: bigint[] = new Array(pools.length).fill(0n);
  const dnL: bigint[] = new Array(pools.length).fill(0n);
  const dnShift: bigint[] = new Array(pools.length).fill(0n);
  const dnSteps: number[] = new Array(pools.length).fill(0); // SHARED per-pool budget (up+window+dn)

  for (let i = 0; i < pools.length; i++) {
    const pd = pools[i];
    const isV2 = pd.isV2;
    const lp = live?.[i];
    let cl = 0n;
    let ll = 0n;
    if (isV2) {
      ll = lp?.liveV2L ?? 0n;
      // default no-drift: live out/in spot = topNearReal (V2 out/in spot)
      cl = lp?.curOI ?? pd.topNearReal ?? 0n;
      if (ll === 0n) {
        // derive from the deepest-far seed's implied L is not available; require liveV2L
        // for V2 — the deterministic caller always supplies it.
        ll = 0n;
      }
    } else {
      const topReal = pd.topNearReal ?? 0n;
      cl = lp?.curOI ?? toOutIn(topReal, zeroForOne);
    }
    curArr[i] = cl;
    lArr[i] = ll;

    // dn (deeper) frontier seed
    const aStartShift = pd.adaptiveStartShifted ?? 0n;
    dnOn[i] = aStartShift > 0n;
    dnNear[i] = pd.adaptiveNearReal ?? 0n;
    dnL[i] = pd.adaptiveStartL ?? 0n;
    dnShift[i] = aStartShift;

    // dn re-anchor on ANY drift (UP against the swap, or DOWN with it) — symmetric to the
    // solver SETUP. V3/V4: window top is a REAL sqrt. RE-ANCHOR the SINGLE dn frontier to the
    // LIVE read whenever the live price differs from the window top, so the whole walk is ONE
    // continuous tick-lattice grid from the true live spot (== the optimal oracle's v3Segments,
    // which never clamps). The old up-frontier clamp-and-splice (walk down, clamp the final
    // segment to the tick-aligned window top, hand off to brackets anchored at a different sqrt)
    // spliced two grids that don't share a boundary and mis-priced the handoff heads; re-anchoring
    // makes drift-UP byte-identical to the proven-exact drift-DOWN path. The merge SKIPS this
    // pool's prepared brackets on ANY drift (cur != window top), so the live frontier and the
    // cache never double-count. No drift (cl == topOI): neither branch fires, the prepared cache
    // + prepare-time dn seed run unchanged ⇒ continuity (0 misallocation at 0% drift).
    if (!isV2) {
      const topReal = pd.topNearReal ?? 0n;
      if (topReal > 0n) {
        const topOI = toOutIn(topReal, zeroForOne);
        if (cl !== topOI) {
          const srReal = lp?.liveRealSqrt ?? topReal;
          const liveTick = BigInt(lp?.liveTick ?? 0);
          const liveL = lp?.liveL ?? 0n;
          const ts = BigInt(pd.tickSpacing);
          const base = ((liveTick + OFFSET) / ts) * ts;
          let sh = base;
          if (!zeroForOne) sh = base + ts;
          dnOn[i] = true;
          dnNear[i] = srReal; // real sqrt at the LIVE price (dn stores real for V3/V4)
          dnL[i] = liveL;
          dnShift[i] = sh;
        }
      }
    } else {
      // V2 is constant-L over the whole range (one geometric grid), so ANY live drift — UP
      // or DOWN — RE-ANCHORS the single dn frontier to the LIVE out/in spot (cl), consuming ONE
      // continuous V2 stream matching the oracle's single from-live-spot grid (v2Segments, NO
      // clamp). Symmetric to the V3/V4 re-anchor above. The merge SKIPS this pool's prepared
      // brackets on ANY drift (cur != top), so the cache and live walk never double-count. No
      // drift (cl == topV2OI): neither branch fires, prepared cache + dn seed run unchanged ⇒
      // 0 misallocation.
      const topV2OI = pd.topNearReal ?? 0n;
      if (topV2OI > 0n && cl !== topV2OI) {
        dnOn[i] = true;
        dnNear[i] = cl; // V2 dn stores OUT/IN directly; re-anchor to the live spot
        dnL[i] = ll;
        dnShift[i] = 0n;
        dnSteps[i] = 0;
      }
    }
  }

  // ── MERGE ──
  let cum = 0n;
  let bc = 0;
  // The fee-adjusted out/in marginal at the cut — updated to the fee-adjusted FAR edge of
  // every segment the merge consumes, so after the loop it is the deepest (last) reached
  // marginal. Diagnostic only (the on-chain solver carries no cut value).
  let cutSqrtAdj = 0n;
  for (let s = 0; s < SAFETY; s++) {
    if (cum >= amountIn) break;

    // STALE-BRACKET SKIP (re-anchor gate, mirrors the solver): if the cursor bracket
    // belongs to a pool whose live price drifted away from its prepared window top, the
    // bracket is stale — the re-seeded live dn frontier covers that region. Skip it (advance
    // bc, consume nothing). The drifted pool re-anchors its SINGLE walk to the live spot for
    // BOTH drift directions, so on ANY drift the whole prepare-time-anchored cache is on a
    // different grid and must be skipped:
    //   - V3/V4 (window top REAL sqrt → toOutIn): stale on ANY drift (cur != top).
    //   - V2 (window top already OUT/IN → compared directly): stale on ANY drift (cur != top).
    // Routes never skip.
    //
    // BUDGET SKIP (D2, mirrors the solver): a prepared window bracket is one step of its
    // pool's single from-live-spot walk, so it counts against the SAME SHARED per-pool budget
    // (dnSteps) as the dn frontier — window + dn together are bounded by ONE PER_POOL == the
    // oracle's single MAX_V3_STEPS total-from-live-spot loop. A cursor bracket whose pool has
    // already spent PER_POOL is skip-advanced (consume nothing).
    if (bc < brackets.length) {
      const sb = brackets[bc];
      if (sb.kind !== EcoBracketKind.Route) {
        const sd = pools[sb.refIdx];
        const sTop = sd.topNearReal ?? 0n;
        const overBudget = dnSteps[sb.refIdx] >= PER_POOL;
        const stale =
          sTop > 0n &&
          (sd.isV2 ? curArr[sb.refIdx] !== sTop : curArr[sb.refIdx] !== toOutIn(sTop, zeroForOne));
        if (overBudget || stale) {
          bc++;
          continue;
        }
      }
    }

    let bestKind = 0; // 0=none 1=prepared 3=dn
    let bestPool = 0;
    let bestPrice = 0n;
    if (bc < brackets.length) {
      const bb = brackets[bc];
      // Prepared-bracket competition key (B1): the bracket integrates at hi=min(cur,near),
      // so its TRUE head price is feeAdj(min(cur,near)), NOT the static spot sqrtAdjNear
      // (bb.sqrtAdjNear). Routes have no live re-price. Mirrors the solver's scan key.
      let bp = bb.sqrtAdjNear; // bb[6]
      if (bb.kind !== EcoBracketKind.Route) {
        const bpd = pools[bb.refIdx];
        const bcur = curArr[bb.refIdx];
        const bhiOI = bcur < bb.sqrtNear ? bcur : bb.sqrtNear;
        bp = feeAdj(bhiOI, bpd.feePpm);
      }
      if (bp > bestPrice) {
        bestPrice = bp;
        bestKind = 1;
      }
    }
    for (let j = 0; j < pools.length; j++) {
      const jd = pools[j];
      const jfee = jd.feePpm;
      if (dnOn[j]) {
        const doi = jd.isV2 ? dnNear[j] : toOutIn(dnNear[j], zeroForOne);
        const dadj = feeAdj(doi, jfee);
        if (dadj > bestPrice) {
          bestPrice = dadj;
          bestKind = 3;
          bestPool = j;
        }
      }
    }

    if (bestKind === 0) break;

    if (bestKind === 1) {
      const bb = brackets[bc];
      if (bb.kind === EcoBracketKind.Route) {
        const rdx = bb.refIdx;
        const cap = bb.capacity;
        let rtake = cap;
        if (cum + cap >= amountIn) rtake = amountIn - cum;
        perRouteInput[rdx] += rtake;
        cum += rtake;
        if (rtake > 0n) cutSqrtAdj = bb.sqrtAdjFar;
      } else {
        const pidx = bb.refIdx;
        const near = bb.sqrtNear;
        const far = bb.sqrtFar;
        const dp = pools[pidx];
        const feePpm = dp.feePpm;
        const isV2b = dp.isV2;
        const cur = curArr[pidx];
        const Lb = isV2b ? lArr[pidx] : bb.liquidity;
        const hi = cur < near ? cur : near;
        if (hi > far && Lb > 0n && far > 0n) {
          const effIn = mulDiv(Lb, Q96, far) - mulDiv(Lb, Q96, hi);
          if (effIn > 0n) {
            const gross = mulDiv(effIn, FEE_DENOM, FEE_DENOM - BigInt(feePpm));
            let take = gross;
            if (cum + gross >= amountIn) take = amountIn - cum;
            perPoolInput[pidx] += take;
            cum += take;
            if (take > 0n) cutSqrtAdj = bb.sqrtAdjFar;
          }
        }
        // BUDGET (D2): a consumed window bracket is one step of this pool's single from-live-
        // spot walk, so it counts against the SAME SHARED per-pool budget (dnSteps) as the dn
        // frontier. At the cap deactivate the dn frontier (the budget-skip gate above skip-
        // advances any remaining window brackets) so window+dn reach EXACTLY PER_POOL.
        dnSteps[pidx] += 1;
        if (dnSteps[pidx] >= PER_POOL) {
          dnOn[pidx] = false;
        }
      }
      bc++;
    } else if (bestKind === 3) {
      const dd = pools[bestPool];
      const dfee = dd.feePpm;
      if (dd.isV2) {
        const v2L = lArr[bestPool];
        const v2Near = dnNear[bestPool];
        const v2Far = v2Near - mulDiv(v2Near, V2_STEP_BPS, V2_STEP_DEN);
        if (v2L > 0n && v2Near > v2Far && v2Far > 0n) {
          const v2eff = mulDiv(v2L, Q96, v2Far) - mulDiv(v2L, Q96, v2Near);
          if (v2eff > 0n) {
            const v2g = mulDiv(v2eff, FEE_DENOM, FEE_DENOM - BigInt(dfee));
            let v2t = v2g;
            if (cum + v2g >= amountIn) v2t = amountIn - cum;
            perPoolInput[bestPool] += v2t;
            cum += v2t;
            if (v2t > 0n) cutSqrtAdj = feeAdj(v2Far, dfee);
          }
        }
        dnNear[bestPool] = v2Far;
        if (v2Far <= 0n) dnOn[bestPool] = false;
        // SHARED PER_POOL budget (B2): bound the V2 dn slice walk by the same cap as
        // MAX_V2_SLICES, shared with the window brackets.
        dnSteps[bestPool] += 1;
        if (dnSteps[bestPool] >= PER_POOL) {
          dnOn[bestPool] = false;
        }
      } else {
        let dL = dnL[bestPool];
        if (dL === 0n) {
          dnOn[bestPool] = false;
        } else {
          const dts = BigInt(dd.tickSpacing);
          const dstep = dd.adaptiveStepRatio ?? 0n;
          let dnear = dnNear[bestPool];
          let dsh = dnShift[bestPool];
          const dfarReal = stepReal(dnear, dstep, zeroForOne);
          const dnearOI = toOutIn(dnear, zeroForOne);
          const dfarOI = toOutIn(dfarReal, zeroForOne);
          let dlim = false;
          if (zeroForOne) {
            if (dfarReal <= priceLimit) dlim = true;
          } else {
            if (dfarReal >= priceLimit) dlim = true;
          }
          if (dL > 0n && dnearOI > dfarOI && dfarOI > 0n) {
            const deff = mulDiv(dL, Q96, dfarOI) - mulDiv(dL, Q96, dnearOI);
            if (deff > 0n) {
              const dg = mulDiv(deff, FEE_DENOM, FEE_DENOM - BigInt(dfee));
              let dt = dg;
              if (cum + dg >= amountIn) dt = amountIn - cum;
              perPoolInput[bestPool] += dt;
              cum += dt;
              if (dt > 0n) cutSqrtAdj = feeAdj(dfarOI, dfee);
            }
          }
          const aNet = dd.adaptiveNet ?? new Map<number, bigint>();
          const signedNet = aNet.get(Number(tickArg(dsh))) ?? 0n;
          const raw = signedNet >= 0n ? signedNet : signedNet + MOD128;
          const neg = raw >= HALF128;
          if (zeroForOne) {
            if (neg) dL = dL + (MOD128 - raw);
            else dL = dL >= raw ? dL - raw : 0n;
            dsh -= dts;
          } else {
            if (neg) {
              const dm = MOD128 - raw;
              dL = dL >= dm ? dL - dm : 0n;
            } else dL = dL + raw;
            dsh += dts;
          }
          dnNear[bestPool] = dfarReal;
          dnL[bestPool] = dL;
          dnShift[bestPool] = dsh;
          if (dlim) dnOn[bestPool] = false;
          // SHARED PER_POOL run-until-filled budget (B2): this dn walk is one step of the pool's
          // single from-live-spot walk (shared with the window brackets). Deactivate dn at the
          // cap so the pool's TOTAL reach (window+dn) is bounded by ONE PER_POOL EXACTLY as the
          // oracle's single MAX_V3_STEPS loop — reference==oracle at the cap, every drift direction.
          dnSteps[bestPool] += 1;
          if (dnSteps[bestPool] >= PER_POOL) {
            dnOn[bestPool] = false;
          }
        }
      }
    }
  }

  const totalInput =
    perPoolInput.reduce((a, b) => a + b, 0n) + perRouteInput.reduce((a, b) => a + b, 0n);
  return { perPoolInput, perRouteInput, totalInput, cutSqrtAdj };
}
