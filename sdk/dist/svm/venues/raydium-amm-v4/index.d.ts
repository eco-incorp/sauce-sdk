import type { Address } from '@solana/kit';
import type { PoolConfig, SvmVenueAdapter } from '../types.js';
export interface RaydiumAmmV4PoolConfig extends PoolConfig {
    /** AmmStatus @0 — 6 (SwapOnly) or 7 (WaitingTrade); everything else is gated out. */
    status: bigint;
    /** Unix seconds @224 — status-7 pools reject swaps before this. */
    poolOpenTime: bigint;
    /** Base (coin) token decimals @32. */
    coinDecimals: number;
    /** Quote (pc) token decimals @40. */
    pcDecimals: number;
    /** fees.swap_fee_numerator @176 (default 25). */
    swapFeeNumerator: bigint;
    /** fees.swap_fee_denominator @184 (default 10000). */
    swapFeeDenominator: bigint;
    /** SPL token account holding base reserves (AmmInfo @336). */
    coinVault: Address;
    /** SPL token account holding quote reserves (AmmInfo @368). */
    pcVault: Address;
    /** Base mint (AmmInfo @400). */
    coinMint: Address;
    /** Quote mint (AmmInfo @432). */
    pcMint: Address;
    /**
     * Swap direction: true = coin in, pc out (Coin2PC); false = pc in, coin out.
     * fetchPoolConfig defaults to true — flip it (spread a copy) for the other
     * side. The on-chain program infers direction from the user token account
     * mints, so buildSwap is direction-independent; only the quote math flips.
     */
    inputIsCoin: boolean;
}
export declare const raydiumAmmV4: SvmVenueAdapter;
//# sourceMappingURL=index.d.ts.map