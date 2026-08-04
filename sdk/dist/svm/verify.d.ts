import type { Address } from '@solana/kit';
import type { ArgsLayout } from '@eco-incorp/sauce-compiler';
export interface DecodedSvmSettleArgs {
    /** The floor applied to escrow 0 (0 disables the floor). */
    minOut: bigint;
    /** Escrows i < splCount sweep via tokenProgram0, the rest via tokenProgram1. */
    splCount: bigint;
    tokenProgram0: Address;
    tokenProgram1: Address;
}
/** Byte length of the settle args tail: 4 scalar slots × 32 bytes. */
export declare const SVM_SETTLE_ARGS_BYTES: number;
/**
 * Decodes the settle program's per-execution args from the CALLDATA tail — the exact inverse of the
 * SDK's `encodePayloadArgs` for `main(minOut, splCount, tokenProgram0, tokenProgram1)` (four 32-byte
 * big-endian scalar slots). Pass the ARGS bytes only (strip the execute payload's flags byte + any
 * hash pin / slice first). `argsLayout` is optional: when supplied it is checked to be the settle
 * shape; the decode itself uses the fixed 0/32/64/96 offsets either way.
 *
 * A token-program slot is a 32-byte pubkey; minOut/splCount are big-endian scalars. Nothing about
 * these values is trusted — a caller compares them against what it expects, exactly as with the EVM
 * decoder.
 */
export declare function decodeSvmSettleArgs(payloadArgs: Uint8Array, argsLayout?: ArgsLayout): DecodedSvmSettleArgs;
export interface AccountPlanLike {
    metas: readonly {
        ref: string;
    }[];
}
export interface SvmSettleVerification {
    /** True iff the bytecode byte-matches svmSettleSource(escrowCount) AND the plan's refs match svmSettleRefs. */
    genuine: boolean;
    /** The inferred escrow count, or null when the account plan does not fit any settle shape. */
    escrowCount: number | null;
    /** The canonical ref order for `escrowCount` (svmSettleRefs) — empty when escrowCount is null. */
    refs: string[];
    /** Present iff not genuine: what failed (unrecognized shape / bytecode mismatch / ref mismatch). */
    mismatch?: string;
}
/**
 * Verifies a compiled SVM settle program is genuine — the SVM analogue of the EVM decoder's body-hash
 * check, done by recompile rather than prologue-decode (the staged blob has no prologue). It:
 *   1. infers the escrow count N from the account plan's ref count (3N + 3),
 *   2. recompiles `svmSettleSource(N)` with the exact shipped options (`target: svm, staged, treeshake`;
 *      placeholder args, whose VALUES cannot affect a staged blob), and
 *   3. byte-compares the blob AND asserts the plan's refs equal `svmSettleRefs(N)`.
 *
 * A genuine result means the bytecode IS the reusable settle logic for N escrows and the account slots
 * are the ones that logic addresses — the params (from `decodeSvmSettleArgs`) and the resolved account
 * identities (from the executed instruction) are then checkable against expectation. Never throws for a
 * non-genuine program; returns `{ genuine: false, mismatch }`.
 */
export declare function verifySvmSettleProgram(bytecode: Uint8Array, accountPlan: AccountPlanLike): SvmSettleVerification;
//# sourceMappingURL=verify.d.ts.map