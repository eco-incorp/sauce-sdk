import { type CompileTarget } from './context.js';
import type { ContractsConfig } from './contracts.js';
import type { AccountPlan } from './planner/index.js';
export { Saucer } from './saucer/saucer.js';
export { V12Saucer } from './saucer/saucer-v12.js';
export type { SaucerLike, OutputSpec } from './saucer/saucer-like.js';
export { CompilerContext } from './context.js';
export type { CompileTarget } from './context.js';
export { OPS } from './saucer/ops.js';
export { OPS_V12 } from './saucer/ops-v12.js';
export { SVM_UNSUPPORTED } from './saucer/svm-profile.js';
export { estimatePacket, stagingTransactionCount, PAYER_REF } from './planner/index.js';
export type { AccountMeta, AccountPlan, PacketBudget, PacketBudgetOptions, PacketMode } from './planner/index.js';
export type { AbiParameter, AbiFunction, AbiItem, Abi, ContractConfig, ContractsConfig, ContractInfo, } from './contracts.js';
export type ArgValue = bigint | string | ArgValue[] | ArgObject;
/**
 * A struct arg at the main() boundary. Passed as a plain object, it is encoded as a
 * TUPLE with fields sorted ALPHABETICALLY — byte-identical to an in-script object
 * literal (see `extractStructType`/`processObjectExpression`) — so main() reads its
 * fields with `param.field` (and nested `param.child.field`) via the same INDEX
 * lowering as any in-script struct. Nested objects recurse; array/scalar/bytes field
 * values encode as their normal ArgValue forms.
 */
export interface ArgObject {
    [key: string]: ArgValue;
}
export type ArgsLayoutKind = 'scalar' | 'bytes';
export interface ArgsLayoutSlot {
    /** main() parameter position this slot feeds (slot i ↔ arg i, in order). */
    arg: number;
    kind: ArgsLayoutKind;
    /** Byte offset within the payload args (composite CALLDATA offset = programLength + offset). */
    offset: number;
    /** Slot byte length (32 for scalars; the fixed compile-time length for bytes). */
    length: number;
}
export interface ArgsLayout {
    /** Args transport: per-execution values ride the instruction payload, read via CALLDATA. */
    mode: 'calldata';
    /** Compiled program byte length L — arg i lives at composite offset L + slots[i].offset. */
    programLength: number;
    /** Total payload-arg bytes (slots laid out back to back, no padding). */
    byteLength: number;
    slots: ArgsLayoutSlot[];
}
export interface CompileOptions {
    label?: string;
    baseDirs?: string[];
    contracts?: ContractsConfig;
    args?: ArgValue[];
    /**
     * Bytecode target: 'v1' (prefix, Solidity interpreter), 'v12' (postfix, Huff runtime) or
     * 'svm' (postfix v12 dialect for the Solana engine — same assembler/opcodes, divergent
     * call/storage lowering; the result carries an accountPlan). Default 'v1'.
     */
    target?: CompileTarget;
    /**
     * Target 'svm' only: compile for STAGED execution (execute_from_account).
     * Compile-time `args` are not baked into the bytecode — the prologue reads
     * them from the instruction payload via CALLDATA (see the staged arg ABI
     * above) so one staged buffer serves every per-execution argument set. User
     * refs intern from index 0 (no reserved accounts); msg.data is rejected (the
     * prologue owns the single CALLDATA). The result carries `argsLayout`, the
     * contract the SDK encodes execute payload args against.
     */
    staged?: boolean;
    /**
     * Transform an imported SOURCE module's text before parsing — e.g. strip TypeScript types.
     * Receives (code, absoluteFilePath); return plain JS. Only invoked for source-file function
     * imports (`import { fn } from "./mod"`), never for `.json` contract ABIs. Callers importing
     * `.ts`/`.sauce.ts` modules supply this (the recipes pass `ts.transpileModule`); plain `.js`
     * /`.sauce` modules need no transform.
     */
    transformModule?: (code: string, filePath: string) => string;
    /**
     * Drop every function NOT reachable from main() (after compile-time constant folding) so an
     * imported-but-unreferenced function — or a handler behind a statically-false branch — is not
     * emitted. Default false (every declared/imported function is emitted, the legacy behaviour).
     */
    treeshake?: boolean;
    /**
     * Compile-time constants (name → value) used for conditional compilation: an `if`/ternary/
     * `&&`/`||` whose condition folds to a known value emits only the taken branch, so a guarded
     * protocol handler call (`if (HAS_CURVE) curve(...)`) vanishes when its flag is false — and
     * with `treeshake`, the now-unreferenced handler is dropped from the bytecode. Booleans map to
     * 1n/0n. Top-level `const X = <literal>` in the program are folded the same way.
     */
    defines?: Record<string, bigint | boolean | number>;
}
export interface CompileResult {
    bytecode: Uint8Array[];
    warnings: string[];
    /** target 'svm' only: ordered user-account plan (metas[i] = user-account index i). */
    accountPlan?: AccountPlan;
    /** target 'svm' + staged only: the payload-args layout the SDK encodes execute args against. */
    argsLayout?: ArgsLayout;
}
export declare function compile(source: string, options?: CompileOptions): CompileResult;
//# sourceMappingURL=index.d.ts.map