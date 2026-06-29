/**
 * EcoSwap K-WAY-LAZY solver — LOCAL EVM validation, NO fork, NO mocks.
 *
 * Cooks the compiled K-way merge — now the CANONICAL solver (ecoswap.sauce.ts) — against locally-deployed
 * pools across the scenario matrix and asserts the realized per-pool tokenIn split +
 * total output EQUAL the NEUTRAL optimal oracle (ecoswap.optimal.ts optimalSplit),
 * built from the SAME live on-chain state — to the wei. Plus exact-spend (cum ==
 * amountIn whenever liquidity allows), conservation (Σ deltas == spent), and post-fee
 * marginal-price equalization at the cut. Parametrized over v12 AND v1.
 *
 * Why on-chain realized input == oracle split to the wei: the solver reads ALL live
 * state in SETUP (once), computes the full split, then executes EXACT-INPUT swaps of
 * exactly inp[pool] per pool. An exact-input swap consumes exactly its assigned input,
 * so the realized tokenIn delta == inp[pool] regardless of the pool's tick geometry.
 * And the solver computes inp from the same multiplicative-step walk the oracle uses,
 * so inp == optimalSplit.perPoolInput[i]. The synthetic pools use single WIDE positions
 * (constant active L through the whole trade region — no initialized tick crossed), so
 * the multiplicative walk has no exact-vs-stepReal seam and the match is exact.
 *
 * Scenarios (spec §VALIDATION): A no-drift window-covers, B window under-fills (dn),
 * C drift-up (up frontier), D no-bracket quote (dn from spot), E price-limit bind,
 * F cross-version V2+V3+V4 split, G early-out (exhaustion). The k-way reference
 * (ecoswap.kway.reference.ts) is proven == optimalSplit on the math tier, so this gate
 * is the on-chain confirmation.
 *
 * Run (v12): SAUCE_ENGINE_V12=1 npx tsx --test src/recipes/test/ecoswap.kway.evm.test.ts
 * Run (v1):  ECO_ENGINE=v1     npx tsx --test src/recipes/test/ecoswap.kway.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import { driftPoolPrice } from "./harness/drift";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  createAndInitPool,
  mint,
  approve,
  balanceOf,
  mintPosition,
  getLiquidity,
  getSlot0,
  deployV2Factory,
  setupEtchedV2Pool,
  etchV4Singletons,
  deployV4Helper,
  setupV4Pool,
  getV4Slot0,
  getV4Liquidity,
  getTickLiquidityNet,
  deployPancakeDeployer,
  createAndInitPancakePool,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import {
  MIN_SQRT_RATIO,
  SwapPoolType,
  FactoryType,
  type ChainPoolConfig,
} from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import {
  feeAdjust,
  toOutIn,
  Q96,
  FEE_DENOM,
  mulDiv,
  stepReal,
  getSqrtRatioAtTick,
  HALF128,
  MOD128,
} from "./ecoswap.math";
import type { EcoPool } from "../shared/types";

const HUGE = parseEther("1000000000");
// The K-way merge is now the canonical solver (ecoswap.sauce.ts) — this suite validates the
// promoted production solver against the optimal oracle, so it points at the canonical file
// (the default ecoSwap() solver). It used to point at a separate ecoswap.kway.sauce.ts draft.
const KWAY = "ecoswap.sauce.ts";
const ENGINE_CELLS = engineCells();

// A far-future block timestamp every cook is pinned to (the V3 oracle accumulator is
// timestamp-dependent → drifts across evm_revert; pinning makes cells deterministic).
const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

/** Read a V3 pool's live state as an OptimalPool (single wide position ⇒ empty net). */
async function v3Optimal(
  c: HarnessClients,
  pool: Hex,
  feePpm: number,
  tickSpacing: number,
): Promise<OptimalPool> {
  const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, pool);
  const liquidity = await getLiquidity(c.publicClient, pool);
  return { isV2: false, feePpm, sqrtPriceX96, tick, tickSpacing, liquidity, net: new Map() };
}

/** Read a V4 pool's live state as an OptimalPool (single wide position ⇒ empty net). */
async function v4Optimal(
  c: HarnessClients,
  stateView: Hex,
  poolId: Hex,
  feePpm: number,
  tickSpacing: number,
): Promise<OptimalPool> {
  const { sqrtPriceX96, tick } = await getV4Slot0(c.publicClient, stateView, poolId);
  const liquidity = await getV4Liquidity(c.publicClient, stateView, poolId);
  return { isV2: false, feePpm, sqrtPriceX96, tick, tickSpacing, liquidity, net: new Map() };
}

/** Read a V2 pair's live reserves as an OptimalPool (engine fee pinned 0.3%). */
async function v2Optimal(
  c: HarnessClients,
  pair: Hex,
  tokenIn: Hex,
  inIsToken0: boolean,
): Promise<OptimalPool> {
  // reserve0/reserve1 in token0/token1 orientation.
  const r = (await c.publicClient.readContract({
    address: pair,
    abi: [
      {
        type: "function",
        name: "getReserves",
        stateMutability: "view",
        inputs: [],
        outputs: [
          { name: "reserve0", type: "uint112" },
          { name: "reserve1", type: "uint112" },
          { name: "blockTimestampLast", type: "uint32" },
        ],
      },
    ],
    functionName: "getReserves",
  })) as readonly [bigint, bigint, number];
  const reserveIn = inIsToken0 ? r[0] : r[1];
  const reserveOut = inIsToken0 ? r[1] : r[0];
  return { isV2: true, feePpm: 3000, reserveIn, reserveOut };
}

/**
 * Assert the on-chain per-pool tokenIn deltas + total EQUAL the optimal oracle split
 * to the wei (the EXACTNESS gate). `deltas[i]` aligns with `prepared.pools[i]`;
 * `optPools` aligns with prepared.pools by the same index.
 */
function assertExactSplit(
  deltas: bigint[],
  opt: { perPoolInput: bigint[]; totalInput: bigint },
  spent: bigint,
  label: string,
): void {
  const sumDeltas = deltas.reduce((a, b) => a + b, 0n);
  // conservation: per-venue tokenIn deltas sum to the input the caller spent.
  assert.equal(sumDeltas, spent, `${label}: Σ per-pool deltas == spent`);
  // exact-spend / total: realized total == oracle total to the wei.
  assert.equal(spent, opt.totalInput, `${label}: spent == oracle totalInput (wei-exact)`);
  // per-pool split to the wei.
  for (let i = 0; i < deltas.length; i++) {
    assert.equal(
      deltas[i],
      opt.perPoolInput[i],
      `${label}: pool[${i}] tokenIn ${deltas[i]} != oracle ${opt.perPoolInput[i]}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// A / B / E / G — multi V3 pools (no-drift, under-fill, limit, early-out)
// ─────────────────────────────────────────────────────────────
describe("EcoSwap K-way — V3 scenarios (no-drift, dn under-fill, price-limit, early-out)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let poolConfig: ChainPoolConfig;
  const poolsByFee = new Map<number, { pool: Hex; ts: number }>();
  let cleanSnapshot: Hex;

  // Pool specs: fee → [tickSpacing, active L]. Single WIDE position each (±60000) so the
  // walk region is constant-L (no initialized tick crossed inside the trade) → wei-exact.
  const SPECS: [number, number, bigint][] = [
    [500, 10, parseEther("4000000")],
    [3000, 60, parseEther("2500000")],
    [10000, 200, parseEther("1500000")],
  ];

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("500000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("500000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    for (const [fee, ts, L] of SPECS) {
      const pool = await createAndInitPool(
        c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, fee, SQRT_PRICE_1_1,
      );
      await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, -60000, 60000, L);
      poolsByFee.set(fee, { pool, ts });
    }

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [500, 3000, 10000],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  async function feeAdjMarginal(pool: Hex, feePpm: number): Promise<bigint> {
    const { sqrtPriceX96 } = await getSlot0(c.publicClient, pool);
    return feeAdjust(toOutIn(sqrtPriceX96, true), feePpm);
  }

  // Map prepared.pools[i] → its on-chain pool address (by feePpm; SPECS fees are distinct).
  function poolAddrFor(p: EcoPool): Hex {
    return poolsByFee.get(p.feePpm)!.pool;
  }

  /** Build the optimal oracle pools aligned to prepared.pools order, from live state. */
  async function buildOpt(pools: EcoPool[]): Promise<OptimalPool[]> {
    const out: OptimalPool[] = [];
    for (const p of pools) {
      const { ts } = poolsByFee.get(p.feePpm)!;
      out.push(await v3Optimal(c, poolAddrFor(p), p.feePpm, ts));
    }
    return out;
  }

  /** Run one cook + exact-split assertion. Returns prepared for further checks. */
  async function runAndAssert(
    engine: Engine,
    amountIn: bigint,
    opts: { maxTicks?: number } | undefined,
    label: string,
    expectFullFill: boolean,
  ) {
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      { ...(opts ?? {}), solverFile: KWAY },
      engine,
    );

    // Oracle from live state captured BEFORE the cook (same state SETUP reads).
    const optPools = await buildOpt(prepared.pools);
    const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: prepared.priceLimit });

    const inBefore = new Map<number, bigint>();
    for (const p of prepared.pools) inBefore.set(p.feePpm, await balanceOf(c.publicClient, tokenIn, poolAddrFor(p)));
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", `${label}: cook() must succeed`);

    const deltas: bigint[] = [];
    for (const p of prepared.pools) {
      const after = await balanceOf(c.publicClient, tokenIn, poolAddrFor(p));
      deltas.push(after - inBefore.get(p.feePpm)!);
    }
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.ok(received > 0n, `${label}: received tokenOut`);

    assertExactSplit(deltas, opt, spent, label);
    if (expectFullFill) assert.equal(spent, amountIn, `${label}: spends amountIn exactly`);

    return { prepared, deltas, opt, spent, received };
  }

  // ── A: no-drift, window covers amountIn (degeneracy) ──
  // 50000 against the deep 3-pool set engages all three (fee spread 500/3000/10000),
  // window comfortably covers, no drift → up inactive, dn never reached. Wei-exact.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`A [${engine}] no-drift, window covers amountIn — wei-exact split across 3 pools == oracle`, { skip }, async () => {
      await resetPools();
      const { prepared, deltas } = await runAndAssert(engine, parseEther("50000"), undefined, `A:${engine}`, true);
      const moved = deltas.filter((d) => d > 0n).length;
      assert.ok(moved >= 2, `A:${engine}: must split across ≥2 pools (moved ${moved})`);
      // Marginal equalization across engaged pools.
      const adj: bigint[] = [];
      for (let i = 0; i < prepared.pools.length; i++) {
        if (deltas[i] > 0n) adj.push(await feeAdjMarginal(poolAddrFor(prepared.pools[i]), prepared.pools[i].feePpm));
      }
      const maxA = adj.reduce((a, b) => (a > b ? a : b));
      const minA = adj.reduce((a, b) => (a < b ? a : b));
      const spread = Number(maxA - minA) / Number(maxA);
      assert.ok(spread < 0.02, `A:${engine}: marginals cluster (spread ${spread})`);
    });
  }

  // ── B: window under-fills → dn walk closes the gap ──
  // maxTicks:2 caps the lens to 2 boundaries/pool ⇒ Σ prepared cap ≈ 49.7k < 80k amountIn
  // ⇒ the dn frontier must close the ~30k gap. Deep constant-L pools ⇒ the dn walk needs
  // only a handful of extra ticks (well within SAFETY) and the geometry is wei-exact.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`B [${engine}] narrow window under-fills → dn frontier fills to amountIn, wei-exact`, { skip }, async () => {
      await resetPools();
      const { prepared, deltas } = await runAndAssert(engine, parseEther("80000"), { maxTicks: 2 }, `B:${engine}`, true);
      const preparedCap = prepared.brackets.reduce((s, b) => s + b.capacity, 0n);
      assert.ok(preparedCap < parseEther("80000"), `B:${engine}: prepared window must under-fill (Σcap ${preparedCap})`);
      const moved = deltas.filter((d) => d > 0n).length;
      assert.ok(moved >= 2, `B:${engine}: split across ≥2 pools`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// E/G — finite-liquidity exhaustion (run-until-exhausted; refund; bounded gas)
// ─────────────────────────────────────────────────────────────
// A single NARROW position so active L drops to 0 after a bounded tick walk: amountIn
// far exceeds the pool's reachable liquidity, so the solver runs the dn frontier until L
// exhausts (the dL===0 early-out fires — the same point the oracle breaks at the extreme
// initialized tick), spends == oracle total < amountIn (wei-exact), the terminal refund
// returns the unspent input, and the cook terminates with bounded gas (no SAFETY-spin /
// OOG). maxTicks:0 ⇒ EMPTY prepared cache ⇒ the dn frontier walks live ticks from spot,
// so the oracle (net map = the known mint boundaries) and the solver walk the identical
// tick grid. This is the spec's price-limit/exhaustion + early-out gate (§E + §G).
describe("EcoSwap K-way — finite-liquidity exhaustion (early-out, refund, bounded gas)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let pool: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  // Narrow [-500, 500] position, fee 500, ts 10, L=100k. Walking down (zeroForOne) crosses
  // the lower boundary -500, where net = +L → L drops to 0. So the pool exhausts at tick
  // -500 (~50 dn steps from spot, well within SAFETY).
  const TS = 10;
  const FEE = 500;
  const L = parseEther("100000");
  const LO = -500;
  const HI = 500;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("500000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("500000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, FEE, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, LO, HI, L);

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [FEE],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`E/G [${engine}] over-cap trade exhausts the pool — spent == oracle total < amountIn, refund, bounded gas`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      const amountIn = parseEther("100000000"); // far beyond the narrow pool's reachable liquidity

      // maxTicks:0 ⇒ empty prepared cache ⇒ dn walks live ticks from spot. The solver reads
      // ticks() live (sees the -500 boundary); the oracle's net map is the known mint.
      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        // minRelBps:0 keeps the pool when maxTicks:0 measures 0 windowed capacity.
        { maxTicks: 0, minRelBps: 0, solverFile: KWAY }, engine,
      );
      assert.equal(prepared.brackets.length, 0, `EG:${engine}: empty cache (maxTicks:0)`);

      // Oracle from TRUE live state + the known initialized-tick net map.
      const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, pool);
      const liquidity = await getLiquidity(c.publicClient, pool);
      const net = new Map<number, bigint>([[LO, L], [HI, -L]]);
      const opt = optimalSplit({
        pools: [{ isV2: false, feePpm: FEE, sqrtPriceX96, tick, tickSpacing: TS, liquidity, net }],
        amountIn, zeroForOne: true, priceLimit: prepared.priceLimit,
      });
      assert.ok(opt.totalInput > 0n && opt.totalInput < amountIn, `EG:${engine}: oracle exhausts below amountIn (${opt.totalInput})`);

      const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);
      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt, transfers } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `EG:${engine}: cook() terminates (no SAFETY-spin / OOG)`);

      // compute-then-pull: the solver transferFroms EXACTLY its computed cum (the
      // run-until-exhausted total) caller→target. That cum is the EXACTNESS gate: it must
      // equal the oracle's exhaustion total to the wei. (The realized pool delta can differ
      // from cum by the multiplicative-vs-exact tick geometry at the exhaustion boundary —
      // the real pool under-delivers vs the multiplicative cum and the surplus is refunded
      // by the terminal refund — so the wei gate is on the COMPUTED cum, not the delta.)
      const pull = transfers.find(
        (t) => t.address.toLowerCase() === tokenIn.toLowerCase() &&
          t.from.toLowerCase() === caller.toLowerCase() && t.to.toLowerCase() === target.toLowerCase(),
      );
      assert.ok(pull, `EG:${engine}: expected a transferFrom(caller→target) for the pulled cum`);
      const cum = pull!.value;
      assert.equal(cum, opt.totalInput, `EG:${engine}: computed cum == oracle exhaustion total (wei-exact)`);

      const poolInDelta = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;
      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      assert.ok(spent < amountIn, `EG:${engine}: under-fills (pool exhausted), terminal refund returns the rest`);
      assert.ok(spent <= cum, `EG:${engine}: spent ≤ cum (refund returns any unexecutable surplus)`);
      assert.ok(poolInDelta > 0n, `EG:${engine}: the exhausted pool still received its reachable liquidity`);
      // Gas bounded — the early-out kept it well under the block ceiling.
      assert.ok(receipt.gasUsed < 1_500_000_000n, `EG:${engine}: gas bounded (${receipt.gasUsed})`);

      console.log(`  [EG:${engine}] exhaustion: cum=${cum} (oracle ${opt.totalInput}) spent=${spent} delta=${poolInDelta} of ${amountIn}, gas=${receipt.gasUsed}`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// B2 — CAP-BINDING run-until-filled: reach pinned at the PER_POOL budget on BOTH
// ─────────────────────────────────────────────────────────────
//
// A single shallow/wide-L V3 pool (ts=10, fee=500, EMPTY cache) sized so the dn walk's
// reach exceeds the PER_POOL=2048 step budget. The solver's run-until-filled merge HITS the
// budget and truncates; the optimal oracle's MAX_V3_STEPS (== PER_POOL) truncates IDENTICALLY,
// so the on-chain realized split == the oracle to the wei EVEN WHEN THE CAP BINDS. The reach
// is trade-size-INDEPENDENT (the fixed-cap signature) yet exactly the oracle's capped reach.
// The single-pool walk to the cap costs ≈1.15e9 gas on anvil (measured) — under the 1.9e9
// ceiling — so the cook succeeds. (maxTicks:0 ⇒ empty cache ⇒ the dn frontier walks live
// ticks from spot; the oracle's empty net map ⇒ both walk the identical wide-L lattice.)
describe("EcoSwap K-way — B2 cap-binding (reach == PER_POOL budget, solver == oracle)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let pool: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  // Shallow flat-L wide pool: L=1000e18 over [-800000,800000]. A trade far larger than what
  // 2048 ts=10 steps (≈1785e18) can absorb makes the cap bind. Wide range ⇒ constant L ⇒ the
  // oracle's empty net map walks the identical lattice ⇒ wei-exact at the cap.
  const TS = 10;
  const FEE = 500;
  const L = parseEther("1000");

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("500000000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("500000000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, FEE, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, -800000, 800000, L);

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [FEE],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`B2 [${engine}] over-budget trade caps at PER_POOL — computed cum == oracle capped reach, wei-exact, bounded gas`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      // 1,000,000e18 — far more than 2048 ts=10 steps can absorb on L=1000e18 (≈1785e18),
      // so the per-pool budget binds and the reach is pinned at the budget, not the trade.
      const amountIn = parseEther("1000000");

      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        { maxTicks: 0, minRelBps: 0, solverFile: KWAY }, engine,
      );
      assert.equal(prepared.brackets.length, 0, `B2:${engine}: empty cache (maxTicks:0)`);

      // Oracle from TRUE live state, empty net (single wide position). Its MAX_V3_STEPS ==
      // the solver PER_POOL, so it caps at the SAME reach.
      const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, pool);
      const liquidity = await getLiquidity(c.publicClient, pool);
      const opt = optimalSplit({
        pools: [{ isV2: false, feePpm: FEE, sqrtPriceX96, tick, tickSpacing: TS, liquidity, net: new Map() }],
        amountIn, zeroForOne: true, priceLimit: prepared.priceLimit,
      });
      // The cap binds: the oracle's capped reach is well below the trade size.
      assert.ok(opt.totalInput > 0n && opt.totalInput < amountIn, `B2:${engine}: oracle caps below amountIn (${opt.totalInput})`);

      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt, transfers } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `B2:${engine}: cook() terminates (no SAFETY-spin / OOG)`);

      // EXACTNESS AT THE CAP: the computed cum (transferFrom caller→target) == the oracle's
      // capped reach to the wei (both truncated at PER_POOL == MAX_V3_STEPS).
      const pull = transfers.find(
        (t) => t.address.toLowerCase() === tokenIn.toLowerCase() &&
          t.from.toLowerCase() === caller.toLowerCase() && t.to.toLowerCase() === target.toLowerCase(),
      );
      assert.ok(pull, `B2:${engine}: expected a transferFrom(caller→target) for the capped cum`);
      assert.equal(pull!.value, opt.totalInput, `B2:${engine}: capped cum == oracle capped reach (wei-exact)`);

      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      assert.ok(spent < amountIn, `B2:${engine}: under-fills (cap binds), terminal refund returns the rest`);
      assert.ok(receipt.gasUsed < 1_900_000_000n, `B2:${engine}: gas bounded under the ceiling (${receipt.gasUsed})`);

      console.log(`  [B2:${engine}] cap-binding: cum=${pull!.value} (oracle ${opt.totalInput}) of ${amountIn}, gas=${receipt.gasUsed}`);
    });
  }

  // ── D2 — CAP-BINDING with a NON-EMPTY cache ──
  // The empty-cache cell above hid the D2 defect: with no prepared brackets the dn frontier
  // alone walked the reach (bounded by PER_POOL), so it matched the oracle. With a NON-EMPTY
  // cache (default maxTicks ⇒ up to 96 window brackets) the prepared window brackets were
  // consumed via the merge cursor WITHOUT counting against the per-pool budget, and the dn
  // frontier resumed from the post-window seed and walked a FULL PER_POOL more steps — so the
  // pool reached (K window brackets) + (PER_POOL dn steps) = DEEPER than the oracle's single
  // from-spot loop (MAX_V3_STEPS == PER_POOL) → over-fill at the cap. The D2 fix counts a
  // consumed window bracket against the SAME per-pool budget as dn, so window + dn together
  // are bounded by PER_POOL == the oracle MAX_V3_STEPS — the computed cum == the oracle's
  // capped reach to the wei EVEN WITH a non-empty cache. (minRelBps:0 keeps the shallow pool.)
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`D2 [${engine}] over-budget trade caps at PER_POOL WITH a non-empty cache — computed cum == oracle capped reach, wei-exact`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      const amountIn = parseEther("1000000");

      // Default maxTicks (96) ⇒ a NON-EMPTY prepared cache for the shallow wide pool.
      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        { minRelBps: 0, solverFile: KWAY }, engine,
      );
      assert.ok(prepared.brackets.length > 0, `D2:${engine}: NON-EMPTY cache (default maxTicks, got ${prepared.brackets.length})`);
      const preparedCap = prepared.brackets.reduce((s, b) => s + b.capacity, 0n);
      assert.ok(preparedCap < amountIn, `D2:${engine}: cache under-fills the over-budget trade (Σcap ${preparedCap})`);

      // Oracle from TRUE live state, empty net (single wide position). Its MAX_V3_STEPS ==
      // the solver PER_POOL: window + dn together must cap at the SAME reach as this oracle.
      const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, pool);
      const liquidity = await getLiquidity(c.publicClient, pool);
      const opt = optimalSplit({
        pools: [{ isV2: false, feePpm: FEE, sqrtPriceX96, tick, tickSpacing: TS, liquidity, net: new Map() }],
        amountIn, zeroForOne: true, priceLimit: prepared.priceLimit,
      });
      assert.ok(opt.totalInput > 0n && opt.totalInput < amountIn, `D2:${engine}: oracle caps below amountIn (${opt.totalInput})`);

      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt, transfers } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `D2:${engine}: cook() terminates (no SAFETY-spin / OOG)`);

      // EXACTNESS AT THE CAP WITH A CACHE: window + dn share ONE budget, so the computed cum
      // == the oracle's capped reach to the wei (NOT deeper than the empty-cache reach).
      const pull = transfers.find(
        (t) => t.address.toLowerCase() === tokenIn.toLowerCase() &&
          t.from.toLowerCase() === caller.toLowerCase() && t.to.toLowerCase() === target.toLowerCase(),
      );
      assert.ok(pull, `D2:${engine}: expected a transferFrom(caller→target) for the capped cum`);
      assert.equal(pull!.value, opt.totalInput, `D2:${engine}: capped cum == oracle capped reach with a cache (wei-exact)`);

      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      assert.ok(spent < amountIn, `D2:${engine}: under-fills (cap binds), terminal refund returns the rest`);
      assert.ok(receipt.gasUsed < 1_900_000_000n, `D2:${engine}: gas bounded under the ceiling (${receipt.gasUsed})`);

      console.log(`  [D2:${engine}] cap-binding w/ cache (${prepared.brackets.length} brackets): cum=${pull!.value} (oracle ${opt.totalInput}) of ${amountIn}, gas=${receipt.gasUsed}`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// C — drift-UP (against-swap drift) → up frontier
// ─────────────────────────────────────────────────────────────
describe("EcoSwap K-way — drift-UP (drift-UP re-anchor)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let poolConfig: ChainPoolConfig;
  const poolsByFee = new Map<number, { pool: Hex; ts: number }>();
  let cleanSnapshot: Hex;

  const SPECS: [number, number, bigint][] = [
    [500, 10, parseEther("4000000")],
    [3000, 60, parseEther("2500000")],
  ];

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("500000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("500000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    for (const [fee, ts, L] of SPECS) {
      const pool = await createAndInitPool(
        c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, fee, SQRT_PRICE_1_1,
      );
      await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, -60000, 60000, L);
      poolsByFee.set(fee, { pool, ts });
    }

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [500, 3000],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  function poolAddrFor(p: EcoPool): Hex {
    return poolsByFee.get(p.feePpm)!.pool;
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`C [${engine}] one pool drifts UP after prepare → drift-UP re-anchor fills (spot,top], wei-exact == oracle`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      const amountIn = parseEther("6000");

      // PREPARE against the pre-drift snapshot (live == prepared spot at this point).
      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        { solverFile: KWAY }, engine,
      );

      // DRIFT the 3000 pool UP (oneForZero pre-swap pushes its price ABOVE prepare-time spot).
      // driftPoolPrice swaps tokenIn→tokenOut (price DOWN) — to push UP we swap tokenOut→tokenIn.
      const driftPoolEco = prepared.pools.find((p) => p.feePpm === 3000)!;
      const driftAddr = poolAddrFor(driftPoolEco);
      const before = await getSlot0(c.publicClient, driftAddr);
      // Push price UP: swap tokenOut in (oneForZero on this pool). Mint+approve handled by drift.
      await driftPoolPrice(
        c, stack.sauceRouter,
        // swap the OTHER direction through this pool: tokenIn=tokenOut, tokenOut=tokenIn, zeroForOne=false
        { ...driftPoolEco, inIsToken0: false },
        tokenOut, tokenIn, false, parseEther("30000"), caller,
      );
      const afterDrift = await getSlot0(c.publicClient, driftAddr);
      assert.ok(afterDrift.sqrtPriceX96 > before.sqrtPriceX96, "C: drift pushed the 3000 pool price UP");

      // Oracle from the TRUE post-drift live state.
      const optPools: OptimalPool[] = [];
      for (const p of prepared.pools) {
        const { ts } = poolsByFee.get(p.feePpm)!;
        optPools.push(await v3Optimal(c, poolAddrFor(p), p.feePpm, ts));
      }
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: prepared.priceLimit });

      const inBefore = new Map<number, bigint>();
      for (const p of prepared.pools) inBefore.set(p.feePpm, await balanceOf(c.publicClient, tokenIn, poolAddrFor(p)));
      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `C:${engine}: drifted cook() must succeed`);

      const deltas: bigint[] = [];
      for (const p of prepared.pools) deltas.push((await balanceOf(c.publicClient, tokenIn, poolAddrFor(p))) - inBefore.get(p.feePpm)!);
      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      assertExactSplit(deltas, opt, spent, `C:${engine}`);
      assert.equal(spent, amountIn, `C:${engine}: spends amountIn exactly`);
      // The drifted (higher-priced) pool gets at least as much as it would at spot — it
      // offers a better rate, so the up frontier funds (spot,top] first.
      const driftIdx = prepared.pools.findIndex((p) => p.feePpm === 3000);
      assert.ok(deltas[driftIdx] > 0n, `C:${engine}: drifted pool funded via up frontier`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// D — no-bracket QUOTE path (brackets=[], dn from spot)
// ─────────────────────────────────────────────────────────────
describe("EcoSwap K-way — no-bracket quote path (empty cache, dn from spot)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let poolConfig: ChainPoolConfig;
  const poolsByFee = new Map<number, { pool: Hex; ts: number }>();
  let cleanSnapshot: Hex;

  const SPECS: [number, number, bigint][] = [
    [500, 10, parseEther("4000000")],
    [3000, 60, parseEther("2500000")],
  ];

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("500000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("500000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    for (const [fee, ts, L] of SPECS) {
      const pool = await createAndInitPool(
        c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, fee, SQRT_PRICE_1_1,
      );
      await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, -60000, 60000, L);
      poolsByFee.set(fee, { pool, ts });
    }

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [500, 3000],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  function poolAddrFor(p: EcoPool): Hex {
    return poolsByFee.get(p.feePpm)!.pool;
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`D [${engine}] maxTicks:0 (empty prepared cache) → dn-from-spot full live walk == oracle, wei-exact`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      // Large enough that the cheaper pool's marginal falls to the pricier pool's spot
      // adjusted price ⇒ the live walk splits across BOTH from spot with no cache.
      const amountIn = parseEther("50000");

      // maxTicks:0 → the lens scans no forward boundaries → bracketCount=0 → no prepared
      // brackets, dn seeded AT SPOT. minRelBps:0 keeps the pools (0 windowed capacity at
      // maxTicks:0). This is the "prepare is a cache, not a dependency" gate: the solver
      // must be optimal from live data alone with an EMPTY cache.
      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        { maxTicks: 0, minRelBps: 0, solverFile: KWAY }, engine,
      );
      assert.equal(prepared.brackets.length, 0, `D:${engine}: prepared cache must be EMPTY (maxTicks:0)`);

      const optPools: OptimalPool[] = [];
      for (const p of prepared.pools) {
        const { ts } = poolsByFee.get(p.feePpm)!;
        optPools.push(await v3Optimal(c, poolAddrFor(p), p.feePpm, ts));
      }
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: prepared.priceLimit });

      const inBefore = new Map<number, bigint>();
      for (const p of prepared.pools) inBefore.set(p.feePpm, await balanceOf(c.publicClient, tokenIn, poolAddrFor(p)));
      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `D:${engine}: no-bracket cook() must succeed`);

      const deltas: bigint[] = [];
      for (const p of prepared.pools) deltas.push((await balanceOf(c.publicClient, tokenIn, poolAddrFor(p))) - inBefore.get(p.feePpm)!);
      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      assertExactSplit(deltas, opt, spent, `D:${engine}`);
      assert.equal(spent, amountIn, `D:${engine}: spends amountIn exactly from live data alone`);
      assert.ok(deltas.filter((d) => d > 0n).length >= 2, `D:${engine}: split across ≥2 pools with no cache`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// F — cross-version split (V2 + V3 + V4) with marginal equalization
// ─────────────────────────────────────────────────────────────
describe("EcoSwap K-way — cross-version split (V2 + V3 + V4)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let v3Pool: Hex;
  let v2Pair: Hex;
  let poolManager: Hex;
  let stateView: Hex;
  let v4PoolId: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  const V2_PAIR_ADDR = "0x00000000000000000000000000000000ec05a2a2" as Hex;
  const V3_FEE = 500;
  const V3_TS = 10;
  const V4_FEE = 3000;
  const V4_TS = 60;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const v2Factory = await deployV2Factory(c.walletClient, c.publicClient);
    const v4 = await etchV4Singletons(c.publicClient, c.testClient);
    poolManager = v4.poolManager;
    stateView = v4.stateView;
    const v4Helper = await deployV4Helper(c.walletClient, c.publicClient, poolManager);

    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("500000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("500000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // V3 (fee 500) deep wide position.
    v3Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3Pool, minter, -60000, 60000, parseEther("3000000"));

    // V4 (fee 3000) deep wide position.
    v4PoolId = await setupV4Pool(
      c.walletClient, c.publicClient, v4Helper, tokenIn, tokenOut,
      V4_FEE, V4_TS, SQRT_PRICE_1_1, -60000, 60000, parseEther("3000000"), parseEther("100000000"),
    );

    // V2 etched pair, deep (equal reserves) — engine fee 0.3%.
    v2Pair = await setupEtchedV2Pool(
      c.walletClient, c.publicClient, c.testClient, v2Factory, V2_PAIR_ADDR,
      tokenIn, tokenOut, parseEther("3000000"), parseEther("3000000"), minter,
    );

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "V3" },
        { address: v2Factory, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "V2" },
        { address: poolManager, stateView, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "V4" },
      ],
      feeTiers: [500, 3000],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  // On-chain venue address for a prepared pool (V2 pair / V4 PoolManager / V3 pool).
  function venueFor(p: EcoPool): Hex {
    if (p.isV2) return v2Pair;
    if (p.poolType === SwapPoolType.UniV4) return poolManager;
    return v3Pool;
  }

  async function optFor(p: EcoPool): Promise<OptimalPool> {
    if (p.isV2) return v2Optimal(c, v2Pair, tokenIn, p.inIsToken0);
    if (p.poolType === SwapPoolType.UniV4) return v4Optimal(c, stateView, v4PoolId, p.feePpm, V4_TS);
    return v3Optimal(c, v3Pool, p.feePpm, V3_TS);
  }

  /** Post-fee fee-adjusted out/in marginal for a prepared pool, from its live price. */
  async function marginalFor(p: EcoPool): Promise<bigint> {
    if (p.isV2) {
      const op = await v2Optimal(c, v2Pair, tokenIn, p.inIsToken0);
      // V2 out/in spot = sqrt(reserveOut*Q192/reserveIn).
      const Q192 = 1n << 192n;
      const sqrtOI = bigintSqrt((op.reserveOut! * Q192) / op.reserveIn!);
      return feeAdjust(sqrtOI, 3000);
    }
    if (p.poolType === SwapPoolType.UniV4) {
      const { sqrtPriceX96 } = await getV4Slot0(c.publicClient, stateView, v4PoolId);
      return feeAdjust(toOutIn(sqrtPriceX96, true), p.feePpm);
    }
    const { sqrtPriceX96 } = await getSlot0(c.publicClient, v3Pool);
    return feeAdjust(toOutIn(sqrtPriceX96, true), p.feePpm);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`F [${engine}] splits across V2 + V3 + V4 — wei-exact per-pool == oracle, marginals equalize`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      // Large enough that the cheaper V3 0.05% pool's marginal falls to the V2/V4 0.30%
      // spot adjusted price ⇒ ALL THREE versions engage at the equalized cut.
      const amountIn = parseEther("20000");

      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        { solverFile: KWAY }, engine,
      );
      assert.equal(prepared.pools.filter((p) => p.isV2).length, 1, `F:${engine}: 1 V2`);
      assert.equal(prepared.pools.filter((p) => p.poolType === SwapPoolType.UniV3).length, 1, `F:${engine}: 1 V3`);
      assert.equal(prepared.pools.filter((p) => p.poolType === SwapPoolType.UniV4).length, 1, `F:${engine}: 1 V4`);

      const optPools: OptimalPool[] = [];
      for (const p of prepared.pools) optPools.push(await optFor(p));
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: prepared.priceLimit });

      const inBefore: bigint[] = [];
      for (const p of prepared.pools) inBefore.push(await balanceOf(c.publicClient, tokenIn, venueFor(p)));
      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
      const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `F:${engine}: cross-version cook() must succeed`);

      const deltas: bigint[] = [];
      for (let i = 0; i < prepared.pools.length; i++) {
        deltas.push((await balanceOf(c.publicClient, tokenIn, venueFor(prepared.pools[i]))) - inBefore[i]);
      }
      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
      assert.ok(received > 0n, `F:${engine}: received tokenOut`);

      assertExactSplit(deltas, opt, spent, `F:${engine}`);
      assert.equal(spent, amountIn, `F:${engine}: spends amountIn exactly`);
      assert.ok(deltas.filter((d) => d > 0n).length === 3, `F:${engine}: ALL three versions funded`);

      // Marginal equalization across the three versions (post-fee fee-adjusted out/in).
      const marg: bigint[] = [];
      for (const p of prepared.pools) marg.push(await marginalFor(p));
      const maxM = marg.reduce((a, b) => (a > b ? a : b));
      const minM = marg.reduce((a, b) => (a < b ? a : b));
      const spread = Number(maxM - minM) / Number(maxM);
      // V2's coarse ~0.5% slice grid is the loosest; allow 1% on the fee-adj sqrt price.
      assert.ok(spread < 0.01, `F:${engine}: cross-version marginals equalize (spread ${spread})`);

      console.log(
        `  [F:${engine}] V2/V3/V4 split: ${prepared.pools.map((p, i) => `${p.isV2 ? "V2" : p.poolType === SwapPoolType.UniV4 ? "V4" : "V3"}=${deltas[i]}`).join(" ")} spent=${spent} spread=${spread}`,
      );
    });
  }

  // ── V2 DRIFT-DOWN re-anchor (the second remaining blocker) ──
  // PREPARE at spot, then drift the V2 pair's price DOWN with a REAL zeroForOne swap (its
  // out/in spot moves BELOW the prepared window top). Before the fix the V2 dn frontier kept
  // the prepare-time deepestFar seed and over-funded the drifted V2 by up to ~38%; the fix
  // re-anchors the V2 dn frontier to the LIVE spot and stale-skips its prepared brackets above
  // it. The realized per-pool split + total must equal the POST-drift optimal oracle to the wei.
  //
  // Two cells per engine close the whole drift-down quadrant for the just-fixed blocker:
  //   MODERATE — V2's drifted spot stays ABOVE the equalized cut, so V2 is STILL FUNDED (a
  //     reduced, nonzero share). This is the load-bearing case: it exercises the re-anchored
  //     V2 dn-frontier ACTUALLY CONSUMING input at the live spot (the path that used to
  //     over-fund). Its share must shrink vs the no-drift baseline yet stay positive, and the
  //     realized split must equal the post-drift oracle to the wei.
  //   LARGE — V2 drifts so far DOWN it falls below the cut entirely (V2 share → 0). The
  //     degenerate edge: the stale-skip + re-anchor must cleanly zero it out (the un-fixed
  //     solver would have over-funded the phantom deepestFar liquidity here).
  async function runV2DriftCell(
    engine: Engine,
    driftAmt: bigint,
    expectV2Funded: boolean,
    label: string,
  ) {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("20000");

    // PREPARE against the pre-drift snapshot (V2 cache is spot-anchored).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
      { solverFile: KWAY }, engine,
    );
    const v2Eco = prepared.pools.find((p) => p.isV2)!;
    const v2Idx = prepared.pools.findIndex((p) => p.isV2);

    // No-drift baseline: the V2 share BEFORE the drift (same prepared dataset, no swap), so
    // the moderate case can assert the drifted share genuinely SHRANK (continuity of the fix).
    const baselineOpt = optimalSplit({
      pools: await Promise.all(prepared.pools.map((p) => optFor(p))),
      amountIn, zeroForOne: true, priceLimit: prepared.priceLimit,
    });
    const v2BaselineShare = baselineOpt.perPoolInput[v2Idx];

    // DRIFT the V2 pair DOWN: a zeroForOne tokenIn→tokenOut swap lowers its out/in spot.
    const before = await v2Optimal(c, v2Pair, tokenIn, v2Eco.inIsToken0);
    await driftPoolPrice(c, stack.sauceRouter, v2Eco, tokenIn, tokenOut, true, driftAmt, caller);
    const afterDrift = await v2Optimal(c, v2Pair, tokenIn, v2Eco.inIsToken0);
    // out/in spot = sqrt(reserveOut/reserveIn); a zeroForOne swap raises reserveIn → lowers it.
    assert.ok(afterDrift.reserveIn! > before.reserveIn!, `${label}: drift raised V2 reserveIn (out/in spot DOWN)`);

    // Oracle from the TRUE post-drift live state.
    const optPools: OptimalPool[] = [];
    for (const p of prepared.pools) optPools.push(await optFor(p));
    const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: prepared.priceLimit });

    const inBefore: bigint[] = [];
    for (const p of prepared.pools) inBefore.push(await balanceOf(c.publicClient, tokenIn, venueFor(p)));
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", `${label}: drifted cook() must succeed`);

    const deltas: bigint[] = [];
    for (let i = 0; i < prepared.pools.length; i++) {
      deltas.push((await balanceOf(c.publicClient, tokenIn, venueFor(prepared.pools[i]))) - inBefore[i]);
    }
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    assertExactSplit(deltas, opt, spent, label);
    assert.equal(spent, amountIn, `${label}: spends amountIn exactly`);

    if (expectV2Funded) {
      // The re-anchored V2 dn-frontier genuinely consumes at the live spot — V2 STILL funded.
      assert.ok(deltas[v2Idx] > 0n, `${label}: V2 still funded at the re-anchored live spot`);
      // …but LESS than the no-drift baseline (drift-down lowers V2's price → smaller share):
      // this is the continuity gate proving the fix did not over-fund (the old defect inflated
      // the V2 share; the fix shrinks it monotonically with the drift).
      assert.ok(deltas[v2Idx] < v2BaselineShare, `${label}: drifted V2 share shrank vs baseline (${deltas[v2Idx]} < ${v2BaselineShare})`);
    } else {
      // Drifted past the cut: the stale-skip + re-anchor zero it out exactly (no over-fund).
      assert.equal(deltas[v2Idx], 0n, `${label}: V2 dropped below the cut → exactly 0 (no phantom over-fund)`);
    }
    console.log(`  [${label}] V2 delta=${deltas[v2Idx]} (oracle ${opt.perPoolInput[v2Idx]}, baseline ${v2BaselineShare}) spent=${spent}`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`F-V2drift-moderate [${engine}] V2 drifts DOWN but stays above the cut → re-anchored dn-frontier still funds it, wei-exact == oracle`, { skip }, async () => {
      // 3000e18 into the 3M-reserve V2 (~0.1% reserve change → ~0.05% out/in price drop):
      // its drifted spot stays ABOVE the equalized cut, so the re-anchored V2 dn-frontier
      // funds a reduced (nonzero) share — the path the blocker fix targets.
      await runV2DriftCell(engine, parseEther("3000"), true, `F-V2drift-mod:${engine}`);
    });
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`F-V2drift-large [${engine}] V2 drifts DOWN past the cut → re-anchored to 0 (no over-fund), wei-exact == oracle`, { skip }, async () => {
      await runV2DriftCell(engine, parseEther("200000"), false, `F-V2drift-lg:${engine}`);
    });
  }

  // ── D1 — V2 DRIFT-UP COMPETING (grid-splice quadrant) ──
  // PREPARE at spot, then drift the V2 pair's out/in spot UP with a REAL oneForZero swap
  // (push tokenOut INTO the pair → out/in spot rises ABOVE the prepared window top). The OLD
  // up-frontier clamped the straddling up-slice to the prepare-time window top and handed off
  // to the prepared brackets anchored at the prepare-time spot — SPLICING two geometric grids
  // that don't share a boundary → a different fee-adjusted-near merge key → mis-ordered cross-
  // pool merge → ~0.5-0.8% misallocation across the V2 + V3 pools. The D1 fix re-anchors the V2
  // single geometric grid to the LIVE spot (one continuous dn stream, dropping the spliced
  // up→prepared clamp) and stale-skips the prepared cache, matching the oracle's single from-
  // live-spot grid. The realized per-pool split + total must equal the POST-drift oracle to the
  // wei, AND the drifted (now better-priced) V2 share must GROW vs the no-drift baseline.
  async function runV2DriftUpCell(engine: Engine, driftAmt: bigint, label: string) {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("20000");

    // PREPARE against the pre-drift snapshot (V2 cache is spot-anchored).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
      { solverFile: KWAY }, engine,
    );
    const v2Eco = prepared.pools.find((p) => p.isV2)!;
    const v2Idx = prepared.pools.findIndex((p) => p.isV2);

    // DRIFT the V2 pair UP: push tokenOut INTO the pair (oneForZero on the pair) so its
    // out/in spot (sqrt(reserveOut/reserveIn)) RISES above the prepared window top.
    const before = await v2Optimal(c, v2Pair, tokenIn, v2Eco.inIsToken0);
    await driftPoolPrice(
      c, stack.sauceRouter, { ...v2Eco, inIsToken0: !v2Eco.inIsToken0 },
      tokenOut, tokenIn, true, driftAmt, caller,
    );
    const afterDrift = await v2Optimal(c, v2Pair, tokenIn, v2Eco.inIsToken0);
    // out/in spot up ⇔ reserveIn fell (tokenIn left the pair as tokenOut came in).
    assert.ok(afterDrift.reserveIn! < before.reserveIn!, `${label}: drift lowered V2 reserveIn (out/in spot UP)`);

    // Oracle from the TRUE post-drift live state.
    const optPools: OptimalPool[] = [];
    for (const p of prepared.pools) optPools.push(await optFor(p));
    const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: prepared.priceLimit });

    const inBefore: bigint[] = [];
    for (const p of prepared.pools) inBefore.push(await balanceOf(c.publicClient, tokenIn, venueFor(p)));
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", `${label}: drifted cook() must succeed`);

    const deltas: bigint[] = [];
    for (let i = 0; i < prepared.pools.length; i++) {
      deltas.push((await balanceOf(c.publicClient, tokenIn, venueFor(prepared.pools[i]))) - inBefore[i]);
    }
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    assertExactSplit(deltas, opt, spent, label);
    assert.equal(spent, amountIn, `${label}: spends amountIn exactly`);
    // The drifted V2 is genuinely FUNDED at its re-anchored live spot (the path that used to
    // grid-splice) and the trade SPLITS — V2 competes, does not swallow the whole trade — so
    // the up→prepared seam the defect mis-ordered is actually crossed.
    assert.ok(deltas[v2Idx] > 0n, `${label}: drifted-up V2 funded at the re-anchored live spot`);
    assert.ok(deltas.filter((d) => d > 0n).length >= 2, `${label}: split across ≥2 pools (V2 competes, does not dominate)`);
    console.log(`  [${label}] V2 delta=${deltas[v2Idx]} (oracle ${opt.perPoolInput[v2Idx]}) spent=${spent} split=${deltas.filter((d) => d > 0n).length}`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`F-V2drift-UP [${engine}] V2 drifts UP competing → re-anchored single grid == oracle, wei-exact (grid-splice fixed)`, { skip }, async () => {
      // Push the 3M-reserve V2 out/in spot UP by a modest, generic amount so the straddling
      // up-slice does NOT land on a prepared-grid boundary (the misallocating splice) yet V2
      // still SPLITS with the deep V3 0.05% pool rather than dominating the whole trade.
      await runV2DriftUpCell(engine, parseEther("3000"), `F-V2drift-up:${engine}`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// B1/B2/B3 — drift-DOWN MID-GRID + an INITIALIZED-TICK L change inside the fill.
// ─────────────────────────────────────────────────────────────
//
// The whole prior matrix used single WIDE positions (constant active L — no initialized
// tick crossed in the fill), which is precisely why the blockers stayed hidden. These
// cells reuse a genuine L-CHANGE pool: pool0 = a base [-60000,60000] L=4e6 position PLUS
// a narrow [LCHANGE,60000] L=6e6 position (so active L = 1e7 above LCHANGE, dropping to
// 4e6 below it — a real initialized tick / L change in the fill path), against a simple
// wide 0.30% pool1. Then they drift pool0 DOWN to a true MID-GRID tick (not a tickSpacing
// multiple) and assert the realized per-pool split + total == the optimal oracle (built
// from POST-drift live state) TO THE WEI, AND brute-force that the oracle is itself
// realized-optimal on the real pools. Parametrized over v1 AND v12.
//
// Why these are the blocker gate:
//   B3 — drift-down mid-grid re-anchoring: the engaged-drifted pool0 must re-anchor its
//        walk to the LIVE tick lattice (and the engine's int24 slot0-tick zero-extension
//        must be sign-corrected), else its dn frontier reads ticks() at phantom boundaries
//        → L never drops at LCHANGE → pool0 over-funds. Also the prepared cache must be
//        re-stamped CONTIGUOUS with the dn seed after the trim (else the dn frontier
//        resumes too deep, mis-allocating across pools).
//   B1 — merge ordering under with-swap drift: the drifted pool competes at its TRUE live
//        head feeAdj(min(cur,near)), not its stale spot head.
//   B2 — run-until-filled: a LARGE fill needing many tick steps must FULLY fill (cum ==
//        amountIn == oracle total), never capped (the old fixed 1024 truncated it).
describe("EcoSwap K-way — drift-DOWN mid-grid + initialized-tick L change (B1/B2/B3)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let poolConfig: ChainPoolConfig;
  const poolsByFee = new Map<number, { pool: Hex; ts: number }>();
  let cleanSnapshot: Hex;

  // pool0 (L change): base [-60000,60000] L=4e6 + narrow [LCHANGE,60000] L=6e6.
  // pool1 (wide 0.30%): [-60000,60000] L=2e6.
  const LCHANGE = -2000;
  const L0_BASE = parseEther("4000000");
  const L0_NARROW = parseEther("6000000");
  const L1 = parseEther("2000000");
  const TS0 = 10, FEE0 = 500, TS1 = 60, FEE1 = 3000;
  // pool0's full net map = {[LCHANGE]: +6e6, [-60000]: +4e6, [60000]: -(1e7)} (signed
  // liquidityNet, add-from-below positive / upper-edge negative). The oracle walks it.
  const NET0 = new Map<number, bigint>([
    [LCHANGE, L0_NARROW],
    [-60000, L0_BASE],
    [60000, -(L0_BASE + L0_NARROW)],
  ]);
  // A drift amount that lands pool0 on a true MID-GRID tick (-199, not a multiple of TS0=10).
  const DRIFT_MIDGRID = parseEther("100000");

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("900000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("900000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // pool0 — two positions ⇒ a genuine initialized tick / L change at LCHANGE.
    const pool0 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, FEE0, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, pool0, minter, -60000, 60000, L0_BASE);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, pool0, minter, LCHANGE, 60000, L0_NARROW);
    poolsByFee.set(FEE0, { pool: pool0, ts: TS0 });

    const pool1 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, FEE1, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, pool1, minter, -60000, 60000, L1);
    poolsByFee.set(FEE1, { pool: pool1, ts: TS1 });

    // Ground the oracle's NET0 net map in the REAL pool: the on-chain liquidityNet at each
    // initialized tick must equal NET0 — so the brute-force certificate (and the oracle it
    // checks) walks the pool's actual lattice, not an assumed one.
    for (const [tick, expected] of NET0) {
      const { liquidityNet } = await getTickLiquidityNet(c.publicClient, pool0, tick);
      assert.equal(liquidityNet, expected, `pool0 on-chain liquidityNet@${tick} (${liquidityNet}) != NET0 (${expected})`);
    }

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [FEE0, FEE1],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  function poolAddrFor(p: EcoPool): Hex {
    return poolsByFee.get(p.feePpm)!.pool;
  }
  function netFor(p: EcoPool): Map<number, bigint> {
    return p.feePpm === FEE0 ? NET0 : new Map<number, bigint>();
  }

  /** Read each prepared pool's POST-drift live state as an OptimalPool (with its net map). */
  async function buildOpt(pools: EcoPool[]): Promise<OptimalPool[]> {
    const out: OptimalPool[] = [];
    for (const p of pools) {
      const { ts } = poolsByFee.get(p.feePpm)!;
      const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, poolAddrFor(p));
      const liquidity = await getLiquidity(c.publicClient, poolAddrFor(p));
      out.push({ isV2: false, feePpm: p.feePpm, sqrtPriceX96, tick, tickSpacing: ts, liquidity, net: netFor(p) });
    }
    return out;
  }

  // ── Brute-force optimality certificate (solver-independent) ──
  // Confirms the optimal ORACLE is itself realised-optimal on the REAL pools — the
  // measuring stick is verified, not assumed. For a given per-pool tokenIn split, walk
  // each pool's REAL tick lattice (live tick/L + the on-chain liquidityNet curve read via
  // ticks()) accumulating tokenOut with the SAME integer math the oracle/solver use, then
  // assert NO neighbouring split (shift a slice between the two pools) beats the oracle's
  // total output by more than a wei-scale epsilon. A water-fill optimum is the unique
  // output-maximising split, so the oracle sitting at the local max IS the global optimum.

  const Q192Local = 1n << 192n;
  /** tokenOut a single V3 pool delivers for `gross` tokenIn, walking its real lattice. */
  function poolOutForInput(op: OptimalPool, gross: bigint, zeroForOne: boolean): bigint {
    if (gross <= 0n) return 0n;
    const feePpm = BigInt(op.feePpm);
    const stepRatio = getSqrtRatioAtTick(op.tickSpacing!);
    let L = op.liquidity!;
    let nearReal = op.sqrtPriceX96!;
    const base = Math.floor(op.tick! / op.tickSpacing!) * op.tickSpacing!;
    let boundary = zeroForOne ? base : base + op.tickSpacing!;
    let budget = gross;
    let out = 0n;
    for (let k = 0; k < 8192 && budget > 0n; k++) {
      const farReal = stepReal(nearReal, stepRatio, zeroForOne);
      const nearOI = toOutIn(nearReal, zeroForOne);
      const farOI = toOutIn(farReal, zeroForOne);
      if (L > 0n && nearOI > farOI && farOI > 0n) {
        const effInFull = mulDiv(L, Q96, farOI) - mulDiv(L, Q96, nearOI);
        const grossFull = mulDiv(effInFull, FEE_DENOM, FEE_DENOM - feePpm);
        if (grossFull > 0n) {
          if (budget >= grossFull) {
            // full segment: dOut = L*(nearReal - farReal)/Q96 (token1 out per zeroForOne).
            out += mulDiv(L, zeroForOne ? nearReal - farReal : farReal - nearReal, Q96);
            budget -= grossFull;
          } else {
            // partial: solve the interior far edge for the remaining budget (out/in space).
            const effIn = mulDiv(budget, FEE_DENOM - feePpm, FEE_DENOM);
            const invNear = mulDiv(L, Q96, nearOI);
            const sLowOI = mulDiv(L, Q96, invNear + effIn);
            const lowOI = sLowOI < farOI ? farOI : sLowOI;
            const lowReal = zeroForOne ? lowOI : Q192Local / lowOI;
            out += mulDiv(L, zeroForOne ? nearReal - lowReal : lowReal - nearReal, Q96);
            budget = 0n;
            break;
          }
        }
      }
      const signedNet = op.net?.get(boundary) ?? 0n;
      const raw = signedNet >= 0n ? signedNet : signedNet + MOD128;
      const neg = raw >= HALF128;
      if (zeroForOne) {
        if (neg) L = L + (MOD128 - raw);
        else L = L >= raw ? L - raw : 0n;
        boundary -= op.tickSpacing!;
      } else {
        if (neg) { const m = MOD128 - raw; L = L >= m ? L - m : 0n; }
        else L = L + raw;
        boundary += op.tickSpacing!;
      }
      nearReal = farReal;
    }
    return out;
  }

  /** Total tokenOut for a per-pool split across all pools. */
  function realizedSplitOut(optPools: OptimalPool[], split: bigint[], zeroForOne: boolean): bigint {
    let out = 0n;
    for (let i = 0; i < optPools.length; i++) out += poolOutForInput(optPools[i], split[i], zeroForOne);
    return out;
  }

  /**
   * Assert the optimal ORACLE is itself realised-optimal on the REAL pools — two ways:
   *
   *  (a) MARGINAL EQUALIZATION (the exact water-fill optimality certificate): every
   *      ENGAGED pool's fee-adjusted out/in marginal reached at the cut must cluster
   *      tightly. A pool whose marginal were materially HIGHER than another's could
   *      absorb more at a better rate — so equal marginals ⇔ output-maximising split.
   *      This is interpolation-free (the oracle reports each pool's segment-edge marginal).
   *
   *  (b) PERTURBATION (output brute force): shifting a slice between the two pools must
   *      not increase total realised tokenOut (walked over the real lattice). The
   *      perturbation crosses a fee/segment boundary so it carries some partial-fill
   *      rounding; the tolerance is relative (≪ any real mis-allocation — the B3 defect
   *      moved ~23% of input, dwarfing this band by orders of magnitude).
   */
  function assertOracleRealizedOptimal(
    optPools: OptimalPool[],
    opt: { perPoolInput: bigint[]; perPoolMarginalAdj: bigint[] },
    amountIn: bigint,
    label: string,
  ): void {
    const oracleSplit = opt.perPoolInput;
    // (a) marginal equalization across engaged pools.
    const margins = optPools.map((_, i) => opt.perPoolMarginalAdj[i]).filter((_, i) => oracleSplit[i] > 0n);
    if (margins.length >= 2) {
      const maxM = margins.reduce((a, b) => (a > b ? a : b));
      const minM = margins.reduce((a, b) => (a < b ? a : b));
      const spread = Number(maxM - minM) / Number(maxM);
      // Marginals are segment-edge granular (one tick step ≈ 1bp in sqrt); a tight 0.5%
      // band proves equalization while tolerating the discrete segment grid.
      assert.ok(spread < 0.005, `${label}: oracle marginals NOT equalized (spread ${spread})`);
    }
    // (b) perturbation brute force (2-pool cells).
    if (optPools.length !== 2) return;
    const base = realizedSplitOut(optPools, oracleSplit, true);
    const slice = amountIn / 100n;
    if (slice === 0n || base === 0n) return;
    for (const [a, b] of [[0, 1], [1, 0]] as const) {
      if (oracleSplit[a] < slice) continue;
      const alt = oracleSplit.slice();
      alt[a] -= slice;
      alt[b] += slice;
      const altOut = realizedSplitOut(optPools, alt, true);
      // Relative tolerance ≫ the partial-fill rounding of one 1% perturbation, ≪ any real
      // mis-allocation. 5e-4 (50 ppm of output) cleanly separates rounding from a defect.
      const eps = base / 2000n + 1n;
      assert.ok(
        base + eps >= altOut,
        `${label}: oracle split NOT realised-optimal — shift ${a}->${b} improves out by ${altOut - base} (eps ${eps})`,
      );
    }
  }

  /** Run one drift-down cell: prepare at spot, drift pool0 DOWN, cook, assert wei-exact. */
  async function runDriftCell(
    engine: Engine,
    amountIn: bigint,
    driftAmt: bigint,
    maxTicks: number | undefined,
    expectLCross: boolean,
    label: string,
  ) {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const opts = maxTicks !== undefined ? { maxTicks, minRelBps: 0, solverFile: KWAY } : { solverFile: KWAY };

    // PREPARE against the pre-drift snapshot (the cache, if any, is spot-anchored).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, opts, engine,
    );

    // DRIFT pool0 DOWN to a mid-grid tick with a REAL zeroForOne swap through the engine.
    if (driftAmt > 0n) {
      const p0 = prepared.pools.find((p) => p.feePpm === FEE0)!;
      await driftPoolPrice(c, stack.sauceRouter, p0, tokenIn, tokenOut, true, driftAmt, caller);
    }
    const { tick: p0Tick } = await getSlot0(c.publicClient, poolsByFee.get(FEE0)!.pool);

    // Oracle from the TRUE post-drift live state (incl. the L-change net map).
    const optPools = await buildOpt(prepared.pools);
    const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: prepared.priceLimit });
    assertOracleRealizedOptimal(optPools, opt, amountIn, label);

    const inBefore = new Map<number, bigint>();
    for (const p of prepared.pools) inBefore.set(p.feePpm, await balanceOf(c.publicClient, tokenIn, poolAddrFor(p)));
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", `${label}: cook() must succeed`);

    const deltas: bigint[] = [];
    for (const p of prepared.pools) deltas.push((await balanceOf(c.publicClient, tokenIn, poolAddrFor(p))) - inBefore.get(p.feePpm)!);
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.ok(received > 0n, `${label}: received tokenOut`);

    assertExactSplit(deltas, opt, spent, label);
    assert.equal(spent, amountIn, `${label}: spends amountIn exactly`);

    // Confirm the L change is genuinely on the fill path when expected: pool0's live tick
    // is above LCHANGE and the cut for this trade walks past it (the live active L drops).
    if (expectLCross) {
      assert.ok(p0Tick > LCHANGE, `${label}: pre-cut live tick above LCHANGE (${p0Tick})`);
      const liveLBefore = optPools[prepared.pools.findIndex((p) => p.feePpm === FEE0)].liquidity!;
      assert.equal(liveLBefore, L0_BASE + L0_NARROW, `${label}: pre-cut active L is base+narrow (1e7)`);
    }
    return { prepared, deltas, opt, p0Tick };
  }

  // (1) DRIFT-DOWN MID-GRID, no L-cross: the cut stays ABOVE LCHANGE.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`(1) [${engine}] drift-down MID-GRID (no L-cross) — wei-exact split == oracle`, { skip }, async () => {
      const { p0Tick, deltas } = await runDriftCell(engine, parseEther("50000"), DRIFT_MIDGRID, undefined, false, `(1):${engine}`);
      assert.ok(p0Tick % TS0 !== 0, `(1):${engine}: pool0 drifted to a true mid-grid tick (${p0Tick})`);
      assert.ok(deltas.filter((d) => d > 0n).length >= 1, `(1):${engine}: pool0 funded`);
    });
  }

  // (2) DRIFT-DOWN MID-GRID crossing the L change (L drops 1e7→4e6 mid-fill).
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`(2) [${engine}] drift-down MID-GRID crossing the L change — wei-exact split == oracle`, { skip }, async () => {
      const { p0Tick, deltas } = await runDriftCell(engine, parseEther("5000000"), DRIFT_MIDGRID, undefined, true, `(2):${engine}`);
      assert.ok(p0Tick % TS0 !== 0, `(2):${engine}: pool0 mid-grid (${p0Tick})`);
      assert.ok(deltas.every((d) => d > 0n), `(2):${engine}: both pools funded across the L change`);
    });
  }

  // (3) L-CHANGE no-drift regression guard: cut crosses LCHANGE, no drift.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`(3) [${engine}] no-drift, cut crosses the L change — wei-exact split == oracle (regression guard)`, { skip }, async () => {
      const { deltas } = await runDriftCell(engine, parseEther("5000000"), 0n, undefined, true, `(3):${engine}`);
      assert.ok(deltas.every((d) => d > 0n), `(3):${engine}: both pools funded`);
    });
  }

  // (4) LARGE run-until-filled (B2): a deep fill needing FAR more than 1024 tick steps must
  // FULLY fill. maxTicks:1 ⇒ a near-empty cache (≤1 bracket/pool), so the dn frontier walks
  // the bulk live. 9M against ts-10/ts-60 pools needs tens of thousands of dn steps (gas
  // ≈1.5e9 confirms the depth) — WELL past the old fixed SAFETY=1024 that truncated such
  // trades. The run-until-filled bound (brackets.length + pools.length*PER_POOL*2) must let
  // it fully fill: cum == amountIn == oracle total, wei-exact. Drift pool0 down too so the
  // re-anchored walk is deep AND crosses the L change.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`(4) [${engine}] LARGE run-until-filled past the old 1024 cap — full fill == oracle, wei-exact`, { skip }, async () => {
      const { prepared, deltas } = await runDriftCell(engine, parseEther("9000000"), DRIFT_MIDGRID, 1, true, `(4):${engine}`);
      const preparedCap = prepared.brackets.reduce((s, b) => s + b.capacity, 0n);
      assert.ok(preparedCap < parseEther("9000000"), `(4):${engine}: cache must under-fill (Σcap ${preparedCap})`);
      assert.ok(deltas.every((d) => d > 0n), `(4):${engine}: both pools funded on the deep walk`);
    });
  }

  // (5) EMPTY-CACHE (maxTicks:0) drift-down mid-grid: the quote / no-cache path.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`(5) [${engine}] EMPTY cache (maxTicks:0) + drift-down mid-grid — wei-exact split == oracle from live alone`, { skip }, async () => {
      const { prepared, p0Tick } = await runDriftCell(engine, parseEther("5000000"), DRIFT_MIDGRID, 0, true, `(5):${engine}`);
      assert.equal(prepared.brackets.length, 0, `(5):${engine}: prepared cache EMPTY (maxTicks:0)`);
      assert.ok(p0Tick % TS0 !== 0, `(5):${engine}: pool0 mid-grid (${p0Tick})`);
    });
  }

  // (6) FULLY-OUT-OF-RANGE drifted pool: a SHALLOW prepared cache (maxTicks:2 ⇒ pool0's window
  // covers only ~2 ts=10 boundaries near spot, tick ~0..-20) and then pool0 drifts DOWN to
  // ~-199 — FAR below its deepest prepared bracket. So pool0's ENTIRE prepared cache is stale
  // (every pool0 bracket sits above the live spot) and is fully stale-skipped; pool0 engages
  // ONLY via the live dn-frontier re-anchored from the deep live price (crossing LCHANGE), with
  // the steady pool1 filling the rest. The realized split must STILL equal the post-drift oracle
  // to the wei — the cache contributes nothing for the drifted pool, proving the solver is
  // optimal from the live frontier alone even when the cache is entirely out of range.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`(6) [${engine}] FULLY-OUT-OF-RANGE drifted pool (cache fully stale) → live dn-frontier only, wei-exact == oracle`, { skip }, async () => {
      const { prepared, deltas, p0Tick } = await runDriftCell(engine, parseEther("5000000"), DRIFT_MIDGRID, 2, true, `(6):${engine}`);
      // pool0's whole shallow cache must be ABOVE the post-drift live spot (fully stale): the
      // deepest pool0 prepared bracket's far edge (out/in) is still > the live out/in spot.
      const p0 = prepared.pools.find((p) => p.feePpm === FEE0)!;
      const { sqrtPriceX96 } = await getSlot0(c.publicClient, poolsByFee.get(FEE0)!.pool);
      const liveOI = toOutIn(sqrtPriceX96, true);
      const p0Brackets = prepared.brackets.filter((b) => prepared.pools[b.refIdx]?.feePpm === FEE0);
      assert.ok(p0Brackets.length > 0, `(6):${engine}: pool0 has a (shallow) prepared cache`);
      const deepestFarOI = p0Brackets.reduce((m, b) => (b.sqrtFar < m ? b.sqrtFar : m), p0Brackets[0].sqrtFar);
      assert.ok(liveOI < deepestFarOI, `(6):${engine}: live spot below the deepest pool0 bracket → cache fully stale (${liveOI} < ${deepestFarOI})`);
      assert.ok(p0Tick % TS0 !== 0, `(6):${engine}: pool0 drifted mid-grid (${p0Tick})`);
      assert.ok(deltas[prepared.pools.findIndex((p) => p.feePpm === FEE0)] > 0n, `(6):${engine}: drifted pool0 still funded via the live dn-frontier`);
      void p0;
    });
  }
});

/** Integer sqrt (Babylonian) — for the V2 marginal computation. */
function bigintSqrt(x: bigint): bigint {
  if (x <= 0n) return 0n;
  let z = x;
  let y = (z + 1n) / 2n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

// ─────────────────────────────────────────────────────────────
// C2 — DRIFT-UP × CAP-BINDING: the unified up+dn budget, on-chain
// ─────────────────────────────────────────────────────────────
//
// The DEFECT quadrant {V3 drift-UP × cap-binding}: a pool drifts UP (against the swap) AFTER
// prepare, then a trade far larger than PER_POOL=2048 steps can absorb hits the budget. Before
// the fix, up-frontier and dn-frontier had TWO INDEPENDENT PER_POOL counters — the drifted pool
// burned up-steps from the live spot down to the window top, THEN a FRESH PER_POOL for window+dn
// below, reaching up-steps + PER_POOL (up to ~2×) — but the optimal oracle (v3Segments) walks a
// SINGLE MAX_V3_STEPS loop FROM THE LIVE drifted spot. So the drifted pool OVER-REACHED at the
// cap and the split was scrambled at the cut. The FIX unifies up+window+dn into ONE SHARED
// per-pool budget, so the reach is bounded by PER_POOL from the LIVE spot == the oracle's single
// loop → the on-chain realized cum == the oracle's capped reach to the wei EVEN WHEN THE CAP
// BINDS UNDER DRIFT-UP. The single-pool walk to the cap costs ≈1.15e9 gas — confirmed < 1.9e9.
//
// This is the spec's required gas measurement case: a drift-up cap-binding cook on v1 AND v12.
describe("EcoSwap K-way — C2 drift-UP × cap-binding (shared up+dn budget, bounded gas)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let pool: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  // Shallow flat-L wide pool (same shape as B2): L=1000e18 over [-800000,800000]. After a
  // drift-UP pre-swap, a trade far larger than 2048 ts=10 steps can absorb (≈1785e18 from any
  // spot on this L) makes the from-live-spot walk cap. Wide range ⇒ constant L ⇒ the oracle's
  // empty net walks the identical lattice from the live (drifted) spot ⇒ wei-exact at the cap.
  const TS = 10;
  const FEE = 500;
  const L = parseEther("1000");

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("500000000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("500000000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, FEE, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, -800000, 800000, L);

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [FEE],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  // SINGLE-POOL drift-UP × cap-binding, across cache depths {0, 40, 96} (spec item 1). The
  // cache depth must NOT change the capped reach: with the shared up+window+dn budget, the
  // window brackets count against the SAME PER_POOL counter as the dn frontier, so window+dn
  // from the live (drifted) spot are bounded by ONE PER_POOL == the oracle's single
  // MAX_V3_STEPS loop. A deeper cache must therefore produce the IDENTICAL capped cum (and
  // == the oracle) — the on-chain confirmation that the cache is a gas optimization, never a
  // correctness lever, EVEN under drift-up at the cap.
  async function runC2Single(engine: Engine, maxTicks: number, label: string): Promise<bigint> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("1000000"); // far exceeds the from-live-spot 2048-step reach

    // PREPARE against the pre-drift snapshot (live == prepared spot here). minRelBps:0 keeps
    // the shallow pool regardless of cache depth.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
      { maxTicks, minRelBps: 0, solverFile: KWAY }, engine,
    );
    if (maxTicks === 0) assert.equal(prepared.brackets.length, 0, `${label}: empty cache (maxTicks:0)`);
    else assert.ok(prepared.brackets.length > 0, `${label}: NON-EMPTY cache (maxTicks:${maxTicks}, got ${prepared.brackets.length})`);

    // DRIFT the pool UP (against the swap) to an EXACT tickSpacing-aligned tick: push its price
    // ABOVE prepare-time spot by swapping the OTHER direction (tokenOut in, oneForZero on this
    // pool) with the sqrt price limit PINNED to getSqrtRatioAtTick(DRIFT_TICK). A large input
    // then lands the pool PRECISELY on that ts-aligned boundary. This is the spec's drift-UP
    // repro regime (the +600/+5000/+12000-tick cases are all ts multiples): the up frontier
    // walks from the live spot down to the window top landing ON the tick lattice, so the
    // up→dn handoff is seam-free and the from-live-spot reach matches the oracle's single
    // MAX_V3_STEPS walk to the wei. (A non-ts-aligned live price introduces a separate
    // per-segment fee-grossup seam at the up→dn handoff, independent of this budget fix.)
    const DRIFT_TICK = 6730; // a ts=10 multiple, well above the prepare-time spot (tick 0)
    const driftTargetSqrt = getSqrtRatioAtTick(DRIFT_TICK);
    const before = await getSlot0(c.publicClient, pool);
    await driftPoolPrice(
      c, stack.sauceRouter,
      { ...prepared.pools[0], inIsToken0: false },
      tokenOut, tokenIn, false, parseEther("500"), caller, driftTargetSqrt,
    );
    const afterDrift = await getSlot0(c.publicClient, pool);
    assert.ok(afterDrift.sqrtPriceX96 > before.sqrtPriceX96, `${label}: drift pushed the pool price UP`);
    assert.equal(afterDrift.sqrtPriceX96, driftTargetSqrt, `${label}: drift landed EXACTLY on the ts-aligned target sqrt`);
    assert.equal(afterDrift.tick % TS, 0, `${label}: live tick is ts-aligned (seam-free up→dn handoff)`);

    // Oracle from the TRUE post-drift live state. Its MAX_V3_STEPS == the solver PER_POOL, and
    // it walks a SINGLE from-live-spot loop — so the unified budget must cap at the SAME reach.
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, pool);
    const liquidity = await getLiquidity(c.publicClient, pool);
    const opt = optimalSplit({
      pools: [{ isV2: false, feePpm: FEE, sqrtPriceX96, tick, tickSpacing: TS, liquidity, net: new Map() }],
      amountIn, zeroForOne: true, priceLimit: prepared.priceLimit,
    });
    // The cap binds from the live (drifted) spot: the oracle's reach is well below the trade.
    assert.ok(opt.totalInput > 0n && opt.totalInput < amountIn, `${label}: oracle caps below amountIn (${opt.totalInput})`);

    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt, transfers } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", `${label}: cook() terminates (no SAFETY-spin / OOG)`);

    // EXACTNESS AT THE CAP UNDER DRIFT-UP: the computed cum (transferFrom caller→target) ==
    // the oracle's single-from-live-spot capped reach to the wei. (OLD: up-steps + PER_POOL
    // → over-reach; the shared budget bounds it to PER_POOL from the live spot == the oracle.)
    const pull = transfers.find(
      (t) => t.address.toLowerCase() === tokenIn.toLowerCase() &&
        t.from.toLowerCase() === caller.toLowerCase() && t.to.toLowerCase() === target.toLowerCase(),
    );
    assert.ok(pull, `${label}: expected a transferFrom(caller→target) for the capped cum`);
    assert.equal(pull!.value, opt.totalInput, `${label}: drift-up capped cum == oracle capped reach (wei-exact)`);

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    assert.ok(spent < amountIn, `${label}: under-fills (cap binds), terminal refund returns the rest`);
    // Spec gas gate: a drift-up cap-binding cook is bounded under the 1.9e9 anvil ceiling.
    assert.ok(receipt.gasUsed < 1_900_000_000n, `${label}: gas bounded under the ceiling (${receipt.gasUsed})`);

    console.log(`  [${label}] drift-up cap-binding (cache ${prepared.brackets.length}): cum=${pull!.value} (oracle ${opt.totalInput}) of ${amountIn}, gas=${receipt.gasUsed}`);
    return pull!.value;
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    // Cache depths {0, 40, 96}: empty (quote path), shallow, and deep window. The capped cum
    // must be IDENTICAL across all three (and == the oracle) — the window must never push the
    // reach past PER_POOL from the live spot.
    it(`C2 [${engine}] single-pool drift-UP × cap, cache depths {0,40,96} — cum == oracle capped reach (cache-independent), wei-exact, gas < 1.9e9`, { skip }, async () => {
      const cums: bigint[] = [];
      for (const maxTicks of [0, 40, 96]) {
        cums.push(await runC2Single(engine, maxTicks, `C2:${engine}:mt${maxTicks}`));
      }
      assert.equal(cums[0], cums[1], `C2:${engine}: capped reach independent of cache depth (0 vs 40)`);
      assert.equal(cums[0], cums[2], `C2:${engine}: capped reach independent of cache depth (0 vs 96)`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// C2-multi — DRIFT-UP × CAP-BINDING, MULTI-POOL (the scrambled cross-pool cut, on-chain)
// ─────────────────────────────────────────────────────────────
//
// The single-pool C2 proves the per-pool reach is bounded to PER_POOL from the live spot. The
// MULTI-POOL case is where the OLD over-reach actually SCRAMBLED the cross-pool split: a
// drifted-UP shallow pool0 (capping at the budget) competed with a deeper undrifted pool1.
// With two independent counters pool0 reached up-steps + PER_POOL — DEEPER than the oracle's
// single from-live-spot loop — so it stole share from pool1 at the cut. The shared budget
// bounds pool0's reach to PER_POOL from the live spot, restoring the exact split. On-chain
// realized per-pool deltas + total must equal the post-drift oracle to the wei.
describe("EcoSwap K-way — C2-multi drift-UP × cap-binding (scrambled cut, two V3 pools)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let poolConfig: ChainPoolConfig;
  const poolsByFee = new Map<number, { pool: Hex; ts: number }>();
  let cleanSnapshot: Hex;

  // pool0 (fee 500) shallow/wide [-800000,800000] ⇒ when drifted UP it caps at its 2048-step
  // reach. pool1 (fee 3000) is a DEEP, undrifted competitor (L=5e6) over a NORMAL [-60000,60000]
  // range — deep so it absorbs the post-cap remainder in only a handful of dn steps (keeping the
  // total step count ≈ the single-pool C2, so v1 stays under the 1.9e9 gas ceiling), while its
  // active L stays constant across the cut so the oracle's empty net walks the identical lattice.
  // Distinct fees so poolsByFee maps cleanly to addresses. The 4th tuple field is the mint range.
  const SPECS: [number, number, bigint, number][] = [
    [500, 10, parseEther("1000"), 800000],
    [3000, 60, parseEther("5000000"), 60000],
  ];

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("500000000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("500000000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    for (const [fee, ts, L, range] of SPECS) {
      const poolAddr = await createAndInitPool(
        c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, fee, SQRT_PRICE_1_1,
      );
      await mintPosition(c.walletClient, c.publicClient, stack.helper, poolAddr, minter, -range, range, L);
      poolsByFee.set(fee, { pool: poolAddr, ts });
    }

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [500, 3000],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  function poolAddrFor(p: EcoPool): Hex {
    return poolsByFee.get(p.feePpm)!.pool;
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`C2-multi [${engine}] drift-UP shallow pool0 caps, deeper pool1 fills the rest — split at the cut == oracle, wei-exact`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      // Sized so the drifted-UP, cheaper pool0 (fee 500, shallow L=1000e18, drifted to tick
      // 40000) CAPS at its from-live-spot PER_POOL reach (≈242e18 from tick 40000) — i.e. the
      // optimal wants MORE from pool0 than 2048 steps deliver — while the DEEP pool1 (fee 3000,
      // L=5e6) absorbs the remainder in only ≈4 dn steps WITHOUT exhausting its [-60000,60000]
      // range. An interior cut with pool0 CAPPED — the exact cross-pool ordering the OLD over-
      // reach (up-steps + PER_POOL on pool0, ~2× deep) scrambled at the cut. The shared budget
      // bounds pool0 to PER_POOL from the live spot == the oracle. (Drifting to a HIGH tick keeps
      // pool0's absorbed cap reach small + pool1's fill shallow, so the total step count ≈ the
      // single-pool C2 and v1 stays under the 1.9e9 gas ceiling.)
      const amountIn = parseEther("60000");

      // PREPARE pre-drift. Empty cache (the drift makes the spot-anchored cache stale anyway);
      // minRelBps:0 keeps the shallow pool0.
      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        { maxTicks: 0, minRelBps: 0, solverFile: KWAY }, engine,
      );

      // DRIFT pool0 (fee 500) UP to a HIGH ts-aligned tick (seam-free up→dn handoff, as in C2).
      const drifted = prepared.pools.find((p) => p.feePpm === 500)!;
      const driftAddr = poolAddrFor(drifted);
      const DRIFT_TICK = 40000; // a ts=10 multiple, far above prepare-time spot (tick 0)
      const driftTargetSqrt = getSqrtRatioAtTick(DRIFT_TICK);
      const before = await getSlot0(c.publicClient, driftAddr);
      // A large input drives pool0 UP to the pinned ts-aligned target (the limit caps it at
      // exactly tick 40000 — ~7.4× the spot price — so it lands precisely on the lattice).
      await driftPoolPrice(
        c, stack.sauceRouter, { ...drifted, inIsToken0: false },
        tokenOut, tokenIn, false, parseEther("20000"), caller, driftTargetSqrt,
      );
      const afterDrift = await getSlot0(c.publicClient, driftAddr);
      assert.ok(afterDrift.sqrtPriceX96 > before.sqrtPriceX96, `C2-multi:${engine}: pool0 drifted UP`);
      assert.equal(afterDrift.sqrtPriceX96, driftTargetSqrt, `C2-multi:${engine}: pool0 landed on the ts-aligned target`);

      // Oracle from the TRUE post-drift live state (pool0 drifted, pool1 at spot).
      const optPools: OptimalPool[] = [];
      for (const p of prepared.pools) {
        const { ts } = poolsByFee.get(p.feePpm)!;
        optPools.push(await v3Optimal(c, poolAddrFor(p), p.feePpm, ts));
      }
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: prepared.priceLimit });

      // The drifted pool0's ISOLATED capped reach (PER_POOL == MAX_V3_STEPS steps from the live
      // drifted spot, in isolation): the optimal's pool0 share must EQUAL this — i.e. the cap
      // genuinely binds on the drifted pool, the precise quadrant the defect mis-handled.
      const drift0Idx = prepared.pools.findIndex((p) => p.feePpm === 500);
      const capReach0 = optimalSplit({
        pools: [optPools[drift0Idx]], amountIn: parseEther("1000000000"),
        zeroForOne: true, priceLimit: prepared.priceLimit,
      }).totalInput;

      const inBefore = new Map<number, bigint>();
      for (const p of prepared.pools) inBefore.set(p.feePpm, await balanceOf(c.publicClient, tokenIn, poolAddrFor(p)));
      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `C2-multi:${engine}: cook() must succeed`);

      const deltas: bigint[] = [];
      for (const p of prepared.pools) deltas.push((await balanceOf(c.publicClient, tokenIn, poolAddrFor(p))) - inBefore.get(p.feePpm)!);
      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      assertExactSplit(deltas, opt, spent, `C2-multi:${engine}`);
      // Both engaged: the drifted shallow pool0 caps; the deeper pool1 absorbs the rest at the cut.
      assert.ok(deltas.filter((d) => d > 0n).length >= 2, `C2-multi:${engine}: trade splits across both pools at the cut`);
      // THE CAP BINDS on the drifted pool: pool0's realized share == its isolated PER_POOL reach.
      assert.equal(deltas[drift0Idx], capReach0, `C2-multi:${engine}: drifted pool0 CAPPED at its PER_POOL reach (${deltas[drift0Idx]} == ${capReach0})`);
      assert.equal(opt.totalInput, amountIn, `C2-multi:${engine}: deep pool1 absorbs the rest (full fill)`);
      assert.ok(receipt.gasUsed < 1_900_000_000n, `C2-multi:${engine}: gas bounded (${receipt.gasUsed})`);
      console.log(`  [C2-multi:${engine}] split=${deltas} (pool0 capped at ${capReach0}) spent=${spent} (oracle total ${opt.totalInput})`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// H — oneForZero bytecode path (zeroForOne === 0) split-exactness
// ─────────────────────────────────────────────────────────────
//
// COVERAGE GAP: every other EVM cell passes zeroForOne:true. The compiled oneForZero branches —
// toOutIn (Q192/sqrt), stepReal up-direction, tickArg negatives, and the oneForZero swap
// execution — had ZERO EVM split-exactness coverage. The kwayReference math is verified
// symmetric across the oneForZero cells on the math tier, but the v1/v12 BYTECODE path was
// unproven on-chain. Here tokenIn is the SECOND sorted token (token1), so prepare computes
// zeroForOne === false → the solver compiles+runs the oneForZero path, and the realized split
// must EQUAL the oracle (zeroForOne:false) to the wei across BOTH engines. A no-drift window-
// covers split + a dn-under-fill split exercise the prepared cursor AND the dn frontier on the
// oneForZero side.
describe("EcoSwap K-way — H oneForZero bytecode path (split-exactness == oracle)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let token0: Hex;
  let token1: Hex;
  let tokenIn: Hex; // == token1 (oneForZero)
  let tokenOut: Hex; // == token0
  let poolConfig: ChainPoolConfig;
  let poolConfigWithV2: ChainPoolConfig; // V3 + V2 (the V2/cross-version oneForZero cells)
  const poolsByFee = new Map<number, { pool: Hex; ts: number }>();
  let v2Pair: Hex;
  let cleanSnapshot: Hex;

  const H_V2_PAIR_ADDR = "0x00000000000000000000000000000000ec05b3b3" as Hex;

  // Single WIDE position each (±60000) ⇒ constant-L trade region ⇒ wei-exact.
  const SPECS: [number, number, bigint][] = [
    [500, 10, parseEther("4000000")],
    [3000, 60, parseEther("2500000")],
  ];

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const v2Factory = await deployV2Factory(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    token0 = tk.token0;
    token1 = tk.token1;
    // oneForZero: swap token1 (higher-address sorted token) IN for token0 OUT ⇒ inLower > outLower
    // ⇒ prepare sets zeroForOne === false ⇒ the solver compiles/runs the oneForZero branches.
    tokenIn = token1;
    tokenOut = token0;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, token0, minter, parseEther("500000000"));
    await mint(c.walletClient, c.publicClient, token1, minter, parseEther("500000000"));
    await approve(c.walletClient, c.publicClient, token0, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, token1, stack.helper, HUGE);

    for (const [fee, ts, L] of SPECS) {
      const poolAddr = await createAndInitPool(
        c.walletClient, c.publicClient, stack.factory, token0, token1, fee, SQRT_PRICE_1_1,
      );
      await mintPosition(c.walletClient, c.publicClient, stack.helper, poolAddr, minter, -60000, 60000, L);
      poolsByFee.set(fee, { pool: poolAddr, ts });
    }

    // V2 etched pair (deep, equal reserves) — engine fee 0.3%. Same token0/token1 order; with
    // tokenIn=token1 the V2 stream is consumed in the oneForZero out/in convention (inIsToken0
    // === false ⇒ reserveIn=r1, reserveOut=r0). Exercises the oneForZero V2 swap execution.
    v2Pair = await setupEtchedV2Pool(
      c.walletClient, c.publicClient, c.testClient, v2Factory, H_V2_PAIR_ADDR,
      token0, token1, parseEther("3000000"), parseEther("3000000"), minter,
    );

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [500, 3000],
      baseTokens: [token0, token1],
    };
    poolConfigWithV2 = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "V3" },
        { address: v2Factory, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "V2" },
      ],
      feeTiers: [500, 3000],
      baseTokens: [token0, token1],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  function poolAddrFor(p: EcoPool): Hex {
    return poolsByFee.get(p.feePpm)!.pool;
  }

  /** On-chain venue address for a prepared pool (V2 pair / V3 pool) in this fixture. */
  function venueFor(p: EcoPool): Hex {
    return p.isV2 ? v2Pair : poolAddrFor(p);
  }

  /** Read a V3 pool's live state in the oneForZero (zeroForOne:false) out/in convention. */
  async function v3OptimalRev(poolAddr: Hex, feePpm: number, tickSpacing: number): Promise<OptimalPool> {
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, poolAddr);
    const liquidity = await getLiquidity(c.publicClient, poolAddr);
    return { isV2: false, feePpm, sqrtPriceX96, tick, tickSpacing, liquidity, net: new Map() };
  }

  /** Optimal-oracle pool for a prepared pool (V2 reads live reserves; V3 reads slot0). */
  async function optFor(p: EcoPool): Promise<OptimalPool> {
    if (p.isV2) return v2Optimal(c, v2Pair, tokenIn, p.inIsToken0);
    return v3OptimalRev(poolAddrFor(p), p.feePpm, poolsByFee.get(p.feePpm)!.ts);
  }

  async function runOneForZero(
    engine: Engine,
    amountIn: bigint,
    opts: { maxTicks?: number } | undefined,
    label: string,
  ) {
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
      { ...(opts ?? {}), solverFile: KWAY }, engine,
    );
    // Confirm we are actually on the oneForZero bytecode path.
    assert.equal(prepared.zeroForOne, false, `${label}: prepare must select oneForZero (zeroForOne===false)`);

    const optPools: OptimalPool[] = [];
    for (const p of prepared.pools) {
      const { ts } = poolsByFee.get(p.feePpm)!;
      optPools.push(await v3OptimalRev(poolAddrFor(p), p.feePpm, ts));
    }
    // zeroForOne:false drives the oracle's oneForZero integration (matches the solver branch).
    const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: false, priceLimit: prepared.priceLimit });

    const inBefore = new Map<number, bigint>();
    for (const p of prepared.pools) inBefore.set(p.feePpm, await balanceOf(c.publicClient, tokenIn, poolAddrFor(p)));
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", `${label}: oneForZero cook() must succeed`);

    const deltas: bigint[] = [];
    for (const p of prepared.pools) deltas.push((await balanceOf(c.publicClient, tokenIn, poolAddrFor(p))) - inBefore.get(p.feePpm)!);
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.ok(received > 0n, `${label}: received tokenOut`);
    assertExactSplit(deltas, opt, spent, label);
    assert.equal(spent, amountIn, `${label}: spends amountIn exactly`);
    return { prepared, deltas };
  }

  // H1: no-drift window covers — exercises the prepared cursor on the oneForZero side.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`H1 [${engine}] oneForZero no-drift window-covers — wei-exact split across pools == oracle`, { skip }, async () => {
      await resetPools();
      const { deltas } = await runOneForZero(engine, parseEther("50000"), undefined, `H1:${engine}`);
      assert.ok(deltas.filter((d) => d > 0n).length >= 2, `H1:${engine}: split across ≥2 pools (oneForZero)`);
    });
  }

  // H2: narrow window under-fills → the oneForZero dn frontier closes the gap (tick walk in the
  // up-tick direction, tickArg negatives crossing tick 0). Exercises the oneForZero dn step.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`H2 [${engine}] oneForZero dn under-fill → dn frontier fills to amountIn, wei-exact == oracle`, { skip }, async () => {
      await resetPools();
      const { prepared, deltas } = await runOneForZero(engine, parseEther("80000"), { maxTicks: 2 }, `H2:${engine}`);
      const preparedCap = prepared.brackets.reduce((s, b) => s + b.capacity, 0n);
      assert.ok(preparedCap < parseEther("80000"), `H2:${engine}: prepared window must under-fill (Σcap ${preparedCap})`);
      assert.ok(deltas.filter((d) => d > 0n).length >= 2, `H2:${engine}: split across ≥2 pools (oneForZero)`);
    });
  }

  // ── oneForZero DRIFT cells: prepare at spot, drift one V3 pool with a REAL swap, cook the
  // pre-drift bytecode against the drifted live state, assert realized split == POST-drift
  // oracle to the wei. This exercises the oneForZero up-frontier (drift-UP) and dn re-anchor
  // (drift-DOWN) bytecode — the stepReal up-direction, tickArg negatives crossing tick 0, and
  // the oneForZero swap execution — none of which the prior H1/H2 (no-drift / dn) cells drove.
  //
  // Direction in oneForZero out/in space (out/in = Q192/sqrtReal): the recipe's out/in spot
  // RISES as the pool's REAL sqrtPrice FALLS. So:
  //   drift-UP (against-swap, live out/in ABOVE the window top → up frontier): push the pool's
  //     REAL price DOWN, i.e. a zeroForOne swap (token0 in) on the pool.
  //   drift-DOWN (with-swap, live out/in BELOW the window top → dn re-anchor): push the pool's
  //     REAL price UP, i.e. a oneForZero swap (token1=tokenIn in) on the pool.
  async function runOneForZeroDrift(
    engine: Engine,
    driftReal: "down" | "up", // pool REAL-price direction (down ⇒ recipe drift-UP)
    driftAmt: bigint,
    label: string,
  ) {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("6000");

    // PREPARE against the pre-drift snapshot (live == prepared spot here).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
      { solverFile: KWAY }, engine,
    );
    assert.equal(prepared.zeroForOne, false, `${label}: oneForZero (zeroForOne===false)`);

    // DRIFT the 3000 pool. driftPoolPrice swaps the given (tokenIn,tokenOut,zeroForOne) through
    // the engine. To move the pool's REAL price DOWN we run a zeroForOne (token0 in) swap; to
    // move it UP a oneForZero (token1 in) swap.
    const driftEco = prepared.pools.find((p) => p.feePpm === 3000)!;
    const driftAddr = poolAddrFor(driftEco);
    const before = await getSlot0(c.publicClient, driftAddr);
    if (driftReal === "down") {
      // token0 in (zeroForOne true on the pool) ⇒ real price DOWN ⇒ recipe out/in spot UP.
      await driftPoolPrice(
        c, stack.sauceRouter, { ...driftEco, inIsToken0: true },
        token0, token1, true, driftAmt, caller,
      );
    } else {
      // token1 in (oneForZero on the pool) ⇒ real price UP ⇒ recipe out/in spot DOWN.
      await driftPoolPrice(
        c, stack.sauceRouter, { ...driftEco, inIsToken0: false },
        token1, token0, false, driftAmt, caller,
      );
    }
    const afterDrift = await getSlot0(c.publicClient, driftAddr);
    if (driftReal === "down") assert.ok(afterDrift.sqrtPriceX96 < before.sqrtPriceX96, `${label}: pool real price drifted DOWN (recipe out/in UP)`);
    else assert.ok(afterDrift.sqrtPriceX96 > before.sqrtPriceX96, `${label}: pool real price drifted UP (recipe out/in DOWN)`);

    // Oracle from the TRUE post-drift live state, in the oneForZero convention.
    const optPools: OptimalPool[] = [];
    for (const p of prepared.pools) {
      const { ts } = poolsByFee.get(p.feePpm)!;
      optPools.push(await v3OptimalRev(poolAddrFor(p), p.feePpm, ts));
    }
    const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: false, priceLimit: prepared.priceLimit });

    const inBefore = new Map<number, bigint>();
    for (const p of prepared.pools) inBefore.set(p.feePpm, await balanceOf(c.publicClient, tokenIn, poolAddrFor(p)));
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", `${label}: drifted oneForZero cook() must succeed`);

    const deltas: bigint[] = [];
    for (const p of prepared.pools) deltas.push((await balanceOf(c.publicClient, tokenIn, poolAddrFor(p))) - inBefore.get(p.feePpm)!);
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    assertExactSplit(deltas, opt, spent, label);
    assert.equal(spent, amountIn, `${label}: spends amountIn exactly`);
    console.log(`  [${label}] split=${deltas} spent=${spent} (oracle total ${opt.totalInput})`);
    return { prepared, deltas };
  }

  // H3: oneForZero drift-UP → the up frontier (oneForZero up step) funds (spot,top] before the
  // prepared brackets. The drifted (better-priced) 3000 pool must be funded via the up frontier.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`H3 [${engine}] oneForZero drift-UP → drift-UP re-anchor fills, wei-exact == oracle`, { skip }, async () => {
      const { prepared, deltas } = await runOneForZeroDrift(engine, "down", parseEther("30000"), `H3:${engine}`);
      const driftIdx = prepared.pools.findIndex((p) => p.feePpm === 3000);
      assert.ok(deltas[driftIdx] > 0n, `H3:${engine}: drifted-up pool funded via the oneForZero up frontier`);
    });
  }

  // H4: oneForZero drift-DOWN → the prepared cache is stale-skipped and the dn frontier
  // re-anchors to the live spot (oneForZero dn re-anchor + tick walk). The trade still splits.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`H4 [${engine}] oneForZero drift-DOWN → dn re-anchor to live spot, wei-exact == oracle`, { skip }, async () => {
      const { deltas } = await runOneForZeroDrift(engine, "up", parseEther("30000"), `H4:${engine}`);
      assert.ok(deltas.filter((d) => d > 0n).length >= 1, `H4:${engine}: funded after the oneForZero dn re-anchor`);
    });
  }

  // H5: oneForZero V2 + V3 cross-version split — exercises the oneForZero V2 swap execution
  // (the unified swap(SwapParams) with the V2 poolKey ordered for oneForZero) AND the V2 stream
  // consumed in the oneForZero out/in convention. amountIn pushes the deep V3 0.05% down to the
  // V2 0.30% spot so BOTH versions engage. Realized split == oracle to the wei.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`H5 [${engine}] oneForZero V2 + V3 split — wei-exact per-pool == oracle (oneForZero V2 swap execution)`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      const amountIn = parseEther("50000");

      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfigWithV2,
        { solverFile: KWAY }, engine,
      );
      assert.equal(prepared.zeroForOne, false, `H5:${engine}: oneForZero (zeroForOne===false)`);
      assert.ok(prepared.pools.some((p) => p.isV2), `H5:${engine}: a V2 pool was discovered`);
      assert.ok(prepared.pools.some((p) => !p.isV2), `H5:${engine}: a V3 pool was discovered`);

      const optPools: OptimalPool[] = [];
      for (const p of prepared.pools) optPools.push(await optFor(p));
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: false, priceLimit: prepared.priceLimit });

      const inBefore: bigint[] = [];
      for (const p of prepared.pools) inBefore.push(await balanceOf(c.publicClient, tokenIn, venueFor(p)));
      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
      const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `H5:${engine}: oneForZero cross-version cook() must succeed`);

      const deltas: bigint[] = [];
      for (let i = 0; i < prepared.pools.length; i++) deltas.push((await balanceOf(c.publicClient, tokenIn, venueFor(prepared.pools[i]))) - inBefore[i]);
      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
      assert.ok(received > 0n, `H5:${engine}: received tokenOut`);
      assertExactSplit(deltas, opt, spent, `H5:${engine}`);
      assert.equal(spent, amountIn, `H5:${engine}: spends amountIn exactly`);
      const v2Idx = prepared.pools.findIndex((p) => p.isV2);
      assert.ok(deltas[v2Idx] > 0n, `H5:${engine}: V2 funded on the oneForZero path`);
      assert.ok(deltas.filter((d) => d > 0n).length >= 2, `H5:${engine}: split across ≥2 versions (oneForZero)`);
      console.log(`  [H5:${engine}] split=${deltas} spent=${spent} (oracle total ${opt.totalInput})`);
    });
  }

});

// ─────────────────────────────────────────────────────────────
// H6 — oneForZero CAP-BINDING (a dedicated SHALLOW pool so the budget binds)
// ─────────────────────────────────────────────────────────────
//
// Closes the cap-binding quadrant on the oneForZero bytecode path. A single shallow/wide V3
// pool with tokenIn == token1 (oneForZero) and an over-budget trade: the dn frontier walks
// up-ticks (oneForZero) from the live spot and hits PER_POOL=2048; the oracle (MAX_V3_STEPS ==
// PER_POOL, oneForZero integration) caps at the SAME reach. The computed cum (transferFrom
// caller→target) == the oracle's capped reach to the wei. (The deep H pools above cannot cap
// the oneForZero walk within the minted token budget — the oneForZero per-step reach at large L
// is huge — so this uses its own shallow L=1000e18 pool, the oneForZero analogue of B2/C2.)
describe("EcoSwap K-way — H6 oneForZero cap-binding (shallow pool, budget binds)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let token0: Hex;
  let token1: Hex;
  let tokenIn: Hex; // == token1 (oneForZero)
  let tokenOut: Hex; // == token0
  let pool: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  const TS = 10;
  const FEE = 500;
  const L = parseEther("1000"); // shallow/wide ⇒ the 2048-step reach is well below the trade

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    token0 = tk.token0;
    token1 = tk.token1;
    tokenIn = token1; // oneForZero
    tokenOut = token0;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, token0, minter, parseEther("500000000000"));
    await mint(c.walletClient, c.publicClient, token1, minter, parseEther("500000000000"));
    await approve(c.walletClient, c.publicClient, token0, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, token1, stack.helper, HUGE);

    pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, token0, token1, FEE, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, -800000, 800000, L);

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [FEE],
      baseTokens: [token0, token1],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`H6 [${engine}] oneForZero cap-binding → cum == oracle capped reach, wei-exact, bounded gas`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      // Far more than 2048 ts=10 oneForZero steps can absorb on L=1000e18: the cap binds and the
      // reach is pinned at the budget, not the trade.
      const amountIn = parseEther("1000000");

      // Default maxTicks (the v1 lens measures 0 in-range capacity for a maxTicks:0 oneForZero
      // shallow pool → drops it; the DEFAULT window measures real capacity on BOTH engines and
      // keeps the pool). A non-empty cache makes this the oneForZero analogue of D2: the window
      // brackets + dn frontier SHARE the per-pool budget, so window+dn together cap at PER_POOL
      // == the oracle's single MAX_V3_STEPS loop ⇒ the computed cum == the oracle to the wei.
      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        { minRelBps: 0, solverFile: KWAY }, engine,
      );
      assert.equal(prepared.zeroForOne, false, `H6:${engine}: oneForZero (zeroForOne===false)`);
      assert.ok(prepared.brackets.length > 0, `H6:${engine}: NON-EMPTY cache (default maxTicks, got ${prepared.brackets.length})`);
      const preparedCap = prepared.brackets.reduce((s, b) => s + b.capacity, 0n);
      assert.ok(preparedCap < amountIn, `H6:${engine}: cache under-fills the over-budget trade (Σcap ${preparedCap})`);

      const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, pool);
      const liquidity = await getLiquidity(c.publicClient, pool);
      const opt = optimalSplit({
        pools: [{ isV2: false, feePpm: FEE, sqrtPriceX96, tick, tickSpacing: TS, liquidity, net: new Map() }],
        amountIn, zeroForOne: false, priceLimit: prepared.priceLimit,
      });
      assert.ok(opt.totalInput > 0n && opt.totalInput < amountIn, `H6:${engine}: oracle caps below amountIn (${opt.totalInput})`);

      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt, transfers } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `H6:${engine}: cook() terminates (no SAFETY-spin / OOG)`);

      const pull = transfers.find(
        (t) => t.address.toLowerCase() === tokenIn.toLowerCase() &&
          t.from.toLowerCase() === caller.toLowerCase() && t.to.toLowerCase() === target.toLowerCase(),
      );
      assert.ok(pull, `H6:${engine}: expected a transferFrom(caller→target) for the capped cum`);
      assert.equal(pull!.value, opt.totalInput, `H6:${engine}: oneForZero capped cum == oracle capped reach (wei-exact)`);

      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      assert.ok(spent < amountIn, `H6:${engine}: under-fills (cap binds), terminal refund returns the rest`);
      assert.ok(receipt.gasUsed < 1_900_000_000n, `H6:${engine}: gas bounded under the ceiling (${receipt.gasUsed})`);
      console.log(`  [H6:${engine}] oneForZero cap-binding: cum=${pull!.value} (oracle ${opt.totalInput}) of ${amountIn}, gas=${receipt.gasUsed}`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// C2-V4 — CAP-BINDING on a V4 pool (the "(and V4)" arm of spec item 1, V4 StateView read path)
// ─────────────────────────────────────────────────────────────
//
// The cap-binding budget logic is engine-shared between V3 and V4 (the solver's dn/up frontier
// V3/V4 branch is the single dd[6]===0 path — V4 differs ONLY in the StateView read path:
// getSlot0/getLiquidity/getTickLiquidity vs slot0/liquidity/ticks), the drift-UP × cap budget
// is validated on V3 by C2 + C2-multi, and the F cross-version cell proves V4 split-execution
// on-chain. This cell closes the remaining V4-specific surface: the V4 READ PATH under the
// run-until-filled PER_POOL budget. A shallow V4 pool + an over-budget trade ⇒ the dn frontier
// walks live V4 ticks from spot and hits PER_POOL=2048; the oracle (MAX_V3_STEPS == PER_POOL)
// caps at the SAME reach ⇒ the computed cum == the oracle's capped reach to the wei. (No drift:
// the V4 drift harness path hardcodes sqrtPriceLimitX96:0 so it can't pin a ts-aligned target;
// the drift-UP budget arm is fully covered on V3, and the V4 budget code is the same engine path.)
describe("EcoSwap K-way — C2-V4 cap-binding on V4 (StateView read path, budget binds)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let poolManager: Hex;
  let stateView: Hex;
  let v4PoolId: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  const V4_FEE = 500;
  const V4_TS = 10;
  const L = parseEther("1000"); // shallow ⇒ the from-spot 2048-step reach is well below the trade

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const v4 = await etchV4Singletons(c.publicClient, c.testClient);
    poolManager = v4.poolManager;
    stateView = v4.stateView;
    const v4Helper = await deployV4Helper(c.walletClient, c.publicClient, poolManager);

    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("500000000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("500000000000"));

    // Shallow wide V4 position (±800000) ⇒ constant L through the trade region ⇒ the oracle's
    // empty net walks the identical lattice ⇒ wei-exact at the cap.
    v4PoolId = await setupV4Pool(
      c.walletClient, c.publicClient, v4Helper, tokenIn, tokenOut,
      V4_FEE, V4_TS, SQRT_PRICE_1_1, -800000, 800000, L, parseEther("100000000000"),
    );

    poolConfig = {
      factories: [
        { address: poolManager, stateView, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "V4" },
      ],
      feeTiers: [V4_FEE],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`C2-V4 [${engine}] V4 over-budget trade caps at PER_POOL — cum == oracle capped reach, wei-exact, bounded gas`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      const amountIn = parseEther("1000000"); // far exceeds the from-spot 2048-step V4 reach

      // Empty cache (maxTicks:0) so the dn frontier walks live V4 ticks from spot; minRelBps:0
      // keeps the shallow V4 pool.
      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        { maxTicks: 0, minRelBps: 0, solverFile: KWAY }, engine,
      );
      assert.equal(prepared.brackets.length, 0, `C2-V4:${engine}: empty cache (maxTicks:0)`);
      assert.ok(prepared.pools.some((p) => p.poolType === SwapPoolType.UniV4), `C2-V4:${engine}: V4 pool discovered`);

      // Oracle from the TRUE V4 live state (StateView reads). MAX_V3_STEPS == the solver PER_POOL.
      const { sqrtPriceX96, tick } = await getV4Slot0(c.publicClient, stateView, v4PoolId);
      const liquidity = await getV4Liquidity(c.publicClient, stateView, v4PoolId);
      const opt = optimalSplit({
        pools: [{ isV2: false, feePpm: V4_FEE, sqrtPriceX96, tick, tickSpacing: V4_TS, liquidity, net: new Map() }],
        amountIn, zeroForOne: true, priceLimit: prepared.priceLimit,
      });
      assert.ok(opt.totalInput > 0n && opt.totalInput < amountIn, `C2-V4:${engine}: oracle caps below amountIn (${opt.totalInput})`);

      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt, transfers } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `C2-V4:${engine}: cook() terminates (no SAFETY-spin / OOG)`);

      const pull = transfers.find(
        (t) => t.address.toLowerCase() === tokenIn.toLowerCase() &&
          t.from.toLowerCase() === caller.toLowerCase() && t.to.toLowerCase() === target.toLowerCase(),
      );
      assert.ok(pull, `C2-V4:${engine}: expected a transferFrom(caller→target) for the capped cum`);
      assert.equal(pull!.value, opt.totalInput, `C2-V4:${engine}: V4 capped cum == oracle capped reach (wei-exact)`);

      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      assert.ok(spent < amountIn, `C2-V4:${engine}: under-fills (cap binds), terminal refund returns the rest`);
      assert.ok(receipt.gasUsed < 1_900_000_000n, `C2-V4:${engine}: gas bounded under the ceiling (${receipt.gasUsed})`);
      console.log(`  [C2-V4:${engine}] V4 cap-binding: cum=${pull!.value} (oracle ${opt.totalInput}) of ${amountIn}, gas=${receipt.gasUsed}`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// CS — drift-UP re-anchor on-chain (clamp-splice removed): the two production-reachable
// manifestations of the old V3/V4 drift-UP clamp-and-splice, now wei-exact on the bytecode.
// ─────────────────────────────────────────────────────────────
//
// The old solver walked a drifted-UP V3/V4 pool's `up` frontier DOWN the live grid, then
// CLAMPED the final up segment to the tick-aligned window top and handed off to the prepared
// window brackets anchored at getSqrtRatioAtTick(prepTick) — splicing two grids that don't share
// a boundary, so the post-handoff bracket heads were mis-priced. The fix DROPS the up frontier
// and re-anchors a drifted pool's WHOLE walk to the live spot (one continuous grid == the optimal
// oracle's v3Segments, which never clamps), stale-skipping the prepared cache. The fast tier
// (ecoswap.kway.reference.test.ts "drift-UP re-anchor — clamp-splice removed") proves the mirror
// is wei-exact; these cells are the on-chain confirmation across BOTH engines.
//
// (1) EQUAL-FEE multi-pool drift-UP (non-cap, fully fills): two equal-fee (0.05%) V3 pools on
//     two SEPARATE forks (a Uniswap V3 factory + a genuine Pancake V3 deployer — the cross-fork
//     Uniswap-500 + Pancake-500 same-pair pools the spec calls out), one drifted UP after prepare;
//     the cut lands just past the drifted pool's up-region (the merge-tie band). The old clamp-
//     splice mis-routed ~1.5% of the up-region to the WRONG pool at the merge tie; the re-anchored
//     single grid must split wei-exact == the oracle, funding both pools.
describe("EcoSwap K-way — CS(1) equal-fee multi-pool drift-UP (cross-fork, non-cap, clamp-splice removed)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let uniPool: Hex; // Uniswap-500 (the drifted-UP fork)
  let cakePool: Hex; // Pancake-500 (undrifted, equal fee)
  let pancakeDeployer: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  // Equal fee 0.05%, ts=10. DEEP, equal L on both forks so a non-cap trade fully fills and the
  // cut sits at an interior marginal both pools reach — the merge-tie band where the old splice
  // mis-routed. Single WIDE position each ⇒ constant L ⇒ the oracle's empty net walks the
  // identical lattice from each pool's live spot ⇒ wei-exact.
  const FEE = 500;
  const TS = 10;
  const DEEP_L = parseEther("5000000");

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    pancakeDeployer = await deployPancakeDeployer(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("500000000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("500000000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // Uniswap-500 pool (the fork that will drift UP).
    uniPool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, FEE, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, uniPool, minter, -800000, 800000, DEEP_L);

    // Pancake-500 pool (genuine pancake bytecode → pancakeV3SwapCallback), same fee/pair/price.
    cakePool = await createAndInitPancakePool(
      c.walletClient, c.publicClient, pancakeDeployer, tokenIn, tokenOut, FEE, TS, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, cakePool, minter, -800000, 800000, DEEP_L);

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3", feeTiers: [FEE] },
        { address: pancakeDeployer, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local PancakeV3", feeTiers: [FEE] },
      ],
      feeTiers: [FEE],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  // Map a prepared pool to its on-chain address. The two equal-fee pools differ only by
  // address, so prepared.pools carry distinct addresses (discovery returns both) — match on it.
  function addrOf(p: EcoPool): Hex {
    return p.address as Hex;
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`CS(1) [${engine}] equal-fee cross-fork drift-UP (non-cap) → split wei-exact == oracle, both forks funded`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      // Non-cap: amountIn sized so the deep undrifted Pancake pool absorbs the rest at a cut
      // BELOW the drifted Uniswap pool's up-region top — i.e. the cut lands past the merge tie,
      // both forks funded. Far below either pool's 2048-step reach ⇒ no cap.
      const amountIn = parseEther("200000");

      // PREPARE pre-drift (both forks at spot tick 0, prepared cache anchored there).
      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        { minRelBps: 0, solverFile: KWAY }, engine,
      );
      assert.equal(prepared.zeroForOne, true, `CS(1):${engine}: zeroForOne`);
      assert.equal(prepared.pools.length, 2, `CS(1):${engine}: both equal-fee forks discovered`);
      const uniIdx = prepared.pools.findIndex((p) => addrOf(p).toLowerCase() === uniPool.toLowerCase());
      const cakeIdx = prepared.pools.findIndex((p) => addrOf(p).toLowerCase() === cakePool.toLowerCase());
      assert.ok(uniIdx >= 0 && cakeIdx >= 0, `CS(1):${engine}: both pools present in prepared.pools`);

      // DRIFT the Uniswap-500 pool UP (against the zeroForOne swap) to a ts-aligned high tick:
      // push its REAL price ABOVE prepare-time spot by a oneForZero (tokenOut in) swap pinned to
      // getSqrtRatioAtTick(DRIFT_TICK) so it lands EXACTLY on the lattice (seam-free).
      const DRIFT_TICK = 600; // a ts=10 multiple; up-region top above prepare-time spot (tick 0)
      const driftTargetSqrt = getSqrtRatioAtTick(DRIFT_TICK);
      const uniBefore = await getSlot0(c.publicClient, uniPool);
      await driftPoolPrice(
        c, stack.sauceRouter, { ...prepared.pools[uniIdx], inIsToken0: false },
        tokenOut, tokenIn, false, parseEther("200000"), caller, driftTargetSqrt,
      );
      const uniAfter = await getSlot0(c.publicClient, uniPool);
      assert.ok(uniAfter.sqrtPriceX96 > uniBefore.sqrtPriceX96, `CS(1):${engine}: Uniswap pool drifted UP`);
      assert.equal(uniAfter.sqrtPriceX96, driftTargetSqrt, `CS(1):${engine}: drift landed on the ts-aligned target`);

      // Oracle from TRUE post-drift live state (Uniswap drifted UP, Pancake at spot).
      const optPools: OptimalPool[] = [];
      for (const p of prepared.pools) optPools.push(await v3Optimal(c, addrOf(p), p.feePpm, TS));
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: prepared.priceLimit });
      assert.equal(opt.totalInput, amountIn, `CS(1):${engine}: fully fills (non-cap)`);
      // The cut must land past the merge tie: the oracle funds BOTH forks (the band where the old
      // clamp-splice mis-routed the up-region share).
      assert.ok(opt.perPoolInput[uniIdx] > 0n && opt.perPoolInput[cakeIdx] > 0n, `CS(1):${engine}: oracle funds both forks at the tie`);

      const inBefore: bigint[] = [];
      for (const p of prepared.pools) inBefore.push(await balanceOf(c.publicClient, tokenIn, addrOf(p)));
      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `CS(1):${engine}: cook() must succeed`);

      const deltas: bigint[] = [];
      for (let i = 0; i < prepared.pools.length; i++) deltas.push((await balanceOf(c.publicClient, tokenIn, addrOf(prepared.pools[i]))) - inBefore[i]);
      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      assertExactSplit(deltas, opt, spent, `CS(1):${engine}`);
      assert.equal(spent, amountIn, `CS(1):${engine}: spends amountIn exactly (non-cap)`);
      assert.ok(deltas[uniIdx] > 0n && deltas[cakeIdx] > 0n, `CS(1):${engine}: BOTH forks funded at the merge tie (clamp-splice mis-route eliminated)`);
      assert.ok(receipt.gasUsed < 1_900_000_000n, `CS(1):${engine}: gas bounded (${receipt.gasUsed})`);
      console.log(`  [CS(1):${engine}] equal-fee cross-fork drift-UP split=${deltas} spent=${spent} (oracle total ${opt.totalInput})`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// CS(2) — oneForZero × DRIFT-UP × CAP-BINDING (the ~0.08% under-fill quadrant, on-chain)
// ─────────────────────────────────────────────────────────────
//
// The old clamp-splice's other manifestation: oneForZero × drift-UP × cap-binding under-filled
// ~0.08% (the Q192/sqrt inversion double-rounds the up→window handoff). A oneForZero pool whose
// REAL price has FALLEN (recipe out/in spot ABOVE the window top — drift-UP against the oneForZero
// swap), with an over-budget trade, must reach EXACTLY PER_POOL steps FROM THE LIVE SPOT == the
// oracle's single MAX_V3_STEPS loop, wei-exact at the cap. Covers single-pool + a multi-pool arm.
describe("EcoSwap K-way — CS(2) oneForZero drift-UP × cap-binding (clamp-splice removed)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let token0: Hex;
  let token1: Hex;
  let tokenIn: Hex; // == token1 (oneForZero)
  let tokenOut: Hex; // == token0
  let poolConfig: ChainPoolConfig;
  const poolsByFee = new Map<number, { pool: Hex; ts: number }>();
  let cleanSnapshot: Hex;

  // pool0 (fee 500) shallow/wide [-800000,800000] ⇒ drifted UP it caps at its from-live-spot
  // 2048-step oneForZero reach. pool1 (fee 3000) DEEP, undrifted competitor over [-60000,60000]
  // — absorbs the post-cap remainder in a few dn steps (total step count near the single-pool
  // case, so v1 stays under the gas ceiling), constant L across the cut so the oracle matches.
  const SPECS: [number, number, bigint, number][] = [
    [500, 10, parseEther("1000"), 800000],
    [3000, 60, parseEther("5000000"), 60000],
  ];

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    token0 = tk.token0;
    token1 = tk.token1;
    tokenIn = token1; // oneForZero
    tokenOut = token0;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, token0, minter, parseEther("500000000000"));
    await mint(c.walletClient, c.publicClient, token1, minter, parseEther("500000000000"));
    await approve(c.walletClient, c.publicClient, token0, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, token1, stack.helper, HUGE);

    for (const [fee, ts, L, range] of SPECS) {
      const poolAddr = await createAndInitPool(
        c.walletClient, c.publicClient, stack.factory, token0, token1, fee, SQRT_PRICE_1_1,
      );
      await mintPosition(c.walletClient, c.publicClient, stack.helper, poolAddr, minter, -range, range, L);
      poolsByFee.set(fee, { pool: poolAddr, ts });
    }

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [500, 3000],
      baseTokens: [token0, token1],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  function poolAddrFor(p: EcoPool): Hex {
    return poolsByFee.get(p.feePpm)!.pool;
  }

  // Read a V3 pool's live state as an oneForZero (zeroForOne:false) OptimalPool.
  async function v3OptimalRev(pool: Hex, feePpm: number, ts: number): Promise<OptimalPool> {
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, pool);
    const liquidity = await getLiquidity(c.publicClient, pool);
    return { isV2: false, feePpm, sqrtPriceX96, tick, tickSpacing: ts, liquidity, net: new Map() };
  }

  // Drift a pool's oneForZero out/in spot UP (drift-UP against the oneForZero swap) by pushing
  // its REAL price DOWN to a ts-aligned target tick: a zeroForOne (token0 in) swap on the pool
  // pinned to getSqrtRatioAtTick(NEG_TICK). For oneForZero the recipe out/in = Q192/realSqrt, so
  // a LOWER real price ⇒ a HIGHER out/in spot (above the prepare-time window top). Returns the
  // post-drift live tick (negative, ts-aligned) for the assertion.
  async function driftRealDownTo(driftEco: EcoPool, negTick: number): Promise<void> {
    const driftAddr = poolAddrFor(driftEco);
    const driftTargetSqrt = getSqrtRatioAtTick(negTick);
    const before = await getSlot0(c.publicClient, driftAddr);
    await driftPoolPrice(
      c, stack.sauceRouter, { ...driftEco, inIsToken0: true },
      token0, token1, true, parseEther("20000"), c.account0, driftTargetSqrt,
    );
    const after = await getSlot0(c.publicClient, driftAddr);
    assert.ok(after.sqrtPriceX96 < before.sqrtPriceX96, `CS(2): pool real price drifted DOWN (recipe out/in UP)`);
    assert.equal(after.sqrtPriceX96, driftTargetSqrt, `CS(2): drift landed on the ts-aligned target`);
    assert.ok(after.tick % driftEco.tickSpacing === 0, `CS(2): live tick ts-aligned (seam-free)`);
  }

  // SINGLE-POOL: the shallow pool0 alone, drifted UP, over-budget — caps at PER_POOL from the
  // live (drifted) spot == the oracle, wei-exact. The ~0.08% under-fill quadrant on the bytecode.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`CS(2)-single [${engine}] oneForZero drift-UP × cap → cum == oracle capped reach, wei-exact`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      const amountIn = parseEther("1000000"); // far exceeds the from-live-spot 2048-step reach

      // Discover ONLY the shallow pool0 (feeTiers:[500]) so the cap genuinely binds on it.
      const singleConfig: ChainPoolConfig = { ...poolConfig, feeTiers: [500] };
      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, singleConfig,
        { minRelBps: 0, solverFile: KWAY }, engine,
      );
      assert.equal(prepared.zeroForOne, false, `CS(2)-single:${engine}: oneForZero`);
      assert.equal(prepared.pools.length, 1, `CS(2)-single:${engine}: only pool0 discovered`);

      // DRIFT pool0's out/in spot UP (real price DOWN) to a ts-aligned negative tick.
      await driftRealDownTo(prepared.pools[0], -600);

      const opt = optimalSplit({
        pools: [await v3OptimalRev(poolAddrFor(prepared.pools[0]), 500, 10)],
        amountIn, zeroForOne: false, priceLimit: prepared.priceLimit,
      });
      assert.ok(opt.totalInput > 0n && opt.totalInput < amountIn, `CS(2)-single:${engine}: oracle caps below amountIn (${opt.totalInput})`);

      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt, transfers } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `CS(2)-single:${engine}: cook() terminates`);

      const pull = transfers.find(
        (t) => t.address.toLowerCase() === tokenIn.toLowerCase() &&
          t.from.toLowerCase() === caller.toLowerCase() && t.to.toLowerCase() === target.toLowerCase(),
      );
      assert.ok(pull, `CS(2)-single:${engine}: expected a transferFrom(caller→target) for the capped cum`);
      assert.equal(pull!.value, opt.totalInput, `CS(2)-single:${engine}: oneForZero drift-UP capped cum == oracle (wei-exact)`);
      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      assert.ok(spent < amountIn, `CS(2)-single:${engine}: under-fills (cap binds), terminal refund`);
      assert.ok(receipt.gasUsed < 1_900_000_000n, `CS(2)-single:${engine}: gas bounded (${receipt.gasUsed})`);
      console.log(`  [CS(2)-single:${engine}] oneForZero drift-UP cap: cum=${pull!.value} (oracle ${opt.totalInput}) of ${amountIn}, gas=${receipt.gasUsed}`);
    });
  }

  // MULTI-POOL: shallow pool0 drifted UP caps at PER_POOL; the deep undrifted pool1 absorbs the
  // rest at the cut. The realized per-pool deltas + total == the oracle to the wei (the old over-
  // reach scrambled the cross-pool cut here on the oneForZero side too).
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`CS(2)-multi [${engine}] oneForZero drift-UP shallow pool0 caps, deep pool1 fills rest → split == oracle, wei-exact`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      const amountIn = parseEther("60000");

      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        { maxTicks: 0, minRelBps: 0, solverFile: KWAY }, engine,
      );
      assert.equal(prepared.zeroForOne, false, `CS(2)-multi:${engine}: oneForZero`);

      // DRIFT pool0 (fee 500) out/in UP (real DOWN) to a HIGH-magnitude ts-aligned negative tick
      // so its capped reach is small and pool1's fill shallow (keeps gas under the ceiling).
      const drifted = prepared.pools.find((p) => p.feePpm === 500)!;
      await driftRealDownTo(drifted, -40000);

      const optPools: OptimalPool[] = [];
      for (const p of prepared.pools) {
        const { ts } = poolsByFee.get(p.feePpm)!;
        optPools.push(await v3OptimalRev(poolAddrFor(p), p.feePpm, ts));
      }
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: false, priceLimit: prepared.priceLimit });

      // The drifted pool0's ISOLATED capped reach == its optimal share (the cap genuinely binds).
      const drift0Idx = prepared.pools.findIndex((p) => p.feePpm === 500);
      const capReach0 = optimalSplit({
        pools: [optPools[drift0Idx]], amountIn: parseEther("1000000000"),
        zeroForOne: false, priceLimit: prepared.priceLimit,
      }).totalInput;

      const inBefore = new Map<number, bigint>();
      for (const p of prepared.pools) inBefore.set(p.feePpm, await balanceOf(c.publicClient, tokenIn, poolAddrFor(p)));
      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `CS(2)-multi:${engine}: cook() must succeed`);

      const deltas: bigint[] = [];
      for (const p of prepared.pools) deltas.push((await balanceOf(c.publicClient, tokenIn, poolAddrFor(p))) - inBefore.get(p.feePpm)!);
      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      assertExactSplit(deltas, opt, spent, `CS(2)-multi:${engine}`);
      assert.ok(deltas.filter((d) => d > 0n).length >= 2, `CS(2)-multi:${engine}: split across both pools at the cut`);
      assert.equal(deltas[drift0Idx], capReach0, `CS(2)-multi:${engine}: drifted pool0 CAPPED at its PER_POOL reach`);
      assert.equal(opt.totalInput, amountIn, `CS(2)-multi:${engine}: deep pool1 absorbs the rest (full fill)`);
      assert.ok(receipt.gasUsed < 1_900_000_000n, `CS(2)-multi:${engine}: gas bounded (${receipt.gasUsed})`);
      console.log(`  [CS(2)-multi:${engine}] split=${deltas} (pool0 capped at ${capReach0}) spent=${spent} (oracle total ${opt.totalInput})`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// CS(3) — drift-UP symmetry: oneForZero multi-pool non-cap + V4 drift-UP
// ─────────────────────────────────────────────────────────────
//
// Closes the symmetry: a oneForZero multi-pool drift-UP that FULLY fills (the non-cap merge-tie
// band on the oneForZero side), and a V4 drift-UP (StateView read path) — both must split wei-
// exact == the oracle via the re-anchored single grid.
describe("EcoSwap K-way — CS(3) oneForZero multi-pool drift-UP (non-cap)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let token0: Hex;
  let token1: Hex;
  let tokenIn: Hex; // == token1 (oneForZero)
  let tokenOut: Hex; // == token0
  let poolConfig: ChainPoolConfig;
  const poolsByFee = new Map<number, { pool: Hex; ts: number }>();
  let cleanSnapshot: Hex;

  // Two DEEP V3 pools (distinct fees so poolsByFee maps cleanly): pool0 (fee 500) drifts UP,
  // pool1 (fee 3000) undrifted. Deep + non-cap ⇒ both fill at an interior cut == the oracle.
  const SPECS: [number, number, bigint][] = [
    [500, 10, parseEther("4000000")],
    [3000, 60, parseEther("4000000")],
  ];

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    token0 = tk.token0;
    token1 = tk.token1;
    tokenIn = token1;
    tokenOut = token0;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, token0, minter, parseEther("500000000000"));
    await mint(c.walletClient, c.publicClient, token1, minter, parseEther("500000000000"));
    await approve(c.walletClient, c.publicClient, token0, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, token1, stack.helper, HUGE);

    for (const [fee, ts, L] of SPECS) {
      const poolAddr = await createAndInitPool(
        c.walletClient, c.publicClient, stack.factory, token0, token1, fee, SQRT_PRICE_1_1,
      );
      await mintPosition(c.walletClient, c.publicClient, stack.helper, poolAddr, minter, -60000, 60000, L);
      poolsByFee.set(fee, { pool: poolAddr, ts });
    }

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [500, 3000],
      baseTokens: [token0, token1],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  function poolAddrFor(p: EcoPool): Hex {
    return poolsByFee.get(p.feePpm)!.pool;
  }

  async function v3OptimalRev(pool: Hex, feePpm: number, ts: number): Promise<OptimalPool> {
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, pool);
    const liquidity = await getLiquidity(c.publicClient, pool);
    return { isV2: false, feePpm, sqrtPriceX96, tick, tickSpacing: ts, liquidity, net: new Map() };
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`CS(3) [${engine}] oneForZero multi-pool drift-UP (non-cap) → split wei-exact == oracle, both funded`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      // pool0 drifts ~3% (60 ts=10 steps, tick -600) above pool1's spot in out/in space; on deep
      // L=4e6 that up-region absorbs ≈123k token1 before the cut reaches pool1, so amountIn must
      // exceed that to engage BOTH at the tie — while staying far under the 2048-step cap (non-cap).
      const amountIn = parseEther("200000");

      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        { minRelBps: 0, solverFile: KWAY }, engine,
      );
      assert.equal(prepared.zeroForOne, false, `CS(3):${engine}: oneForZero`);

      // DRIFT pool0 (fee 500) out/in UP (real DOWN) to a ts-aligned negative tick so its up-region
      // top sits above pool1's window — the merge-tie band on the oneForZero side.
      const drifted = prepared.pools.find((p) => p.feePpm === 500)!;
      const driftAddr = poolAddrFor(drifted);
      const driftTargetSqrt = getSqrtRatioAtTick(-600);
      const before = await getSlot0(c.publicClient, driftAddr);
      // Deep L=4e6 ⇒ reaching tick -600 needs ≈122k token0 of input; over-provision so the swap
      // clamps EXACTLY on the pinned ts-aligned target (deterministic landing).
      await driftPoolPrice(
        c, stack.sauceRouter, { ...drifted, inIsToken0: true },
        token0, token1, true, parseEther("300000"), caller, driftTargetSqrt,
      );
      const after = await getSlot0(c.publicClient, driftAddr);
      assert.ok(after.sqrtPriceX96 < before.sqrtPriceX96, `CS(3):${engine}: pool0 real price drifted DOWN (out/in UP)`);
      assert.equal(after.sqrtPriceX96, driftTargetSqrt, `CS(3):${engine}: drift landed on the ts-aligned target`);

      const optPools: OptimalPool[] = [];
      for (const p of prepared.pools) {
        const { ts } = poolsByFee.get(p.feePpm)!;
        optPools.push(await v3OptimalRev(poolAddrFor(p), p.feePpm, ts));
      }
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: false, priceLimit: prepared.priceLimit });
      assert.equal(opt.totalInput, amountIn, `CS(3):${engine}: fully fills (non-cap)`);

      const inBefore = new Map<number, bigint>();
      for (const p of prepared.pools) inBefore.set(p.feePpm, await balanceOf(c.publicClient, tokenIn, poolAddrFor(p)));
      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `CS(3):${engine}: cook() must succeed`);

      const deltas: bigint[] = [];
      for (const p of prepared.pools) deltas.push((await balanceOf(c.publicClient, tokenIn, poolAddrFor(p))) - inBefore.get(p.feePpm)!);
      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      assertExactSplit(deltas, opt, spent, `CS(3):${engine}`);
      assert.equal(spent, amountIn, `CS(3):${engine}: spends amountIn exactly (non-cap)`);
      const drift0Idx = prepared.pools.findIndex((p) => p.feePpm === 500);
      const otherIdx = prepared.pools.findIndex((p) => p.feePpm === 3000);
      assert.ok(deltas[drift0Idx] > 0n && deltas[otherIdx] > 0n, `CS(3):${engine}: both pools funded at the merge tie`);
      assert.ok(receipt.gasUsed < 1_900_000_000n, `CS(3):${engine}: gas bounded (${receipt.gasUsed})`);
      console.log(`  [CS(3):${engine}] oneForZero multi drift-UP split=${deltas} spent=${spent} (oracle total ${opt.totalInput})`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// CS(4) — V4 drift-UP (StateView read path, non-cap), re-anchored single grid
// ─────────────────────────────────────────────────────────────
//
// V4 symmetry for the re-anchor: a V4 pool drifted UP (real price down, against a zeroForOne
// swap) must re-anchor its walk to the live StateView spot and split wei-exact == the oracle.
// The V4 drift uses driftPoolPrice with the V4 pool's address; the StateView read path feeds the
// solver's getSlot0/getLiquidity/getTickLiquidity branch.
describe("EcoSwap K-way — CS(4) V4 drift-UP (StateView read path, re-anchored)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let poolManager: Hex;
  let stateView: Hex;
  let v4PoolId: Hex;
  let v4PoolAddr: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  const V4_FEE = 500;
  const V4_TS = 10;
  const L = parseEther("4000000"); // deep ⇒ non-cap

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const v4 = await etchV4Singletons(c.publicClient, c.testClient);
    poolManager = v4.poolManager;
    stateView = v4.stateView;
    v4PoolAddr = poolManager; // V4 swaps route through the PoolManager singleton (drift target)
    const v4Helper = await deployV4Helper(c.walletClient, c.publicClient, poolManager);

    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("500000000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("500000000000"));

    v4PoolId = await setupV4Pool(
      c.walletClient, c.publicClient, v4Helper, tokenIn, tokenOut,
      V4_FEE, V4_TS, SQRT_PRICE_1_1, -800000, 800000, L, parseEther("100000000000"),
    );

    poolConfig = {
      factories: [
        { address: poolManager, stateView, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "V4" },
      ],
      feeTiers: [V4_FEE],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`CS(4) [${engine}] V4 drift-UP (non-cap) → re-anchored to live StateView spot, wei-exact == oracle`, { skip }, async () => {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const caller = c.account0;
      const amountIn = parseEther("30000"); // non-cap on deep L

      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig,
        { minRelBps: 0, solverFile: KWAY }, engine,
      );
      assert.equal(prepared.zeroForOne, true, `CS(4):${engine}: zeroForOne`);
      assert.ok(prepared.pools.some((p) => p.poolType === SwapPoolType.UniV4), `CS(4):${engine}: V4 pool discovered`);

      // DRIFT the V4 pool UP (against the zeroForOne swap): push its REAL price ABOVE prepare-time
      // spot via a oneForZero (tokenOut in) swap through the engine. (The V4 drift path uses the
      // direction-extreme limit — no ts-aligned pin — but with empty net / constant wide L the
      // from-live-spot walk matches the oracle regardless of ts-alignment.)
      const v4Eco = prepared.pools.find((p) => p.poolType === SwapPoolType.UniV4)!;
      const before = await getV4Slot0(c.publicClient, stateView, v4PoolId);
      await driftPoolPrice(
        c, stack.sauceRouter, { ...v4Eco, inIsToken0: false, address: v4PoolAddr },
        tokenOut, tokenIn, false, parseEther("60000"), caller,
      );
      const after = await getV4Slot0(c.publicClient, stateView, v4PoolId);
      assert.ok(after.sqrtPriceX96 > before.sqrtPriceX96, `CS(4):${engine}: V4 pool drifted UP`);

      const opt = optimalSplit({
        pools: [await v4Optimal(c, stateView, v4PoolId, V4_FEE, V4_TS)],
        amountIn, zeroForOne: true, priceLimit: prepared.priceLimit,
      });
      assert.equal(opt.totalInput, amountIn, `CS(4):${engine}: fully fills (non-cap)`);

      const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
      const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(receipt.status, "success", `CS(4):${engine}: cook() must succeed`);

      const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
      const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
      assert.ok(received > 0n, `CS(4):${engine}: received tokenOut`);
      // Single V4 pool ⇒ the whole computed cum lands in it: spent == oracle total to the wei.
      assert.equal(spent, opt.totalInput, `CS(4):${engine}: V4 drift-UP re-anchored cum == oracle (wei-exact)`);
      assert.equal(spent, amountIn, `CS(4):${engine}: spends amountIn exactly (non-cap)`);
      assert.ok(receipt.gasUsed < 1_900_000_000n, `CS(4):${engine}: gas bounded (${receipt.gasUsed})`);
      console.log(`  [CS(4):${engine}] V4 drift-UP re-anchored cum=${spent} (oracle ${opt.totalInput}) of ${amountIn}, gas=${receipt.gasUsed}`);
    });
  }
});
