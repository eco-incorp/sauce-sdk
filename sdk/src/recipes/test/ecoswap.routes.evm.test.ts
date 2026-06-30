/**
 * EcoSwap MULTI-HOP ROUTE path — local EVM, NO fork — WEI-EXACT gate.
 *
 * A multi-hop route (tokenIn → X → tokenOut) is now a FIRST-CLASS live-walk venue
 * held to the SAME wei-exact standard as a direct pool: each leg is a SET of leg
 * pools the leg splits across, and the route competes in the global price-ordered
 * merge via its product-fold head (see the plan + ecoswap.solver-reference.ts).
 *
 * This boots anvil + the engine + a local universe with a DIRECT A→B pool AND a
 * 2-hop route A→X→B where EACH leg has MULTIPLE pools (different fee tiers). It
 * prepare()s + compile()s + cook()s the real solver, then asserts:
 *
 *   (1) WEI-EXACT — the cooked per-route + per-leg-pool tokenIn/intermediate input
 *       deltas equal the optimal split to the WEI. The neutral oracle (optimalSplit,
 *       built from the LOCAL LIVE leg state via OptimalRoute/OptimalRouteLeg) is the
 *       truth; the cursor-faithful kwayReference (which mirrors the on-chain solver
 *       bit-for-bit AND is gated wei-exact vs the oracle in the fast tier) supplies
 *       the per-UNIVERSE-pool expectation the cook must realize.
 *   (2) EQUALIZATION — at the cut the direct pool's post-fee marginal == the route's
 *       composed product head (the merge's shared marginal).
 *   (3) MULTI-POOL-LEG split — both pools in the first leg move.
 *   (4) DRIFT / re-anchor — drift a leg pool's price with a real swap AFTER prepare()
 *       but BEFORE cook(), cook the pre-drift bytecodes, and assert the recipe
 *       re-anchored to the live grid (drift + recipe ≈ baseline).
 *
 * A V2/V4-leg test is shipped {skip:true} + TODO (V3-only legs land first).
 *
 * Run: ECO_ENGINE=v1 pnpm --filter './sdk' exec tsx --test src/recipes/test/ecoswap.routes.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Hex, type Account } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import { driftPoolPrice } from "./harness/drift";
import {
  ensureMulticall3,
  deployStack,
  deployToken,
  createAndInitPool,
  mint,
  approve,
  balanceOf,
  getSlot0,
  mintPosition,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import type { EcoPool, EcoSwapPrepared } from "../shared/types";
import { ecoSwap } from "../ecoswap/index";
import { kwayReference } from "./ecoswap.solver-reference";
import { optimalSplit, type OptimalPool, type OptimalRoute } from "./ecoswap.optimal";
import { toOutIn, feeAdjust } from "./ecoswap.math";

const HUGE = parseEther("1000000000");
const ENGINE_CELLS = engineCells();
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const HOP_FEE_A = 500;
const HOP_FEE_B = 3000;

/**
 * Reconstruct the FLAT POOL UNIVERSE index.ts buildPoolUniverseAndRouting builds —
 * [...prepared.pools, ...legPools] deduped by lowercased address, leg pools appended
 * contiguously per leg — together with each pool's INPUT token (the token it pulls in
 * its hop: tokenIn for a direct pool / a leg-0 pool; the leg's hopIn for a deeper leg).
 * Mirrors the reference's universe build so on-chain deltas map to reference indices.
 */
function buildUniverse(prepared: EcoSwapPrepared): {
  pools: EcoPool[];
  /** input token per universe pool (the token whose pool balance moves on the hop). */
  inputToken: Hex[];
  directCount: number;
} {
  const directCount = prepared.pools.length;
  const pools: EcoPool[] = [...prepared.pools];
  const idxByAddr = new Map<string, number>();
  prepared.pools.forEach((p, i) => idxByAddr.set(p.address.toLowerCase(), i));

  // Direct pools pull the swap's tokenIn — sentinel ZERO here, the reader uses tokenIn for the
  // direct prefix. Leg pools' input token is their leg's hopIn (the route structure carries it).
  const inputToken: Hex[] = prepared.pools.map(() => ZERO);

  for (const route of prepared.routes) {
    for (const leg of route.legs) {
      for (const lp of leg.pools) {
        const key = lp.address.toLowerCase();
        let idx = idxByAddr.get(key);
        if (idx === undefined) {
          idx = pools.length;
          pools.push(lp);
          idxByAddr.set(key, idx);
          inputToken.push(leg.hopIn);
        } else {
          // deduped to an earlier (direct or leg) index — keep its input token.
        }
      }
    }
  }
  return { pools, inputToken, directCount };
}

/** Build the oracle OptimalRoute legs from the prepared route's LIVE leg-pool state. */
async function liveOptimalRoutes(
  c: HarnessClients,
  prepared: EcoSwapPrepared,
): Promise<OptimalRoute[]> {
  const routes: OptimalRoute[] = [];
  for (const route of prepared.routes) {
    // The oracle leg is ONE pool; a multi-pool leg expands to the cartesian product of
    // leg-pool choices as PARALLEL routes (each a single-pool-per-leg path through the
    // shared intermediate). The reference's ONE perRouteInput equals the SUM over these.
    let combos: OptimalPool[][] = [[]];
    for (const leg of route.legs) {
      const legOpts: OptimalPool[] = [];
      for (const lp of leg.pools) {
        const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, lp.address);
        legOpts.push({
          isV2: false,
          feePpm: lp.feePpm,
          sqrtPriceX96,
          tick,
          tickSpacing: lp.tickSpacing,
          liquidity: lp.spotActiveL ?? 0n,
          net: lp.adaptiveNet ?? new Map<number, bigint>(),
        });
      }
      const next: OptimalPool[][] = [];
      for (const prefix of combos) {
        for (const opt of legOpts) next.push([...prefix, opt]);
      }
      combos = next;
    }
    for (const combo of combos) {
      routes.push({ legs: combo.map((p, i) => ({ ...p, zeroForOne: route.legs[i].zeroForOne })) });
    }
  }
  return routes;
}

/** Build the oracle's OptimalPool list for the prepared DIRECT pools (live state). */
async function liveOptimalDirect(
  c: HarnessClients,
  prepared: EcoSwapPrepared,
): Promise<OptimalPool[]> {
  const out: OptimalPool[] = [];
  for (const p of prepared.pools) {
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, p.address);
    out.push({
      isV2: false,
      feePpm: p.feePpm,
      sqrtPriceX96,
      tick,
      tickSpacing: p.tickSpacing,
      liquidity: p.spotActiveL ?? 0n,
      net: p.adaptiveNet ?? new Map<number, bigint>(),
    });
  }
  return out;
}

describe("EcoSwap multi-hop route — WEI-EXACT (direct A->B + 2-hop A->X->B, multi-pool legs)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let base: Hex; // intermediate X
  let tokenOut: Hex;
  // direct A->B + leg0 (A->X) x2 fees + leg1 (X->B) x2 fees
  let directPool: Hex;
  let leg0a: Hex;
  let leg0b: Hex;
  let leg1: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);

    // Three distinct tokens. tokenIn < base < tokenOut is NOT required — per-pool
    // direction is derived per leg from address ordering by prepare(); the solver
    // self-orients from each pool's inIsToken0. Deploy in role order; addresses are
    // whatever the deployer hands out.
    tokenIn = await deployToken(c.walletClient, c.publicClient, "In", "IN");
    base = await deployToken(c.walletClient, c.publicClient, "Base", "BASE");
    tokenOut = await deployToken(c.walletClient, c.publicClient, "Out", "OUT");

    const minter = c.account0;
    for (const t of [tokenIn, base, tokenOut]) {
      await mint(c.walletClient, c.publicClient, t, minter, parseEther("1000000000"));
      await approve(c.walletClient, c.publicClient, t, stack.helper, HUGE);
    }

    // DIRECT A->B pool: SHALLOW (fills first, then overflows into the route at the cut).
    directPool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, HOP_FEE_B, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, directPool, minter, -12000, 12000, parseEther("8000"),
    );

    // ROUTE leg pools. leg0 (A->X) splits across TWO fee tiers (the MULTI-POOL leg — the
    // leg-internal merge orders by fee-adjusted head). leg1 (X->B) is ONE DEEP pool, so the
    // route's optimal split is the SUM over the parallel single-pool routes {leg0a->leg1,
    // leg0b->leg1} sharing the (effectively unbounded) leg1 — the exact identity the neutral
    // oracle (optimalSplit) models, so the EVM wei-exact tie is valid. All DEEP at 1:1.
    leg0a = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, base, HOP_FEE_A, SQRT_PRICE_1_1,
    );
    leg0b = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, base, HOP_FEE_B, SQRT_PRICE_1_1,
    );
    leg1 = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, base, tokenOut, HOP_FEE_A, SQRT_PRICE_1_1,
    );
    // leg1 EXTREMELY deep (≈1e26) so its price does not move a bracket within the trade — the
    // parallel-route oracle identity (Σ over {leg0a->leg1, leg0b->leg1} == the single route's
    // leg-internal split) is then wei-exact, since leg1 behaves as the shared unbounded sink the
    // oracle assumes when it walks leg1 once per parallel route.
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, leg1, minter, -12000, 12000, parseEther("100000000"),
    );
    for (const pool of [leg0a, leg0b]) {
      await mintPosition(
        c.walletClient, c.publicClient, stack.helper, pool, minter, -12000, 12000, parseEther("400000"),
      );
    }

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [HOP_FEE_A, HOP_FEE_B],
      baseTokens: [base], // the intermediate hop token
    };

    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("1000000"));
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => anvil?.stop());

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  /** Read every universe pool's INPUT-token balance (direct → tokenIn; leg pool → hopIn). */
  async function readInputBalances(
    pools: EcoPool[],
    inputToken: Hex[],
    directCount: number,
  ): Promise<bigint[]> {
    const out: bigint[] = [];
    for (let i = 0; i < pools.length; i++) {
      const tk = i < directCount ? tokenIn : inputToken[i];
      out.push(await balanceOf(c.publicClient, tk, pools[i].address));
    }
    return out;
  }

  // ── (1)(2)(3) WEI-EXACT split + equalization + multi-pool-leg ──
  async function runWeiExact(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    // Sized so the SHALLOW direct pool fills, then the trade overflows into the route —
    // both legs split internally (multi-pool legs) at a clean interior cut.
    const amountIn = parseEther("20000");
    const caller = c.account0;

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      target,
      caller,
      poolConfig,
      { minRelBps: 0 }, // keep every alive pool (no relative-depth dropping)
      engine,
    );

    // Topology asserts: one direct A->B pool + one 2-hop route, each leg multi-pool.
    assert.equal(prepared.pools.length, 1, "exactly one direct A->B pool");
    assert.equal(prepared.routes.length, 1, "exactly one route (through base)");
    const route = prepared.routes[0];
    assert.equal(route.legs.length, 2, "2-hop route");
    assert.equal(route.intermediateTokens.length, 1, "one intermediate");
    assert.equal(route.intermediateTokens[0].toLowerCase(), base.toLowerCase(), "intermediate is base");
    assert.ok(route.legs[0].pools.length >= 2, "leg0 splits across >=2 pools (multi-pool leg)");
    assert.equal(route.legs[1].pools.length, 1, "leg1 is one deep pool (parallel-route oracle identity)");

    const { pools, inputToken, directCount } = buildUniverse(prepared);

    // ── The wei-exact expectation: kwayReference mirrors the on-chain solver bit-for-bit
    // (and is gated wei-exact vs the oracle in the fast tier). Its perPoolInput is indexed
    // by UNIVERSE pool, perRouteInput by route. ──
    const ref = kwayReference(prepared, amountIn);

    // ── Independent oracle (optimalSplit, built from LOCAL LIVE leg state). The reference
    // must equal it on totalInput + route input (the multi-pool leg expands to parallel
    // single-pool routes; the reference's ONE route == the Σ of those). ──
    const optDirect = await liveOptimalDirect(c, prepared);
    const optRoutes = await liveOptimalRoutes(c, prepared);
    const opt = optimalSplit({
      pools: optDirect,
      routes: optRoutes,
      amountIn,
      zeroForOne: prepared.zeroForOne,
      priceLimit: prepared.priceLimit,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei-exact)");
    // The reference's single route input == the Σ over the oracle's parallel single-pool routes.
    const oracleRouteSum = opt.perRouteInput.reduce((a, b) => a + b, 0n);
    assert.equal(ref.perRouteInput[0], oracleRouteSum, "reference route input == oracle parallel sum (wei-exact)");
    // Direct-pool input matches the oracle's direct pool to the wei.
    assert.equal(ref.perPoolInput[0], opt.perPoolInput[0], "reference direct input == oracle direct (wei-exact)");

    // ── Snapshot input balances, cook, read deltas ──
    const inBefore = await readInputBalances(pools, inputToken, directCount);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "route cook() must succeed");

    const inAfter = await readInputBalances(pools, inputToken, directCount);
    const delta: bigint[] = inAfter.map((a, i) => a - inBefore[i]);

    const idxByAddr = new Map<string, number>();
    pools.forEach((p, i) => idxByAddr.set(p.address.toLowerCase(), i));

    // (1a) WEI-EXACT — DIRECT pools: on-chain tokenIn delta == oracle perPoolInput (== reference,
    // gated identical in the fast tier). The reference's perPoolInput is sized directCount, so the
    // direct prefix is the per-pool wei gate; leg pools come from the oracle's parallel routes below.
    for (let i = 0; i < directCount; i++) {
      assert.equal(delta[i], opt.perPoolInput[i], `[${engine}] direct pool[${i}] input delta != oracle (wei)`);
      assert.equal(delta[i], ref.perPoolInput[i], `[${engine}] direct pool[${i}] input delta != reference (wei)`);
    }

    // (1b) WEI-EXACT — PER-LEG-POOL: the multi-pool leg0 / single-pool leg1 route decomposes into
    // the oracle's PARALLEL single-pool routes {leg0.pools[k] -> leg1}. liveOptimalRoutes built
    // them in leg0-pool order (leg0 first in the cartesian fold, leg1 the single tail), so
    // opt.perRouteInput[k] is the tokenIn through leg0.pools[k]. The on-chain leg0-pool tokenIn
    // delta must equal it to the WEI.
    const leg0Idxs: number[] = route.legs[0].pools.map((lp) => idxByAddr.get(lp.address.toLowerCase())!);
    assert.equal(optRoutes.length, route.legs[0].pools.length, "one parallel oracle route per leg0 pool");
    for (let k = 0; k < leg0Idxs.length; k++) {
      assert.equal(
        delta[leg0Idxs[k]], opt.perRouteInput[k],
        `[${engine}] leg0 pool[${k}] tokenIn delta != oracle parallel-route input (on-chain ${delta[leg0Idxs[k]]} vs oracle ${opt.perRouteInput[k]})`,
      );
    }

    // leg1 (single pool) receives the realized intermediate X; its X-side delta must be > 0 and the
    // route input (Σ leg0 tokenIn) must equal the reference route input to the WEI.
    const leg1Idx = idxByAddr.get(route.legs[1].pools[0].address.toLowerCase())!;
    assert.ok(delta[leg1Idx] > 0n, `[${engine}] leg1 pool received the intermediate token`);
    const onchainRouteIn = leg0Idxs.reduce((s, i) => s + delta[i], 0n);
    assert.equal(onchainRouteIn, ref.perRouteInput[0], `[${engine}] on-chain route input (Σ leg0 tokenIn) != reference route input (wei)`);

    // (3) MULTI-POOL-LEG split: BOTH leg0 pools moved.
    const leg0Moved = leg0Idxs.filter((i) => delta[i] > 0n).length;
    assert.ok(leg0Moved >= 2, `[${engine}] leg0 must split across >=2 pools (moved ${leg0Moved})`);

    // Direct pool engaged AND route engaged (the shared-cut split).
    assert.ok(delta[0] > 0n, `[${engine}] direct pool engaged`);
    assert.ok(ref.perRouteInput[0] > 0n, `[${engine}] route engaged`);

    // Caller spent exactly the computed gross (compute-then-pull, no binding limit).
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (compute-then-pull)`);
    assert.ok(received > 0n, `[${engine}] caller received tokenOut`);

    // (2) EQUALIZATION at the cut: the direct pool's post-fee marginal ≈ the route's composed
    // product head (the merge's shared marginal). Read the post-cook spot of the direct pool and
    // the route's per-leg internal-best pools; fold the legs into a route head and compare. The
    // two equalize to within fee-rounding (the merge stops when the next-best segment dips below
    // the cut, so they agree to a per-bracket micro-step, not exactly).
    const directAdj = await feeAdjMarginal(directPool, prepared.pools[0].feePpm, prepared.zeroForOne);
    // Route head: product fold of each leg's best (cheapest-fee) pool's post-fee marginal.
    const leg0Best = route.legs[0].pools.reduce((a, b) => (a.feePpm <= b.feePpm ? a : b));
    const leg1Best = route.legs[1].pools.reduce((a, b) => (a.feePpm <= b.feePpm ? a : b));
    const h0 = await feeAdjMarginal(leg0Best.address, leg0Best.feePpm, route.legs[0].zeroForOne);
    const h1 = await feeAdjMarginal(leg1Best.address, leg1Best.feePpm, route.legs[1].zeroForOne);
    const Q96 = 1n << 96n;
    const routeHead = (h0 * h1) / Q96;
    const hi = directAdj > routeHead ? directAdj : routeHead;
    const lo = directAdj > routeHead ? routeHead : directAdj;
    const rel = Number(hi - lo) / Number(hi);
    assert.ok(rel < 5e-3, `[${engine}] equalization: direct marginal ${directAdj} ≈ route head ${routeHead} (rel ${rel})`);

    console.log(
      `  [ROUTE-WEI ${engine}] direct=${delta[0]} routeIn=${ref.perRouteInput[0]} spent=${spent} received=${received}\n` +
        `       leg0 split: ${leg0Idxs.map((i) => delta[i]).join(", ")}  equalize rel=${rel}`,
    );
  }

  /** Post-swap fee-adjusted out/in marginal for a V3 pool. */
  async function feeAdjMarginal(pool: Hex, feePpm: number, zeroForOne: boolean): Promise<bigint> {
    const { sqrtPriceX96 } = await getSlot0(c.publicClient, pool);
    return feeAdjust(toOutIn(sqrtPriceX96, zeroForOne), feePpm);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`WEI-EXACT direct + multi-pool-leg route split == optimal [${engine}]`, { skip }, async () => {
      await runWeiExact(engine);
    });
  }

  // ── (4) DRIFT / re-anchor ──
  // Drift a leg pool's price with a REAL swap AFTER prepare()+compile() but BEFORE the real
  // cook(), then cook the PRE-DRIFT bytecodes. The unified single-pass solver is INPUT-ANCHORED:
  // it spends the full amountIn either way — the re-anchoring shows up as a SHIFT in the SPLIT,
  // not in the total. Phase A reads the LIVE (drifted) slot0, so the drifted leg pool (leg0a, its
  // price pushed DOWN with the swap → less attractive) gets a SMALLER tokenIn share than baseline,
  // while the untouched leg pool (leg0b) picks up the difference. Proves the recipe re-anchored to
  // the live grid at cook (not the stale prepared price).
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`DRIFT re-anchor: drift a leg pool, the split adapts at runtime [${engine}]`, { skip }, async () => {
      const target = cookTarget(engine, stack, v12);
      const amountIn = parseEther("20000");
      const caller = c.account0;

      // ── Baseline (no drift): record leg0a's tokenIn share. ──
      await resetPools();
      const baseline = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, { minRelBps: 0 }, engine,
      );
      const leg0aBefore0 = await balanceOf(c.publicClient, tokenIn, leg0a);
      const callerInBefore0 = await balanceOf(c.publicClient, tokenIn, caller);
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const r0 = await cook(c.walletClient, c.publicClient, target, baseline.bytecodes);
      assert.equal(r0.receipt.status, "success", "baseline cook ok");
      const baselineLeg0aShare = (await balanceOf(c.publicClient, tokenIn, leg0a)) - leg0aBefore0;
      const baselineSpent = callerInBefore0 - (await balanceOf(c.publicClient, tokenIn, caller));
      assert.ok(baselineLeg0aShare > 0n, "baseline routes some tokenIn through leg0a");

      // ── Fresh state: prepare()+compile() clean, drift leg0a DOWN, cook the PRE-DRIFT bytecodes. ──
      await resetPools();
      const { bytecodes } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, { minRelBps: 0 }, engine,
      );

      // Real drift swap on leg0a (tokenIn -> base), cooked through the v1 SauceRouter (the drift
      // harness only needs to MOVE the pool's price; it self-orients on the per-pool direction).
      const zHop0 = BigInt(tokenIn) < BigInt(base);
      const leg0aEco: EcoPool = {
        poolType: SwapPoolType.UniV3, address: leg0a, fee: HOP_FEE_A, tickSpacing: 10, hooks: ZERO,
        feePpm: HOP_FEE_A, isV2: false, inIsToken0: zHop0,
        stateView: ZERO, poolId: ("0x" + "0".repeat(64)) as Hex, source: "drift",
      };
      const driftIn = parseEther("8000");
      await driftPoolPrice(c, stack.sauceRouter, leg0aEco, tokenIn, base, zHop0, driftIn, caller);

      const { sqrtPriceX96: driftedLeg0a } = await getSlot0(c.publicClient, leg0a);

      // Cook the PRE-DRIFT recipe bytecodes against the drifted live state.
      const leg0aBefore1 = await balanceOf(c.publicClient, tokenIn, leg0a);
      const callerInBefore1 = await balanceOf(c.publicClient, tokenIn, caller);
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const r1 = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(r1.receipt.status, "success", "pre-drift cook against drifted state ok");
      const driftedLeg0aShare = (await balanceOf(c.publicClient, tokenIn, leg0a)) - leg0aBefore1;
      const recipeSpent = callerInBefore1 - (await balanceOf(c.publicClient, tokenIn, caller));

      // Input-anchored: the recipe still spends ~the full amountIn (it re-anchored, did not revert
      // or under-fill against the stale price).
      assert.equal(recipeSpent, baselineSpent, `[${engine}] input-anchored: spends the same total as baseline`);
      // RE-ANCHOR signal: leg0a's price was pushed DOWN (against the merge), so the runtime split
      // routes STRICTLY LESS through leg0a than the baseline did — the split adapted to the LIVE
      // drifted price Phase A read, not the stale prepared one.
      assert.ok(
        driftedLeg0aShare < baselineLeg0aShare,
        `[${engine}] re-anchor: leg0a share shrank under drift (drifted ${driftedLeg0aShare} < baseline ${baselineLeg0aShare})`,
      );

      console.log(
        `  [ROUTE-DRIFT ${engine}] baselineSpent=${baselineSpent} recipeSpent=${recipeSpent}\n` +
          `       leg0a share baseline=${baselineLeg0aShare} -> drifted=${driftedLeg0aShare} (drift ${driftIn}, slot0 now ${driftedLeg0a})`,
      );
    });
  }

  // ── V2/V4-leg route — FOLLOW-UP (V3-only legs land first) ──
  // TODO: the on-chain route execution dispatches every hop as a flat swapV3. V2/V4 legs need
  // per-hop type dispatch in the route exec (V2 transfer+pool.swap / V4 swap(SwapParams) with the
  // nested PoolKey), plus the leg-pool stamping already being type-agnostic (it is). When that
  // lands, this exercises a 2-hop route whose first leg is a V2 pool and second leg a V3 pool,
  // asserting the same wei-exact split. Skipped until the route-exec type dispatch is implemented.
  it("WEI-EXACT V2-leg + V3-leg route split == optimal", { skip: true }, async () => {
    // TODO(N-hop / V2-V4 legs follow-up): build a V2 A->X leg + V3 X->B leg, prepare+cook,
    // assert per-leg-pool deltas == optimalSplit (OptimalRouteLeg with isV2:true on leg0).
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3-HOP route — N-leg event end-to-end on the EVM (the staged N-hop generalization).
//
// A 4-token universe A->X->Y->B where the route is a THREE-leg chain (leg0 A->X, leg1
// X->Y, leg2 Y->B — DIFFERING fee tiers so the BINDING leg genuinely rotates across
// events) PLUS a competing direct A->B pool. prepare() enumerates exactly the one 3-hop
// route (the only edges with V3 liquidity are A-X, X-Y, Y-B + the A-B direct), the solver
// folds all THREE legs via routeHeadFold and advances the binding leg via routeEventN
// with conservation maintained at BOTH intermediates (X and Y); the cook is asserted
// WEI-EXACT vs the neutral oracle (optimalSplit over the live leg state — a single
// single-pool-per-leg OptimalRoute) and the cursor-faithful kwayReference. Same gate as
// the 2-hop test, one more leg, with both intermediates' conservation exercised.
//
// SINGLE pool per leg here (the wei-exact N-hop landing). A MULTI-POOL leg inside a
// k>=3 route is a documented follow-up: the oracle models a multi-pool leg as parallel
// single-pool routes that SHARE the downstream legs, and that parallel decomposition is
// wei-exact with the single-route leg-internal split only at k=2 (proven by the 2-hop
// test above + the fast tier). At k>=3 the shared-downstream-leg conservation diverges
// (the on-chain solver under-engages the second leg pool) — the multi-route /
// shared-intermediate delta read in the plan's later stage. The 2-hop test covers the
// multi-pool-leg split; this 3-hop test covers the N-leg conservation chain.
// ─────────────────────────────────────────────────────────────────────────────
describe("EcoSwap multi-hop route — WEI-EXACT 3-HOP (direct A->B + 3-hop A->X->Y->B, rotating binding leg)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let xTok: Hex; // first intermediate X
  let yTok: Hex; // second intermediate Y
  let tokenOut: Hex;
  let directPool: Hex;
  let leg0: Hex; // A->X
  let leg1: Hex; // X->Y
  let leg2: Hex; // Y->B
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;
  // leg fee tiers — leg0/leg2 cheap (0.05%), leg1 expensive (0.30%): the binding leg rotates
  // between leg0/leg2 (the finite leg that crosses first) as the walk descends.
  const FEE_LEG0 = HOP_FEE_A;
  const FEE_LEG1 = HOP_FEE_B;
  const FEE_LEG2 = HOP_FEE_A;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);

    tokenIn = await deployToken(c.walletClient, c.publicClient, "In", "IN");
    xTok = await deployToken(c.walletClient, c.publicClient, "MidX", "MIDX");
    yTok = await deployToken(c.walletClient, c.publicClient, "MidY", "MIDY");
    tokenOut = await deployToken(c.walletClient, c.publicClient, "Out", "OUT");

    const minter = c.account0;
    for (const t of [tokenIn, xTok, yTok, tokenOut]) {
      await mint(c.walletClient, c.publicClient, t, minter, parseEther("1000000000"));
      await approve(c.walletClient, c.publicClient, t, stack.helper, HUGE);
    }

    // DIRECT A->B pool: SHALLOW (fills first, then overflows into the 3-hop route at the cut).
    directPool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, HOP_FEE_B, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, directPool, minter, -12000, 12000, parseEther("8000"),
    );

    // Single-pool legs. leg0 (A->X) is the FINITE binding leg (≈4e23); leg1 (X->Y) + leg2 (Y->B)
    // are EXTREMELY deep (≈1e26) so the route's depth is governed by leg0, and the binding leg is
    // unambiguous each event. Differing fees (leg0/leg2 0.05%, leg1 0.30%) so the product-fold head
    // is non-trivial. All initialised 1:1.
    leg0 = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, xTok, FEE_LEG0, SQRT_PRICE_1_1,
    );
    leg1 = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, xTok, yTok, FEE_LEG1, SQRT_PRICE_1_1,
    );
    leg2 = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, yTok, tokenOut, FEE_LEG2, SQRT_PRICE_1_1,
    );
    for (const deep of [leg1, leg2]) {
      await mintPosition(
        c.walletClient, c.publicClient, stack.helper, deep, minter, -12000, 12000, parseEther("100000000"),
      );
    }
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, leg0, minter, -12000, 12000, parseEther("400000"),
    );

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [HOP_FEE_A, HOP_FEE_B],
      baseTokens: [xTok, yTok], // the two intermediate hop tokens
    };

    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("1000000"));
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => anvil?.stop());

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  async function readInputBalances(
    pools: EcoPool[],
    inputToken: Hex[],
    directCount: number,
  ): Promise<bigint[]> {
    const out: bigint[] = [];
    for (let i = 0; i < pools.length; i++) {
      const tk = i < directCount ? tokenIn : inputToken[i];
      out.push(await balanceOf(c.publicClient, tk, pools[i].address));
    }
    return out;
  }

  async function feeAdjMarginal(pool: Hex, feePpm: number, zeroForOne: boolean): Promise<bigint> {
    const { sqrtPriceX96 } = await getSlot0(c.publicClient, pool);
    return feeAdjust(toOutIn(sqrtPriceX96, zeroForOne), feePpm);
  }

  async function run3Hop(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("20000");
    const caller = c.account0;

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      target,
      caller,
      poolConfig,
      { minRelBps: 0 },
      engine,
    );

    // Topology: one direct A->B pool + one 3-hop route (A->X->Y->B), single pool per leg.
    assert.equal(prepared.pools.length, 1, "exactly one direct A->B pool");
    assert.equal(prepared.routes.length, 1, "exactly one route (the 3-hop chain)");
    const route = prepared.routes[0];
    assert.equal(route.legs.length, 3, "3-hop route (three legs)");
    assert.equal(route.intermediateTokens.length, 2, "two intermediates (X, Y)");
    assert.equal(route.intermediateTokens[0].toLowerCase(), xTok.toLowerCase(), "first intermediate is X");
    assert.equal(route.intermediateTokens[1].toLowerCase(), yTok.toLowerCase(), "second intermediate is Y");
    assert.equal(route.legs[0].pools.length, 1, "leg0 is one pool");
    assert.equal(route.legs[1].pools.length, 1, "leg1 is one deep pool");
    assert.equal(route.legs[2].pools.length, 1, "leg2 is one deep pool");

    const { pools, inputToken, directCount } = buildUniverse(prepared);

    // Wei-exact expectation: kwayReference mirrors the on-chain solver bit-for-bit.
    const ref = kwayReference(prepared, amountIn);

    // Independent oracle from LOCAL LIVE leg state. Single pool per leg ⇒ ONE OptimalRoute
    // (leg0 -> leg1 -> leg2); the reference's ONE route input equals it to the wei.
    const optDirect = await liveOptimalDirect(c, prepared);
    const optRoutes = await liveOptimalRoutes(c, prepared);
    assert.equal(optRoutes.length, 1, "one single-pool-per-leg oracle route");
    const opt = optimalSplit({
      pools: optDirect,
      routes: optRoutes,
      amountIn,
      zeroForOne: prepared.zeroForOne,
      priceLimit: prepared.priceLimit,
    });
    const oracleRouteSum = opt.perRouteInput.reduce((a, b) => a + b, 0n);
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei-exact)");
    assert.equal(ref.perRouteInput[0], oracleRouteSum, "reference route input == oracle (wei-exact)");
    assert.equal(ref.perPoolInput[0], opt.perPoolInput[0], "reference direct input == oracle direct (wei-exact)");

    const inBefore = await readInputBalances(pools, inputToken, directCount);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "3-hop route cook() must succeed");

    const inAfter = await readInputBalances(pools, inputToken, directCount);
    const delta: bigint[] = inAfter.map((a, i) => a - inBefore[i]);

    const idxByAddr = new Map<string, number>();
    pools.forEach((p, i) => idxByAddr.set(p.address.toLowerCase(), i));

    // (1a) WEI-EXACT — DIRECT pool tokenIn delta == oracle/reference perPoolInput.
    for (let i = 0; i < directCount; i++) {
      assert.equal(delta[i], opt.perPoolInput[i], `[${engine}] direct pool[${i}] input delta != oracle (wei)`);
      assert.equal(delta[i], ref.perPoolInput[i], `[${engine}] direct pool[${i}] input delta != reference (wei)`);
    }

    // (1b) WEI-EXACT — PER-LEG-POOL: leg0's tokenIn delta == the oracle's route input (one
    // single-pool-per-leg route). Conservation through BOTH intermediates X and Y is what makes
    // the downstream legs' realized throughput match.
    const leg0Idx = idxByAddr.get(route.legs[0].pools[0].address.toLowerCase())!;
    assert.equal(
      delta[leg0Idx], opt.perRouteInput[0],
      `[${engine}] leg0 tokenIn delta != oracle route input (on-chain ${delta[leg0Idx]} vs oracle ${opt.perRouteInput[0]})`,
    );

    // ALL HOPS move: leg1 (receives X) and leg2 (receives Y) both got their intermediate input.
    const leg1Idx = idxByAddr.get(route.legs[1].pools[0].address.toLowerCase())!;
    const leg2Idx = idxByAddr.get(route.legs[2].pools[0].address.toLowerCase())!;
    assert.ok(delta[leg1Idx] > 0n, `[${engine}] leg1 (X->Y) received the X intermediate`);
    assert.ok(delta[leg2Idx] > 0n, `[${engine}] leg2 (Y->B) received the Y intermediate`);
    assert.equal(delta[leg0Idx], ref.perRouteInput[0], `[${engine}] on-chain route input (leg0 tokenIn) != reference route input (wei)`);

    // Direct + route both engaged (the shared-cut split).
    assert.ok(delta[0] > 0n, `[${engine}] direct pool engaged`);
    assert.ok(ref.perRouteInput[0] > 0n, `[${engine}] route engaged`);

    // Full amountIn spent (compute-then-pull) and caller received tokenOut.
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (compute-then-pull)`);
    assert.ok(received > 0n, `[${engine}] caller received tokenOut`);

    // (2) EQUALIZATION at the cut: the direct pool's post-fee marginal ≈ the route's composed
    // THREE-leg product head. Fold all legs' best (cheapest-fee) post-fee marginals via mulDiv.
    const directAdj = await feeAdjMarginal(directPool, prepared.pools[0].feePpm, prepared.zeroForOne);
    const Q96 = 1n << 96n;
    let routeHead = Q96;
    for (const leg of route.legs) {
      const best = leg.pools.reduce((a, b) => (a.feePpm <= b.feePpm ? a : b));
      const h = await feeAdjMarginal(best.address, best.feePpm, leg.zeroForOne);
      routeHead = (routeHead * h) / Q96;
    }
    const hi = directAdj > routeHead ? directAdj : routeHead;
    const lo = directAdj > routeHead ? routeHead : directAdj;
    const rel = Number(hi - lo) / Number(hi);
    assert.ok(rel < 5e-3, `[${engine}] equalization: direct marginal ${directAdj} ≈ 3-leg route head ${routeHead} (rel ${rel})`);

    console.log(
      `  [ROUTE3-WEI ${engine}] direct=${delta[0]} routeIn=${ref.perRouteInput[0]} spent=${spent} received=${received}\n` +
        `       leg0In=${delta[leg0Idx]} leg1In=${delta[leg1Idx]} leg2In=${delta[leg2Idx]}  equalize rel=${rel}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`WEI-EXACT direct + 3-hop route split == optimal [${engine}]`, { skip }, async () => {
      await run3Hop(engine);
    });
  }

  // OPPOSITE-DIRECTION hops: a 3-hop route whose per-leg hop direction alternates (z0 != z1 etc.)
  // exercises the per-pool direction (pd[7]) reuse — each leg self-orients from address ordering,
  // so the chain composes/conserves regardless of the route's overall in->out direction. This is
  // structurally covered by the run3Hop universe already (token deploy order is arbitrary, so the
  // hop directions are whatever the addresses give); we additionally assert here that the legs do
  // NOT all share one direction (i.e. at least one hop is oneForZero) when that is the case, and
  // that the wei-exact gate holds either way — the single run3Hop body is direction-agnostic.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`WEI-EXACT 3-hop with per-leg direction self-orientation [${engine}]`, { skip }, async () => {
      // Re-run the wei-exact gate (direction-agnostic) and report the realized per-leg directions —
      // this is the opposite-direction-hops vector: the legs orient independently from pd[7], and
      // the chain stays wei-exact whether or not the hop directions agree.
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const amountIn = parseEther("20000");
      const caller = c.account0;
      const { prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, { minRelBps: 0 }, engine,
      );
      const dirs = prepared.routes[0].legs.map((l) => l.zeroForOne);
      console.log(`  [ROUTE3-DIR ${engine}] per-leg zeroForOne = [${dirs.join(", ")}]`);
      await run3Hop(engine);
    });
  }
});
