import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadder, VenueAccount } from '../types.js';
declare const SLUG = "whalestreet";
export declare const WHALESTREET_PROGRAM_ID: Address<"FW6zUqn4iKRaeopwwhwsquTY6ABWLLgjxtrC3VPnaWBf">;
export declare const WHALESTREET_OFF_MINT_A = 22;
export declare const WHALESTREET_OFF_VAULT_A = 54;
export declare const WHALESTREET_OFF_MINT_B = 137;
export declare const WHALESTREET_OFF_VAULT_B = 169;
/**
 * The REAL, validated 9-byte instruction-data prefix — opcode 0x01 plus an
 * 8-byte tag observed identical across all 5 real captured samples (3
 * sizes + a repeat + the reverse direction) on the ONE pool this
 * integration validated against. See the module doc's "INSTRUCTION DATA".
 */
export declare const WHALESTREET_IX_PREFIX: Uint8Array<ArrayBuffer>;
export interface WhalestreetPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 0 = mintA in / mintB out, 1 = mintB in / mintA out. */
    direction: 0 | 1;
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
}
export declare function fetchWhalestreetPoolConfig(load: AccountLoader, pool: Address): Promise<WhalestreetPoolConfig>;
declare function quoteAccounts(base: PoolConfig): VenueAccount[];
/** Partial v1-shaped helper (fetchPoolConfig/quoteAccounts only) — this venue is ladder-only (v2); see whalestreetLadder below for the full adapter surface. */
export declare const whalestreet: {
    slug: string;
    kind: "constant-product";
    programId: Address<"FW6zUqn4iKRaeopwwhwsquTY6ABWLLgjxtrC3VPnaWBf">;
    fetchPoolConfig: typeof fetchWhalestreetPoolConfig;
    quoteAccounts: typeof quoteAccounts;
};
export declare const whalestreetLadder: SvmVenueLadder;
export {};
//# sourceMappingURL=index.d.ts.map