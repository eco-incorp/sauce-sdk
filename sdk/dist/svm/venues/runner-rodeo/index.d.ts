import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
declare const SLUG: "runner-rodeo";
export declare const RUNNER_RODEO_PROGRAM_ID: Address;
export interface RunnerRodeoPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** exactIn side: 'quoteToBase' (default, buy) | 'baseToQuote' (sell). */
    direction: 'quoteToBase' | 'baseToQuote';
    configAccount: Address;
    baseVault: Address;
    quoteVault: Address;
    baseMint: Address;
    quoteMint: Address;
    baseTokenProgram: Address;
    creatorFeeVault: Address;
    creatorFeeBps: bigint;
    protocolFeeBpsA: bigint;
    protocolFeeBpsB: bigint;
}
export declare const runnerRodeo: {
    slug: "runner-rodeo";
    kind: "constant-product";
    programId: Address;
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<RunnerRodeoPoolConfig>;
};
export declare const runnerRodeoLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=index.d.ts.map