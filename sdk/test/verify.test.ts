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

    it('inspectSettleProgram on a genuine, authentic program is structurallyValid:true, authentic:true, but verdict:INTENT_UNCHECKED — inspect NEVER checks intent, so verdict can never claim it did', () => {
      const r = inspectSettleProgram(v1.program);
      // This IS the "cooked drain" shape: a well-formed, authentic (body-hash-matching) program —
      // inspect has no expectation to compare tokens/recipient against, so a bare `ok:true` (the
      // OLD, now-deleted shape) would have read as "safe to cook" for ANY choice of tokens/
      // recipient, including a hostile one. `verdict` names its own relativity instead.
      expect(r.verdict).toBe('INTENT_UNCHECKED');
      expect(r.intentReconciled).toBeNull();
      expect(r.intentSource).toBe('none');
      expect(r.declaredIntent).toBeNull();
      expect('ok' in r).toBe(false);
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
      // never omitted" contract) but PERMANENTLY unchecked+blocking, which is what forces
      // `intentReconciled:null`/`verdict:'INTENT_UNCHECKED'`.
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
      // effects[]/sweepScope.tokens are a BEHAVIORAL claim gated on structurallyValid && authentic,
      // NOT on verdict (a caller's absent expectation doesn't change what the program actually
      // does) — still renders.
      expect(r.effects.length).toBe(v1.tokens.length);
      expect(r.effects[0]!.amount).toBe('ENTIRE_POT_BALANCE');
      expect(r.sweepScope.unbounded).toBe(true);
      expect(r.sweepScope.basis).toBe('BALANCE_LEVEL');
      expect(r.sweepScope.tokens.length).toBe(v1.tokens.length);
      expect(r.sweepScope.tokens[0]!.token.toLowerCase()).toBe(v1.tokens[0]!.toLowerCase());
      expect(r.floorClaim.basis).toBe('BALANCE_LEVEL');
      expect(r.floorClaim.comparableToUnsplitFloor).toBe(false);
    });

    it('verifySettleProgram requires recipient at runtime even if the type system is bypassed', () => {
      // @ts-expect-error — recipient is required
      expect(() => verifySettleProgram(v1.program, {})).toThrow(TypeError);
    });

    it('verifySettleProgram: matching expectation is verdict:MATCHES_DECLARED_INTENT', () => {
      const r = verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: v1.tokens, minOut: v1.minOut });
      expect(r.verdict).toBe('MATCHES_DECLARED_INTENT');
      expect(r.intentReconciled).toBe(true);
      expect(r.intentSource).toBe('caller');
      expect(r.checks.find((c) => c.id === 'intent.recipient')!.status).toBe('pass');
      expect(r.checks.find((c) => c.id === 'intent.tokens')!.status).toBe('pass');
    });

    it('verifySettleProgram: wrong recipient is verdict:INTENT_MISMATCH with EXPECT_RECIPIENT', () => {
      const wrong = '0x000000000000000000000000000000000000dEaD' as Hex;
      const r = verifySettleProgram(v1.program, { recipient: wrong, tokens: v1.tokens });
      expect(r.verdict).toBe('INTENT_MISMATCH');
      expect(r.intentReconciled).toBe(false);
      expect(r.checks.find((c) => c.id === 'intent.recipient')!.status).toBe('fail');
    });

    it('verifySettleProgram: omitting tokens/allowTokens marks intent.tokens unchecked+blocking, forcing verdict:INTENT_UNCHECKED', () => {
      const r = verifySettleProgram(v1.program, { recipient: v1.recipient });
      const tokensCheck = r.checks.find((c) => c.id === 'intent.tokens')!;
      expect(tokensCheck.status).toBe('unchecked');
      expect(tokensCheck.severity).toBe('blocking');
      expect(r.verdict).toBe('INTENT_UNCHECKED');
      expect(r.intentReconciled).toBeNull();
    });

    it('a mutated body fails body.hash — verdict:NOT_OUR_TEMPLATE, templateId/templateVersion null — but keeps every other check present and decoded populated', () => {
      const d = decodeSettleProgram(v1.program);
      const bodyHexChars = d.bodySize * 2;
      const prologueHex = v1.program.slice(0, v1.program.length - bodyHexChars); // includes '0x'
      const mutatedBodyHex = '00' + d.body.slice(4); // flip the first body byte, same length
      const mutated = (prologueHex + mutatedBodyHex) as Hex;
      const r = inspectSettleProgram(mutated);
      expect(r.verdict).toBe('NOT_OUR_TEMPLATE');
      expect(r.authentic).toBe(false);
      expect(r.structurallyValid).toBe(true);
      // No table entry matches a forged body — templateId must be null, NEVER fall back to the
      // current template's id (that would misrepresent a NOT_OUR_TEMPLATE program as if it named
      // a real, if outdated, template).
      expect(r.templateId).toBeNull();
      expect(r.templateVersion).toBeNull();
      expect(r.failureCode).toBe('BODY_HASH');
      expect(r.decoded).not.toBeNull();
      expect(r.checks.find((c) => c.id === 'body.hash')!.status).toBe('fail');
      // every other shape check still ran and passed
      for (const id of ['shape.pushes', 'shape.canonical', 'shape.tuple', 'shape.arity', 'shape.recipientNonZero', 'body.size']) {
        expect(r.checks.find((c) => c.id === id)!.status).toBe('pass');
      }
      expect(r.effects.length).toBe(0); // unauthenticated — no behavioral claim
      expect(r.sweepScope.tokens.length).toBe(0);
    });

    it('BLOCKER 2 (order-free floor bypass) — allowTokens alone, with NO minOut expectation at all, still forfeits reconciliation for BOTH orderings because the DECODED PROGRAM carries the floor; expect.floorToken discriminates honest from attacker', () => {
      const v2 = SETTLE_VECTORS.find((v) => v.name.startsWith('v2'))!;
      const [honestFloor, honestOther] = v2.tokens; // [U, W] — U is genuinely tokens[0]
      const d = decodeSettleProgram(v2.program);
      // The attacker's program: SAME body/minOut/recipient, tokens REORDERED — the floor now sits
      // on what was the honest program's second (non-floor) token.
      const attackerProgram = encodeSettleProgram([honestOther, honestFloor], v2.minOut, v2.recipient, d.body);

      // NOTE: no `minOut`/`minMinOut` in this expectation at all — the caller never asked about
      // the floor. The OLD (caller-keyed) rule would have left intent.floorToken
      // unchecked+ADVISORY here (informational only), so BOTH orderings would have reconciled —
      // indistinguishable. The fix keys the forfeiture on the PROGRAM's own `decoded.minOut > 0n`
      // claim, so this bare `allowTokens` expectation still forfeits reconciliation.
      const looseExpect = { recipient: v2.recipient, allowTokens: v2.tokens };
      const honestLoose = verifySettleProgram(v2.program, looseExpect);
      const attackerLoose = verifySettleProgram(attackerProgram, looseExpect);
      expect(honestLoose.verdict).toBe('INTENT_UNCHECKED');
      expect(honestLoose.intentReconciled).toBeNull();
      expect(attackerLoose.verdict).toBe('INTENT_UNCHECKED');
      expect(attackerLoose.intentReconciled).toBeNull();
      expect(honestLoose.checks.find((c) => c.id === 'intent.floorToken')!.status).toBe('unchecked');
      expect(honestLoose.checks.find((c) => c.id === 'intent.floorToken')!.severity).toBe('blocking');

      // Pin the floor explicitly: now the honest program reconciles and the attacker's — whose
      // decoded.floorToken has genuinely moved — mismatches, on the SAME bare allowTokens.
      const pinnedExpect = { ...looseExpect, floorToken: honestFloor };
      const honestPinned = verifySettleProgram(v2.program, pinnedExpect);
      const attackerPinned = verifySettleProgram(attackerProgram, pinnedExpect);
      expect(honestPinned.verdict).toBe('MATCHES_DECLARED_INTENT');
      expect(honestPinned.intentReconciled).toBe(true);
      expect(attackerPinned.verdict).toBe('INTENT_MISMATCH');
      expect(attackerPinned.intentReconciled).toBe(false);
      expect(attackerPinned.checks.find((c) => c.id === 'intent.floorToken')!.status).toBe('fail');
      expect(attackerPinned.failureCode).toBe('EXPECT_FLOOR_TOKEN');

      // An exact (order-sensitive) `tokens` list already pins position 0 without floorToken.
      const exactExpect = { recipient: v2.recipient, tokens: v2.tokens };
      expect(verifySettleProgram(v2.program, exactExpect).verdict).toBe('MATCHES_DECLARED_INTENT');
      const exactAttacker = verifySettleProgram(attackerProgram, { recipient: v2.recipient, tokens: v2.tokens });
      expect(exactAttacker.verdict).toBe('INTENT_MISMATCH'); // intent.tokens itself catches the reordering
    });

    it('BLOCKER 5 — a malformed FIRST token push (single-token program) reports the SPECIFIC canonicality code, not NOT_SETTLE_SHAPED, and shape.pushes itself renders fail (never claims "all well-formed")', () => {
      const good = decodeSettleProgram(SETTLE_VECTORS[0]!.program).body; // v1's genuine 165-byte body
      // A single-token settle program whose ONLY token push is non-minimal (leading zero byte,
      // width 0x15 = 21 bytes) — the scan fails on the very FIRST push, before any push is
      // recorded, which is exactly the condition that used to misattribute the failure.
      const nonMinimalFirstPush = ('0x15' + '00' + '833589fcd6edb6e08f4c7c32d4f71b54bda02913' + '9401' + '0100' + '144200000000000000000000000000000000000006' + good.slice(2)) as Hex;

      const r = inspectSettleProgram(nonMinimalFirstPush);
      expect(r.failureCode).toBe('NON_MINIMAL_PUSH');
      const pushesCheck = r.checks.find((c) => c.id === 'shape.pushes')!;
      expect(pushesCheck.status).toBe('fail');
      expect(pushesCheck.actual).not.toMatch(/all well-formed/);
      expect(r.checks.find((c) => c.id === 'shape.canonical')!.status).toBe('fail'); // NOT 'unchecked'
      expect(r.structurallyValid).toBe(false);
      expect(r.verdict).toBe('MALFORMED');
    });

    describe('never throws on a garbage runtime value bypassing the type system', () => {
      it('a non-string program', () => {
        expect(() => inspectSettleProgram(12345 as unknown as Hex)).not.toThrow();
        const garbageProgram = inspectSettleProgram(12345 as unknown as Hex);
        expect(garbageProgram.verdict).toBe('MALFORMED');
      });

      it('a garbage (non-hex, non-bigint) expect.recipient', () => {
        expect(() => verifySettleProgram(v1.program, { recipient: 'not-an-address' as unknown as Hex, tokens: v1.tokens })).not.toThrow();
        const garbageExpect = verifySettleProgram(v1.program, { recipient: 'not-an-address' as unknown as Hex, tokens: v1.tokens });
        expect(garbageExpect.verdict).toBe('INTENT_MISMATCH');
        expect(garbageExpect.checks.find((c) => c.id === 'intent.recipient')!.status).toBe('fail');
      });

      it('a garbage (non-address) element inside a well-formed expect.tokens array', () => {
        expect(() => verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: ['also-not-an-address'] as unknown as Hex[] })).not.toThrow();
      });

      it('expect.tokens as a bare address (not an array)', () => {
        expect(() => verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: v1.recipient as unknown as Hex[] })).not.toThrow();
        const r = verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: v1.recipient as unknown as Hex[] });
        expect(['INTENT_MISMATCH', 'MALFORMED']).toContain(r.verdict);
        expect(r.checks.find((c) => c.id === 'intent.tokens')!.status).toBe('fail');
      });

      it('expect.allowTokens as a bare address (not an array)', () => {
        expect(() => verifySettleProgram(v1.program, { recipient: v1.recipient, allowTokens: v1.recipient as unknown as Hex[] })).not.toThrow();
        const r = verifySettleProgram(v1.program, { recipient: v1.recipient, allowTokens: v1.recipient as unknown as Hex[] });
        expect(['INTENT_MISMATCH', 'MALFORMED']).toContain(r.verdict);
        expect(r.checks.find((c) => c.id === 'intent.tokens')!.status).toBe('fail');
      });

      it('opts.expectedBodyHash as a non-string', () => {
        expect(() => inspectSettleProgram(v1.program, { expectedBodyHash: 12345 as unknown as Hex })).not.toThrow();
        const r = inspectSettleProgram(v1.program, { expectedBodyHash: 12345 as unknown as Hex });
        expect(['MATCHES_DECLARED_INTENT', 'INTENT_UNCHECKED', 'NOT_OUR_TEMPLATE', 'MALFORMED']).toContain(r.verdict);
      });

      it('opts.serverEchoBodyHash as a non-string', () => {
        expect(() => inspectSettleProgram(v1.program, { serverEchoBodyHash: 12345 as unknown as Hex })).not.toThrow();
        const r = inspectSettleProgram(v1.program, { serverEchoBodyHash: 12345 as unknown as Hex });
        expect(r.checks.find((c) => c.id === 'serverEcho.bodyHash')!.status).toBe('unchecked');
      });

      it('opts.templates as a non-array', () => {
        expect(() => inspectSettleProgram(v1.program, { templates: { not: 'an array' } as unknown as never })).not.toThrow();
        const r = inspectSettleProgram(v1.program, { templates: { not: 'an array' } as unknown as never });
        expect(r.hashSource).toBe('pinned'); // falls back to the pinned table, honestly labeled
      });
    });

    it('hashSource is "caller" (not "pinned") when opts.templates overrides the trust root, even without expectedBodyHash', () => {
      const overrideTable = SETTLE_TEMPLATES.map((t) => ({ ...t }));
      const r = inspectSettleProgram(v1.program, { templates: overrideTable });
      expect(r.hashSource).toBe('caller');
    });

    it('effects[]/sweepScope.tokens are empty for a structurally-rejected program (zero recipient), even though the body still parses', () => {
      const good = decodeSettleProgram(SETTLE_VECTORS[0]!.program).body;
      const zeroRecipient = ('0x14833589fcd6edb6e08f4c7c32d4f71b54bda02913' + '9401' + '0100' + '0100' + good.slice(2)) as Hex;
      const r = inspectSettleProgram(zeroRecipient);
      expect(r.checks.find((c) => c.id === 'shape.recipientNonZero')!.status).toBe('fail');
      expect(r.structurallyValid).toBe(false);
      expect(r.verdict).toBe('MALFORMED');
      expect(r.decoded).not.toBeNull(); // the body still parses — an operator can see what WOULD have run
      expect(r.effects.length).toBe(0); // but no behavioral claim is made about a structurally-rejected program
      expect(r.sweepScope.tokens.length).toBe(0);
    });

    it('formatSettleReport renders every check id, token, and disclosure, and never mentions a bare "ok="', () => {
      const r = verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: v1.tokens, minOut: v1.minOut });
      const text = formatSettleReport(r);
      for (const c of r.checks) expect(text).toContain(c.id);
      for (const t of v1.tokens) expect(text.toLowerCase()).toContain(t.toLowerCase());
      expect(text).toContain('FULL_BALANCE_SWEEP');
      expect(text).toContain('FLOOR_IS_LEVEL_NOT_DELTA');
      expect(text).toContain('verdict=');
      expect(text).not.toMatch(/\bok=/);
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
