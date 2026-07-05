/**
 * Packet budget estimator for the 'svm' compile target.
 *
 * Solana caps a serialized transaction packet at 1232 bytes. Two execute
 * transports exist:
 *
 * - **inline** (`execute`): the instruction data carries the full v12 bytecode,
 *   so bytecode size eats directly into the packet budget (practical ceiling
 *   ~800-950 bytes of bytecode depending on the account surface).
 * - **staged** (`execute_from_account`): the bytecode lives in a finalized
 *   buffer PDA (staged across separate transactions) and the execute
 *   instruction data is just the 8-byte discriminator plus the 32-byte content
 *   hash pin — bytecode size stops mattering to the packet and is bounded by
 *   the 65,535-byte buffer capacity instead. The account list gains the buffer
 *   (prepended read-only before the 3 memory PDAs).
 *
 * estimatePacket models the v0 transaction the send layer will build (fee
 * payer + engine program + the engine PDAs + the plan's user accounts, execute
 * as the only instruction) and reports overflow before anything hits the wire.
 * Pure function of its inputs; raw-index plans have empty metas, so their user
 * accounts are not counted.
 *
 * The ref 'payer' is reserved: the SDK's resolveAccounts binds it to the fee
 * payer, whose signature, key, and lock the fixed terms already count — a plan
 * meta under that ref adds only its 1-byte instruction account index. The
 * engine requires an in-list signer on both execute paths; when the plan
 * declares none, the SDK appends the fee payer as one (modeled below as one
 * extra instruction account index — key and signature are already counted).
 */
import type { AccountPlan } from './registry.js';
import { PAYER_REF } from './registry.js';

export type PacketMode = 'inline' | 'staged';

export interface PacketBudgetOptions {
  /**
   * Execute transport being modeled. 'inline' (default) carries the bytecode
   * in the instruction data; 'staged' models execute_from_account — data is
   * discriminator + 32-byte hash pin, the buffer account is prepended, and the
   * bytecode is bounded by the 65,535-byte buffer capacity instead of the
   * packet. Pass the plan the staged compile produced (it already carries the
   * reserved args/payer metas).
   */
  mode?: PacketMode;
  /**
   * Transaction signature count (fee payer included). Default: 1 (fee payer)
   * + one per plan meta flagged signer, except the reserved 'payer' ref (it is
   * guaranteed-bound to the fee payer). Still conservative for any OTHER
   * signer ref the sender happens to resolve to the fee payer's own key —
   * pass an explicit count for that case.
   */
  signers?: number;
  /** Address lookup tables referenced by the message. Default 0. */
  lookupTables?: number;
  /** Account metas resolved via those tables (moved out of the static key section). Default 0. */
  lookupAddresses?: number;
  /**
   * Serialized bytes of instructions the send layer prepends to execute —
   * the estimate models execute as the ONLY instruction. The SDK's
   * computeUnitLimit option prepends one ComputeBudget SetComputeUnitLimit
   * instruction: +40 bytes (32-byte program key + 8-byte instruction); a
   * microLamportsPerCu price prepend adds 12 more. In staged mode the same-tx
   * args-writer inline execute (executeStaged with args) is a prepend too:
   * ~8 bytes + its writer bytecode + 5 account indices. Default 0.
   */
  prependBytes?: number;
}

export interface PacketBudget {
  /** The transport this estimate models. */
  mode: PacketMode;
  bytecodeBytes: number;
  /** inline: 8 (discriminator) + bytecodeBytes; staged: 8 + 32 (content-hash pin). */
  instructionDataBytes: number;
  /** payer + engine program + engine PDAs (+ buffer when staged) + non-ALT user metas (a reserved 'payer' meta dedupes into the fee payer). */
  staticAccountKeys: number;
  /** Full serialized v0 transaction estimate (prependBytes headroom included). */
  messageBytes: number;
  /** 1232 — the wire packet cap. */
  limitBytes: number;
  /** max(0, messageBytes - limitBytes). */
  overflowBytes: number;
  /** Total unique tx accounts, ALT-resolved included. */
  accountLocks: number;
  /** 64 — the runtime account-lock cap. */
  lockLimit: number;
  /**
   * staged only: end-to-end transactions to stage-and-execute this bytecode at
   * the 1,000-byte write chunk — init tx + ceil(len/1000) write txs + a
   * dedicated finalize tx + the execute tx (8/12/20 for 4/8/16 KB).
   */
  stagingTxs?: number;
  warnings: string[];
}

const PACKET_LIMIT_BYTES = 1232;

// The runtime lock cap is 64 today — the increase_tx_account_lock_limit
// feature (raising it to 128) is not active.
const LOCK_LIMIT = 64;

/** payer + engine program + stack/heap/frames PDAs — always in the static key section. */
const FIXED_STATIC_KEYS = 5;

/** The staged buffer rides read-only ahead of the memory PDAs — one more static key. */
const STAGED_EXTRA_STATIC_KEYS = 1;

/** Mirrors the engine's MAX_BUFFER_CAPACITY (u16::MAX, the last addressable pc). */
const MAX_BUFFER_CAPACITY = 65_535;

/** The SDK's staging write chunk (hard packet ceiling ≈ 1,016; 1,000 leaves margin). */
const STAGING_CHUNK_BYTES = 1_000;

/** Byte length of a compact-u16 (shortvec) encoding: 1 below 0x80, 2 below 0x4000, else 3. */
function compactU16Len(n: number): number {
  return n < 0x80 ? 1 : n < 0x4000 ? 2 : 3;
}

/**
 * Transactions to stage `bytecodeLength` bytes and execute them: one init tx
 * (1 ix ≤ 10,160 capacity, 2 up to 20,400, … — all fit one tx), the write txs,
 * a dedicated finalize tx (sent only after every write confirmed), the execute.
 */
export function stagingTransactionCount(bytecodeLength: number, chunkBytes: number = STAGING_CHUNK_BYTES): number {
  return 1 + Math.ceil(bytecodeLength / chunkBytes) + 1 + 1;
}

export function estimatePacket(
  plan: AccountPlan,
  bytecodeLength: number,
  opts: PacketBudgetOptions = {},
): PacketBudget {
  const mode = opts.mode ?? 'inline';
  // Every plan meta flagged signer contributes its own 64-byte signature on
  // top of the fee payer's — the runtime rejects the tx without it. The
  // reserved 'payer' ref IS the fee payer: no extra signature, key, or lock.
  const planSigners = plan.metas.reduce((n, m) => (m.signer && m.ref !== PAYER_REF ? n + 1 : n), 0);
  const signers = opts.signers ?? 1 + planSigners;
  const lookupTables = opts.lookupTables ?? 0;
  const lookupAddresses = opts.lookupAddresses ?? 0;
  const prependBytes = opts.prependBytes ?? 0;
  const userMetas = plan.metas.length;
  // Metas whose key occupies a slot outside FIXED_STATIC_KEYS (the fee payer's
  // key is deduplicated at message compile).
  const nonPayerMetas = plan.metas.reduce((n, m) => (m.ref === PAYER_REF ? n : n + 1), 0);
  // The engine fails NoSigner without an in-list signer, so the SDK appends the
  // fee payer as one when the plan declares none: +1 instruction account index
  // (its key and signature are already in the fixed terms).
  const appendedSigner = plan.metas.some((m) => m.signer || m.ref === PAYER_REF) ? 0 : 1;

  if (lookupAddresses > nonPayerMetas) {
    throw new Error(`lookupAddresses (${lookupAddresses}) exceeds the plan's account metas (${nonPayerMetas})`);
  }

  if (lookupAddresses > 0 && lookupTables === 0) {
    throw new Error(`lookupAddresses (${lookupAddresses}) requires lookupTables > 0, got 0`);
  }

  const bytecodeBytes = bytecodeLength;
  // staged: discriminator + the 32-byte content-hash pin the SDK always sends.
  const instructionDataBytes = mode === 'staged' ? 8 + 32 : 8 + bytecodeBytes;
  const fixedStaticKeys = FIXED_STATIC_KEYS + (mode === 'staged' ? STAGED_EXTRA_STATIC_KEYS : 0);
  const staticAccountKeys = fixedStaticKeys + (nonPayerMetas - lookupAddresses);
  // Every account the execute instruction references, ALT-resolved included
  // (ALT moves key BYTES out of the message, not the instruction's index list).
  // Staged prepends the buffer: [buffer, stack, heap, frames, ...user].
  const ixAccounts = (mode === 'staged' ? 4 : 3) + userMetas + appendedSigner;

  // v0 wire math, term by term (every count prefix is compact-u16: 1 byte
  // below 128, 2 below 16384, else 3):
  //   signatures   = compact signature count + 64 per signature
  //   message      = version prefix 1 + header 3 + compact key count
  //                  + 32 per static account key + recent blockhash 32
  //   instructions = compact instruction count 1 + the execute instruction:
  //                  program-id index 1 + compact account count + 1 per account index
  //                  + compact data length + instruction data
  //   ALT section  = compact table count + per table: pubkey 32
  //                  + writable/readonly compact index counts + 1 per resolved address index
  // The split of resolved addresses across tables (and each table's writable/
  // readonly lists) is unknown here, so the per-table index-count prefixes
  // assume an even spread, all in one list per table.
  const perTableAddresses = lookupTables > 0 ? Math.ceil(lookupAddresses / lookupTables) : 0;
  const signaturesSection = compactU16Len(signers) + 64 * signers;
  const messageSection = 1 + 3 + compactU16Len(staticAccountKeys) + 32 * staticAccountKeys + 32;
  const instructionsSection =
    1 + (1 + compactU16Len(ixAccounts) + ixAccounts + compactU16Len(instructionDataBytes) + instructionDataBytes);
  const altSection =
    compactU16Len(lookupTables) + lookupTables * (32 + compactU16Len(perTableAddresses) + 1) + lookupAddresses;
  const messageBytes = signaturesSection + messageSection + instructionsSection + altSection + prependBytes;

  const overflowBytes = Math.max(0, messageBytes - PACKET_LIMIT_BYTES);
  const accountLocks = staticAccountKeys + lookupAddresses;

  const warnings: string[] = [];

  if (overflowBytes > 0) {
    warnings.push(
      mode === 'staged'
        ? `staged execute transaction exceeds the 1232-byte packet by ${overflowBytes} bytes; use address lookup tables or trim accounts`
        : `transaction exceeds the 1232-byte packet by ${overflowBytes} bytes; stage the bytecode (execute_from_account), use address lookup tables, or trim bytecode`,
    );
  }

  if (mode === 'staged' && bytecodeBytes > MAX_BUFFER_CAPACITY) {
    warnings.push(
      `bytecode (${bytecodeBytes} bytes) exceeds the staged buffer capacity of ${MAX_BUFFER_CAPACITY} bytes`,
    );
  }

  if (accountLocks > LOCK_LIMIT) {
    warnings.push(`account locks (${accountLocks}) exceed the runtime cap of 64`);
  }

  return {
    mode,
    bytecodeBytes,
    instructionDataBytes,
    staticAccountKeys,
    messageBytes,
    limitBytes: PACKET_LIMIT_BYTES,
    overflowBytes,
    accountLocks,
    lockLimit: LOCK_LIMIT,
    ...(mode === 'staged' ? { stagingTxs: stagingTransactionCount(bytecodeBytes) } : {}),
    warnings,
  };
}
