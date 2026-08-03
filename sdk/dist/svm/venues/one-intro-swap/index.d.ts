import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "one-intro-swap";
export declare const ONE_INTRO_SWAP_PROGRAM_ID: Address;
/**
 * The ONE known `MetadataState` — see the module header's "global, not
 * per-pool" evidence. Required by every swap (accounts[0], read-only).
 */
export declare const ONE_INTRO_SWAP_METADATA_STATE: Address;
/**
 * The two fixed fee-collector owners — ground-truthed via the real mainnet
 * SOL/USDC market's four fee token accounts (2 per mint side): each owner's
 * ATA for whichever mint is being DEPOSITED is where that stream's cut
 * lands (see ./ladder.ts for the exact per-swap amount, always
 * `floor(amountIn / 100_000)` per stream).
 */
export declare const ONE_INTRO_SWAP_FEE_OWNER_A: Address;
export declare const ONE_INTRO_SWAP_FEE_OWNER_B: Address;
export declare const OFF_VIRTUAL_RESERVE0 = 153;
export declare const OFF_VIRTUAL_RESERVE1 = 233;
/** SPL token account `amount` (u64 LE) offset — standard Tokenkeg layout. */
export declare const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
export interface OneIntroSwapPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    authority: Address;
    mint0: Address;
    vault0: Address;
    mint1: Address;
    vault1: Address;
    /** ATA(FEE_OWNER_A, mint0) / ATA(FEE_OWNER_B, mint0) — pre-derived (buildSwapV2 is sync). */
    feeA0: Address;
    feeB0: Address;
    /** ATA(FEE_OWNER_A, mint1) / ATA(FEE_OWNER_B, mint1). */
    feeA1: Address;
    feeB1: Address;
    /** '0to1' (default, mint0 in) | '1to0'. */
    direction: '0to1' | '1to0';
}
export declare function oneIntroSwapConfig(base: PoolConfig): OneIntroSwapPoolConfig;
export declare function fetchOneIntroSwapPoolConfig(load: AccountLoader, pool: Address): Promise<OneIntroSwapPoolConfig>;
export {};
//# sourceMappingURL=index.d.ts.map