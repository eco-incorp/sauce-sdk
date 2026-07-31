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

  describe('R1-R4 fixes — the second adversarial pass', () => {
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

    // R2: a caller-pinned `expectedBodyHash` that merely equals the hash of the SAME arbitrary
    // bytes being checked is self-certification — the identical tautology the deleted `ok`
    // boolean used to hide, relocated to the authenticity check. `authentic:true` alongside
    // `templateId:null` is an internal contradiction: it claims "this IS our audited template"
    // for a body that matches NO entry in the templates table at all.
    it('R2 — a caller-pinned expectedBodyHash must not authenticate arbitrary non-audited bytes as "our audited template" merely because it equals that same body\'s own hash', () => {
      const goodBody = decodeSettleProgram(v1.program).body;
      const bodyHexChars = 165 * 2;
      const prologueHex = v1.program.slice(0, v1.program.length - bodyHexChars);
      const forgedBody = '00' + goodBody.slice(4); // flip one byte — matches no table entry
      const forged = (prologueHex + forgedBody) as Hex;
      const forgedHash = decodeSettleProgram(forged).bodyHash;

      // Default label ('caller') — a bare, self-referential assertion. Must NOT authenticate.
      const r = inspectSettleProgram(forged, { expectedBodyHash: forgedHash });
      expect(r.authentic).toBe(false);
      expect(r.templateId).toBeNull(); // no longer a contradiction: authentic is also false
      expect(r.hashSource).toBe('caller');
      expect(r.checks.find((c) => c.id === 'body.hash')!.status).toBe('fail');
      expect(r.verdict).not.toBe('MATCHES_DECLARED_INTENT');

      // A genuinely accepted table hash, caller-pinned, still authenticates (non-regression).
      const realPin = inspectSettleProgram(v1.program, { expectedBodyHash: CURRENT_SETTLE_TEMPLATE.bodyHash });
      expect(realPin.authentic).toBe(true);
      expect(realPin.templateId).not.toBeNull();
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

  describe('B1 — the "rederived" hashSourceLabel must not restore the self-referential authenticity tautology', () => {
    const v1 = SETTLE_VECTORS[0]!;
    const goodBody = decodeSettleProgram(v1.program).body;
    const bodyHexChars = 165 * 2;
    const prologueHex = v1.program.slice(0, v1.program.length - bodyHexChars);
    const forgedBodyHex = '00' + goodBody.slice(4); // flip one byte — matches no table entry
    const forged = (prologueHex + forgedBodyHex) as Hex;
    const forgedHash = decodeSettleProgram(forged).bodyHash;

    it('ROUTE 1 — expectedBodyHash: keccak256(forgedBody), hashSourceLabel: "rederived" must NOT authenticate arbitrary bytes just because the caller labels their self-referential hash "rederived"', () => {
      const ATTACKER = '0x000000000000000000000000000000000000dEaD' as Hex;
      const VICTIM = v1.tokens[0]!;
      const r = verifySettleProgram(forged, { recipient: ATTACKER, tokens: [VICTIM] }, { expectedBodyHash: forgedHash, hashSourceLabel: 'rederived' });
      expect(r.hashSource).toBe('rederived');
      // The exploit: this must NOT read authentic:true / verdict:MATCHES_DECLARED_INTENT — a
      // caller who controls both the forged bytes AND the hash checked against them can trivially
      // satisfy hashMatchesClaim regardless of the label attached to it.
      expect(r.authentic).toBe(false);
      expect(r.templateId).toBeNull();
      expect(r.checks.find((c) => c.id === 'body.hash')!.status).toBe('fail');
      expect(r.verdict).not.toBe('MATCHES_DECLARED_INTENT');
      expect(r.verdict).toBe('NOT_OUR_TEMPLATE');
      // sweepScope/effects must be empty — no behavioral claim about an unauthenticated program.
      expect(r.sweepScope.tokens.length).toBe(0);
      expect(r.effects.length).toBe(0);
    });

    it('a GENUINE "rederived" pin (the recipes package\'s real reportOwnSettleProgram use case — a hash independently recompiled from the audited template) still authenticates — this fix must not regress the legitimate case', () => {
      const r = inspectSettleProgram(v1.program, { expectedBodyHash: CURRENT_SETTLE_TEMPLATE.bodyHash, hashSourceLabel: 'rederived' });
      expect(r.hashSource).toBe('rederived');
      expect(r.authentic).toBe(true);
      expect(r.templateId).not.toBeNull();
      expect(r.checks.find((c) => c.id === 'body.hash')!.status).toBe('pass');
    });

    it('ROUTE 2 — a caller-controlled opts.templates override does not, by itself, let templateId!==null be mistaken for a security gate; hashSource still names it "caller"', () => {
      // Demonstrates why "assert templateId !== null" would be the WRONG mitigation: a caller who
      // controls their own templates table can make an arbitrary forged body match a "current"
      // entry trivially. hashSource:'caller' is the honest signal here, not templateId.
      const forgedTable = [{ id: 'ecoswap-settle', version: 'forged', bodyHash: forgedHash, bodySize: 165, compilerSha: 'forged', status: 'current' as const, since: '2026', notes: 'forged' }];
      const r = inspectSettleProgram(forged, { templates: forgedTable });
      expect(r.templateId).not.toBeNull();
      expect(r.hashSource).toBe('caller');
      // authentic:true here is the DOCUMENTED consequence of a caller overriding their OWN trust
      // root (see VerifyOpts.templates) — not the tautology this fix closes. A consumer that wants
      // ONLY the SDK's own pinned root must additionally check hashSource==='pinned'.
      expect(r.authentic).toBe(true);
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
    // per-verdict expectation table below, not by writing a new ad-hoc test.
    const EXPECTED_BY_VERDICT: Record<string, { structurallyValid: boolean; authentic: boolean | null; intentReconciled: boolean | null }> = {
      MALFORMED: { structurallyValid: false, authentic: null /* not constrained by verdict */, intentReconciled: null },
      NOT_OUR_TEMPLATE: { structurallyValid: true, authentic: false, intentReconciled: null },
      INTENT_MISMATCH: { structurallyValid: true, authentic: true, intentReconciled: false },
      INTENT_UNCHECKED: { structurallyValid: true, authentic: true, intentReconciled: null },
    };

    it('enumerated per-field invariant over every gateable boolean/nullable field, across all four non-affirmative verdicts', () => {
      for (const { label, report } of nonAffirmativeCases()) {
        const expected = EXPECTED_BY_VERDICT[label]!;
        expect(report.structurallyValid).toBe(expected.structurallyValid);
        if (expected.authentic !== null) expect(report.authentic).toBe(expected.authentic);
        expect(report.intentReconciled).toBe(expected.intentReconciled);
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
    const v1 = SETTLE_VECTORS[0]!;
    const garbageElements = [null, undefined, {}, { bodyHash: 1 }, { bodyHash: null }] as unknown as Array<{ bodyHash: string }>;

    it('inspectSettleProgram(program, {templates:[<garbage>]}) never throws, for every garbage element shape', () => {
      for (const el of garbageElements) {
        expect(() => inspectSettleProgram(v1.program, { templates: [el] as unknown as never })).not.toThrow();
        const r = inspectSettleProgram(v1.program, { templates: [el] as unknown as never });
        // A templates table with no real entry can never authenticate.
        expect(r.authentic).toBe(false);
      }
    });

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
});
