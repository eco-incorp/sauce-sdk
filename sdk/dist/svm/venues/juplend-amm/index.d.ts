import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
declare const SLUG = "juplend-amm";
export declare const JUPLEND_AMM_PROGRAM_ID: Address<"jupZ4m2GqUCJ5iueMfzQf8khFfH31d4XAQt3RzCT9Vd">;
export declare const JUPLEND_LIQUIDITY_PROGRAM_ID: Address<"jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC">;
export declare const JUPLEND_ORACLE_PROGRAM_ID: Address<"jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc">;
export declare const OFF_TOKEN_0 = 11;
export declare const OFF_TOKEN_1 = 43;
export declare const OFF_TOKEN_0_DECIMALS = 75;
export declare const OFF_TOKEN_1_DECIMALS = 76;
export declare const OFF_CENTER_PRICE = 109;
export declare const OFF_SMART_COLLATERAL_ENABLED = 141;
export declare const OFF_SMART_DEBT_ENABLED = 142;
export declare const OFF_FEE = 143;
export declare const OFF_CENTER_PRICE_ADDRESS = 166;
export declare const OFF_IS_CENTER_PRICE_SHIFT_ACTIVE = 218;
export declare const OFF_SWAP_AND_ARBITRAGE_PAUSED = 219;
export declare const OFF_POSITION_AMOUNT = 73;
export declare const OFF_POSITION_CEILING = 81;
/** 1 raw-unit-per-raw-unit price scale (empirically confirmed — see module doc). */
export declare const CENTER_PRICE_SCALE = 1000000000000000n;
export declare const FEE_SCALE = 1000000n;
export interface JuplendAmmPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** true ⇒ token0 in / token1 out; false ⇒ token1 in / token0 out. */
    swap0to1: boolean;
    token0: Address;
    token1: Address;
    tokenProgram0: Address;
    tokenProgram1: Address;
    /** Liquidity-program TokenReserve PDAs (`["reserve", mint]`), one per mint. */
    tokenReserve0: Address;
    tokenReserve1: Address;
    /** Each mint's shared-liquidity vault (read off its TokenReserve.vault field). */
    vault0: Address;
    vault1: Address;
    /** `["rate_model", mint]` PDAs — carried through untouched for the swap CPI. */
    rateModel0: Address;
    rateModel1: Address;
    /** `["liquidity"]` — one global singleton. */
    liquidity: Address;
    /** Whichever of supply/borrow position this Dex uses (see class doc). */
    positionKind: 'supply' | 'borrow';
    /** `["user_{supply,borrow}_position", mint, dex]` PDAs for BOTH mints. */
    position0: Address;
    position1: Address;
    /** Dex.fee, ppm (1e6 scale). */
    feePpm: bigint;
}
export declare const juplendAmm: {
    slug: string;
    kind: "constant-product";
    programId: Address<"jupZ4m2GqUCJ5iueMfzQf8khFfH31d4XAQt3RzCT9Vd">;
    /**
     * Decode + shape-gate the Dex account, derive every PDA the swap CPI and
     * the ladder need, and pick this Dex's position kind. Rejects: wrong
     * size/discriminator, a paused Dex, an active center-price shift (see
     * module doc), and a Dex with NEITHER smart_collateral nor smart_debt
     * enabled (the real program's own swap can never succeed in that state —
     * `_swapIn`'s routing-amount branch has no route, `DexNoSwapRoute`).
     */
    fetchPoolConfig(load: AccountLoader, pool: Address, swap0to1?: boolean): Promise<JuplendAmmPoolConfig>;
    quoteAccounts(cfg: PoolConfig): VenueAccount[];
    /**
     * The full `swap_in` CPI (24 accounts — see module doc's account-list
     * validation). `dex_supply_position_token_{0,1}` / `dex_borrow_position_token_{0,1}`
     * carry the DEX's own program id as the Anchor "None" sentinel for
     * whichever position kind this Dex does not use (proven correct: reaching
     * real business logic past account resolution for both position kinds —
     * see module doc). `amount_out_min` is the recipe-wide venue convention
     * of 1 (the recipe's own outAta delta check owns the real floor).
     */
    buildSwap(cfg: PoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
};
/** sha256('global:swap_in')[0..8] — exported for buildSwapV2's prefix. */
export declare const JUPLEND_SWAP_IN_DISCRIMINATOR: number[];
/**
 * The 24-account order `swap_in`/`swap_out` share (see dex.json's IDL).
 * `make(role, addr, writable?)` builds one VenueAccount; `refFor` (default
 * identity) lets buildSwapV2 slot-namespace the pool-owned refs while
 * user-owned refs (owner/inAta/outAta) stay exactly as SwapUser gave them —
 * the same shared-helper shape obric-v2's swapAccounts uses.
 */
export declare function juplendAmmSwapAccounts(c: JuplendAmmPoolConfig, user: SwapUser, make: (role: string, addr: Address, writable?: boolean) => VenueAccount, refFor?: (role: string) => string): VenueAccount[];
export {};
//# sourceMappingURL=index.d.ts.map