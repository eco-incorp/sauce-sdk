/**
 * Packet budget estimator for the 'svm' compile target.
 *
 * Solana caps a serialized transaction packet at 1232 bytes, and the execute
 * instruction carries the full v12 bytecode as instruction data — so bytecode
 * size eats directly into that budget. estimatePacket models the v0
 * transaction the send layer will build (fee payer + engine program + the 3
 * engine PDAs + the plan's user accounts, execute as the only instruction) and
 * reports overflow before anything hits the wire. Pure function of its inputs;
 * raw-index plans have empty metas, so their user accounts are not counted.
 *
 * The ref 'payer' is reserved: the SDK's resolveAccounts binds it to the fee
 * payer, whose signature, key, and lock the fixed terms already count — a plan
 * meta under that ref adds only its 1-byte instruction account index.
 */
import type { AccountPlan } from './registry.js';

/** Reserved ref, bound to the fee payer by the SDK send layer (resolveAccounts' PAYER_REF). */
const PAYER_REF = 'payer';

export interface PacketBudgetOptions {
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
   * microLamportsPerCu price prepend adds 12 more. Default 0.
   */
  prependBytes?: number;
}

export interface PacketBudget {
  bytecodeBytes: number;
  /** 8 (execute discriminator) + bytecodeBytes. */
  instructionDataBytes: number;
  /** payer + engine program + 3 engine PDAs + non-ALT user metas (a reserved 'payer' meta dedupes into the fee payer). */
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
  warnings: string[];
}

const PACKET_LIMIT_BYTES = 1232;

// The runtime lock cap is 64 today — the increase_tx_account_lock_limit
// feature (raising it to 128) is not active.
const LOCK_LIMIT = 64;

/** payer + engine program + stack/heap/frames PDAs — always in the static key section. */
const FIXED_STATIC_KEYS = 5;

/** Byte length of a compact-u16 (shortvec) encoding: 1 below 0x80, 2 below 0x4000, else 3. */
function compactU16Len(n: number): number {
  return n < 0x80 ? 1 : n < 0x4000 ? 2 : 3;
}

export function estimatePacket(
  plan: AccountPlan,
  bytecodeLength: number,
  opts: PacketBudgetOptions = {},
): PacketBudget {
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

  if (lookupAddresses > nonPayerMetas) {
    throw new Error(`lookupAddresses (${lookupAddresses}) exceeds the plan's account metas (${nonPayerMetas})`);
  }

  if (lookupAddresses > 0 && lookupTables === 0) {
    throw new Error(`lookupAddresses (${lookupAddresses}) requires lookupTables > 0, got 0`);
  }

  const bytecodeBytes = bytecodeLength;
  const instructionDataBytes = 8 + bytecodeBytes;
  const staticAccountKeys = FIXED_STATIC_KEYS + (nonPayerMetas - lookupAddresses);
  // Every account the execute instruction references, ALT-resolved included
  // (ALT moves key BYTES out of the message, not the instruction's index list).
  const ixAccounts = 3 + userMetas;

  // v0 wire math, term by term (every count prefix is compact-u16: 1 byte
  // below 128, 2 below 16384, else 3):
  //   signatures   = compact signature count + 64 per signature
  //   message      = version prefix 1 + header 3 + compact key count
  //                  + 32 per static account key + recent blockhash 32
  //   instructions = compact instruction count 1 + the execute instruction:
  //                  program-id index 1 + compact account count + 1 per account index
  //                  + compact data length (2 for >=128) + (8 discriminator + bytecode)
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
      `transaction exceeds the 1232-byte packet by ${overflowBytes} bytes; use address lookup tables or trim bytecode`,
    );
  }

  if (accountLocks > LOCK_LIMIT) {
    warnings.push(`account locks (${accountLocks}) exceed the runtime cap of 64`);
  }

  return {
    bytecodeBytes,
    instructionDataBytes,
    staticAccountKeys,
    messageBytes,
    limitBytes: PACKET_LIMIT_BYTES,
    overflowBytes,
    accountLocks,
    lockLimit: LOCK_LIMIT,
    warnings,
  };
}
