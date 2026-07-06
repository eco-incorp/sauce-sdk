/**
 * Meteora DLMM ladder adapter units (no engine, no RPC): mainnet fixture
 * decode, bin price math against the stored bin.price field, worked-example
 * quotes (regression-pinned from the mirror — the venue's quote_exact_in
 * transcription; the lamport-exact engine gate cross-checks the fragment
 * against this mirror), window/re-anchor, the warm chain's merge-safety, fetch
 * gates, swap-instruction encoding, and a full staged compile of a one-slot
 * shape.
 *
 * Fixture: SOL/USDC bin_step=4 pair 5rCf1DM8... + surrounding bin arrays +
 * mints, one-slot mainnet snapshot (slot ~431198953). NOW is pinned past the
 * pair's last_update so update_references(clock) runs the normal decay path.
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import {
  fetchMeteoraDlmmConfig,
  windowArrayIndexes,
  LB_PAIR_DISCRIMINATOR,
  BIN_ARRAY_DISCRIMINATOR,
  METEORA_DLMM_MAX_BINS,
} from '../../../src/svm/venues/meteora-dlmm/index.js';
import type { MeteoraDlmmPoolConfig } from '../../../src/svm/venues/meteora-dlmm/index.js';
import { meteoraDlmmLadder, priceFromId } from '../../../src/svm/venues/meteora-dlmm/ladder.js';
import { binArrayIndex } from '../../../src/svm/venues/meteora-dlmm/bin-math.js';
import type { AccountBytesMap, AccountLoader } from '../../../src/svm/index.js';
import { buildLadder, generateEcoSwapSvm } from '../../../src/recipes/ecoswap/svm/index.js';
import { fixtureBytesMap, fixtureData, fixtureLoader, loadFixtures } from '../fixtures.js';
import { WSOL_MINT, USDC_MINT } from '../ecoswap-svm.fixtures.js';

const PAIR = address('5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6');
const NOW = 1_783_355_400n; // inside the decay window (last_update 1783355346 + 54s) — exercises the variable fee
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };

const fixtures = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/meteora-dlmm'));
const loader = fixtureLoader(fixtures);
const state = fixtureBytesMap(fixtures);
const pairFixture = fixtures.find((f) => f.address === PAIR)!;

const fetchCfg = (): Promise<MeteoraDlmmPoolConfig> => fetchMeteoraDlmmConfig(loader, PAIR);
const asYtoX = (cfg: MeteoraDlmmPoolConfig): MeteoraDlmmPoolConfig => ({ ...cfg, direction: 'yToX' });
const quoteFn = (cfg: MeteoraDlmmPoolConfig, bytes: AccountBytesMap = state) =>
  meteoraDlmmLadder.referenceQuote(cfg, bytes, meteoraDlmmLadder.paramsFor(cfg), NOW);

function doctoredLoader(mutate: (data: Uint8Array) => void): AccountLoader {
  const data = fixtureData(pairFixture);
  mutate(data);
  return async (addr) => (addr === PAIR ? data : loader(addr));
}

describe('meteora-dlmm bin math', () => {
  it('priceFromId equals the stored bin.price (Q64.64 pow), monotone in id', () => {
    expect(priceFromId(0, 4)).toBe(18446744073709551616n); // 2^64
    expect(priceFromId(-6241, 4)).toBe(1520420633046447680n); // stored bin -6241 price
    expect(priceFromId(-6240, 4)).toBe(1521028801299666259n);
    expect(priceFromId(-6260, 4)).toBeLessThan(priceFromId(-6259, 4));
  });

  it('binArrayIndex floors toward negative infinity', () => {
    expect(binArrayIndex(-6260)).toBe(-90); // floor(-6260/70)
    expect(binArrayIndex(0)).toBe(0);
    expect(binArrayIndex(-1)).toBe(-1);
    expect(windowArrayIndexes(-6260, true)).toEqual([-90, -91, -92]);
    expect(windowArrayIndexes(-6260, false)).toEqual([-90, -89, -88]);
  });
});

describe('meteora-dlmm fetchPoolConfig on the mainnet fixture', () => {
  it('decodes the pinned pair fields (snapshot slot ~431198953)', async () => {
    const cfg = await fetchCfg();
    expect(cfg.activeId).toBe(-6260);
    expect(cfg.binStep).toBe(4);
    expect(cfg.baseFactor).toBe(10000);
    expect(cfg.variableFeeControl).toBe(120000);
    expect(cfg.maxVolatilityAccumulator).toBe(300000);
    expect(cfg.collectFeeMode).toBe(0);
    expect(cfg.tokenXMint).toBe(WSOL_MINT);
    expect(cfg.tokenYMint).toBe(USDC_MINT);
  });

  it('derives both direction bin windows (xToY down, yToX up) and the params', async () => {
    const cfg = await fetchCfg();
    expect(cfg.windows.xToY.bins.map((b) => b.binId)).toEqual([-6260, -6261, -6262, -6263, -6264, -6265, -6266, -6267]);
    expect(cfg.windows.yToX.bins.map((b) => b.binId)).toEqual([-6260, -6259, -6258, -6257, -6256, -6255, -6254, -6253]);
    expect(cfg.windows.xToY.bins[0].price).toBe(priceFromId(-6260, 4));

    const params = meteoraDlmmLadder.paramsFor(cfg);
    expect(params).toHaveLength(7 + 1 + 3 * METEORA_DLMM_MAX_BINS);
    expect(params[0]).toBe(10000n * 4n * 10n); // base fee = base_factor*bin_step*10*10^0 = 400000
    expect(params[1]).toBe(4n); // bin step
    expect(params[7]).toBe(8n); // nb
    expect(params[8] & 0xffffffffn).toBe(2147483648n - 6260n); // biased active bin id
  });

  it('gates collect_fee_mode, limit orders, non-Enabled, sizes/discriminators, Token-2022', async () => {
    await expect(fetchMeteoraDlmmConfig(doctoredLoader((d) => (d[8 + 28] = 1)), PAIR)).rejects.toThrow(/collect_fee_mode/);
    await expect(fetchMeteoraDlmmConfig(doctoredLoader((d) => (d[8 + 27] = 1)), PAIR)).rejects.toThrow(/limit orders/); // function_type=LimitOrder
    await expect(fetchMeteoraDlmmConfig(doctoredLoader((d) => (d[8 + 74] = 1)), PAIR)).rejects.toThrow(/not Enabled/);
    await expect(fetchMeteoraDlmmConfig(doctoredLoader((d) => (d[8 + 872] = 1)), PAIR)).rejects.toThrow(/Token-2022/);
    const truncated = fixtureData(pairFixture).subarray(0, 800);
    await expect(fetchMeteoraDlmmConfig(async () => truncated, PAIR)).rejects.toThrow(/904/);
    await expect(fetchMeteoraDlmmConfig(doctoredLoader((d) => (d[0] ^= 0xff)), PAIR)).rejects.toThrow(/discriminator/);
  });
});

describe('meteora-dlmm worked examples (regression-pinned from the mirror)', () => {
  it('xToY SOL -> USDC (swap_for_y, walks down)', async () => {
    const quote = quoteFn(await fetchCfg());
    expect(quote(1_000_000_000n)).toBe(81_732_707n);
    expect(quote(5_000_000_000n)).toBe(408_662_622n);
    expect(quote(0n)).toBe(0n);
  });

  it('yToX USDC -> SOL (walks up)', async () => {
    const quote = quoteFn(asYtoX(await fetchCfg()));
    expect(quote(100_000_000n)).toBe(1_222_030_256n);
    expect(quote(1_000_000_000n)).toBe(12_220_302_614n);
  });

  it('the warm chain equals the cold quotes pointwise and stays monotone (no negative dOut)', async () => {
    const cfg = await fetchCfg();
    const amountIn = 5_000_000_000n;
    const cold = quoteFn(cfg);
    const chain = meteoraDlmmLadder.referenceLadderQuotes!(cfg, state, meteoraDlmmLadder.paramsFor(cfg), NOW);
    const rungs = buildLadder(cold, amountIn, 4, chain);
    for (const rung of rungs) {
      expect(rung.dOut).toBeGreaterThanOrEqual(0n);
      expect(rung.dIn).toBeGreaterThan(0n);
    }
    const grid = [amountIn >> 3n, amountIn >> 2n, amountIn >> 1n, amountIn];
    expect(grid.map(cold)).toEqual(chain(grid));
  });
});

describe('meteora-dlmm swap template + staged compile', () => {
  it('encodes the swap instruction (disc, min_out 1) and the DLMM account order', async () => {
    const cfg = await fetchCfg();
    const template = meteoraDlmmLadder.buildSwapV2(cfg, 0, USER);
    expect(template.programId).toBe(address('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'));
    expect([...template.prefix]).toEqual([248, 198, 158, 145, 225, 117, 135, 200]);
    expect([...template.suffix]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(template.accounts.map((a) => a.ref)).toEqual([
      's0:pair', 's0:bmx', 's0:rx', 's0:ry', 'user:in', 'user:out', 's0:mx', 's0:my', 's0:orc',
      's0:prog', 'payer', 's0:tpx', 's0:tpy', 's0:evt', 's0:prog', 's0:ba0', 's0:ba1', 's0:ba2',
    ]);
    const flipped = meteoraDlmmLadder.buildSwapV2(asYtoX(cfg), 0, USER);
    expect(flipped.accounts[4].ref).toBe('user:out'); // yToX: user_token_in is the y-side (out ata role)
    expect(flipped.accounts[5].ref).toBe('user:in');
  });

  it('compiles a one-slot staged shape (fee unpack, update_references, bin walk)', async () => {
    const cfg = await fetchCfg();
    const generated = generateEcoSwapSvm({ slots: [{ adapter: meteoraDlmmLadder, cfg }], user: USER, cuFloor: 1 });
    expect(generated.shapeKey).toBe('meteora-dlmm:xToY~r2');
    expect(generated.rungs).toEqual([2]);
    expect(generated.cfgByteLength).toBe((2 + 1 + (7 + 1 + 3 * METEORA_DLMM_MAX_BINS)) * 8);
    expect(generated.bytecode.length).toBeGreaterThan(1000);
    const refs = generated.accountPlan.metas.map((m) => m.ref);
    for (const ref of ['s0:pair', 's0:ba0', 's0:ba1', 's0:ba2', 's0:prog']) expect(refs).toContain(ref);
  });

  it('pins the account discriminators the fragment/fetch check', () => {
    expect(LB_PAIR_DISCRIMINATOR).toEqual([0x21, 0x0b, 0x31, 0x62, 0xb5, 0x65, 0xb1, 0x0d]);
    expect(BIN_ARRAY_DISCRIMINATOR).toEqual([0x5c, 0x8e, 0x5c, 0xdc, 0x05, 0x94, 0x46, 0xb5]);
  });
});
