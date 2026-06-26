/**
 * EcoSwap reference oracle (pure TypeScript bigint math, EVM-free).
 *
 * Faithfully mirrors the on-chain solver in `dev-tools/recipes/ecoswap/ecoswap.sauce.ts`
 * (the single-pass live-cut water-fill) so an EVM end-to-end test can cross-check
 * on-chain allocations against this.
 *
 * The integer math (mulDiv truncation) and the adaptive-walk helpers (stepReal,
 * toOutIn, tickArg, int128 sign recovery) are replicated EXACTLY from the sauce
 * script and from prepare.ts; see ./ecoswap.math for the shared copies.
 *
 * LIVE-PRICE ASSUMPTION
 * ─────────────────────
 * The on-chain solver re-reads live prices during the sweep (slot0 for V3,
 * getReserves for V2). This reference is for the DETERMINISTIC local test where
 * live state equals the prepared state, so we model:
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

/**
 * Reference allocation for EcoSwap's single-pass (live-cut) on-chain solver,
 * including the always-on WS4 streaming tick walk. The walk is naturally a no-op
 * for pools without a frontier seed (V2, or synthetic fixtures with no
 * adaptiveStartShifted), so non-adaptive callers are unaffected.
 */
export function ecoSwapReference(prepared: EcoSwapPrepared, amountIn: bigint): EcoSwapReferenceResult {
  return singlePassReference(prepared, amountIn);
}

/**
 * SINGLE-PASS (live-cut) reference — mirrors ecoswap.sauce.ts EXACTLY.
 *
 * One sweep over the pre-sorted ladder, accumulating each bracket's LIVE gross
 * capacity into its pool/route register until cum reaches amountIn; the crossing
 * entry's pool/route takes the remaining `need`. No explicit cut: it is implicit
 * where cum hits amountIn, and exact-input swaps realise the geometry. Live price
 * is read once per pool (here, in the deterministic local test, live == the pool's
 * first capacity>0 bracket's near = spot). Reverse brackets (capacity 0, sorted
 * above spot) contribute nothing because hi=min(spot,near)=spot < far there.
 *
 * Spends amountIn EXACTLY when liquidity allows (the crossing bracket takes the
 * remaining `need`), and allocates by bracket granularity (sub-tick on fine V3,
 * larger on coarse V2) — a valid water-fill with equalised post-fee marginals.
 */
function singlePassReference(
  prepared: EcoSwapPrepared,
  amountIn: bigint,
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
  // Mirrors ecoswap.sauce.ts's always-on adaptive block EXACTLY: when the sweep
  // under-filled and a pool carries a frontier seed, resume its tick walk using the
  // SAME multiplicative stepReal (NOT getSqrtRatioAtTick), toOutIn, mulDiv+fee-grossup,
  // and the SAME int128 raw-uint L update — reading net from the off-chain adaptiveNet
  // map keyed by signed tick. Naturally a no-op for pools without a seed (V2, or
  // synthetic fixtures with adaptiveStartShifted 0 → the per-pool aStartShift>0 gate
  // below skips them), so non-adaptive fixtures are unaffected.
  const EXTRA_TICKS = 64;
  if (cum < amountIn) {
    const zeroForOne = prepared.zeroForOne;
    const z = zeroForOne ? 1 : 0;
    const priceLimit = prepared.priceLimit;
    for (let ap = 0; ap < pools.length; ap++) {
      if (cum >= amountIn) break;
      const ad = pools[ap];
      if (ad.isV2) continue;
      const aStartShift = ad.adaptiveStartShifted ?? 0n;
      if (aStartShift <= 0n) continue; // no frontier seed (V2 / synthetic fixture) → skip
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
