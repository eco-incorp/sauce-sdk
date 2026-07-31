import {
  decodeSettleProgram,
  encodeSettleProgram,
  SettleDecodeError,
  SETTLE_VECTORS,
  SETTLE_TEMPLATES,
  CURRENT_SETTLE_TEMPLATE,
  SETTLE_WIRE,
  inspectSettleProgram,
  verifySettleProgram,
  formatSettleReport,
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
        expect(d.bodySize).toBe(165);
        expect(d.bodyHash).toBe(CURRENT_SETTLE_TEMPLATE.bodyHash);
      });

      it(`round-trips ${v.name} through encodeSettleProgram`, () => {
        const d = decodeSettleProgram(v.program);
        const reencoded = encodeSettleProgram(v.tokens, v.minOut, v.recipient, d.body);
        expect(reencoded.toLowerCase()).toBe(v.program.toLowerCase());
      });
    }

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

  describe('pin — the weld', () => {
    it('CURRENT_SETTLE_TEMPLATE.bodySize matches every golden vector body length', () => {
      for (const v of SETTLE_VECTORS) {
        const d = decodeSettleProgram(v.program);
        expect(d.bodySize).toBe(CURRENT_SETTLE_TEMPLATE.bodySize);
      }
    });

    it('SETTLE_TEMPLATES has exactly one current ecoswap-settle entry', () => {
      const current = SETTLE_TEMPLATES.filter((t) => t.id === 'ecoswap-settle' && t.status === 'current');
      expect(current.length).toBe(1);
      expect(current[0]).toBe(CURRENT_SETTLE_TEMPLATE);
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

  describe('inspectSettleProgram / verifySettleProgram — the visible report', () => {
    const v1 = SETTLE_VECTORS[0]!;

    it('inspectSettleProgram on a genuine, authentic program is structurallyValid:true, authentic:true, but ok:false — inspect NEVER checks intent, so ok can never claim it did', () => {
      const r = inspectSettleProgram(v1.program);
      // This IS the "cooked drain" shape: a well-formed, authentic (body-hash-matching) program —
      // inspect has no expectation to compare tokens/recipient against, so a single `ok:true` here
      // would read as "safe to cook" for ANY choice of tokens/recipient, including a hostile one.
      expect(r.ok).toBe(false);
      expect(r.mode).toBe('inspect');
      expect(r.structurallyValid).toBe(true);
      expect(r.authentic).toBe(true);
      expect(r.failureCode).toBe('INTENT_UNCHECKED');
      expect(r.decoded).not.toBeNull();
      const ids = r.checks.map((c) => c.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          'shape.pushes',
          'shape.canonical',
          'shape.tuple',
          'shape.arity',
          'shape.recipientNonZero',
          'body.size',
          'body.hash',
          'template.status',
          'intent.recipient',
          'intent.tokens',
          'intent.minOut',
          'intent.floorToken',
          'serverEcho.bodyHash',
        ]),
      );
      // The intent checks ARE present (never omitted — see api/README.md's "one row per check ...
      // never omitted" contract) but PERMANENTLY unchecked+blocking, which is what forces `ok:false`.
      const recip = r.checks.find((c) => c.id === 'intent.recipient')!;
      expect(recip.status).toBe('unchecked');
      expect(recip.severity).toBe('blocking');
      const tokens = r.checks.find((c) => c.id === 'intent.tokens')!;
      expect(tokens.status).toBe('unchecked');
      expect(tokens.severity).toBe('blocking');
      // BLOCKER 3: intent.floorToken must NEVER manufacture a 'pass' just because `decoded` is
      // non-null — it is 'unchecked' unless an expectation (expect.floorToken) was actually
      // supplied, exactly like every other check.
      const floorToken = r.checks.find((c) => c.id === 'intent.floorToken')!;
      expect(floorToken.status).toBe('unchecked');
      expect(r.disclosures.map((d) => d.id)).toEqual(expect.arrayContaining(['FULL_BALANCE_SWEEP', 'FLOOR_IS_LEVEL_NOT_DELTA']));
      // effects[] is a BEHAVIORAL claim gated on structurallyValid && authentic, NOT on ok (a
      // caller's absent expectation doesn't change what the program actually does) — still renders.
      expect(r.effects.length).toBe(v1.tokens.length);
      expect(r.effects[0]!.amount).toBe('ENTIRE_POT_BALANCE');
    });

    it('verifySettleProgram requires recipient at runtime even if the type system is bypassed', () => {
      // @ts-expect-error — recipient is required
      expect(() => verifySettleProgram(v1.program, {})).toThrow(TypeError);
    });

    it('verifySettleProgram: matching expectation is ok:true', () => {
      const r = verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: v1.tokens, minOut: v1.minOut });
      expect(r.ok).toBe(true);
      expect(r.checks.find((c) => c.id === 'intent.recipient')!.status).toBe('pass');
      expect(r.checks.find((c) => c.id === 'intent.tokens')!.status).toBe('pass');
    });

    it('verifySettleProgram: wrong recipient is ok:false with EXPECT_RECIPIENT', () => {
      const wrong = '0x000000000000000000000000000000000000dEaD' as Hex;
      const r = verifySettleProgram(v1.program, { recipient: wrong, tokens: v1.tokens });
      expect(r.ok).toBe(false);
      expect(r.checks.find((c) => c.id === 'intent.recipient')!.status).toBe('fail');
    });

    it('verifySettleProgram: omitting tokens/allowTokens marks intent.tokens unchecked+blocking, forcing ok:false', () => {
      const r = verifySettleProgram(v1.program, { recipient: v1.recipient });
      const tokensCheck = r.checks.find((c) => c.id === 'intent.tokens')!;
      expect(tokensCheck.status).toBe('unchecked');
      expect(tokensCheck.severity).toBe('blocking');
      expect(r.ok).toBe(false);
    });

    it('a mutated body fails body.hash but keeps every other check present and decoded populated', () => {
      const d = decodeSettleProgram(v1.program);
      const bodyHexChars = d.bodySize * 2;
      const prologueHex = v1.program.slice(0, v1.program.length - bodyHexChars); // includes '0x'
      const mutatedBodyHex = '00' + d.body.slice(4); // flip the first body byte, same length
      const mutated = (prologueHex + mutatedBodyHex) as Hex;
      const r = inspectSettleProgram(mutated);
      expect(r.ok).toBe(false);
      expect(r.failureCode).toBe('BODY_HASH');
      expect(r.decoded).not.toBeNull();
      expect(r.checks.find((c) => c.id === 'body.hash')!.status).toBe('fail');
      // every other shape check still ran and passed
      for (const id of ['shape.pushes', 'shape.canonical', 'shape.tuple', 'shape.arity', 'shape.recipientNonZero', 'body.size']) {
        expect(r.checks.find((c) => c.id === id)!.status).toBe('pass');
      }
      expect(r.effects.length).toBe(0); // unauthenticated — no behavioral claim
    });

    it('BLOCKER 2 — allowTokens + minOut alone forfeits the ok:true claim for BOTH orderings; expect.floorToken discriminates honest from attacker', () => {
      const v2 = SETTLE_VECTORS.find((v) => v.name.startsWith('v2'))!;
      const [honestFloor, honestOther] = v2.tokens; // [U, W] — U is genuinely tokens[0]
      const d = decodeSettleProgram(v2.program);
      // The attacker's program: SAME body/minOut/recipient, tokens REORDERED — the floor now sits
      // on what was the honest program's second (non-floor) token.
      const attackerProgram = encodeSettleProgram([honestOther, honestFloor], v2.minOut, v2.recipient, d.body);

      const looseExpect = { recipient: v2.recipient, allowTokens: v2.tokens, minOut: v2.minOut };
      const honestLoose = verifySettleProgram(v2.program, looseExpect);
      const attackerLoose = verifySettleProgram(attackerProgram, looseExpect);
      // BEFORE the fix this pair was ok:true / ok:true — indistinguishable. Now neither claims
      // ok:true: allowTokens is order-free and never pinned position 0, so a minOut expectation
      // with no floorToken (and no exact tokens list) cannot be honored — the report forfeits.
      expect(honestLoose.ok).toBe(false);
      expect(attackerLoose.ok).toBe(false);
      expect(honestLoose.checks.find((c) => c.id === 'intent.floorToken')!.status).toBe('unchecked');
      expect(honestLoose.checks.find((c) => c.id === 'intent.floorToken')!.severity).toBe('blocking');

      // Pin the floor explicitly: now the honest program passes and the attacker's — whose
      // decoded.floorToken has genuinely moved — fails, on the SAME allowTokens/minOut expectation.
      const pinnedExpect = { ...looseExpect, floorToken: honestFloor };
      const honestPinned = verifySettleProgram(v2.program, pinnedExpect);
      const attackerPinned = verifySettleProgram(attackerProgram, pinnedExpect);
      expect(honestPinned.ok).toBe(true);
      expect(attackerPinned.ok).toBe(false);
      expect(attackerPinned.checks.find((c) => c.id === 'intent.floorToken')!.status).toBe('fail');
      expect(attackerPinned.failureCode).toBe('EXPECT_FLOOR_TOKEN');

      // An exact (order-sensitive) `tokens` list already pins position 0 without floorToken.
      const exactExpect = { recipient: v2.recipient, tokens: v2.tokens, minOut: v2.minOut };
      expect(verifySettleProgram(v2.program, exactExpect).ok).toBe(true);
      const exactAttacker = verifySettleProgram(attackerProgram, { recipient: v2.recipient, tokens: v2.tokens, minOut: v2.minOut });
      expect(exactAttacker.ok).toBe(false); // intent.tokens itself catches the reordering
    });

    it('BLOCKER 5 — a malformed FIRST token push (single-token program) reports the SPECIFIC canonicality code, not NOT_SETTLE_SHAPED', () => {
      const good = decodeSettleProgram(SETTLE_VECTORS[0]!.program).body; // v1's genuine 165-byte body
      // A single-token settle program whose ONLY token push is non-minimal (leading zero byte,
      // width 0x15 = 21 bytes) — the scan fails on the very FIRST push, before any push is
      // recorded, which is exactly the condition that used to misattribute the failure.
      const nonMinimalFirstPush = ('0x15' + '00' + '833589fcd6edb6e08f4c7c32d4f71b54bda02913' + '9401' + '0100' + '144200000000000000000000000000000000000006' + good.slice(2)) as Hex;

      const r = inspectSettleProgram(nonMinimalFirstPush);
      expect(r.failureCode).toBe('NON_MINIMAL_PUSH');
      expect(r.checks.find((c) => c.id === 'shape.pushes')!.status).toBe('pass'); // the push run itself is complete, just non-minimal
      expect(r.checks.find((c) => c.id === 'shape.canonical')!.status).toBe('fail'); // NOT 'unchecked'
      expect(r.structurallyValid).toBe(false);
    });

    it('SHOULD-FIX: neither function throws on a garbage runtime value bypassing the type system', () => {
      // A non-string `program` (inspectSettleProgram takes no expectations to blame instead).
      expect(() => inspectSettleProgram(12345 as unknown as Hex)).not.toThrow();
      const garbageProgram = inspectSettleProgram(12345 as unknown as Hex);
      expect(garbageProgram.ok).toBe(false);
      // A garbage (non-hex, non-bigint) expect.recipient/tokens/allowTokens.
      expect(() =>
        verifySettleProgram(v1.program, { recipient: 'not-an-address' as unknown as Hex, tokens: v1.tokens }),
      ).not.toThrow();
      expect(() =>
        verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: ['also-not-an-address'] as unknown as Hex[] }),
      ).not.toThrow();
      const garbageExpect = verifySettleProgram(v1.program, { recipient: 'not-an-address' as unknown as Hex, tokens: v1.tokens });
      expect(garbageExpect.ok).toBe(false);
      expect(garbageExpect.checks.find((c) => c.id === 'intent.recipient')!.status).toBe('fail');
    });

    it('SHOULD-FIX: hashSource is "caller" (not "pinned") when opts.templates overrides the trust root, even without expectedBodyHash', () => {
      const overrideTable = SETTLE_TEMPLATES.map((t) => ({ ...t }));
      const r = inspectSettleProgram(v1.program, { templates: overrideTable });
      expect(r.hashSource).toBe('caller');
    });

    it('SHOULD-FIX: effects[] is empty for a structurally-rejected program (zero recipient), even though the body still parses', () => {
      const good = decodeSettleProgram(SETTLE_VECTORS[0]!.program).body;
      const zeroRecipient = ('0x14833589fcd6edb6e08f4c7c32d4f71b54bda02913' + '9401' + '0100' + '0100' + good.slice(2)) as Hex;
      const r = inspectSettleProgram(zeroRecipient);
      expect(r.checks.find((c) => c.id === 'shape.recipientNonZero')!.status).toBe('fail');
      expect(r.structurallyValid).toBe(false);
      expect(r.decoded).not.toBeNull(); // the body still parses — an operator can see what WOULD have run
      expect(r.effects.length).toBe(0); // but no behavioral claim is made about a structurally-rejected program
    });

    it('formatSettleReport renders every check id, token, and disclosure', () => {
      const r = verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: v1.tokens, minOut: v1.minOut });
      const text = formatSettleReport(r);
      for (const c of r.checks) expect(text).toContain(c.id);
      for (const t of v1.tokens) expect(text.toLowerCase()).toContain(t.toLowerCase());
      expect(text).toContain('FULL_BALANCE_SWEEP');
      expect(text).toContain('FLOOR_IS_LEVEL_NOT_DELTA');
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
