/**
 * IEEE-754 binary64 -> baked integer-scale reduction, shared by index.ts
 * (fetchPoolConfig, which runs this once per pool against the fetched
 * oracle bytes) and ladder.ts (the on-chain fragment + its TS reference
 * mirror). See ladder.ts's module doc for the full derivation and why this
 * is necessary (the SVM target's arithmetic is pure-integer; the Wildcard
 * oracle stores price as a real f64).
 *
 * Split into its own file (not index.ts or ladder.ts) purely to avoid a
 * cross-import between those two — both need it, neither owns it.
 */
/** 2^52 - 1 (52-bit mantissa mask, IEEE-754 binary64). */
export declare const MANTISSA_MASK = 4503599627370495n;
/** 2^52 (the implicit leading mantissa bit, restored before use). */
export declare const IMPLICIT_BIT = 4503599627370496n;
/**
 * Decode an IEEE-754 binary64 bit pattern into the ladder's baked constants
 * for ONE pool: `bakedTop` (compared live on-chain every cook), `shiftPre`
 * (a mantissa right-shift, FLOOR-only — never inflates the decoded price),
 * and the canonical (num, den) rational such that, for any LIVE bit
 * pattern whose top 12 bits (sign + biased exponent) still equal
 * `bakedTop`:
 *
 *   liveMantissa = (liveBits & MANTISSA_MASK) | IMPLICIT_BIT
 *   reduced      = liveMantissa >> shiftPre
 *   price       ≈ reduced * num / den            (mintA -> mintB direction)
 *   price       ≈ num / (reduced * den)          (mintB -> mintA direction, exact reciprocal)
 *
 * already folding the 2^(exponent-1075) term AND the mintA/mintB decimals
 * difference, gcd-reduced so the on-chain fragment's live multiply/divide
 * never needs to carry more than ~53 live mantissa bits through a plain
 * `*`/`/` (see ladder.ts's module doc for why that matters).
 */
export declare function ieee754ScaleParams(rawBits: bigint, decimalsA: number, decimalsB: number): {
    bakedTop: bigint;
    shiftPre: bigint;
    num: bigint;
    den: bigint;
};
//# sourceMappingURL=ieee754.d.ts.map