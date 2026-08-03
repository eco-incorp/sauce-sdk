import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadder } from '../types.js';
export declare const HEAVEN_PROGRAM_ID: Address<"HEAVENoP2qxoeuF8Dj2oT1GHEnu49U5mJYkdeC8BAX2o">;
/** One resolved (buyBps, sellBps) fee-type pair — see module header's FEE MODEL note. */
interface HeavenFeeRates {
    protocolBuyBps: bigint;
    protocolSellBps: bigint;
    lpBuyBps: bigint;
    lpSellBps: bigint;
    creatorBuyBps: bigint;
    creatorSellBps: bigint;
    creatorProtocolBuyBps: bigint;
    creatorProtocolSellBps: bigint;
    reflectionBuyBps: bigint;
    reflectionSellBps: bigint;
}
export interface HeavenPoolConfig extends PoolConfig {
    venue: 'heaven';
    direction: 'buy' | 'sell';
    tokenAMint: Address;
    tokenBMint: Address;
    tokenAProgram: Address;
    tokenBProgram: Address;
    tokenAVault: Address;
    tokenBVault: Address;
    protocolConfig: Address;
    fees: HeavenFeeRates;
}
export declare const heaven: {
    slug: "heaven";
    programId: Address<"HEAVENoP2qxoeuF8Dj2oT1GHEnu49U5mJYkdeC8BAX2o">;
    fetchPoolConfig: (load: AccountLoader, pool: Address) => Promise<HeavenPoolConfig>;
};
export declare const heavenLadder: SvmVenueLadder;
export declare function heavenMints(base: PoolConfig): {
    inMint: Address;
    outMint: Address;
};
export declare function heavenApplyDirection(base: PoolConfig, direction: string | undefined): HeavenPoolConfig;
export {};
//# sourceMappingURL=index.d.ts.map