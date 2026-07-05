import * as acorn from 'acorn';
import { processNode } from './processor/index.js';
import {
  CompilerContext,
  type ElementType,
  type VariableKind,
  type CompileTarget,
  type FunctionMeta,
} from './context.js';
import { OPS } from './saucer/ops.js';
import { OPS_V12 } from './saucer/ops-v12.js';
import { encodeInt } from './saucer/integer.js';
import { encodeBytes } from './saucer/bytes.js';
import { concatBytes, V12Saucer } from './saucer/saucer-v12.js';
import type { RefPlaceholder, CallPlaceholder } from './saucer/saucer-v12.js';
import type { ContractsConfig } from './contracts.js';
import { estimatePacket, PAYER_REF, STAGED_ARGS_REF } from './planner/index.js';
import type { AccountPlan } from './planner/index.js';

export { Saucer } from './saucer/saucer.js';
export { V12Saucer } from './saucer/saucer-v12.js';
export type { SaucerLike, OutputSpec } from './saucer/saucer-like.js';
export { CompilerContext } from './context.js';
export type { CompileTarget } from './context.js';
export { OPS } from './saucer/ops.js';
export { OPS_V12 } from './saucer/ops-v12.js';
export { SVM_UNSUPPORTED } from './saucer/svm-profile.js';
export { estimatePacket, stagingTransactionCount, PAYER_REF, STAGED_ARGS_REF } from './planner/index.js';
export type { AccountMeta, AccountPlan, PacketBudget, PacketBudgetOptions, PacketMode } from './planner/index.js';

export type {
  AbiParameter,
  AbiFunction,
  AbiItem,
  Abi,
  ContractConfig,
  ContractsConfig,
  ContractInfo,
} from './contracts.js';

export type ArgValue = bigint | string | ArgValue[];

// ── staged svm arg ABI ──
//
// A staged program (target 'svm', staged: true) does NOT bake compile-time args
// into the blob — restaging 16 KB to change one amount is the exact failure the
// buffer split exists to avoid. Instead the assembly prologue reads each arg
// from the caller's ARGS PDA (user-tail account index 0 by SDK convention, the
// one engine-owned account bytecode may SSTORE at offsets ≥ 32) and pushes it
// exactly where the inline arg-prologue would have:
//
//   scalar arg (bigint): one 32-byte slot, u256 LITTLE-ENDIAN (byte 0 least
//     significant — the Solana-native field order CAST_LE consumes);
//     prologue emits [len=32][offset][index=0][SLOAD][CAST_LE] → scalar.
//   bytes arg (hex string): the raw bytes at the slot, length fixed at compile
//     time; the region stride pads to the next 32-byte boundary;
//     prologue emits [len][offset][index=0][SLOAD] → Bytes descriptor.
//   array args: unsupported in staged mode (ABI-encode to a bytes arg and
//     abi.decode on-chain instead).
//
// Slots are laid out in arg order from ARGS_REGION_OFFSET (32). The SDK writer
// (executeStaged's same-tx inline SSTORE instruction) encodes values with this
// exact layout — argsLayout on the CompileResult is the writer's contract.

export type ArgsLayoutKind = 'scalar' | 'bytes';

export interface ArgsLayoutSlot {
  /** main() parameter position this slot feeds (slot i ↔ arg i, in order). */
  arg: number;
  kind: ArgsLayoutKind;
  /** Absolute byte offset in the args PDA account data (≥ 32). */
  offset: number;
  /** Bytes the staged prologue SLOADs at `offset` (32 for scalars). */
  length: number;
}

export interface ArgsLayout {
  /** User-tail account index of the args PDA (staged convention: 0). */
  accountIndex: number;
  /** First bytecode-writable byte of the args PDA (the engine's ARGS_REGION_OFFSET). */
  regionOffset: number;
  /** Total arg-region bytes consumed (32-byte-strided slots). */
  byteLength: number;
  slots: ArgsLayoutSlot[];
}

/** Mirrors the engine's ARGS_REGION_OFFSET — the args PDA's protected 32-byte header word. */
const ARGS_REGION_OFFSET = 32;
/** Mirrors the engine's arg region size (PDA_ARGS_BYTES − ARGS_REGION_OFFSET). */
const ARGS_REGION_BYTES = 8192;

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
   * them from the args PDA (see the staged arg ABI above) so one staged buffer
   * serves every per-execution argument set; the account plan reserves user
   * index 0 for the args PDA and index 1 for the payer signer; CALLDATA
   * (msg.data) emission is rejected. The result carries `argsLayout`, the
   * writer contract for the SDK's same-tx args instruction.
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
  /** target 'svm' + staged only: the args-PDA slot layout the SDK writer encodes against. */
  argsLayout?: ArgsLayout;
}

function inferArgType(v: ArgValue): { kind: VariableKind; elementType?: ElementType } {
  if (typeof v === 'bigint') return { kind: 'scalar' };

  if (typeof v === 'string') return { kind: 'dynamic' }; // hex bytes

  if (Array.isArray(v)) {
    // Infer element type from first element
    if (v.length > 0) {
      const inner = inferArgType(v[0]);

      return { kind: 'dynamic', elementType: { kind: inner.kind, element: inner.elementType } };
    }

    return { kind: 'dynamic' };
  }

  return { kind: 'scalar' };
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const target: CompileTarget = options.target ?? 'v1';
  const staged = options.staged ?? false;

  if (staged && target !== 'svm') {
    throw new Error(`staged compilation requires target 'svm', got '${target}'`);
  }

  const ast = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowReturnOutsideFunction: true,
  });

  const ctx = new CompilerContext(options.baseDirs, options.contracts, target);
  ctx.transformModule = options.transformModule;
  ctx.treeshake = options.treeshake ?? false;
  ctx.setStaged(staged);

  if (staged) {
    // Staged account-plan convention: the args PDA at user index 0 (the staged
    // arg-prologue bakes SLOADs against it) and the payer signer at index 1
    // (both execute paths require an in-list signer). Reserved BEFORE
    // processing so user refs intern from index 2; both refs are reserved
    // words in staged mode — user code interning them lands on these slots.
    ctx.reserveAccount(STAGED_ARGS_REF, { writable: true });
    ctx.reserveAccount(PAYER_REF, { signer: true });
  }

  if (options.defines) ctx.setDefines(options.defines);

  if (options.args && options.args.length > 0) {
    ctx.mainArgTypes = options.args.map(inferArgType);
  }

  const saucers = processNode(ast, ctx);

  if (target !== 'v1') {
    // v12 (and its svm dialect) assembles every function into a single blob. The
    // runtime entry pushes only a stack-bottom sentinel and jumps to offset 0 — it
    // does NOT marshal main()'s parameters onto the stack. So when args are supplied,
    // we synthesize a no-param WRAPPER entry that pushes the args and CALL_FUNCTIONs
    // the original main (now a normal table function whose params arrive via the call
    // frame) — the v12 analogue of v1's appended [CALL_FUNCTION, mainIndex, argCount, …args].
    // In staged svm mode the prologue does not PUSH literal values — it SLOADs each
    // arg from the args PDA per argsLayout (same count, order, and stack shape).
    const argsLayout = staged ? buildArgsLayout(options.args ?? []) : undefined;
    const bytecode = [assembleV12(ctx, options.args ?? [], argsLayout)];

    if (target === 'svm') {
      // The account plan is the interned-ref registry in first-use order (empty
      // metas for pure-compute programs or raw-index programs). The packet-budget
      // check runs with default send options (fee payer + plan-declared signers,
      // the reserved 'payer' ref counted as the fee payer, no lookup tables, no
      // prepends) and is non-fatal — its warnings ride along with the compile
      // warnings. Staged compiles are budgeted against the execute_from_account
      // packet shape (hash-pin data, buffer account, 65,535-byte code ceiling).
      const accountPlan = ctx.buildAccountPlan();
      const budget = estimatePacket(accountPlan, bytecode[0].length, { mode: staged ? 'staged' : 'inline' });

      return {
        bytecode,
        warnings: [...ctx.warnings, ...budget.warnings],
        accountPlan,
        ...(argsLayout ? { argsLayout } : {}),
      };
    }

    return { bytecode, warnings: ctx.warnings };
  }

  const bytecodes = saucers.map((saucer) => saucer.build());

  if (options.args && options.args.length > 0) {
    const mainIndex = ctx.getFunc('main');
    const argBytes = options.args.map(encodeArgValue);
    const argsFlat = argBytes.reduce((acc, bytes) => new Uint8Array([...acc, ...bytes]), new Uint8Array());
    bytecodes.push(new Uint8Array([OPS.CALL_FUNCTION, mainIndex, options.args.length, ...argsFlat]));
  }

  return {
    bytecode: bytecodes,
    warnings: ctx.warnings,
  };
}

// ── v12 assembly: [main][STOP][func0][FUNC_RETURN][func1][FUNC_RETURN]… ──
//
// CALL_FUNCTION sentinels (0xFF00|index, recorded as callPositions) are patched
// to each helper's absolute byte offset; parameter-read SDUP sentinels (recorded
// as refPositions) are patched to a concrete SDUPn from the tracked stack depth.

function patchCalls(
  bc: Uint8Array,
  calls: CallPlaceholder[],
  funcOffsets: (number | undefined)[],
  posShift = 0,
  mainIndex = -1,
): void {
  for (const { pos, funcIndex } of calls) {
    // funcOffsets maps a function's REGISTRY index to its absolute body offset.
    // main has no body offset — it is the entry (no-arg path) or inlined behind the
    // arg-prologue (with-args path), so a main() self-call can't be resolved.
    const offset = funcOffsets[funcIndex];

    if (offset === undefined) {
      if (funcIndex === mainIndex) {
        throw new Error(`cannot resolve CALL_FUNCTION target (index ${funcIndex}); calling main() is not supported`);
      }

      throw new Error(`cannot resolve CALL_FUNCTION target (index ${funcIndex}); no body offset recorded`);
    }

    bc[pos + posShift] = (offset >> 8) & 0xff;
    bc[pos + posShift + 1] = offset & 0xff;
  }
}

function patchSdup(bc: Uint8Array, position: number, realPos: number): void {
  if (realPos < 1 || realPos > 16) throw new Error(`REF position out of range: ${realPos}`);

  bc[position] = OPS_V12.SDUP1 + realPos - 1;
}

/**
 * Lays the staged arg slots out in arg order from ARGS_REGION_OFFSET, one
 * 32-byte-strided slot per arg (see the staged arg ABI doc above).
 */
function buildArgsLayout(args: ArgValue[]): ArgsLayout {
  const slots: ArgsLayoutSlot[] = [];
  let offset = ARGS_REGION_OFFSET;

  args.forEach((value, arg) => {
    if (Array.isArray(value)) {
      throw new Error(
        `staged svm args do not support array values (arg ${arg}); ABI-encode the collection into a bytes arg and abi.decode it on-chain`,
      );
    }

    if (typeof value === 'string') {
      const length = hexToBytes(value).length;

      slots.push({ arg, kind: 'bytes', offset, length });
      offset += Math.ceil(length / 32) * 32;

      return;
    }

    slots.push({ arg, kind: 'scalar', offset, length: 32 });
    offset += 32;
  });

  const byteLength = offset - ARGS_REGION_OFFSET;

  if (byteLength > ARGS_REGION_BYTES) {
    throw new Error(`staged svm args need ${byteLength} bytes; the args PDA region holds ${ARGS_REGION_BYTES}`);
  }

  return { accountIndex: 0, regionOffset: ARGS_REGION_OFFSET, byteLength, slots };
}

/**
 * The staged arg-prologue read for one slot: [len][offset][index 0][SLOAD]
 * pushes the slot's bytes as a Bytes descriptor off the args PDA; scalars add
 * CAST_LE (the slot ABI is u256 little-endian). Net stack effect +1 per arg —
 * identical shape to the inline literal push it replaces, so SDUP patching and
 * the arg order contract (arg0 deepest) are untouched.
 */
function stagedArgRead(ctx: CompilerContext, layout: ArgsLayout, slot: ArgsLayoutSlot): V12Saucer {
  const read = new V12Saucer(ctx).svmAccountData(
    new V12Saucer(ctx).int(BigInt(layout.accountIndex)),
    new V12Saucer(ctx).int(BigInt(slot.offset)),
    new V12Saucer(ctx).int(BigInt(slot.length)),
  );

  return slot.kind === 'scalar' ? new V12Saucer(ctx).castLe(read) : read;
}

function assembleV12(ctx: CompilerContext, args: ArgValue[], argsLayout?: ArgsLayout): Uint8Array {
  const meta: FunctionMeta[] = ctx.funcMeta;
  const mainMeta = meta.find((m) => m.isMain);

  if (!mainMeta) throw new Error('missing main() function');

  // With compile-time args, main becomes a normal table function called by a
  // synthesized no-param wrapper entry (see the wrapper path below). Without args,
  // main is the entry itself (the runtime jumps to offset 0) — preserved exactly.
  if (args.length > 0) {
    return assembleV12WithArgs(ctx, mainMeta, meta, args, argsLayout);
  }

  const helpers = meta.filter((m) => !m.isMain); // function-index order (0..n-1)
  const main = mainMeta.saucer;
  // main carries its own ALLOCATE_VALUE/ALLOCATE_HEAP prefix declaring its frame
  // stride to the runtime (the runtime strides per call by the caller's declared slot
  // count, default 0), so a main→helper call strides past main's slots and the callee's
  // frame can't alias/clobber them. ALLOCATE is stack-neutral, so the prefix shifts only
  // BYTE positions (by mainPrefixLen) — SDUP depths are unchanged.
  const { bytes: mainBc, prefixLen: mainPrefixLen } = main.buildMain();
  const mainIndex = ctx.getFunc('main');

  // Main params are pre-pushed by the runtime, so no frame-pointer offset; shift
  // recorded positions past the ALLOCATE prefix.
  const patchMainRefs = (bc: Uint8Array, refs: RefPlaceholder[]): void => {
    for (const r of refs) patchSdup(bc, r.position + mainPrefixLen, r.depth + mainMeta.paramCount - r.paramIndex);
  };

  if (helpers.length === 0) {
    // No helper bodies to jump to: any CALL_FUNCTION here is a main() self-call,
    // which patchCalls rejects (empty offset table) rather than emit corrupt bytes.
    patchCalls(mainBc, main.callPositions, [], mainPrefixLen, mainIndex);
    patchMainRefs(mainBc, main.refPositions);

    return mainBc;
  }

  const built = helpers.map((h) => {
    const saucer = h.saucer;
    const bc = saucer.buildFunctionBody();

    return { meta: h, saucer, bc, prefixLen: bc.length - saucer._bytes.length };
  });

  // Helper registry indices are 0..n-1 (main is registered last, index n); main is
  // the entry here so its slot stays undefined (a main self-call is unsupported).
  const funcOffsets: (number | undefined)[] = [];
  let off = mainBc.length + 1;
  for (const h of built) {
    funcOffsets.push(off);
    off += h.bc.length + 1;
  }

  patchCalls(mainBc, main.callPositions, funcOffsets, mainPrefixLen, mainIndex);
  patchMainRefs(mainBc, main.refPositions);

  for (const h of built) {
    // Helper bodies sit behind an ALLOCATE prefix, so shift recorded positions.
    patchCalls(h.bc, h.saucer.callPositions, funcOffsets, h.prefixLen);
    for (const r of h.saucer.refPositions) {
      // Helpers are entered via CALL_FUNCTION (+1 frame-pointer word on the stack).
      patchSdup(h.bc, r.position + h.prefixLen, r.depth + 1 + h.meta.paramCount - r.paramIndex);
    }
  }

  const parts: (Uint8Array | number[])[] = [mainBc, [OPS.STOP]];
  for (const h of built) parts.push(h.bc, [OPS_V12.FUNC_RETURN]);

  return concatBytes(parts);
}

// ── v12 arg-prologue path: [arg pushes][main body][STOP][helper][FUNC_RETURN]… ──
//
// A synthesized no-param ENTRY pushes the compile-time args, then main's body is
// INLINED right after (fall-through) — main reads its params straight off the stack
// with the MAIN SDUP formula (depth + paramCount - paramIndex), NO call frame.
//
// Why inline rather than CALL_FUNCTION the original main: a CALL_FUNCTION frame adds
// a frame-pointer word ABOVE the params (the helper +1), so a main reading its first
// param under ~7 live locals lands at SDUP17 — past the EVM DUP16 ceiling. Falling
// through with the args already on the stack keeps the deepest read at SDUP16. The
// args sit above the runtime's stack-bottom sentinel; main never reads below them.
// (main therefore can't be recursive — it's inlined, not a table entry — which is
// fine: v1 likewise cannot call main, and recipes never recurse main.)
function assembleV12WithArgs(
  ctx: CompilerContext,
  mainMeta: FunctionMeta,
  meta: FunctionMeta[],
  args: ArgValue[],
  argsLayout?: ArgsLayout,
): Uint8Array {
  // Prologue: push each arg (postfix, forward order so arg0 is deepest = paramIndex 0).
  // Inline: literal pushes of the compile-time values. Staged: SLOAD(+CAST_LE)
  // reads off the args PDA per argsLayout — same count, order, and net +1 per arg.
  const argBytes = argsLayout
    ? argsLayout.slots.map((slot) => stagedArgRead(ctx, argsLayout, slot)._bytes)
    : args.map((a) => encodeArgValueV12(ctx, a)._bytes);
  const prologue = concatBytes(argBytes);
  const prologueLen = prologue.length;

  const main = mainMeta.saucer;
  // main carries its ALLOCATE_VALUE/ALLOCATE_HEAP prefix (frame-stride declaration)
  // AND the result-MSTORE. The prefix sits AFTER the arg prologue (which already
  // pushed the args) and BEFORE main's body; ALLOCATE is stack-neutral so the args
  // and SDUP depths are untouched — only main's byte positions shift by mainPrefixLen.
  // Without it, a main→helper call would stride by the default 0 and the callee's
  // frame would alias/clobber main's slots from base 0.
  const { bytes: mainBody, prefixLen: mainPrefixLen } = main.buildMain();
  const helpers = meta.filter((m) => !m.isMain); // registry indices 0..n-1

  const built = helpers.map((h) => {
    const saucer = h.saucer;
    const bc = saucer.buildFunctionBody();

    return { meta: h, saucer, bc, prefixLen: bc.length - saucer._bytes.length };
  });

  // funcOffsets keyed by registry index (helpers 0..n-1; main is inlined so its slot
  // stays undefined — a main self-call is unsupported, same as the no-arg path).
  const funcOffsets: (number | undefined)[] = [];
  let off = prologueLen + mainBody.length + 1; // after [prologue][main body (+ALLOCATE)][STOP]
  for (const h of built) {
    funcOffsets[ctx.getFunc(h.meta.name)] = off;
    off += h.bc.length + 1; // body + FUNC_RETURN
  }

  // main's sentinels are patched in its own standalone array; shift recorded positions
  // past the ALLOCATE prefix. main reads params with the MAIN formula — the args are
  // directly on the stack, no frame-pointer word. main is inlined (not a table entry),
  // so a main() self-call is unsupported.
  patchCalls(mainBody, main.callPositions, funcOffsets, mainPrefixLen, ctx.getFunc('main'));
  for (const r of main.refPositions) {
    patchSdup(mainBody, r.position + mainPrefixLen, r.depth + mainMeta.paramCount - r.paramIndex);
  }

  // Helpers are entered via CALL_FUNCTION → +1 frame-pointer word.
  for (const h of built) {
    patchCalls(h.bc, h.saucer.callPositions, funcOffsets, h.prefixLen);
    for (const r of h.saucer.refPositions) {
      patchSdup(h.bc, r.position + h.prefixLen, r.depth + 1 + h.meta.paramCount - r.paramIndex);
    }
  }

  const parts: (Uint8Array | number[])[] = [prologue, mainBody, [OPS.STOP]];
  for (const h of built) parts.push(h.bc, [OPS_V12.FUNC_RETURN]);

  return concatBytes(parts);
}

// Postfix arg encoder mirroring `encodeArgValue` (the v1 prefix form) but emitting
// V12 builder ops: scalar → int push, hex string → bytes, array → tuple(elems).
// Built via the V12Saucer methods so the runtime decodes args identically to how
// the compiler builds the same values inline (nested tuples recurse).
function encodeArgValueV12(ctx: CompilerContext, v: ArgValue): V12Saucer {
  if (Array.isArray(v)) {
    return new V12Saucer(ctx).tuple(v.map((el) => encodeArgValueV12(ctx, el)));
  }

  if (typeof v === 'string') return new V12Saucer(ctx).bytes(hexToBytes(v));

  return new V12Saucer(ctx).int(typeof v === 'bigint' ? v : BigInt(v));
}

function encodeArgValue(v: ArgValue): Uint8Array {
  if (Array.isArray(v)) {
    const elements = v.map((el) => encodeArgValue(el));
    const flat = elements.reduce((acc, bytes) => new Uint8Array([...acc, ...bytes]), new Uint8Array());

    return new Uint8Array([OPS.TUPLE, elements.length, ...flat]);
  }

  if (typeof v === 'string') return encodeBytes(hexToBytes(v));

  return encodeInt(typeof v === 'bigint' ? v : BigInt(v));
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}
