import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
declare const SLUG = "binaryfi";
export declare const BINARYFI_PROGRAM_ID: Address<"B72M6nyCLFgWiJtAN4naUTminMiTmyGcEqQHXwVeRdht">;
/** Single global config account, shared by every market (see file header). */
export declare const BINARYFI_CONFIG: Address<"AR7uY4Uzn8Zhzvb1XiqfoejuVYgimFAVTwnFBqTnGznS">;
export interface BinaryFiPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    vaultAuthority: Address;
    assetMint: Address;
    quoteMint: Address;
    assetVault: Address;
    quoteVault: Address;
    /** Conservative per-asset floor rate (assetOut-raw per quoteIn-raw) — see asset-configs.ts. */
    floorRateNum: bigint;
    floorRateDen: bigint;
}
export declare const binaryfi: {
    slug: string;
    kind: "constant-product";
    programId: Address<"B72M6nyCLFgWiJtAN4naUTminMiTmyGcEqQHXwVeRdht">;
    /**
     * Reads the Market account directly (vault-authority, both mints, both
     * vaults). Throws a clear, named error — never silently mis-decodes — on
     * wrong size/tag or a non-classic (likely token-2022) vault; either drops
     * just this ONE pool from discovery. Separately gates on a calibrated
     * floor rate for the decoded asset mint (`BINARYFI_ASSET_FLOOR_RATES`) —
     * a market whose asset has not been independently measured is dropped
     * the same way, per this file's module header.
     */
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<BinaryFiPoolConfig>;
    quoteAccounts(base: PoolConfig): VenueAccount[];
};
export declare const binaryfiLadder: {
    slug: string;
    shapeKey(base: PoolConfig): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    /** Two params: the per-asset conservative floor rate (num, den). */
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[]): string;
    emitQuoteCall(_base: PoolConfig, slot: number, x: string): string;
    /**
     * The real, ground-truthed swap ix (see file header): disc(1)=0x08 ++
     * amountIn(8, patched) ++ minOut(8)=0. Account order/roles match 24 real
     * historical fills on the `GWqUcqoZtjq8...` market.
     */
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
export {};
//# sourceMappingURL=index.d.ts.map