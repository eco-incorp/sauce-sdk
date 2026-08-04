import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "solfi-v1";
export declare const SOLFI_V1_PROGRAM_ID: Address<'SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe'>;
export declare const POOL_ACCOUNT_SIZE = 2800;
export declare const OFF_MINT_A = 2664;
export declare const OFF_MINT_B = 2696;
export declare const OFF_VAULT_A = 2736;
export declare const OFF_VAULT_B = 2768;
/**
 * The verified conservative floor rate for a pool + direction: real realized
 * output is >= (num/den)·amountIn at every sampled size (see the module doc
 * and docs/solfi-v1-evidence.md for the raw LiteSVM sweep this was derived
 * from — NOT a claim about the venue's real fee/impact schedule, a safety
 * floor sized so the model never over-promises).
 */
export interface SolfiV1FloorRate {
    num: bigint;
    den: bigint;
}
/**
 * Per-pool, per-direction verified floor rates. A pool absent here THROWS at
 * `fetchPoolConfig` (see `fetchSolfiV1Config`) — never borrowed from another
 * pool, mirroring solfi-v2's `POOL_K`. direction 0 = mintA -> mintB, 1 =
 * mintB -> mintA (matches the on-chain instruction's direction byte).
 *
 * '65ZHSArs...'-style single-pool coverage today: the only pool this
 * integration's LiteSVM sweep verified (docs/solfi-v1-evidence.md). Extend
 * by running the same sweep against another pool's real bytes.
 */
export declare const SOLFI_V1_POOL_RATES: Record<string, {
    0: SolfiV1FloorRate;
    1: SolfiV1FloorRate;
}>;
export interface SolfiV1PoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 0 = mintA -> mintB, 1 = mintB -> mintA. */
    direction: 0 | 1;
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
    rate0: SolfiV1FloorRate;
    rate1: SolfiV1FloorRate;
}
/**
 * Off-chain gate + decode: pool size, mint/vault pubkeys (plaintext, fixed
 * offsets — verified across all 40 discovered pools), and the per-pool
 * verified floor rate (REQUIRED — see `SOLFI_V1_POOL_RATES`; a pool not yet
 * independently verified throws rather than guessing).
 */
export declare function fetchSolfiV1Config(load: AccountLoader, pool: Address, direction?: 0 | 1): Promise<SolfiV1PoolConfig>;
export {};
//# sourceMappingURL=index.d.ts.map