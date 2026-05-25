import * as acorn from 'acorn';
import { processNode } from './processor/index.js';
import { CompilerContext, type ElementType, type VariableKind } from './context.js';
import { OPS } from './saucer/ops.js';
import { encodeInt } from './saucer/integer.js';
import { encodeBytes } from './saucer/bytes.js';
import type { ContractsConfig } from './contracts.js';

export { Saucer } from './saucer/saucer.js';
export type { OutputSpec } from './saucer/saucer.js';
export { CompilerContext } from './context.js';
export { OPS } from './saucer/ops.js';

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
  const ast = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowReturnOutsideFunction: true,
  });

  const ctx = new CompilerContext(options.baseDirs, options.contracts);

  if (options.args && options.args.length > 0) {
    ctx.mainArgTypes = options.args.map(inferArgType);
  }

  const saucers = processNode(ast, ctx);
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
