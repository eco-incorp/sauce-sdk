/**
 * solswapBest end-to-end on the REAL SVM engine (LiteSVM): multi-venue
 * programs generated over the adapters' mainnet fixture dumps, executed
 * through the sdk's pure builders. Venue programs are NOT deployed here, so
 * the winning CPI is either a stand-in (an SPL-token transfer crediting the
 * user's outAta — the token program ships with LiteSVM) or deliberately
 * bracketed through the pre-CPI "minOut" revert; the real-venue-binary CPI
 * lives in the SAUCE_VENUE_PROGRAMS-gated suite at the bottom.
 *
 * Scenarios:
 *  1. 4 live venues + stand-in winner: exact pay returns the realized delta;
 *     an underpaying stand-in trips the post-swap check (payload "out").
 *  2. live + external mix where the external wins: the returned value is the
 *     realized outAta delta, not the baked quote.
 *  3. stable-only pair: the shared Newton helpers are declared once, and the
 *     in-VM bestOut is pinned exactly via the minOut revert bracket.
 *  4. DAMM v2 sqrt-price pool next to CP pools: the sqrt quote wins the scan
 *     with its facts-pinned value.
 *  5. minOut over every quote: reverts with "minOut" BEFORE any CPI.
 *  6. ALT path: a fabricated lookup-table account compresses the transaction
 *     and the compressed v0 message executes.
 *
 * Requires the engine .so (SAUCE_ENGINE_SO); every suite skips cleanly
 * without it.
 */
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { address, getCompiledTransactionMessageDecoder } from '@solana/kit';
import type { Address } from '@solana/kit';
import { solswapBest } from '../../src/recipes/solswap/index.js';
import type { SolswapBestOutput, SolswapBestPool } from '../../src/recipes/solswap/index.js';
import { selectAltAddresses, resolveAccounts } from '../../src/svm/index.js';
import type { AccountResolution, VenueSwap } from '../../src/svm/index.js';
import { venueAdapter } from '../../src/svm/venues/registry.js';
import { USER_VOLUME_ACCUMULATOR_REF } from '../../src/svm/venues/pumpswap/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from './fixtures.js';
import type { AccountFixture } from './fixtures.js';
import {
  describeSvm,
  ENGINE_SO,
  execute,
  expectFail,
  expectOk,
  fabricateAlt,
  getTransactionSize,
  loadFixtureAccounts,
  randomAddress,
  sendSigned,
  setTokenAccount,
  signExecuteTransaction,
  splTransferData,
  startEngine,
  toBigInt,
  tokenAmount,
  TOKEN_PROGRAM,
} from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';

// ── fixture pools (the venue unit suites' mainnet snapshots) ────────────────

const VENUE_POOL: Record<string, Address> = {
  'raydium-cp-swap': address('7JuwJuNU88gurFnyWeiyGKbFmExMWcmRZntn9imEzdny'),
  'raydium-amm-v4': address('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'),
  pumpswap: address('2uF4Xh61rDwxnG9woyxsVQP7zuA6kLFpb3NvnRQeoiSd'),
  'orca-legacy-token-swap': address('EGZ7tiLeH62TPV1gL8WwbXGzEPa9zmcpVnnkPKKnrE2U'),
  'meteora-damm-v2': address('8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie'),
  'saber-stableswap': address('YAkoNb6HKmSxQN9L8hiBE5tPJRsniSSMzND1boHmZxe'),
  'meteora-damm-v1-stable': address('32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG'),
};

// Facts-file pins re-asserted where a scenario's clock matches the pin's.
const DAMM_V2_PIN = 81_533_661n; // 1 SOL -> 81.533661 USDC
const DAMM_V1S_PIN = 1_000_605_351n; // 1e9 uUSDC -> 1000605351 uUSDT at CLOCK_T
const SABER_PIN = 1_000_603n; // 1.0 USDC -> 1.000603 USDT (post-ramp)

// Post-gate clocks: the CP venues are time-free, the pins above hold at their
// facts timestamps (see venue-triangle.e2e.test.ts for the full triangle).
const CLOCK_CP = 1_783_123_200n;
const CLOCK_DAMM_V2 = 1_780_000_000n;
const CLOCK_STABLE = 1_783_175_236n; // meteora-damm-v1-stable snapshot clock

const AMOUNT_IN = 1_000_000_000n;
const OUT_ATA_START = 5_000_000n;
const USER = { outAta: 'user_out', inAta: 'user_in', owner: 'payer' };

const fixturesDir = (slug: string) => resolve(process.cwd(), 'test', 'svm', 'fixtures', slug);
const venueFixtures = (slugs: string[]): AccountFixture[] => slugs.flatMap((slug) => loadFixtures(fixturesDir(slug)));

/** Off-chain reference quote for a live pool over its fixture snapshot at `clock`. */
const referenceFor = async (slug: string, fixtures: AccountFixture[], amountIn: bigint, clock: bigint): Promise<bigint> => {
  const adapter = venueAdapter(slug);
  const cfg = await adapter.fetchPoolConfig(fixtureLoader(fixtures), VENUE_POOL[slug]);
  return adapter.referenceQuote(cfg, fixtureBytesMap(fixtures), amountIn, clock);
};

const livePool = (slug: string): SolswapBestPool => ({ venue: slug, pool: VENUE_POOL[slug] });

/**
 * Stand-in winner: an external entry whose "swap" is an SPL-token transfer of
 * `pay` from a harness-funded vault into the user's outAta. `quotedOut` is
 * what the scan sees; `pay` is what the CPI delivers — split them to model a
 * stale external quote underpaying the post-swap check.
 */
const standIn = (vault: Address, quotedOut: bigint, pay: bigint, label = 'stand-in'): SolswapBestPool => {
  const swap: VenueSwap = {
    programId: TOKEN_PROGRAM,
    data: splTransferData(pay),
    accounts: [
      { ref: 'standin_vault', address: vault, writable: true },
      { ref: USER.outAta, writable: true },
      { ref: USER.owner, signer: true }, // the payer owns the stand-in vault
    ],
  };
  return { external: { label, quotedOut, swap } };
};

interface Scenario {
  harness: EngineHarness;
  output: SolswapBestOutput;
  resolution: AccountResolution;
  outAta: Address;
}

interface ScenarioInput {
  pools: SolswapBestPool[];
  fixtures: AccountFixture[];
  minOut: bigint;
  clock: bigint;
  amountIn?: bigint;
  /** Pre-created stand-in vault to fund (mint-matched with the outAta). */
  vault?: Address;
}

const buildScenario = async ({ pools, fixtures, minOut, clock, amountIn = AMOUNT_IN, vault }: ScenarioInput): Promise<Scenario> => {
  const output = await solswapBest({
    amountIn,
    minOut,
    pools,
    user: USER,
    load: fixtureLoader(fixtures),
  });

  const harness = await startEngine(clock);
  loadFixtureAccounts(harness, fixtures);

  const mint = randomAddress();
  const outAta = setTokenAccount(harness, randomAddress(), mint, harness.payer.address, OUT_ATA_START);
  if (vault !== undefined) setTokenAccount(harness, vault, mint, harness.payer.address, 10n ** 15n);

  // user_in is attached (writable) by every venue swap but never touched:
  // only the winner's CPI runs, and the stand-in reads just its own vault.
  // pumpswap additionally declares the caller-derived user-volume-accumulator
  // PDA — resolve it whenever the plan interned it (also never touched).
  const resolution: AccountResolution = { [USER.outAta]: outAta, [USER.inAta]: randomAddress() };
  if (output.accountPlan.metas.some((meta) => meta.ref === USER_VOLUME_ACCUMULATOR_REF)) {
    resolution[USER_VOLUME_ACCUMULATOR_REF] = randomAddress();
  }

  return { harness, output, resolution, outAta };
};

const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

// ── scenario 1: 4 live venues + stand-in winner, exact pay and underpay ────

describeSvm('solswapBest e2e: 4-venue live mix with a stand-in winner', () => {
  const slugs = ['raydium-cp-swap', 'raydium-amm-v4', 'orca-legacy-token-swap', 'pumpswap'];
  const QUOTED = 1_000_000_000_000n; // above pumpswap's ~632.7e9, the best live quote

  it('quotes all four venues in-VM, CPIs only the stand-in, returns the realized delta', async () => {
    const fixtures = venueFixtures(slugs);
    const liveRefs = await Promise.all(slugs.map((slug) => referenceFor(slug, fixtures, AMOUNT_IN, CLOCK_CP)));
    for (const ref of liveRefs) expect(ref).toBeLessThan(QUOTED); // the stand-in really wins

    const vault = randomAddress();
    const scenario = await buildScenario({
      pools: [...slugs.map(livePool), standIn(vault, QUOTED, QUOTED)],
      fixtures,
      minOut: QUOTED, // inclusive bound: bestOut == minOut passes
      clock: CLOCK_CP,
      vault,
    });

    // The generator's off-chain references match the adapters' (the venues
    // here are time-free, so the generator's wall-clock `now` is immaterial).
    expect(scenario.output.quotes.map((quote) => quote.reference)).toEqual([...liveRefs, QUOTED]);
    expect(scenario.output.quotes.map((quote) => quote.pool)).toEqual([
      ...slugs.map((slug) => VENUE_POOL[slug] as string),
      'stand-in',
    ]);

    // A 4-venue plan is ~50 static keys — beyond the 1232-byte packet, so a
    // production send is ALT-compressed; the harness mirrors that (it is also
    // required here: LiteSVM skips packet-size sanitization, and agave's
    // compute-budget filter hard-aborts on a program id index above the
    // sanitized-packet bound of 37 static keys).
    const metas = resolveAccounts(scenario.output.accountPlan, scenario.resolution, scenario.harness.payer.address);
    const lookupTables = fabricateAlt(scenario.harness, selectAltAddresses(metas));

    const result = expectOk(await execute(scenario.harness, scenario.output, scenario.resolution, { lookupTables }));
    expect(toBigInt(result.returnData)).toBe(QUOTED);
    expect(tokenAmount(scenario.harness, scenario.outAta)).toBe(OUT_ATA_START + QUOTED);
  });

  it('an underpaying stand-in trips the post-swap delta check with payload "out"', async () => {
    const fixtures = venueFixtures(slugs);
    const vault = randomAddress();
    const scenario = await buildScenario({
      // The scan still believes QUOTED, but the CPI delivers one token less
      // than minOut — the stale-external-quote failure mode.
      pools: [...slugs.map(livePool), standIn(vault, QUOTED, QUOTED - 1n)],
      fixtures,
      minOut: QUOTED,
      clock: CLOCK_CP,
      vault,
    });

    // ALT-compressed like a production 4-venue send (the plan overruns the
    // 1232-byte packet). It also sidesteps a LiteSVM limitation: a FAILING
    // transaction whose static key list exceeds the sanitized-packet bound
    // (~37 keys) aborts the process inside solana-compute-budget-instruction
    // ("program id index is sanitized") — compression keeps the static list
    // small, exactly as a real cluster send would.
    const metas = resolveAccounts(scenario.output.accountPlan, scenario.resolution, scenario.harness.payer.address);
    const lookupTables = fabricateAlt(scenario.harness, selectAltAddresses(metas));

    const failure = expectFail(await execute(scenario.harness, scenario.output, scenario.resolution, { lookupTables }));
    expect(utf8(failure.revertData)).toBe('out');
    // The whole transaction rolled back: the partial transfer is gone.
    expect(tokenAmount(scenario.harness, scenario.outAta)).toBe(OUT_ATA_START);
  });
});

// ── scenario 2: live + external mix, the external wins ─────────────────────

describeSvm('solswapBest e2e: external quote wins over a live venue', () => {
  it('returns the realized outAta delta, not the baked external quote', async () => {
    const amountIn = 1_000_000n;
    const fixtures = venueFixtures(['raydium-cp-swap']);
    const liveRef = await referenceFor('raydium-cp-swap', fixtures, amountIn, CLOCK_CP);
    expect(liveRef).toBe(81_443n); // facts pin: 1_000_000 WSOL lamports -> 81443 USDC

    const quoted = 100_000n; // beats the live 81_443
    const paid = 100_005n; // the venue over-delivers relative to its quote
    const vault = randomAddress();
    const scenario = await buildScenario({
      pools: [livePool('raydium-cp-swap'), standIn(vault, quoted, paid, 'prop-amm')],
      fixtures,
      minOut: 90_000n,
      clock: CLOCK_CP,
      amountIn,
      vault,
    });

    expect(scenario.output.quotes).toEqual([
      { pool: VENUE_POOL['raydium-cp-swap'], reference: liveRef },
      { pool: 'prop-amm', reference: quoted },
    ]);

    const result = expectOk(await execute(scenario.harness, scenario.output, scenario.resolution));
    // The program returns after - before, whatever the scan predicted.
    expect(toBigInt(result.returnData)).toBe(paid);
    expect(tokenAmount(scenario.harness, scenario.outAta)).toBe(OUT_ATA_START + paid);
  });
});

// ── scenario 3: stable-only pair, shared helpers + exact in-VM bestOut ─────

describeSvm('solswapBest e2e: stable-only pair shares one Newton helper set', () => {
  const slugs = ['saber-stableswap', 'meteora-damm-v1-stable'];

  it('declares stableD/stableY once and computes the exact pinned bestOut in-VM', async () => {
    const fixtures = venueFixtures(slugs);
    const refs = await Promise.all(slugs.map((slug) => referenceFor(slug, fixtures, AMOUNT_IN, CLOCK_STABLE)));
    expect(refs[1]).toBe(DAMM_V1S_PIN); // facts pin at this exact clock
    const best = refs[0] > refs[1] ? refs[0] : refs[1];

    // No stand-in and no deployed venue program, so the exact in-VM bestOut
    // is pinned by bracketing the pre-CPI minOut check:
    //   minOut = best + 1  -> revert "minOut"  (bestOut < best + 1)
    //   minOut = best      -> passes the check, then dies at the CPI to the
    //                         undeployed winner (bestOut >= best)
    // Together: bestOut == best, computed by the engine's own Newton loops.
    const over = await buildScenario({ pools: slugs.map(livePool), fixtures, minOut: best + 1n, clock: CLOCK_STABLE });
    expect(over.output.source.split('function stableD(').length - 1).toBe(1);
    expect(over.output.source.split('function stableY(').length - 1).toBe(1);

    const overFailure = expectFail(await execute(over.harness, over.output, over.resolution));
    expect(utf8(overFailure.revertData)).toBe('minOut');

    const at = await buildScenario({ pools: slugs.map(livePool), fixtures, minOut: best, clock: CLOCK_STABLE });
    const atFailure = expectFail(await execute(at.harness, at.output, at.resolution));
    expect(utf8(atFailure.revertData)).not.toBe('minOut');
  });
});

// ── scenario 4: DAMM v2 sqrt-price pool next to CP pools ───────────────────

describeSvm('solswapBest e2e: DAMM v2 sqrt pool wins next to CP pools', () => {
  const slugs = ['raydium-cp-swap', 'raydium-amm-v4', 'meteora-damm-v2'];

  it('the sqrt-price quote beats both CP quotes with its facts-pinned value', async () => {
    const fixtures = venueFixtures(slugs);
    const [cpRef, v4Ref, dammV2Ref] = await Promise.all(
      slugs.map((slug) => referenceFor(slug, fixtures, AMOUNT_IN, CLOCK_DAMM_V2)),
    );
    expect(dammV2Ref).toBe(DAMM_V2_PIN);
    expect(dammV2Ref).toBeGreaterThan(v4Ref);
    expect(v4Ref).toBeGreaterThan(cpRef);

    // Same minOut bracket as scenario 3 — the winner (listed LAST, so the
    // strictly-greater scan must actually flip bestIndex twice) is a live
    // venue whose program is not deployed.
    const over = await buildScenario({ pools: slugs.map(livePool), fixtures, minOut: DAMM_V2_PIN + 1n, clock: CLOCK_DAMM_V2 });
    const overFailure = expectFail(await execute(over.harness, over.output, over.resolution));
    expect(utf8(overFailure.revertData)).toBe('minOut');

    const at = await buildScenario({ pools: slugs.map(livePool), fixtures, minOut: DAMM_V2_PIN, clock: CLOCK_DAMM_V2 });
    const atFailure = expectFail(await execute(at.harness, at.output, at.resolution));
    expect(utf8(atFailure.revertData)).not.toBe('minOut');
  });
});

// ── scenario 5: minOut over every quote reverts before any CPI ─────────────

describeSvm('solswapBest e2e: minOut above every quote', () => {
  it('reverts with "minOut" before any CPI starts', async () => {
    const slugs = ['raydium-cp-swap', 'raydium-amm-v4', 'orca-legacy-token-swap'];
    const fixtures = venueFixtures(slugs);
    const scenario = await buildScenario({
      pools: slugs.map(livePool),
      fixtures,
      minOut: 1n << 60n,
      clock: CLOCK_CP,
    });

    // None of the venue programs is deployed: reaching a CPI would fail with
    // a non-"minOut" error, so the clean payload proves the revert fired
    // before the dispatch.
    const failure = expectFail(await execute(scenario.harness, scenario.output, scenario.resolution));
    expect(utf8(failure.revertData)).toBe('minOut');
    expect(tokenAmount(scenario.harness, scenario.outAta)).toBe(OUT_ATA_START);
  });
});

// ── scenario 6: address lookup table path ───────────────────────────────────

describeSvm('solswapBest e2e: fabricated address lookup table', () => {
  it('compresses the v0 message through the ALT and still executes', async () => {
    const slugs = ['raydium-cp-swap', 'raydium-amm-v4'];
    const fixtures = venueFixtures(slugs);
    const quoted = 100_000_000n; // above both live quotes
    const vault = randomAddress();
    const scenario = await buildScenario({
      pools: [...slugs.map(livePool), standIn(vault, quoted, quoted)],
      fixtures,
      minOut: quoted,
      clock: CLOCK_CP,
      vault,
    });

    // Fabricate the table over every non-signer resolved meta (signers must
    // stay static) and compress the same instruction both ways.
    const metas = resolveAccounts(scenario.output.accountPlan, scenario.resolution, scenario.harness.payer.address);
    const lookupTables = fabricateAlt(scenario.harness, selectAltAddresses(metas));

    const plain = await signExecuteTransaction(scenario.harness, scenario.output, scenario.resolution);
    const compressed = await signExecuteTransaction(scenario.harness, scenario.output, scenario.resolution, { lookupTables });

    // Every looked-up account costs 1 index byte instead of a 32-byte static
    // entry, so the compressed message must be materially smaller.
    expect(getTransactionSize(compressed)).toBeLessThan(getTransactionSize(plain));

    const message = getCompiledTransactionMessageDecoder().decode(compressed.messageBytes);
    if (message.version !== 0) throw new Error('expected a v0 compiled message');
    expect(message.addressTableLookups).toHaveLength(1);

    // LiteSVM resolves the lookups from the fabricated table account and the
    // engine sees the exact same account list: the swap still lands.
    const result = expectOk(sendSigned(scenario.harness, compressed));
    expect(toBigInt(result.returnData)).toBe(quoted);
    expect(tokenAmount(scenario.harness, scenario.outAta)).toBe(OUT_ATA_START + quoted);
  });
});

// ── real venue-program CPI (env-gated: SAUCE_VENUE_PROGRAMS) ────────────────

// Points at a directory of `solana program dump`ed venue binaries (see
// sdk/src/recipes/solswap/README.md, "Running against real venue programs").
// Cleanly skipped unless both the engine and the dump are present.
const VENUE_PROGRAMS_DIR = process.env.SAUCE_VENUE_PROGRAMS;
const SABER_SO = VENUE_PROGRAMS_DIR ? join(VENUE_PROGRAMS_DIR, 'saber-stableswap.so') : undefined;
const describeRealCpi = existsSync(ENGINE_SO) && SABER_SO !== undefined && existsSync(SABER_SO) ? describe : describe.skip;

describeRealCpi('solswapBest e2e: real saber-stableswap binary CPI', () => {
  it('the realized on-chain output equals the in-VM quote and the facts pin', async () => {
    const amountIn = 1_000_000n;
    const slug = 'saber-stableswap';
    const fixtures = loadFixtures(fixturesDir(slug));
    const adapter = venueAdapter(slug);
    const cfg = await adapter.fetchPoolConfig(fixtureLoader(fixtures), VENUE_POOL[slug]);
    const reference = adapter.referenceQuote(cfg, fixtureBytesMap(fixtures), amountIn, CLOCK_STABLE);
    expect(reference).toBe(SABER_PIN);

    // A losing external keeps the pool count at 2 without ever being CPI'd.
    const output = await solswapBest({
      amountIn,
      minOut: 1n,
      pools: [livePool(slug), standIn(randomAddress(), 1n, 1n, 'loser')],
      user: USER,
      load: fixtureLoader(fixtures),
    });

    const harness = await startEngine(CLOCK_STABLE);
    loadFixtureAccounts(harness, fixtures);
    harness.svm.addProgramFromFile(adapter.programId, SABER_SO!);

    // Real SPL token accounts for the swap legs: source funded with the input
    // (saber pool A side = USDC, B side = USDT — the fixture pool's mints).
    // The admin-fee destination is CPI'd (third inner transfer) but never
    // quoted, so it is not in the fixture snapshot — fabricate it empty.
    const saberCfg = cfg as typeof cfg & { mintA: Address; mintB: Address; adminFeeB: Address };
    const inAta = setTokenAccount(harness, randomAddress(), saberCfg.mintA, harness.payer.address, 10n * amountIn);
    const outAta = setTokenAccount(harness, randomAddress(), saberCfg.mintB, harness.payer.address, OUT_ATA_START);
    setTokenAccount(harness, saberCfg.adminFeeB, saberCfg.mintB, randomAddress(), 0n);
    const resolution: AccountResolution = { [USER.outAta]: outAta, [USER.inAta]: inAta };

    const result = expectOk(await execute(harness, output, resolution));

    // The quadrilateral: facts pin == referenceQuote == in-VM quote ==
    // realized output of the REAL venue binary.
    expect(toBigInt(result.returnData)).toBe(SABER_PIN);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + SABER_PIN);
    expect(tokenAmount(harness, inAta)).toBe(10n * amountIn - amountIn);
  });
});
