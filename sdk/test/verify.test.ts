/**
 * @eco-incorp/sauce-sdk/verify — decoder coverage.
 *
 * This file used to be ~960 lines, most of it covering a template/authenticity layer
 * (`template.ts` + `report.ts` + `internal/root-testing.ts`, and their
 * `inspectSettleProgram`/`verifySettleProgram`/`formatSettleReport` surface) that has been deleted:
 * `verify/` answers one question now — what `(tokens, minOut, recipient)` was a program compiled
 * with. "Is this body a program I audited" is answered by compiling the source and byte-comparing
 * (`@eco-incorp/sauce-sdk/programs`), which is evidence a partner derives rather than a hash
 * constant shipped in the same package as the claim it supports.
 *
 * What survived is everything that tested the DECODER: golden-vector conformance, the encode
 * round-trip, the three canonicality gaps a partner-facing decoder must not repeat, and the wire
 * constants a foreign (Go/Solidity/Python) implementer needs.
 */
import {
  decodeSettleProgram,
  encodeSettleProgram,
  parseSettleProgram,
  SettleDecodeError,
  SETTLE_VECTORS,
  SETTLE_WIRE,
} from '../src/verify/index';
import type { Hex } from 'viem';

describe('@eco-incorp/sauce-sdk/verify', () => {
  describe('golden vectors — wire conformance', () => {
    for (const v of SETTLE_VECTORS) {
      it(`decodes ${v.name}`, () => {
        const d = decodeSettleProgram(v.program);
        expect(d.tokens.map((t) => BigInt(t))).toEqual(v.tokens.map((t) => BigInt(t)));
        expect(d.minOut).toBe(v.minOut);
        expect(BigInt(d.recipient)).toBe(BigInt(v.recipient));
        expect(d.floorToken).toBe(d.tokens[0]);
      });

      it(`round-trips ${v.name} through encodeSettleProgram`, () => {
        const d = decodeSettleProgram(v.program);
        const reencoded = encodeSettleProgram(v.tokens, v.minOut, v.recipient, d.body);
        expect(reencoded.toLowerCase()).toBe(v.program.toLowerCase());
      });
    }

    it('every vector shares one identical body — the program is helper-free, so the suffix does not vary with the args', () => {
      // This is the property that lets a SINGLE body comparison cover every argument set. Asserted
      // as an invariant across the corpus rather than against a pinned hash constant, so nothing
      // here has to be rotated when the program legitimately changes.
      const bodies = new Set(SETTLE_VECTORS.map((v) => decodeSettleProgram(v.program).bodyHash));
      expect(bodies.size).toBe(1);
      const sizes = new Set(SETTLE_VECTORS.map((v) => decodeSettleProgram(v.program).bodySize));
      expect(sizes.size).toBe(1);
    });

    it('the trap vector (v3) encodes the leading-zero-byte address as a 3-byte push, not 20', () => {
      const trap = SETTLE_VECTORS.find((v) => v.name.includes('TRAP'))!;
      // 0x14 (20-byte push) for U, then the SECOND leading push for Z must be 0x03, not 0x14.
      const bytes = trap.program.slice(2);
      expect(bytes.startsWith('14833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe(true);
      expect(bytes.slice(42, 44)).toBe('03');
    });

    it('minOut=0 encodes as a 1-byte push of 0x00, never a bare 0x00 opcode', () => {
      const v1 = SETTLE_VECTORS.find((v) => v.minOut === 0n)!;
      const d = decodeSettleProgram(v1.program);
      expect(d.minOut).toBe(0n);
    });
  });

  describe('canonicality — the three gaps a partner-facing decoder must not repeat', () => {
    const goodBody = decodeSettleProgram(SETTLE_VECTORS[0]!.program).body;

    it('rejects a non-minimal-length token push (leading zero byte)', () => {
      // 0x15 (21-byte width) with a leading 0x00 byte, then the rest of a well-formed v1 program.
      const nonMinimal = ('0x15' + '00' + '833589fcd6edb6e08f4c7c32d4f71b54bda02913' + '9401' + '0100' + '144200000000000000000000000000000000000006' + goodBody.slice(2)) as Hex;
      expect(() => decodeSettleProgram(nonMinimal)).toThrow(SettleDecodeError);
      try {
        decodeSettleProgram(nonMinimal);
      } catch (e) {
        expect((e as SettleDecodeError).code).toBe('NON_MINIMAL_PUSH');
      }
    });

    it('rejects an oversize (32-byte) token push', () => {
      const oversize = ('0x20' + 'ff'.repeat(32) + '9401' + '0100' + '144200000000000000000000000000000000000006' + goodBody.slice(2)) as Hex;
      expect(() => decodeSettleProgram(oversize)).toThrow(SettleDecodeError);
      try {
        decodeSettleProgram(oversize);
      } catch (e) {
        expect((e as SettleDecodeError).code).toBe('OVERSIZE_ADDRESS');
      }
    });

    it('rejects a zero recipient', () => {
      const zeroRecipient = ('0x14833589fcd6edb6e08f4c7c32d4f71b54bda02913' + '9401' + '0100' + '0100' + goodBody.slice(2)) as Hex;
      expect(() => decodeSettleProgram(zeroRecipient)).toThrow(SettleDecodeError);
      try {
        decodeSettleProgram(zeroRecipient);
      } catch (e) {
        expect((e as SettleDecodeError).code).toBe('ZERO_RECIPIENT');
      }
    });
  });

  describe('body length', () => {
    const PROLOGUE = ('0x14833589fcd6edb6e08f4c7c32d4f71b54bda02913' + '9401' + '0100' + '144200000000000000000000000000000000000006') as Hex;

    it('rejects a prologue with no body at all', () => {
      expect(() => decodeSettleProgram(PROLOGUE)).toThrow(SettleDecodeError);
      try {
        decodeSettleProgram(PROLOGUE);
      } catch (e) {
        expect((e as SettleDecodeError).code).toBe('BODY_LENGTH');
      }
    });

    it('accepts any non-empty body — the exact length is deliberately NOT pinned here', () => {
      // A program whose body differs in length is still decodable for its PARAMS. Deciding whose
      // body it is belongs to whoever compiles the source and byte-compares, not to this decoder —
      // the old bare `165` gate rejected such a program before its params were ever read.
      const shortBody = (PROLOGUE + 'c000') as Hex;
      const d = decodeSettleProgram(shortBody);
      expect(d.bodySize).toBe(2);
      expect(BigInt(d.tokens[0]!)).toBe(BigInt('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'));
    });
  });

  describe('never throws', () => {
    it('parseSettleProgram reports malformed input instead of throwing', () => {
      for (const bad of ['', '0x', '0xzz', '0x1', '0x94'] as Hex[]) {
        expect(() => parseSettleProgram(bad)).not.toThrow();
        expect(parseSettleProgram(bad).fatal).not.toBeNull();
      }
    });
  });

  describe('closure', () => {
    it('SETTLE_WIRE exposes the wire constants a foreign implementer needs', () => {
      expect(SETTLE_WIRE.TUPLE_OP).toBe(0x94);
      expect(SETTLE_WIRE.PUSH_MIN).toBe(0x01);
      expect(SETTLE_WIRE.PUSH_MAX).toBe(0x20);
      expect(SETTLE_WIRE.ADDRESS_BYTES).toBe(20);
    });
  });
});
