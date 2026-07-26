/**
 * Fold provably-constant branches/expressions/loops in a `.ts`/`.sauce.ts` module and
 * strip types, returning plain JS text ready for `acorn.parse`. Pure function of its input
 * text.
 */
export declare function tsPartialEval(code: string, filePath: string): string;
//# sourceMappingURL=ts-frontend.d.ts.map