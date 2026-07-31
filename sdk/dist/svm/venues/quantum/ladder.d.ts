/**
 * Quantum adapter v2 (EcoSwapSVM ladder fragment) — the discrete-level PMM
 * walk. See ./index.ts for the layout, the reversed closed form and the
 * shipped-prefix rule; this file is the fragment + its lamport-exact mirror.
 *
 * NOTHING is baked as a drift-invariant shape param: every price, size,
 * per-level expiry slot, kind byte, cached reserve and vault balance is read
 * LIVE at cook time, and the walkable-prefix conditions the venue itself
 * enforces (price != 0, non-decreasing price, kind == 1) are RE-DERIVED live.
 * The only per-trade cfg words are the shipped level count and 2*10^outDec.
 *
 * Drift semantics:
 * - a level repriced/resized since prepare: exact (live read);
 * - a level EXPIRED since prepare: skipped, exactly like the venue (.text
 *   0x1058) — a self-drop, never a revert;
 * - a level whose price dropped below its predecessor since prepare (the
 *   venue's own `pc >= pp` gate would REVERT): the walk stops there, so the
 *   merge books no input past it and the venue never reaches it;
 * - the whole shipped ladder consumed, or the output vault drained below the
 *   walk's output: the slot SELF-CAPS (capacityInputVar) instead of emitting a
 *   value the venue would reject.
 *
 * THE PARTIAL-FILL INVERSION. The venue bisects `max{m <= c : cost(m) <= rem}`
 * in-program (.text 0x20c0-0x2328). cost is nondecreasing in m, so the
 * predicate is downward-closed and a BINARY-DIGIT DESCENT over [0, hi] with a
 * STATIC 64 steps returns the identical m — `qtFill` below. hi = K/(2*pp)
 * (valid because the inner ramp term is >= 0) keeps the descent inside the
 * bracket. Verified against the deployed binary in LiteSVM: 97,419 exact
 * matches vs. the reference bisection over every level of all 27 live pools,
 * and 35,938 wei-exact end-to-end quote matches (0 over-quotes) across 12
 * pools x 2 directions x {live, unbounded} reserves x 10 expiry masks.
 *
 * Not a fixed-point/Newton seed on purpose: a seeded linear iteration is exact
 * only for gentle ramps and was measured 4,210 bps LOW on a live pool whose
 * level ramps steeply (dP >> pp). The descent is shape-independent.
 */
import type { Address } from '@solana/kit';
import type { SvmVenueLadderV2 } from '../types.js';
/** The program's single global config account (one for every pool). */
export declare const QUANTUM_GLOBAL: Address;
/** TS mirror of qtCost. */
export declare function quantumCost(m: bigint, pp: bigint, pc: bigint, c: bigint, s2: bigint): bigint;
/** TS mirror of qtFill (the exact 64-step binary-digit descent). */
export declare function quantumFill(rem: bigint, pp: bigint, pc: bigint, c: bigint, s2: bigint): bigint;
export declare const quantumLadder: SvmVenueLadderV2;
//# sourceMappingURL=ladder.d.ts.map