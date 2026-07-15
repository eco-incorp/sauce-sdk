import { isSignerRole } from '@solana/kit';
import type {
  Address,
  AddressesByLookupTableAddress,
  Commitment,
  GetLatestBlockhashApi,
  GetSlotApi,
  Instruction,
  Rpc,
  TransactionSigner,
} from '@solana/kit';
import {
  fetchAddressLookupTable,
  findAddressLookupTablePda,
  getCreateLookupTableInstructionAsync,
  getExtendLookupTableInstruction,
} from '@solana-program/address-lookup-table';
import type { ResolvedAccountMeta } from './resolve.js';
import { buildExecuteTransaction } from './transaction.js';
import type { SignedExecuteTransaction } from './transaction.js';

/**
 * Max addresses per extend instruction — keeps each extend transaction inside
 * the 1232-byte packet. 30 addresses fit (1212 bytes) when payer === authority;
 * a distinct authority costs a second signature (64B) plus one extra static
 * account (32B) = exactly 3 address slots, leaving room for 27 (also 1212 bytes).
 */
const MAX_ADDRESSES_PER_EXTEND = 30;
const MAX_ADDRESSES_PER_EXTEND_DISTINCT_AUTHORITY = 27;

/**
 * Picks the account addresses worth putting in a lookup table: non-signers
 * only (signers must be static message accounts — they cannot be looked up),
 * deduplicated in first-seen order.
 */
export function selectAltAddresses(metas: readonly ResolvedAccountMeta[]): Address[] {
  const seen = new Set<Address>();
  const addresses: Address[] = [];

  for (const meta of metas) {
    if (isSignerRole(meta.role) || seen.has(meta.address)) continue;
    seen.add(meta.address);
    addresses.push(meta.address);
  }

  return addresses;
}

export type SendAndConfirmTransaction = (
  transaction: SignedExecuteTransaction,
  config: { commitment: Commitment },
) => Promise<void>;

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
export async function createAltWithAddresses({
  rpc,
  payer,
  authority,
  addresses,
  sendAndConfirm,
  commitment = 'confirmed',
}: CreateAltInput): Promise<{ lookupTableAddress: Address; lastExtendedSlot: bigint }> {
  const recentSlot = await rpc.getSlot({ commitment: 'finalized' }).send();
  const [createInstruction, [lookupTableAddress]] = await Promise.all([
    getCreateLookupTableInstructionAsync({ authority: authority.address, payer, recentSlot }),
    findAddressLookupTablePda({ authority: authority.address, recentSlot }),
  ]);

  const chunkSize = payer.address === authority.address ? MAX_ADDRESSES_PER_EXTEND : MAX_ADDRESSES_PER_EXTEND_DISTINCT_AUTHORITY;
  const batches: Instruction[][] = [[createInstruction]];

  for (let i = 0; i < addresses.length; i += chunkSize) {
    batches.push([
      getExtendLookupTableInstruction({
        address: lookupTableAddress,
        authority,
        payer,
        addresses: addresses.slice(i, i + chunkSize),
      }),
    ]);
  }

  for (const instructions of batches) {
    const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment }).send();
    const transaction = await buildExecuteTransaction({ payer, instructions, latestBlockhash });
    await sendAndConfirm(transaction, { commitment });
  }

  // The last extend landed no later than the current confirmed slot, so this
  // is a safe (over-approximated) anchor for the warmup wait below.
  const lastExtendedSlot = await rpc.getSlot({ commitment }).send();

  return { lookupTableAddress, lastExtendedSlot };
}

/**
 * Waits until the lookup table is usable. Addresses extended in slot N are
 * usable from slot N+1 onward, so this resolves once getSlot() > lastExtendedSlot.
 */
export async function waitForAltActive(
  rpc: Rpc<GetSlotApi>,
  lastExtendedSlot: bigint,
  { timeoutMs = 30_000, pollMs = 400 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();

    if (slot > lastExtendedSlot) return;

    if (Date.now() >= deadline) {
      throw new Error(
        `address lookup table not active after ${timeoutMs}ms: current slot ${slot} has not passed last extended slot ${lastExtendedSlot}`,
      );
    }

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

/** Fetches a lookup table in the shape `compressTransactionMessageUsingAddressLookupTables` consumes. */
export async function fetchAlt(
  rpc: Parameters<typeof fetchAddressLookupTable>[0],
  lookupTableAddress: Address,
): Promise<AddressesByLookupTableAddress> {
  const account = await fetchAddressLookupTable(rpc, lookupTableAddress);

  return { [lookupTableAddress]: [...account.data.addresses] };
}
