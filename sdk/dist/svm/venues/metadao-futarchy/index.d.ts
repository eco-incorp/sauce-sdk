import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
declare const SLUG = "metadao-futarchy";
export declare const METADAO_FUTARCHY_PROGRAM_ID: Address<'FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq'>;
/**
 * PDA(["__event_authority"], METADAO_FUTARCHY_PROGRAM_ID) — Anchor's
 * `#[event_cpi]` self-log signer, fixed for this program (independent of any
 * pool). Computed via `getProgramDerivedAddress` and confirmed byte-for-byte
 * against two real mainnet `spotSwap` transactions' account lists (see the
 * file header).
 */
export declare const METADAO_FUTARCHY_EVENT_AUTHORITY: Address;
export interface MetaDaoFutarchySpotPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'buy' (default, quote in -> base out, SwapType::Buy=0) | 'sell' (base in -> quote out, SwapType::Sell=1). */
    direction: 'buy' | 'sell';
    baseMint: Address;
    quoteMint: Address;
    ammBaseVault: Address;
    ammQuoteVault: Address;
    tokenProgram: Address;
}
/**
 * Off-chain gate + decode: rejects the wrong account shape (size/discriminator),
 * an active-proposal dao (PoolState::Futarchy — see the file header), and a
 * drained side (Pool::swap requires both reserves nonzero). `pool` here is
 * the Dao account address itself (the AMM lives embedded on it, not on a
 * separate pool account).
 */
export declare function fetchMetaDaoFutarchySpotConfig(load: AccountLoader, pool: Address): Promise<MetaDaoFutarchySpotPoolConfig>;
/** The COLD, venue-exact quote (see the file header's derivation). */
export declare function metadaoFutarchySpotQuote(x: bigint, rin: bigint, rout: bigint): bigint;
export declare const metadaoFutarchySpotLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=index.d.ts.map