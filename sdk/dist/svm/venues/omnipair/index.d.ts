import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "omnipair";
export declare const OMNIPAIR_PROGRAM_ID: Address<"omnixgS8fnqHfCcTGKWj6JtKjzpJZ1Y5y9pyFkQDkYE">;
export declare const PAIR_ACCOUNT_SIZE = 350;
/** sha256('account:Pair')[0..8]. */
export declare const PAIR_DISCRIMINATOR: number[];
export interface OmnipairPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'aToB' (default, token0 in / token1 out) | 'bToA'. */
    direction: 'aToB' | 'bToA';
    token0Mint: Address;
    token1Mint: Address;
    rateModel: Address;
    futarchyAuthority: Address;
    eventAuthority: Address;
    reserveVault0: Address;
    reserveVault1: Address;
    /** Immutable per-pair Borsh option-tag offset for reserve0 (147 tag=None, 149 tag=Some) — part of the shape key. */
    reserveBase: 147 | 149;
    token0Decimals: number;
    token1Decimals: number;
}
/** Fetch + decode one Pair, deriving the fixed accounts the swap CPI needs. Read-only against the loader. */
export declare function fetchOmnipairPoolConfig(load: AccountLoader, pool: Address): Promise<OmnipairPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like orca-whirlpool/raydium-clmm/defituna). */
export declare const omnipair: {
    slug: string;
    programId: Address<"omnixgS8fnqHfCcTGKWj6JtKjzpJZ1Y5y9pyFkQDkYE">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchOmnipairPoolConfig;
};
/**
 * Closed-form capacity: the largest gross input `x` for which
 * `amountOut(x) <= cashOut` holds (see the module header derivation).
 * `U64_MAX` when `reserveOut <= cashOut` (never binds).
 */
export declare function omnipairCapacity(reserveIn: bigint, reserveOut: bigint, cashOut: bigint, feeBps: bigint): bigint;
/** The COLD (venue-exact) quote for gross input x, saturating at the capacity clamp. */
export declare function omnipairQuote(x: bigint, ri: bigint, ro: bigint, fb: bigint, icap: bigint): bigint;
export {};
//# sourceMappingURL=index.d.ts.map