import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, PoolConfig, SwapUser, VenueAccount } from '../types.js';
declare const SLUG = "mercurial";
export declare const MERCURIAL_PROGRAM_ID: Address<"MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky">;
export interface MercurialPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    direction: 'aToB' | 'bToA';
    nonce: number;
    authority: Address;
    vaultA: Address;
    vaultB: Address;
    mintA: Address;
    mintB: Address;
}
/** Fetch + decode one Mercurial SwapV2 pool, plus its two vaults' mints. Read-only against the loader. */
export declare function fetchMercurialPoolConfig(load: AccountLoader, pool: Address): Promise<MercurialPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like orca-whirlpool/raydium-clmm/saber-stableswap). */
export declare const mercurial: {
    slug: string;
    programId: Address<"MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchMercurialPoolConfig;
};
export declare const mercurialLadder: {
    slug: string;
    /** Stable slots default to 2 rungs (cap 4) — a Newton quote is ~2 orders costlier than a CP one. */
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    /** Everything is a live read — no per-trade params. */
    paramCount: number;
    paramsFor(_base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, _params: readonly string[], enableVar?: string): string;
    emitLadderQuote(_base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string;
    emitFinalQuote(_base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): {
        programId: Address<"MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky">;
        prefix: Uint8Array<ArrayBuffer>;
        suffix: Uint8Array<ArrayBuffer>;
        patch: "in";
        accounts: VenueAccount[];
    };
    referenceQuote(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], _now?: bigint): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], _now?: bigint): (grid: readonly bigint[]) => bigint[];
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(base: PoolConfig, state: AccountBytesMap): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
export {};
//# sourceMappingURL=index.d.ts.map