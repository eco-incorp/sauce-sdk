import type {
  Statement,
  VariableDeclaration,
  Expression,
  IfStatement,
  BlockStatement,
  ConditionalExpression,
  ForStatement,
  WhileStatement,
  UpdateExpression,
  AssignmentExpression,
  MemberExpression,
  ArrayPattern,
  CallExpression,
} from 'acorn';
import type { SaucerLike } from '../saucer/index.js';
import { isImmutablePackedArray } from '../saucer/index.js';
import type { CompilerContext, ElementType } from '../context.js';
import type { AbiParameter } from '../contracts.js';
import { processExpression, processStatement } from './index.js';
import {
  applyBinaryOp,
  resolveContractCallTarget,
  emitRawContractCall,
  resolveCatchChain,
  abiDecodeTypeSpecs,
} from './expression.js';
import { evalConstBool } from './const-eval.js';
import {
  inferKindWithContext,
  inferElementTypeWithContext,
  inferStructTypeWithContext,
  getPropertyName,
  lookupStructType,
  getFieldIndex,
  abiOutputKind,
} from './inference.js';

export function processVariableDeclaration(
  decl: VariableDeclaration,
  ctx: CompilerContext,
  saucer: SaucerLike,
): SaucerLike {
  if (decl.kind === 'var') {
    throw new Error('var is not supported, use const or let');
  }

  return decl.declarations.reduce((acc, declarator) => {
    if (!declarator.init) {
      throw new Error('const declarations must be initialized');
    }

    if (declarator.id.type === 'ArrayPattern') {
      return processDestructuringDeclaration(declarator.id as ArrayPattern, declarator.init, ctx, acc);
    }

    if (declarator.id.type !== 'Identifier') {
      throw new Error(`not implemented: ${declarator.id.type}`);
    }

    return storeExpression(declarator.id.name, declarator.init, ctx, acc);
  }, saucer);
}

/**
 * `const [price, tick] = pool.slot0()` — ONE external call whose RAW returndata
 * lands in a hidden heap temp, then per bound element
 * `STORE(name, INDEX(ABI_DECODE(count, READ(temp), specs), i))`.
 *
 * The tuple descriptor is freshly derived by ABI_DECODE at every use and never
 * stored: a decoded tuple does not survive a variable round-trip on the deployed
 * (immutable) v1 engines — INDEX then faults with SauceInvalidOperationArgs —
 * while raw heap bytes round-trip fine (the same shape the catch parameter uses).
 * The identical lowering works on v12; the in-engine re-decode per element is
 * negligible next to the ~2.6K-gas staticcall it replaces.
 */
function processDestructuringDeclaration(
  pattern: ArrayPattern,
  init: Expression,
  ctx: CompilerContext,
  saucer: SaucerLike,
): SaucerLike {
  if (init.type === 'CallExpression' && resolveCatchChain(init as CallExpression)) {
    throw new Error(
      'cannot destructure a .catch() chain — a catch handler cannot capture call outputs; destructure the bare call instead',
    );
  }

  const target = resolveContractCallTarget(init, ctx);

  if (!target) {
    throw new Error(
      'array destructuring requires a contract method call initializer, e.g. const [a, b] = Pool.at(addr).slot0()',
    );
  }

  const label = `${target.contract.name}.${target.methodName}()`;
  const outputs = target.method.outputs ?? [];

  if (outputs.length === 0) {
    throw new Error(`cannot destructure ${label}: it returns no outputs`);
  }

  if (pattern.elements.length > outputs.length) {
    throw new Error(
      `cannot destructure ${outputs.length} output(s) of ${label} into ${pattern.elements.length} element(s)`,
    );
  }

  const bindings: { name: string; index: number }[] = [];

  pattern.elements.forEach((element, index) => {
    if (!element) return; // hole (`const [, tick] = …`) — skip this output

    if (element.type === 'RestElement') {
      throw new Error('not implemented: rest element in array destructuring');
    }

    if (element.type !== 'Identifier') {
      throw new Error(`not implemented: ${element.type} in array destructuring`);
    }

    const output = outputs[index];

    if (output.type === 'tuple') {
      throw new Error(
        `cannot destructure output ${index}${output.name ? ` ('${output.name}')` : ''} of ${label}: ` +
          `a nested tuple cannot be stored in a variable — leave a hole and read its fields via chained ` +
          `indexing (…${target.methodName}(…)[${index}][j])`,
      );
    }

    bindings.push({ name: element.name, index });
  });

  // Derived once for the whole tuple (throws on unsupported ABI output types
  // exactly like a normally-decoded call would).
  const typeSpecs = abiDecodeTypeSpecs(outputs);

  // The one external call. Emitted even when every element is a hole — the call
  // may have side effects. `#tmpN` cannot collide with a parsed identifier.
  const temp = ctx.freshTemp('dynamic');
  let result = saucer.store(temp, emitRawContractCall(target, ctx), 'dynamic');

  for (const { name, index } of bindings) {
    const output = outputs[index];
    const decoded = ctx.newSaucer().abiDecode(outputs.length, ctx.newSaucer().read(temp), typeSpecs);
    const value = ctx.newSaucer().index(decoded, ctx.newSaucer().int(BigInt(index)));

    result = result.store(name, value, abiOutputKind(output), destructuredElementType(output));
  }

  return result;
}

/**
 * Element type for a destructured array component, so later `name[i]` reads infer
 * the right kind. Only the top level is resolved; deeper nesting stays dynamic
 * (safe — heap values round-trip).
 */
function destructuredElementType(output: AbiParameter): ElementType | undefined {
  if (!output.type.endsWith('[]')) return undefined;

  const inner = output.type.slice(0, -2);

  if (inner.endsWith(']') || inner === 'tuple' || inner === 'bytes' || inner === 'string') {
    return { kind: 'dynamic' };
  }

  return { kind: 'scalar' };
}

export function processIfStatement(stmt: IfStatement, ctx: CompilerContext, saucer: SaucerLike): SaucerLike {
  // Conditional compilation: when folding is enabled and the test folds to a known
  // boolean, emit ONLY the taken branch (and recurse into an `else if` chain). This
  // mirrors collectCalls() EXACTLY (same evalConstBool prune, nothing else), so the
  // CALL targets the emitter emits == the set treeshake walks — every emitted call
  // therefore targets a registered function.
  if (ctx.foldEnabled) {
    const taken = evalConstBool(stmt.test, ctx);

    if (taken === true) return saucer.join(processBlock(stmt.consequent, ctx));

    if (taken === false) {
      if (!stmt.alternate) return saucer;

      return stmt.alternate.type === 'IfStatement'
        ? processIfStatement(stmt.alternate as IfStatement, ctx, saucer)
        : saucer.join(processBlock(stmt.alternate, ctx));
    }
  }

  const condition = processExpression(stmt.test, ctx);
  const thenBody = processBlock(stmt.consequent, ctx);

  if (!stmt.alternate) {
    return saucer.if(condition).then(thenBody);
  }

  const elseBody =
    stmt.alternate.type === 'IfStatement'
      ? processIfStatement(stmt.alternate as IfStatement, ctx, ctx.newSaucer())
      : processBlock(stmt.alternate, ctx);

  return saucer.if(condition).then(thenBody).else(elseBody);
}

export function processBlock(node: Statement, ctx: CompilerContext): SaucerLike {
  if (node.type === 'BlockStatement') {
    return (node as BlockStatement).body.reduce((saucer, stmt) => processStatement(stmt, ctx, saucer), ctx.newSaucer());
  }

  return processStatement(node, ctx, ctx.newSaucer());
}

export function processForStatement(stmt: ForStatement, ctx: CompilerContext, saucer: SaucerLike): SaucerLike {
  ctx.pushScope();

  const init = stmt.init
    ? stmt.init.type === 'VariableDeclaration'
      ? processVariableDeclaration(stmt.init as VariableDeclaration, ctx, ctx.newSaucer())
      : processMutation(stmt.init as Expression, ctx, ctx.newSaucer())
    : undefined;

  const condition = stmt.test ? processExpression(stmt.test, ctx) : undefined;

  ctx.pushLoop();
  const body = processBlock(stmt.body, ctx);
  const update = stmt.update ? processMutation(stmt.update, ctx, ctx.newSaucer()) : undefined;
  ctx.popLoop();

  ctx.popScope();

  return saucer.for(init, condition, update).loop(body);
}

export function processWhileStatement(stmt: WhileStatement, ctx: CompilerContext, saucer: SaucerLike): SaucerLike {
  const condition = processExpression(stmt.test, ctx);

  ctx.pushLoop();
  const body = processBlock(stmt.body, ctx);
  ctx.popLoop();

  return saucer.while(condition).loop(body);
}

export function storeExpression(name: string, expr: Expression, ctx: CompilerContext, saucer: SaucerLike): SaucerLike {
  switch (expr.type) {
    case 'ConditionalExpression':
      return processTernaryStore(name, expr as ConditionalExpression, ctx, saucer);
    case 'UpdateExpression':
      return processUpdateStore(name, expr as UpdateExpression, ctx, saucer);
    default: {
      const value = processExpression(expr, ctx);

      const result = saucer.store(
        name,
        value,
        inferKindWithContext(expr, ctx),
        inferElementTypeWithContext(expr, ctx),
        inferStructTypeWithContext(expr, ctx),
      );
      // Track whether the variable now holds an immutable packed array literal, so
      // a later `name[i] = x` can be rejected before it reverts on the engine.
      const variable = ctx.getVar(name);

      if (variable) {
        variable.immutablePacked = isImmutablePackedArray(value._bytes);
        // Metadata only (bytes above are untouched): on v1, remember that the
        // variable was assigned a multi-output call result — a later indexed
        // read of it would fault INDEX at runtime, so it is rejected at compile
        // time (processIndexAccess) with a pointer at destructuring. Cleared on
        // any other assignment so a reassigned variable indexes normally again.
        variable.multiOutputCall = undefined;

        if (!ctx.isV12 && expr.type === 'CallExpression' && !resolveCatchChain(expr as CallExpression)) {
          // Pure probe — resolveContractCallTarget emits nothing (addr is lazy).
          const target = resolveContractCallTarget(expr, ctx);

          if (target && (target.method.outputs?.length ?? 0) > 1) {
            variable.multiOutputCall = target.method.outputs;
          }
        }
      }

      ctx.consumePendingContractBinding(name);

      return result;
    }
  }
}

function processTernaryStore(
  name: string,
  expr: ConditionalExpression,
  ctx: CompilerContext,
  saucer: SaucerLike,
): SaucerLike {
  // Conditional compilation (mirrors processIfStatement / collectCalls): a const-known
  // test stores ONLY the taken side, so a guarded handler call in the untaken side is
  // never emitted (and treeshake then drops it).
  if (ctx.foldEnabled) {
    const taken = evalConstBool(expr.test, ctx);

    if (taken !== undefined) return storeExpression(name, taken ? expr.consequent : expr.alternate, ctx, saucer);
  }

  const condition = processExpression(expr.test, ctx);
  const consequent = processExpression(expr.consequent, ctx);
  const alternate = processExpression(expr.alternate, ctx);
  const thenStore = ctx.newSaucer().store(name, consequent);
  const elseStore = ctx.newSaucer().store(name, alternate);

  // Recompute (don't leave stale): the variable is immutable-packed only if a
  // branch actually stores a packed array literal — clear it otherwise so a later
  // `name[i] = x` isn't wrongly rejected.
  const variable = ctx.getVar(name);

  if (variable) {
    variable.immutablePacked = isImmutablePackedArray(consequent._bytes) || isImmutablePackedArray(alternate._bytes);
  }

  return saucer.if(condition).then(thenStore).else(elseStore);
}

function processUpdateStore(
  name: string,
  expr: UpdateExpression,
  ctx: CompilerContext,
  saucer: SaucerLike,
): SaucerLike {
  if (expr.argument.type !== 'Identifier') {
    throw new Error(`not implemented: update on ${expr.argument.type}`);
  }

  const target = expr.argument.name;
  const s = ctx.newSaucer();
  const incremented = expr.operator === '++' ? s.add(s.read(target), s.int(1n)) : s.sub(s.read(target), s.int(1n));
  const assign = (saucer: SaucerLike) => saucer.store(name, ctx.newSaucer().read(target));
  const update = (saucer: SaucerLike) => saucer.store(target, incremented);
  const result = expr.prefix ? assign(update(saucer)) : update(assign(saucer));

  // An increment result is always a scalar, never a packed literal — clear any
  // stale flag from a prior array-literal assignment to `name`.
  const variable = ctx.getVar(name);

  if (variable) variable.immutablePacked = false;

  return result;
}

export function processMutation(expr: Expression, ctx: CompilerContext, saucer: SaucerLike): SaucerLike {
  switch (expr.type) {
    case 'UpdateExpression':
      return processUpdateMutation(expr as UpdateExpression, ctx, saucer);
    case 'AssignmentExpression':
      return processAssignmentMutation(expr as AssignmentExpression, ctx, saucer);
    case 'CallExpression': {
      // Side-effect function calls (e.g. emit) can be used as statements. The
      // result is discarded, so drop it — on v12 a value-returning call would
      // otherwise leak onto the stack (dropIfUnused is a no-op on v1).
      return saucer.join(processExpression(expr, ctx).dropIfUnused());
    }
    default:
      throw new Error(`not implemented: ${expr.type} as statement`);
  }
}

function processUpdateMutation(expr: UpdateExpression, ctx: CompilerContext, saucer: SaucerLike): SaucerLike {
  if (expr.argument.type !== 'Identifier') {
    throw new Error(`not implemented: update on ${expr.argument.type}`);
  }

  const name = expr.argument.name;
  const s = ctx.newSaucer();
  const value = expr.operator === '++' ? s.add(s.read(name), s.int(1n)) : s.sub(s.read(name), s.int(1n));

  return saucer.store(name, value);
}

function processAssignmentMutation(expr: AssignmentExpression, ctx: CompilerContext, saucer: SaucerLike): SaucerLike {
  if (expr.left.type === 'MemberExpression') {
    return processMemberAssignment(expr.left as MemberExpression, expr, ctx, saucer);
  }

  if (expr.left.type !== 'Identifier') {
    throw new Error(`not implemented: assignment to ${expr.left.type}`);
  }

  const name = (expr.left as { name: string }).name;

  if (expr.operator === '=') return storeExpression(name, expr.right, ctx, saucer);

  const s = ctx.newSaucer();
  const value = applyBinaryOp(s, expr.operator.slice(0, -1), s.read(name), processExpression(expr.right, ctx));

  return saucer.store(name, value);
}

// Element/field assignment: `arr[i] = x`, `obj.field = x` and their compound forms.
// Lowers to STORE(name, SET_INDEX(readArr, index, value)) (the saucer's read/store
// pick slot-memory vs stack-param access per target).
function processMemberAssignment(
  member: MemberExpression,
  expr: AssignmentExpression,
  ctx: CompilerContext,
  saucer: SaucerLike,
): SaucerLike {
  if (member.object.type !== 'Identifier') {
    throw new Error(`not implemented: assignment to ${member.object.type} member`);
  }

  const name = (member.object as { name: string }).name;
  const target = ctx.getVar(name);

  if (!target) throw new Error(`undefined variable: ${name}`);

  // Same hazard as the indexed read (processIndexAccess): the stored value lost
  // its tuple descriptor on v1, so SET_INDEX faults at runtime — reject early.
  if (target.multiOutputCall) {
    throw new Error(
      `cannot assign to a component of '${name}': a multi-output call result stored in a variable loses its ` +
        `tuple on the v1 engine — destructure the call instead: const [a, b] = …`,
    );
  }

  // A static packed array literal is immutable — the engine reverts SET_INDEX on
  // it. Reject element assignment at compile time and point at the mutable path.
  if (target.immutablePacked) {
    throw new Error(
      `cannot assign to an element of '${name}': array literals are immutable (packed); ` +
        `create a mutable array with new Array(n) instead`,
    );
  }

  // Simple assignment: the index feeds only the SET_INDEX write, so there is no
  // reuse hazard — compute it once and store.
  if (expr.operator === '=') {
    const index = resolveMemberIndex(member, ctx);

    return saucer.store(
      name,
      ctx.newSaucer().setIndex(ctx.newSaucer().read(name), index, processExpression(expr.right, ctx)),
    );
  }

  // Compound assignment (`+=`, `-=`, …): the index feeds BOTH the INDEX read and
  // the SET_INDEX write. A builder node emits its bytecode wherever it is reused,
  // so a side-effecting computed index (`arr[f()] += 1`) would execute twice.
  // Hoist a non-pure computed index into a scratch local so it runs exactly once.
  const op = expr.operator.slice(0, -1);

  if (member.computed && !isPureIndex(member.property as Expression)) {
    const tmp = ctx.freshTemp();
    const withIndex = saucer.store(tmp, processExpression(member.property as Expression, ctx));
    const current = ctx.newSaucer().index(ctx.newSaucer().read(name), ctx.newSaucer().read(tmp));
    const value = applyBinaryOp(ctx.newSaucer(), op, current, processExpression(expr.right, ctx));

    return withIndex.store(
      name,
      ctx.newSaucer().setIndex(ctx.newSaucer().read(name), ctx.newSaucer().read(tmp), value),
    );
  }

  // Pure computed index (identifier / literal / arithmetic) or struct field: the
  // index is side-effect-free and idempotent, so reusing the node is safe and
  // keeps the common-case bytecode minimal.
  const readArr = ctx.newSaucer().read(name);
  const index = resolveMemberIndex(member, ctx);
  const current = ctx.newSaucer().index(readArr, index);
  const value = applyBinaryOp(ctx.newSaucer(), op, current, processExpression(expr.right, ctx));

  return saucer.store(name, ctx.newSaucer().setIndex(readArr, index, value));
}

// Whether an index expression is safe to emit more than once: no observable side
// effects and idempotent. Conservative — only literals, variable reads and pure
// arithmetic of those qualify; calls, `new`, member reads and anything unknown
// fall through to false and get hoisted into a temp.
function isPureIndex(node: Expression): boolean {
  switch (node.type) {
    case 'Literal':
    case 'Identifier':
      return true;
    case 'BinaryExpression':
      return isPureIndex(node.left as Expression) && isPureIndex(node.right as Expression);
    default:
      return false;
  }
}

// The index for a member assignment: computed `arr[i]` → the property expression;
// field `obj.field` → the field's slot looked up from the object's known shape.
function resolveMemberIndex(member: MemberExpression, ctx: CompilerContext): SaucerLike {
  if (member.computed) return processExpression(member.property as Expression, ctx);

  const field = getPropertyName(member);

  if (!field) throw new Error('unsupported member assignment target');

  const structType = lookupStructType(member, ctx);

  if (!structType) throw new Error(`property '${field}' assignment not supported, use array indexing arr[i]`);

  return ctx.newSaucer().int(BigInt(getFieldIndex(structType, field)));
}
