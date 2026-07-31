import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
declare const SLUG = "deriverse";
export declare const DERIVERSE_PROGRAM_ID: Address;
/**
 * `find_program_address([b"ndxnt"], programId)` — ONE PDA for the whole
 * program (drv-smart-contract-common's `DRVS_SEED`), independent of any
 * pool. Hardcoded (verified against mainnet via an offline PDA derivation,
 * not read from any account) exactly like raydium-amm-v4's `AMM_AUTHORITY`.
 */
export declare const DERIVERSE_AUTH: Address;
/**
 * The front slice of `InstrAccountHeader` this adapter reads (1064 bytes,
 * drv-smart-contract-common v0.2.68). The LIVE deployed account is larger
 * (2344 bytes observed on both checked instruments) — the extra bytes are
 * unread reserved tail space (candle/history buffers not yet promoted to
 * named fields), exactly the pattern jupiter-deriverse's own
 * `AccountsHolder::from_account` relies on (`&data[0..size_of::<T>()]`).
 * fetchPoolConfig accepts anything >= this size, never an exact match.
 */
export declare const INSTR_ACCOUNT_HEADER_MIN_SIZE = 1064;
export declare const OFF_MASK = 28;
export declare const OFF_LAST_PX = 32;
export declare const OFF_ASSET_TOKENS = 144;
export declare const OFF_CRNCY_TOKENS = 152;
export declare const OFF_DEC_FACTOR = 800;
export declare const MASK_SUSPENDED = 32;
/**
 * Bakes ONE conservative fee-ppm constant from a fetch-time snapshot of the
 * instrument's fee inputs. `ZeroFees` (mask bit 0x1) is a protocol invariant
 * that zeros BOTH the AMM fee_rate and the protocol swap_fee_rate (lib.rs's
 * `quote()`, both branches check it first) — trusted exactly, no margin.
 * Otherwise: `FixedFees` (0x2) uses the admin-set static `fixed_fee_rate`;
 * the default case uses the DYNAMIC `day_volatility * spot_fee_rate *
 * FEE_RATE_STEP`, which can drift between this snapshot and the eventual
 * cook (it is a live, per-trade-recalculated statistic, not frozen). Either
 * way the raw ppm is DOUBLED plus a flat +20ppm floor: the margin absorbs
 * (a) day_volatility drift and (b) the deployed binary's protocol-level
 * `swap_fee_rate` (currently the constant 0 in the drv-models crate, but not
 * independently re-derivable from account state, and a bigger assumed fee
 * only ever LOWERS the predicted output — the safe direction; assuming it
 * stays 0 is the unsafe one). This is the ONLY fee derivation this adapter
 * does off-chain; the ladder never reads day_volatility/fixed_fee_rate live.
 */
export declare function conservativeFeePpm(mask: number, dayVolatility: number, spotFeeRate: number, fixedFeeRate: number): bigint;
export interface DeriversePoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'sell' (default, asset in / crncy out — input_crncy=0) | 'buy' (crncy in / asset out — input_crncy=1). */
    side: 'buy' | 'sell';
    instrId: number;
    assetTokenId: number;
    crncyTokenId: number;
    assetMint: Address;
    crncyMint: Address;
    /** The instrument's own asset/crncy vault token accounts (a_token_state/b_token_state.program_address). */
    assetVault: Address;
    crncyVault: Address;
    asksTree: Address;
    askOrders: Address;
    bidsTree: Address;
    bidOrders: Address;
    lines: Address;
    mapsAddress: Address;
    clientInfos: Address;
    tokenProgram: Address;
    /** Conservative baked fee (see {@link conservativeFeePpm}), ppm of 1e6. */
    feePpm: bigint;
}
export declare const deriverse: {
    slug: string;
    kind: "constant-product";
    programId: Address;
    /**
     * Off-chain gate + decode. Rejects: too-short account data, a non-INSTR
     * discriminator or an unrecognized schema version (defends the fixed
     * offsets above against a future account-layout migration), and an empty
     * `dec_factor` (would divide by zero in the curve). An empty embedded AMM
     * (`asset_tokens == crncy_tokens == 0`, a real live case — the pair trades
     * purely off its resting book) is NOT rejected here: it is a live-state
     * fact the ladder's own enable gate reads every quote, exactly like a
     * drained obric-v2/raydium pool.
     */
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<DeriversePoolConfig>;
    quoteAccounts(cfg: PoolConfig): VenueAccount[];
    /** v1 swap CPI (amount baked) — the unified `Swap` instruction (tag 26). */
    buildSwap(cfg: PoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
};
/**
 * The 14-account order for Deriverse's `Swap` (disc 26 — SwapInstruction::
 * MIN_ACCOUNTS), shared by v1 buildSwap and v2 buildSwapV2: [signer, asset
 * mint, crncy mint, asset vault, crncy vault, instrument, {asks_tree,
 * ask_orders} on buy / {bids_tree, bid_orders} on sell, lines, maps, client
 * infos, asset-side user ATA, crncy-side user ATA, token program]. User ATAs
 * are POSITIONAL BY MINT (asset vs crncy), not by direction — the same trap
 * documented on solfi-v2/quantum.
 */
export declare function deriverseSwapAccounts(c: DeriversePoolConfig, user: SwapUser, make: (ref: string, addr: Address, writable?: boolean) => VenueAccount, refFor?: (role: string) => string): VenueAccount[];
export {};
//# sourceMappingURL=index.d.ts.map