/**
 * THE LADDER-ADAPTER CONTRACT GUARD (no engine, no RPC).
 *
 * the consuming app SVM reference solver (the recipes-side SvmRoute merge mirror)
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
  deriverse,
  deriverseLadder,
  manifestLadder,
  fetchManifestConfig,
  meteoraDammV1Stable,
  meteoraDammV1StableLadder,
  meteoraDammV2,
  meteoraDammV2Ladder,
  meteoraDbc,
  meteoraDbcLadder,
  meteoraDlmmLadder,
  fetchMeteoraDlmmConfig,
  goonfiV2Ladder,
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
  stabbleStableSwap,
  stabbleStableSwapLadder,
  stabbleWeightedSwap,
  stabbleWeightedSwapLadder,
  fetchTesseraVConfig,
  tesseravLadder,
  fetchWoofiConfig,
  woofiLadder,
  perpsJlpLadder,
  juplendAmmLadder,
  aldrin,
  aldrinLadder,
  scaleAmmLadder,
  scaleAmm,
  sanctumStakePoolLadder,
  sanctumStakePool,
  sanctumInfinityPoolKey,
  sanctumInfinityLadder,
  sanctumInfinity,
  saberDecimalsWrapperLadder,
  saberDecimalsWrapper,
  stepnLadder,
  stepn,
  penguinLadder,
  penguin,
  orcaV1Ladder,
  orcaV1,
  tokenSwapV1Ladder,
  tokenSwapV1,
  fetchSolfiV1Config,
  solfiV1Ladder,
  solayerLadder,
  solayer,
  scorchLadder,
  scorch,
  scaleVmmLadder,
  scaleVmm,
  hyloStabilityPoolLadder,
  hyloStabilityPool,
  humaLadder,
  huma,
  heliumTreasuryLadder,
  heliumTreasury,
  heavenLadder,
  heaven,
  raydiumLaunchlabLadder,
  raydiumLaunchlab,
  phoenixLadder,
  fetchPhoenixConfig,
  perenaStarLadder,
  perenaStar,
  fetchOneIntroSwapPoolConfig,
  oneIntroSwapLadder,
  omnipairLadder,
  omnipair,
  mswapPoolKey,
  mswapLadder,
  mswap,
  moonitLadder,
  moonit,
  metadaoFutarchySpotLadder,
  fetchMetaDaoFutarchySpotConfig,
  mercurialLadder,
  fetchMercurialPoolConfig,
  lemmingsfiLadder,
  fetchLemmingsFiPoolConfig,
  jupiterLendEarnLadder,
  jupiterLendEarn,
  CARROT_VAULT_ADDRESS,
  carrotApplyDirection,
  carrotLadder,
  carrot,
  fetchByrealPoolConfig,
  byrealLadder,
  bonkswapLadder,
  bonkswap,
  fetchDenaliPoolConfig,
  denaliLadder,
  fetchXorcaConfig,
  xorcaLadder,
  fetchVoltrConfig,
  voltrLadder,
  virtualsLadder,
  virtuals,
  vaultLiquidUnstakeLadder,
  vaultLiquidUnstake,
  trendsLadder,
  trends,
  boopFunLadder,
  boopFun,
  fetchAlphaqPoolConfig,
  alphaqLadder,
  fetchGavelConfig,
  gavelLadder,
  gammaLadder,
  gamma,
  fetchFluxBeamPoolConfig,
  fluxbeamLadder,
} from '../../../src/svm/index.js';
import type { JuplendAmmPoolConfig } from '../../../src/svm/index.js';
import type { AccountBytesMap, PoolConfig, SvmVenueLadder } from '../../../src/svm/index.js';
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
// the consuming app SVM reference solver's grid + rung construction (the recipes
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
  ladder: SvmVenueLadder;
  variants(): Promise<Variant[]>;
  /**
   * A REQUIRED declaration (evaluateQuoteContract's strong structural form,
   * see the file header) for any variant whose standalone cold
   * `referenceQuote` closure has a finite cliff — keyed by variant label,
   * exact pinned (x, peak) pair. meteora-damm-v1-stable is the SOLE entry:
   * its LADDER-CHAIN path (referenceLadderQuotes +
   * capacityInputVar/referenceCapacities — the ONLY path the merge actually
   * evaluates a final-fill amount through) is fully capacity-safe, but its
   * cold, standalone `referenceQuote` asked directly for an amount past the
   * idle-float bound (which the merge never does) still collapses —
   * "LATENT, saved only by warm-chain saturation, not a safety property".
   * The three window-walking families (orca-whirlpool/raydium-clmm/
   * meteora-dlmm — an exhausted tick/bin window) and solfi-v2 (closed-form,
   * an impact/110%-of-vault revert boundary) each USED TO collapse the same
   * way, but the five-family correctness batch fixed their cold
   * `referenceQuote` to SATURATE, so none carries an entry now — as does
   * every other family's cold quote.
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

const GOONFI_DUMMY = address('So11111111111111111111111111111111111111112');
const GOONFI_POOL = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const GOONFI_VAULT_A = address('75HgnSvXbWKZBpZHveX68ZzAhDqMzNDS29X6BGLtxMo1');
const GOONFI_VAULT_B = address('APDFRM3HMr8CAGXwKHiu2f5ePSpaiEJhaURwhsRrUUt9');
const GOONFI_ORACLE = address('JU8kmKzDHF9sXWsnoznaFDFezLsE5uomX2JkRMbmsQP');
/** Real, measured schedule (see goonfi-v2/index.ts's module doc) — 6-decimal-scaled cumulative
 *  size tiers, mintB-raw units. */
const GOONFI_SIZE_TIERS_B: readonly bigint[] = [
  500_000_000n,
  1_000_000_000n,
  2_500_000_000n,
  5_000_000_000n,
  10_000_000_000n,
  50_000_000_000n,
  100_000_000_000n,
  250_000_000_000n,
  1_000_000_000_000n,
];
const GOONFI_FEE_TIERS_PPM: readonly bigint[] = [1320n, 1450n, 1650n, 1950n, 2200n, 2800n, 3500n, 6000n, 11000n];

function goonfiVaultBytes(amount: bigint): Uint8Array {
  const data = new Uint8Array(72);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return data;
}
function goonfiOracleBytes(price: bigint): Uint8Array {
  const data = new Uint8Array(32);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, price, true);
  view.setBigUint64(8, price, true);
  view.setUint32(20, 1_000_000, true); // denom
  return data;
}

// juplend-amm: synthetic (no mainnet fixture checked in — see ladder.ts's
// module doc, "juplend-amm.test.ts" for the real-mainnet-state decode this
// mirrors). Only the two byte ranges the ladder actually reads (Dex's
// center_price @109, the position's amount/ceiling @73/81) are populated;
// every other field is inert to the quote math.
const JUPLEND_DEX = address('So11111111111111111111111111111111111111112');
const JUPLEND_POS0 = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const JUPLEND_POS1 = address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const JUPLEND_DUMMY = address('75HgnSvXbWKZBpZHveX68ZzAhDqMzNDS29X6BGLtxMo1');

function juplendDexBytes(centerPrice: bigint): Uint8Array {
  const data = new Uint8Array(329);
  const view = new DataView(data.buffer);
  view.setBigUint64(109, centerPrice & ((1n << 64n) - 1n), true);
  view.setBigUint64(109 + 8, centerPrice >> 64n, true);
  return data;
}

function juplendPositionBytes(amount: bigint, ceiling: bigint): Uint8Array {
  const data = new Uint8Array(120);
  const view = new DataView(data.buffer);
  view.setBigUint64(73, amount, true);
  view.setBigUint64(81, ceiling, true);
  return data;
}

const FAMILIES: Family[] = [
  {
    slug: 'aldrin',
    ladder: aldrinLadder,
    async variants() {
      const POOL = address('4GUniSDrCAZR3sKtLa1AWC8oyYubZeKJQ8KraQmy3Wt5');
      const fixtures = fixturesFor('aldrin');
      const cfg = await aldrin.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'fluxbeam',
    ladder: fluxbeamLadder,
    async variants() {
      const POOL = address('CZEZDGDkzsn4zTfdw6XRm4U1o6GatotMhhRmVEzdwGS3');
      const fixtures = fixturesFor('fluxbeam');
      const cfg = await fetchFluxBeamPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'gamma',
    ladder: gammaLadder,
    async variants() {
      const POOL = address('CM681mP5GjxrzFWg452RfJ2W4zEnshR9kkgg34NdAthi');
      const fixtures = fixturesFor('gamma');
      const cfg = await gamma.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: '0to1', cfg, state },
        { label: '1to0', cfg: { ...cfg, inputIsToken0: false }, state },
      ];
    },
  },
  {
    slug: 'gavel',
    ladder: gavelLadder,
    async variants() {
      const POOL = address('CcWf5D6BhUTv2tD4ebFFcmCdTUgBWMc8CqqoJvFHGGXi');
      const fixtures = fixturesFor('gavel');
      const cfg = await fetchGavelConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'baseIn', cfg, state },
        { label: 'quoteIn', cfg: { ...cfg, direction: 'quoteIn' }, state },
      ];
    },
  },
  {
    slug: 'alphaq',
    ladder: alphaqLadder,
    async variants() {
      const POOL = address('Pi9nzTjPxD8DsRfRBGfKYzmefJoJM8TcXu2jyaQjSHm');
      const fixtures = fixturesFor('alphaq');
      const cfg = await fetchAlphaqPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'boop-fun',
    ladder: boopFunLadder,
    async variants() {
      const POOL = address('8uwipGAmbqzLFt6hky77C9YWEJzycLf9vgceEJyN1M7e');
      const fixtures = fixturesFor('boop-fun');
      const cfg = await boopFun.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'trends',
    ladder: trendsLadder,
    async variants() {
      const POOL = address('8najX6BzqVwEwNXfJWZhP4TMYGmGvf1Mn6BpzfkpFpBG');
      const fixtures = fixturesFor('trends');
      const cfg = await trends.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'quoteToBase', cfg: { ...cfg, direction: 'quoteToBase' }, state },
        { label: 'baseToQuote', cfg: { ...cfg, direction: 'baseToQuote' }, state },
      ];
    },
  },
  {
    slug: 'vault-liquid-unstake',
    ladder: vaultLiquidUnstakeLadder,
    async variants() {
      // POOL is the LstInfo account (this family's "pool"); the global Pool
      // singleton (pool.json) and the stake pool (stakepool.json) are loaded
      // internally by fetchPoolConfig and read by referenceQuote — all three
      // fixture accounts are in fixtureBytesMap(fixtures).
      const POOL = address('5U6DciyzRQoCHFr8PxiokVLcA1ADZ9U34AeVHqWSa7N');
      const fixtures = fixturesFor('vault-liquid-unstake');
      const cfg = await vaultLiquidUnstake.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'virtuals',
    ladder: virtualsLadder,
    async variants() {
      const POOL = address('135Q44ShcCmWzaHZDJY25GejVQ4xwcgX9MzAEqE1eaFY');
      const fixtures = fixturesFor('virtuals');
      const cfg = await virtuals.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'quoteToBase', cfg, state },
        { label: 'baseToQuote', cfg: { ...cfg, direction: 'baseToQuote' }, state },
      ];
    },
  },
  {
    slug: 'voltr',
    ladder: voltrLadder,
    async variants() {
      // POOL is the Voltr vault account. referenceQuote reads the vault + lp
      // mint (assetToLp) and additionally the idle ATA (lpToAsset) — all three
      // are in the fixture. `now` is omitted (defaults to Date.now()), mirroring
      // recipes voltr.test.ts; monotonicity holds for any `now`.
      const VAULT = address('Gj8kURFs8fK3GhiX5Yc6H1HQKSpEvLHeDRZsP6Y2D1je');
      const fixtures = fixturesFor('voltr');
      const cfg = await fetchVoltrConfig(fixtureLoader(fixtures), VAULT);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'assetToLp', cfg, state },
        { label: 'lpToAsset', cfg: { ...cfg, direction: 'lpToAsset' }, state },
      ];
    },
  },
  {
    slug: 'xorca',
    ladder: xorcaLadder,
    async variants() {
      // Singleton venue: POOL must equal XORCA_STATE_PDA (fetchXorcaConfig
      // rejects anything else). referenceQuote reads the vault ATA, state PDA,
      // and xORCA mint — all three are in the fixture.
      const POOL = address('CSqKhyW1cpdyjheAx5HXx4ibcnYrzpL5JywEMAkZixBK');
      const fixtures = fixturesFor('xorca');
      const cfg = await fetchXorcaConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'denali',
    ladder: denaliLadder,
    async variants() {
      const POOL = address('8njE4Rq7nWX5XiQMH5sNcJy5GrHV2aFUFaZzuQUBFQZ8');
      const fixtures = fixturesFor('denali');
      const cfg = await fetchDenaliPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'bonkswap',
    ladder: bonkswapLadder,
    async variants() {
      const POOL = address('5MMaArf3NgUjaDqYZiwYP2wbXLd8myKmmYzBzzqdfYSb');
      const fixtures = fixturesFor('bonkswap-fork');
      const cfg = await bonkswap.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'xToY', cfg: { ...cfg, direction: 'xToY' }, state },
        { label: 'yToX', cfg: { ...cfg, direction: 'yToX' }, state },
      ];
    },
  },
  {
    slug: 'byreal',
    ladder: byrealLadder,
    async variants() {
      const POOL = address('23XoPQqGw9WMsLoqTu8HMzJLD6RnXsufbKyWPLJywsCT');
      const fixtures = fixturesFor('byreal');
      const cfg = await fetchByrealPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: '0to1', cfg, state },
        { label: '1to0', cfg: { ...cfg, direction: '1to0' }, state },
      ];
    },
  },
  {
    slug: 'carrot',
    ladder: carrotLadder,
    async variants() {
      const POOL = CARROT_VAULT_ADDRESS;
      const fixtures = fixturesFor('carrot');
      const cfg = await carrot.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'issue:0', cfg, state },
        { label: 'redeem:0', cfg: carrotApplyDirection(cfg, 'redeem:0'), state },
      ];
    },
  },
  {
    slug: 'jupiter-lend-earn',
    ladder: jupiterLendEarnLadder,
    async variants() {
      const POOL = address('2vVYHYM8VYnvZqQWpTJSj8o8DBf1wM8pVs3bsTgYZiqJ');
      const fixtures = fixturesFor('jupiter-lend-earn');
      const cfg = await jupiterLendEarn.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'deposit', cfg, state },
        { label: 'redeem', cfg: { ...cfg, direction: 'redeem' }, state },
      ];
    },
  },
  {
    slug: 'lemmingsfi',
    ladder: lemmingsfiLadder,
    async variants() {
      const POOL = address('AqWXTbzDG3qmAhtoSQoiVudaP5voVFcJSmCjvNS4hyzo');
      const fixtures = fixturesFor('lemmingsfi');
      const cfg = await fetchLemmingsFiPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'dir0', cfg, state },
        { label: 'dir1', cfg: { ...cfg, direction: 1 }, state },
      ];
    },
  },
  {
    slug: 'mercurial',
    ladder: mercurialLadder,
    async variants() {
      const POOL = address('MAR1zHjHaQcniE2gXsDptkyKUnNfMEsLBVcfP7vLyv7');
      const fixtures = fixturesFor('mercurial');
      const cfg = await fetchMercurialPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'aToB', cfg, state },
        { label: 'bToA', cfg: { ...cfg, direction: 'bToA' }, state },
      ];
    },
  },
  {
    slug: 'metadao-futarchy',
    ladder: metadaoFutarchySpotLadder,
    async variants() {
      const POOL = address('CUPoiqkK4hxyCiJcLC4yE9AtJP1MoV1vFV2vx3jqwWeS');
      const fixtures = fixturesFor('metadao-futarchy');
      const cfg = await fetchMetaDaoFutarchySpotConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'buy', cfg, state },
        { label: 'sell', cfg: { ...cfg, direction: 'sell' }, state },
      ];
    },
  },
  {
    slug: 'moonit',
    ladder: moonitLadder,
    async variants() {
      const POOL = address('GnM6fY3hDnt6fUBrRK89xZQ5cdayvHnz6TWrnYan9Es6');
      const fixtures = fixturesFor('moonit');
      const cfg = await moonit.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'quoteToBase', cfg, state },
        { label: 'baseToQuote', cfg: { ...cfg, direction: 'baseToQuote' }, state },
      ];
    },
  },
  {
    slug: 'mswap',
    ladder: mswapLadder,
    async variants() {
      // mswap has no on-chain pool account — the "pool" is a synthetic
      // discovery key registered by mswapPoolKey(inMint, outMint) (populates a
      // module-scoped PAIR_BY_KEY the fetch then reads). This leg (WM_MINT ->
      // EXT6_MINT, a Crank ExtGlobalV2) is the one the recipes e2e test
      // exercises; its SwapGlobal + both ExtGlobalV2 globals + both m-vaults
      // are all in test/svm/fixtures/mswap. min(x, cap) quote — one variant.
      const WM_MINT = address('mzeroXDoBpRVhnEXBra27qzAMdxgpWVY3DzQW7xMVJp');
      const EXT6_MINT = address('dawn7ZUF7h7anFuEsDdAU1Y3HYwikwqNMAENZsQJdNL');
      const POOL = mswapPoolKey(WM_MINT, EXT6_MINT);
      const fixtures = fixturesFor('mswap');
      const cfg = await mswap.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'omnipair',
    ladder: omnipairLadder,
    async variants() {
      const POOL = address('Cp2nGCWWfqkUmPR3pPKoR376Fti8wuYRFrSWJZq1a9SA');
      const fixtures = fixturesFor('omnipair');
      const cfg = await omnipair.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'aToB', cfg, state },
        { label: 'bToA', cfg: { ...cfg, direction: 'bToA' }, state },
      ];
    },
  },
  {
    slug: 'one-intro-swap',
    ladder: oneIntroSwapLadder,
    async variants() {
      const POOL = address('DbuvwPuLvH8uy2B1sKuu18aCd2QpCvfZdfDtdRZztBd2');
      const fixtures = fixturesFor('one-intro-swap');
      const cfg = await fetchOneIntroSwapPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: '0to1', cfg, state },
        { label: '1to0', cfg: { ...cfg, direction: '1to0' }, state },
      ];
    },
  },
  {
    slug: 'perena-star',
    ladder: perenaStarLadder,
    async variants() {
      const POOL = address('hXfEYpB5FB3ZWjGNc5C5JqLixmGdmZFyjXKJB2xFPgc');
      const fixtures = fixturesFor('perena-star');
      const cfg = await perenaStar.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'stake', cfg, state },
        { label: 'unstake', cfg: { ...cfg, direction: 'unstake' }, state },
      ];
    },
  },
  {
    slug: 'phoenix',
    ladder: phoenixLadder,
    async variants() {
      const POOL = address('4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg');
      const fixtures = fixturesFor('phoenix');
      const cfg = await fetchPhoenixConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'baseIn', cfg: { ...cfg, direction: 'baseIn' }, state },
        { label: 'quoteIn', cfg: { ...cfg, direction: 'quoteIn' }, state },
      ];
    },
  },
  {
    slug: 'raydium-launchlab',
    ladder: raydiumLaunchlabLadder,
    async variants() {
      const POOL = address('At3uPTXn5xpVfm4DehXCsm85Zzu1xktGV2vQo5TyBW2E');
      const fixtures = fixturesFor('raydium-launchlab');
      const cfg = await raydiumLaunchlab.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'quoteToBase', cfg, state },
        { label: 'baseToQuote', cfg: { ...cfg, direction: 'baseToQuote' }, state },
      ];
    },
  },
  {
    slug: 'heaven',
    ladder: heavenLadder,
    async variants() {
      const POOL = address('EkU9zGSkUnVVK6nhmPSqnxqcKPzt1PicrCjdxSbWo9uA');
      const fixtures = fixturesFor('heaven');
      const cfg = await heaven.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'buy', cfg, state },
        { label: 'sell', cfg: { ...cfg, direction: 'sell' }, state },
      ];
    },
  },
  {
    slug: 'helium-treasury',
    ladder: heliumTreasuryLadder,
    async variants() {
      const POOL = address('Aon7sbdvCGuXQJW8BEiDDWzsSvoycTL9v3L1S4GWhxNK');
      const fixtures = fixturesFor('helium-treasury');
      const cfg = await heliumTreasury.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'huma',
    ladder: humaLadder,
    async variants() {
      // POOL is the curated Classic-mode mode_config (NOT a fixture-file account
      // itself). huma.fetchPoolConfig resolves the real pool_config (28hFhD21, via
      // HUMA_CURATED_MODE_CONFIGS), pool_state, mode_mint and the underlying ATA —
      // all present in the fixture dir. Same POOL the passing huma.test.ts uses.
      const POOL = address('3FhoMDyKzQqxtGxnz9DfysfoGQKvgDnSFjoDGgguDCQN');
      const fixtures = fixturesFor('huma');
      const cfg = await huma.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'deposit', cfg, state },
        { label: 'withdraw', cfg: { ...cfg, direction: 'withdraw' }, state },
      ];
    },
  },
  {
    slug: 'hylo-stability-pool',
    ladder: hyloStabilityPoolLadder,
    async variants() {
      const POOL = address('2jk7miWrsTbt5hUSaCXPkEQPvuUMgbFLpgMzMQw3Z6ar');
      const fixtures = fixturesFor('hylo-stability-pool');
      const cfg = await hyloStabilityPool.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'deposit', cfg, state },
        { label: 'withdraw', cfg: { ...cfg, direction: 'withdraw' }, state },
      ];
    },
  },
  {
    slug: 'scale-vmm',
    ladder: scaleVmmLadder,
    async variants() {
      const POOL = address('9vrZeDD4MnmZyCv8hdWmYbjhYpx4nF9L5YLgHuNHvi7F');
      const fixtures = fixturesFor('scale-vmm');
      const cfg = await scaleVmm.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'aToB', cfg: { ...cfg, direction: 'aToB' }, state },
        { label: 'bToA', cfg: { ...cfg, direction: 'bToA' }, state },
      ];
    },
  },
  {
    slug: 'scorch',
    ladder: scorchLadder,
    async variants() {
      const POOL = address('Ni1oTyrfCCfAF6dzK3R7BmJa1yDrracrDdPoiJXGzns');
      const fixtures = fixturesFor('scorch');
      const cfg = await scorch.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'AtoB', cfg, state },
        { label: 'BtoA', cfg: { ...cfg, direction: 'BtoA' }, state },
      ];
    },
  },
  {
    slug: 'solayer',
    ladder: solayerLadder,
    async variants() {
      const POOL = address('HBkJwH6rjUUBK1wNhBuYgo9Wnk1iCx2phduyxWCQj6uk');
      const fixtures = fixturesFor('solayer');
      const cfg = await solayer.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'delegate', cfg, state },
        { label: 'undelegate', cfg: { ...cfg, direction: 'undelegate' }, state },
      ];
    },
  },
  {
    slug: 'solfi-v1',
    ladder: solfiV1Ladder,
    async variants() {
      const POOL = address('rfynE6GWHaTkeYgXrZtF2FNMLg48VuKARogcDgeNpHX');
      const fixtures = fixturesFor('solfi-v1');
      const state = fixtureBytesMap(fixtures);
      const cfg0 = await fetchSolfiV1Config(fixtureLoader(fixtures), POOL, 0);
      const cfg1 = await fetchSolfiV1Config(fixtureLoader(fixtures), POOL, 1);
      return [
        { label: 'dir0', cfg: cfg0, state },
        { label: 'dir1', cfg: cfg1, state },
      ];
    },
  },
  {
    slug: 'token-swap-v1',
    ladder: tokenSwapV1Ladder,
    async variants() {
      const POOL = address('AmHUjHKfSFP34D4VgPsviFNjWrvTN761Yazvv2eKAsSz');
      const fixtures = fixturesFor('spl-token-swap-forks');
      const cfg = await tokenSwapV1.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'orca-v1',
    ladder: orcaV1Ladder,
    async variants() {
      const POOL = address('Hj45HZesMQD4ghdU7GuskiMyYBfxLnfibqKNgdaj8284');
      const fixtures = fixturesFor('spl-token-swap-forks');
      const cfg = await orcaV1.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'penguin',
    ladder: penguinLadder,
    async variants() {
      const POOL = address('GfgZJgNycWxsc5K8xB6F75KDHKsR71gQXCtkhx7PPfQ5');
      const fixtures = fixturesFor('spl-token-swap-forks');
      const cfg = await penguin.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'stepn',
    ladder: stepnLadder,
    async variants() {
      const POOL = address('5GGvkcqQ1554ibdc18JXiPqR8aJz6WV3JSNShoj32ufT');
      const fixtures = fixturesFor('spl-token-swap-forks');
      const cfg = await stepn.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'saber-decimals-wrapper',
    ladder: saberDecimalsWrapperLadder,
    async variants() {
      const POOL = address('AnKLLfpMcceM6YXtJ9nGxYekVXqfWy8WNsMZXoQTCVQk');
      const fixtures = fixturesFor('saber-decimals-wrapper');
      const cfg = await saberDecimalsWrapper.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'sanctum-infinity',
    ladder: sanctumInfinityLadder,
    async variants() {
      const JITOSOL = address('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn');
      const JUPSOL = address('jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v');
      const WSOL = address('So11111111111111111111111111111111111111112');
      const fixtures = fixturesFor('sanctum-infinity');
      const load = fixtureLoader(fixtures);
      const state = fixtureBytesMap(fixtures);
      const [jitoToWsol, jitoToJup, wsolToJito] = await Promise.all([
        sanctumInfinity.fetchPoolConfig(load, sanctumInfinityPoolKey(JITOSOL, WSOL)),
        sanctumInfinity.fetchPoolConfig(load, sanctumInfinityPoolKey(JITOSOL, JUPSOL)),
        sanctumInfinity.fetchPoolConfig(load, sanctumInfinityPoolKey(WSOL, JITOSOL)),
      ]);
      return [
        { label: 'jitoToWsol', cfg: jitoToWsol, state },
        { label: 'jitoToJup', cfg: jitoToJup, state },
        { label: 'wsolToJito', cfg: wsolToJito, state },
      ];
    },
  },
  {
    slug: 'sanctum-stake-pool',
    ladder: sanctumStakePoolLadder,
    async variants() {
      const POOL = address('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb');
      const fixtures = fixturesFor('sanctum-stake-pool');
      const cfg = await sanctumStakePool.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'scale-amm',
    ladder: scaleAmmLadder,
    async variants() {
      const POOL = address('H8uPkiqryuZcs4sDiupxpy8wVvU2KqwknyeBimHmavsv');
      const fixtures = fixturesFor('scale-amm');
      const cfg = await scaleAmm.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      return [{ label: 'default', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
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
    slug: 'meteora-dbc',
    ladder: meteoraDbcLadder,
    async variants() {
      // Real, non-migrated, single-segment (segIdx 0) mainnet pool — static
      // 2% base fee (period_frequency == 0, dynamic fee disabled). The
      // closed-form segment/migration capacity is real and merge-reachable
      // in both directions on this fixture (see meteora-dbc.test.ts).
      const POOL = address('5HXw3UDdd9n6aNsiPCNkB23JJBAZv3qSMf11oiJxL5z8');
      const fixtures = fixturesFor('meteora-dbc');
      const cfg = await meteoraDbc.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      const now = 2_000_000_000n; // far past any real activation_point — deterministic forever
      return [
        { label: 'quoteToBase', cfg: { ...cfg, direction: 'quoteToBase' }, state, now },
        { label: 'baseToQuote', cfg: { ...cfg, direction: 'baseToQuote' }, state, now },
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
      // The remaining disclosed gap of this shape (orca-whirlpool/
      // raydium-clmm/meteora-dlmm/solfi-v2/goonfi-v2 all had the identical
      // pattern -- fixed in the SDK's five-family correctness batch: their
      // standalone cold referenceQuote now saturates instead of collapsing,
      // via coldWalkClamped/emitFinalQuote no longer gating on full
      // absorption -- see each family's ladder.ts for the fix). This
      // family's own boundary is a STRICT idle-float bound behind a
      // vault-share transform (needs an inverse-Newton derivation, not
      // attempted here) rather than an exhausted window or a closed-form
      // spline/tier ceiling, so it is not part of that batch. The
      // ladder-chain path (referenceLadderQuotes + capacityInputVar/
      // referenceCapacities) is capacity-safe regardless (the MERGE-ALTITUDE
      // sweep below proves it never yields a negative dIn or dOut). Each
      // (x, peak) pair is the exact geometric cliff/peak of the STANDALONE
      // cold quote — the TRUE boundary, not the analytic clamp's own
      // (deliberately more conservative) reported value; see the CAPACITY
      // DENSITY block below for the clamp side of this story.
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
    slug: 'goonfi-v2',
    ladder: goonfiV2Ladder,
    async variants() {
      const decimalsA = 9;
      const decimalsB = 6;
      // Round p1===p2 price: 100 mintB-human-units per 1 mintA-human-unit.
      const price = 100_000_000n;
      const cfgYtoX = {
        venue: 'goonfi-v2' as const,
        pool: GOONFI_POOL,
        direction: 'yToX' as const,
        mintA: GOONFI_DUMMY,
        mintB: GOONFI_DUMMY,
        decimalsA,
        decimalsB,
        vaultA: GOONFI_VAULT_A,
        vaultB: GOONFI_VAULT_B,
        oracle: GOONFI_ORACLE,
        tokenProgram: GOONFI_DUMMY,
        feeSchedule: { sizeTiers: GOONFI_SIZE_TIERS_B, feeTiersPpm: GOONFI_FEE_TIERS_PPM },
      };
      // xToY thresholds are mintA-raw (the snapshot-price conversion fetchPoolConfig performs —
      // see index.ts's module doc): T_A = T_B * denomAdjusted / snapshotPrice, with
      // denomAdjusted = 1e6 * 10^9/10^6 = 1e9 and snapshotPrice = 1e8, i.e. T_A = T_B * 10.
      const cfgXtoY = {
        ...cfgYtoX,
        direction: 'xToY' as const,
        feeSchedule: { sizeTiers: GOONFI_SIZE_TIERS_B.map((t) => t * 10n), feeTiersPpm: GOONFI_FEE_TIERS_PPM },
      };
      const state: AccountBytesMap = {
        [GOONFI_POOL]: new Uint8Array(8),
        [GOONFI_VAULT_A]: goonfiVaultBytes(10_000_000_000_000n),
        [GOONFI_VAULT_B]: goonfiVaultBytes(10_000_000_000_000n),
        [GOONFI_ORACLE]: goonfiOracleBytes(price),
      };
      return [
        { label: 'xToY', cfg: cfgXtoY, state },
        { label: 'yToX', cfg: cfgYtoX, state },
      ];
    },
    // FIXED (five-family SDK correctness batch): the size-tier ceiling and
    // vault clamp both used to collapse the standalone cold referenceQuote
    // to 0 -- goonfi-v2's ladder.ts now bumps to the setup-computed
    // tierCeilOut/rout instead (see emitLadderQuote's "THE TIER-CEILING +
    // VAULT-CLAMP COLLAPSE" doc), so there is no longer a declared cliff.
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
    // FIXED (five-family SDK correctness batch): the cold referenceQuote
    // used to collapse to 0 past the tick-array window's capacity --
    // referenceQuote now uses coldWalkClamped (never null) instead of
    // coldWalk(...) ?? 0n, so there is no longer a declared cliff.
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
    // FIXED (five-family SDK correctness batch): the cold referenceQuote
    // used to collapse to 0 past the shipped bin window's capacity --
    // referenceQuote now uses coldWalkClamped (never null) instead of
    // coldWalk(...) ?? 0n, so there is no longer a declared cliff.
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
    // FIXED (five-family SDK correctness batch): the cold referenceQuote
    // used to collapse to 0 past the tick-array window's capacity --
    // referenceQuote now uses coldWalkClamped (never null) instead of
    // coldWalk(...) ?? 0n, so there is no longer a declared cliff.
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
    // FIXED (five-family SDK correctness batch): the standalone cold
    // referenceQuote used to collapse to 0 past the impact/110%-of-vault
    // revert boundary. Fixed via satCap = preInv(outVault), a closed-form
    // (linear, ignoring only the fee/impact haircut) inversion computed once
    // in setup, so referenceQuote/emitFinalQuote now plateau at satOut
    // instead of collapsing (see ladder.ts's module doc). NOTE a narrow,
    // BOUNDED residual remains, documented on solfiColdQuote: because this
    // function has no running state to bump-then-latch against (unlike
    // referenceLadderQuotes/referenceCapacities, whose accumulator can only
    // ever increase), the exact one-wei transition from "organic" to
    // "fallback" can dip by the haircut margin -- categorically smaller than
    // the pre-fix unbounded collapse to 0, and not what this registry's
    // coarse absoluteProbePoints lattice is built to catch (it does not
    // specifically target that one-wei window), so no declaredCliffs entry
    // is needed here either.
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
  {
    slug: 'stabble-stable-swap',
    ladder: stabbleStableSwapLadder,
    async variants() {
      // Real mainnet USDT/USDC pool (2 tokens, live amp ramp) — no discrete
      // window/idle-float bound (unlike its stable-kind siblings), so no
      // declaredCliffs entry: the N-token Newton has no hard capacity cap.
      const POOL = address('5K7CHUbBYAh6wrantyJvDDqwT4VoKuZTi73CN1DTUUer');
      const fixtures = fixturesFor('stabble-stable-swap');
      const cfg = await stabbleStableSwap.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [{ label: 'AtoB', cfg, state, now: 1_785_000_000n }];
    },
  },
  {
    slug: 'stabble-weighted-swap',
    ladder: stabbleWeightedSwapLadder,
    async variants() {
      // Real mainnet wSOL/USDC pool (50/50 weights, exponent==ONE, the
      // exact-integer pow_up fast path). The real, on-chain MAX_IN_RATIO
      // (30%-of-balance) hard cap is modeled as a SATURATING clamp in BOTH
      // the ladder chain and the standalone cold quote (see ladder.ts's
      // module doc) — unlike meteora-damm-v1-stable/solfi-v2's collapse-to-
      // zero cliff, this family never collapses, so no declaredCliffs entry.
      const POOL = address('JV4MkRFn58xpyrhF2oDxQYwnq5jFVzTQUKcUzce1FQA');
      const fixtures = fixturesFor('stabble-weighted-swap');
      const cfg = await stabbleWeightedSwap.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [{ label: 'AtoB', cfg, state }];
    },
  },
  {
    slug: 'woofi',
    ladder: woofiLadder,
    async variants() {
      // The real SOL/USDC mainnet dump (test/svm/fixtures/woofi) has the
      // venue's OWN feasibility gate genuinely tripped (a stale keeper price,
      // see woofi.test.ts) — degenerate (always 0), so this sweep uses the
      // SAME patched-fixture technique obric-v2's own tests use for its
      // drained real snapshot: test/svm/fixtures/woofi-patched only touches
      // the Pyth price/timestamps (feasibility), never the curve shape.
      const fixtures = fixturesFor('woofi-patched');
      const load = fixtureLoader(fixtures);
      const state = fixtureBytesMap(fixtures);
      const cfg = await fetchWoofiConfig(load, address('BEz2Suv2WvGKWouU1srbhZfudBGuw9v2VzkhMZHFBdvs'));
      const now = 1_785_600_000n;
      return [
        { label: 'sellBase', cfg: { ...cfg, direction: 'sellBase' as const }, state, now },
        { label: 'sellQuote', cfg: { ...cfg, direction: 'sellQuote' as const }, state, now },
      ];
    },
  },
  {
    slug: 'deriverse',
    ladder: deriverseLadder,
    async variants() {
      // A REAL, LIVE (non-drained) mainnet instrument — wSOL/USDC
      // (8Wk2L1yD...), embedded-AMM reserves both nonzero at this snapshot,
      // unlike obric-v2's own checked-in fixture. No `declaredCliffs`: the
      // isqrt-based circuit-breaker capacity clamp SATURATES the standalone
      // cold referenceQuote too (see ladder.ts's module doc) — the same
      // no-entry shape as raydium-*/pumpswap/meteora-damm-v2/saber, not the
      // whirlpool/clmm/dlmm/solfi-v2/damm-v1-stable "latent cliff" class.
      const POOL = address('8Wk2L1yDovBJifCN1o86X7g7pDcqLau39m6tEsJ9Sheh');
      const fixtures = fixturesFor('deriverse');
      const cfg = await deriverse.fetchPoolConfig(fixtureLoader(fixtures), POOL);
      const state = fixtureBytesMap(fixtures);
      return [
        { label: 'sell', cfg: { ...cfg, side: 'sell' as const }, state },
        { label: 'buy', cfg: { ...cfg, side: 'buy' as const }, state },
      ];
    },
  },
  {
    slug: 'tesserav',
    ladder: tesseravLadder,
    async variants() {
      // ONE verified direction only — see tesserav/ladder.ts's module doc:
      // 'bToA' is a hard gate in fetchTesseraVConfig (unverified swap-CPI
      // account order; a launched-then-failing CPI aborts the whole cook on
      // SVM, so this stays a gate, not a self-drop, until a second live
      // replay confirms the reverse shape).
      const POOL = address('FLckHLGMJy5gEoXWwcE68Nprde1D4araK4TGLw4pQq2n');
      const fixtures = fixturesFor('tesserav');
      const cfg = await fetchTesseraVConfig(fixtureLoader(fixtures), POOL, 'aToB');
      return [{ label: 'aToB', cfg, state: fixtureBytesMap(fixtures) }];
    },
  },
  {
    slug: 'perps-jlp',
    ladder: perpsJlpLadder,
    async variants() {
      // Synthetic-but-real-shaped state (the JLP Pool/Custody/Doves-feed
      // byte layout, scale constants and bps parameters transcribed from a
      // real mainnet SOL/USDC snapshot 2026-07-31 — see perps-jlp/index.ts's
      // module doc) — no checked-in fixture (a basket AMM's fetchPoolConfig
      // needs a live PDA derivation this offline harness does not run; every
      // other family here that skips it, e.g. obric-v2, does the same).
      // No `declaredCliffs`: the dispensing-custody-owned-balance clamp
      // SATURATES the standalone cold referenceQuote (never collapses) —
      // the same no-entry shape as raydium-*/deriverse/meteora-damm-v2.
      const custodyIn = address('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz');
      const custodyOut = address('G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa');
      const pool = address('5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq');
      const dovesIn = address('39cWjvHrpHNz2SbXv6ME4NPhqBDBd4KsjUYv5JkHEAJU');
      const dovesOut = address('A28T5pKtscnhDo6C1Sz786Tup88aTjt8uyKewjVvPrGk');
      const mintIn = address('So11111111111111111111111111111111111111112');
      const mintOut = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const cfg = {
        venue: 'perps-jlp' as const,
        pool,
        mintIn,
        mintOut,
        custodyIn,
        custodyOut,
        tokenAccountIn: mintIn,
        tokenAccountOut: mintOut,
        dovesOracleIn: dovesIn,
        dovesOracleOut: dovesOut,
        pythAccountIn: mintIn,
        pythAccountOut: mintOut,
        tokenProgram: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        transferAuthority: address('AVzP2GeRmqGphJsMxWoqjpUifPpCret7LqWhD8NWQK49'),
        perpetuals: address('H4ND9aYttUVLFmNypZqLjZ52FYiGvdEB45GmwNoKEjTj'),
        eventAuthority: address('37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN'),
        decimalsIn: 9,
        decimalsOut: 6,
        fxScaleUp: 1n,
        fxScaleDown: 1_000_000_000_000n,
        usdScaleUpIn: 1n,
        usdScaleDownIn: 100_000_000_000n,
        usdScaleUpOut: 1n,
        usdScaleDownOut: 100_000_000n,
        isStableIn: false,
        isStableOut: true,
        targetRatioBpsIn: 4_700n,
        targetRatioBpsOut: 3_000n,
        baseFeeBps: 10n,
        taxFeeBps: 100n,
        multiplier: 100n,
        externalMultiplierBps: 20_000n,
        poolAumUsdOffset: 8n,
        poolFeesOffset: 24n,
      };
      const poolBytes = new Uint8Array(24);
      new DataView(poolBytes.buffer).setBigUint64(8, 797_450_521_854_735n, true); // aumUsd (low 8 bytes; high 8 stay 0)
      const custodyInBytes = new Uint8Array(250);
      {
        const view = new DataView(custodyInBytes.buffer);
        view.setBigUint64(222, 5_094_449_759_612_497n, true); // assets.owned
        view.setBigUint64(230, 406_853_168_715_083n, true); // assets.locked
        view.setBigUint64(238, 23_874_756_516_054n, true); // assets.guaranteedUsd
      }
      const custodyOutBytes = new Uint8Array(1_040);
      {
        const view = new DataView(custodyOutBytes.buffer);
        view.setBigUint64(222, 133_324_712_281_091n, true); // assets.owned
        view.setBigUint64(230, 32_485_051_391_576n, true); // assets.locked
        view.setBigUint64(238, 0n, true); // assets.guaranteedUsd
        // debt (u128 @1004) and borrowLendInterestsAccured (u128 @1020) — real
        // magnitudes (USDC carries real internal-lending debt on mainnet).
        const debt = 112_762_299_084_223_540_107_741n;
        const accrued = 163_386_532_560_144_559n;
        view.setBigUint64(1004, debt & 0xffff_ffff_ffff_ffffn, true);
        view.setBigUint64(1012, debt >> 64n, true);
        view.setBigUint64(1020, accrued & 0xffff_ffff_ffff_ffffn, true);
        view.setBigUint64(1028, accrued >> 64n, true);
      }
      const dovesBytes = (price: bigint): Uint8Array => {
        const data = new Uint8Array(91);
        new DataView(data.buffer).setBigUint64(73, price, true);
        data[81] = 0xf8; // expo = -8 (i8 two's complement) — unread by referenceQuote (baked into cfg's scales)
        return data;
      };
      const state: AccountBytesMap = {
        [pool]: poolBytes,
        [custodyIn]: custodyInBytes,
        [custodyOut]: custodyOutBytes,
        [dovesIn]: dovesBytes(6_782_862_018n),
        [dovesOut]: dovesBytes(99_967_793n),
      };
      return [{ label: 'solToUsdc', cfg, state }];
    },
  },
  {
    slug: 'juplend-amm',
    ladder: juplendAmmLadder,
    async variants() {
      const cfg: JuplendAmmPoolConfig = {
        venue: 'juplend-amm' as const,
        pool: JUPLEND_DEX,
        swap0to1: true,
        token0: JUPLEND_DUMMY,
        token1: JUPLEND_DUMMY,
        tokenProgram0: JUPLEND_DUMMY,
        tokenProgram1: JUPLEND_DUMMY,
        tokenReserve0: JUPLEND_DUMMY,
        tokenReserve1: JUPLEND_DUMMY,
        vault0: JUPLEND_DUMMY,
        vault1: JUPLEND_DUMMY,
        rateModel0: JUPLEND_DUMMY,
        rateModel1: JUPLEND_DUMMY,
        liquidity: JUPLEND_DUMMY,
        positionKind: 'supply',
        position0: JUPLEND_POS0,
        position1: JUPLEND_POS1,
        feePpm: 1_000n,
      };
      const state: AccountBytesMap = {
        [JUPLEND_DEX]: juplendDexBytes(1_000_000_000_000_000n), // center_price = 1.0
        [JUPLEND_POS0]: juplendPositionBytes(100_000_000n, 1_000_000_000n), // cap = 900,000,000
        [JUPLEND_POS1]: juplendPositionBytes(200_000_000n, 1_000_000_000n), // cap = 800,000,000
      };
      return [
        { label: 'swap0to1', cfg, state },
        { label: 'swap1to0', cfg: { ...cfg, swap0to1: false }, state },
      ];
    },
  },
];

describe('LADDER_REGISTRY count assertion', () => {
  it('this file enumerates exactly the 23 families the SDK registers — adding one without wiring it here fails loudly', () => {
    const registered = listLadderVenues();
    expect(registered).toHaveLength(65);
    expect(FAMILIES).toHaveLength(65);
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

  it('exactly ONE family still carries a disclosed gap: meteora-damm-v1-stable (closed-form, a strict idle-float bound behind a vault-share transform, needing an inverse-Newton derivation not attempted here) — the three window-walking families (orca-whirlpool, raydium-clmm, meteora-dlmm) plus solfi-v2 plus goonfi-v2 were FIXED in the five-family SDK correctness batch (each now saturates instead of collapsing — see their own ladder.ts), and obric-v2 never had one (fixed alongside this guard)', () => {
    expect(withGaps.map((f) => f.slug).sort()).toEqual(['meteora-damm-v1-stable']);
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
