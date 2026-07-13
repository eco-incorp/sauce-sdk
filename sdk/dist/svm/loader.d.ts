/**
 * Batched account loading for prepare/quote flows.
 *
 * The venue adapters consume the one-address AccountLoader (fixture tests
 * feed it directly), but a naive RPC binding costs one round-trip per
 * account — an EcoSwapSVM prepare over k pools touches 3-8 accounts each.
 * `coalescingAccountLoader` keeps the adapter surface unchanged while
 * batching transport: every load() issued in the same microtask turn joins
 * ONE getMultipleAccounts sweep (deduped, chunked at the RPC's 100-account
 * cap), so a parallelized prepare resolves in O(dependency-depth) sweeps —
 * pool accounts first, then their vault/config satellites — regardless of
 * pool count.
 *
 * Owner checks are PRESERVED through batching: getMultipleAccounts returns
 * each account's owner, and the loader hands (address, owner) to the
 * `expectOwner` hook before releasing the data — a per-account rejection
 * there fails that account's load() alone, exactly like a single-account
 * loader that verifies owners. quoteEcoSwapSvm/ecoSwapSvm wire the pool
 * accounts' owner expectations to each family's program id.
 */
import type { Address } from '@solana/kit';
import type { AccountLoader } from './venues/types.js';
export interface LoadedAccount {
    data: Uint8Array;
    owner: Address;
}
/** Batch transport: addresses in, (data + owner) per account out (null = not found). */
export type BatchAccountLoader = (addresses: readonly Address[]) => Promise<(LoadedAccount | null)[]>;
export interface CoalescingLoaderOptions {
    /** getMultipleAccounts cap per request (public RPC limit: 100). */
    chunkSize?: number;
    /** Per-account owner check — throw to reject that account's load(). */
    expectOwner?: (address: Address, owner: Address) => void;
}
/**
 * Wraps a batch transport as a single-account AccountLoader that coalesces
 * same-turn loads into deduped, chunked sweeps.
 */
export declare function coalescingAccountLoader(loadMany: BatchAccountLoader, options?: CoalescingLoaderOptions): AccountLoader;
/** The slice of a @solana/kit RPC this loader needs (Rpc<GetMultipleAccountsApi>). */
export interface GetMultipleAccountsRpc {
    getMultipleAccounts(addresses: readonly Address[], config: {
        encoding: 'base64';
    }): {
        send(): Promise<{
            value: ({
                data: readonly [string, string];
                owner: Address;
            } | null)[];
        }>;
    };
}
/** Batch transport over a @solana/kit RPC's getMultipleAccounts (base64). */
export declare function kitBatchAccountLoader(rpc: GetMultipleAccountsRpc): BatchAccountLoader;
//# sourceMappingURL=loader.d.ts.map