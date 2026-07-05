import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import type { Address, AddressesByLookupTableAddress, Instruction, Signature, TransactionSigner } from '@solana/kit';
import type { AccountPlan, ArgsLayout, ArgValue } from '@eco-incorp/sauce-compiler';
import { buildArgsWriteInstruction } from './args.js';
import {
  buildCloseBufferInstruction,
  buildExecuteFromAccountInstruction,
  buildExecuteInstruction,
  buildFinalizeBufferInstruction,
  buildInitBufferInstructions,
  buildInitInstructions,
  buildStagingPlan,
  buildWriteBufferInstruction,
} from './instructions.js';
import { deriveBufferPda, deriveEnginePdas } from './pda.js';
import type { EnginePdas } from './pda.js';
import { buildComputeBudgetPrepend } from './prepends.js';
import { ARGS_REF, resolveAccounts } from './resolve.js';
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
  /**
   * Memory-set session byte (default 0). The engine derives the memory PDAs
   * per (owner, session); rotate sessions to run parallel executes as one
   * identity (each session carries its own refundable rent deposit).
   */
  session?: number;
}

export interface SimulateOpts {
  prepends?: readonly Instruction[];
  lookupTables?: AddressesByLookupTableAddress;
}

export interface ExecuteOpts extends SimulateOpts {
  /** 'auto' simulates first and applies recommendedComputeUnitLimit (x1.2, capped 1.4M). */
  computeUnitLimit?: number | 'auto';
}

/** A buffer staged by this client — carries the SDK-computed content hash (the execute pin). */
export interface StagedBuffer {
  address: Address;
  index: number;
  /** sha256 of the staged bytecode, computed SDK-side and verified on-chain at finalize. */
  sha256: Uint8Array;
  /** Staging transaction signatures in send order: init, writes…, finalize. */
  signatures: Signature[];
}

/** Per-execution args for a staged program, matching the compile's argsLayout. */
export interface StagedArgs {
  layout: ArgsLayout;
  values: readonly ArgValue[];
}

export interface SimulateStagedOpts extends SimulateOpts {
  args?: StagedArgs;
  /**
   * Content-hash pin for the execute (32 bytes). Required for buffers this
   * client did not stage itself — a buffer address alone is never a
   * cross-lifecycle trust anchor. Buffers from stageBuffer pin automatically.
   */
  expectedSha256?: Uint8Array;
}

export interface ExecuteStagedOpts extends SimulateStagedOpts {
  computeUnitLimit?: number | 'auto';
}

export interface SauceSvmClient {
  pdas: EnginePdas;
  /** Grows the engine memory PDAs (stack/heap/frames/args) to full size; no-op when already initialized. */
  bootstrap(): Promise<void>;
  simulate(bytecode: Uint8Array, plan: AccountPlan, resolution: AccountResolution, opts?: SimulateOpts): Promise<SimulateExecuteResult>;
  execute(bytecode: Uint8Array, plan: AccountPlan, resolution: AccountResolution, opts?: ExecuteOpts): Promise<SendExecuteResult>;
  /**
   * Stages bytecode into buffer `index` (init → chunked writes → a dedicated
   * finalize sent only after every write confirmed, each tx on a fresh
   * blockhash). The buffer at the index must not be finalized — close it first
   * (closeBuffer) to recompile at the same address.
   */
  stageBuffer(index: number, bytecode: Uint8Array): Promise<StagedBuffer>;
  /** Closes buffer `index`, refunding its rent to the payer (the recompile path). */
  closeBuffer(index: number): Promise<SendExecuteResult>;
  simulateStaged(buffer: Address | StagedBuffer, plan: AccountPlan, resolution: AccountResolution, opts?: SimulateStagedOpts): Promise<SimulateExecuteResult>;
  /**
   * Executes a finalized buffer, hash-pinned. With `args`, the transaction is
   * [prepends…, inline args-writer execute, execute_from_account] — the writer
   * SSTOREs fresh values into the args PDA the staged prologue reads, so one
   * staged buffer serves every argument set without restaging.
   */
  executeStaged(buffer: Address | StagedBuffer, plan: AccountPlan, resolution: AccountResolution, opts?: ExecuteStagedOpts): Promise<SendExecuteResult>;
}

export async function createSauceSvmClient({ rpcUrl, wsUrl, programId, payer, session = 0 }: SauceSvmClientConfig): Promise<SauceSvmClient> {
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl ?? rpcUrl.replace(/^http/, 'ws'));
  const pdas = await deriveEnginePdas(programId, payer.address, session);
  /** Content hashes of buffers staged by THIS client — the automatic execute pins. */
  const stagedHashes = new Map<Address, Uint8Array>();

  async function currentDataSize(account: Address): Promise<number> {
    const { value } = await rpc.getAccountInfo(account, { encoding: 'base64' }).send();

    return value === null ? 0 : Number(value.space);
  }

  async function sendInstructions(instructions: readonly Instruction[]): Promise<SendExecuteResult> {
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    const transaction = await buildExecuteTransaction({ payer, instructions, latestBlockhash });

    return sendExecute({ rpc, rpcSubscriptions, transaction });
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

  /**
   * Resolves the staged plan: the reserved 'args' ref (user index 0) binds to
   * the derived args PDA — a conflicting resolution entry is refused rather
   * than silently redirecting the writer's target.
   */
  function stagedResolution(resolution: AccountResolution): AccountResolution {
    const provided = resolution[ARGS_REF];

    if (provided !== undefined && (typeof provided === 'string' ? provided : provided.address) !== pdas.args.address) {
      throw new Error(`account ref 'args' is reserved for the args PDA ${pdas.args.address} in staged mode`);
    }

    return { ...resolution, [ARGS_REF]: pdas.args.address };
  }

  function stagedPin(address: Address, expectedSha256?: Uint8Array): Uint8Array {
    const pin = expectedSha256 ?? stagedHashes.get(address);

    if (pin === undefined) {
      throw new Error(
        `buffer ${address} was not staged by this client: pass expectedSha256 (the content-hash pin) — an address alone is never a trust anchor`,
      );
    }

    return pin;
  }

  async function buildStagedTransaction(
    buffer: Address | StagedBuffer,
    plan: AccountPlan,
    resolution: AccountResolution,
    prepends: readonly Instruction[],
    opts: SimulateStagedOpts,
  ): Promise<SignedExecuteTransaction> {
    const address = typeof buffer === 'string' ? buffer : buffer.address;
    const expectedSha256 = stagedPin(address, opts.expectedSha256 ?? (typeof buffer === 'string' ? undefined : buffer.sha256));
    const accounts = resolveAccounts(plan, stagedResolution(resolution), payer.address);
    const instructions: Instruction[] = [...prepends];

    if (opts.args && opts.args.layout.slots.length > 0) {
      instructions.push(buildArgsWriteInstruction({ programId, pdas, payer: payer.address, layout: opts.args.layout, values: opts.args.values }));
    }

    instructions.push(buildExecuteFromAccountInstruction({ programId, buffer: address, pdas, accounts, expectedSha256 }));

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    return buildExecuteTransaction({ payer, instructions, latestBlockhash, lookupTables: opts.lookupTables });
  }

  async function simulateStaged(
    buffer: Address | StagedBuffer,
    plan: AccountPlan,
    resolution: AccountResolution,
    opts: SimulateStagedOpts = {},
  ): Promise<SimulateExecuteResult> {
    const transaction = await buildStagedTransaction(buffer, plan, resolution, opts.prepends ?? [], opts);

    return simulateExecute(rpc, transaction);
  }

  async function autoComputeUnitPrepends(
    simulateRun: () => Promise<SimulateExecuteResult>,
    opts: ExecuteOpts | ExecuteStagedOpts,
  ): Promise<Instruction[]> {
    let unitLimit: number | undefined;

    if (opts.computeUnitLimit === 'auto') {
      const sim = await simulateRun();

      if (!sim.ok || sim.unitsConsumed === undefined) {
        throw new Error(`compute unit auto-limit simulation failed: ${JSON.stringify(sim.err) ?? 'no units consumed'}`);
      }

      unitLimit = recommendedComputeUnitLimit(sim.unitsConsumed);
    } else {
      unitLimit = opts.computeUnitLimit;
    }

    return [
      ...(unitLimit !== undefined ? buildComputeBudgetPrepend({ unitLimit }) : []),
      ...(opts.prepends ?? []),
    ];
  }

  return {
    pdas,

    async bootstrap(): Promise<void> {
      const [stack, heap, frames, args] = await Promise.all([
        currentDataSize(pdas.stack.address),
        currentDataSize(pdas.heap.address),
        currentDataSize(pdas.frames.address),
        currentDataSize(pdas.args.address),
      ]);
      const instructions = buildInitInstructions(programId, pdas, payer.address, { stack, heap, frames, args }, session);

      if (instructions.length === 0) return;

      await sendInstructions(instructions);
    },

    simulate,

    async execute(
      bytecode: Uint8Array,
      plan: AccountPlan,
      resolution: AccountResolution,
      opts: ExecuteOpts = {},
    ): Promise<SendExecuteResult> {
      const prepends = await autoComputeUnitPrepends(
        () => simulate(bytecode, plan, resolution, { prepends: opts.prepends, lookupTables: opts.lookupTables }),
        opts,
      );
      const transaction = await buildTransaction(bytecode, plan, resolution, prepends, opts.lookupTables);

      return sendExecute({ rpc, rpcSubscriptions, transaction });
    },

    async stageBuffer(index: number, bytecode: Uint8Array): Promise<StagedBuffer> {
      const plan = buildStagingPlan(bytecode.length);
      const { address } = await deriveBufferPda(programId, payer.address, index);
      // Copy into a fresh ArrayBuffer-backed view (subtle.digest rejects
      // SharedArrayBuffer-backed views at the type level).
      const sha256 = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytecode)));
      const currentBytes = await currentDataSize(address);
      const signatures: Signature[] = [];

      // One init tx (all growth steps pack), one tx per write chunk, then the
      // DEDICATED finalize — sent only after every write confirmed (landing
      // order across concurrently broadcast txs is not guaranteed; the on-chain
      // hash gate backstops any race). Each send fetches a fresh blockhash.
      const initInstructions = buildInitBufferInstructions({
        programId,
        payer: payer.address,
        buffer: address,
        index,
        capacity: bytecode.length,
        currentBytes,
      });

      if (initInstructions.length > 0) {
        signatures.push((await sendInstructions(initInstructions)).signature);
      }

      for (const chunk of plan.chunks) {
        const write = buildWriteBufferInstruction({
          programId,
          authority: payer.address,
          buffer: address,
          offset: chunk.offset,
          chunk: bytecode.subarray(chunk.offset, chunk.offset + chunk.length),
        });
        signatures.push((await sendInstructions([write])).signature);
      }

      const finalize = buildFinalizeBufferInstruction({
        programId,
        authority: payer.address,
        buffer: address,
        length: bytecode.length,
        sha256,
      });
      signatures.push((await sendInstructions([finalize])).signature);

      stagedHashes.set(address, sha256);

      return { address, index, sha256, signatures };
    },

    async closeBuffer(index: number): Promise<SendExecuteResult> {
      const { address } = await deriveBufferPda(programId, payer.address, index);
      stagedHashes.delete(address);

      return sendInstructions([buildCloseBufferInstruction({ programId, authority: payer.address, buffer: address })]);
    },

    simulateStaged,

    async executeStaged(
      buffer: Address | StagedBuffer,
      plan: AccountPlan,
      resolution: AccountResolution,
      opts: ExecuteStagedOpts = {},
    ): Promise<SendExecuteResult> {
      const prepends = await autoComputeUnitPrepends(
        () => simulateStaged(buffer, plan, resolution, { ...opts, prepends: opts.prepends }),
        opts,
      );
      const transaction = await buildStagedTransaction(buffer, plan, resolution, prepends, opts);

      return sendExecute({ rpc, rpcSubscriptions, transaction });
    },
  };
}
