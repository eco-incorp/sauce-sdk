import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const perpsJlpLadder: {
    slug: string;
    /**
     * Heavier per-rung arithmetic than a plain CP quote (a two-sided fee
     * branch), so 2 rungs by default — matching the Newton-style stable
     * families' CU-conservative default, not because this is iterative.
     */
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string;
    /** Stateless per rung (no warm-start) — identical body to the cold final quote. */
    emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string;
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    /**
     * swap2(params: Swap2Params { amountIn: u64, minAmountOut: u64 }) —
     * disc(8) ++ amountIn u64 LE (runtime-patched) ++ minAmountOut u64 LE = 1
     * (the recipe's terminal outAta delta check owns the real bound). The
     * 17-account order below is the on-chain IDL's `swap2` accounts list
     * verbatim (decoded from the live on-chain Anchor IDL account 2026-07-31)
     * — receivingCustody/receivingCustody* = the INPUT (funding) side,
     * dispensingCustody/dispensingCustody* = the OUTPUT (receiving) side.
     */
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap): (grid: readonly bigint[]) => bigint[];
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(base: PoolConfig): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
//# sourceMappingURL=ladder.d.ts.map