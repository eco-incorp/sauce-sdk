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
} from 'acorn';
import type { SaucerLike } from '../saucer/index.js';
import type { CompilerContext } from '../context.js';
import { processExpression, processStatement } from './index.js';
import { applyBinaryOp } from './expression.js';
import { inferKindWithContext, inferElementTypeWithContext, inferStructTypeWithContext } from './inference.js';

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
  if (expr.left.type !== 'Identifier') {
    throw new Error(`not implemented: assignment to ${expr.left.type}`);
  }

  const name = (expr.left as { name: string }).name;

  if (expr.operator === '=') return storeExpression(name, expr.right, ctx, saucer);

  const s = ctx.newSaucer();
  const value = applyBinaryOp(s, expr.operator.slice(0, -1), s.read(name), processExpression(expr.right, ctx));

  return saucer.store(name, value);
}
