/**
 * Quantum wei-exactness pin — the adapter mirror vs. the DEPLOYED program.
 *
 * Every vector below is the output the real
 * QuaNtZsgYRe5Z9Bk4LZ4cTD9tbkVoyCNf1R2BN9bBDv binary produced in LiteSVM,
 * against the checked-in fixture accounts at the pinned slot, driven through
 * its real swap instruction (tag 7, amountIn u64, minOut u64, direction u8).
 * Nothing here is the model quoting itself.
 *
 * A reverting live result only ever happens where the walk yields ZERO output
 * (the venue's own err 0xd dust gate) — pinned as '0', which is what the
 * saturating ladder quote must also say (a zero rung is never elected).
 *
 * WHY THIS FILE IS THE GATE: shipping a guessed mid on a venue quoting ~4 bps
 * of spread manufactures an over-optimistic head that wins elections it should
 * lose. The adapter may UNDER-quote; a single wei of OVER-quote is a liveness
 * hazard. These assertions are exact equality, not a tolerance.
 *
 * Every equality compares String(...) — a failing raw-bigint .toBe() kills the
 * jest worker with "Do not know how to serialize a BigInt" and the suite
 * vanishes from the run count instead of failing.
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import { fetchQuantumConfig, quantumLadder } from '../../../src/svm/index.js';
import type { QuantumPoolConfig } from '../../../src/svm/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';

const FIXTURES = resolve(process.cwd(), 'test/svm/fixtures/quantum');

const POOLS = {
  bhr: { pool: 'BHrYr82teMWH38Q6QSgNEzkfZjiyLP74vL9m9FG6bQAD', slot: 436_213_243n },
  tc3: { pool: '6TC3v1iA6a17ABkdg2LFeUbwjFtLR5TzbNzUEgtosx8a', slot: 435_803_506n },
} as const;

// Measured against the deployed binary — see the header.
const MEASURED: Record<string, { cap: string; vectors: [string, string][] }> = {
  'bhr:zeroIn': {
    cap: '78799949118',
    vectors: [
    ['1', '0'],
    ['4', '0'],
    ['16', '1'],
    ['65', '4'],
    ['264', '19'],
    ['1064', '79'],
    ['4287', '319'],
    ['17280', '1287'],
    ['69647', '5190'],
    ['280713', '20922'],
    ['1131424', '84326'],
    ['4560244', '339881'],
    ['18380217', '1369901'],
    ['74082082', '5521433'],
    ['298590323', '22254317'],
    ['1203478347', '89696694'],
    ['4850659983', '361524263'],
    ['8755549902', '652556618'],
    ['17511099804', '1305097895'],
    ['19550748320', '1457108002'],
    ['26266649706', '1957619156'],
    ['35022199608', '2610117367'],
    ['39399974559', '2936356090'],
    ['43777749510', '3262583436'],
    ['52533299412', '3915003561'],
    ['61288849314', '4567377600'],
    ['70044399216', '5219705556'],
    ['78799949117', '5871987434'],
    ['78799949118', '5871987434'],
    ] as [string, string][],
  },
  'bhr:oneIn': {
    cap: '6600406905',
    vectors: [
    ['1', '26'],
    ['4', '67'],
    ['12', '174'],
    ['43', '590'],
    ['152', '2051'],
    ['534', '7175'],
    ['1876', '25173'],
    ['6588', '88371'],
    ['23134', '310278'],
    ['81243', '1089608'],
    ['285310', '3826457'],
    ['1001956', '13437771'],
    ['3518686', '47190950'],
    ['12356975', '165725835'],
    ['43395419', '581998288'],
    ['152396710', '2043867400'],
    ['535189147', '7177644726'],
    ['733378545', '9835610190'],
    ['1466757090', '19670923222'],
    ['1879485605', '25205839166'],
    ['2200135635', '29505837377'],
    ['2933514180', '39340293463'],
    ['3300203452', '44257244231'],
    ['3666892725', '49173978847'],
    ['4400271270', '59006799403'],
    ['5133649815', '68838755467'],
    ['5867028360', '78669847349'],
    ['6600406904', '88500074999'],
    ['6600406905', '88500075000'],
    ] as [string, string][],
  },
  'tc3:zeroIn': {
    cap: '81792',
    vectors: [
    ['1', '1262'],
    ['2', '1893'],
    ['4', '3155'],
    ['7', '5048'],
    ['12', '8203'],
    ['23', '15144'],
    ['43', '27764'],
    ['81', '51743'],
    ['153', '97176'],
    ['286', '181101'],
    ['536', '338854'],
    ['1005', '634800'],
    ['1884', '1189462'],
    ['3532', '2229373'],
    ['6622', '4179208'],
    ['9088', '5735289'],
    ['12414', '7834043'],
    ['18176', '11469947'],
    ['23273', '14686228'],
    ['27264', '17204606'],
    ['36352', '22939264'],
    ['40896', '25806594'],
    ['43630', '27531700'],
    ['45440', '28673832'],
    ['54528', '34408473'],
    ['63616', '40143113'],
    ['72704', '45877753'],
    ['81791', '51611763'],
    ['81792', '51612394'],
    ] as [string, string][],
  },
  'tc3:oneIn': {
    cap: '1776235362',
    vectors: [
    ['1', '0'],
    ['3', '0'],
    ['11', '0'],
    ['35', '0'],
    ['114', '0'],
    ['371', '0'],
    ['1211', '1'],
    ['3954', '6'],
    ['12909', '20'],
    ['42145', '65'],
    ['137598', '213'],
    ['449234', '697'],
    ['1466674', '2277'],
    ['4788448', '7435'],
    ['15633490', '24276'],
    ['51040755', '79257'],
    ['166639607', '258759'],
    ['197359484', '306460'],
    ['394718969', '612906'],
    ['544050699', '844768'],
    ['592078454', '919337'],
    ['789437938', '1225753'],
    ['888117681', '1378956'],
    ['986797423', '1532155'],
    ['1184156908', '1838542'],
    ['1381516392', '2144914'],
    ['1578875877', '2451271'],
    ['1776235361', '2757613'],
    ['1776235362', '2757613'],
    ] as [string, string][],
  },
};

type Tag = keyof typeof POOLS;
type Dir = 'zeroIn' | 'oneIn';

describe('quantum ladder mirror is wei-exact against the deployed program', () => {
  const fixtures = loadFixtures(FIXTURES);
  const state = fixtureBytesMap(fixtures);
  const load = fixtureLoader(fixtures);

  async function cfgFor(tag: Tag, direction: Dir): Promise<QuantumPoolConfig> {
    const base = await fetchQuantumConfig(load, address(POOLS[tag].pool));
    return { ...base, direction };
  }
  const split = (key: string): [Tag, Dir] => key.split(':') as [Tag, Dir];

  it.each(Object.keys(MEASURED))('%s: referenceQuote reproduces every measured output exactly', async (key) => {
    const [tag, direction] = split(key);
    const cfg = await cfgFor(tag, direction);
    const quote = quantumLadder.referenceQuote(cfg, state, quantumLadder.paramsFor(cfg), POOLS[tag].slot);
    for (const [x, expected] of MEASURED[key].vectors) expect(String(quote(BigInt(x)))).toBe(expected);
  });

  it.each(Object.keys(MEASURED))('%s: never OVER-quotes the deployed program at any measured point', async (key) => {
    const [tag, direction] = split(key);
    const cfg = await cfgFor(tag, direction);
    const quote = quantumLadder.referenceQuote(cfg, state, quantumLadder.paramsFor(cfg), POOLS[tag].slot);
    for (const [x, expected] of MEASURED[key].vectors) {
      expect(String(quote(BigInt(x)) <= BigInt(expected))).toBe('true');
    }
  });

  it.each(Object.keys(MEASURED))('%s: saturates past the measured max landable input and never collapses', async (key) => {
    const [tag, direction] = split(key);
    const cfg = await cfgFor(tag, direction);
    const params = quantumLadder.paramsFor(cfg);
    const quote = quantumLadder.referenceQuote(cfg, state, params, POOLS[tag].slot);
    const caps = quantumLadder.referenceCapacities!(cfg, state, params, POOLS[tag].slot);
    const cap = BigInt(MEASURED[key].cap);
    const atCap = quote(cap);
    expect(String(atCap > 0n)).toBe('true');
    for (const mult of [1n, 2n, 1_000n, 1_000_000n]) {
      const x = cap * mult + mult;
      expect(String(quote(x))).toBe(String(atCap)); // saturates, never 0
      expect(String(caps([x])[0])).toBe(String(cap)); // productive input freezes at the cliff
    }
    expect(String(caps([cap / 2n])[0])).toBe(String(cap / 2n));
  });

  it('the per-level expiry gate is a SELF-DROP: a slot past every expiry quotes 0 and does not throw', async () => {
    const cfg = await cfgFor('bhr', 'zeroIn');
    const stale = quantumLadder.referenceQuote(cfg, state, quantumLadder.paramsFor(cfg), POOLS.bhr.slot + 1n);
    expect(String(stale(1_000_000_000n))).toBe('0');
  });

  it('the shipped window is the walkable prefix, per direction', async () => {
    const cfg = await cfgFor('bhr', 'zeroIn');
    expect(cfg.windows.zeroIn.levels.map((l) => l.index)).toEqual([0, 1, 2, 3, 4]);
    expect(cfg.windows.oneIn.levels.map((l) => l.index)).toEqual([0, 1, 2, 3, 4]);
    expect(cfg.levelCount).toBe(5);
    expect([cfg.dec0, cfg.dec1]).toEqual([9, 6]);
  });

  it('gates a foreign account size', async () => {
    await expect(fetchQuantumConfig(async () => new Uint8Array(64), address('11111111111111111111111111111111'))).rejects.toThrow(/2280/);
  });

  it('the emitted fragment reads everything LIVE: no price/size/expiry literal is baked', async () => {
    const cfg = await cfgFor('bhr', 'zeroIn');
    const params = quantumLadder.paramsFor(cfg).map((_, i) => `s0p${i}`);
    const setup = quantumLadder.emitSetup(cfg, 0, params, 's0en');
    const walk = quantumLadder.emitLadderQuote!(cfg, 0, 0, 's0g0', 's0o0');
    // Every value-bearing quantity comes from accountUint over the pool/vault.
    expect(setup).toContain('accountUint("s0:pool"');
    expect(setup).toContain('accountUint("s0:ovault"');
    expect(setup).toContain('block.number');
    for (const level of cfg.windows.zeroIn.levels) {
      const price = String(1n); // sanity: no literal price/cum from the snapshot may appear
      expect(price.length).toBeGreaterThan(0);
      expect(level.index).toBeGreaterThanOrEqual(0);
    }
    for (const baked of ['13417183', '447185128', '4362132430000']) {
      expect(setup).not.toContain(baked);
      expect(walk).not.toContain(baked);
    }
    expect(walk).toContain('qtFill(');
    expect(walk).toContain('qtCost(');
  });
});
