import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, VenueAccount } from '../types.js';
declare const SLUG = "scorch";
/** CORE — pool state owner + pricing engine. This is `SVM_VENUE_PROGRAM_IDS.scorch`. */
export declare const SCORCH_CORE_PROGRAM_ID: Address<"ojh19ojaKduoJZuaJADhcVGp4xt1TcdAvZmpVsCorch">;
/** ROUTER — the real custodian; the swap CPI's actual CALL target. */
export declare const SCORCH_ROUTER_PROGRAM_ID: Address<"SCoRcH8c2dpjvcJD6FiPbCSQyQgu3PcUAWj2Xxx3mqn">;
/**
 * Conservative haircut on the raw vault-reserve-ratio price (parts per
 * million of the naive constant-product output) — see this file's top
 * docblock for the measured justification. 300,000 = keep 70% of the naive
 * CP output.
 */
export declare const SCORCH_HAIRCUT_PPM = 300000n;
export interface ScorchPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'AtoB' (default, mintA in / mintB out) | 'BtoA'. */
    direction: 'AtoB' | 'BtoA';
    mintA: Address;
    vaultA: Address;
    assetConfigA: Address;
    mintB: Address;
    vaultB: Address;
    assetConfigB: Address;
}
export declare const scorch: {
    slug: string;
    kind: "constant-product";
    programId: Address<"ojh19ojaKduoJZuaJADhcVGp4xt1TcdAvZmpVsCorch">;
    /**
     * Reads the PairConfig account directly (mints + vaults; both mints' known
     * AssetConfig addresses resolved via the vendored directory). Throws a
     * clear, named error — never silently mis-decodes — on wrong size/tag, a
     * missing AssetConfig entry (a not-yet-snapshotted asset), or a
     * non-classic (likely token-2022) vault; any of those drops just this ONE
     * pool from discovery, per the venue-robustness convention.
     */
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<ScorchPoolConfig>;
    quoteAccounts(base: PoolConfig): VenueAccount[];
};
export {};
//# sourceMappingURL=index.d.ts.map