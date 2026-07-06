/**
 * EcoSwapSVM CU budgeter — fits the shape (slot count + per-slot ladder
 * rungs) to Solana's compute budget BEFORE codegen, deterministically.
 *
 * WHY CODEGEN-TIME (the determinism rule): the EVM EcoSwap can adapt its
 * walk to gas at runtime because its reference oracle replays the same gas
 * schedule; the SVM solver-reference CANNOT read GasLeft, so any CU-dependent
 * branching in the solver would break the lamport-exact gate. Rung counts
 * are therefore a pure function of (shape, budget) decided HERE, baked into
 * the blob, and mirrored by the reference from the prepared slots; GasLeft
 * (0x62) survives only as the codegen'd hard safety throw (`"cu"`) that
 * aborts before any work when the transaction's compute budget cannot cover
 * the shape's modeled cost — an all-or-nothing abort that can never change a
 * landed split.
 *
 * MODEL: estimate(shape) = BASE + Σ_slots (slot_f + rung_f · rungs_i), CU.
 * Coefficients are MEASURED on LiteSVM against the real engine
 * (test/svm/ecoswap-svm.cu.e2e.test.ts re-measures and alarms on drift):
 * `slot` folds the setup reads (a stable slot's once-per-trade Newton D
 * included), the COLD final quote, the merge share and the venue CPI
 * (real-binary swaps where measured; SPL-transfer stand-ins put ~5-15k CU of
 * that back as headroom); `rung` folds one ladder quote (warm-start Newton
 * for stable slots) plus the per-rung merge scan.
 *
 * ADMISSION: greedy under CU_ADMISSION_BUDGET (the 1.4M transaction cap
 * minus ~15% model headroom). Candidates arrive depth-filtered in caller
 * preference order at their family default rungs (CP 4, stable 2).
 * Degradation order (deterministic): stable slots shed rungs toward
 * MIN_RUNGS first, then CP slots; within a kind the slot with the MOST
 * rungs degrades first (last index breaks ties), i.e. round-robin — ladders
 * stay balanced, so identical pools keep identical ladders and the merge's
 * earliest-slot tie preference survives degradation. When nothing is left
 * to degrade, whole tail slots drop (warned, like the packet budgeter). A
 * single-slot shape that still exceeds the budget at MIN_RUNGS throws — the
 * caller may relax with `cuBudget` (e.g. meteora-damm-v1-stable alone
 * models within budget, but pairing it with anything does not; the thrown
 * error names the estimate).
 */
import { MIN_RUNGS, QL_S } from './solver-reference.js';

/** Solana's per-transaction compute ceiling. */
export const CU_TRANSACTION_CAP = 1_400_000;
/** Model headroom kept under the cap (parts of the cap). */
export const CU_HEADROOM = 0.15;
/** Default admission budget: the cap minus the model headroom. */
export const CU_ADMISSION_BUDGET = Math.floor(CU_TRANSACTION_CAP * (1 - CU_HEADROOM));

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
export const CU_BASE = -43_197;
export const CU_FAMILIES: Record<string, FamilyCuCoefficients> = {
  'raydium-cp-swap': { kind: 'cp', slot: 183_187, rung: 65_054 },
  'raydium-amm-v4': { kind: 'cp', slot: 163_374, rung: 62_149 },
  pumpswap: { kind: 'cp', slot: 175_949, rung: 70_379 },
  'orca-legacy-token-swap': { kind: 'cp', slot: 195_664, rung: 87_681 },
  // CLMM: slot folds the shipped-boundary live verification and the final
  // predicted quote (usually the reused top rung); rung folds one COLD rung
  // walk (each is a full compute_swap walk from the live spot; crossed
  // boundaries after the first walk replay from the full-step memo). 'stable'
  // kind = the 2-rung default + degrade-first class. Calibrated on the
  // SOL/USDC ts=4 fixture at 100 SOL (one boundary crossing); CU rises with
  // crossing depth (~+130k at four crossings), still under the 1.4M cap with
  // a CP co-slot — the admission headroom absorbs the state-dependence, like
  // the stable families' Newton-iteration variance.
  'orca-whirlpool': { kind: 'stable', slot: 443_056, rung: 185_725 },
  // Raydium CLMM: same window/walk shape as whirlpool (a rung is a full cold
  // compute_swap walk from the live spot; crossed boundaries replay from the
  // full-step memo), so 'stable' kind (2-rung default, degrade-first). The
  // nested delta_0 rounding costs a little more arithmetic per boundary than
  // whirlpool's single division. Calibrated on the SOL/USDC ts=1 fixture; the
  // slot term scales with crossing depth — re-pin with ECO_SVM_CU_PRINT=1
  // (test/svm/ecoswap-svm.cu.e2e.test.ts).
  'raydium-clmm': { kind: 'stable', slot: 453_176, rung: 204_363 },
  // Meteora DLMM: a rung is a full cold bin walk (up to METEORA_DLMM_MAX_BINS
  // discrete bins, each a live reserve read + the dynamic-fee arithmetic), so
  // 'stable' kind (2-rung default, degrade-first). Calibrated on the SOL/USDC
  // bin_step=4 fixture; the slot term folds the unrolled bin unpack +
  // update_references. Re-pin with ECO_SVM_CU_PRINT=1.
  'meteora-dlmm': { kind: 'stable', slot: 492_722, rung: 183_395 },
  // CLOB: slot folds the shipped-order live seq-verification (MANIFEST_MAX_ORDERS
  // unrolled market reads over the whole book account) + the cold final quote —
  // a heavy fixed cost, so 'stable' kind (2-rung default + degrade-FIRST class,
  // like whirlpool). rung folds one cold best-first walk over the shipped
  // levels. Calibrated on the SOL/USDC fixture (10 shipped bid levels); the slot
  // term scales with the shipped-order count (state-dependent, like whirlpool's
  // crossing depth). Re-pin with ECO_SVM_CU_PRINT=1
  // (test/svm/ecoswap-svm.cu.e2e.test.ts).
  manifest: { kind: 'stable', slot: 664_190, rung: 85_224 },
  'meteora-damm-v2': { kind: 'cp', slot: 185_290, rung: 82_405 },
  // Obric V2 (prop-AMM oracle-anchored, tier P-A): a closed-form shifted-CP
  // quote — CP kind (4-rung default). The slot term folds the setup (4 live
  // reads: two vaults + two oracle feeds, the oracle→mult scaling, the isqrt
  // re-anchor + the sanity band) and the cold final quote; the rung term folds
  // one last-good ladder step (a division + fee). Heavier than meteora-damm-v2
  // for the isqrt + the two extra oracle reads. Measured 2026-07-06 on a
  // synthesized centered pool (@2 373,150 CU, @4 500,097 CU); re-pin with
  // ECO_SVM_CU_PRINT=1 (test/svm/ecoswap-svm.cu.e2e.test.ts).
  'obric-v2': { kind: 'cp', slot: 295_925, rung: 63_473 },
  'saber-stableswap': { kind: 'stable', slot: 503_243, rung: 159_258 },
  'meteora-damm-v1-stable': { kind: 'stable', slot: 570_859, rung: 206_414 },
};

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
export const CU_TWO_HOP = 40_000;

export interface BudgetSlotInput {
  /** Family slug (a CU_FAMILIES key). */
  slug: string;
  /** Ladder rungs; absent = the family default (stable 2, CP QL_S). */
  rungs?: number;
}

export function familyCuCoefficients(slug: string): FamilyCuCoefficients {
  const coefficients = CU_FAMILIES[slug];
  if (coefficients === undefined) {
    throw new Error(`ecoSwapSvm CU model has no coefficients for family '${slug}' (known: ${Object.keys(CU_FAMILIES).join(', ')})`);
  }
  return coefficients;
}

export function defaultRungsFor(slug: string): number {
  return familyCuCoefficients(slug).kind === 'stable' ? 2 : QL_S;
}

/** Modeled CU for a shape — BASE + Σ (slot + rung·rungs). */
export function estimateShapeCu(slots: readonly BudgetSlotInput[]): number {
  return slots.reduce((sum, slot) => {
    const c = familyCuCoefficients(slot.slug);
    return sum + c.slot + c.rung * (slot.rungs ?? defaultRungsFor(slot.slug));
  }, CU_BASE);
}

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
export function planLadders(slots: readonly BudgetSlotInput[], cuBudget: number = CU_ADMISSION_BUDGET): LadderPlan {
  if (slots.length === 0) throw new Error('planLadders needs at least one slot');
  const warnings: string[] = [];
  let admitted = slots.length;
  let rungs = slots.map((slot) => slot.rungs ?? defaultRungsFor(slot.slug));

  const estimate = (): number => estimateShapeCu(slots.slice(0, admitted).map((slot, i) => ({ slug: slot.slug, rungs: rungs[i] })));

  for (;;) {
    if (estimate() <= cuBudget) break;

    // Degrade rungs: stable slots first, then CP; within a kind the most
    // rungs first, last index on ties (round-robin — see the header).
    const degrade = (kind: 'stable' | 'cp'): boolean => {
      let pick = -1;
      for (let i = 0; i < admitted; i++) {
        if (familyCuCoefficients(slots[i].slug).kind !== kind || rungs[i] <= MIN_RUNGS) continue;
        if (pick === -1 || rungs[i] >= rungs[pick]) pick = i;
      }
      if (pick === -1) return false;
      rungs[pick] -= 1;
      warnings.push(
        `ecoSwapSvm CU budget: degraded slot ${pick} (${slots[pick].slug}) to ${rungs[pick]} rungs (modeled ${estimate()} CU, budget ${cuBudget})`,
      );
      return true;
    };
    if (degrade('stable') || degrade('cp')) continue;

    // Nothing left to degrade — drop the tail slot.
    if (admitted > 1) {
      admitted -= 1;
      rungs = rungs.slice(0, admitted);
      warnings.push(
        `ecoSwapSvm CU budget: dropped slot ${admitted} (${slots[admitted].slug}) — modeled cost exceeds the ${cuBudget} CU budget`,
      );
      continue;
    }

    throw new Error(
      `ecoSwapSvm CU budget: a single ${slots[0].slug} slot at ${MIN_RUNGS} rungs models ${estimate()} CU, over the ${cuBudget} CU budget` +
        ` (transaction cap ${CU_TRANSACTION_CAP}); pass a higher cuBudget to force it`,
    );
  }

  return { rungs, admitted, estimatedCu: estimate(), warnings };
}

/** Modeled CU for a 2-hop route — the combined leg-0 ++ leg-1 shape plus the CU_TWO_HOP intercept. */
export function estimateRouteCu(leg0: readonly BudgetSlotInput[], leg1: readonly BudgetSlotInput[]): number {
  return estimateShapeCu([...leg0, ...leg1]) + CU_TWO_HOP;
}

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
export function planRouteLadders(
  leg0: readonly BudgetSlotInput[],
  leg1: readonly BudgetSlotInput[],
  cuBudget: number = CU_ADMISSION_BUDGET,
): RouteLadderPlan {
  if (leg0.length === 0 || leg1.length === 0) throw new Error('planRouteLadders needs at least one slot per leg');
  const warnings: string[] = [];
  let leg0Admitted = leg0.length;
  let leg1Admitted = leg1.length;
  const leg0Rungs = leg0.map((slot) => slot.rungs ?? defaultRungsFor(slot.slug));
  const leg1Rungs = leg1.map((slot) => slot.rungs ?? defaultRungsFor(slot.slug));

  const estimate = (): number =>
    estimateRouteCu(
      leg0.slice(0, leg0Admitted).map((slot, i) => ({ slug: slot.slug, rungs: leg0Rungs[i] })),
      leg1.slice(0, leg1Admitted).map((slot, i) => ({ slug: slot.slug, rungs: leg1Rungs[i] })),
    );

  // Degrade one slot of the given kind: most rungs first, later flat index on
  // ties (leg-1 slots are higher flat than leg-0), so identical pools keep
  // balanced ladders and the merge's earliest-slot tie preference survives.
  const degrade = (kind: 'stable' | 'cp'): boolean => {
    let pickRungs: number[] | undefined;
    let pickIndex = -1;
    let pickCurrent = -1;
    const consider = (rungsArr: number[], slots: readonly BudgetSlotInput[], admitted: number): void => {
      for (let i = 0; i < admitted; i++) {
        if (familyCuCoefficients(slots[i].slug).kind !== kind || rungsArr[i] <= MIN_RUNGS) continue;
        if (pickRungs === undefined || rungsArr[i] >= pickCurrent) {
          pickRungs = rungsArr;
          pickIndex = i;
          pickCurrent = rungsArr[i];
        }
      }
    };
    consider(leg0Rungs, leg0, leg0Admitted);
    consider(leg1Rungs, leg1, leg1Admitted);
    if (pickRungs === undefined) return false;
    pickRungs[pickIndex] -= 1;
    const leg = pickRungs === leg0Rungs ? 0 : 1;
    warnings.push(
      `ecoSwapSvm route CU budget: degraded leg-${leg} slot ${pickIndex} to ${pickRungs[pickIndex]} rungs (modeled ${estimate()} CU, budget ${cuBudget})`,
    );
    return true;
  };

  // Drop the tail slot, never emptying a leg (leg-1 tail first, then leg-0).
  const drop = (): boolean => {
    if (leg1Admitted > 1) {
      leg1Admitted -= 1;
      warnings.push(`ecoSwapSvm route CU budget: dropped leg-1 slot ${leg1Admitted} — modeled cost exceeds the ${cuBudget} CU budget`);
      return true;
    }
    if (leg0Admitted > 1) {
      leg0Admitted -= 1;
      warnings.push(`ecoSwapSvm route CU budget: dropped leg-0 slot ${leg0Admitted} — modeled cost exceeds the ${cuBudget} CU budget`);
      return true;
    }
    return false;
  };

  for (;;) {
    if (estimate() <= cuBudget) break;
    if (degrade('stable') || degrade('cp')) continue;
    if (drop()) continue;
    throw new Error(
      `ecoSwapSvm route CU budget: a minimal 1-slot-per-leg route (${leg0[0].slug} >> ${leg1[0].slug}) at ${MIN_RUNGS} rungs models ${estimate()} CU,` +
        ` over the ${cuBudget} CU budget (transaction cap ${CU_TRANSACTION_CAP}); pass a higher cuBudget to force it`,
    );
  }

  const admittedLeg0 = leg0Rungs.slice(0, leg0Admitted);
  const admittedLeg1 = leg1Rungs.slice(0, leg1Admitted);
  return {
    leg0Rungs: admittedLeg0,
    leg1Rungs: admittedLeg1,
    rungs: [...admittedLeg0, ...admittedLeg1],
    leg0Admitted,
    leg1Admitted,
    estimatedCu: estimate(),
    warnings,
  };
}
