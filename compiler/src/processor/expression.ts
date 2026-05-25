import type {
  Expression,
  Literal,
  UnaryExpression,
  BinaryExpression,
  LogicalExpression,
  CallExpression,
  MemberExpression,
  NewExpression,
  ArrowFunctionExpression,
  Statement,
  TaggedTemplateExpression,
  TemplateElement,
} from 'acorn';
import { Saucer, OPS } from '../saucer/index.js';
import type { AbiParameter, ContractInfo } from '../contracts.js';
import { hexToBytes } from '../contracts.js';
import type { CompilerContext, VariableKind } from '../context.js';
import { processExpression } from './index.js';
import { processBlock } from './statement.js';
import {
  resolveStaticMethod,
  resolveInstanceMethod,
  getPropertyName,
  lookupStructType,
  getFieldIndex,
  inferKindWithContext,
} from './inference.js';
import { processUint8Array } from './collection.js';
import { GLOBALS, GLOBAL_FUNCTIONS } from '../globals.js';
import { compile } from '../index.js';

export function processLiteral(literal: Literal, saucer: Saucer): Saucer {
  switch (typeof literal.value) {
    case 'number':
      if (!Number.isInteger(literal.value)) {
        throw new Error('floating point numbers are not supported');
      }

      return saucer.int(BigInt(literal.raw ?? literal.value));
    case 'bigint':
      return saucer.int(literal.value);
    case 'boolean':
      return saucer.int(literal.value ? 1n : 0n);
    case 'string':
      return saucer.string(literal.value);
    default:
      throw new Error(`not implemented: ${typeof literal.value} literal`);
  }
}

export function literalToInt(literal: Literal): bigint {
  switch (typeof literal.value) {
    case 'number':
      if (!Number.isInteger(literal.value)) {
        throw new Error('floating point numbers are not supported');
      }

      return BigInt(literal.raw ?? literal.value);
    case 'bigint':
      return literal.value;
    case 'boolean':
      return literal.value ? 1n : 0n;
    default:
      throw new Error(`not implemented: ${typeof literal.value} literal`);
  }
}

export function isLiteralZero(expr: Expression): boolean {
  if (expr.type !== 'Literal') return false;

  const lit = expr as Literal;

  return lit.value === 0 || lit.value === 0n;
}

export function processUnaryExpression(expr: UnaryExpression, ctx: CompilerContext, saucer: Saucer): Saucer {
  switch (expr.operator) {
    case '!':
      return saucer.not(processExpression(expr.argument as Expression, ctx));
    case '-': {
      if (expr.argument.type !== 'Literal') throw new Error(`not implemented: unary - on ${expr.argument.type}`);

      return saucer.int(-literalToInt(expr.argument as Literal));
    }
    case '~':
      return saucer.bitNot(processExpression(expr.argument as Expression, ctx));
    default:
      throw new Error(`not implemented: unary ${expr.operator}`);
  }
}

export function applyBinaryOp(saucer: Saucer, op: string, left: Saucer, right: Saucer): Saucer {
  switch (op) {
    case '+':
      return saucer.add(left, right);
    case '-':
      return saucer.sub(left, right);
    case '*':
      return saucer.mul(left, right);
    case '/':
      return saucer.div(left, right);
    case '%':
      return saucer.mod(left, right);
    case '**':
      return saucer.exp(left, right);
    case '&':
      return saucer.bitAnd(left, right);
    case '|':
      return saucer.bitOr(left, right);
    case '^':
      return saucer.bitXor(left, right);
    case '<<':
      return saucer.shl(left, right);
    case '>>':
      return saucer.shr(left, right);
    default:
      throw new Error(`not implemented: operator ${op}`);
  }
}

export function processBinaryExpression(expr: BinaryExpression, ctx: CompilerContext, saucer: Saucer): Saucer {
  const left = processExpression(expr.left as Expression, ctx);
  const right = processExpression(expr.right as Expression, ctx);

  switch (expr.operator) {
    case '===':
      return isLiteralZero(expr.right) ? saucer.isZero(left) : saucer.eq(left, right);
    case '!==':
      return isLiteralZero(expr.right) ? saucer.isNotZero(left) : saucer.neq(left, right);
    case '>':
      return saucer.gt(left, right);
    case '<':
      return saucer.lt(left, right);
    case '>=':
      return saucer.gte(left, right);
    case '<=':
      return saucer.lte(left, right);
    case '>>>':
      throw new Error('use >> instead of >>>');
    case '==':
      throw new Error('use === instead of ==');
    case '!=':
      throw new Error('use !== instead of !=');
    default:
      return applyBinaryOp(saucer, expr.operator, left, right);
  }
}

const processStaticMethod = (
  method: [string, string],
  expr: CallExpression,
  ctx: CompilerContext,
  saucer: Saucer,
): Saucer => {
  const [object, property] = method;
  const entry = GLOBALS[object]?.[property];

  if (!entry || entry.compile.length === 1) throw new Error(`not implemented: ${object}.${property}`);

  return (entry.compile as (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => Saucer)(
    saucer,
    expr.arguments as Expression[],
    (e: Expression) => processExpression(e, ctx),
  );
};

const BINDING_METHODS: Record<string, 'static' | 'delegate' | undefined> = {
  at: undefined, // auto-detect from ABI
  view: 'static', // force STATIC
  lib: 'delegate', // force DELEGATE
};

interface InlineChainInfo {
  contractName: string;
  bindMethod: string;
  addressExpr: Expression;
  methodName: string;
  args: Expression[];
}

function resolveInlineChain(expr: CallExpression): InlineChainInfo | undefined {
  if (expr.callee.type !== 'MemberExpression') return;

  const outerMember = expr.callee as MemberExpression;

  if (outerMember.property.type !== 'Identifier') return;

  const methodName = (outerMember.property as { name: string }).name;

  if (outerMember.object.type !== 'CallExpression') return;

  const innerCall = outerMember.object as CallExpression;

  if (innerCall.callee.type !== 'MemberExpression') return;

  const innerMember = innerCall.callee as MemberExpression;

  if (innerMember.object.type !== 'Identifier' || innerMember.property.type !== 'Identifier') return;

  const contractName = (innerMember.object as { name: string }).name;
  const bindMethod = (innerMember.property as { name: string }).name;

  if (!(bindMethod in BINDING_METHODS)) return;

  if (innerCall.arguments.length !== 1) return;

  return {
    contractName,
    bindMethod,
    addressExpr: innerCall.arguments[0] as Expression,
    methodName,
    args: expr.arguments as Expression[],
  };
}

function processContractCall(
  contract: ContractInfo,
  methodName: string,
  args: Expression[],
  ctx: CompilerContext,
  saucer: Saucer,
  addrSaucer: Saucer,
  callTypeOverride?: 'static' | 'delegate',
  skipOutput?: boolean,
): Saucer {
  const method = contract.methods.get(methodName);

  if (!method) {
    throw new Error(`Unknown method "${methodName}" on contract "${contract.name}"`);
  }

  if (args.length !== method.inputs.length) {
    throw new Error(`${contract.name}.${methodName}() expects ${method.inputs.length} argument(s), got ${args.length}`);
  }

  const s = new Saucer(ctx);
  const selectorBytes = hexToBytes(method.selector);

  const processedArgs = args.map((arg) => processExpression(arg, ctx));

  const calldata =
    processedArgs.length === 0
      ? s.bytes(selectorBytes)
      : s.concat([s.bytes(selectorBytes), s.abiEncode(s.tuple(processedArgs))]);

  const effectiveCallType =
    callTypeOverride ?? (method.stateMutability === 'view' || method.stateMutability === 'pure' ? 'static' : undefined);

  const outputSpecs = !skipOutput && method.outputs?.length ? abiDecodeTypeSpecs(method.outputs) : undefined;
  const output = outputSpecs ? { count: method.outputs!.length, typeSpecs: outputSpecs } : undefined;

  switch (effectiveCallType) {
    case 'static':
      return saucer.staticCall(addrSaucer, calldata, output);
    case 'delegate':
      return saucer.delegateCall(addrSaucer, calldata, output);
    default:
      return saucer.externalCall(addrSaucer, s.int(0n), calldata, output);
  }
}

interface CatchChainInfo {
  innerCall: CallExpression;
  handlerBody: Statement;
  paramName?: string;
}

function resolveCatchChain(expr: CallExpression): CatchChainInfo | undefined {
  if (expr.callee.type !== 'MemberExpression') return;

  const member = expr.callee as MemberExpression;

  if (member.property.type !== 'Identifier' || (member.property as { name: string }).name !== 'catch') return;

  if (member.object.type !== 'CallExpression') return;

  if (expr.arguments.length !== 1) return;

  const handler = expr.arguments[0];

  if (handler.type !== 'ArrowFunctionExpression' && handler.type !== 'FunctionExpression') return;

  const fn = handler as ArrowFunctionExpression;

  if (fn.params.length > 1) {
    throw new Error('catch handler takes at most one parameter');
  }

  let paramName: string | undefined;

  if (fn.params.length === 1) {
    const param = fn.params[0];

    if (param.type !== 'Identifier') {
      throw new Error('catch parameter must be an identifier');
    }

    paramName = (param as { name: string }).name;
  }

  return {
    innerCall: member.object as CallExpression,
    handlerBody: fn.body as Statement,
    paramName,
  };
}

function declareCatchParam(paramName: string | undefined, ctx: CompilerContext): void {
  if (paramName && !ctx.getVar(paramName)) {
    ctx.setVar(paramName, 'dynamic');
  }
}

function buildCatchSaucer(
  callOnly: Saucer,
  handler: Saucer,
  paramName: string | undefined,
  ctx: CompilerContext,
  saucer: Saucer,
): Saucer {
  if (!paramName) {
    // No parameter — emit call directly with catch
    return new Saucer(ctx, new Uint8Array([...saucer._bytes, ...callOnly._bytes])).catch(handler);
  }

  // Wrap call with store: [prefix] WRITE_HEAP <e_slot> [CALL bytes] CATCH <skip> <handler>
  // store() handles slot tracking, the CALL result (dynamicResult) is captured into e
  return saucer.store(paramName, callOnly, 'dynamic').catch(handler);
}

function processCatchCall(info: CatchChainInfo, ctx: CompilerContext, saucer: Saucer): Saucer {
  const { innerCall, handlerBody, paramName } = info;

  // Declare catch parameter early so handler body can reference it
  declareCatchParam(paramName, ctx);

  // Process the inner contract call without output decoding (CATCH must follow CALL directly)
  const inlineChain = resolveInlineChain(innerCall);

  if (inlineChain) {
    const { contractName, bindMethod, addressExpr, methodName, args: chainArgs } = inlineChain;
    const contract = ctx.lookupContract(contractName);

    if (!contract) throw new Error(`Unknown contract: ${contractName}`);

    const addrSaucer = processExpression(addressExpr, ctx);
    // Build CALL with empty prefix so we get just the call bytes
    const callOnly = processContractCall(
      contract,
      methodName,
      chainArgs,
      ctx,
      new Saucer(ctx),
      addrSaucer,
      BINDING_METHODS[bindMethod],
      true,
    );
    const handler = processBlock(handlerBody, ctx);

    return buildCatchSaucer(callOnly, handler, paramName, ctx, saucer);
  }

  // Variable-bound: token.transfer(to, amount).catch(() => { ... })
  const boundCatch = resolveVariableBoundCatch(innerCall, handlerBody, paramName, ctx, saucer);

  if (boundCatch) return boundCatch;

  // Raw call builtins: contract.call(addr, value, data).catch(() => { ... })
  const rawCallCatch = resolveRawCallCatch(innerCall, handlerBody, paramName, ctx, saucer);

  if (rawCallCatch) return rawCallCatch;

  throw new Error('.catch() can only be used on contract calls');
}

function resolveVariableBoundCatch(
  innerCall: CallExpression,
  handlerBody: Statement,
  paramName: string | undefined,
  ctx: CompilerContext,
  saucer: Saucer,
): Saucer | undefined {
  if (innerCall.callee.type !== 'MemberExpression') return;

  const member = innerCall.callee as MemberExpression;

  if (member.object.type !== 'Identifier' || member.property.type !== 'Identifier') return;

  const objectName = (member.object as { name: string }).name;
  const propertyName = (member.property as { name: string }).name;
  const bound = ctx.lookupBoundContract(objectName);

  if (!bound) return;

  const addrSaucer = new Saucer(ctx).read(objectName);
  const callOnly = processContractCall(
    bound.contract,
    propertyName,
    innerCall.arguments as Expression[],
    ctx,
    new Saucer(ctx),
    addrSaucer,
    bound.callTypeOverride,
    true,
  );
  const handler = processBlock(handlerBody, ctx);

  return buildCatchSaucer(callOnly, handler, paramName, ctx, saucer);
}

const RAW_CALL_METHODS = new Set(['call', 'static', 'delegate']);

function resolveRawCallCatch(
  innerCall: CallExpression,
  handlerBody: Statement,
  paramName: string | undefined,
  ctx: CompilerContext,
  saucer: Saucer,
): Saucer | undefined {
  if (innerCall.callee.type !== 'MemberExpression') return;

  const member = innerCall.callee as MemberExpression;

  if (member.object.type !== 'Identifier' || member.property.type !== 'Identifier') return;

  const objectName = (member.object as { name: string }).name;
  const propertyName = (member.property as { name: string }).name;

  if (objectName !== 'contract' || !RAW_CALL_METHODS.has(propertyName)) return;

  const entry = GLOBALS[objectName]?.[propertyName];

  if (!entry) return;

  const callOnly = (entry.compile as (s: Saucer, a: Expression[], p: (e: Expression) => Saucer) => Saucer)(
    new Saucer(ctx),
    innerCall.arguments as Expression[],
    (e: Expression) => processExpression(e, ctx),
  );
  const handler = processBlock(handlerBody, ctx);

  return buildCatchSaucer(callOnly, handler, paramName, ctx, saucer);
}

function resolveVariableBoundCall(expr: CallExpression, ctx: CompilerContext, saucer: Saucer): Saucer | undefined {
  if (expr.callee.type !== 'MemberExpression') return;

  const member = expr.callee as MemberExpression;

  if (member.object.type !== 'Identifier' || member.property.type !== 'Identifier') return;

  const objectName = (member.object as { name: string }).name;
  const propertyName = (member.property as { name: string }).name;
  const bound = ctx.lookupBoundContract(objectName);

  if (!bound) return;

  const addrSaucer = new Saucer(ctx).read(objectName);

  return processContractCall(
    bound.contract,
    propertyName,
    expr.arguments as Expression[],
    ctx,
    saucer,
    addrSaucer,
    bound.callTypeOverride,
  );
}

function resolveStandaloneBinding(expr: CallExpression, ctx: CompilerContext): Saucer | undefined {
  if (expr.callee.type !== 'MemberExpression') return;

  const member = expr.callee as MemberExpression;

  if (member.object.type !== 'Identifier' || member.property.type !== 'Identifier') return;

  const objectName = (member.object as { name: string }).name;
  const propertyName = (member.property as { name: string }).name;

  if (!(propertyName in BINDING_METHODS)) return;

  const contract = ctx.lookupContract(objectName);

  if (!contract) return;

  if (expr.arguments.length !== 1) throw new Error(`${contract.name}.${propertyName}() requires exactly 1 argument`);

  ctx.setPendingContractBinding(contract.name, BINDING_METHODS[propertyName]);

  return processExpression(expr.arguments[0] as Expression, ctx);
}

export const processCallExpression = (expr: CallExpression, ctx: CompilerContext, saucer: Saucer): Saucer => {
  // Pattern: .catch(handler) — ERC20.at(addr).transfer(to, amount).catch(() => { ... })
  const catchInfo = resolveCatchChain(expr);

  if (catchInfo) {
    return processCatchCall(catchInfo, ctx, saucer);
  }

  // Pattern A: Inline chain — ERC20.at(addr).transfer(to, amount)
  const inlineChain = resolveInlineChain(expr);

  if (inlineChain) {
    const { contractName, bindMethod, addressExpr, methodName, args: chainArgs } = inlineChain;
    const contract = ctx.lookupContract(contractName);

    if (!contract) throw new Error(`Unknown contract: ${contractName}`);

    const addrSaucer = processExpression(addressExpr, ctx);

    return processContractCall(contract, methodName, chainArgs, ctx, saucer, addrSaucer, BINDING_METHODS[bindMethod]);
  }

  const staticMethod = resolveStaticMethod(expr);

  if (staticMethod) return processStaticMethod(staticMethod, expr, ctx, saucer);

  // Pattern B: Variable-bound — token.transfer(to, amount)
  const variableBound = resolveVariableBoundCall(expr, ctx, saucer);

  if (variableBound) return variableBound;

  // Pattern C: Standalone binding — ERC20.at(addr) / ERC20.view(addr) / ERC20.lib(addr)
  const standaloneBinding = resolveStandaloneBinding(expr, ctx);

  if (standaloneBinding) return standaloneBinding;

  const instance = resolveInstanceMethod(expr);

  if (instance) return processInstanceMethod(instance, expr, ctx, saucer);

  if (expr.callee.type !== 'Identifier') {
    throw new Error(`not implemented: non identifier call expression`);
  }

  const ctxFn = GLOBAL_FUNCTIONS[expr.callee.name];

  if (ctxFn) {
    return (ctxFn.compile as (s: Saucer, args: Expression[], process: (e: Expression) => Saucer) => Saucer)(
      saucer,
      expr.arguments as Expression[],
      (e: Expression) => processExpression(e, ctx),
    );
  }

  const args = expr.arguments.map((arg) => processExpression(arg as Expression, ctx));

  return saucer.callFunction(expr.callee.name, args);
};

export function processLogicalExpression(expr: LogicalExpression, ctx: CompilerContext, saucer: Saucer): Saucer {
  const left = processExpression(expr.left, ctx);
  const right = processExpression(expr.right, ctx);

  switch (expr.operator) {
    case '&&':
      return saucer.and(left, right);
    case '||':
      return saucer.or(left, right);
    default:
      throw new Error(`not implemented: operator ${expr.operator}`);
  }
}

// Field access (e.g. `obj.name`) compiles to INDEX into a tuple.
// The INDEX result is dynamic data that must live on the heap, but we're in the
// middle of compiling an expression — we can't emit a WRITE_HEAP side-effect inline.
// So we defer a store to a temp variable and return a READ_HEAP of that temp.
const processFieldAccess = (expr: MemberExpression, field: string, ctx: CompilerContext, saucer: Saucer): Saucer => {
  const structType = lookupStructType(expr, ctx);

  if (!structType) throw new Error(`property '${field}' access not supported, use array indexing arr[i]`);

  return saucer.index(
    processExpression(expr.object as Expression, ctx),
    new Saucer(ctx).int(BigInt(getFieldIndex(structType, field))),
  );
};

const processIndexAccess = (expr: MemberExpression, ctx: CompilerContext, saucer: Saucer): Saucer =>
  saucer.index(processExpression(expr.object as Expression, ctx), processExpression(expr.property as Expression, ctx));

export const processMemberExpression = (expr: MemberExpression, ctx: CompilerContext, saucer: Saucer): Saucer => {
  const property = getPropertyName(expr);

  if (property && expr.object.type === 'Identifier') {
    const entry = GLOBALS[(expr.object as { name: string }).name]?.[property];

    if (entry?.compile.length === 1) return (entry.compile as (s: Saucer) => Saucer)(saucer);
  }

  if (property === 'length') return saucer.length(processExpression(expr.object as Expression, ctx));

  if (property) return processFieldAccess(expr, property, ctx, saucer);

  return processIndexAccess(expr, ctx, saucer);
};

export const processNewExpression = (expr: NewExpression, ctx: CompilerContext, saucer: Saucer): Saucer => {
  if (expr.callee.type !== 'Identifier') throw new Error(`not implemented: new ${expr.callee.type}`);

  const name = (expr.callee as { name: string }).name;

  if (name !== 'Uint8Array') throw new Error(`not implemented: new ${name}`);

  return processUint8Array(expr, saucer);
};

const processInstanceMethod = (
  instance: { method: string; object: Expression },
  expr: CallExpression,
  ctx: CompilerContext,
  saucer: Saucer,
): Saucer => {
  const receiver = processExpression(instance.object, ctx);

  switch (instance.method) {
    case 'concat': {
      const args = expr.arguments.map((a) => processExpression(a as Expression, ctx));

      return saucer.concat([receiver, ...args]);
    }
    case 'slice': {
      if (expr.arguments.length !== 2) throw new Error('.slice() expects exactly 2 arguments (start, end)');

      const start = processExpression(expr.arguments[0] as Expression, ctx);
      const end = processExpression(expr.arguments[1] as Expression, ctx);

      return saucer.slice(receiver, start, new Saucer(ctx).sub(end, start));
    }
    default:
      throw new Error(`not implemented: .${instance.method}()`);
  }
};

const ABI_TYPE_SPECS: Record<string, number> = {
  bool: OPS.BYTE_1,
  address: OPS.BYTE_20,
  bytes: OPS.BYTES,
  string: OPS.BYTES,
  ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`uint${(i + 1) * 8}`, OPS.BYTE_1 + i])),
  ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`int${(i + 1) * 8}`, OPS.BYTE_1 + i])),
};

function resolveAbiParamTypeSpec(param: AbiParameter): number[] {
  let { type, components } = param;

  if (type === 'tuple') {
    const inner = (components ?? []).flatMap(resolveAbiParamTypeSpec);

    return [OPS.TUPLE, (components ?? []).length, ...inner];
  }

  if (type === 'tuple[]') {
    const inner = (components ?? []).flatMap(resolveAbiParamTypeSpec);

    return [OPS.ARRAY, OPS.TUPLE, (components ?? []).length, ...inner];
  }

  const result = [];
  while (type.endsWith('[]')) {
    type = type.slice(0, -2);
    result.push(OPS.ARRAY);
  }

  const spec = ABI_TYPE_SPECS[type];

  if (!spec) throw new Error(`unknown ABI type: '${type}'`);

  result.push(spec);

  return result;
}

export function abiDecodeTypeSpecs(params: AbiParameter[]): number[] {
  return params.flatMap(resolveAbiParamTypeSpec);
}

// --- $ tagged template inline implementation ---

// Sentinel prefix for scalar placeholders (32-byte constants)
const SCALAR_SENTINEL_PREFIX = 0xdead5a0c01n;
// Sentinel prefix bytes for dynamic placeholders (8-byte arrays)
const DYNAMIC_SENTINEL_PREFIX = [0xde, 0xad, 0x5a, 0x0c, 0x02];

function generateScalarSentinel(index: number): bigint {
  return (SCALAR_SENTINEL_PREFIX << 216n) | BigInt(index);
}

function generateDynamicSentinel(index: number): number[] {
  return [...DYNAMIC_SENTINEL_PREFIX, 0x00, 0x00, index];
}

function sentinelToSource(index: number, kind: VariableKind): string {
  if (kind === 'scalar') {
    const value = generateScalarSentinel(index);

    return `0x${value.toString(16).padStart(64, '0')}n`;
  }

  const bytes = generateDynamicSentinel(index);

  return `Uint8Array.from([${bytes.map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}])`;
}

function scalarSentinelPattern(index: number): Uint8Array {
  const value = generateScalarSentinel(index);
  const bytes = new Uint8Array(33);
  bytes[0] = OPS.BYTE_32;
  for (let i = 0; i < 32; i++) {
    bytes[1 + i] = Number((value >> BigInt((31 - i) * 8)) & 0xffn);
  }

  return bytes;
}

function dynamicSentinelPattern(index: number): Uint8Array {
  const sentinel = generateDynamicSentinel(index);

  return new Uint8Array([OPS.BYTES, sentinel.length, ...sentinel]);
}

function findPattern(haystack: Uint8Array, needle: Uint8Array): number {
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }

    if (match) return i;
  }

  return -1;
}

function splitBySentinels(bytecodes: Uint8Array, kinds: VariableKind[]): Uint8Array[] {
  const segments: Uint8Array[] = [];
  let remaining = bytecodes;

  for (let i = 0; i < kinds.length; i++) {
    const needle = kinds[i] === 'scalar' ? scalarSentinelPattern(i) : dynamicSentinelPattern(i);
    const pos = findPattern(remaining, needle);

    if (pos === -1) {
      throw new Error(`$\`...\`: could not find placeholder ${i} in compiled bytecodes`);
    }

    segments.push(remaining.slice(0, pos));
    remaining = remaining.slice(pos + needle.length);
  }

  segments.push(remaining);

  return segments;
}

function encodeScalarAsBytecode(expr: Saucer, ctx: CompilerContext): Saucer {
  // Produces [BYTE_32][32 bytes of value] at runtime via:
  // CONCAT(BYTES([0x20]), ABI_ENCODE(TUPLE(1, expr)))
  return new Saucer(ctx).concat([
    new Saucer(ctx).bytes(new Uint8Array([OPS.BYTE_32])),
    new Saucer(ctx).abiEncode(new Saucer(ctx).tuple([expr])),
  ]);
}

function encodeDynamicAsBytecode(expr: Saucer, ctx: CompilerContext): Saucer {
  // Produces [BYTES_2][len_hi][len_lo][data...] at runtime via:
  // CONCAT(BYTES([0x91]), SLICE(ABI_ENCODE(TUPLE(1, LENGTH(expr))), 30, 2), expr)
  const lengthSaucer = new Saucer(ctx).length(expr);
  const lengthEncoded = new Saucer(ctx).abiEncode(new Saucer(ctx).tuple([lengthSaucer]));
  const length2Bytes = new Saucer(ctx).slice(lengthEncoded, new Saucer(ctx).int(30n), new Saucer(ctx).int(2n));

  return new Saucer(ctx).concat([new Saucer(ctx).bytes(new Uint8Array([OPS.BYTES_2])), length2Bytes, expr]);
}

export function processTaggedTemplateExpression(
  expr: TaggedTemplateExpression,
  ctx: CompilerContext,
  saucer: Saucer,
): Saucer {
  // Verify tag is $
  if (expr.tag.type !== 'Identifier' || (expr.tag as { name: string }).name !== '$') {
    throw new Error('tagged template expressions must use $`...`');
  }

  const quasis = expr.quasi.quasis as TemplateElement[];
  const expressions = expr.quasi.expressions as Expression[];

  // No expressions — compile as a static program and return bytes
  if (expressions.length === 0) {
    const source = quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
    const wrappedSource = /function\s+main\s*\(/.test(source) ? source : `function main() { ${source} }`;
    const { bytecode } = compile(wrappedSource, {
      baseDirs: ctx.resolvedBaseDirs,
      contracts: ctx.contractsConfig,
    });

    return new Saucer(ctx, new Uint8Array([...saucer._bytes, ...new Saucer(ctx).bytes(bytecode[0])._bytes]));
  }

  // Determine kind of each interpolation expression
  const kinds = expressions.map((e) => inferKindWithContext(e, ctx));

  // Build inner source by joining quasis with sentinel literal values
  let innerSource = '';
  for (let i = 0; i < quasis.length; i++) {
    innerSource += quasis[i].value.cooked ?? quasis[i].value.raw;

    if (i < expressions.length) {
      innerSource += sentinelToSource(i, kinds[i]);
    }
  }

  // Wrap in function main() if needed
  const wrappedSource = /function\s+main\s*\(/.test(innerSource) ? innerSource : `function main() { ${innerSource} }`;

  // Compile inner source — contracts from outer scope are available
  const { bytecode } = compile(wrappedSource, {
    baseDirs: ctx.resolvedBaseDirs,
    contracts: ctx.contractsConfig,
  });
  const innerBytes = bytecode[0];

  // Split bytecodes at sentinel positions
  const segments = splitBySentinels(innerBytes, kinds);

  // Process outer expressions in the outer context
  const outerExprs = expressions.map((e) => processExpression(e, ctx));

  // Build CONCAT: interleave static segments with encoded outer expressions
  const concatParts: Saucer[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].length > 0) {
      concatParts.push(new Saucer(ctx).bytes(segments[i]));
    }

    if (i < outerExprs.length) {
      concatParts.push(
        kinds[i] === 'scalar'
          ? encodeScalarAsBytecode(outerExprs[i], ctx)
          : encodeDynamicAsBytecode(outerExprs[i], ctx),
      );
    }
  }

  // Single segment, no CONCAT needed
  if (concatParts.length === 1) {
    return new Saucer(ctx, new Uint8Array([...saucer._bytes, ...concatParts[0]._bytes]));
  }

  return saucer.concat(concatParts);
}
