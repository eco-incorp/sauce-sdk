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
} from 'acorn';
import type { SaucerLike } from '../saucer/index.js';
import type { CompilerContext } from '../context.js';
import { processExpression, processStatement } from './index.js';
import { applyBinaryOp } from './expression.js';
import {
  inferKindWithContext,
  inferElementTypeWithContext,
  inferStructTypeWithContext,
  getPropertyName,
  lookupStructType,
  getFieldIndex,
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
    if (declarator.id.type !== 'Identifier') {
      throw new Error(`not implemented: ${declarator.id.type}`);
    }

    if (!declarator.init) {
      throw new Error('const declarations must be initialized');
    }

    return storeExpression(declarator.id.name, declarator.init, ctx, acc);
  }, saucer);
}

export function processIfStatement(stmt: IfStatement, ctx: CompilerContext, saucer: SaucerLike): SaucerLike {
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
  const condition = processExpression(expr.test, ctx);
  const s = ctx.newSaucer();
  const thenStore = s.store(name, processExpression(expr.consequent, ctx));
  const elseStore = ctx.newSaucer().store(name, processExpression(expr.alternate, ctx));

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

  return expr.prefix ? assign(update(saucer)) : update(assign(saucer));
}

export function processMutation(expr: Expression, ctx: CompilerContext, saucer: SaucerLike): SaucerLike {
  switch (expr.type) {
    case 'UpdateExpression':
      return processUpdateMutation(expr as UpdateExpression, ctx, saucer);
    case 'AssignmentExpression':
      return processAssignmentMutation(expr as AssignmentExpression, ctx, saucer);
    case 'CallExpression': {
      // Side-effect function calls (e.g., emit) can be used as statements
      return saucer.join(processExpression(expr, ctx));
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

  if (!ctx.getVar(name)) throw new Error(`undefined variable: ${name}`);

  // Compute the array-read and index fragments ONCE; reuse them (immutable
  // builder nodes) for both the compound INDEX read and the SET_INDEX write,
  // so the index/array expression is never transpiled twice.
  const readArr = ctx.newSaucer().read(name);
  const index = resolveMemberIndex(member, ctx);

  const value =
    expr.operator === '='
      ? processExpression(expr.right, ctx)
      : applyBinaryOp(
          ctx.newSaucer(),
          expr.operator.slice(0, -1),
          ctx.newSaucer().index(readArr, index),
          processExpression(expr.right, ctx),
        );

  return saucer.store(name, ctx.newSaucer().setIndex(readArr, index, value));
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
