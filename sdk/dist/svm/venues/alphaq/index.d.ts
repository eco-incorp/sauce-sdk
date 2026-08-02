import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
declare const SLUG = "alphaq";
export declare const ALPHAQ_PROGRAM_ID: Address<"ALPHAQmeA7bjrVuccPsYPiCvsi428SNwte66Srvs4pHA">;
/** Minimal getProgramAccounts transport for the stats-account join (data included, unlike the
 *  pubkey-only {@link GetProgramAccountsRpc} discovery.ts uses for candidate scans). */
export interface AlphaqStatsRpc {
    getProgramAccounts(program: Address, config: {
        encoding: 'base64';
        filters: {
            dataSize: bigint;
        }[];
    }): {
        send(): Promise<readonly {
            pubkey: Address;
            account: {
                data: [string, string];
            };
        }[]>;
    };
}
/**
 * One-time (idempotent, memoized) live join for markets not yet in
 * {@link ALPHAQ_STATS_ACCOUNTS}. Safe to call repeatedly/concurrently — every
 * call after the first returns the SAME in-flight/completed promise. A
 * failure here never throws past the caller that awaits it losing anything
 * beyond "no new markets discovered this run" — the static table still
 * serves every market known at integration time.
 *
 * NOT auto-wired into `ecoswap/svm/discovery.ts`'s gPA sweep (deliberately —
 * it would add one extra getProgramAccounts call to EVERY discovery sweep for
 * a table that is already complete for every market that exists today). A
 * caller with its own boot sequence (the api, a CLI, a future cron) should
 * invoke this once with a live `getProgramAccounts` transport to pick up any
 * AlphaQ market added after this file was captured.
 */
export declare function primeAlphaqStatsAccounts(rpc: AlphaqStatsRpc): Promise<void>;
/** Test-only: seed the runtime overlay without a real RPC (LiteSVM/jest fixtures). */
export declare function __setAlphaqStatsAccountsForTest(entries: Readonly<Record<string, Address>>): void;
/** Test-only: undo {@link __setAlphaqStatsAccountsForTest} / a completed prime. */
export declare function __resetAlphaqStatsAccountsForTest(): void;
declare function decodeSymbol(data: Uint8Array): string;
export interface AlphaqPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'AtoB' (default, mintA -> mintB) | 'BtoA'. */
    direction: 'AtoB' | 'BtoA';
    symbol: string;
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
    decimalsA: number;
    decimalsB: number;
    /** The market's 336-byte hot-state companion account — WRITABLE in the swap CPI. */
    statsAccount: Address;
}
/**
 * Decode a market (672-byte) account. Throws (caller self-drops, per
 * `resolveSvmPoolSpec`'s existing try/catch) on: a size mismatch; a blank
 * symbol; either mint outside the curated `STABLE_MINTS` set (the "SCOPE
 * GATE" — this ladder's quote model is only safe for a genuine stablecoin
 * pair); mismatched decimals (the raw-unit depth comparison's precondition);
 * or a stats account this integration has neither the static table nor a
 * live prime for. A genuinely unknown/out-of-scope/future market is
 * dropped, never crashed on.
 */
export declare function fetchAlphaqPoolConfig(load: AccountLoader, pool: Address): Promise<AlphaqPoolConfig>;
/**
 * The symmetric constant-product model — see the module doc's "THE ACTUAL
 * MODEL". `D = min(rawA, rawB)` (raw units; safe because
 * `fetchAlphaqPoolConfig` gates decimalsA === decimalsB) is the conservative
 * shared depth, pinning the spot price at parity (minus the haircut) rather
 * than at the market's possibly-skewed raw reserve RATIO — the fix for the
 * favourable-mispricing bug this file's own test caught (see the module
 * doc's "REJECTED FIRST ATTEMPT").
 */
declare function cpQuote(x: bigint, rawA: bigint, rawB: bigint): bigint;
/**
 * AlphaQ ladder (adapter contract v2). CP-kind, 4-rung default (no
 * window/capacity walk — the model is a symmetric reserve-based
 * constant-product curve, see the module doc's "QUOTE MODEL"). Reads BOTH
 * vaults every slot (the depth is `min(vaultA, vaultB)`, not a directed
 * reserveIn/reserveOut pair) — no per-trade params, the haircut is a
 * compiled constant, not pool state.
 */
export declare const alphaqLadder: SvmVenueLadderV2;
export { cpQuote as __alphaqCpQuoteForTest, decodeSymbol as __alphaqDecodeSymbolForTest };
//# sourceMappingURL=index.d.ts.map