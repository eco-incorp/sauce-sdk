import { AccountRole, address } from '@solana/kit';
import {
  BUFFER_HEADER_BYTES,
  CLOSE_BUFFER_DISCRIMINATOR,
  CLOSE_MEMORY_DISCRIMINATOR,
  EXECUTE_DISCRIMINATOR,
  EXECUTE_FROM_ACCOUNT_DISCRIMINATOR,
  FINALIZE_BUFFER_DISCRIMINATOR,
  INIT_ARGS_DISCRIMINATOR,
  INIT_BUFFER_DISCRIMINATOR,
  INIT_FRAMES_DISCRIMINATOR,
  INIT_HEAP_DISCRIMINATOR,
  INIT_STACK_DISCRIMINATOR,
  MAX_BUFFER_CAPACITY,
  PDA_ARGS_BYTES,
  PDA_FRAMES_BYTES,
  PDA_GROWTH_STEP,
  PDA_HEAP_BYTES,
  PDA_STACK_BYTES,
  WRITE_BUFFER_DISCRIMINATOR,
  buildCloseBufferInstruction,
  buildCloseMemoryInstruction,
  buildExecuteFromAccountInstruction,
  buildExecuteInstruction,
  buildFinalizeBufferInstruction,
  buildInitBufferInstructions,
  buildInitInstructions,
  buildStagingPlan,
  buildWriteBufferInstruction,
  deriveEnginePdas,
} from '../../src/svm/index.js';
import type { EnginePdas } from '../../src/svm/index.js';

const PROGRAM_ID = address('Stake11111111111111111111111111111111111111');
const PAYER = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const BUFFER = address('So11111111111111111111111111111111111111112');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

let pdas: EnginePdas;

beforeAll(async () => {
  pdas = await deriveEnginePdas(PROGRAM_ID, PAYER);
});

describe('engine PDA constants', () => {
  it('match the engine crate values', () => {
    expect(PDA_STACK_BYTES).toBe(3 + 1024 * 33); // [kind, bump, session] + 1024 slots of 33 bytes
    expect(PDA_HEAP_BYTES).toBe(3 + 0xffff); // header + u16::MAX
    expect(PDA_FRAMES_BYTES).toBe(3 + 4 * (256 + 256) * 33); // header + 4 eval depths * (value+heap slots) * 33
    expect(PDA_ARGS_BYTES).toBe(32 + 8192); // reserved 32-byte header word + arg region
    expect(PDA_GROWTH_STEP).toBe(10240); // MAX_PERMITTED_DATA_INCREASE
    expect(BUFFER_HEADER_BYTES).toBe(80);
    expect(MAX_BUFFER_CAPACITY).toBe(0xffff); // the last addressable 16-bit pc
  });
});

describe('buildInitInstructions', () => {
  it('emits the exact 4 + 7 + 7 + 1 grow-to-size sequence with the session payload', () => {
    const instructions = buildInitInstructions(PROGRAM_ID, pdas, PAYER);

    expect(instructions).toHaveLength(19);
    expect(Math.ceil(PDA_STACK_BYTES / PDA_GROWTH_STEP)).toBe(4);
    expect(Math.ceil(PDA_HEAP_BYTES / PDA_GROWTH_STEP)).toBe(7);
    expect(Math.ceil(PDA_FRAMES_BYTES / PDA_GROWTH_STEP)).toBe(7);
    expect(Math.ceil(PDA_ARGS_BYTES / PDA_GROWTH_STEP)).toBe(1);

    for (const [i, instruction] of instructions.entries()) {
      const [discriminator, pda] =
        i < 4
          ? [INIT_STACK_DISCRIMINATOR, pdas.stack]
          : i < 11
            ? [INIT_HEAP_DISCRIMINATOR, pdas.heap]
            : i < 18
              ? [INIT_FRAMES_DISCRIMINATOR, pdas.frames]
              : [INIT_ARGS_DISCRIMINATOR, pdas.args];

      // data is the 8-byte discriminator + EXACTLY one session byte
      expect(instruction.data).toEqual(new Uint8Array([...discriminator, 0]));
      expect(instruction.programAddress).toBe(PROGRAM_ID);
      expect(instruction.accounts).toEqual([
        { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
        { address: pda.address, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      ]);
    }
  });

  it('stamps a non-zero session byte into every payload', () => {
    const instructions = buildInitInstructions(PROGRAM_ID, pdas, PAYER, {}, 7);

    for (const instruction of instructions) expect(instruction.data?.[8]).toBe(7);
  });

  it('emits only the missing growth steps when current sizes are provided', () => {
    const instructions = buildInitInstructions(PROGRAM_ID, pdas, PAYER, {
      stack: PDA_STACK_BYTES,
      heap: 30000, // ceil((65538 - 30000) / 10240) = 4 steps left
      frames: PDA_FRAMES_BYTES,
      args: PDA_ARGS_BYTES,
    });

    expect(instructions).toHaveLength(4);
    for (const ix of instructions) expect(ix.data?.subarray(0, 8)).toEqual(INIT_HEAP_DISCRIMINATOR);
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
      args: PDA_ARGS_BYTES,
    });

    expect(instructions).toHaveLength(0);
  });

  it('rejects a non-u8 session', () => {
    expect(() => buildInitInstructions(PROGRAM_ID, pdas, PAYER, {}, 256)).toThrow('session must be a u8 (0-255), got 256');
  });
});

describe('buildCloseMemoryInstruction', () => {
  it('lists [owner WS, stack, heap, frames, args W] with the session payload', () => {
    const instruction = buildCloseMemoryInstruction({ programId: PROGRAM_ID, pdas, owner: PAYER, session: 3 });

    expect(instruction.data).toEqual(new Uint8Array([...CLOSE_MEMORY_DISCRIMINATOR, 3]));
    expect(instruction.accounts).toEqual([
      { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
      { address: pdas.stack.address, role: AccountRole.WRITABLE },
      { address: pdas.heap.address, role: AccountRole.WRITABLE },
      { address: pdas.frames.address, role: AccountRole.WRITABLE },
      { address: pdas.args.address, role: AccountRole.WRITABLE },
    ]);
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

describe('buildExecuteFromAccountInstruction', () => {
  const user = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

  it('prepends the buffer READ-ONLY: the user tail is byte-identical to inline execute', () => {
    const instruction = buildExecuteFromAccountInstruction({
      programId: PROGRAM_ID,
      buffer: BUFFER,
      pdas,
      accounts: [
        { address: user, role: AccountRole.WRITABLE },
        { address: PAYER, role: AccountRole.READONLY_SIGNER },
      ],
    });

    expect(instruction.accounts).toEqual([
      { address: BUFFER, role: AccountRole.READONLY },
      { address: pdas.stack.address, role: AccountRole.WRITABLE },
      { address: pdas.heap.address, role: AccountRole.WRITABLE },
      { address: pdas.frames.address, role: AccountRole.WRITABLE },
      { address: user, role: AccountRole.WRITABLE },
      { address: PAYER, role: AccountRole.READONLY_SIGNER },
    ]);
    // no pin: the data is the bare discriminator
    expect(instruction.data).toEqual(EXECUTE_FROM_ACCOUNT_DISCRIMINATOR);
  });

  it('appends the optional 32-byte content-hash pin to the data', () => {
    const pin = new Uint8Array(32).fill(0xcd);
    const instruction = buildExecuteFromAccountInstruction({
      programId: PROGRAM_ID,
      buffer: BUFFER,
      pdas,
      accounts: [],
      expectedSha256: pin,
    });

    expect(instruction.data).toEqual(new Uint8Array([...EXECUTE_FROM_ACCOUNT_DISCRIMINATOR, ...pin]));
  });

  it('rejects a pin that is not exactly 32 bytes', () => {
    expect(() =>
      buildExecuteFromAccountInstruction({
        programId: PROGRAM_ID,
        buffer: BUFFER,
        pdas,
        accounts: [],
        expectedSha256: new Uint8Array(31),
      }),
    ).toThrow('expectedSha256 must be exactly 32 bytes, got 31');
  });
});

describe('buffer lifecycle builders', () => {
  it('init_buffer payload is index u8 + capacity u32 LE; one instruction under one growth step', () => {
    const instructions = buildInitBufferInstructions({
      programId: PROGRAM_ID,
      payer: PAYER,
      buffer: BUFFER,
      index: 3,
      capacity: 4096,
    });

    expect(instructions).toHaveLength(1); // 80 + 4096 = 4176 ≤ 10240
    expect(instructions[0].data).toEqual(new Uint8Array([...INIT_BUFFER_DISCRIMINATOR, 3, 0x00, 0x10, 0x00, 0x00]));
    expect(instructions[0].accounts).toEqual([
      { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
      { address: BUFFER, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ]);
  });

  it('a 16 KB buffer needs two init instructions (create + one grow), all one transaction', () => {
    const instructions = buildInitBufferInstructions({
      programId: PROGRAM_ID,
      payer: PAYER,
      buffer: BUFFER,
      index: 0,
      capacity: 16 * 1024,
    });

    expect(instructions).toHaveLength(2); // 80 + 16384 = 16464 → 2 x 10240 steps
    expect(instructions[0].data).toEqual(instructions[1].data);
    expect(instructions[0].data).not.toBe(instructions[1].data);
  });

  it('init_buffer emits only the missing growth steps and validates capacity', () => {
    const grown = buildInitBufferInstructions({
      programId: PROGRAM_ID,
      payer: PAYER,
      buffer: BUFFER,
      index: 0,
      capacity: 16 * 1024,
      currentBytes: 10240,
    });

    expect(grown).toHaveLength(1);
    expect(() =>
      buildInitBufferInstructions({ programId: PROGRAM_ID, payer: PAYER, buffer: BUFFER, index: 0, capacity: MAX_BUFFER_CAPACITY + 1 }),
    ).toThrow(`buffer capacity must be 1-${MAX_BUFFER_CAPACITY} bytes, got 65536`);
    expect(() =>
      buildInitBufferInstructions({ programId: PROGRAM_ID, payer: PAYER, buffer: BUFFER, index: 256, capacity: 100 }),
    ).toThrow('buffer index must be a u8 (0-255), got 256');
  });

  it('write_buffer payload is offset u32 LE + the chunk; [authority RS, buffer W]', () => {
    const chunk = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const instruction = buildWriteBufferInstruction({
      programId: PROGRAM_ID,
      authority: PAYER,
      buffer: BUFFER,
      offset: 0x1234,
      chunk,
    });

    expect(instruction.data).toEqual(new Uint8Array([...WRITE_BUFFER_DISCRIMINATOR, 0x34, 0x12, 0x00, 0x00, ...chunk]));
    expect(instruction.accounts).toEqual([
      { address: PAYER, role: AccountRole.READONLY_SIGNER },
      { address: BUFFER, role: AccountRole.WRITABLE },
    ]);
  });

  it('finalize_buffer payload is len u32 LE + the 32-byte sha256 (exactly 36 payload bytes)', () => {
    const sha256 = new Uint8Array(32).fill(0xab);
    const instruction = buildFinalizeBufferInstruction({
      programId: PROGRAM_ID,
      authority: PAYER,
      buffer: BUFFER,
      length: 5000,
      sha256,
    });

    expect(instruction.data).toEqual(new Uint8Array([...FINALIZE_BUFFER_DISCRIMINATOR, 0x88, 0x13, 0x00, 0x00, ...sha256]));
    expect(instruction.data).toHaveLength(8 + 36);
    expect(() =>
      buildFinalizeBufferInstruction({ programId: PROGRAM_ID, authority: PAYER, buffer: BUFFER, length: 1, sha256: new Uint8Array(16) }),
    ).toThrow('sha256 must be exactly 32 bytes, got 16');
  });

  it('close_buffer carries no payload; [authority WS, buffer W]', () => {
    const instruction = buildCloseBufferInstruction({ programId: PROGRAM_ID, authority: PAYER, buffer: BUFFER });

    expect(instruction.data).toEqual(CLOSE_BUFFER_DISCRIMINATOR);
    expect(instruction.data).not.toBe(CLOSE_BUFFER_DISCRIMINATOR); // fresh copy
    expect(instruction.accounts).toEqual([
      { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
      { address: BUFFER, role: AccountRole.WRITABLE },
    ]);
  });
});

describe('buildStagingPlan', () => {
  it('pins the engine staging protocol: 8/12/20 transactions for 4/8/16 KB', () => {
    expect(buildStagingPlan(4 * 1024).transactions).toEqual({ init: 1, writes: 5, finalize: 1, execute: 1, total: 8 });
    expect(buildStagingPlan(8 * 1024).transactions).toEqual({ init: 1, writes: 9, finalize: 1, execute: 1, total: 12 });
    expect(buildStagingPlan(16 * 1024).transactions).toEqual({ init: 1, writes: 17, finalize: 1, execute: 1, total: 20 });
  });

  it('chunks cover the bytecode exactly, in order, at the 1,000-byte default', () => {
    const plan = buildStagingPlan(2500);

    expect(plan.chunks).toEqual([
      { offset: 0, length: 1000 },
      { offset: 1000, length: 1000 },
      { offset: 2000, length: 500 },
    ]);
    expect(plan.capacity).toBe(2500);
  });

  it('init instruction counts follow the 10,240-byte growth step (header included)', () => {
    expect(buildStagingPlan(4 * 1024).initInstructionCount).toBe(1); // 4176
    expect(buildStagingPlan(16 * 1024).initInstructionCount).toBe(2); // 16464
    expect(buildStagingPlan(MAX_BUFFER_CAPACITY).initInstructionCount).toBe(7); // 65615
  });

  it('rejects out-of-range inputs', () => {
    expect(() => buildStagingPlan(0)).toThrow(`bytecode length must be 1-${MAX_BUFFER_CAPACITY} bytes, got 0`);
    expect(() => buildStagingPlan(MAX_BUFFER_CAPACITY + 1)).toThrow(
      `bytecode length must be 1-${MAX_BUFFER_CAPACITY} bytes, got 65536`,
    );
    expect(() => buildStagingPlan(100, 0)).toThrow('chunk size must be a positive integer, got 0');
  });
});
