import { OPS } from './ops.js';
import { BYTE_OPS, BYTE_WIDTH } from './integer.js';
import type { Saucer } from './saucer.js';

const MAX_BYTE_1 = 0xff;
const MAX_BYTE_2 = 0xffff;

const isStaticType = (op: number): boolean => op in BYTE_WIDTH;

const isDynamicLiteral = (op: number): boolean =>
  op === OPS.BYTES || op === OPS.BYTES_2 || op === OPS.ARRAY || op === OPS.ARRAY_2 || op === OPS.TUPLE;

// Runtime-computed expressions that produce dynamic (bytes) values
const isRuntimeDynamic = (op: number): boolean =>
  op === OPS.READ_HEAP || op === OPS.CONCAT || op === OPS.SLICE || op === OPS.ABI_ENCODE;

const isDynamicType = (op: number): boolean => isDynamicLiteral(op) || isRuntimeDynamic(op);

const allStatic = (elements: Saucer[]): boolean => elements.every((e) => isStaticType(e._bytes[0]));

const allDynamic = (elements: Saucer[]): boolean => elements.every((e) => isDynamicType(e._bytes[0]));

const maxByteWidth = (elements: Saucer[]): number => Math.max(...elements.map((e) => BYTE_WIDTH[e._bytes[0]]));

const padToWidth = (bytes: Uint8Array, width: number): number[] => {
  const valueBytes = bytes.slice(1); // Skip opcode
  const padding = width - valueBytes.length;

  return [...Array<number>(padding).fill(0), ...valueBytes];
};

const packStaticElements = (elements: Saucer[], width: number): number[] =>
  elements.flatMap((e) => padToWidth(e._bytes, width));

const packDynamicElements = (elements: Saucer[]): number[] => elements.flatMap((e) => Array.from(e._bytes));

const encodeLength = (length: number): { op: number; bytes: number[] } =>
  length <= MAX_BYTE_1
    ? { op: OPS.ARRAY, bytes: [length] }
    : { op: OPS.ARRAY_2, bytes: [(length >> 8) & 0xff, length & 0xff] };

export const encodeArray = (elements: Saucer[]): Uint8Array => {
  if (elements.length === 0) return new Uint8Array([OPS.ARRAY, 0, OPS.BYTE_1]);

  if (elements.length > MAX_BYTE_2)
    throw new Error(`array too large: ${elements.length} elements exceeds ${MAX_BYTE_2}`);

  const { op, bytes: lengthBytes } = encodeLength(elements.length);

  if (allStatic(elements)) {
    const width = maxByteWidth(elements);

    return new Uint8Array([op, ...lengthBytes, BYTE_OPS[width], ...packStaticElements(elements, width)]);
  }

  if (!allDynamic(elements))
    throw new Error('array elements must be literals or dynamic types (strings, arrays, bytes)');

  // For runtime-computed elements (READ_HEAP, CONCAT, etc.), use BYTES as the element type marker
  const firstOp = elements[0]._bytes[0];
  const elementType = isDynamicLiteral(firstOp) ? firstOp : OPS.BYTES;

  return new Uint8Array([op, ...lengthBytes, elementType, ...packDynamicElements(elements)]);
};

export const encodeIndex = (index: Saucer, array: Saucer): Uint8Array =>
  new Uint8Array([OPS.INDEX, ...index._bytes, ...array._bytes]);
