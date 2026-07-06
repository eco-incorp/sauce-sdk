/**
 * Obric V2 oracle units (no engine, no RPC): the prop-AMM oracle-anchored
 * (P-A) family.
 *
 *  - fetchPoolConfig against the REAL mainnet AJ5 (27G8/USDC) dump: layout,
 *    the oracle→mult scaling (verified vs the pool's own stored multX/multY),
 *    tier P-A, and the CPI-acceptance gates (introspecting feed → P-C,
 *    non-Pyth feed → P-B);
 *  - the ladder referenceQuote as the lamport-exact target: independently
 *    transcribed from the obric-solana SDK's V2Pool.quoteXToY, the empty-
 *    inventory guard, monotonicity/quote(0)=0, the LIVE mid re-anchor and the
 *    sanity-band self-deactivation;
 *  - the CPI-acceptance probe (staticCpiScreen / classifyVenue);
 *  - the codegen shape contract (compiles, shape-stable).
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address, getAddressCodec } from '@solana/kit';
import {
  INSTRUCTIONS_SYSVAR,
  classifyVenue,
  obricV2,
  obricV2Ladder,
  staticCpiScreen,
  isqrt,
} from '../../src/svm/index.js';
import type { ObricV2PoolConfig } from '../../src/svm/index.js';
import { generateEcoSwapSvm } from '../../src/recipes/ecoswap/svm/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from './fixtures.js';
import type { AccountFixture } from './fixtures.js';
import {
  synthesizeObricPool,
  pythV2FeedBytes,
  overlayBytesMap,
  overlayLoader,
  syntheticMintBytes,
  TOKENKEG,
  OBRIC_V2_PROGRAM,
} from './ecoswap-svm.fixtures.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const OBRIC_FIXTURES = loadFixtures(join(FIXTURES, 'obric-v2'));
const AJ5_POOL = address('AJ5HfGY32igLgUbDtfNRdrkjTSYkCVKdhmnFFfcZMJ1E');
const codec = getAddressCodec();

/** Only the AJ5 (Pyth-relay) account set — bwb-* (Minimox) is separate ledger evidence. */
const aj5Fixtures = OBRIC_FIXTURES.filter((f) => !f.address.startsWith('BWB'))
  .filter((f) => ![
    'C3tPQ8TRcHybnPpR8KMASUVD3PukQRRHEsLwxorJMhgm',
    'AAamGhyPfpQJWfZHTq944NM1cFvoVLDrQxt7HGjeRQUS',
    'J4HJYz4p7TRP96WVFky3vh7XryxoFehHjoRySUTeSeXw',
  ].includes(f.address));

/** A 165-byte SPL token account with a chosen balance (reserve overlay). */
function vaultBytes(mint: string, owner: string, amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  d.set(new Uint8Array(codec.encode(address(mint))), 0);
  d.set(new Uint8Array(codec.encode(address(owner))), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  return d;
}

/**
 * The independent mirror: the obric-solana SDK's V2Pool.quoteXToY, rebate
 * OMITTED (the conservative adapter charges the full fee). Derived from the
 * SDK source, NOT from the emitted fragment — the referenceQuote must match it.
 */
function sdkQuoteXToY(
  bigK: bigint,
  multX: bigint,
  multY: bigint,
  targetX: bigint,
  reserveX: bigint,
  reserveY: bigint,
  fee: bigint,
  x: bigint,
): bigint {
  if (x === 0n) return 0n;
  const targetXK = isqrt((bigK * multY) / multX);
  const currentXK = targetXK - targetX + reserveX;
  const currentYK = bigK / currentXK;
  const newXK = currentXK + x;
  const newYK = bigK / newXK;
  const out = currentYK - newYK;
  if (out > reserveY) return 0n;
  return out - (out * fee) / 1_000_000n;
}

describe('obric-v2: fetchPoolConfig against the real AJ5 (27G8/USDC) mainnet dump', () => {
  it('decodes the layout, derives the oracle scaling, classifies P-A', async () => {
    const cfg = await obricV2.fetchPoolConfig(fixtureLoader(aj5Fixtures), AJ5_POOL);
    expect(cfg.venue).toBe('obric-v2');
    expect(cfg.direction).toBe('xToY');
    expect(cfg.cpiTier).toBe('P-A');
    expect(cfg.bigK).toBe(6_725_685_088_743_750_000_000_000_000n);
    expect(cfg.targetX).toBe(0n);
    expect(cfg.feeMillionth).toBe(150n);
    // expo −8 → getPrice scales to expo −3 (÷1e5); both mints 6-decimal → decimalMult 1.
    expect([cfg.divX, cfg.mulX, cfg.divY, cfg.mulY]).toEqual([100_000n, 1n, 100_000n, 1n]);
    expect([cfg.priceOffX, cfg.priceOffY]).toEqual([208n, 208n]);
    // The pool's STORED multY (USDC) reproduces from the live feed: 1e10 @ expo −8 → ÷1e5 = 100000.
    expect(cfg.storedMultY).toBe(100_000n);
    expect(cfg.storedMultX).toBe(339_001n);
  });

  it('the params ride the cfg words in order (bigK hi/lo, targetX, fee, scaling, offsets, band)', async () => {
    const cfg = await obricV2.fetchPoolConfig(fixtureLoader(aj5Fixtures), AJ5_POOL);
    const params = obricV2Ladder.paramsFor(cfg);
    expect(params).toEqual([
      cfg.bigK >> 64n,
      cfg.bigK & ((1n << 64n) - 1n),
      0n, // targetX
      150n, // fee
      100_000n, 1n, 100_000n, 1n, // divX mulX divY mulY
      208n, 208n, // offsets
      2500n, // default band
    ]);
  });

  it('CPI-acceptance gate: a feed pointing at the Instructions sysvar is rejected (introspecting → P-C)', async () => {
    // Doctor the real pool: overwrite yPriceFeedId @41 with the sysvar.
    const doctored = aj5Fixtures.map((f) => {
      if (f.address !== String(AJ5_POOL)) return f;
      const data = new Uint8Array(Buffer.from(f.base64Data, 'base64'));
      data.set(new Uint8Array(codec.encode(INSTRUCTIONS_SYSVAR)), 41);
      return { ...f, base64Data: Buffer.from(data).toString('base64') } as AccountFixture;
    });
    await expect(obricV2.fetchPoolConfig(fixtureLoader(doctored), AJ5_POOL)).rejects.toThrow(/instructions sysvar|introspecting|P-C/);
  });

  it('CPI-acceptance gate: a non-Pyth-v2 feed (Minimox magic) is rejected (unpinned layout → P-B)', async () => {
    // Point feedX at the checked-in Minimox bytes (magic 0xcab93a6d ≠ 0xa1b2c3d4).
    const minimox = OBRIC_FIXTURES.find((f) => f.address === 'J4HJYz4p7TRP96WVFky3vh7XryxoFehHjoRySUTeSeXw')!;
    const doctored = aj5Fixtures.map((f) => {
      if (f.address !== String(AJ5_POOL)) return f;
      const data = new Uint8Array(Buffer.from(f.base64Data, 'base64'));
      data.set(new Uint8Array(codec.encode(address(minimox.address))), 9); // xPriceFeedId
      return { ...f, base64Data: Buffer.from(data).toString('base64') } as AccountFixture;
    });
    await expect(obricV2.fetchPoolConfig(fixtureLoader([...doctored, minimox]), AJ5_POOL)).rejects.toThrow(/non-Pyth|P-B|not pinned|layout/);
  });

  it('gates a drained pool (bigK=0) and a wrong discriminator', async () => {
    const zeroed = aj5Fixtures.map((f) => {
      if (f.address !== String(AJ5_POOL)) return f;
      const data = new Uint8Array(Buffer.from(f.base64Data, 'base64'));
      new DataView(data.buffer).setBigUint64(274, 0n, true); // bigK lo
      new DataView(data.buffer).setBigUint64(282, 0n, true); // bigK hi
      return { ...f, base64Data: Buffer.from(data).toString('base64') } as AccountFixture;
    });
    await expect(obricV2.fetchPoolConfig(fixtureLoader(zeroed), AJ5_POOL)).rejects.toThrow(/bigK=0|drained/);
  });
});

describe('obric-v2: referenceQuote — the lamport-exact target (bake shape / read level)', () => {
  it('real AJ5 bytes have empty vaults → the Insufficient-active guard quotes 0 (self-deactivation)', async () => {
    const cfg = await obricV2.fetchPoolConfig(fixtureLoader(aj5Fixtures), AJ5_POOL);
    const params = obricV2Ladder.paramsFor(cfg);
    const quote = obricV2Ladder.referenceQuote(cfg, fixtureBytesMap(aj5Fixtures), params);
    expect(quote(1_000_000n)).toBe(0n);
    expect(quote(0n)).toBe(0n);
  });

  it('with reserves, the reference matches the independently-transcribed SDK quote and is monotone', async () => {
    const cfg = await obricV2.fetchPoolConfig(fixtureLoader(aj5Fixtures), AJ5_POOL);
    const params = obricV2Ladder.paramsFor(cfg);
    const state = fixtureBytesMap(aj5Fixtures);
    state[String(cfg.reserveXVault)] = vaultBytes(String(cfg.mintX), String(cfg.pool), 10n ** 12n);
    state[String(cfg.reserveYVault)] = vaultBytes(String(cfg.mintY), String(cfg.pool), 10n ** 12n);
    const quote = obricV2Ladder.referenceQuote(cfg, state, params);
    // Live oracle-derived mults from the real feeds (÷1e5): 27G8=330596, USDC=100000.
    const expected = (x: bigint): bigint => sdkQuoteXToY(cfg.bigK, 330_596n, 100_000n, 0n, 10n ** 12n, 10n ** 12n, 150n, x);
    for (const x of [1_000_000n, 100_000_000n, 1_000_000_000n, 5_000_000_000n]) {
      expect(quote(x)).toBe(expected(x));
    }
    expect(quote(0n)).toBe(0n);
    expect(quote(2_000_000n) > quote(1_000_000n)).toBe(true);
  });

  it('the LIVE mid re-anchors: doctoring the oracle price moves the quote by the new mult ratio', async () => {
    const cfg = await obricV2.fetchPoolConfig(fixtureLoader(aj5Fixtures), AJ5_POOL);
    const params = obricV2Ladder.paramsFor(cfg);
    const base = fixtureBytesMap(aj5Fixtures);
    base[String(cfg.reserveXVault)] = vaultBytes(String(cfg.mintX), String(cfg.pool), 10n ** 12n);
    base[String(cfg.reserveYVault)] = vaultBytes(String(cfg.mintY), String(cfg.pool), 10n ** 12n);
    const q0 = obricV2Ladder.referenceQuote(cfg, base, params)(1_000_000_000n);

    // Drift 27G8 up ~5% (in the 25% band): rawX 33059603329 → 34712583495.
    const drifted = { ...base };
    drifted[String(cfg.feedX)] = pythV2FeedBytes(34_712_583_495n, -8);
    const q1 = obricV2Ladder.referenceQuote(cfg, drifted, params)(1_000_000_000n);
    // A higher X price shifts the curve center — the quote changes and stays exact vs the SDK mirror.
    expect(q1).not.toBe(q0);
    const mx = 34_712_583_495n / 100_000n;
    expect(q1).toBe(sdkQuoteXToY(cfg.bigK, mx, 100_000n, 0n, 10n ** 12n, 10n ** 12n, 150n, 1_000_000_000n));
  });

  it('the sanity band self-deactivates a grossly out-of-band oracle (clamp to 0)', async () => {
    const cfg = await obricV2.fetchPoolConfig(fixtureLoader(aj5Fixtures), AJ5_POOL);
    const params = obricV2Ladder.paramsFor(cfg);
    const state = fixtureBytesMap(aj5Fixtures);
    state[String(cfg.reserveXVault)] = vaultBytes(String(cfg.mintX), String(cfg.pool), 10n ** 12n);
    state[String(cfg.reserveYVault)] = vaultBytes(String(cfg.mintY), String(cfg.pool), 10n ** 12n);
    // 10× the real X price — far outside the 25% band vs the stored mult ratio.
    state[String(cfg.feedX)] = pythV2FeedBytes(330_596_033_290n, -8);
    expect(obricV2Ladder.referenceQuote(cfg, state, params)(1_000_000_000n)).toBe(0n);
    // A zero/halted feed price also deactivates.
    state[String(cfg.feedX)] = pythV2FeedBytes(0n, -8);
    expect(obricV2Ladder.referenceQuote(cfg, state, params)(1_000_000_000n)).toBe(0n);
  });

  it('a synthesized pool quotes both directions and drops to 0 past its inventory', () => {
    const synth = synthesizeObricPool({
      bigK: 10n ** 24n,
      reserveX: 1_000_000_000n,
      reserveY: 200_000_000n, // thin Y — the guard clamps a large X-in
      priceX: 20_000_000_000n, // $200 @ expo −8
      priceY: 1_000_000_000n, // $10 @ expo −8 (a scaled stable)
    });
    const state = overlayBytesMap([], [synth]);
    const cfg: ObricV2PoolConfig = {
      venue: 'obric-v2',
      pool: synth.pool,
      direction: 'xToY',
      mintX: address('So11111111111111111111111111111111111111112'),
      mintY: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      reserveXVault: synth.vaultX,
      reserveYVault: synth.vaultY,
      protocolFeeX: synth.protocolFeeX,
      protocolFeeY: synth.protocolFeeY,
      feedX: synth.feedX,
      feedY: synth.feedY,
      tokenProgram: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      bigK: 10n ** 24n,
      targetX: 0n,
      feeMillionth: 150n,
      divX: 100_000n,
      mulX: 1n,
      divY: 100_000n,
      mulY: 1n,
      priceOffX: 208n,
      priceOffY: 208n,
      bandBps: 2500n,
      storedMultX: 200_000n,
      storedMultY: 10_000n,
      cpiTier: 'P-A',
    };
    const params = obricV2Ladder.paramsFor(cfg);
    const q = obricV2Ladder.referenceQuote(cfg, state, params);
    // A tiny X-in fills; a huge X-in would draw more Y than reserveY → guard 0.
    expect(q(1_000_000n) > 0n).toBe(true);
    expect(q(10_000_000_000_000n)).toBe(0n);
    // yToX quotes X out for Y in.
    const yx = obricV2Ladder.referenceQuote({ ...cfg, direction: 'yToX' }, state, params);
    expect(yx(1_000_000n) > 0n).toBe(true);
  });
});

describe('obric-v2: CPI-acceptance probe (static screen + classification)', () => {
  it('flags the Instructions sysvar as introspection (P-C)', () => {
    const screen = staticCpiScreen({
      accounts: [{ address: address('So11111111111111111111111111111111111111112') }, { address: INSTRUCTIONS_SYSVAR }],
      userSigner: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    });
    expect(screen.introspects).toBe(true);
    expect(screen.candidateTier).toBe('P-C');
    expect(classifyVenue(screen).tier).toBe('P-C');
  });

  it('flags a non-user signer as a maker/oracle-writer seat (P-C)', () => {
    const maker = address('4zaRAseHRKTsdb4NNcLJogrLjUvQAobaNYuKebKPnWs');
    const user = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const screen = staticCpiScreen({ accounts: [{ address: maker, signer: true }, { address: user, signer: true }], userSigner: user });
    expect(screen.foreignSigners).toEqual([maker]);
    expect(screen.candidateTier).toBe('P-C');
  });

  it('a clean 12-account Obric swap screens P-A (no introspection, no foreign signer)', () => {
    const user = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const accounts = Array.from({ length: 11 }, () => ({ address: address('So11111111111111111111111111111111111111112') }));
    accounts.push({ address: user, signer: true } as any);
    const screen = staticCpiScreen({ accounts, userSigner: user });
    expect(screen.introspects).toBe(false);
    expect(screen.foreignSigners).toEqual([]);
    expect(screen.candidateTier).toBe('P-A');
    // With no sim verdict it stays a provisional P-A; a public-oracle ACCEPT confirms.
    expect(classifyVenue(screen).tier).toBe('P-A');
    expect(classifyVenue(screen, { verdict: 'accept', delta: 100n, cu: 5000n }).tier).toBe('P-A');
    // A proprietary internal oracle that ACCEPTs is P-B.
    expect(classifyVenue(screen, { verdict: 'accept', delta: 100n }, { internalOracle: true }).tier).toBe('P-B');
    // A REJECT / DEGRADE is P-C (degrade keeps external-scan eligibility).
    expect(classifyVenue(screen, { verdict: 'reject', delta: 0n }).tier).toBe('P-C');
    const degraded = classifyVenue(screen, { verdict: 'degrade', delta: 1n });
    expect(degraded.tier).toBe('P-C');
    expect(degraded.externalScanEligible).toBe(true);
  });
});

describe('obric-v2: codegen shape contract', () => {
  it('compiles a solo obric slot and is shape-stable across pool sets', async () => {
    const cfg = await obricV2.fetchPoolConfig(fixtureLoader(aj5Fixtures), AJ5_POOL);
    const user = { outAta: 'u:o', inAta: 'u:i', owner: 'p' };
    const g1 = generateEcoSwapSvm({ slots: [{ adapter: obricV2Ladder, cfg }], user });
    expect(g1.bytecode.length).toBeGreaterThan(0);
    expect(g1.shapeKey).toBe('obric-v2:xToY');
    expect(g1.cfgByteLength).toBe((2 + 1 + 11) * 8); // amountIn, minOut, enable, 11 params

    // A DIFFERENT pool of the same shape compiles byte-identically.
    const synth = synthesizeObricPool({ bigK: 10n ** 24n, reserveX: 1n, reserveY: 1n, priceX: 1n, priceY: 1n });
    const cfg2: ObricV2PoolConfig = { ...cfg, pool: synth.pool, feedX: synth.feedX, feedY: synth.feedY, reserveXVault: synth.vaultX, reserveYVault: synth.vaultY, protocolFeeX: synth.protocolFeeX, protocolFeeY: synth.protocolFeeY };
    const g2 = generateEcoSwapSvm({ slots: [{ adapter: obricV2Ladder, cfg: cfg2 }], user });
    expect(Buffer.from(g2.bytecode).toString('hex')).toBe(Buffer.from(g1.bytecode).toString('hex'));
  });
});

describe('obric-v2: shape/level drift-invariance boundary (VERIFIER adversarial)', () => {
  // Prove the "bake the shape, read the level" contract at its seams: what
  // rides cfg (baked SHAPE — a change needs re-prepare) vs what is read LIVE
  // in-VM (LEVEL — tracked without re-preparing). A mid-only drift re-anchors
  // EXACTLY; a reserve drift tracks live; a bigK (spread) change is INVISIBLE
  // to the staged params and only a fresh prepare picks it up.
  const U64 = (1n << 64n) - 1n;
  const AAA = address('AAA1111111111111111111111111111111111111111');
  const bigK1 = 10n ** 24n;
  const R = 5_000_000_000n; // reserves == targetX -> pool centered on the oracle mid

  const mkCfg = (synth: ReturnType<typeof synthesizeObricPool>, bigK: bigint): ObricV2PoolConfig => ({
    venue: 'obric-v2',
    pool: synth.pool,
    direction: 'xToY',
    mintX: AAA,
    mintY: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    reserveXVault: synth.vaultX,
    reserveYVault: synth.vaultY,
    protocolFeeX: synth.protocolFeeX,
    protocolFeeY: synth.protocolFeeY,
    feedX: synth.feedX,
    feedY: synth.feedY,
    tokenProgram: TOKENKEG,
    bigK,
    targetX: R,
    feeMillionth: 150n,
    divX: 100_000n,
    mulX: 1n,
    divY: 100_000n,
    mulY: 1n,
    priceOffX: 208n,
    priceOffY: 208n,
    bandBps: 2500n,
    storedMultX: 1000n,
    storedMultY: 1000n,
    cpiTier: 'P-A',
  });

  it('mid-only drift re-anchors exactly; reserve drift tracks live; a bigK (spread) change needs re-prepare', async () => {
    // priceX = priceY = $10 @ expo −8 → mult 1000 (matches storedMult in band).
    const synth = synthesizeObricPool({
      bigK: bigK1,
      reserveX: R,
      reserveY: R,
      priceX: 1_000_000_000n,
      priceY: 1_000_000_000n,
      targetX: R,
      mintX: AAA,
    });
    const cfg = mkCfg(synth, bigK1);
    const params = obricV2Ladder.paramsFor(cfg);
    const state = overlayBytesMap([], [synth]);
    const x = 1_000_000_000n;

    // Baseline == the independently-transcribed SDK quote at the live mult 1000.
    const q0 = obricV2Ladder.referenceQuote(cfg, state, params)(x);
    expect(q0).toBe(sdkQuoteXToY(bigK1, 1000n, 1000n, R, R, R, 150n, x));
    expect(q0 > 0n).toBe(true);

    // (1) MID-only drift (LEVEL): raise feedX price 5% within the 25% band →
    // the SAME baked params re-anchor targetXK exactly to the new mult 1050.
    const midDrift = { ...state };
    midDrift[String(synth.feedX)] = pythV2FeedBytes(1_050_000_000n, -8);
    const qMid = obricV2Ladder.referenceQuote(cfg, midDrift, params)(x);
    expect(qMid).toBe(sdkQuoteXToY(bigK1, 1050n, 1000n, R, R, R, 150n, x)); // exact re-anchor
    expect(qMid).not.toBe(q0); // the live mid genuinely moved the quote

    // (2) RESERVE-only drift (LEVEL): fewer X in the vault → tracked live with
    // the SAME params (currentXK = targetXK − targetX + reserveX).
    const resDrift = { ...state };
    resDrift[String(synth.vaultX)] = vaultBytes(String(AAA), String(synth.pool), 4_000_000_000n);
    const qRes = obricV2Ladder.referenceQuote(cfg, resDrift, params)(x);
    expect(qRes).toBe(sdkQuoteXToY(bigK1, 1000n, 1000n, R, 4_000_000_000n, R, 150n, x));
    expect(qRes).not.toBe(q0);

    // (3) SPREAD change (bigK, on-chain): the fragment reads bigK from the
    // BAKED params, never from the pool bytes — so mutating bigK@274 leaves the
    // staged quote UNCHANGED (a stale shape). Only a fresh prepare re-reads it.
    const bigK2 = 2n * bigK1;
    const mutatedPool = new Uint8Array(state[String(synth.pool)]);
    const dv = new DataView(mutatedPool.buffer);
    dv.setBigUint64(274, bigK2 & U64, true);
    dv.setBigUint64(282, bigK2 >> 64n, true);
    const spread = { ...state, [String(synth.pool)]: mutatedPool };
    expect(obricV2Ladder.referenceQuote(cfg, spread, params)(x)).toBe(q0); // baked → invariant

    // A FRESH prepare over the mutated pool ships DIFFERENT params (bigK2) — the
    // documented re-prepare boundary. Equal-decimal mints keep every other
    // param identical, so ONLY the bigK hi/lo words move.
    const freshLoader = overlayLoader([], [
      {
        accounts: [
          { address: synth.pool, owner: OBRIC_V2_PROGRAM, data: mutatedPool },
          ...synth.accounts.filter((a) => a.address !== synth.pool),
          { address: AAA, owner: TOKENKEG, data: syntheticMintBytes(6) },
          { address: cfg.mintY, owner: TOKENKEG, data: syntheticMintBytes(6) },
        ],
      },
    ]);
    const freshCfg = await obricV2.fetchPoolConfig(freshLoader, synth.pool);
    expect(freshCfg.bigK).toBe(bigK2);
    const freshParams = obricV2Ladder.paramsFor(freshCfg);
    expect([freshParams[0], freshParams[1]]).toEqual([bigK2 >> 64n, bigK2 & U64]);
    expect([freshParams[0], freshParams[1]]).not.toEqual([params[0], params[1]]);
    expect(freshParams.slice(2)).toEqual(params.slice(2)); // only the spread (bigK) changed
  });
});

// keep overlayLoader referenced for future engine-free loader assertions
void overlayLoader;
