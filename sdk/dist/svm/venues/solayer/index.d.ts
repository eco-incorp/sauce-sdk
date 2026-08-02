import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
declare const SLUG = "solayer";
export declare const SOLAYER_PROGRAM_ID: Address<"endoLNCKTqDn8gSVnN2hDdpgACUPWHZTwoYnnMybpAT">;
export declare const SOLAYER_SSOL_MINT: Address<"sSo14endRuUbvQaJS3dq36Q829a3A6BEfoeeRGJywEh">;
export declare const ENDO_AVS_ACCOUNT_SIZE = 443;
/** sha256('account:EndoAVS')[0..8] — verified identical across all 20 live pool accounts. */
export declare const ENDO_AVS_DISCRIMINATOR: number[];
/** sha256('global:delegate_no_init')[0..8] — verified against a real mainnet instruction's leading bytes. */
export declare const DELEGATE_NO_INIT_DISCRIMINATOR: number[];
/** sha256('global:undelegate_no_init')[0..8] — verified against a real mainnet instruction's leading bytes. */
export declare const UNDELEGATE_NO_INIT_DISCRIMINATOR: number[];
export type SolayerDirection = 'delegate' | 'undelegate';
export interface SolayerPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    direction: SolayerDirection;
    authority: Address;
    receiptMint: Address;
    lstMint: Address;
    vault: Address;
    name: string;
}
/** Off-chain, once per pool: decode the EndoAVS account and gate its two mints. Read-only against the loader. */
export declare function fetchSolayerPoolConfig(load: AccountLoader, pool: Address): Promise<SolayerPoolConfig>;
/** Family facade for the recipe orchestrator. */
export declare const solayer: {
    slug: string;
    programId: Address<"endoLNCKTqDn8gSVnN2hDdpgACUPWHZTwoYnnMybpAT">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchSolayerPoolConfig;
};
export declare const solayerLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=index.d.ts.map