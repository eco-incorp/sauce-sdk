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
 * A prior version of this file shipped a sweep that, hand-reverting each of
 * four known violators, caught only ONE of four (obric-v2) — not a coverage
 * gap, a SHAPE gap, in three independent ways this version fixes:
 *
 *   A. DEPTH-ANCHORED, TOP-CAPPED SWEEP. The old sweep was `domainMax >> e`
 *      for e<=62, scaled off the pool's OWN depth (`depthReserves().reserveIn
 *      * 4096`) — every measured cliff sits at a fixed-width-integer
 *      boundary in ABSOLUTE units, unrelated to a pool's depth (2^41 for
 *      meteora-damm-v2 aToB, ~1.48e18 for manifest:quoteIn, ~2.09e25 for
 *      orca-legacy-token-swap — the last one ABOVE u64::MAX entirely). The
 *      fix (`ladder-probe.ts`'s `absoluteProbePoints`): an ABSOLUTE,
 *      bottom-anchored lattice — 2^e for e=0..256, refined with a 2-bit
 *      mantissa — that depends on NOTHING from `depthReserves`.
 *   B. MERGE-ALTITUDE'S DOMAIN WAS THE SAME DEPTH SCALING (`reserveIn * 2`)
 *      against an ARITHMETIC cliff unrelated to depth — the manifest
 *      violation needs amountIn ~3e18 (rungs=3) but the old sweep's amount
 *      topped out nine orders below that for the actual fixture. Fixed:
 *      `mergeAltitudeAmounts` sweeps an absolute 2^e (e=0..64) amountIn
 *      lattice — merge amountIn always rides a u64 cfg word — plus the
 *      neighbourhood of any declared cliff.
 *   C. THE STRUCTURAL CHECK WAS THE WEAK FORM: `capacityInputVar present iff
 *      referenceCapacities present`, vacuously TRUE when both are absent —
 *      obric-v2's exact pre-fix shape. Fixed: the STRONG form
 *      (`ladder-probe.ts`'s `evaluateQuoteContract`) — a family whose cold
 *      quote has a finite cliff MUST declare it (an exact pinned x/peak in
 *      `declaredCliffs` below) and, when merge-reachable (x <= u64::MAX),
 *      wire BOTH capacityInputVar and referenceCapacities. An undeclared
 *      cliff fails LOUDLY regardless of reachability (the weak pair-check
 *      below is kept as a cheap, separate coherence check, never the sole
 *      gate).
 *
 * The mechanism, unchanged in spirit from the prior version:
 *
 *   1. REGISTRY-ENUMERATED with a COUNT ASSERTION (FAMILIES below,
 *      cross-checked against sdk/src/svm/venues/registry.ts's
 *      listLadderVenues()) — adding a ladder family without adding it here
 *      fails the count assertion, loudly, in CI.
 *   2. A DENSE, ABSOLUTE domain sweep per family per direction
 *      (ladder-probe.ts), bisecting to the exact violating interval on
 *      failure, with a DISTINCT-VALUE FLOOR (mechanism A above) so a sweep
 *      that only ever samples one side of a family's real cliff cannot pass
 *      by accident.
 *   3. The MERGE-ALTITUDE property, across every family x every direction x
 *      rung count 2/3/4 x an absolute amountIn lattice: buildLadder
 *      (transcribed from solver-reference.ts) never yields a negative dIn
 *      or dOut.
 *   4. A u256-WRAPPING LICENCE test: the mirror is plain bigint, the engine
 *      wraps at 2^64 per rung word — pin the exact mechanism the
 *      nondecreasing contract exists to prevent, using the actual measured
 *      pre-fix manifest:quoteIn collapse (dOut=-36,607,379,770 at
 *      amountIn=3e18, rungs=3) as the worked example.
 *   5. THE STRONG STRUCTURAL check (mechanism C above).
 *   6. A SELF-TEST: five synthetic negative-control quote closures run
 *      through the exact same evaluateQuoteContract the real families use,
 *      each with a known expected verdict — proving the detector itself
 *      would fire before trusting it against the real registry.
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
  fetchQuantumConfig,
  quantumLadder,
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
import { evaluateQuoteContract, mergeAltitudeAmounts, U64_MAX, type DeclaredCliff } from './ladder-probe.js';

const FIXTURES = resolve(process.cwd(), 'test/svm/fixtures');
const fixturesFor = (slug: string) => loadFixtures(resolve(FIXTURES, slug));

// A dense absolute sweep (~1028 points) x up to 20 family/direction variants
// x (cold-quote contract + 3 merge-altitude rung counts, each up to ~71
// amountIn points) comfortably exceeds jest's 5s default per test.
const SWEEP_TIMEOUT_MS = 30_000;

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
   * A REQUIRED declaration (evaluateQuoteContract's strong structural form,
   * see the file header) for any variant whose standalone cold
   * `referenceQuote` closure has a finite cliff — keyed by variant label,
   * exact pinned (x, peak) pair. Three window-walking families
   * (orca-whirlpool/raydium-clmm/meteora-dlmm — an exhausted tick/bin
   * window) plus solfi-v2 (closed-form, an impact/110%-of-vault revert
   * boundary) carry one: their LADDER-CHAIN path (referenceLadderQuotes +
   * capacityInputVar/referenceCapacities — the ONLY path the merge actually
   * evaluates a final-fill amount through) is fully capacity-safe, but the
   * cold, standalone `referenceQuote` asked directly for an amount past the
   * off-chain-shipped window (which the merge never does) still collapses —
   * "LATENT, saved only by warm-chain saturation, not a safety property".
   * Every other family's cold quote SATURATES (never collapses) and carries
   * no entry.
   */
  declaredCliffs?: Record<string, DeclaredCliff>;
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
      const B_TOKEN_VAULT = address('DQjGWHN9ERn1zSMpWLNvSpTFUSfnxbanBt9A7xyU2bVE');
      const fixtures = fixturesFor('meteora-damm-v1-stable');
      const cfg = await meteoraDammV1Stable.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      // 'default' (the checked-in mainnet dump) has its OWN idle float
      // (959,036,927,046) EXCEED the curve's own asymptotic max
      // (~861,412,784,533) — the cliff is never reached under it, the exact
      // accident that let the collapse-to-zero bug this fix addresses ship
      // undetected through every existing test (see ladder.ts's module doc).
      // 'lowIdle' doctors b_token_vault's SPL amount (u64 LE @ offset 64)
      // down to an ORDINARY idle float that sits BELOW the asymptote, so the
      // cliff is real and merge-reachable — this is the missing variant that
      // would have caught the original bug had it existed from the start.
      // 'idle1e9'/'idle100e9' are two MORE ordinary idle floats (smaller —
      // retail-size territory, not a whale trade) added alongside it: the
      // round-1-rejected collapse-to-zero defect scaled its collapse band
      // with the idle float itself, so a single doctored fixture cannot
      // stand in for "every idle float below the asymptote" — see the
      // CAPACITY DENSITY describe block below, which sweeps all three.
      const withIdleFloat = (idle: bigint): AccountBytesMap => {
        const doctored = new Uint8Array(state[B_TOKEN_VAULT]);
        new DataView(doctored.buffer).setBigUint64(64, idle, true);
        return { ...state, [B_TOKEN_VAULT]: doctored };
      };
      return [
        { label: 'default', cfg, state, now: CLOCK_D1S },
        { label: 'lowIdle', cfg, state: withIdleFloat(500_000_000_000n), now: CLOCK_D1S },
        { label: 'idle1e9', cfg, state: withIdleFloat(1_000_000_000n), now: CLOCK_D1S },
        { label: 'idle100e9', cfg, state: withIdleFloat(100_000_000_000n), now: CLOCK_D1S },
      ];
    },
    declaredCliffs: {
      // Same disclosed shape as orca-whirlpool/raydium-clmm/meteora-dlmm/
      // solfi-v2: the ladder-chain path (referenceLadderQuotes +
      // capacityInputVar/referenceCapacities) is capacity-safe (the
      // MERGE-ALTITUDE sweep below proves it never yields a negative dIn or
      // dOut), but the standalone cold referenceQuote asked directly for an
      // x past this boundary still collapses to 0 (ladder.ts's module doc).
      // Each (x, peak) pair is the exact geometric cliff/peak of the
      // STANDALONE cold quote — the TRUE boundary, not the analytic clamp's
      // own (deliberately more conservative) reported value; see the
      // CAPACITY DENSITY block below for the clamp side of this story.
      lowIdle: { x: 499_992_225_659n, peak: 499_999_999_998n },
      idle1e9: { x: 999_395_010n, peak: 999_999_999n },
      idle100e9: { x: 99_968_830_253n, peak: 99_999_999_999n },
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
    declaredCliffs: {
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
    declaredCliffs: {
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
    declaredCliffs: {
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
    declaredCliffs: {
      // solfi-v2 is CLOSED-FORM (not window-walking), so this is a DIFFERENT
      // mechanism than the three families above (a spline-depth impact/110%-
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
  {
    slug: 'quantum',
    ladder: quantumLadder,
    async variants() {
      // Two REAL mainnet pools: BHrYr82... (9/6 decimals, per-pool impact
      // params live) and 6TC3v1iA... (10/8 decimals) — different output
      // scales, so the trapezoid's 2*10^outDec param differs per variant.
      // `now` is a SLOT (the per-level expiry gate compares against
      // Clock::slot, like solfi-v2's staleness gate — NOT unix seconds),
      // pinned at each pool's own level-expiry floor so every level is live.
      const bhr = fixturesFor('quantum');
      const load = fixtureLoader(bhr);
      const state = fixtureBytesMap(bhr);
      const a = await fetchQuantumConfig(load, address('BHrYr82teMWH38Q6QSgNEzkfZjiyLP74vL9m9FG6bQAD'));
      const b = await fetchQuantumConfig(load, address('6TC3v1iA6a17ABkdg2LFeUbwjFtLR5TzbNzUEgtosx8a'));
      return [
        { label: 'bhr:zeroIn', cfg: { ...a, direction: 'zeroIn' as const }, state, now: 436_213_243n },
        { label: 'bhr:oneIn', cfg: { ...a, direction: 'oneIn' as const }, state, now: 436_213_243n },
        { label: 'tc3:zeroIn', cfg: { ...b, direction: 'zeroIn' as const }, state, now: 435_803_506n },
        { label: 'tc3:oneIn', cfg: { ...b, direction: 'oneIn' as const }, state, now: 435_803_506n },
      ];
    },
  },
];

describe('LADDER_REGISTRY count assertion', () => {
  it('this file enumerates exactly the 13 families the SDK registers — adding one without wiring it here fails loudly', () => {
    const registered = listLadderVenues();
    expect(registered).toHaveLength(14);
    expect(FAMILIES).toHaveLength(14);
    expect(FAMILIES.map((f) => f.slug).sort()).toEqual([...registered].sort());
  });
});

describe.each(FAMILIES)('$slug', (family) => {
  it(
    'cold referenceQuote satisfies the STRONG contract (nondecreasing, quote(0)==0, distinct-value floor, declared cliffs) for every direction',
    async () => {
      const variants = await family.variants();
      expect(variants.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const v of variants) {
        const params = family.ladder.paramsFor(v.cfg);
        const quote = family.ladder.referenceQuote(v.cfg, v.state, params, v.now);
        const result = evaluateQuoteContract({
          label: `${family.slug}:${v.label}`,
          quote,
          declared: family.declaredCliffs?.[v.label],
          hasCapacityPair: family.ladder.capacityInputVar !== undefined,
        });
        // eslint-disable-next-line no-console
        console.info(
          `[census] ${family.slug}:${v.label} shape=${result.shape.kind} distinct=${result.distinct} distinctNonzero=${result.distinctNonzero}`,
        );
        failures.push(...result.violations);
      }
      if (failures.length > 0) throw new Error(failures.join('\n'));
    },
    SWEEP_TIMEOUT_MS,
  );

  it('capacityInputVar and referenceCapacities are a PAIR — one implies the other (cheap coherence check, not the sole structural gate — see evaluateQuoteContract for the strong form)', () => {
    const hasVar = family.ladder.capacityInputVar !== undefined;
    const hasCapacities = family.ladder.referenceCapacities !== undefined;
    expect(hasVar).toBe(hasCapacities);
  });

  it.each([2, 3, 4])(
    'MERGE-ALTITUDE: buildLadder never yields a negative dIn or dOut at %d rungs, over the absolute amountIn lattice',
    async (rungs) => {
      const variants = await family.variants();
      const failures: string[] = [];
      for (const v of variants) {
        const params = family.ladder.paramsFor(v.cfg);
        const quote = family.ladder.referenceQuote(v.cfg, v.state, params, v.now);
        const { reserveIn } = family.ladder.depthReserves(v.cfg, v.state, v.now);
        const ladderQuotes = family.ladder.referenceLadderQuotes?.(v.cfg, v.state, params, v.now);
        const ladderCapacities = family.ladder.referenceCapacities?.(v.cfg, v.state, params, v.now);
        const amounts = mergeAltitudeAmounts(reserveIn, family.declaredCliffs?.[v.label]);
        for (const amountIn of amounts) {
          const rungList = buildLadder(quote, amountIn, rungs, ladderQuotes, ladderCapacities);
          rungList.forEach((rung, i) => {
            if (rung.dIn < 0n || rung.dOut < 0n) {
              failures.push(
                `[${family.slug}:${v.label}] rungs=${rungs} amountIn=${amountIn}: rung ${i} dIn=${rung.dIn} dOut=${rung.dOut}`,
              );
            }
          });
        }
      }
      if (failures.length > 0) throw new Error(failures.slice(0, 5).join('\n'));
    },
    SWEEP_TIMEOUT_MS,
  );
});

describe('KNOWN, DISCLOSED gaps — standalone cold referenceQuote collapses past a boundary the LADDER-CHAIN path already saturates at (LATENT: the merge never reaches this; NOT a safety property)', () => {
  const withGaps = FAMILIES.filter((f) => f.declaredCliffs !== undefined);

  it('exactly five families carry a disclosed gap: the three window-walking families (orca-whirlpool, raydium-clmm, meteora-dlmm, an exhausted tick/bin window) plus solfi-v2 (closed-form, an impact/110%-of-vault revert boundary) plus meteora-damm-v1-stable (closed-form, a strict idle-float bound) — obric-v2 does NOT (fixed alongside this guard)', () => {
    expect(withGaps.map((f) => f.slug).sort()).toEqual([
      'meteora-damm-v1-stable',
      'meteora-dlmm',
      'orca-whirlpool',
      'raydium-clmm',
      'solfi-v2',
    ]);
  });

  it.each(withGaps.flatMap((f) => Object.entries(f.declaredCliffs!).map(([label, gap]) => ({ family: f, label, gap }))))(
    '$family.slug:$label pins the EXACT collapse: quote(x) peaks then quote(x+1) drops to 0, and is merge-reachable with both capacity halves wired',
    async ({ family, label, gap }) => {
      const variant = (await family.variants()).find((v) => v.label === label)!;
      const params = family.ladder.paramsFor(variant.cfg);
      const quote = family.ladder.referenceQuote(variant.cfg, variant.state, params, variant.now);
      // Wrapped in String(): a raw-bigint .toBe() that FAILS cannot be
      // reported under jest workers — JSON.stringify (jest-worker's IPC to
      // the parent process) throws "Do not know how to serialize a BigInt",
      // which silently vanishes this entire suite from the run instead of
      // reporting a failing assertion (see this file's header / the PR body
      // for the reproduced experiment). String() keeps the comparison exact
      // (decimal digits, no precision loss) while making a failure printable.
      expect(String(quote(gap.x))).toBe(String(gap.peak));
      expect(String(quote(gap.x + 1n))).toBe(String(0n));
      expect(gap.x <= U64_MAX).toBe(true);
      expect(family.ladder.capacityInputVar).toBeDefined();
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

describe('meteora-damm-v1-stable CAPACITY DENSITY — the round-1-rejected mechanism: a 2-round bracketed search fails to find ANY productive point once amountIn sits far above the idle-float cliff, reporting the SAME (0, 0) a total collapse would. The fix (an ANALYTIC clamp, no search) must keep the venue alive at every multiple, at every rung count this family actually ships (defaultRungs=2, cap 4 — swept here through 8 for margin)', () => {
  const damm1sFamily = FAMILIES.find((f) => f.slug === 'meteora-damm-v1-stable')!;
  // 2/3/5/10/100/10,000x the cliff: the exact multiplier set the round-1
  // rejection was measured against (density sweep, per-idle-float collapse
  // counts) — see docs/ARB.md-style campaign notes / the PR body for the
  // full table. rungs 2..8 spans the shipped defaultRungs (2) through past
  // the shipped cap (4) for margin.
  const MULTS = [2n, 3n, 5n, 10n, 100n, 10_000n];
  const RUNGS = [2, 3, 4, 5, 6, 7, 8];
  // Each family.declaredCliffs entry above IS the exact geometric cliff for
  // that variant (the standalone cold quote's true boundary) — reused here
  // as the multiplier base, not re-derived.
  const CLIFF_LABELS = ['lowIdle', 'idle1e9', 'idle100e9'];

  it.each(CLIFF_LABELS)(
    '%s: every 2/3/5/10/100/10,000x-cliff amountIn keeps NONZERO final capacity and NONZERO final out at rungs 2..8 — a single zero cell is a total, not partial, loss of this venue',
    async (label) => {
      const variant = (await damm1sFamily.variants()).find((v) => v.label === label)!;
      const params = damm1sFamily.ladder.paramsFor(variant.cfg);
      const ladderQuotes = damm1sFamily.ladder.referenceLadderQuotes!(variant.cfg, variant.state, params, variant.now);
      const ladderCapacities = damm1sFamily.ladder.referenceCapacities!(variant.cfg, variant.state, params, variant.now);
      const cliff = damm1sFamily.declaredCliffs![label].x;
      const failures: string[] = [];
      for (const mult of MULTS) {
        const amountIn = cliff * mult;
        for (const rungs of RUNGS) {
          const grid = ladderGrid(amountIn, rungs);
          const outs = ladderQuotes(grid);
          const caps = ladderCapacities(grid);
          const finalOut = outs[outs.length - 1];
          const finalCap = caps[caps.length - 1];
          if (finalCap === 0n || finalOut === 0n) {
            failures.push(`${label} x${mult} rungs=${rungs}: finalCap=${finalCap} finalOut=${finalOut} (amountIn=${amountIn})`);
          }
        }
      }
      if (failures.length > 0) throw new Error(failures.join('\n'));
    },
    SWEEP_TIMEOUT_MS,
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

describe('SELF-TEST — the detector against synthetic negative controls (proves evaluateQuoteContract fires BEFORE trusting it against the real registry)', () => {
  // Cheaper sweep for the synthetic cases: exercises the exact same code path
  // as the real families (evaluateQuoteContract), just over a narrower bit
  // range where it is not testing anything past the case's own boundary.

  it('1. an undeclared cliff WITHIN u64::MAX fails BOTH the undeclared-cliff and the missing-capacity-pair checks', () => {
    const CLIFF = 1_000_000_000n; // well inside u64::MAX
    const quote = (x: bigint): bigint => (x === 0n ? 0n : x <= CLIFF ? x : 0n);
    const result = evaluateQuoteContract({ label: 'synthetic:undeclared-u64', quote, hasCapacityPair: false, maxBits: 40 });
    expect(result.shape.kind).toBe('cliff');
    expect(result.violations.some((v) => v.includes('UNDECLARED cliff'))).toBe(true);
    expect(result.violations.some((v) => v.includes('without capacityInputVar/referenceCapacities wired'))).toBe(true);
  });

  it('2. an undeclared cliff ABOVE u64::MAX fails as undeclared but is NOT flagged for a missing capacity pair (unreachable)', () => {
    const CLIFF = 1n << 96n; // above u64::MAX (2^64)
    const quote = (x: bigint): bigint => (x === 0n ? 0n : x <= CLIFF ? x : 0n);
    const result = evaluateQuoteContract({ label: 'synthetic:undeclared-above-u64', quote, hasCapacityPair: false, maxBits: 100 });
    expect(result.shape.kind).toBe('cliff');
    if (result.shape.kind === 'cliff') expect(result.shape.x > U64_MAX).toBe(true);
    expect(result.violations.some((v) => v.includes('UNDECLARED cliff'))).toBe(true);
    expect(result.violations.some((v) => v.includes('without capacityInputVar/referenceCapacities wired'))).toBe(false);
  });

  it('3. a cliff that IS declared correctly and wired passes clean', () => {
    const CLIFF = 1n << 41n;
    const quote = (x: bigint): bigint => (x === 0n ? 0n : x <= CLIFF ? x : 0n);
    const declared: DeclaredCliff = { x: CLIFF, peak: CLIFF };
    const result = evaluateQuoteContract({ label: 'synthetic:declared-wired', quote, declared, hasCapacityPair: true, maxBits: 50 });
    expect(result.shape.kind).toBe('cliff');
    expect(result.violations).toEqual([]);
  });

  it('4. a monotone-forever (asymptotic, never-collapsing) quote passes with NO declaration required', () => {
    const CAP = 1_000_000_000_000n;
    const quote = (x: bigint): bigint => (CAP * x) / (1n + x);
    const result = evaluateQuoteContract({ label: 'synthetic:monotone-forever', quote, hasCapacityPair: false, maxBits: 120 });
    expect(result.shape.kind).toBe('none');
    expect(result.violations).toEqual([]);
  });

  it('5. a genuinely 2-distinct-value instrument fails the distinct-value floor regardless of lattice density', () => {
    const quote = (x: bigint): bigint => (x === 0n ? 0n : 1_000_000n);
    const result = evaluateQuoteContract({ label: 'synthetic:vacuous', quote, hasCapacityPair: false, maxBits: 60 });
    expect(result.distinct).toBeLessThan(16);
    expect(result.violations.some((v) => v.includes('VACUOUS sweep'))).toBe(true);
  });

  it('6. an unregistered ladder family fails the count assertion loudly (demonstrates the mechanism kept from the prior version)', () => {
    // Exercises the REAL mechanism from the "LADDER_REGISTRY count assertion"
    // block above (listLadderVenues() cross-checked against FAMILIES) — not
    // a synthetic length comparison that never calls the registry. Simulates
    // registry.ts registering a 14th family this file was never updated for:
    // the two slug sets diverge and the comparison must throw.
    const registered = listLadderVenues();
    const fakeRegistered = [...registered, 'synthetic-14th-family'];
    expect(() => {
      expect(FAMILIES.map((f) => f.slug).sort()).toEqual([...fakeRegistered].sort());
    }).toThrow();
  });
});
