import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
declare const SLUG = "zerofi";
export declare const ZEROFI_PROGRAM_ID: Address<"ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY">;
export declare const POOL_ACCOUNT_SIZE = 38176;
export declare const ORACLE_ACCOUNT_SIZE = 128;
export declare const OFF_MINT_A = 72;
export declare const OFF_MINT_B = 104;
export declare const OFF_VAULT_A = 136;
export declare const OFF_COMPANION_A = 168;
export declare const OFF_VAULT_B = 200;
export declare const OFF_COMPANION_B = 232;
export declare const OFF_ORACLE = 2184;
/** IEEE-754 f64 LE price word inside the oracle account (mintB per whole mintA). */
export declare const PRICE_OFFSET = 48;
/** `swap_v4`'s single-byte discriminator (NOT an 8-byte Anchor sighash). */
export declare const ZEROFI_SWAP_DISCRIMINATOR = 16;
/**
 * Per-pool, per-direction fee/spread the ladder charges against the raw
 * oracle mid, in parts-per-million, ROUNDED UP from the measured realized
 * ratio (see module doc) so a predicted quote never exceeds the real fill —
 * REFUSE (fetchPoolConfig throws), don't guess, for any pool not listed
 * here. Keyed by pool account address (the 38,176-byte account), matching
 * solfi-v2's POOL_K precedent: a pool is never assumed to share its
 * neighbor's fee.
 */
export declare const ZEROFI_POOL_FEE_PPM: Readonly<Record<string, bigint>>;
/**
 * The registered authority + its own token-account pair, per pool — see the
 * module doc's "ACCOUNT 8" note. UNCONFIGURED BY DEFAULT: there is no
 * synthesizable value (a bare PDA does not satisfy the live program's
 * check, see the module doc), so `fetchPoolConfig` throws for any pool
 * without an entry here rather than wiring an address guaranteed to fail
 * on-chain. Populate this once ZeroFi (or whatever registry backs the
 * check) recognizes this deployment's own authority.
 */
export declare const ZEROFI_POOL_AUTHORITY: Readonly<Record<string, {
    authority: Address;
    authorityAtaA: Address;
    authorityAtaB: Address;
}>>;
/**
 * Conservative quotable-capacity divisor: the ladder never quotes more than
 * `liveReserveOut / CAP_DIVISOR` output (see ladder.ts). 20 == 5% of the
 * live output vault. This is NOT a measured venue depth limit (the true
 * capacity model is unresolved — see the module doc's "ACCOUNTS 6/7" note);
 * it is a deliberately-conservative ceiling picked so that every measured
 * real fill in this integration's sample (largest: 262,787,635 raw USDC
 * against a >29B raw USDC vault, ~0.9% of reserve) sat comfortably inside
 * it, while still being far short of "unbounded" — an unbounded linear
 * quote is unsafe on its own (a more-favourable-than-real quote wins merge
 * elections it cannot actually fill).
 */
export declare const CAP_DIVISOR = 20n;
export interface ZeroFiPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 0 = mintA -> mintB (vaultA is the deposit vault), 1 = mintB -> mintA. */
    direction: 0 | 1;
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
    companionA: Address;
    companionB: Address;
    oracle: Address;
    tokenProgramA: Address;
    tokenProgramB: Address;
    decimalsA: number;
    decimalsB: number;
    /** See module doc "ACCOUNT 8" / ZEROFI_POOL_AUTHORITY — pending ZeroFi-side registration. */
    authority: Address;
    authorityAtaA: Address;
    authorityAtaB: Address;
    /** Verified per-pool fee/spread, ppm (see ZEROFI_POOL_FEE_PPM). */
    feePpm: bigint;
    /**
     * Baked IEEE-754 scale constants derived from the oracle bytes AT FETCH
     * TIME (see ladder.ts's `ieee754ScaleParams` / module doc) — decimals-
     * adjusted, gcd-reduced. `bakedTop` is compared against the LIVE oracle
     * bit pattern on-chain every cook (a mismatch deactivates the slot); the
     * rest scale the live mantissa. Read-only re-derivation from the SAME
     * oracle bytes fetchPoolConfig already loaded, exactly mirroring how
     * obric-v2 bakes its own oracle-derived divX/mulX/divY/mulY into
     * PoolConfig rather than re-reading them at paramsFor time.
     */
    scaleBakedTop: bigint;
    scaleShiftPre: bigint;
    scaleNum: bigint;
    scaleDen: bigint;
}
export declare const zerofi: {
    slug: string;
    kind: "constant-product";
    programId: Address<"ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY">;
    /**
     * Off-chain gate + decode. `pool` is the 38,176-byte account (see module
     * doc). Rejects: wrong size, missing account, a pool absent from the
     * verified fee catalog, a pool without a registered authority (REFUSE,
     * don't guess, for both — see ZEROFI_POOL_FEE_PPM / ZEROFI_POOL_AUTHORITY),
     * and missing mint/oracle accounts. Tokenkeg-only (both sampled pools use
     * plain Tokenkeg for both legs, confirmed from real swap_v4 account
     * lists — slots 9/11 are always TokenkegQfeZy...; a Token-2022 pool
     * changes wire semantics this adapter has not verified against, the
     * same scope restriction obric-v2 documents for itself).
     */
    fetchPoolConfig(load: AccountLoader, pool: Address, direction?: 0 | 1): Promise<ZeroFiPoolConfig>;
    quoteAccounts(cfg: PoolConfig): VenueAccount[];
    /**
     * v1 swap CPI (amount baked). disc(1) || amountIn u64 LE || minOut u64
     * LE=1. NOTE (see module doc): this CPI settles through the registered
     * `c.authority`'s own ATAs, not `user`'s — `user` is accepted for
     * interface parity with every other adapter but is UNUSED here (there is
     * no slot for an arbitrary caller-owned token account in this venue's
     * instruction — see zerofiSwapAccounts).
     */
    buildSwap(cfg: PoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
};
/**
 * The 14-account order for ZeroFi's `swap_v4` (disc 0x10) — see module doc
 * for the full derivation and the measured fund-flow proof. The pool's own
 * vaultA/vaultB (slots 3/5, direction-selected) and the registered
 * authority's own ATA pair (slots 6/7) are the ONLY accounts that carry
 * value; slot 8 is the authority's signature. There is deliberately no
 * `user`-token-account parameter — see `zerofi.buildSwap`'s doc.
 */
export declare function zerofiSwapAccounts(c: ZeroFiPoolConfig, make: (ref: string, addr: Address, writable?: boolean) => VenueAccount, refFor?: (role: string) => string): VenueAccount[];
export {};
//# sourceMappingURL=index.d.ts.map