import type { Expression, ArrayExpression, NewExpression, CallExpression, ObjectExpression, Literal } from 'acorn';
import type { SaucerLike } from '../saucer/index.js';
import type { CompilerContext } from '../context.js';
import { processExpression } from './index.js';
import { extractSortedProperties, extractStructType } from './inference.js';

const assertValidArrayElement = (el: ArrayExpression['elements'][number]): Expression => {
  if (!el) throw new Error('sparse arrays are not supported');

  if (el.type === 'SpreadElement') throw new Error('spread elements in arrays are not supported');

  return el as Expression;
};

const assertConsistentStructFields = (elements: Expression[]): void => {
  const objects = elements.filter((el): el is ObjectExpression => el.type === 'ObjectExpression');

  if (objects.length === 0) return;

  const getFields = (obj: ObjectExpression): string => extractStructType(obj).fields.join(',');
  const firstFields = getFields(objects[0]);

  const mismatch = objects.find((obj) => getFields(obj) !== firstFields);

  if (mismatch) throw new Error('array elements must have consistent struct fields');
};

export const processArrayExpression = (expr: ArrayExpression, ctx: CompilerContext, saucer: SaucerLike): SaucerLike => {
  const elements = expr.elements.map(assertValidArrayElement);
  assertConsistentStructFields(elements);

  return saucer.array(elements.map((el) => processExpression(el, ctx)));
};

export const processObjectExpression = (
  expr: ObjectExpression,
  ctx: CompilerContext,
  saucer: SaucerLike,
): SaucerLike => {
  const sorted = extractSortedProperties(expr);
  const elements = sorted.map((p) => processExpression(p.value, ctx));

  return saucer.tuple(elements);
};

const isValidByte = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;

const extractByteLiteral = (el: ArrayExpression['elements'][number]): number => {
  if (!el || el.type !== 'Literal') throw new Error('Uint8Array elements must be number literals');

  const lit = el as Literal;

  if (!isValidByte(lit.value)) throw new Error('Uint8Array elements must be integers 0-255');

  return lit.value;
};

const extractUint8ArrayArg = (expr: NewExpression | CallExpression): ArrayExpression => {
  if (expr.arguments.length !== 1) throw new Error('Uint8Array expects exactly 1 argument');

  const arg = expr.arguments[0];

  if (arg.type !== 'ArrayExpression') throw new Error('Uint8Array expects an array literal');

  return arg as ArrayExpression;
};

export const processUint8Array = (expr: NewExpression | CallExpression, saucer: SaucerLike): SaucerLike => {
  const arrayExpr = extractUint8ArrayArg(expr);
  const bytes = new Uint8Array(arrayExpr.elements.map(extractByteLiteral));

  return saucer.bytes(bytes);
};
