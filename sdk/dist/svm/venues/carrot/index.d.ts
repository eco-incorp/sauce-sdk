import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
export declare const CARROT_PROGRAM_ID: Address<"CarrotwivhMpDnm27EHmRLeQ683Z1PufuqEmBZvD282s">;
export declare const CRT_MINT: Address<"CRTx1JouZhzSU6XytsE42UQraoGqiHgxabocVfARTy2s">;
/** The one deployed vault — a PDA of `["vault", CRT_MINT]`, singleton today. */
export declare const CARROT_VAULT_ADDRESS: Address<"FfCRL34rkJiMiX5emNDrYp3MdWH2mES3FvDQyFppqgpJ">;
/** See the module header's TOKEN PROGRAM note — CRT (shares) plus pyUSD are the only Token-2022 mints today. */
export declare const CARROT_TOKEN_2022_MINTS: ReadonlySet<Address>;
/**
 * Fail-loud cap on basket size (not a silent truncation) — see the module
 * header's SELF-DROP SCOPE note. The vault has held exactly 3 assets
 * (USDC/USDT/pyUSD) for its entire observed history; `paramCount` below is
 * sized for this. A real 4th-asset addition needs this constant (and
 * `paramCount`) bumped, not a silent misquote.
 */
export declare const CARROT_MAX_ASSETS = 3;
/** Pyth `PriceUpdateV2` (pyth-solana-receiver) layout, confirmed live against all 3 basket oracles. */
declare const PYTH_RECEIVER_PROGRAM_ID: Address<"rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ">;
declare const U64_MAX: bigint;
export interface CarrotAssetSnapshot {
    /** The on-chain `asset_id` (stable identity — NOT the array index, which can shift if an asset is ever removed). */
    assetId: number;
    mint: Address;
    decimals: number;
    /** The vault's own ATA for this asset — read live on-chain (balance) at cook time. */
    ata: Address;
    oracle: Address;
    /** Baked absolute byte offset of the oracle's live i64 price field (73 for `Full`, 74 for `Partial` — see module header). */
    priceOffset: number;
    /** `10^(CARROT_TARGET_SCALE + oracleExponent - decimals)` — see module header. */
    scale: bigint;
    /** Fetch-time snapshot, used ONLY for the prepare-time staleness/positivity gate — the fragment re-reads price live. */
    priceSnapshot: bigint;
    publishTime: bigint;
}
export interface CarrotPoolConfig extends PoolConfig {
    venue: 'carrot';
    sharesMint: Address;
    /** Vault-level redemption fee, bps (1 unit = 1/10000) — snapshotted at fetch time, re-staged like any other family's fee param. */
    redemptionFeeBps: bigint;
    /** Every basket asset, in vault order — ALWAYS all of them (see module header's SELF-DROP SCOPE note). */
    assets: readonly CarrotAssetSnapshot[];
    /** `issue:<assetId>` | `redeem:<assetId>` — see module header. */
    direction: string;
}
export interface CarrotDirection {
    op: 'issue' | 'redeem';
    assetId: number;
}
export declare function parseCarrotDirection(direction: string): CarrotDirection;
/** Every `issue:<id>` / `redeem:<id>` direction the fetched vault currently offers, in asset order — the multi-direction dispatch `resolveSvmPoolSpec` tries (see `the consuming app SVM solver entry`). */
export declare function carrotAllDirections(cfg: PoolConfig): string[];
export declare const carrot: {
    slug: "carrot";
    programId: Address<"CarrotwivhMpDnm27EHmRLeQ683Z1PufuqEmBZvD282s">;
    fetchPoolConfig: (load: AccountLoader, pool: Address) => Promise<CarrotPoolConfig>;
};
/** Prepare-time direction gate: self-drops the SPECIFIC direction (not the whole vault) if its asset's oracle reading is stale. */
export declare function carrotGate(base: PoolConfig, now: bigint): void;
export declare function carrotMints(base: PoolConfig): {
    inMint: Address;
    outMint: Address;
};
export declare function carrotApplyDirection(base: PoolConfig, direction: string | undefined): CarrotPoolConfig;
export { PYTH_RECEIVER_PROGRAM_ID, U64_MAX as CARROT_U64_MAX };
//# sourceMappingURL=index.d.ts.map