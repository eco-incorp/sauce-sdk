import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadder } from '../types.js';
declare const SLUG = "trends";
export declare const TRENDS_PROGRAM_ID: Address<"CURVEmPpijXDTNdqrA9PGP1io2rkgiVXH26xdXVGLLfz">;
export declare const WSOL_MINT: Address<"So11111111111111111111111111111111111111112">;
/** Global `config` PDA (seeds `["config"]`) — same account for every pool (verified live). */
export declare const TRENDS_CONFIG_PDA: Address<"BMejsRsPsaMypBsexufEmEGh8vjxfp2CMVHZE2PTTetj">;
/** Global `pool_authority` — a hardcoded Anchor `address` constraint, identical for every pool. */
export declare const TRENDS_POOL_AUTHORITY: Address<"C6B7knNSF8X8YfW54D8jQvM3VUCifsphHEQZSCyAERoE">;
/** Global `event_authority` PDA (seeds `["__event_authority"]`) — same for every pool. */
export declare const TRENDS_EVENT_AUTHORITY: Address<"87jkvJSERNjGmzftppK4Kt4Trv6tDh25K66aatP9esXQ">;
export declare const POOL_ACCOUNT_SIZE = 312;
/** sha256('account:Pool')[0..8] (the `bonding_curve` Pool account — see module header point 2). */
export declare const POOL_DISCRIMINATOR: number[];
export interface TrendsPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'quoteToBase' (default, BUY: pay wSOL, receive base) | 'baseToQuote' (SELL: pay base, receive wSOL). */
    direction: 'quoteToBase' | 'baseToQuote';
    baseMint: Address;
    baseVault: Address;
    quoteVault: Address;
    baseTokenProgram: Address;
}
/** Fetch + decode one Pool account. Read-only against the loader; reserves are read LIVE on-chain
 *  at swap time (see emitSetup) — nothing about the curve state is baked here. */
export declare function fetchTrendsPoolConfig(load: AccountLoader, pool: Address): Promise<TrendsPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like obric-v2/solfi-v2). */
export declare const trends: {
    slug: string;
    programId: Address<"CURVEmPpijXDTNdqrA9PGP1io2rkgiVXH26xdXVGLLfz">;
    fetchPoolConfig: typeof fetchTrendsPoolConfig;
};
export declare const trendsLadder: SvmVenueLadder;
export {};
//# sourceMappingURL=index.d.ts.map