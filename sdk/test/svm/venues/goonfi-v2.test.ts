/**
 * goonfi-v2 ladder units (no engine, no RPC): the "THE TIER-CEILING +
 * VAULT-CLAMP COLLAPSE" fix.
 *
 * Both of goonfi-v2's deactivation edges (the fee-tier size ceiling, the
 * live vaultOut clamp) used to latch/return WITHOUT recording anything,
 * collapsing referenceQuote/referenceLadderQuotes/referenceCapacities and
 * the emitted SauceScript fragment (emitLadderQuote/emitFinalQuote) straight
 * to 0 past either edge — violating the adapter contract's "nondecreasing
 * in x, quote(0)=0". See ladder.ts's emitLadderQuote doc for the fix.
 *
 * Hand-built synthetic accounts (no fixture directory exists for this
 * family at the SDK level yet — the CU/e2e harness that already exercises a
 * synthesized goonfi-v2 pool lives one repo away, in sauce-recipes'
 * test/svm/ecoswap-svm.cu.e2e.test.ts). Only the oracle (32 bytes: p1@0,
 * p2@8 u64 LE, denom@20 u32 LE) and the output vault (a plain u64 LE
 * `amount` at the standard SPL token offset 64) are read by liveState/
 * emitSetup at quote time — thresholds/fees are baked as compile-time
 * params (paramsFor), never read live from the pool account, so no pool
 * account bytes are needed here at all.
 */
import { address, getAddressCodec } from '@solana/kit';
import { goonfiV2Ladder } from '../../../src/svm/venues/goonfi-v2/ladder.js';
import type { GoonfiV2PoolConfig } from '../../../src/svm/venues/goonfi-v2/index.js';
import type { AccountBytesMap } from '../../../src/svm/index.js';

const POOL = address('FmxXDSR9WvpJTCh738D1LEDuhMoA8geCtZgHb3isy7Dp');
const VAULT_A = address('So11111111111111111111111111111111111111112');
const VAULT_B = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ORACLE = address('BNrK9LpEn65QA4TyBLVSMdngW3XHj3xLfFPwGdCBv8wV');
const MINT_A = address('So11111111111111111111111111111111111111112');
const MINT_B = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const codec = getAddressCodec();

function oracleBytes(p1: bigint, p2: bigint, denom: bigint): Uint8Array {
  const b = new Uint8Array(32);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, p1, true);
  v.setBigUint64(8, p2, true);
  v.setUint32(20, Number(denom), true);
  return b;
}

function vaultBytes(mint: import('@solana/kit').Address, owner: import('@solana/kit').Address, amount: bigint): Uint8Array {
  const b = new Uint8Array(165);
  b.set(codec.encode(mint), 0);
  b.set(codec.encode(owner), 32);
  new DataView(b.buffer).setBigUint64(64, amount, true);
  return b;
}

// Round-number fee schedule: 9 ascending thresholds 1e8..9e8, fees 1000..9000 ppm (0.1%..0.9%).
const THRESHOLDS = Array.from({ length: 9 }, (_, i) => BigInt((i + 1) * 100_000_000));
const FEES_PPM = Array.from({ length: 9 }, (_, i) => BigInt((i + 1) * 1000));

function cfgFor(rout: bigint): { cfg: GoonfiV2PoolConfig; state: AccountBytesMap; params: bigint[] } {
  const cfg: GoonfiV2PoolConfig = {
    venue: 'goonfi-v2',
    pool: POOL,
    direction: 'xToY',
    mintA: MINT_A,
    mintB: MINT_B,
    decimalsA: 0,
    decimalsB: 0,
    vaultA: VAULT_A,
    vaultB: VAULT_B,
    oracle: ORACLE,
    tokenProgram: TOKEN_PROGRAM,
    feeSchedule: { sizeTiers: THRESHOLDS, feeTiersPpm: FEES_PPM },
  };
  // p1 = p2 = 2,000,000; da = denomAdjustedFor(0,0) = 1,000,000 -> raw(x) = x*2 (a plain 2:1 price).
  const state: AccountBytesMap = {
    [ORACLE]: oracleBytes(2_000_000n, 2_000_000n, 1_000_000n),
    [VAULT_B]: vaultBytes(MINT_B, POOL, rout),
  };
  const params = goonfiV2Ladder.paramsFor(cfg).map((v) => v);
  return { cfg, state, params };
}

// tierCeilOut when rout is ample (never binds): raw(t9) = 9e8*2 = 1.8e9; fee at t9 is the LAST
// tier (9000ppm = 0.9%, since the escalation loop only checks thresholds[0..7]); net =
// 1,800,000,000 - 1,800,000,000*9000/1,000,000 = 1,800,000,000 - 16,200,000 = 1,783,800,000.
const TIER_CEIL_OUT_UNCLAMPED = 1_783_800_000n;

describe('goonfi-v2 — vault-clamp edge no longer collapses to 0', () => {
  // rout picked so the clamp trips well inside tier 1 (fee=1000ppm): net=rout at
  // x = rout / (2*(1-0.001)) = 50,000,000 / 1.998 = 25,025,025.02... -- any x above
  // ~25,025,026 should saturate at rout, not collapse.
  const ROUT = 50_000_000n;

  it('REGRESSION: referenceQuote saturates at rout for x arbitrarily far past the clamp, instead of collapsing to 0', () => {
    const { cfg, state, params } = cfgFor(ROUT);
    const q = goonfiV2Ladder.referenceQuote(cfg, state, params);
    expect(q(0n)).toBe(0n);
    expect(q(30_000_000n)).toBe(ROUT); // just past the crossing -- already saturated
    expect(q(1_000_000_000n)).toBe(ROUT); // deep past it, still tier 1 -- still saturated
    expect(q(900_000_000n)).toBe(ROUT); // AT the tier ceiling -- still just the vault clamp
    expect(q(1n << 60n)).toBe(ROUT); // arbitrarily large -- plateaus, never collapses
  });

  it('REGRESSION: referenceLadderQuotes/referenceCapacities bump-then-latch at (rout, x), not freeze below it', () => {
    const { cfg, state, params } = cfgFor(ROUT);
    const grid = [0n, 10_000_000n, 20_000_000n, 25_100_000n, 50_000_000n, 900_000_000n, 1n << 40n, 1n << 60n];
    const quotes = goonfiV2Ladder.referenceLadderQuotes!(cfg, state, params)(grid);
    const caps = goonfiV2Ladder.referenceCapacities!(cfg, state, params)(grid);
    for (let i = 1; i < quotes.length; i++) {
      expect(quotes[i]).toBeGreaterThanOrEqual(quotes[i - 1]);
      expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]);
    }
    expect(quotes[quotes.length - 1]).toBe(ROUT);
    expect(quotes[quotes.length - 1]).toBeGreaterThan(0n);
    expect(caps[caps.length - 1]).toBeGreaterThan(0n);
  });
});

describe('goonfi-v2 — tier-ceiling edge no longer collapses to 0', () => {
  const ROUT = 1_000_000_000_000n; // ample -- never binds, isolates the tier-ceiling edge

  it('REGRESSION: referenceQuote saturates at tierCeilOut past the size ceiling, instead of collapsing to 0', () => {
    const { cfg, state, params } = cfgFor(ROUT);
    const q = goonfiV2Ladder.referenceQuote(cfg, state, params);
    expect(q(900_000_000n)).toBe(TIER_CEIL_OUT_UNCLAMPED); // exactly at t9 -- organic, not yet a fallback
    expect(q(900_000_001n)).toBe(TIER_CEIL_OUT_UNCLAMPED); // one past it -- was 0n pre-fix
    expect(q(1n << 60n)).toBe(TIER_CEIL_OUT_UNCLAMPED); // arbitrarily large -- plateaus
  });

  it('REGRESSION: referenceLadderQuotes/referenceCapacities bump-then-latch at (tierCeilOut, t9)', () => {
    const { cfg, state, params } = cfgFor(ROUT);
    const grid = [0n, 100_000_000n, 500_000_000n, 900_000_000n, 900_000_001n, 1n << 50n];
    const quotes = goonfiV2Ladder.referenceLadderQuotes!(cfg, state, params)(grid);
    const caps = goonfiV2Ladder.referenceCapacities!(cfg, state, params)(grid);
    for (let i = 1; i < quotes.length; i++) {
      expect(quotes[i]).toBeGreaterThanOrEqual(quotes[i - 1]);
      expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]);
    }
    expect(quotes[quotes.length - 1]).toBe(TIER_CEIL_OUT_UNCLAMPED);
    expect(caps[caps.length - 1]).toBe(900_000_000n);
  });
});

describe('FRAGMENT/REFERENCE PARITY — emitted SauceScript matches the JS mirror\'s fix, and compiles', () => {
  it('compiles as valid SauceScript (emitSetup + one ladder rung + emitFinalQuote), both edges included', async () => {
    const { compile } = await import('@eco-incorp/sauce-compiler');
    const { cfg, params } = cfgFor(1_000_000_000_000n);
    const paramStrs = params.map((v) => v.toString());
    const source = [
      'function main() {',
      goonfiV2Ladder.emitSetup(cfg, 0, paramStrs),
      goonfiV2Ladder.emitLadderQuote!(cfg, 0, 0, '900000001', 's0o1'),
      goonfiV2Ladder.emitFinalQuote!(cfg, 0, '900000001', 'qFinal'),
      '  return qFinal;',
      '}',
    ].join('\n');
    const { bytecode } = compile(source, { target: 'svm' });
    expect(bytecode[0].length).toBeGreaterThan(0);
  });

  it('emitLadderQuote/emitFinalQuote source references the setup-computed tierCeilOut fallback (not a bare 0)', () => {
    const { cfg } = cfgFor(1_000_000_000_000n);
    const rung = goonfiV2Ladder.emitLadderQuote!(cfg, 0, 0, '900000001', 's0o1');
    const final = goonfiV2Ladder.emitFinalQuote!(cfg, 0, '900000001', 'qFinal');
    expect(rung).toContain('tierCeilOut');
    expect(final).toContain('tierCeilOut');
  });
});
