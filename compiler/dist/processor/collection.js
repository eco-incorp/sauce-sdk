import { processExpression } from './index.js';
import { extractSortedProperties, extractStructType } from './inference.js';
const assertValidArrayElement = (el) => {
    if (!el)
        throw new Error('sparse arrays are not supported');
    if (el.type === 'SpreadElement')
        throw new Error('spread elements in arrays are not supported');
    return el;
};
const assertConsistentStructFields = (elements) => {
    const objects = elements.filter((el) => el.type === 'ObjectExpression');
    if (objects.length === 0)
        return;
    const getFields = (obj) => extractStructType(obj).fields.join(',');
    const firstFields = getFields(objects[0]);
    const mismatch = objects.find((obj) => getFields(obj) !== firstFields);
    if (mismatch)
        throw new Error('array elements must have consistent struct fields');
};
export const processArrayExpression = (expr, ctx, saucer) => {
    const elements = expr.elements.map(assertValidArrayElement);
    assertConsistentStructFields(elements);
    return saucer.array(elements.map((el) => processExpression(el, ctx)));
};
export const processObjectExpression = (expr, ctx, saucer) => {
    const sorted = extractSortedProperties(expr);
    const elements = sorted.map((p) => processExpression(p.value, ctx));
    return saucer.tuple(elements);
};
const isValidByte = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
const extractByteLiteral = (el) => {
    if (!el || el.type !== 'Literal')
        throw new Error('Uint8Array elements must be number literals');
    const lit = el;
    if (!isValidByte(lit.value))
        throw new Error('Uint8Array elements must be integers 0-255');
    return lit.value;
};
const extractUint8ArrayArg = (expr) => {
    if (expr.arguments.length !== 1)
        throw new Error('Uint8Array expects exactly 1 argument');
    const arg = expr.arguments[0];
    if (arg.type !== 'ArrayExpression')
        throw new Error('Uint8Array expects an array literal');
    return arg;
};
export const processUint8Array = (expr, saucer) => {
    const arrayExpr = extractUint8ArrayArg(expr);
    const bytes = new Uint8Array(arrayExpr.elements.map(extractByteLiteral));
    return saucer.bytes(bytes);
};
