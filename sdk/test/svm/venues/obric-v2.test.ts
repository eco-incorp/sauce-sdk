/**
 * obric-v2 ladder adapter units (no engine, no RPC): the capacity (band)
 * clamp that keeps referenceQuote SATURATING instead of COLLAPSING once a
 * cumulative grid point pushes the shifted-CP output past the live output
 * vault, plus the capacityInputVar/referenceCapacities pair this family
 * shipped WITHOUT (2026-07 fix) — the highest-value gap the ladder-contract
 * guard exists to catch (see ladder-contract.test.ts).
 *
 * THE BUG (this family's original ladder chain, before this fix): a raw
 * `qRaw(x)` COLLAPSES past the point where `gg(x) > reserveOut` (the venue's
 * own "Insufficient active" boundary) — the OLD code masked this with a
 * STICKY "capped" flag that held the LAST-GOOD output flat, which never went
 * NEGATIVE but never wired capacityInputVar either: the merge still saw the
 * FULL raw grid span as `dIn` for a rung whose `dOut` had gone flat (0),
 * silently wasting the productive input between the last pre-cap grid point
 * and the true boundary. Fixed: `obricColdQuote`/`emitLadderQuote`/
 * `emitFinalQuote` all evaluate `qRaw(min(x, C))` — closed-form C — and
 * `capacityInputVar`/`referenceCapacities` fold `dIn` to the productive
 * input only, the SAME contract meteora-damm-v2/orca-legacy-token-swap/
 * orca-whirlpool/raydium-clmm/meteora-dlmm/manifest already implement.
 *
 * A real mainnet dump exists (sdk/test/svm/fixtures/obric-v2, pool
 * AJ5HfGY32igLgUbDtfNRdrkjTSYkCVKdhmnFFfcZMJ1E) but its vaults are DRAINED
 * (both reserves 0 at the snapshot) — cap collapses to the (correct) 0 for
 * every x there, exercising nothing about this fix. So the capacity tests
 * below use a synthetic-but-decode-realistic pool (constructed as a plain
 * ObricV2PoolConfig + a minimal state map covering exactly the bytes
 * referenceQuote reads — no fetchPoolConfig, no RPC) with real, nonzero
 * reserves so the cliff actually binds; a separate case pins the drained
 * fixture's own (degenerate but correct) always-0 behavior.
 */
import { address } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import { obricV2 } from '../../../src/svm/venues/obric-v2/index.js';
import type { ObricV2PoolConfig } from '../../../src/svm/venues/obric-v2/index.js';
import { obricV2Ladder, obricCapacity, obricRawQuote, isqrt } from '../../../src/svm/venues/obric-v2/ladder.js';
import { readUintLE } from '../../../src/svm/venues/math.js';
import type { AccountBytesMap } from '../../../src/svm/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';
import { resolve } from 'path';

// Distinct, valid base58 addresses (arbitrary real pubkeys borrowed from
// other fixtures in this repo — their identity carries no meaning here,
// only that address() accepts them and they are pairwise distinct).
const DUMMY = address('So11111111111111111111111111111111111111112');
const POOL = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const FEED_X = address('JU8kmKzDHF9sXWsnoznaFDFezLsE5uomX2JkRMbmsQP');
const FEED_Y = address('ANP74VNsHwSrq9uUSjiSNyNWvf6ZPrKTmE4gHoNd13Lg');
const VAULT_X = address('75HgnSvXbWKZBpZHveX68ZzAhDqMzNDS29X6BGLtxMo1');
const VAULT_Y = address('APDFRM3HMr8CAGXwKHiu2f5ePSpaiEJhaURwhsRrUUt9');

// A live vault/feed byte layout matching exactly what liveCurve() reads:
// amount (u64 LE) @ 64 for a vault, price (u64 LE) @ 0 + status (u32 LE) @ 16
// for a feed (priceOffX/Y = 0 below), plus a placeholder pool account (only
// dereferenced for undefined-ness — bandBps=0 skips the OFF_MULT_X/Y read).
function vaultBytes(amount: bigint): Uint8Array {
  const data = new Uint8Array(72);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return data;
}
function feedBytes(price: bigint): Uint8Array {
  const data = new Uint8Array(32);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, price, true);
  view.setUint32(16, 1, true); // agg.status = Trading
  return data;
}

const BIG_K = 10n ** 24n;
const PRICE_X = 100n;
const PRICE_Y = 100n; // mx === my → tk = isqrt(BIG_K)
const TARGET_X = 0n;
const RESERVE_X = 1_000_000n;
const RESERVE_Y = 500_000n; // this is rOut for direction xToY

function syntheticCfg(): ObricV2PoolConfig {
  return {
    venue: 'obric-v2',
    pool: POOL,
    direction: 'xToY',
    mintX: DUMMY,
    mintY: DUMMY,
    reserveXVault: VAULT_X,
    reserveYVault: VAULT_Y,
    protocolFeeX: DUMMY,
    protocolFeeY: DUMMY,
    feedX: FEED_X,
    feedY: FEED_Y,
    tokenProgram: DUMMY,
    bigK: BIG_K,
    targetX: TARGET_X,
    feeMillionth: 0n,
    divX: 1n,
    mulX: 1n,
    divY: 1n,
    mulY: 1n,
    priceOffX: 0n,
    priceOffY: 0n,
    bandBps: 0n,
    storedMultX: 0n,
    storedMultY: 0n,
    cpiTier: 'P-A',
  };
}

function syntheticState(): AccountBytesMap {
  return {
    [POOL]: new Uint8Array(8),
    [VAULT_X]: vaultBytes(RESERVE_X),
    [VAULT_Y]: vaultBytes(RESERVE_Y),
    [FEED_X]: feedBytes(PRICE_X),
    [FEED_Y]: feedBytes(PRICE_Y),
  };
}

describe('capacityInputVar / referenceCapacities are now wired (the structural gap the guard catches)', () => {
  it('the ladder declares BOTH halves of the capacity pair', () => {
    expect(obricV2Ladder.capacityInputVar).toBeDefined();
    expect(obricV2Ladder.referenceCapacities).toBeDefined();
    expect(obricV2Ladder.capacityInputVar!(3)).toBe('s3cx');
  });
});

describe('referenceQuote saturates (never collapses) past the live output vault', () => {
  const cfg = syntheticCfg();
  const state = syntheticState();
  const params = obricV2Ladder.paramsFor(cfg);

  it('quote(0) == 0', () => {
    expect(obricV2Ladder.referenceQuote(cfg, state, params)(0n)).toBe(0n);
  });

  it('is nondecreasing across an ascending sweep, up to and PAST the true closed-form cliff', () => {
    const quote = obricV2Ladder.referenceQuote(cfg, state, params);
    let prev = -1n;
    let sawPlateau = false;
    for (let x = 0n; x <= 2_000_000n; x += 1_000n) {
      const out = quote(x);
      expect(out >= prev).toBe(true); // the merge-altitude property: never a lower value at a larger x
      if (out === prev && prev > 0n) sawPlateau = true;
      prev = out;
    }
    // A REAL finite cliff must actually be exercised by this sweep — a
    // vacuous "never decreases because it never saturates" pass would prove
    // nothing about the fix.
    expect(sawPlateau).toBe(true);
  });

  it('the plateau value matches the closed-form capacity exactly: quote(C) === quote(C+1) === peak', () => {
    const quote = obricV2Ladder.referenceQuote(cfg, state, params);
    const capacities = obricV2Ladder.referenceCapacities!(cfg, state, params);
    const grid = [100_000n, 500_002n, 2_000_000n];
    const [cSmall, cAtCap, cPast] = capacities(grid);
    // referenceCapacities must itself be nondecreasing and never exceed the grid point.
    expect(cSmall <= grid[0]).toBe(true);
    expect(cAtCap <= grid[1]).toBe(true);
    expect(cPast <= grid[2]).toBe(true);
    expect(cAtCap >= cSmall).toBe(true);
    expect(cPast >= cAtCap).toBe(true);
    // Past the true cap, the productive input FREEZES at the cap and the
    // quote freezes at the cap's own output — never a lower value, never the
    // raw (uncapped) formula's own past-band value either.
    expect(cPast).toBe(cAtCap); // 500_002 IS the closed-form cap (verified below)
    expect(quote(2_000_000n)).toBe(quote(500_002n));
    expect(quote(500_002n)).toBe(quote(500_002n + 1n));
  });

  it('the closed-form cap matches obricCapacity directly (500_002 for this synthetic pool)', () => {
    const tk = isqrt((BIG_K * PRICE_Y) / PRICE_X);
    const cIn = tk - TARGET_X + RESERVE_X;
    const cOut = BIG_K / cIn;
    const cap = obricCapacity(cIn, cOut, BIG_K, RESERVE_Y);
    expect(cap).toBe(500_002n);
  });
});

describe('REGRESSION: the pre-fix sticky-flag mechanism collapsed to 0 well past the same cliff', () => {
  it('reproduces the old shape via the raw (unclamped) formula on the SAME synthetic pool', () => {
    const cfg = syntheticCfg();
    const state = syntheticState();
    const params = obricV2Ladder.paramsFor(cfg);

    const tk = isqrt((BIG_K * PRICE_Y) / PRICE_X);
    const cIn = tk - TARGET_X + RESERVE_X;
    const cOut = BIG_K / cIn;
    const rOut = RESERVE_Y;
    const cap = obricCapacity(cIn, cOut, BIG_K, rOut);
    expect(cap).toBe(500_002n);

    // Old (pre-fix) behavior: qRaw(x) directly, no clamp — collapses to 0
    // once gg(x) > rOut, instead of saturating at the cap's own output.
    const oldQuote = (x: bigint): bigint => {
      const raw = obricRawQuote(x, cIn, cOut, BIG_K, 0n);
      const nOut = BIG_K / (cIn + x);
      const gg = nOut < cOut ? cOut - nOut : 0n;
      return gg > rOut ? 0n : raw;
    };
    const justBelowCap = cap;
    const wayPastCap = cap * 4n + 1000n;
    const oldAtCap = oldQuote(justBelowCap);
    const oldPast = oldQuote(wayPastCap);
    expect(oldAtCap).toBeGreaterThan(0n);
    expect(oldPast).toBe(0n); // the collapse
    expect(oldPast).toBeLessThan(oldAtCap); // dOut < 0 across this pair — exactly what the fix removes

    // The FIXED reference does not collapse over the same pair.
    const newQuote = obricV2Ladder.referenceQuote(cfg, state, params);
    expect(newQuote(wayPastCap) >= newQuote(justBelowCap)).toBe(true);
    expect(newQuote(wayPastCap)).toBe(oldAtCap); // saturates at exactly the pre-collapse peak
  });
});

describe('the rewritten (stateless clamp-then-quote) fragment compiles as valid SauceScript', () => {
  // No existing test in this repo compiles a ladder-v2 fragment standalone
  // (the established pattern tests the reference closures — buildLadder /
  // solveReference over referenceQuote/referenceCapacities, in the recipes
  // repo); this is an EXTRA belt-and-suspenders check given the rewrite
  // touched hand-written SauceScript strings directly, in both directions
  // and with the sanity band ENABLED (bandBps != 0, so the OFF_MULT_X/Y pool
  // read path compiles too).
  it.each(['xToY', 'yToX'] as const)('%s: emitSetup + two ladder rungs + emitFinalQuote', (direction) => {
    const cfg: ObricV2PoolConfig = { ...syntheticCfg(), direction, bandBps: 2500n };
    const params = obricV2Ladder.paramsFor(cfg).map((v) => v.toString());
    const source = [
      'function main() {',
      '  let s0en = 1;',
      obricV2Ladder.emitSetup(cfg, 0, params),
      obricV2Ladder.emitLadderQuote!(cfg, 0, 0, '100000', 's0o1'),
      obricV2Ladder.emitLadderQuote!(cfg, 0, 1, '500000', 's0o2'),
      obricV2Ladder.emitFinalQuote!(cfg, 0, '250000', 'qFinal'),
      '  return qFinal;',
      '}',
    ].join('\n');
    const { bytecode, accountPlan } = compile(source, { target: 'svm' });
    expect(bytecode[0].length).toBeGreaterThan(0);
    expect(accountPlan?.metas.map((m) => m.ref).sort()).toEqual(
      ['s0:vx', 's0:vy', 's0:fx', 's0:fy', 's0:pool'].sort(),
    );
  });
});

describe('the real (drained) mainnet fixture — a degenerate but correct always-0 edge case', () => {
  const FIXTURES = resolve(process.cwd(), 'test/svm/fixtures/obric-v2');
  const REAL_POOL = address('AJ5HfGY32igLgUbDtfNRdrkjTSYkCVKdhmnFFfcZMJ1E');

  it('a pool with 0 reserves quotes 0 for every x (0 capacity), never negative, never a false positive', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const state = fixtureBytesMap(fixtures);
    const cfg = await obricV2.fetchPoolConfig(load, REAL_POOL);
    const rx = readUintLE(state[cfg.reserveXVault], 64, 8);
    const ry = readUintLE(state[cfg.reserveYVault], 64, 8);
    expect(rx).toBe(0n);
    expect(ry).toBe(0n);
    const params = obricV2Ladder.paramsFor(cfg);
    const quote = obricV2Ladder.referenceQuote(cfg, state, params);
    expect(quote(0n)).toBe(0n);
    expect(quote(1_000_000n)).toBe(0n);
    expect(quote(1n << 40n)).toBe(0n);
  });
});
