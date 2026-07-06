/**
 * Manifest CLOB ladder adapter units (no engine, no RPC): mainnet fixture
 * decode against the source field layout, worked-example quotes pinned from an
 * INDEPENDENT direct port of the venue's taker math (impact_base_atoms +
 * place_order + checked_*_for_* — a throwing transcription written separately
 * from the adapter over the SAME dumped market, sharing nothing but the venue),
 * the conversion round-trips, the best-first order walk, the global/expiring
 * stop and seq-mismatch drift on synthetic books, ladder monotonicity +
 * top-of-book saturation, swap-instruction encoding, and a full staged compile.
 *
 * Fixture: SOL/USDC market ENhU8LsaR7... + its two vaults + WSOL/USDC mints,
 * one mainnet snapshot (2026-07-06) — see fixtures/manifest/README.md. The
 * pinned numbers are reproducible from the checked-in fixture via
 * scratchpad/independent-manifest.py (the independent port).
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import {
  fetchManifestConfig,
  MANIFEST_MAX_ORDERS,
  MARKET_DISCRIMINANT,
  MARKET_FIXED_SIZE,
} from '../../../src/svm/venues/manifest/index.js';
import type { ManifestPoolConfig } from '../../../src/svm/venues/manifest/index.js';
import {
  manifestBaseForQuote,
  manifestLadder,
  manifestQuoteForBase,
} from '../../../src/svm/venues/manifest/ladder.js';
import type { AccountBytesMap, AccountLoader } from '../../../src/svm/index.js';
import { buildLadder, generateEcoSwapSvm } from '../../../src/recipes/ecoswap/svm/index.js';
import { fixtureBytesMap, fixtureData, fixtureLoader, loadFixtures } from '../fixtures.js';
import {
  manifestPriceInner,
  ORDER_GLOBAL,
  ORDER_POST_ONLY,
  ORDER_REVERSE,
  synthesizeManifestMarket,
} from '../manifest.fixtures.js';
import { randomAddr, syntheticMintBytes, USDC_MINT, WSOL_MINT } from '../ecoswap-svm.fixtures.js';

const POOL = address('ENhU8LsaR7vDD2G1CsWcsuSGNrih9Cv5WZEk7q9kPapQ');
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };

const fixtures = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/manifest'));
const loader = fixtureLoader(fixtures);
const state = fixtureBytesMap(fixtures);
const marketFixture = fixtures.find((fixture) => fixture.address === POOL)!;

const fetchCfg = (): Promise<ManifestPoolConfig> => fetchManifestConfig(loader, POOL);
const asQuoteIn = (cfg: ManifestPoolConfig): ManifestPoolConfig => ({ ...cfg, direction: 'quoteIn' });
const quoteFn = (cfg: ManifestPoolConfig, bytes: AccountBytesMap = state) =>
  manifestLadder.referenceQuote(cfg, bytes, manifestLadder.paramsFor(cfg));

function doctoredLoader(mutate: (data: Uint8Array) => void): AccountLoader {
  const data = fixtureData(marketFixture);
  mutate(data);
  return async (addr) => (addr === POOL ? data : loader(addr));
}

// Synthetic-book loader: overlay the market + vaults + 82-byte mints.
const synthLoader = (accounts: { address: Address; owner: Address; data: Uint8Array }[]): AccountLoader => {
  const mints: Record<string, Uint8Array> = { [WSOL_MINT]: syntheticMintBytes(9), [USDC_MINT]: syntheticMintBytes(6) };
  return async (addr) => {
    for (const account of accounts) if (account.address === addr) return new Uint8Array(account.data);
    return mints[addr] === undefined ? null : new Uint8Array(mints[addr]);
  };
};
const synthState = (accounts: { address: Address; data: Uint8Array }[]): AccountBytesMap => {
  const bytes: AccountBytesMap = {};
  for (const account of accounts) bytes[account.address] = new Uint8Array(account.data);
  return bytes;
};

describe('price conversions (quantities.rs)', () => {
  it('quote_for_base and base_for_quote round-trip with the documented rounding', () => {
    const D18 = 1_000_000_000_000_000_000n;
    // price 2.0 quote atoms per base atom -> inner = 2e18.
    const price = 2n * D18;
    expect(manifestQuoteForBase(price, 1000n, false)).toBe(2000n); // 2 * 1000
    expect(manifestQuoteForBase(price, 1000n, true)).toBe(2000n);
    expect(manifestBaseForQuote(price, 2000n, false)).toBe(1000n);
    // Fractional price 1.5, rounding sides differ.
    const p15 = (3n * D18) / 2n;
    expect(manifestQuoteForBase(p15, 3n, false)).toBe(4n); // floor(4.5)
    expect(manifestQuoteForBase(p15, 3n, true)).toBe(5n); // ceil(4.5)
    expect(manifestQuoteForBase(price, 0n, true)).toBe(0n);
    expect(manifestBaseForQuote(0n, 1000n, false)).toBe(0n);
  });
});

describe('fetchManifestConfig on the mainnet fixture', () => {
  it('decodes the pinned market header fields', async () => {
    const cfg = await fetchCfg();
    expect(cfg.baseMint).toBe(WSOL_MINT);
    expect(cfg.quoteMint).toBe(USDC_MINT);
    expect(cfg.baseDecimals).toBe(9);
    expect(cfg.quoteDecimals).toBe(6);
    expect(cfg.baseVault).toBe(address('AKjfJDv4ywdpCDrj7AURuNkGA3696GTVFgrMwk4TjkKs'));
    expect(cfg.quoteVault).toBe(address('FN9K6rTdWtRDUPmLTN2FnGvLZpHVNRN2MeRghKknSGDs'));
    expect(cfg.direction).toBe('baseIn');
    expect(MARKET_DISCRIMINANT).toBe(4_859_840_929_024_028_656n);
  });

  it('walks both book sides best-first (monotone prices, capped at MANIFEST_MAX_ORDERS)', async () => {
    const cfg = await fetchCfg();
    // The snapshot's asks side is deep (capped at 16); the bids side has 10.
    expect(cfg.windows.quoteIn.orders.length).toBe(MANIFEST_MAX_ORDERS);
    expect(cfg.windows.baseIn.orders.length).toBe(10);
    // Each level's live price is monotone-worsening in walk order.
    const priceOf = (dataIndex: number): bigint => {
      const base = MARKET_FIXED_SIZE + dataIndex;
      const raw = fixtureData(marketFixture);
      let v = 0n;
      for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(raw[base + 16 + i]);
      return v;
    };
    const asks = cfg.windows.quoteIn.orders.map((o) => priceOf(o.dataIndex));
    for (let i = 1; i < asks.length; i++) expect(asks[i]).toBeGreaterThanOrEqual(asks[i - 1]); // asks ascending
    const bids = cfg.windows.baseIn.orders.map((o) => priceOf(o.dataIndex));
    for (let i = 1; i < bids.length; i++) expect(bids[i]).toBeLessThanOrEqual(bids[i - 1]); // bids descending
    // params: [nb, (DataIndex, seq) x MANIFEST_MAX_ORDERS].
    const params = manifestLadder.paramsFor(cfg);
    expect(params).toHaveLength(1 + 2 * MANIFEST_MAX_ORDERS);
    expect(params[0]).toBe(10n);
  });

  it('gates a foreign discriminant and a non-classic-SPL mint', async () => {
    await expect(fetchManifestConfig(doctoredLoader((data) => (data[0] ^= 0xff)), POOL)).rejects.toThrow(/discriminant/);
    await expect(fetchManifestConfig(async () => new Uint8Array(200), POOL)).rejects.toThrow(/>= 256|MarketFixed/);
    // A Token-2022-sized (non-82-byte) mint is rejected.
    const bigMint: AccountLoader = async (addr) => (addr === WSOL_MINT ? new Uint8Array(200) : loader(addr));
    await expect(fetchManifestConfig(bigMint, POOL)).rejects.toThrow(/classic SPL/);
  });
});

describe('worked examples (pinned from the independent Manifest port)', () => {
  it('quoteIn: USDC in, SOL out', async () => {
    const quote = quoteFn(asQuoteIn(await fetchCfg()));
    expect(quote(1_000_000n)).toBe(12_445_225n);
    expect(quote(100_000_000n)).toBe(1_244_522_576n);
    expect(quote(1_000_000_000n)).toBe(12_381_694_976n);
    expect(quote(5_000_000_000n)).toBe(36_607_379_770n); // exhausts the 16-level ask window
    expect(quote(50_000_000_000n)).toBe(36_607_379_770n); // saturated — no out-of-window fallback
  });

  it('baseIn: SOL in, USDC out', async () => {
    const quote = quoteFn(await fetchCfg());
    expect(quote(1_000_000_000n)).toBe(80_216_939n);
    expect(quote(5_000_000_000n)).toBe(401_084_700n);
    expect(quote(10_000_000_000n)).toBe(801_614_101n);
    expect(quote(50_000_000_000n)).toBe(3_361_566_055n); // exhausts the bid side
  });

  it('quotes 0 at zero input; the ladder is monotone and saturates', async () => {
    const cfg = await fetchCfg();
    expect(quoteFn(cfg)(0n)).toBe(0n);
    const grid = [10_000_000_000n, 20_000_000_000n, 40_000_000_000n, 80_000_000_000n];
    const rungs = buildLadder(quoteFn(cfg), 80_000_000_000n, 4);
    let prev = 0n;
    for (const rung of rungs) {
      expect(rung.dOut).toBeGreaterThanOrEqual(0n); // monotone, no negative rung
      expect(rung.dIn).toBeGreaterThan(0n);
    }
    // pointwise cold quote at the grid == cumulative rung outputs (no warm-start).
    let cum = 0n;
    grid.forEach((g, i) => {
      cum += rungs[i].dOut;
      expect(quoteFn(cfg)(g)).toBe(cum);
      prev = g;
    });
    expect(prev).toBe(80_000_000_000n);
  });

  it('reports a book-depth metric for both directions', async () => {
    const cfg = await fetchCfg();
    expect(manifestLadder.depthReserves(cfg, state)).toEqual({ reserveIn: 42_006_323_006n, reserveOut: 3_361_566_055n });
    expect(manifestLadder.depthReserves(asQuoteIn(cfg), state)).toEqual({ reserveIn: 2_991_397_830n, reserveOut: 36_607_379_770n });
    expect(manifestLadder.continuousFees()).toEqual({ gammaPpm: 1_000_000n, muPpm: 1_000_000n }); // zero fee
  });
});

describe('synthetic books (walk stops, drift, exact levels)', () => {
  const priceLevels = [manifestPriceInner(2.0), manifestPriceInner(1.9), manifestPriceInner(1.8)];

  it('quoteIn exact split across two ask levels (level boundaries, taker rounding)', async () => {
    // Two asks: 100 base @ 2.0, 100 base @ 2.1.
    const synth = synthesizeManifestMarket({
      side: 'asks',
      baseMint: WSOL_MINT,
      quoteMint: USDC_MINT,
      orders: [
        { priceInner: manifestPriceInner(2.0), size: 100n },
        { priceInner: manifestPriceInner(2.1), size: 100n },
      ],
    });
    const cfg = { ...(await fetchManifestConfig(synthLoader(synth.accounts), synth.market)), direction: 'quoteIn' as const };
    const quote = manifestLadder.referenceQuote(cfg, synthState(synth.accounts), manifestLadder.paramsFor(cfg));
    // 100 quote at price 2.0 buys floor(1e18*100/2e18) = 50 base (first level has 100, so partial).
    expect(quote(100n)).toBe(50n);
    // 200 quote buys all 100 of level 0 (costs floor(2*100)=200), remaining 0 -> 100 base.
    expect(quote(200n)).toBe(100n);
    // 300 quote: full level0 (100 base, 200 quote), remaining 100 quote at 2.1 -> floor(1e18*100/2.1e18)=47.
    expect(quote(300n)).toBe(147n);
    // Beyond both levels -> saturates at 200 base.
    expect(quote(100_000n)).toBe(200n);
  });

  it('baseIn exact fill across two bid levels', async () => {
    const synth = synthesizeManifestMarket({
      side: 'bids',
      baseMint: WSOL_MINT,
      quoteMint: USDC_MINT,
      orders: [
        { priceInner: manifestPriceInner(2.0), size: 100n },
        { priceInner: manifestPriceInner(1.9), size: 100n },
      ],
    });
    const cfg = await fetchManifestConfig(synthLoader(synth.accounts), synth.market);
    const quote = manifestLadder.referenceQuote(cfg, synthState(synth.accounts), manifestLadder.paramsFor(cfg));
    // Sell 100 base fully at bid 2.0 -> 200 quote (round up on full fill).
    expect(quote(100n)).toBe(200n);
    // Sell 150 base: 100 @2.0 (200, full UP) + 50 @1.9 (floor(1.9*50)=95, partial DOWN) = 295.
    expect(quote(150n)).toBe(295n);
    // Sell 200: full both -> 200 + ceil-full 190 = 390.
    expect(quote(200n)).toBe(390n);
    // Sell beyond depth saturates at 390.
    expect(quote(1000n)).toBe(390n);
  });

  it('stops the shipped walk at the first global or expiring maker (venue taker halt)', async () => {
    const withGlobal = synthesizeManifestMarket({
      side: 'asks',
      baseMint: WSOL_MINT,
      quoteMint: USDC_MINT,
      orders: [
        { priceInner: priceLevels[0], size: 100n },
        { priceInner: priceLevels[1], size: 100n, orderType: ORDER_GLOBAL }, // halts here
        { priceInner: priceLevels[2], size: 100n },
      ],
    });
    const cfgG = await fetchManifestConfig(synthLoader(withGlobal.accounts), withGlobal.market);
    expect(cfgG.windows.quoteIn.orders.length).toBe(1); // only the pre-global level shipped

    const withExpiring = synthesizeManifestMarket({
      side: 'asks',
      baseMint: WSOL_MINT,
      quoteMint: USDC_MINT,
      orders: [
        { priceInner: priceLevels[0], size: 100n },
        { priceInner: priceLevels[1], size: 100n, lastValidSlot: 42 }, // expiring -> model-stop
        { priceInner: priceLevels[2], size: 100n },
      ],
    });
    const cfgE = await fetchManifestConfig(synthLoader(withExpiring.accounts), withExpiring.market);
    expect(cfgE.windows.quoteIn.orders.length).toBe(1);

    // Reverse and post-only makers ARE takeable (only global/expiring stop).
    const withReverse = synthesizeManifestMarket({
      side: 'asks',
      baseMint: WSOL_MINT,
      quoteMint: USDC_MINT,
      orders: [
        { priceInner: priceLevels[0], size: 100n, orderType: ORDER_REVERSE },
        { priceInner: priceLevels[1], size: 100n, orderType: ORDER_POST_ONLY },
      ],
    });
    const cfgR = await fetchManifestConfig(synthLoader(withReverse.accounts), withReverse.market);
    expect(cfgR.windows.quoteIn.orders.length).toBe(2);
  });

  it('self-deactivates the walk on a seq mismatch (a shipped order was filled/reused)', async () => {
    const synth = synthesizeManifestMarket({
      side: 'bids',
      baseMint: WSOL_MINT,
      quoteMint: USDC_MINT,
      orders: [
        { priceInner: manifestPriceInner(2.0), size: 100n, seq: 500n },
        { priceInner: manifestPriceInner(1.9), size: 100n, seq: 501n },
      ],
    });
    const cfg = await fetchManifestConfig(synthLoader(synth.accounts), synth.market);
    const params = manifestLadder.paramsFor(cfg);
    const baseNoDrift = synthState(synth.accounts);
    expect(manifestLadder.referenceQuote(cfg, baseNoDrift, params)(200n)).toBe(390n);

    // Doctor block 0's live sequence_number (the order was cancelled + the slot
    // reused) -> the fragment stops at level 0, quoting 0.
    const drifted = synthState(synth.accounts);
    const market = drifted[synth.market];
    const seqOffset = MARKET_FIXED_SIZE + 0 + 16 + 24;
    for (let i = 0; i < 8; i++) market[seqOffset + i] = 0;
    market[seqOffset] = 0xff; // seq now != shipped 500
    expect(manifestLadder.referenceQuote(cfg, drifted, params)(200n)).toBe(0n);

    // Doctoring only the SIZE (partial fill, seq intact) stays exact on the live size.
    const partial = synthState(synth.accounts);
    const m2 = partial[synth.market];
    const sizeOffset = MARKET_FIXED_SIZE + 0 + 16 + 16;
    for (let i = 0; i < 8; i++) m2[sizeOffset + i] = 0;
    m2[sizeOffset] = 40; // block 0 size now 40 (was 100)
    // Sell 200: 40 @2.0 (full, 80) + 100 @1.9 (full, 190) = 270; remaining 60 unmatched.
    expect(manifestLadder.referenceQuote(cfg, partial, params)(200n)).toBe(270n);
  });
});

describe('swap template + staged compile', () => {
  it('encodes the Swap instruction (disc 4, min_out 1, direction + exact-in flags, 8 accounts)', async () => {
    const cfg = await fetchCfg();
    const sell = manifestLadder.buildSwapV2(cfg, 0, USER);
    expect(sell.programId).toBe(address('MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms'));
    expect([...sell.prefix]).toEqual([4]);
    expect(sell.patch).toBe('in');
    // out_atoms u64 = 1, is_base_in = 1 (baseIn), is_exact_in = 1.
    expect([...sell.suffix]).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    expect(sell.accounts.map((a) => a.ref)).toEqual([
      'payer', 's0:mkt', 's0:sys', 'user:in', 'user:out', 's0:bv', 's0:qv', 's0:tp',
    ]);
    expect(sell.accounts[0].signer).toBe(true);
    expect(sell.accounts[1].writable).toBe(true);

    const buy = manifestLadder.buildSwapV2(asQuoteIn(cfg), 0, USER);
    expect(buy.suffix[8]).toBe(0); // is_base_in = false
    expect(buy.accounts[3].ref).toBe('user:out'); // trader_base receives on a buy
    expect(buy.accounts[4].ref).toBe('user:in'); // trader_quote is spent
  });

  it('compiles a one-slot staged shape (helpers, order reads, ladder walk, cold final)', async () => {
    const cfg = await fetchCfg();
    const generated = generateEcoSwapSvm({ slots: [{ adapter: manifestLadder, cfg }], user: USER, cuFloor: 1 });
    expect(generated.shapeKey).toBe('manifest:baseIn~r2'); // 2 rungs (heavy setup) — rung count joins the key off QL_S
    expect(generated.rungs).toEqual([2]);
    expect(generated.cfgByteLength).toBe((2 + 1 + (1 + 2 * MANIFEST_MAX_ORDERS)) * 8); // amountIn, minOut, enable, params
    expect(generated.bytecode.length).toBeGreaterThan(1000);
    const refs = generated.accountPlan.metas.map((meta) => meta.ref);
    for (const ref of ['s0:mkt', 's0:bv', 's0:qv', 's0:tp', 's0:prog']) expect(refs).toContain(ref);
  });
});
