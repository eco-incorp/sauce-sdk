import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "xorca";
export declare const XORCA_PROGRAM_ID: Address<'StaKE6XNKVVhG8Qu9hDJBqCW3eRe7MDGLz17nJZetLT'>;
/** Hardcoded program constants (`cpi/token/mod.rs`) — never stored as pool-account bytes. */
export declare const ORCA_MINT_ID: Address<'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'>;
export declare const XORCA_MINT_ID: Address<'xorcaYqbXUNz3474ubUMJAdu2xgPsew3rUCe5ughT3N'>;
/**
 * The single global State PDA — seed `["state"]` under `XORCA_PROGRAM_ID`,
 * bump 250. The single vault ATA — seed `[statePda, tokenProgram, orcaMint]`
 * under the ATA program, bump 254. Both re-derived independently via
 * `getProgramDerivedAddress` and cross-checked against the live account's own
 * `State.bump`/`State.vault_bump` fields (250/254 exactly) AND against 3 real
 * mainnet `Stake` transactions' account lists (see file header) — hardcoded
 * here rather than derived at call time because both are permanently fixed
 * (there is exactly one xORCA vault; the mints never change).
 */
export declare const XORCA_STATE_PDA: Address<'CSqKhyW1cpdyjheAx5HXx4ibcnYrzpL5JywEMAkZixBK'>;
export declare const XORCA_VAULT_ATA: Address<'Ce5j11WAsSzM3nkzrw4Kw6v6ic3nbyqpv5eywjYKeKc5'>;
/** `State.escrowed_orca_amount`, u64 LE. */
export declare const STATE_ESCROWED_OFFSET = 8;
/** SPL `TokenAccount.amount`, u64 LE — the vault's live ORCA balance. */
export declare const VAULT_AMOUNT_OFFSET = 64;
/** SPL `Mint.supply`, u64 LE (4-byte COption tag + 32-byte pubkey precede it). */
export declare const MINT_SUPPLY_OFFSET = 36;
export interface XorcaPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** The only tradable direction — see file header for why Unstake/Withdraw cannot be one. */
    direction: 'orcaToXorca';
}
/**
 * Singleton venue: `pool` must be `XORCA_STATE_PDA` (there is nothing else to
 * resolve it to). `load` re-reads the live account so a program
 * upgrade/migration is caught like any other vanished pool — never silently
 * misquoted — rather than trusting the hardcoded address blindly.
 */
export declare function fetchXorcaConfig(load: AccountLoader, pool: Address): Promise<XorcaPoolConfig>;
export {};
//# sourceMappingURL=index.d.ts.map