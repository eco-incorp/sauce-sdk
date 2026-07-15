/** Solana's per-transaction compute ceiling. */
export declare const CU_TRANSACTION_CAP = 1400000;
/** Model headroom kept under the cap (parts of the cap). */
export declare const CU_HEADROOM = 0.15;
/** Default admission budget: the cap minus the model headroom. */
export declare const CU_ADMISSION_BUDGET: number;
export interface FamilyCuCoefficients {
    /** 'stable' slots degrade first and default to 2 rungs. */
    kind: 'cp' | 'stable';
    /** Per-slot fixed cost: setup (+ Newton D once for stables) + cold final quote + merge share + CPI. */
    slot: number;
    /** Per-rung cost: one ladder quote (warm-start for stables) + merge scan share. */
    rung: number;
}
/**
 * Measured 2026-07-06 on LiteSVM 1.2.1 (FeatureSet.allEnabled — mainnet
 * parity for the GasLeft syscall) against engine.so @ c099cdee (sauce/svm),
 * via test/svm/ecoswap-svm.cu.e2e.test.ts — see that suite for the
 * measurement method and the fitting arithmetic (rung = the 2→4-rung delta
 * halved; BASE from the 2-slot raydium-cp pair; slot = the 2-rung residual).
 * The suite re-measures every family and fails when one drifts beyond ±25%
 * of these pins, so an engine CU regression is loud, not silent — RE-PIN
 * (ECO_SVM_CU_PRINT=1 prints a fresh table) whenever the engine or a
 * fragment changes.
 *
 * CU_BASE is NEGATIVE by fit: a 2-slot shape costs slightly more than twice
 * a 1-slot shape (the merge scan widens with k), so the per-slot
 * coefficients absorb the shared overhead and the intercept compensates.
 * The model is exact on 1-slot shapes by construction and tracked the
 * Phase-0 3-slot measurement within 2%.
 */
export declare const CU_BASE = -43197;
export declare const CU_FAMILIES: Record<string, FamilyCuCoefficients>;
/**
 * The 2-hop ROUTE intercept, added ONCE to a route's combined-slot estimate:
 * the second inlined merge's base + the intermediate `accountUint` before/after
 * reads + the leg-boundary `realizedX` handling. Everything else (both legs'
 * setup, cold quotes, merge shares and venue CPIs) is already counted per slot
 * by estimateShapeCu over the combined leg-0 ++ leg-1 slot list — a route just
 * runs two single-hop-style legs back to back, so the family coefficients
 * (calibrated WITH a real-binary CPI per slot) already fold both legs' CPIs.
 *
 * Measured (test/svm/ecoswap-svm.multihop.e2e.test.ts, 2026-07-06): a 1+1
 * raydium-cp route with SPL-transfer stand-ins runs 775,675 CU, ~68k UNDER the
 * combined-model 843,609 — but the stand-in CPIs are ~76 CU each vs a real
 * raydium-cp swap's ~50k, so stand-ins hide ~100k of real-CPI cost the model
 * assumes; the true structural route overhead over two independent legs is a
 * modest POSITIVE ~30-40k. Pinned conservatively at 40k (a floor that is only
 * a safety throw, not the consumed amount — gasLeft at entry is the full
 * budget). Re-pin against a REAL-binary route lane when one lands, same ±25%
 * alarm discipline as the family coefficients.
 */
export declare const CU_TWO_HOP = 40000;
export interface BudgetSlotInput {
    /** Family slug (a CU_FAMILIES key). */
    slug: string;
    /** Ladder rungs; absent = the family default (stable 2, CP QL_S). */
    rungs?: number;
}
export declare function familyCuCoefficients(slug: string): FamilyCuCoefficients;
export declare function defaultRungsFor(slug: string): number;
/** Modeled CU for a shape — BASE + Σ (slot + rung·rungs). */
export declare function estimateShapeCu(slots: readonly BudgetSlotInput[]): number;
export interface LadderPlan {
    /** Per-admitted-slot rung counts, caller order preserved. */
    rungs: number[];
    /** Admitted slot count (a prefix of the input order). */
    admitted: number;
    /** Modeled CU of the admitted shape — also the codegen GasLeft floor. */
    estimatedCu: number;
    /** Budgeter notes: degradations and drops, packet-budgeter style. */
    warnings: string[];
}
/**
 * Fits rung counts (and, when degradation is not enough, the slot count) to
 * `cuBudget`. Deterministic in its inputs alone — see the module header.
 */
export declare function planLadders(slots: readonly BudgetSlotInput[], cuBudget?: number): LadderPlan;
/** Modeled CU for a 2-hop route — the combined leg-0 ++ leg-1 shape plus the CU_TWO_HOP intercept. */
export declare function estimateRouteCu(leg0: readonly BudgetSlotInput[], leg1: readonly BudgetSlotInput[]): number;
export interface RouteLadderPlan {
    /** leg-0 admitted rungs (a prefix of the leg-0 input order). */
    leg0Rungs: number[];
    /** leg-1 admitted rungs. */
    leg1Rungs: number[];
    /** Flat rung array: leg-0 admitted, then leg-1 admitted (the codegen/reference order). */
    rungs: number[];
    /** Admitted counts (prefixes of each leg's input). */
    leg0Admitted: number;
    leg1Admitted: number;
    /** Modeled route CU of the admitted shape — also the codegen GasLeft floor. */
    estimatedCu: number;
    /** Budgeter notes: degradations and drops, packet-budgeter style. */
    warnings: string[];
}
/**
 * Fits a 2-hop route's per-slot rung counts (and, when degradation is not
 * enough, the per-leg slot counts) to `cuBudget`, deterministically in its
 * inputs alone. Degradation is the single-hop order over the COMBINED slot list
 * (stable slots shed rungs toward MIN_RUNGS first, then CP; within a kind the
 * most rungs first, later flat index on ties). When nothing is left to
 * degrade, the TAIL slot drops — but NEVER a leg's last surviving slot (a route
 * needs >= 1 enabled slot per leg or it is not a route), so drops come from the
 * higher-flat-index leg's tail first (leg-1, then leg-0) and only while that leg
 * has more than one admitted slot. A 1-slot-per-leg route still over budget at
 * MIN_RUNGS throws infeasible (naming the estimate) — the caller falls back to
 * direct-only or a different route, or relaxes with `cuBudget`.
 */
export declare function planRouteLadders(leg0: readonly BudgetSlotInput[], leg1: readonly BudgetSlotInput[], cuBudget?: number): RouteLadderPlan;
//# sourceMappingURL=budget.d.ts.map