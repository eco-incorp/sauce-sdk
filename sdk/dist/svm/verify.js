// @eco-incorp/sauce-sdk/svm/verify — the SVM counterpart of `@eco-incorp/sauce-sdk/verify`, for a
// compiled `settle` program.
//
// WHY IT LOOKS DIFFERENT FROM THE EVM ONE. The EVM settle program bakes its params
// (tokens, minOut, recipient) into a PROLOGUE, so `decodeSettleProgram` reads them straight out of
// the bytecode. The SVM settle program is compiled STAGED (`staged: true`): the compiler puts args in
// the per-execution CALLDATA, not the blob — the buffer bytecode is byte-identical for ANY arg values
// at a given escrow count (verified: `svmSettleSource(1)` compiles to the same 293 bytes for
// minOut=1 and minOut=999). So there is nothing to decode OUT of the program itself. Two facts split
// the EVM decoder's single job into two halves here:
//
//   1. THE PROGRAM is a pure function of the escrow count. You verify it the way the recipe's own
//      "PARTNER VERIFY" note says — recompile `svmSettleSource(N)` and byte-compare — not by parsing a
//      prologue. `verifySvmSettleProgram` packages that: it infers N from the account plan, recompiles,
//      and byte-compares the blob + the ref order. That is the SVM analogue of the EVM `bodyHash`
//      check (prove the logic is the genuine settle logic, not a lookalike).
//
//   2. THE ARGS (minOut, splCount, tokenProgram0/1) ride the CALLDATA, so they ARE recoverable — from
//      the execute payload's args tail, not the blob. `decodeSvmSettleArgs` is the exact inverse of the
//      SDK's `encodePayloadArgs` for the settle layout (four 32-byte big-endian scalar slots).
//
// The account identities (escrows, mints, dests, owner, token programs) are never in the bytecode on
// SVM in either mode — Solana requires them attached — so they come from the executed instruction's
// account list, matched against the plan's refs (`svmSettleRefs(N)`). This module does not read them;
// a caller pairs the verified plan with the on-chain instruction to resolve them.
//
// Unlike `@eco-incorp/sauce-sdk/verify` (viem-only, browser-safe), `verifySvmSettleProgram` pulls the
// compiler in to recompile — a node-side check. `decodeSvmSettleArgs` is light (only @solana/kit).
import { getAddressDecoder } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import { SVM_MAX_ESCROWS, svmSettleRefs, svmSettleSource } from './recipes/index.js';
/** Byte length of the settle args tail: 4 scalar slots × 32 bytes. */
export const SVM_SETTLE_ARGS_BYTES = 4 * 32;
const addressDecoder = getAddressDecoder();
/** Big-endian u256 -> bigint, for a 32-byte scalar slot. */
function beScalar(bytes, offset) {
    let v = 0n;
    for (let i = 0; i < 32; i++)
        v = (v << 8n) | BigInt(bytes[offset + i]);
    return v;
}
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
export function decodeSvmSettleArgs(payloadArgs, argsLayout) {
    if (!(payloadArgs instanceof Uint8Array) || payloadArgs.length !== SVM_SETTLE_ARGS_BYTES) {
        const got = payloadArgs instanceof Uint8Array ? `${payloadArgs.length} bytes` : 'a non-Uint8Array';
        throw new Error(`svm settle args must be exactly ${SVM_SETTLE_ARGS_BYTES} bytes (4 × 32), got ${got}`);
    }
    if (argsLayout !== undefined) {
        const shapeOk = argsLayout.mode === 'calldata' &&
            argsLayout.slots.length === 4 &&
            argsLayout.slots.every((s, i) => s.kind === 'scalar' && s.length === 32 && s.offset === i * 32);
        if (!shapeOk) {
            throw new Error('argsLayout is not the settle shape (4 scalar 32-byte slots at 0/32/64/96)');
        }
    }
    return {
        minOut: beScalar(payloadArgs, 0),
        splCount: beScalar(payloadArgs, 32),
        tokenProgram0: addressDecoder.decode(payloadArgs.subarray(64, 96)),
        tokenProgram1: addressDecoder.decode(payloadArgs.subarray(96, 128)),
    };
}
/** N escrows intern `3N + 3` accounts (2 token programs + 3 per escrow + the shared owner). */
function escrowCountFromPlan(metaCount) {
    if ((metaCount - 3) % 3 !== 0)
        return null;
    const n = (metaCount - 3) / 3;
    return Number.isInteger(n) && n >= 1 && n <= SVM_MAX_ESCROWS ? n : null;
}
function bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
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
export function verifySvmSettleProgram(bytecode, accountPlan) {
    const escrowCount = escrowCountFromPlan(accountPlan.metas.length);
    if (escrowCount === null) {
        return {
            genuine: false,
            escrowCount: null,
            refs: [],
            mismatch: `account plan has ${accountPlan.metas.length} accounts, which is not 3N + 3 for any settle escrow count 1..${SVM_MAX_ESCROWS}`,
        };
    }
    const refs = svmSettleRefs(escrowCount);
    const planRefs = accountPlan.metas.map((m) => m.ref);
    if (planRefs.length !== refs.length || planRefs.some((r, i) => r !== refs[i])) {
        return { genuine: false, escrowCount, refs, mismatch: `account plan refs do not match svmSettleRefs(${escrowCount})` };
    }
    // Placeholder args: 4 scalars. Values are irrelevant to a staged blob (verified) — only the shape
    // (four scalar slots) must match what the source declares.
    const expected = compile(svmSettleSource(escrowCount), {
        target: 'svm',
        staged: true,
        treeshake: true,
        args: [0n, 0n, 0n, 0n],
    });
    if (!bytesEqual(bytecode, expected.bytecode[0])) {
        return { genuine: false, escrowCount, refs, mismatch: `bytecode does not byte-match svmSettleSource(${escrowCount})` };
    }
    return { genuine: true, escrowCount, refs };
}
//# sourceMappingURL=verify.js.map