import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2, VenueAccount } from '../types.js';
declare const SLUG = "denali";
export declare const DENALI_PROGRAM_ID: Address<"DNL1tgEj3nJovHw9jtyCCQD3arssCJzkmpDizknwzey4">;
/** Owner of every pool's per-pool oracle PDA — see the file header. */
export declare const DENALI_ORACLE_PROGRAM_ID: Address<"DZNTS5ujuiyx1mazqCPdYPzEyE2VrTPPb6QbqBUftJbY">;
/**
 * Protocol-wide global config account — constant across every pool
 * (real-chain-confirmed across 5 transactions on 2 different pools). Read-only,
 * not a signer.
 */
export declare const DENALI_GLOBAL_CONFIG: Address<"46TF9vo4oqnLuY7LrueQybyJoLsgMeauUhTHFYfcgFyJ">;
export declare const OFF_MINT_A = 72;
export declare const OFF_MINT_B = 104;
export declare const OFF_VAULT_A = 136;
export declare const OFF_VAULT_B = 168;
export interface DenaliPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 0 = mintA in / mintB out, 1 = mintB in / mintA out. */
    direction: 0 | 1;
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
    /** Per-pool PDA, derived off `pool` — see the file header. */
    oracle: Address;
}
export declare function fetchDenaliPoolConfig(load: AccountLoader, pool: Address): Promise<DenaliPoolConfig>;
declare function quoteAccounts(base: PoolConfig): VenueAccount[];
/** Family facade for the recipe orchestrator. */
export declare const denali: {
    slug: string;
    kind: "constant-product";
    programId: Address<"DNL1tgEj3nJovHw9jtyCCQD3arssCJzkmpDizknwzey4">;
    fetchPoolConfig: typeof fetchDenaliPoolConfig;
    quoteAccounts: typeof quoteAccounts;
};
export declare const denaliLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=index.d.ts.map