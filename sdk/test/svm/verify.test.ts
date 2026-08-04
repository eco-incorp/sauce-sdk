/**
 * SVM settle verify/decode — the SVM counterpart of the EVM `/verify` decoder.
 *
 * verifySvmSettleProgram: recompile + byte-compare (the staged blob has no prologue to parse, so
 * genuineness is proven by recompiling svmSettleSource(N) and byte-comparing, not by decoding params
 * out of the bytecode). decodeSvmSettleArgs: the exact inverse of encodePayloadArgs for the four
 * settle scalar slots, from the per-execution calldata tail.
 */
import { getAddressEncoder } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import { encodePayloadArgs } from '../../src/svm/args.js';
import { svmSettleRefs, svmSettleSource } from '../../src/svm/recipes/index.js';
import { SVM_SETTLE_ARGS_BYTES, decodeSvmSettleArgs, verifySvmSettleProgram } from '../../src/svm/verify.js';

const TOKENKEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function partnerCompile(escrowCount: number) {
  return compile(svmSettleSource(escrowCount), { target: 'svm', staged: true, treeshake: true, args: [0n, 0n, 0n, 0n] });
}

/** BE u256 scalar of a pubkey's 32 bytes — how a token-program address rides a scalar arg slot. */
function addressScalar(addr: string): bigint {
  let v = 0n;
  for (const b of getAddressEncoder().encode(addr as never)) v = (v << 8n) | BigInt(b);
  return v;
}

describe('verifySvmSettleProgram', () => {
  it('accepts a genuine settle program and reports its escrow count + refs', () => {
    for (const n of [1, 2, 5, 8]) {
      const { bytecode, accountPlan } = partnerCompile(n);
      const result = verifySvmSettleProgram(bytecode[0]!, accountPlan!);
      expect(result.genuine).toBe(true);
      expect(result.escrowCount).toBe(n);
      expect(result.refs).toEqual(svmSettleRefs(n));
      expect(result.mismatch).toBeUndefined();
    }
  });

  it('rejects a program whose bytecode was tampered (one flipped byte)', () => {
    const { bytecode, accountPlan } = partnerCompile(2);
    const tampered = bytecode[0]!.slice();
    tampered[10] ^= 0xff;
    const result = verifySvmSettleProgram(tampered, accountPlan!);
    expect(result.genuine).toBe(false);
    expect(result.escrowCount).toBe(2); // shape still inferred from the plan
    expect(result.mismatch).toMatch(/byte-match svmSettleSource\(2\)/);
  });

  it('rejects a genuine blob paired with the WRONG account plan (ref mismatch)', () => {
    const { bytecode } = partnerCompile(2);
    // A plan with the right COUNT (3·2+3=9) but a wrong ref name at one slot.
    const badRefs = svmSettleRefs(2).map((r, i) => (i === 4 ? 'not_a_settle_ref' : r));
    const result = verifySvmSettleProgram(bytecode[0]!, { metas: badRefs.map((ref) => ({ ref })) });
    expect(result.genuine).toBe(false);
    expect(result.mismatch).toMatch(/refs do not match svmSettleRefs\(2\)/);
  });

  it('rejects an account plan whose size fits no settle shape (not 3N+3)', () => {
    const { bytecode } = partnerCompile(1);
    const result = verifySvmSettleProgram(bytecode[0]!, { metas: [{ ref: 'a' }, { ref: 'b' }] }); // 2 accounts
    expect(result.genuine).toBe(false);
    expect(result.escrowCount).toBeNull();
    expect(result.mismatch).toMatch(/not 3N \+ 3/);
  });
});

describe('decodeSvmSettleArgs', () => {
  it('round-trips the four args from a real encodePayloadArgs tail', () => {
    const { argsLayout } = partnerCompile(3);
    const values = [123456789n, 2n, addressScalar(TOKENKEG), addressScalar(TOKEN_2022)];
    const payload = encodePayloadArgs(argsLayout!, values);
    expect(payload.length).toBe(SVM_SETTLE_ARGS_BYTES);

    const decoded = decodeSvmSettleArgs(payload, argsLayout!);
    expect(decoded.minOut).toBe(123456789n);
    expect(decoded.splCount).toBe(2n);
    expect(decoded.tokenProgram0).toBe(TOKENKEG);
    expect(decoded.tokenProgram1).toBe(TOKEN_2022);
  });

  it('decodes a zero floor + single-program settle (tokenProgram1 == tokenProgram0)', () => {
    const { argsLayout } = partnerCompile(1);
    const payload = encodePayloadArgs(argsLayout!, [0n, 0n, addressScalar(TOKENKEG), addressScalar(TOKENKEG)]);
    const decoded = decodeSvmSettleArgs(payload);
    expect(decoded.minOut).toBe(0n);
    expect(decoded.tokenProgram0).toBe(TOKENKEG);
    expect(decoded.tokenProgram1).toBe(TOKENKEG);
  });

  it('rejects a payload that is not exactly 128 bytes', () => {
    expect(() => decodeSvmSettleArgs(new Uint8Array(96))).toThrow(/must be exactly 128 bytes/);
  });

  it('rejects an argsLayout that is not the settle shape', () => {
    const notSettle = { mode: 'calldata' as const, programLength: 0, byteLength: 32, slots: [{ arg: 0, kind: 'scalar' as const, offset: 0, length: 32 }] };
    expect(() => decodeSvmSettleArgs(new Uint8Array(128), notSettle)).toThrow(/not the settle shape/);
  });
});
