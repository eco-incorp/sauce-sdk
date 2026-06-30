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

export { Saucer } from './saucer/saucer.js';
export { V12Saucer } from './saucer/saucer-v12.js';
export type { SaucerLike, OutputSpec } from './saucer/saucer-like.js';
export { CompilerContext } from './context.js';
export type { CompileTarget } from './context.js';
export { OPS } from './saucer/ops.js';
export { OPS_V12 } from './saucer/ops-v12.js';

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

export interface CompileOptions {
  label?: string;
  baseDirs?: string[];
  contracts?: ContractsConfig;
  args?: ArgValue[];
  /** Bytecode target: 'v1' (prefix, Solidity interpreter) or 'v12' (postfix, Huff runtime). Default 'v1'. */
  target?: CompileTarget;
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

  const ast = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowReturnOutsideFunction: true,
  });

  const ctx = new CompilerContext(options.baseDirs, options.contracts, target);
  ctx.transformModule = options.transformModule;
  ctx.treeshake = options.treeshake ?? false;

  if (options.defines) ctx.setDefines(options.defines);

  if (options.args && options.args.length > 0) {
    ctx.mainArgTypes = options.args.map(inferArgType);
  }

  const saucers = processNode(ast, ctx);

  if (target === 'v12') {
    // v12 assembles every function into a single blob. The runtime entry pushes
    // only a stack-bottom sentinel and jumps to offset 0 — it does NOT marshal
    // main()'s parameters onto the stack. So when args are supplied, we synthesize
    // a no-param WRAPPER entry that pushes the args and CALL_FUNCTIONs the original
    // main (now a normal table function whose params arrive via the call frame) —
    // the v12 analogue of v1's appended [CALL_FUNCTION, mainIndex, argCount, …args].
    return { bytecode: [assembleV12(ctx, options.args ?? [])], warnings: ctx.warnings };
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

function assembleV12(ctx: CompilerContext, args: ArgValue[]): Uint8Array {
  const meta: FunctionMeta[] = ctx.funcMeta;
  const mainMeta = meta.find((m) => m.isMain);

  if (!mainMeta) throw new Error('missing main() function');

  // With compile-time args, main becomes a normal table function called by a
  // synthesized no-param wrapper entry (see the wrapper path below). Without args,
  // main is the entry itself (the runtime jumps to offset 0) — preserved exactly.
  if (args.length > 0) {
    return assembleV12WithArgs(ctx, mainMeta, meta, args);
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
): Uint8Array {
  // Prologue: push each arg (postfix, forward order so arg0 is deepest = paramIndex 0).
  const argBytes = args.map((a) => encodeArgValueV12(ctx, a)._bytes);
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
