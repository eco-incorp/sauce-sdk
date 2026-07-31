/**
 * Stabble Weighted Swap venue adapter — program
 * `swapFpHZwjELNnjvThjajtiVmkz3yPQEHjLtka2fwHW`, a Balancer-style weighted
 * (2..4 token) Anchor AMM sharing the SAME `Pool`/`Vault` account shapes and
 * `Vault` custody program as its stable-swap sibling. See
 * `../stabble-common.ts`'s module doc for the shared layout citations and
 * `weighted_math.rs`'s `#[test]`-verified math this port mirrors.
 *
 * SCOPE: AtoB only (tokens[0] -> tokens[1]) — see the stable-swap sibling's
 * module doc for why (same precedent this repo already carries for
 * saber-stableswap/meteora-damm-v1-stable); the underlying math
 * (`weightedCalcOutGivenIn`) supports ANY token-index pair. Only plain
 * SPL-Token (Tokenkeg) mints are in scope (the v1 `swap` entry point, not
 * `swap_v2`, carries no Token-2022/transfer-fee accounting).
 *
 * A REAL, on-chain hard capacity cap applies: `amountIn` (wrapped) past 30%
 * of the wrapped `balanceIn` makes the real program's own `calc_out_given_in`
 * return `None` (an instruction panic, not a graceful 0) — `emitQuote`/
 * `referenceQuote` below CLAMP to that boundary rather than reproducing the
 * panic, matching this repo's "a capacity bound is real depth, not an
 * arithmetic accident" convention (see meteora-damm-v1-stable's ladder doc).
 */
import type { Address } from '@solana/kit';
import { type StabbleTokenScale } from '../stabble-common.js';
import type { PoolConfig, SvmVenueAdapter } from '../types.js';
declare const SLUG = "stabble-weighted-swap";
declare const INVARIANT_OFFSET = 106;
declare const WEIGHT_SUB_OFFSET = 50;
export interface StabbleWeightedToken extends StabbleTokenScale {
    mint: Address;
    decimals: number;
    balance: bigint;
    weight: bigint;
    vaultTokenAccount: Address;
}
export interface StabbleWeightedSwapPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    vault: Address;
    authorityBump: number;
    isActive: boolean;
    swapFee: bigint;
    tokens: StabbleWeightedToken[];
    vaultAuthority: Address;
    withdrawAuthority: Address;
    beneficiary: Address;
    beneficiaryTokenOut: Address;
}
export declare const stabbleWeightedSwap: SvmVenueAdapter;
export { INVARIANT_OFFSET as STABBLE_WEIGHTED_INVARIANT_OFFSET, WEIGHT_SUB_OFFSET };
//# sourceMappingURL=index.d.ts.map