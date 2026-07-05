import { createHash } from 'node:crypto';
import {
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
  WRITE_BUFFER_DISCRIMINATOR,
} from '../../src/svm/index.js';

// Anchor-style discriminator: sha256("global:<instruction_name>")[..8]
function anchorDiscriminator(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));
}

// All 11 engine instructions, name → exported constant.
const DISCRIMINATORS: Record<string, Uint8Array> = {
  execute: EXECUTE_DISCRIMINATOR,
  execute_from_account: EXECUTE_FROM_ACCOUNT_DISCRIMINATOR,
  init_stack: INIT_STACK_DISCRIMINATOR,
  init_heap: INIT_HEAP_DISCRIMINATOR,
  init_frames: INIT_FRAMES_DISCRIMINATOR,
  init_args: INIT_ARGS_DISCRIMINATOR,
  close_memory: CLOSE_MEMORY_DISCRIMINATOR,
  init_buffer: INIT_BUFFER_DISCRIMINATOR,
  write_buffer: WRITE_BUFFER_DISCRIMINATOR,
  finalize_buffer: FINALIZE_BUFFER_DISCRIMINATOR,
  close_buffer: CLOSE_BUFFER_DISCRIMINATOR,
};

describe('engine instruction discriminators', () => {
  it('covers the full 11-instruction surface', () => {
    expect(Object.keys(DISCRIMINATORS)).toHaveLength(11);
  });

  for (const [name, constant] of Object.entries(DISCRIMINATORS)) {
    it(`${name} matches sha256("global:${name}")[..8]`, () => {
      expect(constant).toEqual(anchorDiscriminator(name));
    });
  }

  it('discriminators are pairwise distinct', () => {
    const hexes = Object.values(DISCRIMINATORS).map(d => Buffer.from(d).toString('hex'));

    expect(new Set(hexes).size).toBe(hexes.length);
  });
});
