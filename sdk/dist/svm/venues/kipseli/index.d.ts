import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadder, VenueAccount } from '../types.js';
declare const SLUG = "kipseli";
export declare const KIPSELI_PROGRAM_ID: Address<"3TK9D8aoBFYjYZtKCjciPrVrRStsnvo7KmpcJqDavpaU">;
/**
 * Ref for the `[b"ban", real_user]` PDA (accounts 11/12 of the swap CPI — see the module doc). Not
 * resolvable from pool state (it depends on the trade's real owner, which `buildSwapV2` never sees
 * as a real address, only a ref) — the CALLER resolves it, exactly `pumpswap`'s own
 * `USER_VOLUME_ACCUMULATOR_REF` situation. `deriveKipseliBanEntry` below performs the derivation for
 * a caller holding the real owner address.
 */
export declare const KIPSELI_BAN_ENTRY_REF = "kipseli-ban-entry";
/** `[b"ban", owner]` under the Kipseli program — see the module doc's "34 tiny 9-byte accounts" section. */
export declare function deriveKipseliBanEntry(owner: Address): Promise<Address>;
export interface KipseliPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'quoteToBase' (default, quote in / base out) | 'baseToQuote'. */
    direction: 'quoteToBase' | 'baseToQuote';
    baseMint: Address;
    quoteMint: Address;
    baseVault: Address;
    quoteVault: Address;
    /** `10^max(baseDecimals-quoteDecimals,0)` — see PRICING MODEL. */
    adjNum: bigint;
    /** `10^max(quoteDecimals-baseDecimals,0)` — see PRICING MODEL. */
    adjDen: bigint;
    /** `expiry` (ms since epoch), read once for the FAMILIES-level liveness gate. */
    expiryMs: bigint;
}
declare function fetchPoolConfig(load: AccountLoader, pool: Address): Promise<KipseliPoolConfig>;
declare function quoteAccounts(base: PoolConfig): VenueAccount[];
export declare const kipseli: {
    slug: string;
    kind: "constant-product";
    programId: Address<"3TK9D8aoBFYjYZtKCjciPrVrRStsnvo7KmpcJqDavpaU">;
    fetchPoolConfig: typeof fetchPoolConfig;
    quoteAccounts: typeof quoteAccounts;
};
export declare const kipseliLadder: SvmVenueLadder;
export {};
//# sourceMappingURL=index.d.ts.map