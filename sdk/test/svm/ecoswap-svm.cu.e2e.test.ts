/**
 * EcoSwapSVM CU calibration on the REAL engine (LiteSVM): measures every
 * ladder family's per-shape compute cost and holds the budget.ts model to
 * it. This is where the budgeter's pinned coefficients COME FROM — run with
 * ECO_SVM_CU_PRINT=1 to print a freshly fitted coefficient table when
 * re-pinning (engine upgrades, fragment changes).
 *
 * Method (single-slot shapes over the venue fixture pools, SPL-transfer
 * stand-in CPIs paying the predicted output):
 * - rung_f  = (cu(f@4 rungs) − cu(f@2 rungs)) / 2
 * - BASE    = 2·cu(raydium-cp@4) − cu(raydium-cp ×2 @4)
 * - slot_f  = cu(f@2) − BASE − 2·rung_f
 *
 * Every cell ALSO asserts the lamport-exact gate (engine returndata ==
 * solver-reference over the same account bytes) — this suite is the first
 * on-engine exercise of the four Phase 1 fragments (raydium-amm-v4,
 * meteora-damm-v2, saber-stableswap, meteora-damm-v1-stable), including the
 * stable warm-start ladder chains and the GasLeft floor.
 *
 * The model tolerance is ±25%: loose enough for LiteSVM scheduling noise and
 * account-size effects, tight enough that an engine CU regression (or a
 * fragment pessimization) fails loudly HERE before it walls shapes
 * on-cluster.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address } from '@solana/kit';
import type { Address } from '@solana/kit';
import {
  fetchManifestConfig,
  fetchOrcaWhirlpoolConfig,
  manifestLadder,
  meteoraDammV1Stable,
  meteoraDammV1StableLadder,
  meteoraDammV2,
  meteoraDammV2Ladder,
  orcaLegacyTokenSwap,
  orcaLegacyTokenSwapLadder,
  orcaWhirlpoolLadder,
  pumpswapAdapter,
  pumpswapLadder,
  raydiumAmmV4,
  raydiumAmmV4Ladder,
  raydiumCpSwap,
  raydiumCpSwapLadder,
  saberStableswap,
  saberStableswapLadder,
} from '../../src/svm/index.js';
import type { AccountBytesMap, LadderSwapTemplate, PumpswapPoolConfig, SvmVenueLadderV2, PoolConfig } from '../../src/svm/index.js';
import {
  CU_BASE,
  CU_FAMILIES,
  encodeEcoSwapSvmTrade,
  estimateShapeCu,
  generateEcoSwapSvm,
  solveReference,
} from '../../src/recipes/ecoswap/svm/index.js';
import type { EcoSwapSvmOutput } from '../../src/recipes/ecoswap/svm/index.js';
import { describeSvm, loadFixtureAccounts, randomAddress, setTokenAccount, startEngine, tokenAmount } from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { loadFixtures } from './fixtures.js';
import { decodeEcoTrade, execEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
/** One clock satisfying every fixture gate (== the damm-v1-stable snapshot clock). */
const CLOCK = 1_783_175_236n;
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };
const OUT_ATA_START = 5_000_000n;

const VENUE_POOL: Record<string, Address> = {
  'raydium-cp-swap': address('7JuwJuNU88gurFnyWeiyGKbFmExMWcmRZntn9imEzdny'),
  'orca-whirlpool': address('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'),
  manifest: address('ENhU8LsaR7vDD2G1CsWcsuSGNrih9Cv5WZEk7q9kPapQ'),
  'raydium-amm-v4': address('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'),
  pumpswap: address('2uF4Xh61rDwxnG9woyxsVQP7zuA6kLFpb3NvnRQeoiSd'),
  'orca-legacy-token-swap': address('EGZ7tiLeH62TPV1gL8WwbXGzEPa9zmcpVnnkPKKnrE2U'),
  'meteora-damm-v2': address('8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie'),
  'saber-stableswap': address('YAkoNb6HKmSxQN9L8hiBE5tPJRsniSSMzND1boHmZxe'),
  'meteora-damm-v1-stable': address('32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG'),
};

interface FamilyCell {
  slug: keyof typeof VENUE_POOL;
  adapter: SvmVenueLadderV2;
  amountIn: bigint;
  fetch: () => Promise<PoolConfig>;
}

/** SPL-token transfer stand-in paying the slot's PREDICTED OUTPUT (patch: 'out'). */
const standIn = (slot: number): LadderSwapTemplate => ({
  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address,
  prefix: Uint8Array.of(3),
  suffix: new Uint8Array(0),
  patch: 'out',
  accounts: [
    { ref: `sv${slot}`, writable: true },
    { ref: USER.outAta, writable: true },
    { ref: USER.owner, signer: true },
  ],
});

describeSvm('ecoswap-svm CU calibration: per-family coefficients on the real engine', () => {
  let harness: EngineHarness;
  let liveLoader: (addr: Address) => Promise<Uint8Array | null>;
  const measured = new Map<string, { cu2: bigint; cu4: bigint }>();
  let cuRayCpPair = 0n;
  let bufferIndex = 0;
  let cells: FamilyCell[] = [];

  beforeAll(async () => {
    harness = await startEngine(CLOCK);
    for (const dir of Object.keys(VENUE_POOL)) {
      loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, dir)));
    }
    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };

    cells = [
      { slug: 'raydium-cp-swap', adapter: raydiumCpSwapLadder, amountIn: 400_000_000n, fetch: () => raydiumCpSwap.fetchPoolConfig(liveLoader, VENUE_POOL['raydium-cp-swap']) },
      { slug: 'raydium-amm-v4', adapter: raydiumAmmV4Ladder, amountIn: 1_000_000_000n, fetch: () => raydiumAmmV4.fetchPoolConfig(liveLoader, VENUE_POOL['raydium-amm-v4']) },
      {
        slug: 'pumpswap',
        adapter: pumpswapLadder,
        amountIn: 50_000_000_000n,
        fetch: async () => {
          const cfg = await pumpswapAdapter.fetchPoolConfig(liveLoader, VENUE_POOL.pumpswap);
          return { ...cfg, direction: 'baseToQuote' } as PumpswapPoolConfig;
        },
      },
      { slug: 'orca-legacy-token-swap', adapter: orcaLegacyTokenSwapLadder, amountIn: 1_000_000_000n, fetch: () => orcaLegacyTokenSwap.fetchPoolConfig(liveLoader, VENUE_POOL['orca-legacy-token-swap']) },
      // 100 SOL = one boundary crossing on the ts=4 fixture — the pinned
      // calibration point (CU rises with crossing depth; see budget.ts).
      { slug: 'orca-whirlpool', adapter: orcaWhirlpoolLadder, amountIn: 100_000_000_000n, fetch: () => fetchOrcaWhirlpoolConfig(liveLoader, VENUE_POOL['orca-whirlpool']) },
      // 5 SOL sells across several real bid levels of the SOL/USDC CLOB.
      { slug: 'manifest', adapter: manifestLadder, amountIn: 5_000_000_000n, fetch: () => fetchManifestConfig(liveLoader, VENUE_POOL.manifest) },
      { slug: 'meteora-damm-v2', adapter: meteoraDammV2Ladder, amountIn: 1_000_000_000n, fetch: () => meteoraDammV2.fetchPoolConfig(liveLoader, VENUE_POOL['meteora-damm-v2']) },
      { slug: 'saber-stableswap', adapter: saberStableswapLadder, amountIn: 1_000_000_000n, fetch: () => saberStableswap.fetchPoolConfig(liveLoader, VENUE_POOL['saber-stableswap']) },
      { slug: 'meteora-damm-v1-stable', adapter: meteoraDammV1StableLadder, amountIn: 1_000_000_000n, fetch: () => meteoraDammV1Stable.fetchPoolConfig(liveLoader, VENUE_POOL['meteora-damm-v1-stable']) },
    ];
  });

  /** Builds, stages and lands one N-slot stand-in trade; asserts the lamport-exact gate; returns CU. */
  const runShape = async (slots: { adapter: SvmVenueLadderV2; cfg: PoolConfig; rungs: number }[], amountIn: bigint): Promise<bigint> => {
    const output = generateEcoSwapSvm({
      slots: slots.map((slot, i) => ({ ...slot, swapOverride: standIn(i) })),
      user: USER,
      cuFloor: 1,
    });

    // Mirror over the SAME bank bytes.
    const inputs = await Promise.all(
      slots.map(async ({ adapter, cfg, rungs }) => {
        const state: AccountBytesMap = {};
        for (const account of adapter.quoteRefs(cfg, 0)) {
          if (account.address === undefined || state[account.address] !== undefined) continue;
          const data = await liveLoader(account.address);
          if (data === null) throw new Error(`missing quote account ${account.address}`);
          state[account.address] = data;
        }
        const params = adapter.paramsFor(cfg);
        return {
          quote: adapter.referenceQuote(cfg, state, params, CLOCK),
          ...(adapter.referenceLadderQuotes !== undefined
            ? { ladderQuotes: adapter.referenceLadderQuotes(cfg, state, params, CLOCK) }
            : {}),
          rungs,
          params,
        };
      }),
    );
    const expected = solveReference(inputs, amountIn);

    const mint = randomAddress();
    const outAta = setTokenAccount(harness, randomAddress(), mint, harness.payer.address, OUT_ATA_START);
    const resolution: Record<string, Address> = { [USER.outAta]: outAta };
    slots.forEach((_, i) => {
      resolution[`sv${i}`] = setTokenAccount(harness, randomAddress(), mint, harness.payer.address, 10n ** 15n);
    });

    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(harness, staged, output, resolution, [
      encodeEcoSwapSvmTrade(inputs.map(({ params }) => ({ params })), amountIn, expected.totalPredicted),
    ]);
    if (!result.ok) throw new Error(`trade failed: ${result.err}\n${result.logs.join('\n')}`);

    const words = decodeEcoTrade(result.returnData, slots.length);
    expect(words.slices).toEqual(expected.slices);
    expect(words.predictedOuts).toEqual(expected.predictedOuts);
    expect(words.realized).toBe(expected.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + expected.totalPredicted);
    return result.cu;
  };

  it('measures every family at 2 and 4 rungs, lamport-exact against the mirror', async () => {
    for (const cell of cells) {
      const cfg = await cell.fetch();
      const cu2 = await runShape([{ adapter: cell.adapter, cfg, rungs: 2 }], cell.amountIn);
      const cu4 = await runShape([{ adapter: cell.adapter, cfg, rungs: 4 }], cell.amountIn);
      measured.set(cell.slug, { cu2, cu4 });
      console.log(`${cell.slug}: ${cu2} CU @2 rungs, ${cu4} CU @4 rungs`);
    }
  }, 120_000);

  it('measures the 2-slot raydium-cp pair for the BASE coefficient', async () => {
    const cfg = await cells[0].fetch();
    cuRayCpPair = await runShape(
      [
        { adapter: raydiumCpSwapLadder, cfg, rungs: 4 },
        { adapter: raydiumCpSwapLadder, cfg, rungs: 4 },
      ],
      400_000_000n,
    );
    console.log(`raydium-cp-swap x2 @4 rungs: ${cuRayCpPair} CU`);
  }, 60_000);

  it('the pinned budget.ts model tracks the measurements within 25%', () => {
    const base = 2n * measured.get('raydium-cp-swap')!.cu4 - cuRayCpPair;
    if (process.env.ECO_SVM_CU_PRINT === '1') {
      console.log(`fitted BASE = ${base} (pinned ${CU_BASE})`);
      for (const [slug, { cu2, cu4 }] of measured) {
        const rung = (cu4 - cu2) / 2n;
        const slot = cu2 - base - 2n * rung;
        console.log(`  '${slug}': { kind: '${CU_FAMILIES[slug].kind}', slot: ${slot}, rung: ${rung} },`);
      }
    }
    for (const [slug, { cu2, cu4 }] of measured) {
      for (const [rungs, cu] of [
        [2, cu2],
        [4, cu4],
      ] as const) {
        const modeled = estimateShapeCu([{ slug, rungs }]);
        const drift = Math.abs(Number(cu) - modeled) / modeled;
        expect({ slug, rungs, cu: Number(cu), modeled, drift: Number(drift.toFixed(3)) }).toEqual(
          expect.objectContaining({ drift: expect.any(Number) }),
        );
        expect(drift).toBeLessThan(0.25);
      }
    }
    const pairModeled = estimateShapeCu([
      { slug: 'raydium-cp-swap', rungs: 4 },
      { slug: 'raydium-cp-swap', rungs: 4 },
    ]);
    expect(Math.abs(Number(cuRayCpPair) - pairModeled) / pairModeled).toBeLessThan(0.25);
  });
});
