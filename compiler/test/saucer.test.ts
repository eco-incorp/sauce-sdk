import { Saucer, OPS } from '../src/saucer/index.js';
import { CompilerContext } from '../src/context.js';

describe('saucer', () => {
  it('uses IF_2 for large then body', () => {
    const ctx = new CompilerContext();
    const saucer = new Saucer(ctx);
    const condition = saucer.int(1n);
    const thenBody = new Saucer(ctx);
    (thenBody as { _bytes: Uint8Array })._bytes = new Uint8Array(300);

    const result = saucer.if(condition).then(thenBody);
    expect(result._bytes[0]).toBe(OPS.IF_2);
    expect(result._bytes[1]).toBe(1);
    expect(result._bytes[2]).toBe(44);
  });

  it('uses IF_2 and JUMP_2 for large else body', () => {
    const ctx = new CompilerContext();
    const saucer = new Saucer(ctx);
    const condition = saucer.int(1n);
    const thenBody = new Saucer(ctx);
    (thenBody as { _bytes: Uint8Array })._bytes = new Uint8Array(300);
    const elseBody = new Saucer(ctx);
    (elseBody as { _bytes: Uint8Array })._bytes = new Uint8Array(400);

    const result = saucer.if(condition).then(thenBody).else(elseBody);
    // IF_2 skip = thenBody(300) + JUMP_2(1) + jumpOperand(2) = 303
    expect(result._bytes[0]).toBe(OPS.IF_2);
    expect(result._bytes[1]).toBe(1);
    expect(result._bytes[2]).toBe(47);
    // JUMP_2 at offset: IF_2(1) + skip(2) + condition(2) + thenBody(300) = 305
    expect(result._bytes[305]).toBe(OPS.JUMP_2);
    expect(result._bytes[306]).toBe(1);
    expect(result._bytes[307]).toBe(144);
  });

  it('throws when if body exceeds 65535 bytes', () => {
    const ctx = new CompilerContext();
    const saucer = new Saucer(ctx);
    const condition = saucer.int(1n);
    const thenBody = new Saucer(ctx);
    (thenBody as { _bytes: Uint8Array })._bytes = new Uint8Array(65536);

    expect(() => saucer.if(condition).then(thenBody)).toThrow('body too large: 65536 bytes exceeds 65535');
  });

  it('throws when else body exceeds 65535 bytes', () => {
    const ctx = new CompilerContext();
    const saucer = new Saucer(ctx);
    const condition = saucer.int(1n);
    const thenBody = new Saucer(ctx);
    (thenBody as { _bytes: Uint8Array })._bytes = new Uint8Array(300);
    const elseBody = new Saucer(ctx);
    (elseBody as { _bytes: Uint8Array })._bytes = new Uint8Array(65536);

    expect(() => saucer.if(condition).then(thenBody).else(elseBody)).toThrow(
      'body too large: 65536 bytes exceeds 65535',
    );
  });

  it('throws when if skip overflows on else addition', () => {
    const ctx = new CompilerContext();
    const saucer = new Saucer(ctx);
    const condition = saucer.int(1n);
    const thenBody = new Saucer(ctx);
    (thenBody as { _bytes: Uint8Array })._bytes = new Uint8Array(254);
    const elseBody = new Saucer(ctx);
    (elseBody as { _bytes: Uint8Array })._bytes = new Uint8Array(1);

    // 254 + 2 (JUMP) = 256 > 255, overflows 1-byte IF skip
    expect(() => saucer.if(condition).then(thenBody).else(elseBody)).toThrow('body too large: 256 bytes exceeds 255');
  });
});
