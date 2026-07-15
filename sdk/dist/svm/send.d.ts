import type { Commitment, GetEpochInfoApi, GetSignatureStatusesApi, GetTransactionApi, Rpc, RpcSubscriptions, SendTransactionApi, Signature, SignatureNotificationsApi, SimulateTransactionApi, SlotNotificationsApi, Transaction } from '@solana/kit';
import type { SignedExecuteTransaction } from './transaction.js';
export interface SimulateExecuteResult {
    ok: boolean;
    unitsConsumed?: bigint;
    returnData?: Uint8Array;
    logs: string[];
    /** Present iff the failure was a sauce REVERT — payload is the revert data. */
    revert?: {
        payload: Uint8Array;
    };
    err?: unknown;
}
export interface SimulateExecuteOptions {
    /**
     * Index of the engine execute instruction inside the transaction. Defaults
     * to the last instruction — buildExecuteTransaction and the client place
     * prepends first and the execute instruction last. Pass it explicitly when
     * the transaction is composed differently.
     */
    executeInstructionIndex?: number;
}
/**
 * Simulates a signed execute transaction. A `Custom(0)` error from the execute
 * instruction is a sauce REVERT: the revert payload rides in returnData and
 * surfaces as `revert.payload`. All other engine failures map to the same
 * InvalidInstructionData instruction error and are NOT distinguishable from
 * each other except by reading `logs`. Failures of other instructions
 * (prepends) surface as plain `err` — never as `revert`.
 */
export declare function simulateExecute(rpc: Rpc<SimulateTransactionApi>, transaction: Transaction, { executeInstructionIndex }?: SimulateExecuteOptions): Promise<SimulateExecuteResult>;
export interface SendExecuteInput {
    rpc: Rpc<GetEpochInfoApi & GetSignatureStatusesApi & GetTransactionApi & SendTransactionApi>;
    rpcSubscriptions: RpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi>;
    transaction: SignedExecuteTransaction;
    commitment?: Commitment;
}
export interface SendExecuteResult {
    signature: Signature;
    returnData?: Uint8Array;
    computeUnits?: bigint;
    logs: string[];
}
/** Sends a signed execute transaction, confirms it, and reads back return data from the transaction meta. */
export declare function sendExecute({ rpc, rpcSubscriptions, transaction, commitment }: SendExecuteInput): Promise<SendExecuteResult>;
/** Simulated units padded 20% (rounded up), capped at the engine's 1.4M CU budget. */
export declare function recommendedComputeUnitLimit(simulatedUnits: bigint): number;
//# sourceMappingURL=send.d.ts.map