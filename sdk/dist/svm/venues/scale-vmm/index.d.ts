/**
 * Scale VMM (`scale_vmm`, program SCALEWoRSpVZpMRqHEcDfNvBh3nUSe34jDr9r689gLa) venue
 * adapter — the sibling bonding-curve program a pair trades on BEFORE it "graduates"
 * (migrates its liquidity into a real scale-amm Pool once `token_b_reserves` crosses
 * `graduation_threshold`). Same curve/fee math as scale-amm (see scale-common.ts), a
 * different account layout, and mandatory extra accounts for the migration CPI that fires
 * atomically inside `buy`/`sell` when the threshold is crossed mid-trade.
 *
 * PairState account layout (327 bytes, disc e5d4dedebf80b0eb — sha256("account:PairState")):
 *   enabled:bool@8  graduated:bool@9  mint_a:pubkey@10  mint_b:pubkey@42
 *   token_a_reserves:u128@74  token_b_reserves:u128@90  shift:u128@106
 *   curve:u8@122  fee_beneficiary_count:u8@123  fee_beneficiaries:[FeeBeneficiary;5]@124
 *   amm_pool:pubkey@294  bump:u8@326
 * PlatformConfig (PDA seeds=["config"] under THIS program — same disc/offsets as
 * scale-amm's, plus a trailing graduation_threshold:u64@106, bump moves to @114).
 *
 * GRADUATION GATE: a graduated pair's `enabled` is false and its reserves are drained to
 * 0 (verified live: pair BWnowWbMBTfsLzTKgZM7vnh8SxbutJA2HB4z7Labswkb, graduated=true,
 * reserves 0/0, whose `quote_buy` reverts on-chain with AnchorError PairDisabled/6000) —
 * the migrated liquidity lives on in a REAL scale-amm Pool at `amm_pool`, independently
 * discoverable through scaleAmm's own gPA sweep. So the `enabled` gate alone (mirroring
 * scale-amm's identical check) is sufficient; `graduated` is checked too, defensively,
 * since it is a stronger and independent signal of the same fact.
 *
 * MIGRATION ACCOUNTS (amm_pool/amm_vault_a/amm_vault_b/amm_config) are REQUIRED on every
 * `buy`/`sell`, not just a graduating one — the IDL's fixed IDL account list carries them
 * unconditionally (Anchor CPIs into scale_amm's `create_from_vmm` only when the trade
 * actually crosses the threshold, but the accounts must be validly derived up front
 * regardless). Their PDA derivation was reverse-engineered from a live, non-graduating
 * buy transaction (WgDtuzy7QjrCPRyFxZBuwQQ6UHrPFRpEgggukmVSBk6QFmMdLm6HFHji1AeXNLtQFeGdV1JeaqwYaNFsXSmHScr)
 * and confirmed to reproduce all three addresses byte-exact:
 *   amm_pool    = PDA(scale_amm, ["pool", THIS PairState's own address, mint_a, mint_b])
 *   amm_vault_a = PDA(scale_amm, [amm_pool, mint_a])
 *   amm_vault_b = PDA(scale_amm, [amm_pool, mint_b])
 *   amm_config  = PDA(scale_amm, ["config"])   (the SAME constant PDA scale-amm.ts uses)
 * i.e. the migrated pool's "owner" (scale-amm Pool PDA seed) is the VMM PairState's OWN
 * address, not a wallet — the VMM program CPI-signs `create_from_vmm` for it via
 * `invoke_signed` over the pair's own seeds.
 *
 * REMAINING ACCOUNTS: SAME pattern as scale-amm (see that file's module doc) — one extra
 * writable account per ACTIVE fee_beneficiary, ata(mint_a) of that beneficiary's wallet.
 * A first pass at this file (going only off a live transaction's account COUNT) concluded
 * VMM carries none; that was wrong, and the real-CPI lane
 * (ecoswap-svm.scale.realcpi.e2e.test.ts) caught it immediately: omitting the remaining
 * account reverts on-chain with AnchorError MissingBeneficiaryAccount (6013). The
 * confusion: that reference transaction's beneficiary wallet happened to be the SAME
 * wallet as the trader (its 19th account, the beneficiary's mint_a ATA, is therefore
 * byte-identical to user_ta_a's own ATA, an 18-vs-19-looking coincidence) — a reminder
 * that a real transaction's account COUNT is not proof of a fixed schema without checking
 * every address is what it claims to be.
 */
import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
import { type FeeBeneficiary, type ScaleDirection } from '../scale-common.js';
declare const SLUG = "scale-vmm";
export interface ScaleVmmPoolConfig extends PoolConfig {
    venue: typeof SLUG;
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
    ammPool: Address;
    ammVaultA: Address;
    ammVaultB: Address;
    ammConfig: Address;
    /** 'aToB' (default, buy: mint_a in / mint_b out) | 'bToA' (sell: mint_b in / mint_a out). */
    direction: ScaleDirection;
}
export declare const scaleVmm: {
    slug: string;
    kind: "constant-product";
    programId: Address<"SCALEWoRSpVZpMRqHEcDfNvBh3nUSe34jDr9r689gLa">;
    fetchPoolConfig(load: AccountLoader, pair: Address): Promise<ScaleVmmPoolConfig>;
};
export declare const scaleVmmLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=index.d.ts.map