import {
  decodeSettleProgram,
  encodeSettleProgram,
  parseSettleProgram,
  SettleDecodeError,
  SETTLE_VECTORS,
  SETTLE_TEMPLATES,
  CURRENT_SETTLE_TEMPLATE,
  SETTLE_WIRE,
  inspectSettleProgram,
  verifySettleProgram,
  formatSettleReport,
  type SettleExpectation,
  type VerifyOpts,
} from '../src/verify/index';
import { authenticateBodyAgainstRoot } from '../src/verify/internal/root-testing';
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
      expect(r.hashSource).toBe('pinned');
      expect(r.rederivation).toBe('absent');
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
          'producer.rederivedBodyHash',
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
      expect(recip.kind).toBe('intent');
      const tokens = r.checks.find((c) => c.id === 'intent.tokens')!;
      expect(tokens.status).toBe('unchecked');
      expect(tokens.severity).toBe('blocking');
      // BLOCKER 3: intent.floorToken must NEVER manufacture a 'pass' just because `decoded` is
      // non-null — it is 'unchecked' unless an expectation (expect.floorToken) was actually
      // supplied, exactly like every other check.
      const floorToken = r.checks.find((c) => c.id === 'intent.floorToken')!;
      expect(floorToken.status).toBe('unchecked');
      const bodyHashCheck = r.checks.find((c) => c.id === 'body.hash')!;
      expect(bodyHashCheck.kind).toBe('authenticity');
      const shapeCheck = r.checks.find((c) => c.id === 'shape.pushes')!;
      expect(shapeCheck.kind).toBe('shape');
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

    it('inspectSettleProgram(program, {declaredIntent}) is a PURE ECHO — populates declaredIntent but stays intentSource:none/verdict:INTENT_UNCHECKED, exactly as if omitted', () => {
      const echoedIntent: SettleExpectation = { recipient: v1.recipient, tokens: v1.tokens, minOut: v1.minOut };
      const r = inspectSettleProgram(v1.program, { declaredIntent: echoedIntent });
      expect(r.declaredIntent).toEqual(echoedIntent);
      expect(r.intentSource).toBe('none');
      expect(r.intentReconciled).toBeNull();
      expect(r.verdict).toBe('INTENT_UNCHECKED');
      // Identical to the no-opts case in every OTHER respect — the echo changes nothing else.
      const bare = inspectSettleProgram(v1.program);
      expect(r.authentic).toBe(bare.authentic);
      expect(r.structurallyValid).toBe(bare.structurallyValid);
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

      // Pin the floor explicitly: the attacker's — whose decoded.floorToken has genuinely moved —
      // still mismatches on the SAME bare allowTokens. The honest program's floorToken now DOES
      // reconcile, but the overall verdict stays capped at INTENT_UNCHECKED (not the affirmative
      // MATCHES_DECLARED_INTENT) — see the R1 fix (allowTokens containment test, below): pinning
      // `floorToken` proves WHICH token holds the floor, but says nothing about whether every
      // OTHER token in the bare `allowTokens` set was actually swept, so containment alone is
      // still not eligible for the affirmative verdict even once the floor identity is pinned.
      const pinnedExpect = { ...looseExpect, floorToken: honestFloor };
      const honestPinned = verifySettleProgram(v2.program, pinnedExpect);
      const attackerPinned = verifySettleProgram(attackerProgram, pinnedExpect);
      expect(honestPinned.checks.find((c) => c.id === 'intent.floorToken')!.status).toBe('pass');
      expect(honestPinned.verdict).toBe('INTENT_UNCHECKED');
      expect(honestPinned.intentReconciled).toBeNull();
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

      it('opts.rederivedBodyHash as a non-string', () => {
        expect(() => inspectSettleProgram(v1.program, { rederivedBodyHash: 12345 as unknown as Hex })).not.toThrow();
        const r = inspectSettleProgram(v1.program, { rederivedBodyHash: 12345 as unknown as Hex });
        expect(r.rederivation).toBe('absent'); // non-string is treated as "not supplied"
        expect(r.authentic).toBe(true); // never regresses the genuine program's own authenticity
      });

      it('opts.serverEchoBodyHash as a non-string', () => {
        expect(() => inspectSettleProgram(v1.program, { serverEchoBodyHash: 12345 as unknown as Hex })).not.toThrow();
        const r = inspectSettleProgram(v1.program, { serverEchoBodyHash: 12345 as unknown as Hex });
        expect(r.checks.find((c) => c.id === 'serverEcho.bodyHash')!.status).toBe('unchecked');
      });

      it('opts.declaredIntent as garbage (a bare string, bypassing the type system) never throws — a pure echo, whatever its shape', () => {
        expect(() => inspectSettleProgram(v1.program, { declaredIntent: 'not-an-expectation' as unknown as SettleExpectation })).not.toThrow();
        const r = inspectSettleProgram(v1.program, { declaredIntent: 'not-an-expectation' as unknown as SettleExpectation });
        expect(r.intentSource).toBe('none');
        expect(r.verdict).toBe('INTENT_UNCHECKED');
      });

      it('a caller passing the OLD, deleted opts keys (templates/expectedBodyHash/hashSourceLabel) at runtime, bypassing the type system entirely — they must be COMPLETELY INERT, not merely rejected', () => {
        const legacyOpts = {
          templates: [{ id: 'ecoswap-settle', version: 'forged', bodyHash: CURRENT_SETTLE_TEMPLATE.bodyHash, bodySize: 165, compilerSha: 'x', status: 'current', since: '2026', notes: 'x' }],
          expectedBodyHash: CURRENT_SETTLE_TEMPLATE.bodyHash,
          hashSourceLabel: 'rederived',
        } as unknown as VerifyOpts;
        const withLegacy = inspectSettleProgram(v1.program, legacyOpts);
        const bare = inspectSettleProgram(v1.program);
        // Identical in every respect — the legacy keys are read nowhere anymore.
        expect(withLegacy.authentic).toBe(bare.authentic);
        expect(withLegacy.verdict).toBe(bare.verdict);
        expect(withLegacy.hashSource).toBe(bare.hashSource);
        expect(withLegacy.templateId).toBe(bare.templateId);
      });
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
      expect(text).toContain('rederivation=');
      expect(text).not.toMatch(/\bok=/);
    });
  });

  describe('R1, R3 fixes — the second adversarial pass (R2 — the expectedBodyHash self-referential-hash escape — is SUPERSEDED: that opt no longer exists at all, see the TRUST MODEL FIX suite\'s T1/T3 below for its replacement coverage)', () => {
    const v1 = SETTLE_VECTORS[0]!; // tokens=[U], minOut=0n, recipient=W
    const v2 = SETTLE_VECTORS.find((v) => v.name.startsWith('v2'))!; // tokens=[U, W]

    // R1: allowTokens CONTAINMENT proves the decoded set is a SUBSET of what's allowed — it
    // never proves the decoded set is what the caller actually wanted. A decoded program that
    // sweeps only ONE of the two allowed tokens (stranding the other's real balance in the Pot,
    // undelivered to the recipient) still passes containment, and used to reconcile to
    // MATCHES_DECLARED_INTENT for it — the affirmative verdict a partner gates a cook on.
    it('R1 — allowTokens containment must NEVER by itself yield verdict:MATCHES_DECLARED_INTENT, even though the subset relation genuinely holds', () => {
      // v1 decodes to tokens=[U] ONLY — W is never swept by this program at all. A partner who
      // declared allowTokens:[U, W] (expecting the recipient could receive either) gets a program
      // that silently never moves W — but W sat in the SAME allowed set, so naive containment
      // reads this as a full match.
      const r = verifySettleProgram(v1.program, { recipient: v1.recipient, allowTokens: [v1.tokens[0]!, v2.tokens[1]!] });
      expect(r.checks.find((c) => c.id === 'intent.tokens')!.status).not.toBe('fail'); // the subset relation IS satisfied
      expect(r.verdict).not.toBe('MATCHES_DECLARED_INTENT');
      expect(r.intentReconciled).not.toBe(true);
      // An exact `tokens` list, by contrast, DOES remain eligible for the affirmative verdict.
      const exact = verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: v1.tokens });
      expect(exact.verdict).toBe('MATCHES_DECLARED_INTENT');
      // A genuine violation (a token truly outside the allowed set) must still fail, exactly as
      // before — this fix narrows the AFFIRMATIVE case only, it does not weaken detection.
      const violated = verifySettleProgram(v1.program, { recipient: v1.recipient, allowTokens: [v2.tokens[1]!] });
      expect(violated.checks.find((c) => c.id === 'intent.tokens')!.status).toBe('fail');
      expect(violated.verdict).toBe('INTENT_MISMATCH');
    });

    // R3: `verifySettleProgram`'s own null-`opts` guard lives in `buildBase` — but this function
    // reads `opts.intentSourceLabel` ITSELF, outside that guard, so an explicit `null` (a runtime
    // caller bypassing the type system, exactly the scenario this same commit's guard elsewhere
    // anticipates) throws a bare TypeError from a function documented "never throws".
    it('R3 — verifySettleProgram(program, expect, null) must not throw', () => {
      expect(() => verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: v1.tokens }, null as unknown as undefined)).not.toThrow();
      const r = verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: v1.tokens }, null as unknown as undefined);
      expect(r.intentSource).toBe('caller');
      expect(r.verdict).toBe('MATCHES_DECLARED_INTENT');
    });
  });

  describe('opts.rederivedBodyHash — the producer cross-check that REPLACES the deleted expectedBodyHash/hashSourceLabel escape', () => {
    const v1 = SETTLE_VECTORS[0]!;

    it('a genuine rederived hash (actually recompiled from the audited template) agrees and changes nothing about authenticity — the LEGITIMATE producer case this fix must not regress', () => {
      const r = inspectSettleProgram(v1.program, { rederivedBodyHash: CURRENT_SETTLE_TEMPLATE.bodyHash });
      expect(r.rederivation).toBe('agrees');
      expect(r.authentic).toBe(true);
      expect(r.templateId).not.toBeNull();
      expect(r.hashSource).toBe('pinned'); // NEVER 'rederived' — that HashSource member is deleted
      expect(r.checks.find((c) => c.id === 'producer.rederivedBodyHash')!.status).toBe('pass');
    });

    it('THE FORMER ROUTE 1 EXPLOIT, restated against the new field: a caller who controls both a forged body and rederivedBodyHash cannot self-authenticate — rederivedBodyHash can only ever narrow authentic toward false, never establish it', () => {
      const goodBody = decodeSettleProgram(v1.program).body;
      const bodyHexChars = 165 * 2;
      const prologueHex = v1.program.slice(0, v1.program.length - bodyHexChars);
      const forgedBodyHex = '00' + goodBody.slice(4);
      const forged = (prologueHex + forgedBodyHex) as Hex;
      const forgedHash = decodeSettleProgram(forged).bodyHash;
      const ATTACKER = '0x000000000000000000000000000000000000dEaD' as Hex;
      const VICTIM = v1.tokens[0]!;

      // The self-referential hash AGREES with the forged body (it's the same bytes) — but that
      // agreement can never establish authenticity: authenticateBody already rejected this body
      // against SETTLE_TEMPLATES, and rederivedBodyHash is compared against the PROGRAM (R vs P),
      // never against the table.
      const r = verifySettleProgram(forged, { recipient: ATTACKER, tokens: [VICTIM] }, { rederivedBodyHash: forgedHash });
      expect(r.rederivation).toBe('agrees'); // agrees with itself, as expected — and still doesn't help
      expect(r.authentic).toBe(false);
      expect(r.templateId).toBeNull();
      expect(r.verdict).toBe('NOT_OUR_TEMPLATE');
      expect(r.sweepScope.tokens.length).toBe(0);
      expect(r.effects.length).toBe(0);
    });

    it('a DIVERGENT rederivedBodyHash forces authentic:false with failureCode PRODUCER_HASH_DIVERGED, even against a genuinely authentic body — a producer whose own recompile disagrees with what it is reporting on is telling the report something is wrong with ITSELF', () => {
      const r = inspectSettleProgram(v1.program, { rederivedBodyHash: '0x' + 'ab'.repeat(32) as Hex });
      expect(r.rederivation).toBe('disagrees');
      expect(r.authentic).toBe(false);
      expect(r.verdict).toBe('NOT_OUR_TEMPLATE');
      expect(r.failureCode).toBe('PRODUCER_HASH_DIVERGED');
      expect(r.checks.find((c) => c.id === 'producer.rederivedBodyHash')!.status).toBe('fail');
      // body.hash itself still reads 'pass' — the table genuinely matched; this distinguishes
      // "the pinned table rejected this body" (body.hash fails) from "the producer's own compile
      // disagrees with what it's reporting on" (producer.rederivedBodyHash fails, body.hash pass).
      expect(r.checks.find((c) => c.id === 'body.hash')!.status).toBe('pass');
    });

    it('rederivedBodyHash is absent by default — rederivation:"absent", and the producer.rederivedBodyHash check renders unchecked+advisory (never manufactures a failure out of silence)', () => {
      const r = inspectSettleProgram(v1.program);
      expect(r.rederivation).toBe('absent');
      const check = r.checks.find((c) => c.id === 'producer.rederivedBodyHash')!;
      expect(check.status).toBe('unchecked');
      expect(check.severity).toBe('advisory');
    });
  });

  describe('B2 — every gateable field must be false-or-null whenever verdict is not affirmative (the "ok" defect recurring one field over)', () => {
    const v1 = SETTLE_VECTORS[0]!;
    const goodBody = decodeSettleProgram(v1.program).body;

    function nonAffirmativeCases(): Array<{ label: string; report: ReturnType<typeof verifySettleProgram> | ReturnType<typeof inspectSettleProgram>; expectVerdict: string }> {
      // MALFORMED: body truncated to 100 bytes (not 165) — prologue (tokens/minOut/recipient)
      // still decodes cleanly and matches the expectation below, so an intent computation that
      // is not gated by verdict would read intentReconciled:true even though structurallyValid
      // is false.
      const shortBody = ('0x' + 'ab'.repeat(100)) as Hex;
      const malformedProgram = encodeSettleProgram(v1.tokens, v1.minOut, v1.recipient, shortBody);
      const malformed = verifySettleProgram(malformedProgram, { recipient: v1.recipient, tokens: v1.tokens });

      // NOT_OUR_TEMPLATE: a forged (but 165-byte, structurally valid) body — same prologue as v1,
      // so the SAME expectation would again spuriously "match" if computed independently of
      // authenticity.
      const bodyHexChars = 165 * 2;
      const prologueHex = v1.program.slice(0, v1.program.length - bodyHexChars);
      const forgedBodyHex = '00' + goodBody.slice(4);
      const forgedProgram = (prologueHex + forgedBodyHex) as Hex;
      const notOurTemplate = verifySettleProgram(forgedProgram, { recipient: v1.recipient, tokens: v1.tokens });

      const intentMismatch = verifySettleProgram(v1.program, { recipient: '0x000000000000000000000000000000000000dEaD' as Hex, tokens: v1.tokens });
      const intentUnchecked = inspectSettleProgram(v1.program);

      return [
        { label: 'MALFORMED', report: malformed, expectVerdict: 'MALFORMED' },
        { label: 'NOT_OUR_TEMPLATE', report: notOurTemplate, expectVerdict: 'NOT_OUR_TEMPLATE' },
        { label: 'INTENT_MISMATCH', report: intentMismatch, expectVerdict: 'INTENT_MISMATCH' },
        { label: 'INTENT_UNCHECKED', report: intentUnchecked, expectVerdict: 'INTENT_UNCHECKED' },
      ];
    }

    it('sets up each of the four non-affirmative verdicts correctly (fixture sanity)', () => {
      for (const { report, expectVerdict } of nonAffirmativeCases()) {
        expect(report.verdict).toBe(expectVerdict);
      }
    });

    it('intentReconciled is NEVER true for any non-affirmative verdict, even when the underlying intent checks would independently "match"', () => {
      for (const { label, report } of nonAffirmativeCases()) {
        expect(report.intentReconciled === true ? label : report.intentReconciled).not.toBe(label);
      }
    });

    // Enumerated invariant: every gateable field's value must be EXACTLY what its own verdict
    // permits — never merely "not obviously wrong". This is written so a NEW field added to the
    // envelope in the future that fails to consult `verdict` is caught by extending the ONE
    // per-verdict expectation table below, not by writing a new ad-hoc test. EXTENDED (not
    // flattened) with `hashSource`/`rederivation`, which every one of these four fixtures shares
    // regardless of verdict — proving they are orthogonal facts, not verdict-derived ones.
    const EXPECTED_BY_VERDICT: Record<string, { structurallyValid: boolean; authentic: boolean | null; intentReconciled: boolean | null; hashSource: string; rederivation: string }> = {
      MALFORMED: { structurallyValid: false, authentic: null /* not constrained by verdict */, intentReconciled: null, hashSource: 'pinned', rederivation: 'absent' },
      NOT_OUR_TEMPLATE: { structurallyValid: true, authentic: false, intentReconciled: null, hashSource: 'pinned', rederivation: 'absent' },
      INTENT_MISMATCH: { structurallyValid: true, authentic: true, intentReconciled: false, hashSource: 'pinned', rederivation: 'absent' },
      INTENT_UNCHECKED: { structurallyValid: true, authentic: true, intentReconciled: null, hashSource: 'pinned', rederivation: 'absent' },
    };

    it('enumerated per-field invariant over every gateable boolean/nullable field, across all four non-affirmative verdicts', () => {
      for (const { label, report } of nonAffirmativeCases()) {
        const expected = EXPECTED_BY_VERDICT[label]!;
        expect(report.structurallyValid).toBe(expected.structurallyValid);
        if (expected.authentic !== null) expect(report.authentic).toBe(expected.authentic);
        expect(report.intentReconciled).toBe(expected.intentReconciled);
        expect(report.hashSource).toBe(expected.hashSource);
        expect(report.rederivation).toBe(expected.rederivation);
        // effects[]/sweepScope stay empty whenever the program is not both structurally valid AND
        // authentic — the ONE place a behavioral claim is allowed to render regardless of intent.
        if (!(report.structurallyValid && report.authentic)) {
          expect(report.effects.length).toBe(0);
          expect(report.sweepScope.tokens.length).toBe(0);
        }
      }
    });
  });

  describe('B3 — never-throws must hold on CONTAINER ELEMENTS, not just the container array', () => {
    it('formatSettleReport(null) never throws', () => {
      expect(() => formatSettleReport(null as unknown as ReturnType<typeof inspectSettleProgram>)).not.toThrow();
    });

    it('formatSettleReport({}) never throws', () => {
      expect(() => formatSettleReport({} as unknown as ReturnType<typeof inspectSettleProgram>)).not.toThrow();
    });

    it('formatSettleReport(undefined) never throws', () => {
      expect(() => formatSettleReport(undefined as unknown as ReturnType<typeof inspectSettleProgram>)).not.toThrow();
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

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // TRUST MODEL FIX — root cause: `authentic` used to be derived from a CALLER-CONTROLLED table
  // (`opts.templates ?? SETTLE_TEMPLATES`). Fix: `authentic` is now establishable ONLY against
  // `SETTLE_TEMPLATES` (`internal/root-testing.ts`'s `authenticateBodyAgainstRoot`, always called
  // with that constant as `root` — see `report.ts`'s `authenticateBody`) — there is no parameter
  // anywhere on the public surface through which a caller can reach that table. T1–T8 below are
  // the acceptance tests for that fix, each shown red by re-injecting its own defect in a comment.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  describe('TRUST MODEL FIX', () => {
    const v1 = SETTLE_VECTORS[0]!;
    const goodBody = decodeSettleProgram(v1.program).body;
    const bodyHexChars = 165 * 2;
    const prologueHex = v1.program.slice(0, v1.program.length - bodyHexChars);
    const forgedBodyHex = '00' + goodBody.slice(4); // flip one byte — matches no table entry
    const forged = (prologueHex + forgedBodyHex) as Hex;
    const forgedHash = decodeSettleProgram(forged).bodyHash;
    const ATTACKER = '0x000000000000000000000000000000000000dEaD' as Hex;
    const VICTIM = v1.tokens[0]!;
    const forgedTableEntry = { id: 'ecoswap-settle', version: 'forged', bodyHash: forgedHash, bodySize: 165, compilerSha: 'forged', status: 'current' as const, since: '2026', notes: 'forged' };

    // T1 — the opts-route matrix against the forged body, BOTH entry points. Every route is
    // constructed the way a real caller (or a legacy caller bypassing the type system with `as
    // any`, exactly what a caller who never recompiled against the new types could still attempt
    // at runtime) would reach it. Every cell must be non-affirmative. This is the mechanical fix
    // for the coverage defect too: unlike the old suite (which asserted the templates-override
    // route benign via `inspectSettleProgram` ONLY — an entry point structurally incapable of an
    // affirmative verdict, so it could never have observed the affirmative it blessed), every
    // route here runs through BOTH `inspectSettleProgram` and `verifySettleProgram`.
    const ROUTES: Array<{ label: string; opts: VerifyOpts }> = [
      { label: 'no opts', opts: {} },
      { label: 'templates: [forged same-hash, well-formed entry]', opts: { templates: [forgedTableEntry] } as unknown as VerifyOpts },
      { label: 'templates: [forged entry], acceptSuperseded:false', opts: { templates: [forgedTableEntry], acceptSuperseded: false } as unknown as VerifyOpts },
      { label: "expectedBodyHash: forgedHash (default label 'caller')", opts: { expectedBodyHash: forgedHash } as unknown as VerifyOpts },
      { label: "expectedBodyHash: forgedHash, hashSourceLabel:'caller'", opts: { expectedBodyHash: forgedHash, hashSourceLabel: 'caller' } as unknown as VerifyOpts },
      { label: "expectedBodyHash: forgedHash, hashSourceLabel:'rederived' — THE ORIGINAL ROUTE 1", opts: { expectedBodyHash: forgedHash, hashSourceLabel: 'rederived' } as unknown as VerifyOpts },
      { label: "expectedBodyHash: forgedHash, hashSourceLabel:'REDERIVED' (mis-cased label)", opts: { expectedBodyHash: forgedHash, hashSourceLabel: 'REDERIVED' } as unknown as VerifyOpts },
      { label: 'templates:[{bodyHash:forgedHash}] — no id/version/status at all — THE ORIGINAL ROUTE 2', opts: { templates: [{ bodyHash: forgedHash }] } as unknown as VerifyOpts },
      { label: "templates:[{...,status:'REVOKED'}] — case-sensitivity escape", opts: { templates: [{ ...forgedTableEntry, status: 'REVOKED' }] } as unknown as VerifyOpts },
      { label: "templates:[{...,status:'revoked'}]", opts: { templates: [{ ...forgedTableEntry, status: 'revoked' }] } as unknown as VerifyOpts },
      { label: 'templates:[{...,status:undefined}]', opts: { templates: [{ ...forgedTableEntry, status: undefined }] } as unknown as VerifyOpts },
      { label: "templates:[{...,status:'bogus'}]", opts: { templates: [{ ...forgedTableEntry, status: 'bogus' }] } as unknown as VerifyOpts },
      { label: 'templates + expectedBodyHash BOTH forged-consistent, acceptSuperseded:true', opts: { templates: [forgedTableEntry], expectedBodyHash: forgedHash, hashSourceLabel: 'rederived', acceptSuperseded: true } as unknown as VerifyOpts },
      { label: 'templates: [] (empty override table)', opts: { templates: [] } as unknown as VerifyOpts },
      { label: 'rederivedBodyHash: forgedHash (agrees with itself — the ONE real replacement field)', opts: { rederivedBodyHash: forgedHash } },
      { label: 'serverEchoBodyHash: forgedHash', opts: { serverEchoBodyHash: forgedHash } },
      { label: 'acceptSuperseded: true (alone, no table/hash override)', opts: { acceptSuperseded: true } },
      { label: 'acceptSuperseded: false (alone)', opts: { acceptSuperseded: false } },
      { label: "intentSourceLabel: 'server-echo' (verify only — inert here since the body itself never authenticates)", opts: { intentSourceLabel: 'server-echo' } },
      { label: 'declaredIntent echo (inspect only)', opts: { declaredIntent: { recipient: ATTACKER, tokens: [VICTIM] } } },
    ];

    it(`T1 — enumerates ${ROUTES.length} routes (${ROUTES.length * 2} cells across both entry points) against the forged body: EVERY cell is non-affirmative`, () => {
      let inspectCells = 0;
      let verifyCells = 0;
      for (const route of ROUTES) {
        const insp = inspectSettleProgram(forged, route.opts);
        inspectCells++;
        expect(insp.verdict).toBe('NOT_OUR_TEMPLATE');
        expect(insp.authentic).toBe(false);
        expect(insp.templateId).toBeNull();
        expect(insp.templateVersion).toBeNull();
        expect(insp.sweepScope.tokens.length).toBe(0);
        expect(insp.effects.length).toBe(0);
        expect(insp.checks.find((c) => c.id === 'body.hash')!.status).toBe('fail');
        expect(insp.verdict).not.toBe('MATCHES_DECLARED_INTENT');

        const ver = verifySettleProgram(forged, { recipient: ATTACKER, tokens: [VICTIM] }, route.opts);
        verifyCells++;
        expect(ver.verdict).toBe('NOT_OUR_TEMPLATE');
        expect(ver.authentic).toBe(false);
        expect(ver.templateId).toBeNull();
        expect(ver.templateVersion).toBeNull();
        expect(ver.sweepScope.tokens.length).toBe(0);
        expect(ver.effects.length).toBe(0);
        expect(ver.verdict).not.toBe('MATCHES_DECLARED_INTENT');
      }
      // Coverage cannot silently shrink — pin the actual count of cells this test ran.
      expect(inspectCells).toBe(ROUTES.length);
      expect(verifyCells).toBe(ROUTES.length);
      expect(ROUTES.length).toBeGreaterThanOrEqual(19);
    });

    // T2 — MONOTONICITY: no opts key may turn `authentic` false→true, or a non-affirmative
    // `verdict` affirmative, relative to the no-opts baseline, on either program.
    it('T2 — every route in the T1 matrix is monotone-restricting on BOTH a genuine and a forged program, both entry points', () => {
      for (const program of [v1.program, forged]) {
        const baseInsp = inspectSettleProgram(program);
        const baseVer = verifySettleProgram(program, { recipient: v1.recipient, tokens: v1.tokens });
        for (const route of ROUTES) {
          const insp = inspectSettleProgram(program, route.opts);
          if (insp.authentic) expect(baseInsp.authentic).toBe(true);
          if (insp.verdict === 'MATCHES_DECLARED_INTENT') expect(baseInsp.verdict).toBe('MATCHES_DECLARED_INTENT');

          const ver = verifySettleProgram(program, { recipient: v1.recipient, tokens: v1.tokens }, route.opts);
          if (ver.authentic) expect(baseVer.authentic).toBe(true);
          if (ver.verdict === 'MATCHES_DECLARED_INTENT') expect(baseVer.verdict).toBe('MATCHES_DECLARED_INTENT');
        }
      }
    });

    // T3 — the surface cannot quietly return: runtime AND compile-time.
    describe('T3 — the surface cannot quietly return', () => {
      it('hashSource is always one of the two closed values, across every T1 cell', () => {
        for (const route of ROUTES) {
          const insp = inspectSettleProgram(forged, route.opts);
          expect(['pinned', 'none']).toContain(insp.hashSource);
        }
      });

      it('COMPILE-TIME GUARD: the deleted opts keys are rejected by the type system — if this test file fails to compile, the escape has been reintroduced', () => {
        // @ts-expect-error — `templates` no longer exists on VerifyOpts
        const _r1: VerifyOpts = { templates: [] };
        // @ts-expect-error — `expectedBodyHash` no longer exists on VerifyOpts
        const _r2: VerifyOpts = { expectedBodyHash: forgedHash };
        // @ts-expect-error — `hashSourceLabel` no longer exists on VerifyOpts
        const _r3: VerifyOpts = { hashSourceLabel: 'rederived' };
        expect([_r1, _r2, _r3].length).toBe(3); // silence unused-var lint; the assertions above are the test
      });
    });

    // T4 — the authentic ⟹ templateId≠null contradiction is impossible, even through the
    // internal test-only root hook (which CAN inject a malformed entry — the public surface never
    // can, by construction: `SETTLE_TEMPLATES` is well-formed).
    describe('T4 — the authentic⇒templateId contradiction is impossible', () => {
      it('every T1 cell: authentic ⟹ templateId !== null && templateVersion !== null (vacuously true here since every cell is non-affirmative — see T1)', () => {
        for (const route of ROUTES) {
          const insp = inspectSettleProgram(forged, route.opts);
          if (insp.authentic) {
            expect(insp.templateId).not.toBeNull();
            expect(insp.templateVersion).not.toBeNull();
          }
        }
      });

      it('a genuine, authentic program: authentic⟹templateId!==null holds affirmatively (not just vacuously)', () => {
        const r = inspectSettleProgram(v1.program);
        expect(r.authentic).toBe(true);
        expect(r.templateId).not.toBeNull();
        expect(r.templateVersion).not.toBeNull();
      });

      it('DIRECT UNIT on the fail-closed guard: a root row whose bodyHash matches but whose id is absent must NOT authenticate — code INTERNAL_INCONSISTENT', () => {
        const malformedRoot = [{ bodyHash: CURRENT_SETTLE_TEMPLATE.bodyHash, status: 'current' } as any];
        const result = authenticateBodyAgainstRoot(CURRENT_SETTLE_TEMPLATE.bodyHash, true, malformedRoot);
        expect(result.authentic).toBe(false);
        expect(result.code).toBe('INTERNAL_INCONSISTENT');
        expect(result.entry).not.toBeNull(); // the row WAS matched — entry is populated even though authentic is false
      });

      it('re-injecting the defect (a hook that skips the id guard) would fail this test — sanity: a well-formed root row DOES authenticate', () => {
        const wellFormedRoot = [{ id: 'x', version: '1', bodyHash: CURRENT_SETTLE_TEMPLATE.bodyHash, bodySize: 165, compilerSha: 'x', status: 'current' as const, since: '2026', notes: '' }];
        const result = authenticateBodyAgainstRoot(CURRENT_SETTLE_TEMPLATE.bodyHash, true, wellFormedRoot);
        expect(result.authentic).toBe(true);
        expect(result.code).toBeUndefined();
      });

      // B3, carried forward: `matchInRoot` (internal/root-testing.ts) guards CONTAINER ELEMENTS,
      // not just the container array — a garbage element must never throw, only never match. The
      // container itself is guarded by the caller (Array.isArray) in the original B3 fix; this is
      // its direct analogue against the new root-parameterized function.
      it('B3 (carried forward): a root array containing garbage elements never throws, and none of them match', () => {
        const garbageElements = [null, undefined, {}, { bodyHash: 1 }, { bodyHash: null }] as unknown as Array<{ bodyHash: string }>;
        for (const el of garbageElements) {
          expect(() => authenticateBodyAgainstRoot(CURRENT_SETTLE_TEMPLATE.bodyHash, true, [el] as any)).not.toThrow();
          const result = authenticateBodyAgainstRoot(CURRENT_SETTLE_TEMPLATE.bodyHash, true, [el] as any);
          expect(result.authentic).toBe(false);
          expect(result.entry).toBeNull();
        }
      });
    });

    // T5 — the status ALLOW-LIST (via the internal hook, which can inject arbitrary statuses;
    // SETTLE_TEMPLATES itself only ever carries real TemplateStatus values).
    describe('T5 — the status allow-list', () => {
      const STATUSES = ['current', 'superseded', 'revoked', 'REVOKED', 'Revoked', undefined, '', 'bogus'] as const;
      const ACCEPT_SUPERSEDED = [undefined, true, false] as const;

      function rootWithStatus(status: unknown) {
        return [{ id: 'x', version: '1', bodyHash: CURRENT_SETTLE_TEMPLATE.bodyHash, bodySize: 165, compilerSha: 'x', status, since: '2026', notes: '' } as any];
      }

      it('authentic===true for EXACTLY (current, *) and (superseded, undefined|true) — every other cell is false', () => {
        for (const status of STATUSES) {
          for (const accept of ACCEPT_SUPERSEDED) {
            const acceptSuperseded = accept ?? true; // mirrors report.ts's `opts.acceptSuperseded !== false` default
            const result = authenticateBodyAgainstRoot(CURRENT_SETTLE_TEMPLATE.bodyHash, acceptSuperseded, rootWithStatus(status));
            const shouldAuthenticate = status === 'current' || (status === 'superseded' && acceptSuperseded !== false);
            expect(result.authentic).toBe(shouldAuthenticate);
          }
        }
      });

      it('a mis-cased or unrecognized status NEVER authenticates, regardless of acceptSuperseded — the case-sensitivity escape is closed', () => {
        for (const status of ['REVOKED', 'Revoked', undefined, '', 'bogus']) {
          for (const acceptSuperseded of [true, false]) {
            const result = authenticateBodyAgainstRoot(CURRENT_SETTLE_TEMPLATE.bodyHash, acceptSuperseded, rootWithStatus(status));
            expect(result.authentic).toBe(false);
          }
        }
      });
    });

    // T6 — the safety sentence is enforced, not decorative.
    describe('T6 — the safety sentence is enforced', () => {
      it('no route in the T1 matrix reaches the state FULL_BALANCE_SWEEP blesses (a non-empty sweepScope alongside an affirmative verdict) on the forged body', () => {
        for (const route of ROUTES) {
          const ver = verifySettleProgram(forged, { recipient: ATTACKER, tokens: [VICTIM] }, route.opts);
          const blessed = ver.verdict === 'MATCHES_DECLARED_INTENT' && ver.sweepScope.tokens.length > 0;
          expect(blessed).toBe(false);
        }
      });

      it("intentSource:'server-echo' can NEVER reach verdict:MATCHES_DECLARED_INTENT, even on a full field match against a genuine, authentic program", () => {
        const r = verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: v1.tokens, minOut: v1.minOut }, { intentSourceLabel: 'server-echo' });
        expect(r.intentSource).toBe('server-echo');
        expect(r.verdict).not.toBe('MATCHES_DECLARED_INTENT');
        expect(r.verdict).toBe('INTENT_UNCHECKED'); // capped, not flipped to a mismatch — the fields DO agree
        expect(r.intentReconciled).toBeNull();
        // Sanity: the SAME expectation under the default 'caller' label DOES reach the affirmative verdict.
        const caller = verifySettleProgram(v1.program, { recipient: v1.recipient, tokens: v1.tokens, minOut: v1.minOut });
        expect(caller.verdict).toBe('MATCHES_DECLARED_INTENT');
      });
    });

    // T7 — the coverage invariant, as an invariant: inspect is structurally incapable of the
    // affirmative verdict, over the SAME matrix + a genuine program, so a test that (like the old
    // suite) exercised only inspectSettleProgram could never have observed T1's headline.
    describe('T7 — inspect never returns MATCHES_DECLARED_INTENT, and the two entry points run the SAME case count', () => {
      it('inspectSettleProgram never returns MATCHES_DECLARED_INTENT for any input in the T1 matrix, nor for a genuine program with no opts', () => {
        for (const route of ROUTES) {
          expect(inspectSettleProgram(forged, route.opts).verdict).not.toBe('MATCHES_DECLARED_INTENT');
          expect(inspectSettleProgram(v1.program, route.opts).verdict).not.toBe('MATCHES_DECLARED_INTENT');
        }
      });

      it('a shared case list run through BOTH entry points sees the SAME case count on each side (the coverage defect this fixes: a prior test blessed the templates override via inspectSettleProgram ONLY)', () => {
        const cases = ROUTES;
        let ranByInspect = 0;
        let ranByVerify = 0;
        for (const route of cases) {
          inspectSettleProgram(forged, route.opts);
          ranByInspect++;
          verifySettleProgram(forged, { recipient: ATTACKER, tokens: [VICTIM] }, route.opts);
          ranByVerify++;
        }
        expect(ranByInspect).toBe(cases.length);
        expect(ranByVerify).toBe(cases.length);
        expect(ranByInspect).toBe(ranByVerify);
      });
    });
  });

  // PR-41 review — the two blockers the trust-model-inversion PR was rejected on. Both are
  // documentation/data fixes on top of an already-shipped mechanical fix (the server-echo verdict
  // cap, `deriveVerdict`, and the caller-supplied-table deletion, both covered above) — see each
  // describe block's header for the exact false claim / unfrozen state each closes.
  describe('PR-41 BLOCKER FIXES', () => {
    const bv1 = SETTLE_VECTORS[0]!;
    const VICTIM = bv1.tokens[0]!;
    const ATTACKER = '0x00000000000000000000000000000000DeaDBeef' as Hex;
    const genuineBody = ('0x' + Buffer.from(parseSettleProgram(bv1.program).body!).toString('hex')) as Hex;

    // BLOCKER 1 — the FULL_BALANCE_SWEEP disclosure used to name `verdict:'MATCHES_DECLARED_INTENT'`
    // from an "independently-formed (`intentSource:'caller'`)" expectation as the only safe read of
    // a full-balance sweep. MEASURED false: `intentSource:'caller'` is the DEFAULT — trivially true
    // of an attacker-authored `expect` checked against an attacker-authored `program` — and
    // independence is a property of the CALLER's own process, invisible to this library. A
    // consumer gating on the sentence's own stated criterion greened a cook-proven drain.
    describe('BLOCKER 1 — intentSource:"caller" is no longer offered as evidence of independence', () => {
      // PINNED VERBATIM. If this ever silently reverts to the old sentence (the exact failure mode
      // that let the false claim survive an entire PR cycle unnoticed), this test goes RED.
      const EXPECTED_FULL_BALANCE_SWEEP_TEXT =
        "The settle half moves the Pot's FULL current balance of every listed token, and the token list is " +
        "caller-chosen. A dust swap naming an unrelated token emits a program that moves that token's whole " +
        "balance to a caller-chosen recipient (cook-proven at 777e18 of a third party's parked balance). " +
        "Cooking is owner-gated, so this is not a public drain — it bites an operator whose relayer cooks " +
        "/swap output it did not originate. A passing body.hash check does NOT make this safe, and " +
        "neither does `verdict:'MATCHES_DECLARED_INTENT'` by itself: that verdict proves ONLY that the " +
        "decoded recipient, tokens and floor token equal the values you passed as `declaredIntent` — " +
        "nothing about who formed `declaredIntent`, or when. It is meaningful ONLY if YOU authored " +
        "`declaredIntent`, in your own process, from your own intent, BEFORE you ever saw this program. " +
        "`intentSource` is a caller-supplied DISCLOSURE of how `declaredIntent` claims to have been " +
        "formed — it is NOT something this module verifies or can verify. Independence is a property of " +
        "your own process, invisible to this library, and `intentSource:'caller'` is simply the DEFAULT " +
        "value, trivially true of any expectation regardless of who or what built it. Treat " +
        "`intentSource` as non-load-bearing metadata, never as proof of independence. Reconciling the " +
        "token list and recipient against your own pre-formed intent before cooking is your " +
        "responsibility, not this validator's. See `sweepScope` for the machine-readable form.";

      it('FULL_BALANCE_SWEEP.text is pinned to the exact rewritten sentence', () => {
        const disc = inspectSettleProgram(bv1.program).disclosures.find((d) => d.id === 'FULL_BALANCE_SWEEP')!;
        expect(disc.text).toBe(EXPECTED_FULL_BALANCE_SWEEP_TEXT);
      });

      it('the sentence never again cites intentSource:"caller" as proof of independence, and explicitly says intentSource is non-load-bearing', () => {
        const disc = inspectSettleProgram(bv1.program).disclosures.find((d) => d.id === 'FULL_BALANCE_SWEEP')!;
        expect(disc.text).not.toMatch(/independently-formed \(`intentSource:'caller'`\)/);
        expect(disc.text.toLowerCase()).toContain('non-load-bearing');
        expect(disc.text).toContain('BEFORE you ever saw this program');
      });

      it('re-runs the exact falsification: a GENUINE drain (pinned body verbatim) still reports authentic:true / MATCHES_DECLARED_INTENT / intentSource:"caller" under the default label — that is UNCHANGED (independence genuinely cannot be verified by this module) — but the disclosure this same report carries no longer claims that pair is what makes it safe', () => {
        const drain = encodeSettleProgram([VICTIM], 0n, ATTACKER, genuineBody);
        const selfEchoExpect: SettleExpectation = { recipient: ATTACKER, tokens: [VICTIM], minOut: 0n, floorToken: VICTIM };
        const r = verifySettleProgram(drain, selfEchoExpect);
        expect(r.authentic).toBe(true);
        expect(r.verdict).toBe('MATCHES_DECLARED_INTENT');
        expect(r.intentSource).toBe('caller');
        const disc = inspectSettleProgram(drain).disclosures.find((d) => d.id === 'FULL_BALANCE_SWEEP')!;
        expect(disc.text).toBe(EXPECTED_FULL_BALANCE_SWEEP_TEXT);
        expect(disc.text).not.toMatch(/independently-formed \(`intentSource:'caller'`\)/);
      });
    });

    // BLOCKER 2 — SETTLE_TEMPLATES is the SOLE authenticity root (`report.ts`'s `authenticateBody`
    // always calls with this exact constant) and is re-exported from the PUBLIC `./verify` barrel.
    // A `readonly`-TYPED array is a compile-time-only annotation; MEASURED
    // `Object.isFrozen(SETTLE_TEMPLATES) === false` pre-fix meant `SETTLE_TEMPLATES.push({id:"pwn",
    // status:"current", bodyHash:<forgedHash>, ...})` silently succeeded and a subsequent
    // `verifySettleProgram` call authenticated the forgery — the same class of escape as
    // monkeypatching the function, closed here with a runtime `Object.freeze` on the array AND
    // every entry.
    describe('BLOCKER 2 — SETTLE_TEMPLATES is runtime-FROZEN, not merely readonly-typed', () => {
      it('the array itself is frozen', () => {
        expect(Object.isFrozen(SETTLE_TEMPLATES)).toBe(true);
      });

      it('every entry in the array is frozen', () => {
        expect(SETTLE_TEMPLATES.length).toBeGreaterThan(0);
        for (const entry of SETTLE_TEMPLATES) {
          expect(Object.isFrozen(entry)).toBe(true);
        }
      });

      it('CURRENT_SETTLE_TEMPLATE (found via .find over the same frozen array) is frozen too', () => {
        expect(Object.isFrozen(CURRENT_SETTLE_TEMPLATE)).toBe(true);
      });

      it('REGRESSION PIN: pushing a forged entry does not silently succeed — the table is unchanged either way (throws in strict-mode ESM, no-ops otherwise; this asserts the STATE invariant that holds under both)', () => {
        const lengthBefore = SETTLE_TEMPLATES.length;
        const forgedHash = ('0x' + 'ab'.repeat(32)) as Hex;
        const forgedEntry = { id: 'pwn', version: 'x', bodyHash: forgedHash, bodySize: 165, compilerSha: 'x', status: 'current' as const, since: '2026', notes: 'forged' };
        try {
          (SETTLE_TEMPLATES as unknown as Array<typeof forgedEntry>).push(forgedEntry);
        } catch {
          // strict-mode ESM throws on a frozen-array mutation — expected, not a test failure.
        }
        expect(SETTLE_TEMPLATES.length).toBe(lengthBefore);
        expect(SETTLE_TEMPLATES.some((t) => t.id === 'pwn')).toBe(false);
        expect(CURRENT_SETTLE_TEMPLATE.id).toBe('ecoswap-settle');
      });

      it('REGRESSION PIN: mutating an existing entry in place does not silently succeed', () => {
        const before = CURRENT_SETTLE_TEMPLATE.bodyHash;
        try {
          (CURRENT_SETTLE_TEMPLATE as unknown as { bodyHash: string }).bodyHash = ('0x' + 'ab'.repeat(32));
        } catch {
          // strict-mode ESM throws on a frozen-object mutation — expected, not a test failure.
        }
        expect(CURRENT_SETTLE_TEMPLATE.bodyHash).toBe(before);
        expect(SETTLE_TEMPLATES.find((t) => t.id === 'ecoswap-settle' && t.status === 'current')!.bodyHash).toBe(before);
      });
    });
  });
});
