/**
 * Orca Whirlpools ladder adapter units (no engine, no RPC): mainnet fixture
 * decode against the docs/svm-venues.md field values, tick math against the
 * program's own pinned test vectors, worked-example quotes pinned from an
 * INDEPENDENT direct port of the whirlpool sources (a throwing
 * compute_swap/tick-sequence transcription written separately from the
 * adapter — the two implementations share nothing but the venue), the
 * window-capacity clamp, the warm chain's merge-safety (monotone outputs,
 * never a negative rung dOut, even when the window exhausts mid-ladder),
 * negative-liquidity-net i128 round-trips on synthetic profiles, every fetch
 * gate on doctored fixtures, swap-instruction encoding, and a full staged
 * compile of a one-slot shape.
 *
 * Fixture: SOL/USDC 0.04% ts=4 pool Czfq3xZZ... + five surrounding tick
 * arrays + vaults + mints, one-slot mainnet snapshot (slot 431094837) — see
 * fixtures/orca-whirlpool/README.md.
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import {
  fetchOrcaWhirlpoolConfig,
  windowStartTicks,
  TICK_ARRAY_DISCRIMINATOR,
  WHIRLPOOL_DISCRIMINATOR,
} from '../../../src/svm/venues/orca-whirlpool/index.js';
import type { OrcaWhirlpoolPoolConfig } from '../../../src/svm/venues/orca-whirlpool/index.js';
import {
  orcaWhirlpoolLadder,
  whirlpoolDeltaA,
  whirlpoolDeltaB,
  whirlpoolSqrtPriceAtTick,
  WHIRLPOOL_MAX_BOUNDARIES,
} from '../../../src/svm/venues/orca-whirlpool/ladder.js';
import type { AccountBytesMap, AccountLoader } from '../../../src/svm/index.js';
import { buildLadder, generateEcoSwapSvm } from '../../../src/recipes/ecoswap/svm/index.js';
import { fixtureBytesMap, fixtureData, fixtureLoader, loadFixtures } from '../fixtures.js';
import { synthesizeWhirlpool, tickArrayPda } from '../orca-whirlpool.fixtures.js';
import { randomAddr, syntheticMintBytes, USDC_MINT, WSOL_MINT } from '../ecoswap-svm.fixtures.js';

const POOL = address('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE');
const TA_N25344 = 'DXi5Z4FeJKHm4kcZPdmfoWSkJG7sj5s3wrvnpxy3DAny';
const TA_N25696 = '2s4eJvC4t2oscWNFDw4sZShL3SfB3Zifmr6R8Qayp7mU';
const TA_N26048 = 'ChxrcGgr1UNLhgE6bge26EQRwDzbv9Q6co5ea12no6JP';
const TA_N24992 = '65cUCgkA4THMitgKTyatqDnKHPSytxkt5GGJ1VMVNarC';
const TA_N24640 = '8Rs3qKaVGBndwNdeDqHcayatonVzdBrdYoq27CKyjuE7';
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };

const fixtures = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/orca-whirlpool'));
const loader = fixtureLoader(fixtures);
const state = fixtureBytesMap(fixtures);
const poolFixture = fixtures.find((fixture) => fixture.address === POOL)!;

const fetchCfg = (): Promise<OrcaWhirlpoolPoolConfig> => fetchOrcaWhirlpoolConfig(loader, POOL);
const asBToA = (cfg: OrcaWhirlpoolPoolConfig): OrcaWhirlpoolPoolConfig => ({ ...cfg, direction: 'bToA' });

const quoteFn = (cfg: OrcaWhirlpoolPoolConfig, bytes: AccountBytesMap = state) =>
  orcaWhirlpoolLadder.referenceQuote(cfg, bytes, orcaWhirlpoolLadder.paramsFor(cfg));
const chainFn = (cfg: OrcaWhirlpoolPoolConfig, bytes: AccountBytesMap = state) =>
  orcaWhirlpoolLadder.referenceLadderQuotes!(cfg, bytes, orcaWhirlpoolLadder.paramsFor(cfg));

function writeLE(data: Uint8Array, offset: number, width: number, value: bigint): void {
  for (let i = 0; i < width; i++) data[offset + i] = Number((value >> BigInt(8 * i)) & 0xffn);
}

function doctoredLoader(mutate: (data: Uint8Array) => void, extra: Record<string, Uint8Array> = {}): AccountLoader {
  const data = fixtureData(poolFixture);
  mutate(data);
  return async (addr) => {
    if (addr === POOL) return data;
    if (extra[addr] !== undefined) return extra[addr];
    return loader(addr);
  };
}

describe('tick math (program test vectors)', () => {
  it('matches sqrt_price_from_tick_index on the source-pinned bit values and bounds', () => {
    const vectors: [number, bigint][] = [
      [0, 18446744073709551616n],
      [1, 18447666387855959850n],
      [-1, 18445821805675392311n],
      [2, 18448588748116922571n],
      [-2, 18444899583751176498n],
      [128, 18565175891880433522n],
      [-128, 18329067761203520168n],
      [32768, 94936283578220370716n],
      [-32768, 3584323654723342297n],
      [262144, 9078618265828848800676189n],
      [-262144, 37481735321082n],
      [443636, 79226673515401279992447579055n], // MAX_SQRT_PRICE
      [-443636, 4295048016n], // MIN_SQRT_PRICE
    ];
    for (const [tick, expected] of vectors) expect(whirlpoolSqrtPriceAtTick(tick)).toBe(expected);
  });

  it('is strictly increasing across boundary-adjacent ticks', () => {
    for (const tick of [-25156, -25152, -1, 0, 1, 443635]) {
      expect(whirlpoolSqrtPriceAtTick(tick)).toBeLessThan(whirlpoolSqrtPriceAtTick(tick + 1));
    }
  });
});

describe('fetchPoolConfig on the mainnet fixture', () => {
  it('decodes the pinned pool fields (snapshot slot 431094837)', async () => {
    const cfg = await fetchCfg();
    expect(cfg.tickSpacing).toBe(4);
    expect(cfg.feeRate).toBe(400);
    expect(cfg.tickCurrentIndex).toBe(-25156);
    expect(cfg.sqrtPrice).toBe(5244461737044097829n);
    expect(cfg.liquidity).toBe(832740502930995n);
    expect(cfg.tokenMintA).toBe(WSOL_MINT);
    expect(cfg.tokenMintB).toBe(USDC_MINT);
    expect(cfg.tokenVaultA).toBe(address('EUuUbDcafPrmVTD5M6qoJAoyyNbihBhugADAxRMn5he9'));
    expect(cfg.tokenVaultB).toBe(address('2WLWEuKDgkDUccTpbwYp1GToYktiSB1cXvreHUwiSUVP'));
    expect(cfg.oracle).toBe(address('FoKYKtRpD25TKzBMndysKpgPqbj8AdLXjfpYHXn9PGTX'));
  });

  it('derives both direction windows: start indexes, shipped boundaries, MAXB-stopped edge', async () => {
    const cfg = await fetchCfg();
    expect(cfg.windows.aToB.startTicks).toEqual([-25344, -25696, -26048]);
    expect(cfg.windows.aToB.tickArrays).toEqual([TA_N25344, TA_N25696, TA_N26048]);
    expect(cfg.windows.aToB.readable).toBe(3);
    // Dense ts=4 arrays: the first four initialized ticks down are one per
    // spacing, all inside the first array; the scan MAXB-stops so no edge.
    expect(cfg.windows.aToB.boundaries.map((b) => b.tick)).toEqual([-25156, -25160, -25164, -25168]);
    expect(cfg.windows.aToB.boundaries.every((b) => b.arrayIndex === 0)).toBe(true);
    expect(cfg.windows.aToB.boundaries[0].sqrtPrice).toBe(whirlpoolSqrtPriceAtTick(-25156));
    expect(cfg.windows.aToB.edge).toBeNull();
    expect(cfg.windows.bToA.startTicks).toEqual([-25344, -24992, -24640]);
    expect(cfg.windows.bToA.tickArrays).toEqual([TA_N25344, TA_N24992, TA_N24640]);
    expect(cfg.windows.bToA.boundaries.map((b) => b.tick)).toEqual([-25152, -25148, -25144, -25140]);
    expect(cfg.windows.bToA.edge).toBeNull();

    // params: [nb, (meta,hi,lo) x4, edgeTick, edgeHi, edgeLo]
    const params = orcaWhirlpoolLadder.paramsFor(cfg);
    expect(params).toHaveLength(16);
    expect(params[0]).toBe(4n);
    const meta0 = params[1];
    expect(meta0 & 0xffffffffn).toBe(2147483648n - 25156n); // biased tick
    expect((meta0 >> 32n) & 127n).toBe(47n); // offset within the start -25344 array
    expect(meta0 >> 39n).toBe(0n); // array index
    expect((params[2] << 64n) | params[3]).toBe(whirlpoolSqrtPriceAtTick(-25156));
    expect(params[13]).toBe(0n); // no edge shipped
  });

  it('applies the bToA shifted-window rule at the array boundary', () => {
    // span = 352; tick -25000: base -25344; -25000 + 4 >= -24992 => shifted.
    expect(windowStartTicks(-24993, 4, false)).toEqual([-24992, -24640, -24288]);
    expect(windowStartTicks(-25000, 4, false)).toEqual([-25344, -24992, -24640]);
    expect(windowStartTicks(-25000, 4, true)).toEqual([-25344, -25696, -26048]);
  });

  it('gates adaptive-fee pools, foreign sizes/discriminators and non-Tokenkeg mints', async () => {
    await expect(
      fetchOrcaWhirlpoolConfig(doctoredLoader((data) => writeLE(data, 43, 2, 5n)), POOL),
    ).rejects.toThrow(/adaptive fee tier/);
    const truncated = fixtureData(poolFixture).subarray(0, 600);
    await expect(fetchOrcaWhirlpoolConfig(async () => truncated, POOL)).rejects.toThrow(/653/);
    await expect(
      fetchOrcaWhirlpoolConfig(doctoredLoader((data) => (data[0] ^= 0xff)), POOL),
    ).rejects.toThrow(/discriminator/);
    await expect(
      fetchOrcaWhirlpoolConfig(doctoredLoader(() => {}, { [WSOL_MINT]: new Uint8Array(200) }), POOL),
    ).rejects.toThrow(/Tokenkeg-only/);
  });

  it('truncates the readable window at a missing or non-fixed tick array', async () => {
    const missingTail = await fetchOrcaWhirlpoolConfig(
      async (addr) => (addr === TA_N25696 ? null : loader(addr)),
      POOL,
    );
    expect(missingTail.windows.aToB.readable).toBe(1);
    expect(missingTail.windows.bToA.readable).toBe(3);

    const dynamicDisc = fixtureData(fixtures.find((f) => f.address === TA_N24992)!);
    dynamicDisc[0] ^= 0xff;
    const dynamicTail = await fetchOrcaWhirlpoolConfig(
      async (addr) => (addr === TA_N24992 ? dynamicDisc : loader(addr)),
      POOL,
    );
    expect(dynamicTail.windows.bToA.readable).toBe(1);
  });
});

describe('worked examples (pinned from the independent whirlpool port)', () => {
  it('aToB: SOL in, USDC out', async () => {
    const quote = quoteFn(await fetchCfg());
    expect(quote(1_000_000_000n)).toBe(80_795_746n);
    expect(quote(10_000_000_000n)).toBe(807_954_981n);
    expect(quote(100_000_000_000n)).toBe(8_079_301_632n); // crosses into tick -25157
    expect(quote(1_000_000_000_000n)).toBe(80_768_189_284n); // walks to tick -25163
  });

  it('bToA: USDC in, SOL out', async () => {
    const quote = quoteFn(asBToA(await fetchCfg()));
    expect(quote(81_000_000n)).toBe(1_001_725_479n);
    expect(quote(8_100_000_000n)).toBe(100_169_156_454n);
    expect(quote(81_000_000_000n)).toBe(1_001_383_338_471n); // walks to tick -25149
  });

  it('quotes 0 at zero input and beyond the window capacity (self-deactivation)', async () => {
    const cfg = await fetchCfg();
    const quote = quoteFn(cfg);
    expect(quote(0n)).toBe(0n);
    expect(quote(10_000_000_000_000n)).toBe(0n); // > the 8-boundary window capacity
    expect(quoteFn(asBToA(cfg))(810_000_000_000n)).toBe(0n);
  });
});

describe('the warm ladder chain', () => {
  it('cold rungs equal the cold quotes pointwise and stay monotone', async () => {
    const cfg = await fetchCfg();
    const grid = [125_000_000_000n, 250_000_000_000n, 500_000_000_000n, 1_000_000_000_000n];
    const chain = chainFn(cfg)(grid);
    expect(chain).toEqual([10_099_040_836n, 20_197_219_532n, 40_390_990_678n, 80_768_189_284n]);
    const cold = quoteFn(cfg);
    expect(grid.map((g) => cold(g))).toEqual(chain);
    for (let i = 1; i < chain.length; i++) expect(chain[i]).toBeGreaterThanOrEqual(chain[i - 1]);
  });

  it('caps clamped rungs at the previous output — no negative dOut ever reaches the merge', async () => {
    const cfg = await fetchCfg();
    // amountIn far beyond window capacity: the top rungs exhaust mid-ladder.
    const amountIn = 8_000_000_000_000n;
    const grid = [amountIn >> 3n, amountIn >> 2n, amountIn >> 1n, amountIn];
    const chain = chainFn(cfg)(grid);
    expect(chain[0]).toBeGreaterThan(0n); // 1k SOL fits the 4-boundary window
    expect(chain[3]).toBe(chain[2]); // exhausted rungs report the last good output
    const rungs = buildLadder(quoteFn(cfg), amountIn, 4, chainFn(cfg));
    for (const rung of rungs) {
      expect(rung.dOut).toBeGreaterThanOrEqual(0n);
      expect(rung.dIn).toBeGreaterThan(0n);
    }
  });
});

describe('synthetic profiles (negative liquidity_net round-trips, window edges)', () => {
  const TS = 64;
  const L = 1_000_000_000_000n;

  const synth = synthesizeWhirlpool({
    mintA: WSOL_MINT,
    mintB: USDC_MINT,
    tickSpacing: TS,
    tickCurrentIndex: 0,
    liquidity: L,
    feeRate: 3000,
    // One position [-128, +128]: +net at the lower bound, -net at the upper.
    ticks: [
      { tick: -128, net: L },
      { tick: 128, net: -L },
    ],
    arrayStarts: [-5632, 0],
  });
  const mints = { [WSOL_MINT]: syntheticMintBytes(9), [USDC_MINT]: syntheticMintBytes(6) };
  const synthLoader: AccountLoader = async (addr) => {
    for (const account of synth.accounts) if (account.address === addr) return new Uint8Array(account.data);
    return mints[addr] === undefined ? null : new Uint8Array(mints[addr]);
  };
  const synthState = (): AccountBytesMap => {
    const bytes: AccountBytesMap = {};
    for (const account of synth.accounts) bytes[account.address] = new Uint8Array(account.data);
    return bytes;
  };

  it('reads a negative net back through the raw u128 word (bToA crossing drops L to zero)', async () => {
    const cfg = { ...(await fetchOrcaWhirlpoolConfig(synthLoader, synth.pool)), direction: 'bToA' as const };
    expect(cfg.windows.bToA.readable).toBe(1); // only array 0 exists upward
    expect(cfg.windows.aToB.readable).toBe(2);
    const quote = quoteFn(cfg, synthState());

    // In-range capacity to the +128 boundary: fee-gross input, exact deltas.
    const sp0 = whirlpoolSqrtPriceAtTick(0);
    const spU = whirlpoolSqrtPriceAtTick(128);
    const netIn = whirlpoolDeltaB(L, sp0, spU, true);
    const fee = (netIn * 3000n + 996_999n) / 997_000n;
    const outFull = whirlpoolDeltaA(L, sp0, spU, false);
    expect(quote(netIn + fee)).toBe(outFull); // exactly to the boundary

    // Beyond the boundary L is 0 (the -net crossing zeroed it): the walk
    // traverses the L == 0 gap to the array edge, then self-deactivates.
    expect(quote(netIn + fee + 1_000_000n)).toBe(0n);
    expect(quote(netIn + fee - 1_000_000n)).toBeGreaterThan(0n);
  });

  it('aToB mirrors the profile downward (positive net at the lower bound zeroes L)', async () => {
    const cfg = await fetchOrcaWhirlpoolConfig(synthLoader, synth.pool);
    const quote = quoteFn(cfg, synthState());
    const spL = whirlpoolSqrtPriceAtTick(-128);
    const sp0 = whirlpoolSqrtPriceAtTick(0);
    const netIn = whirlpoolDeltaA(L, spL, sp0, true);
    const fee = (netIn * 3000n + 996_999n) / 997_000n;
    expect(quote(netIn + fee)).toBe(whirlpoolDeltaB(L, spL, sp0, false));
    expect(quote(netIn + fee + 1_000_000n)).toBe(0n); // past the lower bound: L == 0 to the window edge
  });

  it('a live tick outside every attached array self-deactivates (no out-of-window fallback)', async () => {
    const drifted = synthState();
    const pool = drifted[synth.pool];
    writeLE(pool, 65, 16, whirlpoolSqrtPriceAtTick(9000));
    writeLE(pool, 81, 4, BigInt.asUintN(32, 9000n)); // tick 9000: array start 5632 — not attached
    const cfg = { ...(await fetchOrcaWhirlpoolConfig(synthLoader, synth.pool)), direction: 'bToA' as const };
    expect(quoteFn(cfg, drifted)(1_000_000n)).toBe(0n);
  });
});

describe('swap template + staged compile', () => {
  it('encodes the v1 swap instruction (disc, threshold 1, no explicit limit, direction flags)', async () => {
    const cfg = await fetchCfg();
    const template = orcaWhirlpoolLadder.buildSwapV2(cfg, 0, USER);
    expect(template.programId).toBe(address('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'));
    expect([...template.prefix]).toEqual([248, 198, 158, 145, 225, 117, 135, 200]);
    expect(template.patch).toBe('in');
    // threshold u64 = 1, sqrt_price_limit u128 = 0, is_input = 1, a_to_b = 1
    expect([...template.suffix]).toEqual([1, 0, 0, 0, 0, 0, 0, 0, ...new Array(16).fill(0), 1, 1]);
    expect(template.accounts.map((account) => account.ref)).toEqual([
      's0:tp', 'payer', 's0:pool', 'user:in', 's0:va', 'user:out', 's0:vb', 's0:ta0', 's0:ta1', 's0:ta2', 's0:orc',
    ]);
    expect(template.accounts[2].writable).toBe(true);
    expect(template.accounts[10].writable).toBeUndefined(); // oracle read-only (static-fee pool)
    expect(template.accounts[7].address).toBe(TA_N25344);

    const flipped = orcaWhirlpoolLadder.buildSwapV2(asBToA(cfg), 0, USER);
    expect(flipped.suffix[25]).toBe(0); // a_to_b = false
    expect(flipped.accounts[3].ref).toBe('user:out'); // token_owner_account_a receives
    expect(flipped.accounts[7].address).toBe(TA_N25344);
    expect(flipped.accounts[8].address).toBe(TA_N24992);
  });

  it('compiles a one-slot staged shape (helpers, scan, chain, cold final)', async () => {
    const cfg = await fetchCfg();
    const generated = generateEcoSwapSvm({ slots: [{ adapter: orcaWhirlpoolLadder, cfg }], user: USER, cuFloor: 1 });
    expect(generated.shapeKey).toBe('orca-whirlpool:aToB~r2'); // rung count joins the key off the QL_S default
    expect(generated.rungs).toEqual([2]); // CLMM rung economics: 2 by default
    expect(generated.cfgByteLength).toBe(152); // amountIn, minOut, enable, 16 boundary/edge words
    expect(generated.bytecode.length).toBeGreaterThan(1000);
    const refs = generated.accountPlan.metas.map((meta) => meta.ref);
    for (const ref of ['s0:pool', 's0:ta0', 's0:ta1', 's0:ta2', 's0:orc', 's0:prog']) expect(refs).toContain(ref);
    expect(WHIRLPOOL_MAX_BOUNDARIES).toBe(4);
  });

  it('pins the account discriminators the fragment checks live', () => {
    expect(WHIRLPOOL_DISCRIMINATOR).toEqual([0x3f, 0x95, 0xd1, 0x0c, 0xe1, 0x80, 0x63, 0x09]);
    expect(TICK_ARRAY_DISCRIMINATOR).toEqual([0x45, 0x61, 0xbd, 0xbe, 0x6e, 0x07, 0x42, 0xbb]);
    expect(tickArrayPda(POOL, -25344)).toBe(TA_N25344);
  });
});
