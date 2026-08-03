import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
declare const SLUG: "boop-fun";
export declare const BOOP_FUN_PROGRAM_ID: Address;
export interface BoopFunPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** exactIn side: 'quoteToBase' (default, buy_token) | 'baseToQuote' (sell_token). */
    direction: 'quoteToBase' | 'baseToQuote';
    mint: Address;
    /** Static per-curve constant (deploy-time, never mutated per trade — see module header). */
    virtualSolReserves: bigint;
    swapFeeBasisPoints: bigint;
    bondingCurveVault: Address;
    bondingCurveSolVault: Address;
    tradingFeesVault: Address;
}
export declare const boopFun: {
    slug: "boop-fun";
    kind: "constant-product";
    programId: Address;
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<BoopFunPoolConfig>;
};
export declare const boopFunLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=index.d.ts.map