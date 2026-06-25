/**
 * EcoSwap reference oracle (pure TypeScript bigint math, EVM-free).
 *
 * Faithfully mirrors the on-chain solver in `dev-tools/recipes/ecoswap/ecoswap.sauce.ts`
 * so an EVM end-to-end test can cross-check on-chain allocations against this.
 *
 * The integer math (mulDiv truncation, isqrt, fee-adjust) is replicated EXACTLY
 * from the sauce script and from prepare.ts; see ./ecoswap.math for the shared
 * copies of those helpers.
 *
 * LIVE-PRICE ASSUMPTION
 * ─────────────────────
 * The on-chain solver re-reads live prices in Phase B (slot0 for V3, getReserves
 * for V2). This reference is for the DETERMINISTIC local test where live state
 * equals the prepared state, so we model:
 *   - V3 pool live `curSqrt` = the out/in `sqrtNear` of that pool's first
 *     (highest-price, i.e. ladder-earliest) bracket.
 *   - V2 pool live liquidity = that bracket's `liquidity`, and live `curSqrt`
 *     likewise = its first bracket's `sqrtNear`.
 * This matches buildV3Brackets/buildV2Brackets where the first bracket's near
 * edge IS the live price the pool was anchored to.
 */

import { EcoBracketKind, type EcoSwapPrepared } from "../shared/types";
import {
  Q96,
  FEE_DENOM,
  isqrt,
  mulDiv,
  stepReal,
  toOutIn,
  HALF128,
  MOD128,
  tickArg,
} from "./ecoswap.math";

export interface EcoSwapReferenceResult {
  cutSqrtAdj: bigint;
  /** Gross tokenIn allocated to pools[i], same indexing as prepared.pools. */
  perPoolInput: bigint[];
  /** Gross tokenIn allocated to routes[i], same indexing as prepared.routes. */
  perRouteInput: bigint[];
  /** Σ perPoolInput + Σ perRouteInput (should be ≤ amountIn). */
  totalInput: bigint;
}

/** sqrt of the on-chain Math.sqrt argument — matches the sauce `Math.sqrt(...)`. */
function sqrtScale(feePpm: bigint): bigint {
  return isqrt((FEE_DENOM - feePpm) * FEE_DENOM);
}

export function ecoSwapReference(prepared: EcoSwapPrepared, amountIn: bigint): EcoSwapReferenceResult {
  // ECO_SOLVER=singlepass selects the single-pass (live-cut) solver; mirror it.
  // ECO_ADAPTIVE=1 additionally mirrors the WS4 streaming tick walk (only meaningful
  // when prepared adaptively — i.e. pools carry adaptiveStartShifted seeds).
  if (process.env.ECO_SOLVER === "singlepass") {
    return singlePassReference(prepared, amountIn, process.env.ECO_ADAPTIVE === "1");
  }
  const { pools, routes, brackets } = prepared;

  // ── Phase A: find the common marginal-price cut ──────────────
  // Mirrors ecoswap.sauce.ts lines 42-81: walk the (pre-sorted DESC) ladder
  // accumulating capacity b[5] until cum+cap >= amountIn.
  let cum = 0n;
  let cutSqrtAdj = 0n;
  let found = false;

  for (let i = 0; i < brackets.length; i++) {
    if (!found) {
      const b = brackets[i];
      const cap = b.capacity;

      if (cum + cap >= amountIn) {
        const need = amountIn - cum;

        if (b.kind === EcoBracketKind.Route) {
          // Route segment: linear interpolation in fee-adjusted sqrt space.
          const an = b.sqrtAdjNear;
          const af = b.sqrtAdjFar;
          if (an > af) {
            cutSqrtAdj = an - mulDiv(an - af, need, cap);
          } else {
            cutSqrtAdj = an;
          }
        } else {
          // Direct bracket: solve the spot price where partial input === need,
          // then fee-adjust. needEff = need * (1 - fee).
          const dp = pools[b.refIdx];
          const feePpm = BigInt(dp.feePpm);
          const L = b.liquidity;
          const needEff = mulDiv(need, FEE_DENOM - feePpm, FEE_DENOM);
          const termNear = mulDiv(L, Q96, b.sqrtNear);
          const termS = termNear + needEff;
          const cutSpot = mulDiv(L, Q96, termS);
          const sf = sqrtScale(feePpm);
          cutSqrtAdj = mulDiv(cutSpot, sf, FEE_DENOM);
        }
        found = true;
      }
      cum = cum + cap;
    }
  }
  // found === false → amountIn exceeds all liquidity → cutSqrtAdj stays 0 (fill all).

  let budget = amountIn;
  const perPoolInput: bigint[] = new Array(pools.length).fill(0n);
  const perRouteInput: bigint[] = new Array(routes.length).fill(0n);

  // ── Phase B (direct pools): integrate live price -> cut, one swap ──
  // Mirrors ecoswap.sauce.ts lines 86-145.
  for (let p = 0; p < pools.length; p++) {
    if (budget > 0n) {
      const dp = pools[p];
      const feePpm = BigInt(dp.feePpm);
      const isV2 = dp.isV2;

      // Live current out/in sqrt + (V2) live liquidity. In the deterministic
      // local test, live == prepared first-bracket of this pool (see header).
      let curSqrt = 0n;
      let liveL = 0n;
      // The pool's first (ladder-earliest, highest-price) direct bracket WITH
      // capacity > 0 is its spot bracket (near edge == the live price it was
      // anchored to). Reverse-drift brackets carry capacity 0 and sort ABOVE it
      // (above spot), so they must be skipped here — in the no-drift model the
      // live price is the spot, not the reverse extent.
      let firstBracket: (typeof brackets)[number] | undefined;
      for (let bi = 0; bi < brackets.length; bi++) {
        const b = brackets[bi];
        if (b.kind !== EcoBracketKind.Route && b.refIdx === p && b.capacity > 0n) {
          firstBracket = b;
          break;
        }
      }
      if (firstBracket) {
        curSqrt = firstBracket.sqrtNear;
        if (isV2) liveL = firstBracket.liquidity;
      }

      // Per-pool target spot where its marginal === cut: target = cut / sqrt(1-fee).
      const sf = sqrtScale(feePpm);
      const targetSpot = sf > 0n ? mulDiv(cutSqrtAdj, FEE_DENOM, sf) : 0n;

      // Integrate this pool's brackets from live price down to target.
      let poolInput = 0n;
      for (let bi = 0; bi < brackets.length; bi++) {
        const b = brackets[bi];
        if (b.kind !== EcoBracketKind.Route && b.refIdx === p) {
          const near = b.sqrtNear;
          const far = b.sqrtFar;
          const Lb = isV2 ? liveL : b.liquidity;
          const hi = curSqrt < near ? curSqrt : near;
          const lo = targetSpot > far ? targetSpot : far;
          if (hi > lo && Lb > 0n && lo > 0n) {
            const effIn = mulDiv(Lb, Q96, lo) - mulDiv(Lb, Q96, hi);
            if (effIn > 0n) {
              poolInput = poolInput + mulDiv(effIn, FEE_DENOM, FEE_DENOM - feePpm);
            }
          }
        }
      }

      if (poolInput > budget) {
        poolInput = budget;
      }

      if (poolInput > 0n) {
        perPoolInput[p] = poolInput;
        budget = budget - poolInput;
      }
    }
  }

  // ── Phase B (routes): whole segments above the cut ──
  // Mirrors ecoswap.sauce.ts lines 148-180.
  for (let r = 0; r < routes.length; r++) {
    if (budget > 0n) {
      let routeInput = 0n;
      for (let bi = 0; bi < brackets.length; bi++) {
        const b = brackets[bi];
        if (b.kind === EcoBracketKind.Route && b.refIdx === r) {
          if (b.sqrtAdjFar >= cutSqrtAdj) {
            routeInput = routeInput + b.capacity;
          }
        }
      }

      if (routeInput > budget) {
        routeInput = budget;
      }

      if (routeInput > 0n) {
        perRouteInput[r] = routeInput;
        budget = budget - routeInput;
      }
    }
  }

  const totalInput =
    perPoolInput.reduce((a, b) => a + b, 0n) + perRouteInput.reduce((a, b) => a + b, 0n);

  return { cutSqrtAdj, perPoolInput, perRouteInput, totalInput };
}

/**
 * SINGLE-PASS (live-cut) reference — mirrors ecoswap.singlepass.sauce.ts EXACTLY.
 *
 * One sweep over the pre-sorted ladder, accumulating each bracket's LIVE gross
 * capacity into its pool/route register until cum reaches amountIn; the crossing
 * entry's pool/route takes the remaining `need`. No explicit cut: it is implicit
 * where cum hits amountIn, and exact-input swaps realise the geometry. Live price
 * is read once per pool (here, in the deterministic local test, live == the pool's
 * first capacity>0 bracket's near = spot). Reverse brackets (capacity 0, sorted
 * above spot) contribute nothing because hi=min(spot,near)=spot < far there.
 *
 * vs the two-pass: spends amountIn EXACTLY when liquidity allows (the two-pass
 * undershoots via per-pool re-derivation), and allocates by bracket granularity
 * (sub-tick on fine V3, larger on coarse V2) — both are valid water-fills with
 * equalised post-fee marginals; output differs only at the flat optimum (<0.1% on
 * fine ticks).
 */
function singlePassReference(
  prepared: EcoSwapPrepared,
  amountIn: bigint,
  adaptive = false,
): EcoSwapReferenceResult {
  const { pools, routes, brackets } = prepared;
  const perPoolInput: bigint[] = new Array(pools.length).fill(0n);
  const perRouteInput: bigint[] = new Array(routes.length).fill(0n);
  const curCache: ({ curSqrt: bigint; liveL: bigint } | undefined)[] = new Array(pools.length).fill(
    undefined,
  );

  // Live price for a pool = its first capacity>0 (spot) bracket's near; V2 live L
  // = that bracket's liquidity. Matches the on-chain slot0/getReserves read.
  const spotBracketFor = (p: number) => {
    for (let bi = 0; bi < brackets.length; bi++) {
      const b = brackets[bi];
      if (b.kind !== EcoBracketKind.Route && b.refIdx === p && b.capacity > 0n) return b;
    }
    return undefined;
  };

  let cum = 0n;
  let found = false;
  let cutSqrtAdj = 0n; // implicit; recorded for diagnostics only

  for (let bi = 0; bi < brackets.length; bi++) {
    if (found) break;
    const b = brackets[bi];

    if (b.kind === EcoBracketKind.Route) {
      let take = b.capacity;
      if (cum + b.capacity >= amountIn) {
        take = amountIn - cum;
        found = true;
        cutSqrtAdj = b.sqrtAdjNear;
      }
      perRouteInput[b.refIdx] = perRouteInput[b.refIdx] + take;
      cum = cum + take;
    } else {
      const p = b.refIdx;
      const dp = pools[p];
      const feePpm = BigInt(dp.feePpm);
      const isV2 = dp.isV2;

      if (curCache[p] === undefined) {
        const sb = spotBracketFor(p);
        curCache[p] = {
          curSqrt: sb ? sb.sqrtNear : 0n,
          liveL: sb && isV2 ? sb.liquidity : 0n,
        };
      }
      const cur = curCache[p]!.curSqrt;
      const Lliv = curCache[p]!.liveL;

      const Lb = isV2 ? Lliv : b.liquidity;
      const hi = cur < b.sqrtNear ? cur : b.sqrtNear;
      const far = b.sqrtFar;
      if (hi > far && Lb > 0n && far > 0n) {
        const effIn = mulDiv(Lb, Q96, far) - mulDiv(Lb, Q96, hi);
        if (effIn > 0n) {
          const capGross = mulDiv(effIn, FEE_DENOM, FEE_DENOM - feePpm);
          let take = capGross;
          if (cum + capGross >= amountIn) {
            take = amountIn - cum;
            found = true;
            cutSqrtAdj = b.sqrtAdjFar;
          }
          perPoolInput[p] = perPoolInput[p] + take;
          cum = cum + take;
        }
      }
    }
  }

  // ── ADAPTIVE STREAMING TICK WALK (WS4 oracle mirror) ──
  // Mirrors ecoswap.singlepass.sauce.ts's adaptive block EXACTLY: when the sweep
  // under-filled and a pool carries a frontier seed, resume its tick walk using the
  // SAME multiplicative stepReal (NOT getSqrtRatioAtTick), toOutIn, mulDiv+fee-grossup,
  // and the SAME int128 raw-uint L update — reading net from the off-chain adaptiveNet
  // map keyed by signed tick. Gated by `adaptive`; default false → no-op (regression pin).
  const EXTRA_TICKS = 64;
  if (adaptive && cum < amountIn) {
    const zeroForOne = prepared.zeroForOne;
    const z = zeroForOne ? 1 : 0;
    const priceLimit = prepared.priceLimit;
    for (let ap = 0; ap < pools.length; ap++) {
      if (cum >= amountIn) break;
      const ad = pools[ap];
      if (ad.isV2) continue;
      const aStartShift = ad.adaptiveStartShifted ?? 0n;
      if (aStartShift <= 0n) continue; // not prepared adaptively → skip (off → no-op)
      const aFeePpm = BigInt(ad.feePpm);
      const aTs = BigInt(ad.tickSpacing);
      const aStep = ad.adaptiveStepRatio ?? 0n;
      const aNet = ad.adaptiveNet ?? new Map<number, bigint>();
      let aShift = aStartShift;
      let aNearReal = ad.adaptiveNearReal ?? 0n;
      let aL = ad.adaptiveStartL ?? 0n;
      let aDone = false;
      for (let kx = 0; kx < EXTRA_TICKS; kx++) {
        if (aDone) break;
        const aFarReal = stepReal(aNearReal, aStep, zeroForOne);
        const aNearOI = toOutIn(aNearReal, zeroForOne);
        const aFarOI = toOutIn(aFarReal, zeroForOne);
        let aLimited = false;
        if (z === 1) {
          if (aFarReal <= priceLimit) aLimited = true;
        } else {
          if (aFarReal >= priceLimit) aLimited = true;
        }
        if (aL > 0n && aNearOI > aFarOI && aFarOI > 0n) {
          const aEffIn = mulDiv(aL, Q96, aFarOI) - mulDiv(aL, Q96, aNearOI);
          if (aEffIn > 0n) {
            const aGross = mulDiv(aEffIn, FEE_DENOM, FEE_DENOM - aFeePpm);
            let aTake = aGross;
            if (cum + aGross >= amountIn) {
              aTake = amountIn - cum;
              aDone = true;
            }
            perPoolInput[ap] = perPoolInput[ap] + aTake;
            cum = cum + aTake;
          }
        }
        // Cross the boundary: update L by liquidityNet. The on-chain solver reads
        // the RAW uint128 word, so reconstruct it from the signed map value and run
        // the identical sign/clamp branches (bit-for-bit with the engine path).
        const signedNet = aNet.get(Number(tickArg(aShift))) ?? 0n;
        const raw = signedNet >= 0n ? signedNet : signedNet + MOD128;
        const neg = raw >= HALF128;
        if (z === 1) {
          if (neg) aL = aL + (MOD128 - raw);
          else aL = aL >= raw ? aL - raw : 0n;
          aShift = aShift - aTs;
        } else {
          if (neg) {
            const mag = MOD128 - raw;
            aL = aL >= mag ? aL - mag : 0n;
          } else {
            aL = aL + raw;
          }
          aShift = aShift + aTs;
        }
        aNearReal = aFarReal;
        if (cum >= amountIn) aDone = true;
        if (aLimited) aDone = true;
      }
    }
  }

  const totalInput =
    perPoolInput.reduce((a, b) => a + b, 0n) + perRouteInput.reduce((a, b) => a + b, 0n);
  return { cutSqrtAdj, perPoolInput, perRouteInput, totalInput };
}
