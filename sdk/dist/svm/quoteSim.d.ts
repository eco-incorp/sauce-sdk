import type { Address, GetAccountInfoApi, Instruction, Rpc, SimulateTransactionApi, TransactionSigner } from '@solana/kit';
export interface QuoteViaSimulationInput {
    rpc: Rpc<SimulateTransactionApi & GetAccountInfoApi>;
    /** The venue swap instruction, exactly as it would be sent. */
    swapIx: Instruction;
    /** Fee payer / signer of the simulated transaction (signature not verified). */
    payer: TransactionSigner;
    /** The user's output-token account — the quote is its balance delta. */
    outAta: Address;
}
/**
 * Simulates `swapIx` as a standalone single-instruction transaction and
 * returns the outAta token-balance delta (post − pre) as the quoted output.
 * See the module doc for the staleness contract.
 */
export declare function quoteViaSimulation({ rpc, swapIx, payer, outAta }: QuoteViaSimulationInput): Promise<bigint>;
//# sourceMappingURL=quoteSim.d.ts.map