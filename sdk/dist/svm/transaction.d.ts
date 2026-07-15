import type { AddressesByLookupTableAddress, BlockhashLifetimeConstraint, Instruction, SendableTransaction, Transaction, TransactionSigner, TransactionWithBlockhashLifetime } from '@solana/kit';
/** Byte length of the encoded wire transaction (kit's own measure; limit is 1232). */
export { getTransactionSize } from '@solana/kit';
export type SignedExecuteTransaction = SendableTransaction & Transaction & TransactionWithBlockhashLifetime;
export interface BuildExecuteTransactionInput {
    payer: TransactionSigner;
    instructions: readonly Instruction[];
    latestBlockhash: BlockhashLifetimeConstraint;
    lookupTables?: AddressesByLookupTableAddress;
}
/** Builds and fully signs a v0 transaction, optionally compressed through address lookup tables. */
export declare function buildExecuteTransaction({ payer, instructions, latestBlockhash, lookupTables, }: BuildExecuteTransactionInput): Promise<SignedExecuteTransaction>;
//# sourceMappingURL=transaction.d.ts.map