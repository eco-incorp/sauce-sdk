import { createHash } from 'node:crypto';
import {
  EXECUTE_DISCRIMINATOR,
  INIT_FRAMES_DISCRIMINATOR,
  INIT_HEAP_DISCRIMINATOR,
  INIT_STACK_DISCRIMINATOR,
} from '../../src/svm/index.js';

// Anchor-style discriminator: sha256("global:<instruction_name>")[..8]
function anchorDiscriminator(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));
}

describe('engine instruction discriminators', () => {
  it('execute matches sha256("global:execute")[..8]', () => {
    expect(EXECUTE_DISCRIMINATOR).toEqual(anchorDiscriminator('execute'));
  });

  it('init_stack matches sha256("global:init_stack")[..8]', () => {
    expect(INIT_STACK_DISCRIMINATOR).toEqual(anchorDiscriminator('init_stack'));
  });

  it('init_heap matches sha256("global:init_heap")[..8]', () => {
    expect(INIT_HEAP_DISCRIMINATOR).toEqual(anchorDiscriminator('init_heap'));
  });

  it('init_frames matches sha256("global:init_frames")[..8]', () => {
    expect(INIT_FRAMES_DISCRIMINATOR).toEqual(anchorDiscriminator('init_frames'));
  });
});
