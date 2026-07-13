/**
 * Shared bigint helpers for venue adapters. All venue math is bigint with
 * floors/ceils exactly as docs/svm-venues.md states; division floors natively.
 */
/** Ceiling division: smallest q with q * b >= a. Non-negative dividends only. */
export declare function ceilDiv(a: bigint, b: bigint): bigint;
/**
 * Little-endian unsigned field read — the TS mirror of the compiler's
 * accountUint(ref, offset, width). All seven venues are pure-LE; BE never
 * occurs. width is in bytes, 1..=32 (SPL token amount = readUintLE(data, 64, 8)).
 */
export declare function readUintLE(data: Uint8Array, offset: number, width: number): bigint;
//# sourceMappingURL=math.d.ts.map