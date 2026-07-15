import type { Address, AddressesByLookupTableAddress, Commitment, GetLatestBlockhashApi, GetSlotApi, Rpc, TransactionSigner } from '@solana/kit';
import { fetchAddressLookupTable } from '@solana-program/address-lookup-table';
import type { ResolvedAccountMeta } from './resolve.js';
import type { SignedExecuteTransaction } from './transaction.js';
/**
 * Picks the account addresses worth putting in a lookup table: non-signers
 * only (signers must be static message accounts — they cannot be looked up),
 * deduplicated in first-seen order.
 */
export declare function selectAltAddresses(metas: readonly ResolvedAccountMeta[]): Address[];
export type SendAndConfirmTransaction = (transaction: SignedExecuteTransaction, config: {
    commitment: Commitment;
}) => Promise<void>;
export interface CreateAltInput {
    rpc: Rpc<GetLatestBlockhashApi & GetSlotApi>;
    payer: TransactionSigner;
    authority: TransactionSigner;
    addresses: readonly Address[];
    sendAndConfirm: SendAndConfirmTransaction;
    commitment?: Commitment;
}
/**
 * Creates an address lookup table and extends it with `addresses` (one create
 * transaction, then one transaction per chunk of 30 addresses — 27 when payer
 * and authority are distinct signers). Returns the table address and a slot
 * upper bound for the last extend — feed it to `waitForAltActive` before
 * compressing a transaction against the table.
 */
export declare function createAltWithAddresses({ rpc, payer, authority, addresses, sendAndConfirm, commitment, }: CreateAltInput): Promise<{
    lookupTableAddress: Address;
    lastExtendedSlot: bigint;
}>;
export interface ExtendAltInput {
    rpc: Rpc<GetLatestBlockhashApi & GetSlotApi>;
    payer: TransactionSigner;
    authority: TransactionSigner;
    /** The existing table to extend (must already be created and owned by `authority`). */
    lookupTableAddress: Address;
    /** Addresses to append — the caller has already removed any the table holds. */
    addresses: readonly Address[];
    sendAndConfirm: SendAndConfirmTransaction;
    commitment?: Commitment;
}
/**
 * Appends `addresses` to an existing lookup table (one transaction per chunk of
 * 30 — 27 with a distinct authority), returning a slot upper bound for the last
 * extend. Feed it to `waitForAltActive` before compressing against the table.
 * An empty `addresses` sends nothing and returns the current slot (the table is
 * already sufficient) — this is the idempotent no-op the reuse path relies on.
 */
export declare function extendAlt({ rpc, payer, authority, lookupTableAddress, addresses, sendAndConfirm, commitment, }: ExtendAltInput): Promise<{
    lastExtendedSlot: bigint;
}>;
/**
 * Waits until the lookup table is usable. Addresses extended in slot N are
 * usable from slot N+1 onward, so this resolves once getSlot() > lastExtendedSlot.
 */
export declare function waitForAltActive(rpc: Rpc<GetSlotApi>, lastExtendedSlot: bigint, { timeoutMs, pollMs }?: {
    timeoutMs?: number;
    pollMs?: number;
}): Promise<void>;
/** Fetches a lookup table in the shape `compressTransactionMessageUsingAddressLookupTables` consumes. */
export declare function fetchAlt(rpc: Parameters<typeof fetchAddressLookupTable>[0], lookupTableAddress: Address): Promise<AddressesByLookupTableAddress>;
//# sourceMappingURL=alt.d.ts.map