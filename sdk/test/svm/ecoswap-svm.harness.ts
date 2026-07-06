/**
 * Shared EcoSwapSVM e2e plumbing: stage a compiled shape blob through the
 * real buffer protocol and fire one execute_from_account trade per call —
 * the exact production path (hash-pinned buffer, packed cfg payload args,
 * CU + heap-frame prepends), factored out of ecoswap-svm.e2e.test.ts for the
 * Phase 1 suites (CU calibration, cp+stable split, real-binary CPI lane).
 */
import { createHash } from 'node:crypto';
import type { Address } from '@solana/kit';
import { FailedTransactionMetadata } from 'litesvm';
import {
  buildComputeBudgetPrepend,
  buildExecuteFromAccountInstruction,
  buildFinalizeBufferInstruction,
  buildHeapFramePrepend,
  buildInitBufferInstructions,
  buildStagingPlan,
  buildWriteBufferInstruction,
  deriveBufferPda,
  encodePayloadArgs,
  getTransactionSize,
  resolveAccounts,
} from '../../src/svm/index.js';
import type { AccountResolution } from '../../src/svm/index.js';
import type { AccountPlan, ArgsLayout } from '@eco-incorp/sauce-compiler';
import { buildExecuteTransactionForHarness, sendInstructions } from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(bytes).digest());

/** The structural slice of a compiled shape these helpers need (EcoSwapSvmOutput satisfies it). */
export interface EcoBlob {
  bytecode: Uint8Array;
  accountPlan: AccountPlan;
  argsLayout: ArgsLayout;
}

export interface StagedEcoBlob {
  buffer: Address;
}

/** Stage `output.bytecode` into buffer `index` (init → chunked writes → sha256-gated finalize). */
export async function stageEcoBlob(harness: EngineHarness, index: number, output: Pick<EcoBlob, 'bytecode'>): Promise<StagedEcoBlob> {
  const plan = buildStagingPlan(output.bytecode.length);
  const { address: buffer } = await deriveBufferPda(harness.programId, harness.payer.address, index);
  const shared = { programId: harness.programId, authority: harness.payer.address, buffer };
  let staged = await sendInstructions(
    harness,
    buildInitBufferInstructions({
      programId: harness.programId,
      payer: harness.payer.address,
      buffer,
      index,
      capacity: output.bytecode.length,
    }),
  );
  if (!staged.ok) throw new Error(`init_buffer failed: ${staged.err}`);
  for (const chunk of plan.chunks) {
    staged = await sendInstructions(harness, [
      buildWriteBufferInstruction({ ...shared, offset: chunk.offset, chunk: output.bytecode.subarray(chunk.offset, chunk.offset + chunk.length) }),
    ]);
    if (!staged.ok) throw new Error(`write_buffer failed: ${staged.err}`);
  }
  staged = await sendInstructions(harness, [
    buildFinalizeBufferInstruction({ ...shared, length: output.bytecode.length, sha256: sha256(output.bytecode) }),
  ]);
  if (!staged.ok) throw new Error(`finalize_buffer failed: ${staged.err}`);
  return { buffer };
}

export type EcoTradeResult =
  | { ok: true; returnData: Uint8Array; cu: bigint; txBytes: number; logs: string[] }
  | { ok: false; err: string; revertData: Uint8Array; logs: string[] };

/** One trade: execute_from_account against the staged blob with fresh cfg args. */
export async function execEcoTrade(
  harness: EngineHarness,
  staged: StagedEcoBlob,
  output: EcoBlob,
  resolution: AccountResolution,
  args: readonly [`0x${string}`],
  computeUnits = 1_400_000,
): Promise<EcoTradeResult> {
  const accounts = resolveAccounts(output.accountPlan, resolution, harness.payer.address);
  const exec = buildExecuteFromAccountInstruction({
    programId: harness.programId,
    buffer: staged.buffer,
    accounts,
    expectedSha256: sha256(output.bytecode),
    args: encodePayloadArgs(output.argsLayout, args as unknown as string[]),
  });
  const tx = await buildExecuteTransactionForHarness(harness, [
    ...buildComputeBudgetPrepend({ unitLimit: computeUnits }),
    buildHeapFramePrepend(),
    exec,
  ]);
  const size = getTransactionSize(tx);
  const result = harness.svm.sendTransaction(tx);
  if (result instanceof FailedTransactionMetadata) {
    return { ok: false, err: String(result.err()), revertData: result.meta().returnData().data(), logs: result.meta().logs() };
  }
  return { ok: true, returnData: result.returnData().data(), cu: result.computeUnitsConsumed(), txBytes: size, logs: result.logs() };
}

export interface TradeWords {
  slices: bigint[];
  predictedOuts: bigint[];
  realized: bigint;
}

/** Decode the solver returndata: [fills…][predicted…][realized] 32-byte BE words. */
export function decodeEcoTrade(returnData: Uint8Array, slots: number): TradeWords {
  if (returnData.length !== (2 * slots + 1) * 32) {
    throw new Error(`ecoswap returndata is ${returnData.length} bytes, expected ${(2 * slots + 1) * 32}`);
  }
  const word = (i: number): bigint => BigInt('0x' + Buffer.from(returnData.subarray(i * 32, (i + 1) * 32)).toString('hex'));
  return {
    slices: Array.from({ length: slots }, (_, i) => word(i)),
    predictedOuts: Array.from({ length: slots }, (_, i) => word(slots + i)),
    realized: word(2 * slots),
  };
}
