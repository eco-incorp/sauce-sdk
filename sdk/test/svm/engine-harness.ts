/**
 * Shared LiteSVM engine harness for the solswap suites (gated on the vendored
 * engine .so existing — see ENGINE_SO below): boots the real SVM engine, pins
 * the cluster clock (the venue fragments read Clock via block.timestamp),
 * loads venue fixtures, fabricates SPL token accounts / address lookup
 * tables, and executes compiled programs through the sdk's own pure builders
 * (resolveAccounts + buildExecuteInstruction + buildExecuteTransaction).
 * Interpreter memory is the transaction's 256 KiB heap frame — no memory
 * accounts, no provisioning; every execute transaction carries the
 * RequestHeapFrame prepend.
 */
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getAddressCodec, generateKeyPairSigner, lamports } from '@solana/kit';
import type { Address, AddressesByLookupTableAddress, Instruction, KeyPairSigner } from '@solana/kit';
import { Clock, FailedTransactionMetadata, FeatureSet, LiteSVM } from 'litesvm';
import type { AccountPlan } from '@eco-incorp/sauce-compiler';
import {
  buildComputeBudgetPrepend,
  buildExecuteInstruction,
  buildExecuteTransaction,
  buildHeapFramePrepend,
  getTransactionSize,
  resolveAccounts,
} from '../../src/svm/index.js';
import type { AccountResolution, SignedExecuteTransaction } from '../../src/svm/index.js';
import { fixtureAccounts } from './fixtures.js';
import type { AccountFixture } from './fixtures.js';

// sdk jest cwd is sdk/; the vendored binary lives at the repo-root
// artifacts/svm/, one level up (same resolution rule as the compiler's
// LiteSVM harness). SAUCE_ENGINE_SO overrides it, e.g. to test against a
// freshly built engine before repinning the sauce dep.
export const ENGINE_SO = process.env.SAUCE_ENGINE_SO ?? resolve(process.cwd(), '../artifacts/svm/engine.so');

/** describe when the engine binary exists, describe.skip otherwise (CI). */
export const describeSvm = existsSync(ENGINE_SO) ? describe : describe.skip;

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111' as Address;

/** Slot every harness runs at (must be > the fabricated ALT's last_extended_slot 0). */
const HARNESS_SLOT = 1000n;

export interface EngineHarness {
  svm: LiteSVM;
  programId: Address;
  payer: KeyPairSigner;
}

export const randomAddress = (): Address => getAddressCodec().decode(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Boots LiteSVM with the engine program, a funded payer, and the cluster
 * clock pinned to `unixTimestamp` — the venue quote fragments read
 * block.timestamp, so engine-side quotes evaluate at exactly this instant.
 * No memory setup exists: interpreter memory is the per-transaction heap
 * frame, requested by the RequestHeapFrame prepend on every execute.
 */
export const startEngine = async (unixTimestamp: bigint): Promise<EngineHarness> => {
  // The default constructor's program runtime misses the
  // sol_remaining_compute_units syscall (the engine's GasLeft, 0x62 — the
  // EcoSwapSVM CU-floor guard); rebuilding the runtime with every feature
  // enabled registers it, matching mainnet where the feature is long active.
  const svm = new LiteSVM()
    .withFeatureSet(FeatureSet.allEnabled())
    .withBuiltins()
    .withPrecompiles()
    .withSysvars()
    .withDefaultPrograms();
  const programId = (await generateKeyPairSigner()).address;
  svm.addProgramFromFile(programId, ENGINE_SO);

  svm.warpToSlot(HARNESS_SLOT);
  svm.setClock(new Clock(HARNESS_SLOT, 0n, 0n, 0n, unixTimestamp));

  const payer = await generateKeyPairSigner();
  svm.airdrop(payer.address, lamports(1_000_000_000_000n));

  return { svm, programId, payer };
};

/** Loads mainnet fixture dumps into the bank (rent-exempt, original owners). */
export const loadFixtureAccounts = (harness: EngineHarness, fixtures: AccountFixture[]): void => {
  for (const account of fixtureAccounts(fixtures)) harness.svm.setAccount(account);
};

/** 165-byte SPL token account image: mint@0, owner@32, amount u64 LE@64, state Initialized. */
export const tokenAccountData = (mint: Address, owner: Address, amount: bigint): Uint8Array => {
  const codec = getAddressCodec();
  const data = new Uint8Array(165);
  data.set(new Uint8Array(codec.encode(mint)), 0);
  data.set(new Uint8Array(codec.encode(owner)), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1; // AccountState::Initialized
  return data;
};

/** Places a token account at `address` (Tokenkeg-owned unless `tokenProgram` says otherwise) and returns the address. */
export const setTokenAccount = (
  harness: EngineHarness,
  address: Address,
  mint: Address,
  owner: Address,
  amount: bigint,
  tokenProgram: Address = TOKEN_PROGRAM,
): Address => {
  const data = tokenAccountData(mint, owner, amount);
  harness.svm.setAccount({
    address,
    data,
    executable: false,
    lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: tokenProgram,
    space: BigInt(data.length),
  });
  return address;
};

/** SPL token `amount` (u64 LE at 64) of an account in the bank. */
export const tokenAmount = (harness: EngineHarness, address: Address): bigint => {
  const account = harness.svm.getAccount(address);
  if (!account.exists) throw new Error(`token account ${address} does not exist`);
  return new DataView(account.data.buffer, account.data.byteOffset).getBigUint64(64, true);
};

/** SPL Token Transfer instruction data: u8 tag 3 + amount u64 LE. */
export const splTransferData = (amount: bigint): Uint8Array => {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return data;
};

/**
 * Fabricates an ACTIVE address lookup table directly in the bank — the
 * on-chain layout the runtime's create/extend path would build, minus the
 * transactions: 56-byte meta (bincode ProgramState::LookupTable, never
 * deactivating, fully extended before the harness slot) + raw addresses.
 * Returns the table in the shape `buildExecuteTransaction` compresses with.
 */
export const fabricateAlt = (harness: EngineHarness, addresses: readonly Address[]): AddressesByLookupTableAddress => {
  const codec = getAddressCodec();
  const table = randomAddress();
  const data = new Uint8Array(56 + 32 * addresses.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true); // ProgramState::LookupTable
  view.setBigUint64(4, 0xffff_ffff_ffff_ffffn, true); // deactivation_slot: never
  view.setBigUint64(12, 0n, true); // last_extended_slot 0 < HARNESS_SLOT: all addresses active
  data[20] = 0; // last_extended_slot_start_index
  data[21] = 1; // authority: Some(payer)
  data.set(new Uint8Array(codec.encode(harness.payer.address)), 22);
  addresses.forEach((address, i) => data.set(new Uint8Array(codec.encode(address)), 56 + 32 * i));

  harness.svm.setAccount({
    address: table,
    data,
    executable: false,
    lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: ALT_PROGRAM,
    space: BigInt(data.length),
  });

  return { [table]: [...addresses] };
};

export type RunResult =
  | { ok: true; returnData: Uint8Array; logs: string[] }
  | { ok: false; revertData: Uint8Array; err: string; logs: string[] };

export interface ExecutableOutput {
  bytecode: Uint8Array;
  accountPlan: AccountPlan;
}

export interface ExecuteOptions {
  lookupTables?: AddressesByLookupTableAddress;
  /** Compute-unit limit prepend; generous default so Newton-loop programs never starve. */
  computeUnits?: number;
}

/**
 * Signs (but does not send) the execute transaction for a compiled output: CU
 * prepend + the mandatory heap-frame request + engine execute instruction,
 * v0, optionally ALT-compressed.
 */
export const signExecuteTransaction = async (
  harness: EngineHarness,
  output: ExecutableOutput,
  resolution: AccountResolution,
  { lookupTables, computeUnits = 1_400_000 }: ExecuteOptions = {},
): Promise<SignedExecuteTransaction> => {
  const accounts = resolveAccounts(output.accountPlan, resolution, harness.payer.address);
  const instructions: Instruction[] = [
    ...buildComputeBudgetPrepend({ unitLimit: computeUnits }),
    buildHeapFramePrepend(),
    buildExecuteInstruction({
      programId: harness.programId,
      bytecode: output.bytecode,
      accounts,
    }),
  ];

  // A fresh blockhash per send keeps signatures unique — LiteSVM's history
  // rejects a byte-identical resend.
  harness.svm.expireBlockhash();

  return buildExecuteTransaction({
    payer: harness.payer,
    instructions,
    latestBlockhash: { blockhash: harness.svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n },
    lookupTables,
  });
};

/**
 * Signs (but does not send) arbitrary instructions as one payer-fee-paid v0
 * transaction on a fresh blockhash — the staging-protocol building block
 * (init/write/finalize/close txs and hand-assembled execute_from_account
 * transactions are all built through it). Callers assembling an EXECUTE
 * transaction must include buildHeapFramePrepend() themselves.
 */
export const buildExecuteTransactionForHarness = async (
  harness: EngineHarness,
  instructions: readonly Instruction[],
): Promise<SignedExecuteTransaction> => {
  // A fresh blockhash per send keeps signatures unique — LiteSVM's history
  // rejects a byte-identical resend.
  harness.svm.expireBlockhash();

  return buildExecuteTransaction({
    payer: harness.payer,
    instructions,
    latestBlockhash: { blockhash: harness.svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n },
  });
};

/** Builds, signs, and sends one transaction of `instructions`; returns the run result. */
export const sendInstructions = async (harness: EngineHarness, instructions: readonly Instruction[]): Promise<RunResult> =>
  sendSigned(harness, await buildExecuteTransactionForHarness(harness, instructions));

export const sendSigned = (harness: EngineHarness, transaction: SignedExecuteTransaction): RunResult => {
  const result = harness.svm.sendTransaction(transaction);

  if (result instanceof FailedTransactionMetadata) {
    return {
      ok: false,
      revertData: result.meta().returnData().data(),
      err: String(result.err()),
      logs: result.meta().logs(),
    };
  }

  return { ok: true, returnData: result.returnData().data(), logs: result.logs() };
};

export const execute = async (
  harness: EngineHarness,
  output: ExecutableOutput,
  resolution: AccountResolution,
  options: ExecuteOptions = {},
): Promise<RunResult> => sendSigned(harness, await signExecuteTransaction(harness, output, resolution, options));

export const expectOk = (result: RunResult): { returnData: Uint8Array; logs: string[] } => {
  if (!result.ok) throw new Error(`expected success, got: ${result.err}\n${result.logs.join('\n')}`);
  return result;
};

export const expectFail = (result: RunResult): { revertData: Uint8Array; err: string; logs: string[] } => {
  if (result.ok) throw new Error('expected the transaction to fail, but it succeeded');
  return result;
};

export const toBigInt = (bytes: Uint8Array): bigint =>
  bytes.length === 0 ? 0n : BigInt('0x' + Buffer.from(bytes).toString('hex'));

export { getTransactionSize };
