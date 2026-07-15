import type { SwapUser } from '../../../svm/venues/types.js';
import type { EcoSwapSvmSlot, GeneratedEcoSwapSvm } from './codegen.js';
/** Structural leg-slot bounds: each leg carries 1..MAX_LEG_SLOTS pools, total 2..MAX_ROUTE_SLOTS. */
export declare const MAX_LEG_SLOTS = 3;
export declare const MAX_ROUTE_SLOTS = 4;
/** Default intermediate-ATA ref (leg-0's out ATA and leg-1's in ATA — one deduped, writable, non-signer key). */
export declare const DEFAULT_INTER_REF = "user:inter";
export interface GenerateEcoSwapSvmRouteInput {
    /** leg-0 slots (A → X), preference order — merge ties keep the earliest slot. */
    leg0: EcoSwapSvmSlot[];
    /** leg-1 slots (X → B), preference order. */
    leg1: EcoSwapSvmSlot[];
    /** User refs: inAta (token A), outAta (token B), owner. */
    user: SwapUser;
    /**
     * Intermediate-token (X) ATA ref for `user.owner`, resolved by the caller.
     * Appears as leg-0's out ATA and leg-1's in ATA (deduped). Default 'user:inter'.
     */
    interRef?: string;
    /** GasLeft safety floor (CU): throws `"cu"` before any work when the budget is below it. */
    cuFloor?: number;
}
export interface GeneratedEcoSwapSvmRoute extends GeneratedEcoSwapSvm {
    /** leg-0 slot count (the flat leg boundary k0) — part of the shape. */
    leg0Count: number;
    /** leg-1 slot count. */
    leg1Count: number;
    /** Resolved per-slot ladder rungs in FLAT order (leg-0 slots, then leg-1 slots). */
    rungs: number[];
}
/**
 * Shape discriminant for route blob reuse: leg-0 family slots, `>>`, leg-1
 * family slots (each slot rung-count-suffixed when off QL_S, plus any swap
 * override), so `k0` (the leg boundary) is recoverable and pool sets sharing
 * the shape reuse the identical blob.
 */
export declare function ecoSwapSvmRouteShapeKey(leg0: readonly EcoSwapSvmSlot[], leg1: readonly EcoSwapSvmSlot[]): string;
declare const U64_MAX: bigint;
/** Generates and compiles the staged 2-hop route blob for one shape. */
export declare function generateEcoSwapSvmRoute(input: GenerateEcoSwapSvmRouteInput): GeneratedEcoSwapSvmRoute;
export { U64_MAX as ROUTE_U64_MAX };
//# sourceMappingURL=route.d.ts.map