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
import type { V12Saucer, RefPlaceholder, CallPlaceholder } from './saucer/saucer-v12.js';
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

  if (options.args && options.args.length > 0) {
    ctx.mainArgTypes = options.args.map(inferArgType);
  }

  const saucers = processNode(ast, ctx);

  if (target === 'v12') {
    // v12 assembles every function into a single blob; args are provided to main
    // on the EVM stack by the runtime, not appended as an invocation segment.
    return { bytecode: [assembleV12(ctx)], warnings: ctx.warnings };
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

function concatBytes(parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }

  return out;
}

function patchCalls(bc: Uint8Array, calls: CallPlaceholder[], funcOffsets: number[], posShift = 0): void {
  for (const { pos, funcIndex } of calls) {
    if (funcIndex >= funcOffsets.length) continue;

    const offset = funcOffsets[funcIndex];
    bc[pos + posShift] = (offset >> 8) & 0xff;
    bc[pos + posShift + 1] = offset & 0xff;
  }
}

function patchSdup(bc: Uint8Array, position: number, realPos: number): void {
  if (realPos < 1 || realPos > 16) throw new Error(`REF position out of range: ${realPos}`);

  bc[position] = OPS_V12.SDUP1 + realPos - 1;
}

function assembleV12(ctx: CompilerContext): Uint8Array {
  const meta: FunctionMeta[] = ctx.funcMeta;
  const mainMeta = meta.find((m) => m.isMain);

  if (!mainMeta) throw new Error('missing main() function');

  const helpers = meta.filter((m) => !m.isMain); // function-index order (0..n-1)
  const main = mainMeta.saucer as V12Saucer;
  const mainBc = main.build();

  // Main params are pre-pushed by the runtime, so no frame-pointer offset.
  const patchMainRefs = (bc: Uint8Array, refs: RefPlaceholder[]): void => {
    for (const r of refs) patchSdup(bc, r.position, r.depth + mainMeta.paramCount - r.paramIndex);
  };

  if (helpers.length === 0) {
    patchMainRefs(mainBc, main.refPositions);

    return mainBc;
  }

  const built = helpers.map((h) => {
    const saucer = h.saucer as V12Saucer;
    const bc = saucer.buildFunctionBody();

    return { meta: h, saucer, bc, prefixLen: bc.length - saucer._bytes.length };
  });

  // Absolute offsets: main + STOP, then each helper + FUNC_RETURN.
  const funcOffsets: number[] = [];
  let off = mainBc.length + 1;
  for (const h of built) {
    funcOffsets.push(off);
    off += h.bc.length + 1;
  }

  patchCalls(mainBc, main.callPositions, funcOffsets);
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
