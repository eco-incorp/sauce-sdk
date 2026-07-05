/**
 * Shared LiteSVM engine harness for the engine-gated (`SAUCE_ENGINE_SO`)
 * solswap suites: boots the real SVM engine with pre-provisioned PDAs, pins
 * the cluster clock (the venue fragments read Clock via block.timestamp),
 * loads venue fixtures, fabricates SPL token accounts / address lookup tables,
 * and executes compiled programs through the sdk's own pure builders
 * (resolveAccounts + buildExecuteInstruction + buildExecuteTransaction).
 */
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getAddressCodec, generateKeyPairSigner, lamports } from '@solana/kit';
import type { Address, AddressesByLookupTableAddress, Instruction, KeyPairSigner } from '@solana/kit';
import { Clock, FailedTransactionMetadata, LiteSVM } from 'litesvm';
import type { AccountPlan } from '@eco-incorp/sauce-compiler';
import {
  buildComputeBudgetPrepend,
  buildExecuteInstruction,
  buildExecuteTransaction,
  deriveEnginePdas,
  getTransactionSize,
  KIND_ARGS,
  KIND_FRAMES,
  KIND_HEAP,
  KIND_STACK,
  PDA_ARGS_BYTES,
  PDA_FRAMES_BYTES,
  PDA_HEAP_BYTES,
  PDA_STACK_BYTES,
  resolveAccounts,
} from '../../src/svm/index.js';
import type { AccountResolution, EnginePda, EnginePdas, SignedExecuteTransaction } from '../../src/svm/index.js';
import { fixtureAccounts } from './fixtures.js';
import type { AccountFixture } from './fixtures.js';

// sdk jest cwd is sdk/, so the default points at the sibling sauce checkout's
// engine build (same resolution rule as the compiler's LiteSVM harness).
export const ENGINE_SO = process.env.SAUCE_ENGINE_SO ?? resolve(process.cwd(), '../../sauce/svm/target/deploy/engine.so');

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
  pdas: EnginePdas;
}

export const randomAddress = (): Address => getAddressCodec().decode(crypto.getRandomValues(new Uint8Array(32)));

/** The memory-set session byte the harness provisions (the SDK default). */
export const HARNESS_SESSION = 0;

/**
 * Full-size setAccount provisioning of one owner's memory set: zeroed data
 * behind the canonical [kind, bump, session] header — exactly what the
 * on-chain init loop builds, minus the transactions. Memory PDAs derive per
 * (owner, session); the owner must be the execute instruction's FIRST in-list
 * signer.
 */
export const provisionEnginePdas = async (svm: LiteSVM, programId: Address, owner: Address): Promise<EnginePdas> => {
  const pdas = await deriveEnginePdas(programId, owner, HARNESS_SESSION);
  const specs: [EnginePda, number, number][] = [
    [pdas.stack, KIND_STACK, PDA_STACK_BYTES],
    [pdas.heap, KIND_HEAP, PDA_HEAP_BYTES],
    [pdas.frames, KIND_FRAMES, PDA_FRAMES_BYTES],
    [pdas.args, KIND_ARGS, PDA_ARGS_BYTES],
  ];
  for (const [pda, kind, size] of specs) {
    const data = new Uint8Array(size);
    data[0] = kind;
    data[1] = pda.bump;
    data[2] = HARNESS_SESSION;
    svm.setAccount({
      address: pda.address,
      data,
      executable: false,
      lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(size))),
      programAddress: programId,
      space: BigInt(size),
    });
  }

  return pdas;
};

/**
 * Boots LiteSVM with the engine program, a funded payer, the payer's full-size
 * memory PDAs, and the cluster clock pinned to `unixTimestamp` — the venue
 * quote fragments read block.timestamp, so engine-side quotes evaluate at
 * exactly this instant.
 */
export const startEngine = async (unixTimestamp: bigint): Promise<EngineHarness> => {
  const svm = new LiteSVM();
  const programId = (await generateKeyPairSigner()).address;
  svm.addProgramFromFile(programId, ENGINE_SO);

  svm.warpToSlot(HARNESS_SLOT);
  svm.setClock(new Clock(HARNESS_SLOT, 0n, 0n, 0n, unixTimestamp));

  const payer = await generateKeyPairSigner();
  svm.airdrop(payer.address, lamports(1_000_000_000_000n));

  const pdas = await provisionEnginePdas(svm, programId, payer.address);

  return { svm, programId, payer, pdas };
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

/** Places a Tokenkeg-owned token account at `address` and returns the address. */
export const setTokenAccount = (
  harness: EngineHarness,
  address: Address,
  mint: Address,
  owner: Address,
  amount: bigint,
): Address => {
  const data = tokenAccountData(mint, owner, amount);
  harness.svm.setAccount({
    address,
    data,
    executable: false,
    lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: TOKEN_PROGRAM,
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
 * prepend + engine execute instruction, v0, optionally ALT-compressed.
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
    buildExecuteInstruction({
      programId: harness.programId,
      pdas: harness.pdas,
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
 * (init/write/finalize/close txs and the [args-writer, execute_from_account]
 * pair are all built through it).
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
