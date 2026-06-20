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
import { Q96, FEE_DENOM, isqrt, mulDiv } from "./ecoswap.math";

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
      // Find this pool's first (ladder-earliest, highest-price) direct bracket.
      let firstBracket: (typeof brackets)[number] | undefined;
      for (let bi = 0; bi < brackets.length; bi++) {
        const b = brackets[bi];
        if (b.kind !== EcoBracketKind.Route && b.refIdx === p) {
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
