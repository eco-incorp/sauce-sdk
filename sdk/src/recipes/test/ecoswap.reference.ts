/**
 * EcoSwap reference oracle (pure TypeScript bigint math, EVM-free).
 *
 * Faithfully mirrors the on-chain solver in `recipes/ecoswap/ecoswap.sauce.ts` — the unified
 * per-pool LIVE walk + per-pool net cache (one k-way merge over each pool's single from-live-
 * spot frontier + the route segments). This is a thin adapter over `kwayReference` (the
 * validated walk model, proven == the neutral optimal oracle `ecoswap.optimal.ts` on the math
 * tier): it derives the modeled LIVE state each pool's on-chain SETUP would read and forwards
 * to `kwayReference`.
 *
 * The integer math (mulDiv truncation, the int128 sign recovery, stepReal, toOutIn, tickArg,
 * the sqrt fee-adjust) lives in `./ecoswap.kway.reference` + `./ecoswap.math`, so this
 * reference is bit-for-bit with both the on-chain solver and the neutral optimal oracle.
 *
 * LIVE-PRICE MODELING
 * ───────────────────
 * The on-chain solver re-reads live prices in SETUP (slot0 for V3/V4, getReserves for V2) and
 * walks each pool's whole frontier from that live spot. This adapter models that read per pool:
 *   - DRIFT (a test sets `liveCurRealOverride`/`liveTickOverride`/`liveLOverride`): the modeled
 *     live state is the override → the frontier walks from it (the cached NET is drift-invariant,
 *     so the walk is wei-exact regardless of the drift).
 *   - NO DRIFT, seeded pool: no override ⇒ `kwayReference` reads the prepare-time spot from the
 *     EcoPool spot fields (spotNearReal/spotTickShifted/spotActiveL for V3/V4; the V2 out/in spot
 *     + √k below), so the walk runs from the prepare-time spot.
 */

import { type EcoSwapPrepared } from "../shared/types";
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
  /**
   * CURSOR-FIDELITY diagnostic (forwarded from kwayReference): one entry per IN-WINDOW boundary
   * the walk crossed, each carrying the cursor-path net vs the full-map net. The reference
   * asserts equality inline; a test can assert the count + that the cursor path ran (length > 0).
   */
  cursorChecks: { shifted: bigint; cursorNet: bigint; mapNet: bigint }[];
}

/**
 * Reference allocation for EcoSwap's unified-walk solver (ecoswap.sauce.ts).
 *
 * Derives the modeled LIVE per-pool state the on-chain SETUP reads, then delegates to the
 * validated `kwayReference`. In the deterministic local test the modeled live == the prepare-
 * time spot (no override) ⇒ each pool's frontier walks from its prepare-time spot.
 */
export function ecoSwapReference(prepared: EcoSwapPrepared, amountIn: bigint): EcoSwapReferenceResult {
  const { pools } = prepared;

  const live: (KwayLivePool | undefined)[] = pools.map((pd) => {
    if (pd.isV2) {
      // V2 drift: a test models the live out/in spot + live √k via liveCurRealOverride (out/in
      // here, since V2 streams in out/in) + liveLOverride.
      if (pd.liveCurRealOverride !== undefined || pd.liveLOverride !== undefined) {
        return {
          curOI: pd.liveCurRealOverride ?? pd.spotNearReal ?? 0n,
          liveV2L: pd.liveLOverride ?? pd.spotActiveL ?? 0n,
        };
      }
      // No-drift V2: the prepare-time spot out/in + √k.
      if (pd.spotActiveL !== undefined) {
        return { curOI: pd.spotNearReal ?? 0n, liveV2L: pd.spotActiveL };
      }
      return undefined;
    }
    // V3/V4 DRIFT: the test models the live (drifted) real sqrt + tick + active L.
    if (pd.liveCurRealOverride !== undefined) {
      return {
        curOI: 0n, // V3/V4 curOI is unused by kwayReference (it derives from liveRealSqrt)
        liveRealSqrt: pd.liveCurRealOverride,
        liveTick: pd.liveTickOverride ?? 0,
        liveL: pd.liveLOverride ?? pd.spotActiveL ?? 0n,
      };
    }
    // V3/V4 NO DRIFT: kwayReference reads the prepare-time spot fields directly — pass undefined.
    return undefined;
  });

  const res = kwayReference(prepared, amountIn, live);
  return {
    cutSqrtAdj: res.cutSqrtAdj,
    perPoolInput: res.perPoolInput,
    perRouteInput: res.perRouteInput,
    totalInput: res.totalInput,
    cursorChecks: res.cursorChecks,
  };
}
