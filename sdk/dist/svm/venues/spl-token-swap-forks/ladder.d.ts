/**
 * spl-token-swap fork LADDER fragments (EcoSwapSVM adapter contract v2) — see
 * ./index.ts's module header for the shared math/layout rationale. One
 * factory instantiated per deployed fork; only the swap CPI's `programId`
 * (buildSwapV2) and the swap-authority PDA domain (folded into fetchPoolConfig,
 * ./index.ts) differ per fork.
 *
 * The quote helper is named `qSplTokenSwapFork` — deliberately NOT the same
 * name as `orca-legacy-token-swap`'s `qOrca` (the codegen dedupes helpers by
 * name across every family in a compiled shape and requires byte-identical
 * source for a reused name; keeping a separate name here means a future
 * change to either family's math can never silently violate that contract).
 */
import type { Address } from '@solana/kit';
import type { SvmVenueLadderV2 } from '../types.js';
/**
 * One ladder per deployed spl-token-swap fork — SAME quote math/CPI shape as
 * orca-legacy-token-swap's ladder (see ./index.ts), parameterized by the
 * fork's own program id.
 */
export declare function makeSplTokenSwapForkLadder(slug: string, programId: Address): SvmVenueLadderV2;
export declare const tokenSwapV1Ladder: SvmVenueLadderV2;
export declare const dexlabLadder: SvmVenueLadderV2;
export declare const sarosLadder: SvmVenueLadderV2;
export declare const orcaV1Ladder: SvmVenueLadderV2;
export declare const penguinLadder: SvmVenueLadderV2;
export declare const stepnLadder: SvmVenueLadderV2;
//# sourceMappingURL=ladder.d.ts.map