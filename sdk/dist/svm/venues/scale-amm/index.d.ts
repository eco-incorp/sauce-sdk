/**
 * Scale AMM (`scale_amm`, program SCALEwAvEK5gtkdHiFzXfPgtk2YwJxPDzaV3aDmR7tA) venue
 * adapter — an Anchor-built constant-product/virtual-CP AMM (permissionless bonding-curve
 * style pool creation; 987 live `Pool` accounts observed at time of writing). See
 * scale-common.ts for the shared curve derivation and its empirical proof.
 *
 * Pool account layout (326 bytes, Anchor account disc f19a6d0411b16dbc — sha256("account:Pool")):
 *   enabled:bool@8  owner:pubkey@9  mint_a:pubkey@41  mint_b:pubkey@73
 *   token_a_reserves:u128@105  token_b_reserves:u128@121  shift:u128@137
 *   curve:u8@153  fee_beneficiary_count:u8@154  fee_beneficiaries:[FeeBeneficiary;5]@155
 *   (34 bytes each: wallet:pubkey + share_bps:u16)  bump:u8@325
 * PlatformConfig (PDA seeds=["config"], disc a04e8000f853e6a0 — sha256("account:PlatformConfig")):
 *   authority:pubkey@8  fee_beneficiary:pubkey@40  base_token:pubkey@72
 *   platform_fee_bps:u16@104  bump:u8@106
 *
 * vault_a/vault_b are PDAs seeds=[pool, mint_a]/[pool, mint_b] (no stored address —
 * derived, never read). `create`'s params take only `initial_token_b_reserves` (never
 * _a), confirming A is always the virtually-shifted side (see scale-common.ts).
 *
 * REMAINING ACCOUNTS (verified against a real mainnet `buy` transaction,
 * 5jqPoZ9Uw9kwNs4trJZ8EzuDd36vf8BLpMJgXXkgv26LK4uNAs57MLLYjSfudrCB2STUxxnGEurDKhRxPbiufCmv):
 * the 14 IDL-named accounts are followed by ONE extra writable account per ACTIVE
 * fee_beneficiary entry — that pool's beneficiary's own ATA(mint_a) (a
 * remaining_accounts pattern the IDL doesn't name). Confirmed byte-exact: the 15th
 * account on that (feeCount=1) pool's buy tx is exactly
 * ata(feeBeneficiaries[0].wallet, mint_a, TOKEN_PROGRAM). A feeCount=0 pool's real buy tx
 * carries exactly the 14 named accounts and nothing more. Because this changes the swap's
 * account-list LENGTH, feeBeneficiaryCount is part of shapeKey (see below) — pools with a
 * different active-beneficiary count cannot share a compiled slot fragment.
 */
import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, AccountBytesMap } from '../types.js';
import { type FeeBeneficiary, type ScaleDirection } from '../scale-common.js';
declare const SLUG = "scale-amm";
export interface ScaleAmmPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    owner: Address;
    mintA: Address;
    mintB: Address;
    reservesA: bigint;
    reservesB: bigint;
    shift: bigint;
    feeBeneficiaryCount: number;
    feeBeneficiaries: readonly FeeBeneficiary[];
    vaultA: Address;
    vaultB: Address;
    platformConfig: Address;
    platformFeeBps: bigint;
    platformFeeTaA: Address;
    /** ATA(mint_a) per ACTIVE (index < feeBeneficiaryCount) beneficiary — the remaining_accounts. */
    beneficiaryAtas: readonly Address[];
    tokenProgramA: Address;
    tokenProgramB: Address;
    /** 'aToB' (default, buy: mint_a in / mint_b out) | 'bToA' (sell: mint_b in / mint_a out). */
    direction: ScaleDirection;
}
export declare const scaleAmm: {
    slug: string;
    kind: "constant-product";
    programId: Address<"SCALEwAvEK5gtkdHiFzXfPgtk2YwJxPDzaV3aDmR7tA">;
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<ScaleAmmPoolConfig>;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, amountIn: bigint): bigint;
};
export type { ScaleDirection } from '../scale-common.js';
//# sourceMappingURL=index.d.ts.map