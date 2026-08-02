import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
declare const SLUG = "mswap";
/** m0-foundation's ext_swap router — `SVM_VENUE_PROGRAM_IDS['mswap']`. */
export declare const MSWAP_PROGRAM_ID: Address<"MSwapi3WhNKMUGm9YrxGhypgUEt7wYQH3ZgG32XoWzH">;
/** `ext_swap`'s own global (PDA seed `b"global"` under `MSWAP_PROGRAM_ID`, bump 253 — derived offline, cross-checked live 2026-07-31). */
export declare const SWAP_GLOBAL_ID: Address<"6U4ZZZkftbuHxjRDHUfh83M9zG66aAAXDV3xTRX7yePr">;
/** The one `$M` mint every whitelisted extension wraps/unwraps against. */
export declare const M_MINT: Address<"mzerojk9tg56ebsrEAhfkyc9VgKjTW2zDqp6C5mhjzH">;
/** `$M` is always Token2022 (`m_ext`'s `Wrap`/`Unwrap` hard-type `m_token_program: Program<Token2022>`). */
export declare const M_TOKEN_PROGRAM: Address<"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb">;
/** `SwapGlobal`'s own ATA of `$M` (owner = `SWAP_GLOBAL_ID`) — the transient per-trade holding account (see module doc). */
export declare const SWAP_M_ACCOUNT: Address<"7dM9YCAbN9XGixnaP7wnyQDVZH6BVy6HPFeZr1SWVNka">;
/** Mint synthetic per-directed-pair discovery key (mirrors `sanctumInfinityPoolKey`). */
export declare function mswapPoolKey(inMint: Address, outMint: Address): Address;
export interface MSwapPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    fromMint: Address;
    toMint: Address;
    fromProgramId: Address;
    toProgramId: Address;
    fromTokenProgram: Address;
    toTokenProgram: Address;
    fromGlobal: Address;
    toGlobal: Address;
    fromMVaultAuth: Address;
    toMVaultAuth: Address;
    fromMintAuthority: Address;
    toMintAuthority: Address;
    fromMVault: Address;
    toMVault: Address;
}
/**
 * Off-chain, once per requested (inMint, outMint): read the LIVE
 * `SwapGlobal` whitelist, resolve both legs' own `ExtGlobalV2` (gating
 * `yield_variant`/`wrap_authorities` per the module doc), and derive every
 * PDA the swap CPI needs. Self-drops (throws) on ANY of: either mint not
 * whitelisted, either leg a "ScaledUi" deploy, either leg missing
 * `SWAP_GLOBAL_ID` from its own `wrap_authorities` — all LIVE checks, never
 * a hardcoded mint exclusion.
 */
export declare function fetchMSwapPoolConfig(load: AccountLoader, pool: Address): Promise<MSwapPoolConfig>;
/** Family facade for the recipe orchestrator. */
export declare const mswap: {
    slug: string;
    programId: Address<"MSwapi3WhNKMUGm9YrxGhypgUEt7wYQH3ZgG32XoWzH">;
    fetchPoolConfig: typeof fetchMSwapPoolConfig;
};
export declare const mswapLadder: {
    slug: string;
    shapeKey(_base: PoolConfig): string;
    helpers(_base: PoolConfig): {
        name: string;
        source: string;
    }[];
    paramCount: number;
    paramsFor(_base: PoolConfig): bigint[];
    quoteRefs(_base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(_base: PoolConfig, slot: number): string;
    emitQuoteCall(_base: PoolConfig, slot: number, x: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap): (x: bigint) => bigint;
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
export {};
//# sourceMappingURL=index.d.ts.map