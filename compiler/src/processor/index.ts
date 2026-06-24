import type {
  Node,
  Program,
  FunctionDeclaration,
  ImportDeclaration,
  Statement,
  Expression,
  Literal,
  ExpressionStatement,
  ReturnStatement,
  ThrowStatement,
} from 'acorn';
import type { SaucerLike } from '../saucer/index.js';
import { V12Saucer } from '../saucer/index.js';
import { CompilerContext } from '../context.js';
import type { Abi } from '../contracts.js';
import {
  processLiteral,
  processUnaryExpression,
  processBinaryExpression,
  processLogicalExpression,
  processCallExpression,
  processMemberExpression,
  processNewExpression,
  processTaggedTemplateExpression,
} from './expression.js';
import {
  processVariableDeclaration,
  processIfStatement,
  processForStatement,
  processWhileStatement,
  processMutation,
} from './statement.js';
import { processArrayExpression, processObjectExpression } from './collection.js';

export function processNode(node: Node, ctx: CompilerContext): SaucerLike[] {
  switch (node.type) {
    case 'Program':
      return processProgram(node as Program, ctx);
    default:
      throw new Error(`not implemented: ${node.type}`);
  }
}

function processImportDeclaration(stmt: ImportDeclaration, ctx: CompilerContext): void {
  const source = (stmt.source as { value: string }).value;
  const artifact = ctx.resolveImport(source);
  const abi = artifact.abi;

  if (!abi) {
    throw new Error(`import "${source}" does not contain an ABI.`);
  }

  for (const specifier of stmt.specifiers) {
    const localName = (specifier.local as { name: string }).name;
    ctx.registerContract(localName, abi as Abi);
  }
}

function processProgram(program: Program, ctx: CompilerContext): SaucerLike[] {
  // Process imports first
  for (const stmt of program.body) {
    if (stmt.type === 'ImportDeclaration') {
      processImportDeclaration(stmt as ImportDeclaration, ctx);
    }
  }

  const declarations = program.body.filter((stmt): stmt is FunctionDeclaration => stmt.type === 'FunctionDeclaration');
  const nonAllowed = program.body.find(
    (stmt) => stmt.type !== 'FunctionDeclaration' && stmt.type !== 'ImportDeclaration',
  );

  if (nonAllowed) {
    throw new Error('top-level statements not allowed, use function main()');
  }

  const mainFunc = declarations.find((stmt) => stmt.id?.name === 'main');

  if (!mainFunc) {
    throw new Error('missing main() function');
  }

  if (ctx.isV12) {
    return processProgramV12(declarations, mainFunc, ctx);
  }

  const functions = declarations
    .filter((stmt) => stmt.id?.name !== 'main')
    .map((stmt) => {
      ctx.addFunc(stmt.id?.name);

      return processFunction(stmt);
    });

  ctx.addFunc('main');

  return [...functions, processFunction(mainFunc, ctx)];
}

/**
 * v12: every function (helpers + main) compiles in its own child context (fresh
 * slots/scopes/stack) sharing the module's function index table, so calls resolve
 * across functions. Each function's build artifacts are recorded for the single-blob
 * assembly in compile(). Function names are registered up front so a body can call a
 * function declared later.
 */
function processProgramV12(
  declarations: FunctionDeclaration[],
  mainFunc: FunctionDeclaration,
  ctx: CompilerContext,
): SaucerLike[] {
  const helpers = declarations.filter((stmt) => stmt.id?.name !== 'main');

  for (const stmt of helpers) ctx.addFunc(stmt.id?.name);
  ctx.addFunc('main');

  const helperSaucers = helpers.map((stmt) => processFunctionV12(stmt, ctx));
  const mainSaucer = processFunctionV12(mainFunc, ctx);

  return [...helperSaucers, mainSaucer];
}

function processFunctionV12(stmt: FunctionDeclaration, parentCtx: CompilerContext): SaucerLike {
  const ctx = parentCtx.forFunction();
  const name = stmt.id?.name ?? 'main';
  const isMain = name === 'main';
  const argTypes = isMain ? parentCtx.mainArgTypes : undefined;

  // Params live on the EVM stack (isParam) in declaration order.
  stmt.params.forEach((param, i) => {
    if (param.type !== 'Identifier') throw new Error(`Unsupported function variable type: ${param.type}`);

    const argType = argTypes?.[i];
    ctx.setVar(param.name, argType?.kind ?? 'scalar', argType?.elementType, undefined, true);
    ctx.pushStack(param.name);
  });

  const body = stmt.body.body.reduce<SaucerLike>((saucer, st) => processStatement(st, ctx, saucer), ctx.newSaucer());

  ctx.recordFunction({ name, isMain, paramCount: stmt.params.length, saucer: body as V12Saucer });

  return body;
}

function processFunction(stmt: FunctionDeclaration, ctx: CompilerContext = new CompilerContext()): SaucerLike {
  const argTypes = ctx.mainArgTypes;

  stmt.params.forEach((param, i) => {
    if (param.type !== 'Identifier') throw new Error(`Unsupported function variable type: ${param.type}`);

    const argType = argTypes?.[i];
    ctx.setVar(param.name, argType?.kind ?? 'scalar', argType?.elementType);
  });

  return stmt.body.body.reduce<SaucerLike>((saucer, st) => processStatement(st, ctx, saucer), ctx.newSaucer());
}

export function processStatement(stmt: Statement, ctx: CompilerContext, saucer: SaucerLike): SaucerLike {
  switch (stmt.type) {
    case 'VariableDeclaration':
      return processVariableDeclaration(stmt, ctx, saucer);
    case 'IfStatement':
      return processIfStatement(stmt, ctx, saucer);
    case 'ReturnStatement':
      return processReturnStatement(stmt as ReturnStatement, ctx, saucer);
    case 'ForStatement':
      return processForStatement(stmt, ctx, saucer);
    case 'WhileStatement':
      return processWhileStatement(stmt, ctx, saucer);
    case 'BreakStatement':
      return saucer.break();
    case 'ContinueStatement':
      return saucer.continue();
    case 'ExpressionStatement':
      return processMutation((stmt as ExpressionStatement).expression as Expression, ctx, saucer);
    case 'ThrowStatement':
      return processThrowStatement(stmt as ThrowStatement, ctx, saucer);
    default:
      throw new Error(`not implemented: ${stmt.type}`);
  }
}

function processReturnStatement(stmt: ReturnStatement, ctx: CompilerContext, saucer: SaucerLike): SaucerLike {
  return stmt.argument ? saucer.return(processExpression(stmt.argument, ctx)) : saucer.return();
}

function processThrowStatement(stmt: ThrowStatement, ctx: CompilerContext, saucer: SaucerLike): SaucerLike {
  return saucer.revert(processExpression(stmt.argument as Expression, ctx));
}

export function processExpression(expr: Expression, ctx: CompilerContext): SaucerLike {
  const saucer = ctx.newSaucer();
  switch (expr.type) {
    case 'Literal':
      return processLiteral(expr as Literal, saucer);
    case 'Identifier':
      return saucer.read(expr.name);
    case 'UnaryExpression':
      return processUnaryExpression(expr, ctx, saucer);
    case 'BinaryExpression':
      return processBinaryExpression(expr, ctx, saucer);
    case 'LogicalExpression':
      return processLogicalExpression(expr, ctx, saucer);
    case 'CallExpression':
      return processCallExpression(expr, ctx, saucer);
    case 'ArrayExpression':
      return processArrayExpression(expr, ctx, saucer);
    case 'ObjectExpression':
      return processObjectExpression(expr, ctx, saucer);
    case 'NewExpression':
      return processNewExpression(expr, ctx, saucer);
    case 'MemberExpression':
      return processMemberExpression(expr, ctx, saucer);
    case 'TaggedTemplateExpression':
      return processTaggedTemplateExpression(expr, ctx, saucer);
    case 'ConditionalExpression':
      throw new Error('ternary must be used directly in an assignment');
    default:
      throw new Error(`not implemented: ${expr.type}`);
  }
}
