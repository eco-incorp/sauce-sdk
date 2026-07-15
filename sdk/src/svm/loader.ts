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

interface PendingLoad {
  resolve: (data: Uint8Array | null) => void;
  reject: (error: unknown) => void;
}

/**
 * Wraps a batch transport as a single-account AccountLoader that coalesces
 * same-turn loads into deduped, chunked sweeps.
 */
export function coalescingAccountLoader(loadMany: BatchAccountLoader, options: CoalescingLoaderOptions = {}): AccountLoader {
  const chunkSize = options.chunkSize ?? 100;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`coalescingAccountLoader chunkSize must be a positive integer, got ${chunkSize}`);
  }
  let pending: Map<Address, PendingLoad[]> | null = null;

  const flush = async (batch: Map<Address, PendingLoad[]>): Promise<void> => {
    const addresses = [...batch.keys()];
    for (let at = 0; at < addresses.length; at += chunkSize) {
      const chunk = addresses.slice(at, at + chunkSize);
      let results: (LoadedAccount | null)[];
      try {
        results = await loadMany(chunk);
        if (results.length !== chunk.length) {
          throw new Error(`batch loader returned ${results.length} accounts for ${chunk.length} addresses`);
        }
      } catch (error) {
        for (const address of chunk) for (const waiter of batch.get(address)!) waiter.reject(error);
        continue;
      }
      chunk.forEach((address, i) => {
        const result = results[i];
        for (const waiter of batch.get(address)!) {
          if (result === null) {
            waiter.resolve(null);
            continue;
          }
          try {
            options.expectOwner?.(address, result.owner);
            // Fresh copy per waiter — callers may mutate their view.
            waiter.resolve(new Uint8Array(result.data));
          } catch (error) {
            waiter.reject(error);
          }
        }
      });
    }
  };

  return (address: Address): Promise<Uint8Array | null> =>
    new Promise((resolve, reject) => {
      if (pending === null) {
        pending = new Map();
        const batch = pending;
        queueMicrotask(() => {
          pending = null;
          void flush(batch);
        });
      }
      const waiters = pending.get(address);
      if (waiters === undefined) pending.set(address, [{ resolve, reject }]);
      else waiters.push({ resolve, reject });
    });
}

/** The slice of a @solana/kit RPC this loader needs (Rpc<GetMultipleAccountsApi>). */
export interface GetMultipleAccountsRpc {
  getMultipleAccounts(
    addresses: readonly Address[],
    config: { encoding: 'base64' },
  ): {
    send(): Promise<{ value: ({ data: readonly [string, string]; owner: Address } | null)[] }>;
  };
}

/** Batch transport over a @solana/kit RPC's getMultipleAccounts (base64). */
export function kitBatchAccountLoader(rpc: GetMultipleAccountsRpc): BatchAccountLoader {
  return async (addresses: readonly Address[]): Promise<(LoadedAccount | null)[]> => {
    const { value } = await rpc.getMultipleAccounts(addresses, { encoding: 'base64' }).send();
    return value.map((account) =>
      account === null ? null : { data: new Uint8Array(Buffer.from(account.data[0], 'base64')), owner: account.owner },
    );
  };
}
