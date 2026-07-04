import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import type { Address, AddressesByLookupTableAddress, Instruction, TransactionSigner } from '@solana/kit';
import type { AccountPlan } from '@eco-incorp/sauce-compiler';
import { buildExecuteInstruction, buildInitInstructions } from './instructions.js';
import { deriveEnginePdas } from './pda.js';
import type { EnginePdas } from './pda.js';
import { buildComputeBudgetPrepend } from './prepends.js';
import { resolveAccounts } from './resolve.js';
import type { AccountResolution } from './resolve.js';
import { recommendedComputeUnitLimit, sendExecute, simulateExecute } from './send.js';
import type { SendExecuteResult, SimulateExecuteResult } from './send.js';
import { buildExecuteTransaction } from './transaction.js';
import type { SignedExecuteTransaction } from './transaction.js';

export interface SauceSvmClientConfig {
  rpcUrl: string;
  /** Defaults to rpcUrl with the protocol swapped to ws(s). */
  wsUrl?: string;
  programId: Address;
  payer: TransactionSigner;
}

export interface SimulateOpts {
  prepends?: readonly Instruction[];
  lookupTables?: AddressesByLookupTableAddress;
}

export interface ExecuteOpts extends SimulateOpts {
  /** 'auto' simulates first and applies recommendedComputeUnitLimit (x1.2, capped 1.4M). */
  computeUnitLimit?: number | 'auto';
}

export interface SauceSvmClient {
  pdas: EnginePdas;
  /** Grows the engine PDAs to full size; no-op when already initialized. */
  bootstrap(): Promise<void>;
  simulate(bytecode: Uint8Array, plan: AccountPlan, resolution: AccountResolution, opts?: SimulateOpts): Promise<SimulateExecuteResult>;
  execute(bytecode: Uint8Array, plan: AccountPlan, resolution: AccountResolution, opts?: ExecuteOpts): Promise<SendExecuteResult>;
}

export async function createSauceSvmClient({ rpcUrl, wsUrl, programId, payer }: SauceSvmClientConfig): Promise<SauceSvmClient> {
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl ?? rpcUrl.replace(/^http/, 'ws'));
  const pdas = await deriveEnginePdas(programId);

  async function currentDataSize(account: Address): Promise<number> {
    const { value } = await rpc.getAccountInfo(account, { encoding: 'base64' }).send();

    return value === null ? 0 : Number(value.space);
  }

  async function buildTransaction(
    bytecode: Uint8Array,
    plan: AccountPlan,
    resolution: AccountResolution,
    prepends: readonly Instruction[],
    lookupTables?: AddressesByLookupTableAddress,
  ): Promise<SignedExecuteTransaction> {
    const accounts = resolveAccounts(plan, resolution, payer.address);
    const executeInstruction = buildExecuteInstruction({ programId, pdas, bytecode, accounts });
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    return buildExecuteTransaction({ payer, instructions: [...prepends, executeInstruction], latestBlockhash, lookupTables });
  }

  async function simulate(
    bytecode: Uint8Array,
    plan: AccountPlan,
    resolution: AccountResolution,
    opts: SimulateOpts = {},
  ): Promise<SimulateExecuteResult> {
    const transaction = await buildTransaction(bytecode, plan, resolution, opts.prepends ?? [], opts.lookupTables);

    return simulateExecute(rpc, transaction);
  }

  return {
    pdas,

    async bootstrap(): Promise<void> {
      const [stack, heap, frames] = await Promise.all([
        currentDataSize(pdas.stack.address),
        currentDataSize(pdas.heap.address),
        currentDataSize(pdas.frames.address),
      ]);
      const instructions = buildInitInstructions(programId, pdas, payer.address, { stack, heap, frames });

      if (instructions.length === 0) return;

      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
      const transaction = await buildExecuteTransaction({ payer, instructions, latestBlockhash });
      await sendExecute({ rpc, rpcSubscriptions, transaction });
    },

    simulate,

    async execute(
      bytecode: Uint8Array,
      plan: AccountPlan,
      resolution: AccountResolution,
      opts: ExecuteOpts = {},
    ): Promise<SendExecuteResult> {
      let unitLimit: number | undefined;

      if (opts.computeUnitLimit === 'auto') {
        const sim = await simulate(bytecode, plan, resolution, { prepends: opts.prepends, lookupTables: opts.lookupTables });

        if (!sim.ok || sim.unitsConsumed === undefined) {
          throw new Error(`compute unit auto-limit simulation failed: ${JSON.stringify(sim.err) ?? 'no units consumed'}`);
        }

        unitLimit = recommendedComputeUnitLimit(sim.unitsConsumed);
      } else {
        unitLimit = opts.computeUnitLimit;
      }

      const prepends = [
        ...(unitLimit !== undefined ? buildComputeBudgetPrepend({ unitLimit }) : []),
        ...(opts.prepends ?? []),
      ];
      const transaction = await buildTransaction(bytecode, plan, resolution, prepends, opts.lookupTables);

      return sendExecute({ rpc, rpcSubscriptions, transaction });
    },
  };
}
