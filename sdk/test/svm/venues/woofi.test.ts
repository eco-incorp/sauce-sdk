/**
 * woofi (Solana sPMM) ladder adapter units (no engine, no RPC). See
 * ../../../src/svm/venues/woofi/index.ts for the full math/account-layout
 * citation (source-verified against the audited Anchor program AND
 * cross-checked byte-for-byte against 6 real mainnet swap transactions).
 *
 * THE REAL FIXTURE (SOL/USDC, pool BEz2Suv2WvGKWouU1srbhZfudBGuw9v2VzkhMZHFBdvs,
 * dumped 2026-07-31) is a live example of the venue's OWN feasibility gate
 * firing FOR REAL: at dump time the keeper-posted `wooracle.price` (from
 * 2026-04-ish) sat ~16% away from the live Pyth cross-price — outside the
 * pool's 1% `bound` — so `get_price_impl` is genuinely infeasible right now
 * (this pool's most recent 10 real on-chain swap attempts are ALL failed
 * transactions, consistent with that). This adapter's job is exactly to
 * self-drop (predict 0) rather than emit a value the real program would
 * revert on — see the first describe block. A SYNTHETIC-but-decode-realistic
 * variant (the SAME fixture with only the Pyth price + timestamps patched so
 * the feasibility gate passes, mirroring obric-v2.test.ts's own "the real
 * fixture happens to be degenerate, so the interesting case uses a patched
 * fixture" precedent) exercises the actual sPMM math, monotonicity, and the
 * live-vault capacity clamp — this venue's real vaults are genuinely thin
 * (2.25 USDC / 0.0049 SOL at dump time), so the clamp is not a hypothetical.
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import { fetchWoofiConfig, woofi } from '../../../src/svm/venues/woofi/index.js';
import type { WoofiPoolConfig } from '../../../src/svm/venues/woofi/index.js';
import { woofiLadder, woofiApplyFee, woofiCalcQuoteAmountSellBase, woofiCalcBaseAmountSellQuote } from '../../../src/svm/venues/woofi/ladder.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';

const REAL_FIXTURES = resolve(process.cwd(), 'test/svm/fixtures/woofi');
const PATCHED_FIXTURES = resolve(process.cwd(), 'test/svm/fixtures/woofi-patched');
const POOL = address('BEz2Suv2WvGKWouU1srbhZfudBGuw9v2VzkhMZHFBdvs');
// Well within the patched fixture's updatedAt/publishTime + staleDuration/maximumAge.
const PATCHED_CLOCK = 1_785_600_000n;

describe('fetchWoofiConfig: decodes the real WooAmmPool bundle + resolves the base/quote sides', () => {
  it('SOL is base, USDC is quote (matches the official docs’ named Wooracle addresses)', async () => {
    const fixtures = loadFixtures(REAL_FIXTURES);
    const load = fixtureLoader(fixtures);
    const cfg = await fetchWoofiConfig(load, POOL);
    expect(cfg.direction).toBe('sellBase');
    expect(cfg.tokenMintBase).toBe(address('So11111111111111111111111111111111111111112'));
    expect(cfg.quoteTokenMint).toBe(address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
    // Named in WooFi's own Solana dev docs as "SOL Wooracle" / "USDC Wooracle".
    expect(cfg.wooracleBase).toBe(address('mjkf7dn23RrwPphKvqze2dJcTUAXnXRBSS51qGGLB4Y'));
    expect(cfg.wooracleQuote).toBe(address('Dk1BiYeDuM4PPQDiNNnqaiiKHPEZ65DJSVjdcSwKt4aU'));
    expect(cfg.priceDec).toBe(100_000_000n);
    expect(cfg.quoteDec).toBe(1_000_000n);
    expect(cfg.baseDec).toBe(1_000_000_000n);
    expect(cfg.feeRate).toBe(20n);
    expect(cfg.minSwapAmount).toBe(0n);
  });

  it('rejects a base-to-base bundle (neither/both sides equal quoteTokenMint) — not yet wired, not silently wrong', async () => {
    const fixtures = loadFixtures(REAL_FIXTURES);
    const data = new Map(fixtures.map((f) => [f.address, Buffer.from(f.base64Data, 'base64')]));
    const poolBuf = Buffer.from(data.get(POOL)!);
    // Overwrite quoteTokenMint@457 with an arbitrary third mint so NEITHER side matches.
    const thirdMint = Buffer.from(address('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'), 'utf8');
    void thirdMint; // addresses are base58 strings, not the raw 32 bytes — construct the 32-byte form instead:
    const { getAddressCodec } = await import('@solana/kit');
    const codec = getAddressCodec();
    const raw = codec.encode(address('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'));
    poolBuf.set(new Uint8Array(raw), 457);
    const load = async (addr: string) => (addr === POOL ? new Uint8Array(poolBuf) : (data.get(addr) ? new Uint8Array(data.get(addr)!) : null));
    await expect(fetchWoofiConfig(load as any, POOL)).rejects.toThrow(/base-to-base/);
  });
});

describe('the real fixture: the venue’s OWN feasibility gate is genuinely tripped right now', () => {
  it('self-drops to 0 at every size (stale keeper price, out of bound vs the live Pyth cross-price)', async () => {
    const fixtures = loadFixtures(REAL_FIXTURES);
    const load = fixtureLoader(fixtures);
    const state = fixtureBytesMap(fixtures);
    const cfg = await fetchWoofiConfig(load, POOL);
    const params = woofiLadder.paramsFor(cfg);
    // A "now" far enough from the dumped Pyth publishTime that staleness alone
    // would also explain a 0 (belt-and-suspenders — the bound failure below is
    // independent of this and would still fire even with a fresh clock).
    const quote = woofiLadder.referenceQuote(cfg, state, params, 1_785_540_000n);
    expect(quote(0n)).toBe(0n);
    expect(quote(1_000_000n)).toBe(0n);
    expect(quote(1_000_000_000n)).toBe(0n);
    const caps = woofiLadder.referenceCapacities!(cfg, state, params, 1_785_540_000n);
    expect(caps([1_000_000n, 1_000_000_000n])).toEqual([0n, 0n]);
  });
});

describe('the patched (synthetic-but-decode-realistic) fixture: the sPMM math, both directions', () => {
  let cfg: WoofiPoolConfig;
  let state: ReturnType<typeof fixtureBytesMap>;

  beforeAll(async () => {
    const fixtures = loadFixtures(PATCHED_FIXTURES);
    const load = fixtureLoader(fixtures);
    state = fixtureBytesMap(fixtures);
    cfg = (await fetchWoofiConfig(load, POOL)) as WoofiPoolConfig;
  });

  it('sellBase: quote(0) === 0, monotone nondecreasing, saturates at the real (thin) USDC vault balance', () => {
    const params = woofiLadder.paramsFor(cfg);
    const quote = woofiLadder.referenceQuote(cfg, state, params, PATCHED_CLOCK);
    expect(quote(0n)).toBe(0n);
    let prev = -1n;
    let sawPlateau = false;
    const sizes = Array.from({ length: 60 }, (_, i) => BigInt(Math.floor(2 ** (i / 3))));
    for (const x of sizes) {
      const out = quote(x);
      expect(out >= prev).toBe(true);
      if (out === prev && prev > 0n) sawPlateau = true;
      prev = out;
    }
    expect(sawPlateau).toBe(true); // the real USDC vault (2.25 USDC) genuinely binds within this sweep

    // Exact hand-check at a small, unclamped size (matches swap_math.rs's calc_quote_amount_sell_base
    // + the once, rounding-UP fee — see the file header).
    const priceOut = 8_459_153_000n; // the stored wooracle.price (unchanged by the patch)
    const spread = 999_270_300_000_000n; // this pool's live spread (unchanged by the patch)
    const raw = woofiCalcQuoteAmountSellBase(1_000_000n, priceOut, cfg.coeff, spread, cfg.priceDec, cfg.quoteDec, cfg.baseDec, cfg.maxGamma, cfg.maxNotionalSwap);
    const net = woofiApplyFee(raw, cfg.feeRate);
    expect(quote(1_000_000n)).toBe(net);
    expect(net).toBeGreaterThan(0n);
  });

  it('sellQuote: quote(0) === 0, monotone, saturates at the real (thin) SOL vault balance', () => {
    const rev: WoofiPoolConfig = { ...cfg, direction: 'sellQuote' };
    const params = woofiLadder.paramsFor(rev);
    const quote = woofiLadder.referenceQuote(rev, state, params, PATCHED_CLOCK);
    expect(quote(0n)).toBe(0n);
    let prev = -1n;
    let sawPlateau = false;
    const sizes = Array.from({ length: 60 }, (_, i) => BigInt(Math.floor(2 ** (i / 3))));
    for (const x of sizes) {
      const out = quote(x);
      expect(out >= prev).toBe(true);
      if (out === prev && prev > 0n) sawPlateau = true;
      prev = out;
    }
    expect(sawPlateau).toBe(true);

    const priceOut = 8_459_153_000n;
    const spread = 999_270_300_000_000n;
    const net = woofiApplyFee(1_000n, cfg.feeRate);
    const expected = woofiCalcBaseAmountSellQuote(net, priceOut, cfg.coeff, spread, cfg.priceDec, cfg.quoteDec, cfg.baseDec, cfg.maxGamma, cfg.maxNotionalSwap);
    expect(quote(1_000n)).toBe(expected);
    expect(expected).toBeGreaterThan(0n);
  });

  it('capacityInputVar / referenceCapacities are wired and never exceed the grid point', () => {
    expect(woofiLadder.capacityInputVar).toBeDefined();
    expect(woofiLadder.referenceCapacities).toBeDefined();
    expect(woofiLadder.capacityInputVar!(2)).toBe('s2cx');
    const params = woofiLadder.paramsFor(cfg);
    const caps = woofiLadder.referenceCapacities!(cfg, state, params, PATCHED_CLOCK);
    const grid = [1_000n, 1_000_000n, 100_000_000n, 100_000_000_000n];
    const out = caps(grid);
    out.forEach((c, i) => expect(c).toBeLessThanOrEqual(grid[i]));
    expect(out[0] <= out[1]).toBe(true);
    expect(out[1] <= out[2]).toBe(true);
    expect(out[2]).toBe(out[3]); // saturated well before the largest grid point
  });
});

describe('the emitted fragment compiles as valid SauceScript', () => {
  it.each(['sellBase', 'sellQuote'] as const)('%s: emitSetup + two ladder rungs + emitFinalQuote', async (direction) => {
    const fixtures = loadFixtures(PATCHED_FIXTURES);
    const load = fixtureLoader(fixtures);
    const base = (await fetchWoofiConfig(load, POOL)) as WoofiPoolConfig;
    const cfg: WoofiPoolConfig = { ...base, direction };
    const params = woofiLadder.paramsFor(cfg).map((v) => v.toString());
    const source = [
      'function main() {',
      '  let s0en = 1;',
      woofiLadder.emitSetup(cfg, 0, params),
      woofiLadder.emitLadderQuote!(cfg, 0, 0, '100000', 's0o1'),
      woofiLadder.emitLadderQuote!(cfg, 0, 1, '500000', 's0o2'),
      woofiLadder.emitFinalQuote!(cfg, 0, '250000', 'qFinal'),
      '  return qFinal;',
      '}',
    ].join('\n');
    const { bytecode, accountPlan } = compile(source, { target: 'svm' });
    expect(bytecode[0].length).toBeGreaterThan(0);
    expect(accountPlan?.metas.map((m) => m.ref).sort()).toEqual(['s0:wc', 's0:or', 's0:pb', 's0:pq', 's0:vc', 's0:wp'].sort());
  });
});

describe('woofi (v1 adapter facade): swap accounts + instruction data', () => {
  it('builds a 17-account swap CPI with the disc + amountIn/minOut u128 LE data shape', async () => {
    const fixtures = loadFixtures(PATCHED_FIXTURES);
    const load = fixtureLoader(fixtures);
    const cfg = await fetchWoofiConfig(load, POOL);
    const user = { inAta: 'user:in', outAta: 'user:out', owner: 'payer' };
    const swap = woofi.buildSwap(cfg, user, 1_000_000n);
    expect(swap.accounts).toHaveLength(17);
    expect(swap.data.length).toBe(8 + 16 + 16);
    expect(Array.from(swap.data.subarray(0, 8))).toEqual([248, 198, 158, 145, 225, 117, 135, 200]);
    expect(swap.accounts.filter((a) => a.signer).map((a) => a.ref)).toEqual(['payer']);
  });
});
