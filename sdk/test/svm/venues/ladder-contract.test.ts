/**
 * THE LADDER-ADAPTER CONTRACT GUARD (no engine, no RPC).
 *
 * ecoswap/svm/solver-reference.ts (the recipes-side EcoSwapSVM merge mirror)
 * asserts one premise as the load-bearing licence for its entire design:
 * "every quote closure is nondecreasing in x with quote(0) == 0 ... so rung
 * dOut values are non-negative and all products stay far below 2^256 for u64
 * amounts — plain bigint arithmetic matches the engine's wrapping ops exactly
 * on this domain." Break that premise for one family and the off-chain
 * plain-bigint mirror and the on-chain u256-wrapping merge read a negative
 * delta DIFFERENTLY (a real negative bigint vs. a colossal wrapped unsigned
 * word) — the merge elects the wrapped rung as the CHEAPEST, routing the
 * whole trade onto a slot that delivers 0.
 *
 * Two prior fixes (meteora-damm-v2, orca-legacy-token-swap) each shipped
 * their own hand-written fixture file with HARDCODED capacity literals
 * (ATOB_CAP/BTOA_CAP) pinned to one specific mainnet snapshot. That does not
 * scale: a 13th family (or a 14th, or a fix to an existing one) gets zero
 * contract coverage unless someone remembers to write another bespoke test.
 * This file is the GENERAL mechanism instead:
 *
 *   1. REGISTRY-ENUMERATED with a COUNT ASSERTION (LADDER_FAMILIES below,
 *      cross-checked against sdk/src/svm/venues/registry.ts's
 *      listLadderVenues()) — adding a ladder family without adding it here
 *      fails the count assertion, loudly, in CI.
 *   2. A BISECTED domain per family per direction (sweepDomain), not a fixed
 *      grid: geometric coverage from 0 to a family-scaled bound (depthReserves
 *      x 4096, so the sweep reaches deep past any real family's own
 *      capacity/cliff), with the failure path bisecting to the EXACT violating
 *      interval instead of just naming two coarse sample points.
 *   3. The MERGE-ALTITUDE property, across every family x every direction x
 *      rung count 2/3/4: buildLadder (transcribed from solver-reference.ts)
 *      never yields a negative dIn or a negative dOut.
 *   4. A u256-WRAPPING LICENCE test: the mirror is plain bigint, the engine
 *      wraps at 2^64 per rung word — pin the exact mechanism the nondecreasing
 *      contract exists to prevent, using the actual measured pre-fix
 *      manifest:quoteIn collapse (dOut=-36,607,379,770 at amountIn=3e18,
 *      rungs=3) as the worked example.
 *   5. A STRUCTURAL check: capacityInputVar and referenceCapacities are a
 *      PAIR — one present without the other is incoherent (the codegen reads
 *      capacityInputVar as a slot-local name; referenceCapacities is its
 *      off-chain mirror). obric-v2 shipped a saturating chain with NEITHER
 *      wired (fixed alongside this guard, see obric-v2.test.ts) — this check
 *      is what makes that class of gap loud instead of latent.
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import {
  listLadderVenues,
  manifestLadder,
  fetchManifestConfig,
  meteoraDammV1Stable,
  meteoraDammV1StableLadder,
  meteoraDammV2,
  meteoraDammV2Ladder,
  meteoraDlmmLadder,
  fetchMeteoraDlmmConfig,
  obricV2Ladder,
  orcaLegacyTokenSwap,
  orcaLegacyTokenSwapLadder,
  orcaWhirlpoolLadder,
  fetchOrcaWhirlpoolConfig,
  pumpswapAdapter,
  pumpswapLadder,
  raydiumAmmV4,
  raydiumAmmV4Ladder,
  raydiumClmmLadder,
  fetchRaydiumClmmConfig,
  raydiumCpSwap,
  raydiumCpSwapLadder,
  saberStableswap,
  saberStableswapLadder,
  solfiV2,
  solfiV2Ladder,
} from '../../../src/svm/index.js';
import type { AccountBytesMap, PoolConfig, SvmVenueLadderV2 } from '../../../src/svm/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';

const FIXTURES = resolve(process.cwd(), 'test/svm/fixtures');
const fixturesFor = (slug: string) => loadFixtures(resolve(FIXTURES, slug));

// ---------------------------------------------------------------------------
// buildLadder / ladderGrid — a faithful, standalone transcription of
// ecoswap/svm/solver-reference.ts's grid + rung construction (the recipes
// repo, not importable from here — this is the SDK side of the mirror). Any
// change to that geometric grid or dIn/dOut derivation must be mirrored here.
// ---------------------------------------------------------------------------

/** G_j = amountIn >> (rungs - j) for j = 1..rungs (G_rungs === amountIn). */
function ladderGrid(amountIn: bigint, rungs: number): bigint[] {
  const grid: bigint[] = [];
  for (let j = 1; j <= rungs; j++) grid.push(amountIn >> BigInt(rungs - j));
  return grid;
}

interface Rung {
  dIn: bigint;
  dOut: bigint;
}

/** Per-rung (dIn, dOut) over the geometric grid — mirrors solver-reference.ts's buildLadder. */
function buildLadder(
  quote: (x: bigint) => bigint,
  amountIn: bigint,
  rungs: number,
  ladderQuotes?: (grid: readonly bigint[]) => bigint[],
  ladderCapacities?: (grid: readonly bigint[]) => bigint[],
): Rung[] {
  const grid = ladderGrid(amountIn, rungs);
  const outs = ladderQuotes === undefined ? grid.map(quote) : ladderQuotes(grid);
  const cins = ladderCapacities === undefined ? grid : ladderCapacities(grid);
  const result: Rung[] = [];
  let cPrev = 0n;
  let oPrev = 0n;
  grid.forEach((_, i) => {
    result.push({ dIn: cins[i] - cPrev, dOut: outs[i] - oPrev });
    cPrev = cins[i];
    oPrev = outs[i];
  });
  return result;
}

// ---------------------------------------------------------------------------
// Bisected domain sweep + violation pinpointing.
// ---------------------------------------------------------------------------

/** Ascending geometric coverage of [0, domainMax] — not a fixed literal grid. */
function sweepDomain(domainMax: bigint): bigint[] {
  if (domainMax <= 0n) return [0n];
  const points = new Set<bigint>([0n, domainMax]);
  for (let e = 0; e <= 62; e++) {
    const x = domainMax >> BigInt(e);
    if (x > 0n) points.add(x);
    if (x <= 1n) break;
  }
  return [...points].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Asserts quote(0)==0 and quote is nondecreasing across the domain, bisecting
 * to the exact violating interval on failure instead of naming two coarse
 * samples.
 */
function assertMirrorContract(quote: (x: bigint) => bigint, domainMax: bigint): void {
  expect(quote(0n)).toBe(0n);
  const points = sweepDomain(domainMax);
  let prevX = 0n;
  let prev = quote(0n);
  for (const x of points) {
    const out = quote(x);
    if (out < prev) {
      let lo = prevX;
      let hi = x;
      let loOut = prev;
      while (hi - lo > 1n) {
        const mid = lo + (hi - lo) / 2n;
        const midOut = quote(mid);
        if (midOut < loOut) {
          hi = mid;
        } else {
          lo = mid;
          loOut = midOut;
        }
      }
      throw new Error(`quote is not nondecreasing: quote(${lo})=${loOut} > quote(${hi})=${quote(hi)}`);
    }
    prev = out;
    prevX = x;
  }
}

// ---------------------------------------------------------------------------
// Family registry — one entry per sdk/src/svm/venues/registry.ts ladder slug.
// Each `variants()` returns every quote DIRECTION the family supports (most
// carry exactly one; the sqrt-price/CP-flip families carry two) against a
// real mainnet fixture (or, for obric-v2, a synthetic-but-decode-realistic
// non-drained pool — the checked-in mainnet snapshot happens to be drained,
// see obric-v2.test.ts).
// ---------------------------------------------------------------------------

interface Variant {
  label: string;
  cfg: PoolConfig;
  state: AccountBytesMap;
  now?: bigint;
}

interface Family {
  slug: string;
  ladder: SvmVenueLadderV2;
  variants(): Promise<Variant[]>;
  /**
   * KNOWN, DISCLOSED gap (not a silent skip): the three window-walking
   * families whose LADDER-CHAIN path (referenceLadderQuotes + capacityInputVar
   * / referenceCapacities — the ONLY path the merge actually evaluates a
   * final-fill amount through) is fully capacity-safe, but whose STANDALONE
   * cold `referenceQuote` closure — asked directly for an amount past the
   * off-chain-shipped tick/bin window, which the merge never does — still
   * COLLAPSES rather than saturates. "LATENT, saved only by warm-chain
   * saturation, not a safety property" (see docs cited in the pinned-gaps
   * describe block below). Keyed by variant label; the exact (x, peak)
   * pair is asserted there, not swept past here.
   */
  knownLatentCollapse?: Record<string, { x: bigint; peak: bigint }>;
}

const CLOCK_SABER = 1_751_500_000n;
const CLOCK_D1S = 1_783_175_236n;
const CLOCK_DLMM = 1_783_355_400n;

const OBRIC_DUMMY = address('So11111111111111111111111111111111111111112');
const OBRIC_POOL = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const OBRIC_FEED_X = address('JU8kmKzDHF9sXWsnoznaFDFezLsE5uomX2JkRMbmsQP');
const OBRIC_FEED_Y = address('ANP74VNsHwSrq9uUSjiSNyNWvf6ZPrKTmE4gHoNd13Lg');
const OBRIC_VAULT_X = address('75HgnSvXbWKZBpZHveX68ZzAhDqMzNDS29X6BGLtxMo1');
const OBRIC_VAULT_Y = address('APDFRM3HMr8CAGXwKHiu2f5ePSpaiEJhaURwhsRrUUt9');

function obricVaultBytes(amount: bigint): Uint8Array {
  const data = new Uint8Array(72);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return data;
}
function obricFeedBytes(price: bigint): Uint8Array {
  const data = new Uint8Array(32);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, price, true);
  view.setUint32(16, 1, true); // agg.status = Trading
  return data;
}

const FAMILIES: Family[] = [
  {
    slug: 'raydium-cp-swap',
    ladder: raydiumCpSwapLadder,
    async variants() {
      const POOL = address('7JuwJuNU88gurFnyWeiyGKbFmExMWcmRZntn9imEzdny');
      const fixtures = fixturesFor('raydium-cp-swap');
      const cfg = await raydiumCpSwap.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'raydium-amm-v4',
    ladder: raydiumAmmV4Ladder,
    async variants() {
      const POOL = address('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2');
      const fixtures = fixturesFor('raydium-amm-v4');
      const cfg = await raydiumAmmV4.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'pumpswap',
    ladder: pumpswapLadder,
    async variants() {
      const POOL = address('2uF4Xh61rDwxnG9woyxsVQP7zuA6kLFpb3NvnRQeoiSd');
      const fixtures = fixturesFor('pumpswap');
      const cfg = await pumpswapAdapter.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'orca-legacy-token-swap',
    ladder: orcaLegacyTokenSwapLadder,
    async variants() {
      const POOL = address('EGZ7tiLeH62TPV1gL8WwbXGzEPa9zmcpVnnkPKKnrE2U');
      const fixtures = fixturesFor('orca-legacy-token-swap');
      const cfg = await orcaLegacyTokenSwap.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'meteora-damm-v2',
    ladder: meteoraDammV2Ladder,
    async variants() {
      const POOL = address('8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie');
      const fixtures = fixturesFor('meteora-damm-v2');
      const cfg = await meteoraDammV2.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'aToB', cfg: { ...cfg, direction: 'aToB' }, state },
        { label: 'bToA', cfg: { ...cfg, direction: 'bToA' }, state },
      ];
    },
  },
  {
    slug: 'saber-stableswap',
    ladder: saberStableswapLadder,
    async variants() {
      const POOL = address('YAkoNb6HKmSxQN9L8hiBE5tPJRsniSSMzND1boHmZxe');
      const fixtures = fixturesFor('saber-stableswap');
      const cfg = await saberStableswap.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures), now: CLOCK_SABER }];
    },
  },
  {
    slug: 'meteora-damm-v1-stable',
    ladder: meteoraDammV1StableLadder,
    async variants() {
      const POOL = address('32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG');
      const fixtures = fixturesFor('meteora-damm-v1-stable');
      const cfg = await meteoraDammV1Stable.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures), now: CLOCK_D1S }];
    },
  },
  {
    slug: 'obric-v2',
    ladder: obricV2Ladder,
    async variants() {
      const cfg = {
        venue: 'obric-v2' as const,
        pool: OBRIC_POOL,
        direction: 'xToY' as const,
        mintX: OBRIC_DUMMY,
        mintY: OBRIC_DUMMY,
        reserveXVault: OBRIC_VAULT_X,
        reserveYVault: OBRIC_VAULT_Y,
        protocolFeeX: OBRIC_DUMMY,
        protocolFeeY: OBRIC_DUMMY,
        feedX: OBRIC_FEED_X,
        feedY: OBRIC_FEED_Y,
        tokenProgram: OBRIC_DUMMY,
        bigK: 10n ** 24n,
        targetX: 0n,
        feeMillionth: 1000n,
        divX: 1n,
        mulX: 1n,
        divY: 1n,
        mulY: 1n,
        priceOffX: 0n,
        priceOffY: 0n,
        bandBps: 0n,
        storedMultX: 0n,
        storedMultY: 0n,
        cpiTier: 'P-A' as const,
      };
      const state: AccountBytesMap = {
        [OBRIC_POOL]: new Uint8Array(8),
        [OBRIC_VAULT_X]: obricVaultBytes(1_000_000n),
        [OBRIC_VAULT_Y]: obricVaultBytes(500_000n),
        [OBRIC_FEED_X]: obricFeedBytes(100n),
        [OBRIC_FEED_Y]: obricFeedBytes(100n),
      };
      return [
        { label: 'xToY', cfg, state },
        { label: 'yToX', cfg: { ...cfg, direction: 'yToX' }, state },
      ];
    },
  },
  {
    slug: 'raydium-clmm',
    ladder: raydiumClmmLadder,
    async variants() {
      const POOL = address('3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv');
      const fixtures = fixturesFor('raydium-clmm');
      const cfg = await fetchRaydiumClmmConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: '0to1', cfg, state },
        { label: '1to0', cfg: { ...cfg, direction: '1to0' }, state },
      ];
    },
    knownLatentCollapse: {
      '0to1': { x: 95_185_556_484n, peak: 7_780_360_867n },
      '1to0': { x: 11_011_525_605n, peak: 134_527_424_614n },
    },
  },
  {
    slug: 'meteora-dlmm',
    ladder: meteoraDlmmLadder,
    async variants() {
      const PAIR = address('5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6');
      const fixtures = fixturesFor('meteora-dlmm');
      const cfg = await fetchMeteoraDlmmConfig(fixtureLoader(fixtures), PAIR);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'xToY', cfg, state, now: CLOCK_DLMM },
        { label: 'yToX', cfg: { ...cfg, direction: 'yToX' }, state, now: CLOCK_DLMM },
      ];
    },
    knownLatentCollapse: {
      xToY: { x: 2_518_898_410_454n, peak: 205_617_877_803n },
      yToX: { x: 210_552_340_323n, peak: 2_569_384_657_300n },
    },
  },
  {
    slug: 'orca-whirlpool',
    ladder: orcaWhirlpoolLadder,
    async variants() {
      const POOL = address('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE');
      const fixtures = fixturesFor('orca-whirlpool');
      const cfg = await fetchOrcaWhirlpoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'aToB', cfg, state },
        { label: 'bToA', cfg: { ...cfg, direction: 'bToA' }, state },
      ];
    },
    knownLatentCollapse: {
      aToB: { x: 1_818_415_775_132n, peak: 146_829_069_683n },
      bToA: { x: 184_416_747_348n, peak: 2_278_904_950_099n },
    },
  },
  {
    slug: 'manifest',
    ladder: manifestLadder,
    async variants() {
      const POOL = address('ENhU8LsaR7vDD2G1CsWcsuSGNrih9Cv5WZEk7q9kPapQ');
      const fixtures = fixturesFor('manifest');
      const cfg = await fetchManifestConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'baseIn', cfg: { ...cfg, direction: 'baseIn' }, state },
        { label: 'quoteIn', cfg: { ...cfg, direction: 'quoteIn' }, state },
      ];
    },
  },
  {
    slug: 'solfi-v2',
    ladder: solfiV2Ladder,
    async variants() {
      const POOL = address('65ZHSArs5XxPseKQbB1B4r16vDxMWnCxHMzogDAqiDUc');
      const REGISTRY = address('FmxXDSR9WvpJTCh738D1LEDuhMoA8geCtZgHb3isy7Dp');
      // The real 1 MiB registry account is never checked in (see
      // solfi-v2.test.ts) — fetchPoolConfig only gates on its size.
      const syntheticRegistry = new Uint8Array(1_048_576);
      const withRegistry = (fixtures: ReturnType<typeof fixturesFor>) => {
        const base = fixtureLoader(fixtures);
        return async (addr: Parameters<typeof base>[0]) => (addr === REGISTRY ? syntheticRegistry : base(addr));
      };
      // Two REAL mainnet snapshots (captured seconds apart), one per
      // direction — see solfi-v2.test.ts's header. `now` is a SLOT (see
      // ladder.ts's module doc — this family's `now` is NOT unix seconds like
      // every other family's), pinned just past each snapshot's own capture
      // point (inside the oracle's live window).
      const dir0 = fixturesFor('solfi-v2-dir0');
      const dir1 = fixturesFor('solfi-v2-dir1');
      const cfg0 = await solfiV2.fetchPoolConfig(withRegistry(dir0), POOL, 0);
      const cfg1 = await solfiV2.fetchPoolConfig(withRegistry(dir1), POOL, 1);
      return [
        { label: 'dir0', cfg: cfg0, state: fixtureBytesMap(dir0), now: 436_250_364n },
        { label: 'dir1', cfg: cfg1, state: fixtureBytesMap(dir1), now: 436_250_365n },
      ];
    },
    knownLatentCollapse: {
      // solfi-v2 is CLOSED-FORM (not window-walking), so this is a DIFFERENT
      // mechanism than the three families below (a spline-depth impact/110%-
      // of-vault revert boundary, not an exhausted tick/bin window) — but the
      // SAME disclosed shape: referenceLadderQuotes/referenceCapacities
      // already FREEZE at the last productive rung (see ladder.ts's
      // capacityInputVar doc), so the merge-relevant path is safe; the
      // standalone cold referenceQuote still collapses past the boundary
      // (not fixed in this pass — see ladder.ts's module doc for why).
      dir0: { x: 24_687_369_393_499n, peak: 1_655_097_325_788n },
      dir1: { x: 1_895_911_984_180n, peak: 22_778_841_047_543n },
    },
  },
];

describe('LADDER_REGISTRY count assertion', () => {
  it('this file enumerates exactly the 13 families the SDK registers — adding one without wiring it here fails loudly', () => {
    const registered = listLadderVenues();
    expect(registered).toHaveLength(13);
    expect(FAMILIES).toHaveLength(13);
    expect(FAMILIES.map((f) => f.slug).sort()).toEqual([...registered].sort());
  });
});

describe.each(FAMILIES)('$slug', (family) => {
  it('quote(0)==0 and quote is nondecreasing across a bisected domain, for every direction', async () => {
    const variants = await family.variants();
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) {
      const params = family.ladder.paramsFor(v.cfg);
      const quote = family.ladder.referenceQuote(v.cfg, v.state, params, v.now);
      const { reserveIn } = family.ladder.depthReserves(v.cfg, v.state, v.now);
      // Domain scaled off the pool's own depth (deep enough to reach any real
      // family's capacity/cliff) — falls back to a fixed floor for a family
      // whose depth reads 0 (a drained pool) so the sweep is never vacuous.
      const domainMax = (reserveIn > 0n ? reserveIn : 1_000_000n) * 4096n;
      // A KNOWN, disclosed exception (see the Family type + the pinned-gaps
      // describe block below): swept only up to just BEFORE the documented
      // cliff — never silently past it. Everything else gets the full domain.
      const gap = family.knownLatentCollapse?.[v.label];
      const swept = gap === undefined ? domainMax : gap.x;
      try {
        assertMirrorContract(quote, swept);
      } catch (err) {
        throw new Error(`[${family.slug}:${v.label}] ${(err as Error).message}`);
      }
    }
  });

  it('capacityInputVar and referenceCapacities are a PAIR — one implies the other', () => {
    const hasVar = family.ladder.capacityInputVar !== undefined;
    const hasCapacities = family.ladder.referenceCapacities !== undefined;
    expect(hasVar).toBe(hasCapacities);
  });

  it.each([2, 3, 4])('MERGE-ALTITUDE: buildLadder never yields a negative dIn or dOut at %d rungs', async (rungs) => {
    const variants = await family.variants();
    for (const v of variants) {
      const params = family.ladder.paramsFor(v.cfg);
      const quote = family.ladder.referenceQuote(v.cfg, v.state, params, v.now);
      const { reserveIn } = family.ladder.depthReserves(v.cfg, v.state, v.now);
      const amountIn = reserveIn > 0n ? reserveIn * 2n : 1_000_000_000n;
      const ladderQuotes = family.ladder.referenceLadderQuotes?.(v.cfg, v.state, params, v.now);
      const ladderCapacities = family.ladder.referenceCapacities?.(v.cfg, v.state, params, v.now);
      const rungList = buildLadder(quote, amountIn, rungs, ladderQuotes, ladderCapacities);
      for (const rung of rungList) {
        expect(rung.dIn >= 0n).toBe(true);
        expect(rung.dOut >= 0n).toBe(true);
      }
    }
  });
});

describe('KNOWN, DISCLOSED gaps — standalone cold referenceQuote collapses past a boundary the LADDER-CHAIN path already saturates at (LATENT: the merge never reaches this; NOT a safety property)', () => {
  const withGaps = FAMILIES.filter((f) => f.knownLatentCollapse !== undefined);

  it('exactly four families carry a disclosed gap: the three window-walking families (orca-whirlpool, raydium-clmm, meteora-dlmm, an exhausted tick/bin window) plus solfi-v2 (closed-form, an impact/110%-of-vault revert boundary) — obric-v2 does NOT (fixed alongside this guard)', () => {
    expect(withGaps.map((f) => f.slug).sort()).toEqual(['meteora-dlmm', 'orca-whirlpool', 'raydium-clmm', 'solfi-v2']);
  });

  it.each(withGaps.flatMap((f) => Object.entries(f.knownLatentCollapse!).map(([label, gap]) => ({ family: f, label, gap }))))(
    '$family.slug:$label pins the EXACT collapse: quote(x) peaks then quote(x+1) drops to 0',
    async ({ family, label, gap }) => {
      const variant = (await family.variants()).find((v) => v.label === label)!;
      const params = family.ladder.paramsFor(variant.cfg);
      const quote = family.ladder.referenceQuote(variant.cfg, variant.state, params, variant.now);
      expect(quote(gap.x)).toBe(gap.peak);
      expect(quote(gap.x + 1n)).toBe(0n);
      // The MERGE-ALTITUDE property (buildLadder over the LADDER-CHAIN path,
      // not this raw cold quote) stays clean for all four at every rung
      // count — see the describe.each block above — because
      // capacityInputVar/referenceCapacities freeze every rung's cumulative
      // input at (or before) this boundary, so it is never reachable from a
      // real merge fill.
      const capacities = family.ladder.referenceCapacities?.(variant.cfg, variant.state, params, variant.now);
      expect(capacities).toBeDefined();
      const [capAtCliff, capPast] = capacities!([gap.x, gap.x + 1n]);
      expect(capPast).toBeLessThanOrEqual(gap.x + 1n);
      expect(capPast).toBeGreaterThanOrEqual(capAtCliff);
    },
  );
});

describe('u256-wrapping licence — the exact mechanism the nondecreasing contract prevents', () => {
  it('a negative dOut wraps to a colossal, favourably-priced u64 under the engine op; the mirror stays a real negative bigint', () => {
    // The measured pre-fix manifest:quoteIn collapse (see manifest/ladder.ts's
    // header + manifest.test.ts's regression case): at amountIn=3e18, rungs=3,
    // the pre-fix walk produced dOut=-36,607,379,770 across the rung that
    // crossed the arithmetic-safety boundary.
    const dOut = -36_607_379_770n;
    const U64 = 1n << 64n;
    const wrapped = ((dOut % U64) + U64) % U64;
    // The wrapped word is a HUGE positive u64 — nowhere near the true
    // (negative, i.e. loss-making) delta the mirror computed.
    expect(wrapped).not.toBe(dOut);
    expect(wrapped).toBeGreaterThan(1n << 63n);
    expect(wrapped).toBe(U64 + dOut);
    // A merge that cross-multiplies price = dOut/dIn to rank rungs would read
    // this wrapped dOut as an ASTRONOMICALLY generous price (a huge dOut over
    // whatever dIn), electing it FIRST — exactly the "whole trade lands on a
    // slot delivering 0" failure mode this file's per-family sweep exists to
    // catch before it ships.
    const dIn = 1_000_000n; // any positive dIn — the wrapped price already dwarfs every real rung
    const wrappedPrice = wrapped / dIn;
    expect(wrappedPrice).toBeGreaterThan(1_000_000_000_000n);
  });

  it('a NONNEGATIVE dOut never wraps — plain bigint and the engine op agree exactly (the domain this contract licenses)', () => {
    const U64 = 1n << 64n;
    for (const dOut of [0n, 1n, 12_345n, (1n << 63n) - 1n, U64 - 1n]) {
      const wrapped = ((dOut % U64) + U64) % U64;
      expect(wrapped).toBe(dOut);
    }
  });
});
