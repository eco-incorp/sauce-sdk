import { address } from '@solana/kit';
import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getSyncNativeInstruction,
} from '@solana-program/token';
import { getTransferSolInstruction } from '@solana-program/system';

/** Wrapped SOL mint (not exported by @solana-program/token). */
export const NATIVE_MINT: Address = address('So11111111111111111111111111111111111111112');

export interface ComputeBudgetPrependInput {
  unitLimit: number;
  microLamportsPerCu?: number | bigint;
}

export function buildComputeBudgetPrepend({ unitLimit, microLamportsPerCu }: ComputeBudgetPrependInput): Instruction[] {
  const instructions: Instruction[] = [getSetComputeUnitLimitInstruction({ units: unitLimit })];

  if (microLamportsPerCu !== undefined) {
    instructions.push(getSetComputeUnitPriceInstruction({ microLamports: microLamportsPerCu }));
  }

  return instructions;
}

export interface AtaPrependInput {
  payer: TransactionSigner;
  owner: Address;
  mint: Address;
  tokenProgram?: Address;
}

/** Idempotent ATA creation — safe to prepend whether or not the ATA already exists. */
export async function buildAtaPrepend({ payer, owner, mint, tokenProgram }: AtaPrependInput): Promise<{ ata: Address; instruction: Instruction }> {
  const program = tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: program });
  const instruction = getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner, mint, tokenProgram: program });

  return { ata, instruction };
}

export interface WrapSolPrependsInput {
  payer: TransactionSigner;
  owner: Address;
  lamports: bigint;
}

/** Idempotent wSOL ATA + SOL transfer + SyncNative — wraps `lamports` into the owner's wSOL account. */
export async function buildWrapSolPrepends({ payer, owner, lamports }: WrapSolPrependsInput): Promise<{ wsolAta: Address; instructions: Instruction[] }> {
  const { ata, instruction: createAta } = await buildAtaPrepend({ payer, owner, mint: NATIVE_MINT });
  const transfer = getTransferSolInstruction({ source: payer, destination: ata, amount: lamports });
  const sync = getSyncNativeInstruction({ account: ata });

  return { wsolAta: ata, instructions: [createAta, transfer, sync] };
}
