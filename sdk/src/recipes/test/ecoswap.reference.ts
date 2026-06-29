/**
 * EcoSwap reference oracle (pure TypeScript bigint math, EVM-free).
 *
 * Faithfully mirrors the on-chain solver in `recipes/ecoswap/ecoswap.sauce.ts` — the
 * K-WAY-LAZY price-ordered merge (one merge pass over the prepared bracket cursor + each
 * pool's live `dn` frontier, advancing the highest fee-adjusted head each step). This is a
 * thin adapter over `kwayReference` (the validated merge model, proven == the neutral
 * optimal oracle `ecoswap.optimal.ts` on the math tier): it derives the modeled LIVE state
 * each pool's on-chain SETUP would read and forwards to `kwayReference`.
 *
 * The integer math (mulDiv truncation, the int128 sign recovery, stepReal, toOutIn, tickArg,
 * the sqrt fee-adjust) lives in `./ecoswap.kway.reference` + `./ecoswap.math`, so this
 * reference is bit-for-bit with both the on-chain solver and the neutral optimal oracle.
 *
 * LIVE-PRICE MODELING
 * ───────────────────
 * The on-chain solver re-reads live prices in SETUP (slot0 for V3/V4, getReserves for V2)
 * and RE-ANCHORS a pool's whole walk to that live spot on ANY drift. This adapter models
 * that read per pool:
 *   - DRIFT (a test sets `liveCurRealOverride`/`liveTickOverride`/`liveLOverride` on the
 *     pool, or `v2LiveOverride`): the modeled live state is the override → the merge
 *     re-anchors the pool's walk to it (symmetric for drift UP and DOWN) and stale-skips its
 *     prepared cache, exactly as the solver does.
 *   - NO DRIFT, seeded pool (real / prod-mirror pools always stamp `topNearReal` + the dn
 *     seed): no override ⇒ `kwayReference`'s default models live == prepared spot, so the
 *     prepared cache + prepare-time dn seed run unchanged.
 *   - NO DRIFT, synthetic no-seed fixture (`topNearReal`/`adaptiveStartShifted` unset): the
 *     adapter supplies the modeled live spot from the pool's first capacity>0 bracket near
 *     (V2 also its live √k), so the merge's competition key prices the cache correctly. With
 *     no `topNearReal` neither the re-anchor nor the stale-skip fires, so the merge simply
 *     consumes the pre-sorted cache in price order — identical to the legacy single sweep.
 */

import { EcoBracketKind, type EcoSwapPrepared } from "../shared/types";
import { OFFSET, toOutIn, getSqrtRatioAtTick } from "./ecoswap.math";
import { kwayReference, type KwayLivePool } from "./ecoswap.kway.reference";

export interface EcoSwapReferenceResult {
  /** fee-adjusted out/in marginal at the cut (deepest reached) — diagnostic. */
  cutSqrtAdj: bigint;
  /** Gross tokenIn allocated to pools[i], same indexing as prepared.pools. */
  perPoolInput: bigint[];
  /** Gross tokenIn allocated to routes[i], same indexing as prepared.routes. */
  perRouteInput: bigint[];
  /** Σ perPoolInput + Σ perRouteInput (≤ amountIn). */
  totalInput: bigint;
}

/**
 * Reference allocation for EcoSwap's canonical K-way merge solver (ecoswap.sauce.ts).
 *
 * Derives the modeled LIVE per-pool state the on-chain SETUP reads, then delegates to the
 * validated `kwayReference`. In the deterministic local test the modeled live == prepared
 * spot (no override) ⇒ the merge consumes the prepared cache + the prepare-time dn seed.
 */
export function ecoSwapReference(prepared: EcoSwapPrepared, amountIn: bigint): EcoSwapReferenceResult {
  const { pools, brackets, zeroForOne } = prepared;

  // Live spot for a pool = its first capacity>0 (spot) bracket's near edge (out/in); V2 live
  // √k = that bracket's liquidity. Matches the on-chain slot0/getReserves read for synthetic
  // no-seed fixtures (real/seeded pools stamp topNearReal and don't need this).
  const spotBracketFor = (p: number) => {
    for (let bi = 0; bi < brackets.length; bi++) {
      const b = brackets[bi];
      if (b.kind !== EcoBracketKind.Route && b.refIdx === p && b.capacity > 0n) return b;
    }
    return undefined;
  };

  const live: (KwayLivePool | undefined)[] = pools.map((pd, i) => {
    if (pd.isV2) {
      // V2 drift: a test models the live out/in spot + live √k via liveCurRealOverride
      // (out/in here, since V2 brackets are already out/in) + liveLOverride.
      if (pd.liveCurRealOverride !== undefined || pd.liveLOverride !== undefined) {
        const sb = spotBracketFor(i);
        const liveV2L = pd.liveLOverride ?? (sb ? sb.liquidity : 0n);
        const curOI = pd.liveCurRealOverride ?? (sb ? sb.sqrtNear : 0n);
        return { curOI, liveV2L };
      }
      // No-drift V2: supply the modeled live √k (+ spot out/in) from the spot bracket so the
      // dn frontier / competition key have a real liquidity to integrate against.
      const sb = spotBracketFor(i);
      if (sb) return { curOI: sb.sqrtNear, liveV2L: sb.liquidity };
      // Seeded V2 with topNearReal but no spot bracket window: let kway default to topNearReal.
      return undefined;
    }
    // V3/V4 DRIFT: the test models the live (drifted) real sqrt + tick + active L.
    if (pd.liveCurRealOverride !== undefined) {
      const liveReal = pd.liveCurRealOverride;
      return {
        curOI: toOutIn(liveReal, zeroForOne),
        liveRealSqrt: liveReal,
        liveTick: pd.liveTickOverride ?? 0,
        liveL: pd.liveLOverride ?? pd.adaptiveStartL ?? 0n,
      };
    }
    // V3/V4 NO DRIFT: if the pool was seeded (topNearReal set), kway's default models live ==
    // spot — pass undefined. Otherwise (synthetic no-seed) supply the spot out/in from the
    // pool's first bracket so the merge's competition key prices the cache.
    if (pd.topNearReal && pd.topNearReal > 0n) return undefined;
    const sb = spotBracketFor(i);
    if (sb) return { curOI: sb.sqrtNear };
    return undefined;
  });

  const res = kwayReference(prepared, amountIn, live);
  return {
    cutSqrtAdj: res.cutSqrtAdj,
    perPoolInput: res.perPoolInput,
    perRouteInput: res.perRouteInput,
    totalInput: res.totalInput,
  };
}

// Re-exported so callers that previously imported the OFFSET/derivation helpers from this
// module keep working (the merge derivation lives in ecoswap.kway.reference now).
export { OFFSET, getSqrtRatioAtTick };
