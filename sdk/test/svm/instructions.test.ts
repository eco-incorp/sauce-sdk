import { AccountRole, address } from '@solana/kit';
import {
  EXECUTE_DISCRIMINATOR,
  INIT_FRAMES_DISCRIMINATOR,
  INIT_HEAP_DISCRIMINATOR,
  INIT_STACK_DISCRIMINATOR,
  PDA_FRAMES_BYTES,
  PDA_GROWTH_STEP,
  PDA_HEAP_BYTES,
  PDA_STACK_BYTES,
  buildExecuteInstruction,
  buildInitInstructions,
  deriveEnginePdas,
} from '../../src/svm/index.js';
import type { EnginePdas } from '../../src/svm/index.js';

const PROGRAM_ID = address('Stake11111111111111111111111111111111111111');
const PAYER = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

let pdas: EnginePdas;

beforeAll(async () => {
  pdas = await deriveEnginePdas(PROGRAM_ID);
});

describe('engine PDA constants', () => {
  it('match the engine crate values', () => {
    expect(PDA_STACK_BYTES).toBe(1 + 1024 * 33); // bump + 1024 slots of 33 bytes
    expect(PDA_HEAP_BYTES).toBe(1 + 0xffff); // bump + u16::MAX
    expect(PDA_FRAMES_BYTES).toBe(1 + 4 * (256 + 256) * 33); // bump + 4 eval depths * (value+heap slots) * 33
    expect(PDA_GROWTH_STEP).toBe(10240); // MAX_PERMITTED_DATA_INCREASE
  });
});

describe('buildInitInstructions', () => {
  it('emits the exact 4 + 7 + 7 grow-to-size sequence', () => {
    const instructions = buildInitInstructions(PROGRAM_ID, pdas, PAYER);

    expect(instructions).toHaveLength(18);
    expect(Math.ceil(PDA_STACK_BYTES / PDA_GROWTH_STEP)).toBe(4);
    expect(Math.ceil(PDA_HEAP_BYTES / PDA_GROWTH_STEP)).toBe(7);
    expect(Math.ceil(PDA_FRAMES_BYTES / PDA_GROWTH_STEP)).toBe(7);

    for (const [i, instruction] of instructions.entries()) {
      const [discriminator, pda] =
        i < 4
          ? [INIT_STACK_DISCRIMINATOR, pdas.stack]
          : i < 11
            ? [INIT_HEAP_DISCRIMINATOR, pdas.heap]
            : [INIT_FRAMES_DISCRIMINATOR, pdas.frames];

      // data is the 8-byte discriminator ONLY — any trailing byte is rejected by the engine
      expect(instruction.data).toEqual(discriminator);
      expect(instruction.programAddress).toBe(PROGRAM_ID);
      expect(instruction.accounts).toEqual([
        { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
        { address: pda.address, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      ]);
    }
  });

  it('emits only the missing growth steps when current sizes are provided', () => {
    const instructions = buildInitInstructions(PROGRAM_ID, pdas, PAYER, {
      stack: PDA_STACK_BYTES,
      heap: 30000, // ceil((65536 - 30000) / 10240) = 4 steps left
      frames: PDA_FRAMES_BYTES,
    });

    expect(instructions).toHaveLength(4);
    for (const ix of instructions) expect(ix.data).toEqual(INIT_HEAP_DISCRIMINATOR);
  });

  it('returns fresh instruction objects that do not alias the discriminator constants', () => {
    const instructions = buildInitInstructions(PROGRAM_ID, pdas, PAYER);

    expect(instructions[0]).not.toBe(instructions[1]);
    expect(instructions[0].data).not.toBe(instructions[1].data);
    expect(instructions[0].data).not.toBe(INIT_STACK_DISCRIMINATOR);
  });

  it('emits nothing when all PDAs are at full size', () => {
    const instructions = buildInitInstructions(PROGRAM_ID, pdas, PAYER, {
      stack: PDA_STACK_BYTES,
      heap: PDA_HEAP_BYTES,
      frames: PDA_FRAMES_BYTES,
    });

    expect(instructions).toHaveLength(0);
  });
});

describe('buildExecuteInstruction', () => {
  const bytecode = new Uint8Array([0x01, 0xaa, 0x00]); // BYTE_1 0xAA, STOP
  const userA = address('So11111111111111111111111111111111111111112');
  const userB = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

  it('prefixes the bytecode with the execute discriminator', () => {
    const instruction = buildExecuteInstruction({ programId: PROGRAM_ID, pdas, bytecode, accounts: [] });

    expect(instruction.data).toEqual(new Uint8Array([...EXECUTE_DISCRIMINATOR, 0x01, 0xaa, 0x00]));
    expect(instruction.programAddress).toBe(PROGRAM_ID);
  });

  it('orders accounts [stack W, heap W, frames W, ...user metas]', () => {
    const instruction = buildExecuteInstruction({
      programId: PROGRAM_ID,
      pdas,
      bytecode,
      accounts: [
        { address: userA, role: AccountRole.WRITABLE },
        { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
        { address: userB, role: AccountRole.READONLY },
      ],
    });

    // user-account index 0 = instruction account 3
    expect(instruction.accounts).toEqual([
      { address: pdas.stack.address, role: AccountRole.WRITABLE },
      { address: pdas.heap.address, role: AccountRole.WRITABLE },
      { address: pdas.frames.address, role: AccountRole.WRITABLE },
      { address: userA, role: AccountRole.WRITABLE },
      { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
      { address: userB, role: AccountRole.READONLY },
    ]);
  });

  it('keeps the payer meta a signer so MSG_SENDER resolves', () => {
    const instruction = buildExecuteInstruction({
      programId: PROGRAM_ID,
      pdas,
      bytecode,
      accounts: [{ address: PAYER, role: AccountRole.WRITABLE_SIGNER }],
    });

    expect(instruction.accounts?.[3]).toEqual({ address: PAYER, role: AccountRole.WRITABLE_SIGNER });
  });
});
