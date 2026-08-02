import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
export interface SplTokenSwapForkPoolConfig extends PoolConfig {
    /** Swap-authority PDA: create_program_address([pool, [bump_seed@2]], THIS fork's program). */
    swapAuthority: Address;
    /** token_program_id @3. */
    tokenProgram: Address;
    /** Vault of the input mint (token_a @35 — quote direction is A -> B). */
    vaultIn: Address;
    /** Vault of the output mint (token_b @67). */
    vaultOut: Address;
    /** pool_mint @99 — writable in the swap ix (owner fee is minted as LP tokens). */
    poolMint: Address;
    /** pool_fee_account @195 — pool-mint token account receiving the owner fee. */
    poolFeeAccount: Address;
    /** token_a_mint @131. */
    inputMint: Address;
    /** token_b_mint @163. */
    outputMint: Address;
    /** trade_fee_numerator @227 / trade_fee_denominator @235. */
    tradeFeeNumerator: bigint;
    tradeFeeDenominator: bigint;
    /** owner_trade_fee_numerator @243 / owner_trade_fee_denominator @251. */
    ownerTradeFeeNumerator: bigint;
    ownerTradeFeeDenominator: bigint;
    /** bump_seed @2 — the stored (not necessarily canonical) swap-authority nonce. */
    bumpSeed: number;
}
export interface SplTokenSwapForkAdapter {
    slug: string;
    kind: 'constant-product';
    programId: Address;
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<SplTokenSwapForkPoolConfig>;
    quoteAccounts(cfg: SplTokenSwapForkPoolConfig): VenueAccount[];
    emitQuote(cfg: SplTokenSwapForkPoolConfig, i: number, amountIn: bigint): string;
    buildSwap(cfg: SplTokenSwapForkPoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
    referenceQuote(cfg: SplTokenSwapForkPoolConfig, state: AccountBytesMap, amountIn: bigint, _now: bigint): bigint;
}
/**
 * One adapter per deployed spl-token-swap fork — SAME math/layout as
 * orca-legacy-token-swap (see module header), parameterized only by the
 * fork's own program id (the CPI target AND the swap-authority PDA domain).
 *
 * `unresolvedGate`, when passed, makes `fetchPoolConfig` throw UNCONDITIONALLY
 * for every pool of this family (naming the reason) — the SAME mechanism
 * `orca-legacy-token-swap` uses to keep its stable-curve pools out of the
 * electable universe (see that adapter's `curve_type` check), just applied to
 * the WHOLE family instead of a per-pool byte. `resolveSvmPoolSpec` catches
 * any `fetchPoolConfig` throw and drops the candidate — one venue's gate
 * never breaks discovery or any other family, and (critically) it means the
 * family is WIRED (program id, discovery filter, CU entry all present and
 * exercised) while being STRUCTURALLY UNABLE to enter a cook until the gate
 * is lifted, so there is zero production revert/mispricing risk from an
 * unresolved integration question. See ./index.ts's `dexlab`/`saros`
 * instantiations below for the two currently gated forks and exactly what
 * each is waiting on.
 */
export declare function makeSplTokenSwapForkAdapter(slug: string, programId: Address, unresolvedGate?: string): SplTokenSwapForkAdapter;
/** Token Swap — the original solana-labs/solana-program-library deployment. */
export declare const TOKEN_SWAP_V1_PROGRAM_ID: Address;
export declare const tokenSwapV1: SplTokenSwapForkAdapter;
/**
 * DexLab — GATED (see `unresolvedGate` above): a real-CPI probe against the
 * live mainnet binary (a real SOL/USDC pool, `4KizLX56YSbTtc8NJQWDBz3iiwSTpJRHFUXAvB4v6MM3`,
 * dumped 2026-07-31) shows the deployed `Swap` instruction reads MORE than
 * the standard spl-token-swap 10 (or 11, with the optional host-fee account)
 * accounts — it still fails `NotEnoughAccountKeys` with 10 or 11 provided,
 * and only clears that check at 14 (10 + 4 arbitrary dummy reads), at which
 * point it fails a DIFFERENT (custom code 24) check — meaning DexLab's fork
 * genuinely extends the account list with something this repo hasn't
 * identified (no public source was available to cross-reference). Gated
 * rather than guessed at: a wrong account list here would revert every
 * dexlab cook in production, and DexLab is otherwise the single
 * deepest-liquidity fork of the six (2,097 live constant-product pools).
 */
export declare const DEXLAB_PROGRAM_ID: Address;
export declare const dexlab: SplTokenSwapForkAdapter;
/**
 * Saros — GATED (see `unresolvedGate` above): a real-CPI probe against the
 * live mainnet binary (a real SOL/USDC pool,
 * `Djxfn7zWFxFqYgwesXfq8BeAirfXwfhQmNcCousXh7G7`, dumped 2026-07-31) executes
 * successfully with the standard 10-account list, but its REALIZED output
 * implies an effective swap fee of a clean, reproducible 4 bps across five
 * independently-tested trade sizes (10 SOL, 100 SOL down to 0.1 SOL raw
 * equivalents) — NOT the 30 bps the pool's own on-chain `owner_trade_fee`
 * field states (`trade_fee` reads 0 bps). The account layout is confirmed
 * correct up through `pool_fee_account` (the swap only succeeds because that
 * key check passes), so this is a genuine fee-MODEL divergence, not a decode
 * bug — Saros's deployed program evidently does not compute the swap fee the
 * vanilla spl-token-swap way from the fields at these offsets, and no public
 * source was available to determine the real rule. Gated rather than
 * guessed at: shipping the wrong fee would silently misquote (and
 * mis-elect) a real, actively-traded venue by ~0.26% per trade.
 */
export declare const SAROS_PROGRAM_ID: Address;
export declare const saros: SplTokenSwapForkAdapter;
/**
 * Orca V1 — the ORIGINAL Orca token-swap deployment, a DIFFERENT program from
 * the already-wired `orca-legacy-token-swap` ("Orca V2",
 * `9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP`). Confirmed distinct live
 * (routePlan ammKey `6fTRDD7sYxCN7oyoSQaN1AWC3P2m8A6gVZzGrpej9DvL`, owner
 * `DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1`).
 */
export declare const ORCA_V1_PROGRAM_ID: Address;
export declare const orcaV1: SplTokenSwapForkAdapter;
/** Penguin. */
export declare const PENGUIN_PROGRAM_ID: Address;
export declare const penguin: SplTokenSwapForkAdapter;
/** StepN (Dooar). */
export declare const STEPN_PROGRAM_ID: Address;
export declare const stepn: SplTokenSwapForkAdapter;
//# sourceMappingURL=index.d.ts.map