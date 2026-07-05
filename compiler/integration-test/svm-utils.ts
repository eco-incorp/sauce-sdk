/**
 * LiteSVM twin of utils.ts — runs `target: 'svm'` bytecode on the real SVM
 * engine inside an in-process LiteSVM bank (no validator, no RPC).
 *
 * Self-contained on purpose: the compiler package must not depend on sdk/, so
 * the engine interface (discriminator, PDA seeds/sizes, account laws) is
 * mirrored here from the engine crate (sauce repo, svm/programs/engine) and
 * the execute instruction is assembled by hand.
 *
 * Two laws bind the execute account list:
 * - the AccountPlan's meta order IS the engine's user-account index space:
 *   plan meta i must be instruction account 3+i (after the stack/heap/frames
 *   PDAs), exactly;
 * - MSG_SENDER = the first is_signer in the FULL instruction account list, so
 *   the payer must be an instruction account: when the plan interns the
 *   reserved 'payer' ref it is mapped in place, otherwise it is appended AFTER
 *   the plan-mapped metas (and any extra provided accounts) so plan indices —
 *   and raw positional indices — stay faithful.
 *
 * The engine binary comes from `make build` (cargo build-sbf) in the sauce
 * repo. CI has no engine.so, so suites guard with `describeSvm` and skip there
 * (same pattern as the v12 suites).
 */
import { existsSync } from 'fs';
import { resolve } from 'path';
import {
  AccountRole,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressCodec,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import type { AccountMeta, AccountSignerMeta, Address, Instruction, KeyPairSigner } from '@solana/kit';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import { compile } from '../src/index.js';
import type { CompileOptions } from '../src/index.js';

// Mirrored from the engine crate: sha256("global:execute")[..8], the full PDA
// sizes (3-byte [kind, bump, session] header + payload), and the kind bytes
// (the SSTORE write-protection discriminant).
const EXECUTE_DISCRIMINATOR = new Uint8Array([0x82, 0xdd, 0xf2, 0x9a, 0x0d, 0xc1, 0xbd, 0x1d]);
const PDA_SIZES = { stack: 33795, heap: 65538, frames: 67587, args: 8224 } as const;
const PDA_KINDS = { stack: 1, heap: 2, frames: 3, args: 4 } as const;
export const KIND_ARGS = PDA_KINDS.args;
/** SSTORE writes engine-owned accounts only at/past this offset (KIND_ARGS targets). */
export const ARGS_REGION_OFFSET = 32;
/** The memory-set session byte (the harness provisions session 0, the SDK default). */
const SESSION = 0;

export const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address;

// cwd is compiler/ under jest (the pnpm script runs there), mirroring how
// utils.ts resolves its cwd-relative paths.
export const ENGINE_SO =
  process.env.SAUCE_ENGINE_SO ?? resolve(process.cwd(), '../../sauce/svm/target/deploy/engine.so');

export const canRunSvm = (): boolean => existsSync(ENGINE_SO);

export interface SvmHarness {
  svm: LiteSVM;
  programId: Address;
  payer: KeyPairSigner;
  pdas: { stack: Address; heap: Address; frames: Address; args: Address };
}

/**
 * A user account for one svmCook run. `ref` names the account: plan refs
 * resolve against it by name; refs the plan never interned (e.g. a CPI target
 * program) are appended after the plan-mapped metas. The account is created in
 * LiteSVM (setAccount) only when `data` or `lamports` is given — address-only
 * entries just place a meta. `signer: true` generates a keypair so the
 * harness can co-sign (a fixed `address` cannot sign).
 */
export interface SvmTestAccount {
  ref: string;
  data?: Uint8Array;
  writable?: boolean;
  signer?: boolean;
  owner?: Address;
  lamports?: bigint;
  address?: Address;
}

export type SvmCookResult =
  | { ok: true; returnData: Uint8Array; logs: string[] }
  | { ok: false; revertData?: Uint8Array; err: string; logs: string[] };

export const startSvm = async (): Promise<SvmHarness> => {
  const svm = new LiteSVM();
  const programId = (await generateKeyPairSigner()).address;
  svm.addProgramFromFile(programId, ENGINE_SO);

  const payer = await generateKeyPairSigner();
  svm.airdrop(payer.address, lamports(1_000_000_000_000n));

  const [stack, heap, frames, args] = await Promise.all(
    (['stack', 'heap', 'frames', 'args'] as const).map((seed) => provisionPda(svm, programId, payer.address, seed)),
  );

  return { svm, programId, payer, pdas: { stack, heap, frames, args } };
};

// Fast-path PDA provisioning: setAccount with full-size zeroed data and the
// canonical [kind, bump, session] header — exactly what the on-chain init_*
// growth loop builds, minus the transactions (the sdk bootstrap path is
// covered by sdk tests). Memory PDAs derive per (owner, session): the owner is
// the execute instruction's first in-list signer — the harness payer.
const provisionPda = async (
  svm: LiteSVM,
  programId: Address,
  owner: Address,
  seed: keyof typeof PDA_SIZES,
): Promise<Address> => {
  const [address, bump] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed, getAddressEncoder().encode(owner), new Uint8Array([SESSION])],
  });
  const size = PDA_SIZES[seed];
  const data = new Uint8Array(size);
  data[0] = PDA_KINDS[seed];
  data[1] = bump;
  data[2] = SESSION;

  svm.setAccount({
    address,
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(size))),
    programAddress: programId,
    space: BigInt(size),
  });

  return address;
};

interface ResolvedTestAccount {
  spec: SvmTestAccount;
  address: Address;
  signer?: KeyPairSigner;
}

/** A random (almost surely off-curve) address for fixture accounts. */
export const randomSvmAddress = (): Address => getAddressCodec().decode(crypto.getRandomValues(new Uint8Array(32)));

const materializeAccount = async (harness: SvmHarness, spec: SvmTestAccount): Promise<ResolvedTestAccount> => {
  let address = spec.address;
  let signer: KeyPairSigner | undefined;

  if (address === undefined) {
    if (spec.signer) {
      signer = await generateKeyPairSigner();
      address = signer.address;
    } else {
      address = randomSvmAddress();
    }
  } else if (spec.signer) {
    throw new Error(`signer test account '${spec.ref}' cannot use a fixed address (the harness has no keypair for it)`);
  }

  if (spec.data !== undefined || spec.lamports !== undefined) {
    const data = spec.data ?? new Uint8Array(0);

    harness.svm.setAccount({
      address,
      data,
      executable: false,
      lamports: lamports(spec.lamports ?? harness.svm.minimumBalanceForRentExemption(BigInt(data.length))),
      // Default owner is the engine so writeAccountData can mutate the data
      // (the runtime rejects writes to accounts the program does not own).
      // The engine's SSTORE kind guard additionally requires an engine-owned
      // target to look like an args PDA: data[0] == KIND_ARGS and write
      // offsets >= ARGS_REGION_OFFSET — writable fixtures must be shaped so.
      programAddress: spec.owner ?? harness.programId,
      space: BigInt(data.length),
    });
  }

  return { spec, address, signer };
};

const roleFor = (writable: boolean, signer: boolean): AccountRole =>
  writable
    ? signer
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.WRITABLE
    : signer
      ? AccountRole.READONLY_SIGNER
      : AccountRole.READONLY;

const accountMeta = (
  acct: ResolvedTestAccount,
  writable: boolean,
  signer: boolean,
): AccountMeta | AccountSignerMeta => {
  const role = roleFor(writable, signer);

  return signer && acct.signer ? { address: acct.address, role, signer: acct.signer } : { address: acct.address, role };
};

export const svmCook = async (
  harness: SvmHarness,
  source: string,
  options: CompileOptions & { accounts?: SvmTestAccount[] } = {},
): Promise<SvmCookResult> => {
  const { accounts: testAccounts = [], ...compileOptions } = options;

  if (compileOptions.target !== undefined && compileOptions.target !== 'svm') {
    throw new Error(`svmCook compiles with target 'svm', got override '${compileOptions.target}'`);
  }

  const { bytecode, accountPlan } = compile(source, { ...compileOptions, target: 'svm' });

  if (!accountPlan) throw new Error('svm compile produced no account plan');

  const resolved: ResolvedTestAccount[] = [];
  const byRef = new Map<string, ResolvedTestAccount>();

  for (const spec of testAccounts) {
    // Reserved: svmCook places the payer itself (plan slot or final append). A
    // provided 'payer' fixture would be a second, random-address account — and
    // with signer:true it could precede the real payer and hijack MSG_SENDER.
    if (spec.ref === 'payer') throw new Error(`test account ref 'payer' is reserved for the harness payer`);

    if (byRef.has(spec.ref)) throw new Error(`duplicate test account ref '${spec.ref}'`);

    const acct = await materializeAccount(harness, spec);

    resolved.push(acct);
    byRef.set(spec.ref, acct);
  }

  // Plan-mapped metas first (plan index i = user index i = instruction account
  // 3+i). In raw-index mode the plan is empty and the provided accounts map
  // positionally to user indices 0..n-1. Unplanned extras follow, the payer
  // last (unless the plan interned the reserved 'payer' ref).
  const metas: (AccountMeta | AccountSignerMeta)[] = [];
  const placed = new Set<string>();
  let payerPlaced = false;

  for (const meta of accountPlan.metas) {
    if (meta.ref === 'payer') {
      metas.push({ address: harness.payer.address, role: roleFor(meta.writable, true) });
      payerPlaced = true;
      continue;
    }

    const acct = byRef.get(meta.ref);

    if (!acct) throw new Error(`unresolved account ref '${meta.ref}' (provide it in options.accounts)`);

    placed.add(meta.ref);
    metas.push(
      accountMeta(acct, meta.writable || (acct.spec.writable ?? false), meta.signer || (acct.spec.signer ?? false)),
    );
  }

  for (const acct of resolved) {
    if (!placed.has(acct.spec.ref))
      metas.push(accountMeta(acct, acct.spec.writable ?? false, acct.spec.signer ?? false));
  }

  if (!payerPlaced) metas.push({ address: harness.payer.address, role: AccountRole.WRITABLE_SIGNER });

  const data = new Uint8Array(EXECUTE_DISCRIMINATOR.length + bytecode[0].length);
  data.set(EXECUTE_DISCRIMINATOR, 0);
  data.set(bytecode[0], EXECUTE_DISCRIMINATOR.length);

  const instruction: Instruction = {
    programAddress: harness.programId,
    accounts: [
      { address: harness.pdas.stack, role: AccountRole.WRITABLE },
      { address: harness.pdas.heap, role: AccountRole.WRITABLE },
      { address: harness.pdas.frames, role: AccountRole.WRITABLE },
      ...metas,
    ],
    data,
  };

  // A fresh blockhash per send keeps signatures unique — LiteSVM's transaction
  // history rejects a byte-identical resend (e.g. the same source cooked twice).
  harness.svm.expireBlockhash();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(harness.payer, m),
    (m) => appendTransactionMessageInstructions([instruction], m),
    (m) => harness.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const result = harness.svm.sendTransaction(transaction);

  if (result instanceof FailedTransactionMetadata) {
    // Nearly all engine errors collapse to InvalidInstructionData at the tx
    // level, so the logs are the only channel a fail-path test can inspect.
    const revertData = result.meta().returnData().data();
    const logs = result.meta().logs();

    return revertData.length > 0
      ? { ok: false, revertData, err: String(result.err()), logs }
      : { ok: false, err: String(result.err()), logs };
  }

  return { ok: true, returnData: result.returnData().data(), logs: result.logs() };
};

/** Decodes a successful scalar result (32-byte big-endian word; empty → 0). */
export const svmUint = (result: SvmCookResult): bigint => {
  if (!result.ok) throw new Error(`svm execution failed: ${result.err}`);

  return result.returnData.length === 0 ? 0n : BigInt('0x' + Buffer.from(result.returnData).toString('hex'));
};

/** Hex of a successful result's raw return bytes (dynamic Bytes results). */
export const svmHex = (result: SvmCookResult): string => {
  if (!result.ok) throw new Error(`svm execution failed: ${result.err}`);

  return '0x' + Buffer.from(result.returnData).toString('hex');
};
