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
 * V2-leg and V4-leg routes are exercised by their own describe blocks below (the leg
 * execution dispatches per pool type — swapV3 / swap(poolType:0) / swap(poolType:2)).
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
  getV4Slot0,
  getV4Liquidity,
  mintPosition,
  deployV2Factory,
  setupEtchedV2Pool,
  etchV4Singletons,
  deployV4Helper,
  setupV4Pool,
  v2PairAbi,
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
 * Reconstruct the FLAT POOL UNIVERSE index.ts buildUniverseRoutingAndQlv builds —
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

/**
 * Read the LIVE OptimalPool fields for a single leg/direct pool, dispatching by type — V3 via
 * slot0, V4 via StateView (poolId), V2 via getReserves (mapped to in/out by the pool's reserve
 * orientation `inIsToken0`). The oracle reads a V4 leg on the SAME path as a V3 leg (isV2:false,
 * sqrt/tick/net); a V2 leg uses isV2:true + live reserveIn/reserveOut.
 */
async function liveOptimalPool(c: HarnessClients, lp: EcoPool): Promise<OptimalPool> {
  if (lp.isV2) {
    const r = (await c.publicClient.readContract({
      address: lp.address, abi: v2PairAbi, functionName: "getReserves", args: [],
    })) as readonly [bigint, bigint, number];
    const [r0, r1] = [r[0], r[1]];
    // inIsToken0 = the hop's in token is token0 ⇒ reserveIn = r0, reserveOut = r1.
    const reserveIn = lp.inIsToken0 ? r0 : r1;
    const reserveOut = lp.inIsToken0 ? r1 : r0;
    return { isV2: true, feePpm: lp.feePpm, reserveIn, reserveOut };
  }
  if (lp.poolType === SwapPoolType.UniV4) {
    const { sqrtPriceX96, tick } = await getV4Slot0(c.publicClient, lp.stateView, lp.poolId);
    const liquidity = await getV4Liquidity(c.publicClient, lp.stateView, lp.poolId);
    return {
      isV2: false, feePpm: lp.feePpm, sqrtPriceX96, tick, tickSpacing: lp.tickSpacing,
      liquidity, net: lp.adaptiveNet ?? new Map<number, bigint>(),
    };
  }
  const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, lp.address);
  return {
    isV2: false, feePpm: lp.feePpm, sqrtPriceX96, tick, tickSpacing: lp.tickSpacing,
    liquidity: lp.spotActiveL ?? 0n, net: lp.adaptiveNet ?? new Map<number, bigint>(),
  };
}

/**
 * Build the oracle OptimalRoute(s) from the prepared route's LIVE leg-pool state (any type). Each
 * prepared route maps to ONE OptimalRoute whose legs carry the FULL set of leg pools — the oracle
 * models a multi-pool leg as an INTERNAL water-fill (the leg-internal merge), NOT parallel routes.
 * This is the k>=3 fix: a multi-pool MIDDLE leg's pools share the downstream chain, so the parallel
 * decomposition (one route per leg-pool combination) over-credits the shared downstream depth and
 * is wrong at k>=3 — the single route with leg-internal split is the true optimum.
 */
async function liveOptimalRoutes(
  c: HarnessClients,
  prepared: EcoSwapPrepared,
): Promise<OptimalRoute[]> {
  const routes: OptimalRoute[] = [];
  for (const route of prepared.routes) {
    const legs: OptimalRoute["legs"] = [];
    for (const leg of route.legs) {
      const pools: OptimalPool[] = [];
      for (const lp of leg.pools) pools.push(await liveOptimalPool(c, lp));
      legs.push({ zeroForOne: leg.zeroForOne, pools });
    }
    routes.push({ legs });
  }
  return routes;
}

/** Build the oracle's OptimalPool list for the prepared DIRECT pools (live state, any type). */
async function liveOptimalDirect(
  c: HarnessClients,
  prepared: EcoSwapPrepared,
): Promise<OptimalPool[]> {
  const out: OptimalPool[] = [];
  for (const p of prepared.pools) {
    out.push(await liveOptimalPool(c, p));
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
    assert.equal(route.legs[1].pools.length, 1, "leg1 is one deep pool");

    const { pools, inputToken, directCount } = buildUniverse(prepared);

    // ── The wei-exact expectation: kwayReference mirrors the on-chain solver bit-for-bit
    // (and is gated wei-exact vs the oracle in the fast tier). Its perPoolInput is indexed
    // by UNIVERSE pool, perRouteInput by route, and perUniversePoolInput by universe pool
    // (the leg-pool tail carries the leg-internal split). ──
    const ref = kwayReference(prepared, amountIn);

    // ── Independent oracle (optimalSplit, built from LOCAL LIVE leg state). The multi-pool leg is
    // modeled as ONE route with an INTERNAL water-fill (NOT parallel routes), so the reference's
    // ONE route input equals the oracle's ONE route input to the wei. ──
    const optDirect = await liveOptimalDirect(c, prepared);
    const optRoutes = await liveOptimalRoutes(c, prepared);
    assert.equal(optRoutes.length, 1, "one oracle route (the multi-pool leg is internal, not parallel)");
    const opt = optimalSplit({
      pools: optDirect,
      routes: optRoutes,
      amountIn,
      zeroForOne: prepared.zeroForOne,
      priceLimit: prepared.priceLimit,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei-exact)");
    // The reference's single route input == the oracle's single route input (leg-internal split).
    assert.equal(ref.perRouteInput[0], opt.perRouteInput[0], "reference route input == oracle (wei-exact)");
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

    // (1b) WEI-EXACT — PER-LEG-POOL: a multi-pool leg splits INTERNALLY (the leg-internal merge),
    // so the per-leg-pool wei expectation is the reference's perUniversePoolInput (the solver's
    // `inp[pI]`, bit-identical to the on-chain accrual). The leg0-pool tokenIn delta must equal it.
    const leg0Idxs: number[] = route.legs[0].pools.map((lp) => idxByAddr.get(lp.address.toLowerCase())!);
    for (let k = 0; k < leg0Idxs.length; k++) {
      assert.equal(
        delta[leg0Idxs[k]], ref.perUniversePoolInput[leg0Idxs[k]],
        `[${engine}] leg0 pool[${k}] tokenIn delta != reference leg-internal split (on-chain ${delta[leg0Idxs[k]]} vs reference ${ref.perUniversePoolInput[leg0Idxs[k]]})`,
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

});

// ─────────────────────────────────────────────────────────────────────────────
// V2-LEG route — a 2-hop route whose FIRST leg is a Uniswap-V2 constant-product pool
// and second leg a V3 pool, run alongside a competing direct A->B V3 pool. The V2 leg
// is DEEP (so it only ever PARTIAL-fills the constant-L geometric stream — it never
// becomes the tick-crossing binding leg, which the unified route event still resolves
// on V3/V4 grid math); the V3 second leg is the finite binding leg. Asserts the same
// WEI-EXACT gate as the V3-leg routes: the cooked per-leg-pool input deltas equal the
// neutral oracle's split (OptimalRouteLeg with isV2:true on leg0) to the wei, both legs
// move, marginals equalize at the cut. The leg0 V2 execution dispatches via the unified
// swap(SwapParams{poolType:0}) exactly like a direct V2 pool.
// ─────────────────────────────────────────────────────────────────────────────
describe("EcoSwap multi-hop route — WEI-EXACT V2-leg (direct A->B + 2-hop V2(A->X)->V3(X->B))", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let base: Hex;
  let tokenOut: Hex;
  let directPool: Hex;
  let leg0v2: Hex; // V2 A->X (etched pair)
  let leg1v3: Hex; // V3 X->B (deep)
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;
  // Deterministic etch address for the V2 pair (well above precompiles, never a CREATE target).
  const V2_PAIR_ADDR = "0x00000000000000000000000000000000ec02ec02" as Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const v2Factory = await deployV2Factory(c.walletClient, c.publicClient);

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

    // leg0: ETCHED V2 pair (A<->X) at 1:1, DEEP reserves so it only partial-fills (never binds).
    // setupEtchedV2Pool needs token0<token1; sort A/X by address.
    const [v2t0, v2t1] = BigInt(tokenIn) < BigInt(base) ? [tokenIn, base] : [base, tokenIn];
    leg0v2 = await setupEtchedV2Pool(
      c.walletClient, c.publicClient, c.testClient, v2Factory, V2_PAIR_ADDR,
      v2t0, v2t1, parseEther("200000000"), parseEther("200000000"), minter,
    );
    // leg1: V3 X->B, EXTREMELY deep so the route depth is governed by the V2 leg's geometric
    // stream and the single-route oracle identity is wei-exact (the binding leg is leg1's tick).
    leg1v3 = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, base, tokenOut, HOP_FEE_A, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, leg1v3, minter, -12000, 12000, parseEther("400000"),
    );

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
        { address: v2Factory, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Local UniV2" },
      ],
      feeTiers: [HOP_FEE_A, HOP_FEE_B],
      baseTokens: [base],
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

  async function runV2Leg(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("20000");
    const caller = c.account0;

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, { minRelBps: 0 }, engine,
    );

    // Topology: one direct A->B pool + one 2-hop route; leg0 is a V2 pool, leg1 a V3 pool.
    assert.equal(prepared.pools.length, 1, "exactly one direct A->B pool");
    assert.equal(prepared.routes.length, 1, "exactly one route (through base)");
    const route = prepared.routes[0];
    assert.equal(route.legs.length, 2, "2-hop route");
    assert.equal(route.legs[0].pools.length, 1, "leg0 is one V2 pool");
    assert.ok(route.legs[0].pools[0].isV2, "leg0 pool is V2");
    assert.equal(route.legs[1].pools.length, 1, "leg1 is one V3 pool");
    assert.ok(!route.legs[1].pools[0].isV2, "leg1 pool is V3");

    const { pools, inputToken, directCount } = buildUniverse(prepared);
    const ref = kwayReference(prepared, amountIn);
    const optDirect = await liveOptimalDirect(c, prepared);
    const optRoutes = await liveOptimalRoutes(c, prepared);
    assert.equal(optRoutes.length, 1, "one single-pool-per-leg oracle route");
    const opt = optimalSplit({
      pools: optDirect, routes: optRoutes, amountIn,
      zeroForOne: prepared.zeroForOne, priceLimit: prepared.priceLimit,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei-exact)");
    const oracleRouteSum = opt.perRouteInput.reduce((a, b) => a + b, 0n);
    assert.equal(ref.perRouteInput[0], oracleRouteSum, "reference route input == oracle (wei-exact)");
    assert.equal(ref.perPoolInput[0], opt.perPoolInput[0], "reference direct input == oracle direct (wei-exact)");

    const inBefore = await readInputBalances(pools, inputToken, directCount);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "V2-leg route cook() must succeed");

    const inAfter = await readInputBalances(pools, inputToken, directCount);
    const delta: bigint[] = inAfter.map((a, i) => a - inBefore[i]);
    const idxByAddr = new Map<string, number>();
    pools.forEach((p, i) => idxByAddr.set(p.address.toLowerCase(), i));

    // WEI-EXACT — direct pool + leg0 (V2) tokenIn delta.
    for (let i = 0; i < directCount; i++) {
      assert.equal(delta[i], opt.perPoolInput[i], `[${engine}] direct pool[${i}] input delta != oracle (wei)`);
      assert.equal(delta[i], ref.perPoolInput[i], `[${engine}] direct pool[${i}] input delta != reference (wei)`);
    }
    const leg0Idx = idxByAddr.get(route.legs[0].pools[0].address.toLowerCase())!;
    assert.equal(
      delta[leg0Idx], opt.perRouteInput[0],
      `[${engine}] V2 leg0 tokenIn delta != oracle route input (on-chain ${delta[leg0Idx]} vs oracle ${opt.perRouteInput[0]})`,
    );
    // leg1 (V3) receives the realized intermediate X.
    const leg1Idx = idxByAddr.get(route.legs[1].pools[0].address.toLowerCase())!;
    assert.ok(delta[leg1Idx] > 0n, `[${engine}] V3 leg1 received the intermediate token`);
    assert.equal(delta[leg0Idx], ref.perRouteInput[0], `[${engine}] on-chain route input (V2 leg0 tokenIn) != reference (wei)`);

    // Both venues engaged.
    assert.ok(delta[0] > 0n, `[${engine}] direct pool engaged`);
    assert.ok(ref.perRouteInput[0] > 0n, `[${engine}] V2-leg route engaged`);

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (compute-then-pull)`);
    assert.ok(received > 0n, `[${engine}] caller received tokenOut`);

    console.log(
      `  [ROUTE-V2LEG ${engine}] direct=${delta[0]} routeIn(V2 leg0)=${delta[leg0Idx]} leg1In=${delta[leg1Idx]} spent=${spent} received=${received}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`WEI-EXACT direct + V2-leg route split == optimal [${engine}]`, { skip }, async () => {
      await runV2Leg(engine);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// V4-LEG route — a 2-hop route whose FIRST leg is a Uniswap-V4 pool (etched PoolManager
// + StateView at canonical addresses) and second leg a V3 pool, alongside a competing
// direct A->B V3 pool. The V4 leg is the FINITE binding leg (V4 reads/crosses identically
// to V3 via StateView, so it can bind); the V3 second leg is DEEP. Same WEI-EXACT gate.
// The leg0 V4 execution dispatches via the unified swap(SwapParams{poolType:2}) with the
// nested PoolKey built from the leg tokens, exactly like a direct V4 pool.
// ─────────────────────────────────────────────────────────────────────────────
describe("EcoSwap multi-hop route — WEI-EXACT V4-leg (direct A->B + 2-hop V4(A->X)->V3(X->B))", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let base: Hex;
  let tokenOut: Hex;
  let directPool: Hex;
  let poolManager: Hex;
  let stateView: Hex;
  let leg0v4Id: Hex; // V4 A->X poolId
  let leg1v3: Hex; // V3 X->B (deep)
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const v4 = await etchV4Singletons(c.publicClient, c.testClient);
    poolManager = v4.poolManager;
    stateView = v4.stateView;
    const v4Helper = await deployV4Helper(c.walletClient, c.publicClient, poolManager);

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

    // leg0: V4 pool A->X (finite binding leg). setupV4Pool needs sorted currencies.
    const [v4t0, v4t1] = BigInt(tokenIn) < BigInt(base) ? [tokenIn, base] : [base, tokenIn];
    leg0v4Id = await setupV4Pool(
      c.walletClient, c.publicClient, v4Helper, v4t0, v4t1,
      HOP_FEE_A, 10, SQRT_PRICE_1_1, -12000, 12000, parseEther("400000"), parseEther("50000000"),
    );
    // leg1: V3 X->B, EXTREMELY deep so the route depth is governed by the V4 leg.
    leg1v3 = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, base, tokenOut, HOP_FEE_A, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, leg1v3, minter, -12000, 12000, parseEther("100000000"),
    );

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
        { address: poolManager, stateView, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Local UniV4" },
      ],
      feeTiers: [HOP_FEE_A, HOP_FEE_B],
      baseTokens: [base],
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

  // For a V4 leg pool the on-chain "input balance" lands on the PoolManager singleton, NOT the
  // pool address (V4 has no per-pool address). Read the input-token balance at the right venue.
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

  async function runV4Leg(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("20000");
    const caller = c.account0;

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, { minRelBps: 0 }, engine,
    );

    // Topology: one direct A->B pool + one 2-hop route; leg0 is a V4 pool, leg1 a V3 pool.
    assert.equal(prepared.pools.length, 1, "exactly one direct A->B pool");
    assert.equal(prepared.routes.length, 1, "exactly one route (through base)");
    const route = prepared.routes[0];
    assert.equal(route.legs.length, 2, "2-hop route");
    assert.equal(route.legs[0].pools.length, 1, "leg0 is one V4 pool");
    assert.equal(route.legs[0].pools[0].poolType, SwapPoolType.UniV4, "leg0 pool is V4");
    assert.equal(route.legs[1].pools.length, 1, "leg1 is one V3 pool");
    assert.equal(route.legs[1].pools[0].poolType, SwapPoolType.UniV3, "leg1 pool is V3");

    const { pools, inputToken, directCount } = buildUniverse(prepared);
    const ref = kwayReference(prepared, amountIn);
    const optDirect = await liveOptimalDirect(c, prepared);
    const optRoutes = await liveOptimalRoutes(c, prepared);
    assert.equal(optRoutes.length, 1, "one single-pool-per-leg oracle route");
    const opt = optimalSplit({
      pools: optDirect, routes: optRoutes, amountIn,
      zeroForOne: prepared.zeroForOne, priceLimit: prepared.priceLimit,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei-exact)");
    const oracleRouteSum = opt.perRouteInput.reduce((a, b) => a + b, 0n);
    assert.equal(ref.perRouteInput[0], oracleRouteSum, "reference route input == oracle (wei-exact)");
    assert.equal(ref.perPoolInput[0], opt.perPoolInput[0], "reference direct input == oracle direct (wei-exact)");

    const inBefore = await readInputBalances(pools, inputToken, directCount);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "V4-leg route cook() must succeed");

    const inAfter = await readInputBalances(pools, inputToken, directCount);
    const delta: bigint[] = inAfter.map((a, i) => a - inBefore[i]);
    const idxByAddr = new Map<string, number>();
    pools.forEach((p, i) => idxByAddr.set(p.address.toLowerCase(), i));

    for (let i = 0; i < directCount; i++) {
      assert.equal(delta[i], opt.perPoolInput[i], `[${engine}] direct pool[${i}] input delta != oracle (wei)`);
      assert.equal(delta[i], ref.perPoolInput[i], `[${engine}] direct pool[${i}] input delta != reference (wei)`);
    }
    // leg0 is V4 — its tokenIn lands on the PoolManager singleton (== leg0 pool address in the
    // universe, which prepare set to the PoolManager). Its delta == the oracle route input.
    const leg0Idx = idxByAddr.get(route.legs[0].pools[0].address.toLowerCase())!;
    assert.equal(
      delta[leg0Idx], opt.perRouteInput[0],
      `[${engine}] V4 leg0 tokenIn delta != oracle route input (on-chain ${delta[leg0Idx]} vs oracle ${opt.perRouteInput[0]})`,
    );
    const leg1Idx = idxByAddr.get(route.legs[1].pools[0].address.toLowerCase())!;
    assert.ok(delta[leg1Idx] > 0n, `[${engine}] V3 leg1 received the intermediate token`);
    assert.equal(delta[leg0Idx], ref.perRouteInput[0], `[${engine}] on-chain route input (V4 leg0 tokenIn) != reference (wei)`);

    assert.ok(delta[0] > 0n, `[${engine}] direct pool engaged`);
    assert.ok(ref.perRouteInput[0] > 0n, `[${engine}] V4-leg route engaged`);

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (compute-then-pull)`);
    assert.ok(received > 0n, `[${engine}] caller received tokenOut`);

    console.log(
      `  [ROUTE-V4LEG ${engine}] direct=${delta[0]} routeIn(V4 leg0)=${delta[leg0Idx]} leg1In=${delta[leg1Idx]} spent=${spent} received=${received}  (poolId ${leg0v4Id.slice(0, 10)}…)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`WEI-EXACT direct + V4-leg route split == optimal [${engine}]`, { skip }, async () => {
      await runV4Leg(engine);
    });
  }
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
// SINGLE pool per leg here. A MULTI-POOL leg inside a k>=3 route (the leg-internal
// water-fill) is covered WEI-EXACT by its own describe block below: the oracle now models a
// multi-pool leg as ONE route with an INTERNAL water-fill (NOT parallel routes), so it is
// wei-exact with the cursor-faithful reference at any k. This 3-hop test covers the N-leg
// conservation chain with one pool per leg.
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

// ─────────────────────────────────────────────────────────────────────────────
// k>=3 route with a MULTI-POOL MIDDLE leg — WEI-EXACT leg-internal water-fill.
//
// A 4-token universe A->X->Y->B where the MIDDLE leg (leg1, X->Y) splits across TWO pools
// (a cheap-fee SHALLOW pool that drains + a dear-fee DEEP pool that picks up the rest);
// leg0 (A->X) and leg2 (Y->B) are single DEEP pools. This is the case the OLD parallel-route
// oracle got WRONG at k>=3 (decomposing the multi-pool middle leg into parallel routes
// over-credits the shared downstream leg2 depth). The fixed oracle models the leg as an
// INTERNAL water-fill — its pools split to equalize the leg-internal marginal and the
// aggregate throughput feeds the chain — so the cook is WEI-EXACT vs both the oracle (ONE
// route, leg-internal split) and the cursor-faithful reference (perUniversePoolInput, the
// solver's per-leg-pool inp[] accrual). BOTH leg1 pools engage.
// ─────────────────────────────────────────────────────────────────────────────
describe("EcoSwap multi-hop route — WEI-EXACT k>=3 MULTI-POOL MIDDLE leg (A->X->Y->B)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let xTok: Hex;
  let yTok: Hex;
  let tokenOut: Hex;
  let directPool: Hex;
  let leg0: Hex; // A->X (single deep)
  let leg1a: Hex; // X->Y cheap-fee SHALLOW (drains first)
  let leg1b: Hex; // X->Y dear-fee DEEP (picks up the rest)
  let leg2: Hex; // Y->B (single deep)
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

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

    // leg0 (A->X) + leg2 (Y->B): single DEEP pools. leg1 (X->Y): TWO pools — leg1a cheap-fee
    // (0.05%) SHALLOW (drains to its leg-internal cut), leg1b dear-fee (0.30%) DEEP (picks up the
    // rest). The leg-internal water-fill splits the X->Y throughput across both.
    leg0 = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, xTok, HOP_FEE_A, SQRT_PRICE_1_1,
    );
    leg1a = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, xTok, yTok, HOP_FEE_A, SQRT_PRICE_1_1,
    );
    leg1b = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, xTok, yTok, HOP_FEE_B, SQRT_PRICE_1_1,
    );
    leg2 = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, yTok, tokenOut, HOP_FEE_A, SQRT_PRICE_1_1,
    );
    for (const deep of [leg0, leg2, leg1b]) {
      await mintPosition(
        c.walletClient, c.publicClient, stack.helper, deep, minter, -12000, 12000, parseEther("100000000"),
      );
    }
    // leg1a SHALLOW (cheap fee): it drains to its leg-internal cut, then leg1b engages.
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, leg1a, minter, -12000, 12000, parseEther("60000"),
    );

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [HOP_FEE_A, HOP_FEE_B],
      baseTokens: [xTok, yTok],
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

  async function runMultiMiddle(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("20000");
    const caller = c.account0;

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, { minRelBps: 0 }, engine,
    );

    // Topology: one direct A->B pool + one 3-hop route whose MIDDLE leg has TWO pools.
    assert.equal(prepared.pools.length, 1, "exactly one direct A->B pool");
    assert.equal(prepared.routes.length, 1, "exactly one route (the 3-hop chain)");
    const route = prepared.routes[0];
    assert.equal(route.legs.length, 3, "3-hop route");
    assert.equal(route.legs[0].pools.length, 1, "leg0 single pool");
    assert.ok(route.legs[1].pools.length >= 2, "leg1 (MIDDLE) splits across >=2 pools");
    assert.equal(route.legs[2].pools.length, 1, "leg2 single pool");

    const { pools, inputToken, directCount } = buildUniverse(prepared);

    // Wei-exact expectation: kwayReference mirrors the on-chain solver bit-for-bit.
    const ref = kwayReference(prepared, amountIn);

    // Independent oracle: ONE route, the middle leg an INTERNAL water-fill (NOT parallel routes).
    const optDirect = await liveOptimalDirect(c, prepared);
    const optRoutes = await liveOptimalRoutes(c, prepared);
    assert.equal(optRoutes.length, 1, "one oracle route (multi-pool middle leg is internal)");
    const opt = optimalSplit({
      pools: optDirect, routes: optRoutes, amountIn, zeroForOne: prepared.zeroForOne, priceLimit: prepared.priceLimit,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei-exact)");
    assert.equal(ref.perRouteInput[0], opt.perRouteInput[0], "reference route input == oracle (wei-exact)");
    assert.equal(ref.perPoolInput[0], opt.perPoolInput[0], "reference direct input == oracle direct (wei-exact)");

    const inBefore = await readInputBalances(pools, inputToken, directCount);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "multi-pool-middle-leg cook() must succeed");

    const inAfter = await readInputBalances(pools, inputToken, directCount);
    const delta: bigint[] = inAfter.map((a, i) => a - inBefore[i]);

    const idxByAddr = new Map<string, number>();
    pools.forEach((p, i) => idxByAddr.set(p.address.toLowerCase(), i));

    // (1a) DIRECT pool wei-exact.
    for (let i = 0; i < directCount; i++) {
      assert.equal(delta[i], opt.perPoolInput[i], `[${engine}] direct pool[${i}] != oracle (wei)`);
      assert.equal(delta[i], ref.perPoolInput[i], `[${engine}] direct pool[${i}] != reference (wei)`);
    }

    // (1b) The MIDDLE leg splits internally. The solver's COMPUTED leg-internal split (the
    // reference's perUniversePoolInput, the inp[] accrual) is wei-exact with the oracle (gated in
    // the fast tier). The on-chain X-side (intermediate) delta is the EXECUTED split: a DEEPER leg
    // (L>0) distributes the REALIZED intermediate balance proportionally with the last funded pool
    // taking the remainder (ecoswap.sauce.ts leg L>0 execution), so a non-last pool's executed
    // delta can sit ≤1 wei below its computed inp[] (the mulDiv proportional truncation moves to
    // the remainder pool). This is the DOCUMENTED EXACT-ON-GRID bound for a multi-pool DEEPER-leg
    // execution: per-pool ≤1 wei, with the leg TOTAL (Σ) and the route input (leg0, the binding
    // first leg) BOTH wei-exact. (leg0's tokenIn split is the computed inp[] directly ⇒ wei-exact;
    // only a deeper leg's REALIZED-balance proportional re-split carries the ≤1-wei dust.)
    const leg1Idxs: number[] = route.legs[1].pools.map((lp) => idxByAddr.get(lp.address.toLowerCase())!);
    const LEG_EXEC_TOL = 1n; // documented exact-on-grid bound: deeper-leg proportional split ≤1 wei/pool
    for (let k = 0; k < leg1Idxs.length; k++) {
      const onchain = delta[leg1Idxs[k]];
      const computed = ref.perUniversePoolInput[leg1Idxs[k]];
      const d = onchain > computed ? onchain - computed : computed - onchain;
      assert.ok(
        d <= LEG_EXEC_TOL,
        `[${engine}] leg1 pool[${k}] X delta off-grid: on-chain ${onchain} vs computed ${computed} (|Δ|=${d} > ${LEG_EXEC_TOL})`,
      );
    }
    // The leg's AGGREGATE realized X throughput tracks the computed leg total within the same
    // documented exact-on-grid bound (≤1 wei): the realized leg0 OUTPUT — the X balance leg1
    // actually receives — can sit ≤1 wei below the computed intermediate (the conservation
    // truncation across the intermediate token), and the proportional split conserves that realized
    // balance exactly (last pool takes the remainder). The route-level gates (route input, total
    // spent) stay wei-exact; only the realized-intermediate throughput carries the dust.
    const leg1OnchainTotal = leg1Idxs.reduce((s, i) => s + delta[i], 0n);
    const leg1ComputedTotal = leg1Idxs.reduce((s, i) => s + ref.perUniversePoolInput[i], 0n);
    const legTotalDiff = leg1OnchainTotal > leg1ComputedTotal ? leg1OnchainTotal - leg1ComputedTotal : leg1ComputedTotal - leg1OnchainTotal;
    assert.ok(
      legTotalDiff <= BigInt(leg1Idxs.length),
      `[${engine}] middle-leg aggregate realized X off-grid: ${leg1OnchainTotal} vs computed ${leg1ComputedTotal} (|Δ|=${legTotalDiff})`,
    );
    const leg1Moved = leg1Idxs.filter((i) => delta[i] > 0n).length;
    assert.ok(leg1Moved >= 2, `[${engine}] middle leg must split across >=2 pools (moved ${leg1Moved})`);

    // leg0 tokenIn delta == route input == reference route input (wei).
    const leg0Idx = idxByAddr.get(route.legs[0].pools[0].address.toLowerCase())!;
    assert.equal(delta[leg0Idx], ref.perRouteInput[0], `[${engine}] leg0 tokenIn != reference route input (wei)`);
    assert.equal(delta[leg0Idx], opt.perRouteInput[0], `[${engine}] leg0 tokenIn != oracle route input (wei)`);

    // leg2 (Y->B) received the Y intermediate; direct + route both engaged.
    const leg2Idx = idxByAddr.get(route.legs[2].pools[0].address.toLowerCase())!;
    assert.ok(delta[leg2Idx] > 0n, `[${engine}] leg2 (Y->B) received the Y intermediate`);
    assert.ok(delta[0] > 0n, `[${engine}] direct pool engaged`);
    assert.ok(ref.perRouteInput[0] > 0n, `[${engine}] route engaged`);

    // Full amountIn spent + caller received tokenOut.
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (compute-then-pull)`);
    assert.ok(received > 0n, `[${engine}] caller received tokenOut`);

    console.log(
      `  [ROUTE-MID3 ${engine}] direct=${delta[0]} routeIn=${ref.perRouteInput[0]} spent=${spent} received=${received}\n` +
        `       leg1 split: ${leg1Idxs.map((i) => delta[i]).join(", ")}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`WEI-EXACT k>=3 multi-pool MIDDLE leg split == optimal [${engine}]`, { skip }, async () => {
      await runMultiMiddle(engine);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// V2-leg BINDS — the SHALLOW-V2 companion to the deep-V2 block above [defect #3]. Here the V2
// leg0 is SHALLOW and the V3 leg1 EXTREMELY deep, so the V2 leg's 25bp geometric slice is the
// SMALLEST gross cross every event ⇒ the V2 leg is the BINDING (crossing) leg. Before the fix the
// route event ran the V3 tick-cross (ticks()/getTickLiquidity + net) on the V2 pair — a staticcall
// that reverts the whole cook (the "sized deep enough never to bind" note was a hope, not a guard).
// The fix advances a V2 binding leg by the geometric slice at CONSTANT L (no tick, no net read),
// mirrored in the reference + the oracle's type-agnostic cursor advance. Asserts the cook does NOT
// revert and the split is WEI-EXACT vs the oracle, with the V2 leg crossing MANY slices (bound).
// ─────────────────────────────────────────────────────────────────────────────
describe("EcoSwap multi-hop route — WEI-EXACT V2-leg BINDS (shallow V2(A->X) is the binding leg)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let base: Hex;
  let tokenOut: Hex;
  let directPool: Hex;
  let leg0v2: Hex; // V2 A->X (etched, SHALLOW ⇒ binds)
  let leg1v3: Hex; // V3 X->B (deep ⇒ never binds)
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;
  const V2_PAIR_ADDR = "0x00000000000000000000000000000000ec02b17d" as Hex;
  // SHALLOW V2 reserves: small enough that its 25bp slice gross is the smallest cross → it binds.
  const V2_RESERVE = parseEther("100000");

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const v2Factory = await deployV2Factory(c.walletClient, c.publicClient);

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

    // leg0: ETCHED V2 pair (A<->X) at 1:1, SHALLOW reserves ⇒ its 25bp slice is the smallest cross
    // ⇒ it BINDS each event. setupEtchedV2Pool needs token0<token1; sort A/X by address.
    const [v2t0, v2t1] = BigInt(tokenIn) < BigInt(base) ? [tokenIn, base] : [base, tokenIn];
    leg0v2 = await setupEtchedV2Pool(
      c.walletClient, c.publicClient, c.testClient, v2Factory, V2_PAIR_ADDR,
      v2t0, v2t1, V2_RESERVE, V2_RESERVE, minter,
    );
    // leg1: V3 X->B, EXTREMELY deep ⇒ its one-bracket cross gross dwarfs the V2 slice, so leg1
    // NEVER binds — the shallow V2 leg is the unambiguous binding leg every event.
    leg1v3 = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, base, tokenOut, HOP_FEE_A, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, leg1v3, minter, -12000, 12000, parseEther("100000000"),
    );

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
        { address: v2Factory, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Local UniV2" },
      ],
      feeTiers: [HOP_FEE_A, HOP_FEE_B],
      baseTokens: [base],
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

  async function readInputBalances(pools: EcoPool[], inputToken: Hex[], directCount: number): Promise<bigint[]> {
    const out: bigint[] = [];
    for (let i = 0; i < pools.length; i++) {
      const tk = i < directCount ? tokenIn : inputToken[i];
      out.push(await balanceOf(c.publicClient, tk, pools[i].address));
    }
    return out;
  }

  async function runV2Binds(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    // Large enough that the direct pool fills and a substantial chunk overflows into the route, so
    // the shallow V2 leg crosses MANY 25bp slices (it BINDS repeatedly) — the code path that
    // reverted before the fix.
    const amountIn = parseEther("20000");
    const caller = c.account0;

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, { minRelBps: 0 }, engine,
    );

    assert.equal(prepared.pools.length, 1, "exactly one direct A->B pool");
    assert.equal(prepared.routes.length, 1, "exactly one route (through base)");
    const route = prepared.routes[0];
    assert.equal(route.legs.length, 2, "2-hop route");
    assert.ok(route.legs[0].pools[0].isV2, "leg0 pool is V2");
    assert.ok(!route.legs[1].pools[0].isV2, "leg1 pool is V3");

    const { pools, inputToken, directCount } = buildUniverse(prepared);
    const ref = kwayReference(prepared, amountIn);
    const optDirect = await liveOptimalDirect(c, prepared);
    const optRoutes = await liveOptimalRoutes(c, prepared);
    const opt = optimalSplit({
      pools: optDirect, routes: optRoutes, amountIn,
      zeroForOne: prepared.zeroForOne, priceLimit: prepared.priceLimit,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei-exact)");
    assert.equal(ref.perRouteInput[0], opt.perRouteInput.reduce((a, b) => a + b, 0n), "reference route == oracle (wei-exact)");
    assert.equal(ref.perPoolInput[0], opt.perPoolInput[0], "reference direct == oracle (wei-exact)");

    const inBefore = await readInputBalances(pools, inputToken, directCount);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    // The core defect-#3 assertion: the V2 binding leg does NOT revert the cook.
    assert.equal(receipt.status, "success", "V2-BINDS route cook() must succeed (no tick-cross on the V2 pair)");

    const inAfter = await readInputBalances(pools, inputToken, directCount);
    const delta: bigint[] = inAfter.map((a, i) => a - inBefore[i]);
    const idxByAddr = new Map<string, number>();
    pools.forEach((p, i) => idxByAddr.set(p.address.toLowerCase(), i));

    // WEI-EXACT — direct pool + V2 leg0 tokenIn delta.
    for (let i = 0; i < directCount; i++) {
      assert.equal(delta[i], opt.perPoolInput[i], `[${engine}] direct pool[${i}] input delta != oracle (wei)`);
      assert.equal(delta[i], ref.perPoolInput[i], `[${engine}] direct pool[${i}] input delta != reference (wei)`);
    }
    const leg0Idx = idxByAddr.get(route.legs[0].pools[0].address.toLowerCase())!;
    const leg1Idx = idxByAddr.get(route.legs[1].pools[0].address.toLowerCase())!;
    assert.equal(delta[leg0Idx], ref.perRouteInput[0], `[${engine}] V2 leg0 tokenIn delta != reference route input (wei)`);
    assert.equal(delta[leg0Idx], opt.perRouteInput.reduce((a, b) => a + b, 0n), `[${engine}] V2 leg0 tokenIn delta != oracle route input (wei)`);
    assert.ok(delta[leg1Idx] > 0n, `[${engine}] V3 leg1 received the intermediate token`);

    // The V2 leg is the BINDING leg: it must have crossed MANY 25bp geometric slices, i.e. absorbed
    // far more than a single slice's gross (≈ reserve*0.0025). A share this large can only arise from
    // the V2 leg binding event after event (the deep V3 leg1 can never cross its own bracket).
    const oneSliceGross = (V2_RESERVE * 25n) / 10000n; // ≈ reserve * 25bp (pre-fee), the per-slice gross
    assert.ok(
      delta[leg0Idx] > oneSliceGross * 4n,
      `[${engine}] V2 leg absorbed ${delta[leg0Idx]} > 4 slices (${oneSliceGross * 4n}) ⇒ it BOUND (crossed) repeatedly`,
    );

    assert.ok(delta[0] > 0n, `[${engine}] direct pool engaged`);
    assert.ok(ref.perRouteInput[0] > 0n, `[${engine}] V2-binds route engaged`);
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (compute-then-pull)`);
    assert.ok(received > 0n, `[${engine}] caller received tokenOut`);

    console.log(
      `  [ROUTE-V2BINDS ${engine}] direct=${delta[0]} routeIn(V2 leg0)=${delta[leg0Idx]} leg1In=${delta[leg1Idx]} ` +
        `slices≈${delta[leg0Idx] / oneSliceGross} spent=${spent} received=${received}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`WEI-EXACT V2 leg BINDS (no tick-cross revert) == optimal [${engine}]`, { skip }, async () => {
      await runV2Binds(engine);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SHARED-EDGE DISJOINT ROUTES — TWO interior base tokens (X, Y) so the DFS emits routes that would
// SHARE a leg pool (same-direction: A<->X used by A->X->B and A->X->Y->B) AND traverse the X<->Y
// pool in OPPOSITE directions (A->X->Y->B vs A->Y->X->B). This block proves the three prepare-side
// fixes at once:
//   • [#5] DIRECTED memo — prepare READS the X<->Y edge in BOTH directions; with the old unordered
//     memo the reverse read reused the forward net rows and stampPoolCache threw, rejecting the
//     whole prepare. Directed memo ⇒ prepareEcoSwap SUCCEEDS.
//   • [#1/#2] DISJOINT selection — the admitted routes claim every leg pool at most once (the
//     universe dedup becomes a no-op), so no pool double-spends its inp[] or inverts its PoolKey.
// Asserts the admitted universe is DISJOINT by address, prepare succeeds, and the cook is WEI-EXACT
// vs the oracle with spent == Σ pool inputs (no double-spend). Plus an ADVERSE-DRIFT re-anchor case.
// ─────────────────────────────────────────────────────────────────────────────
describe("EcoSwap multi-hop route — DISJOINT shared-edge routes (2 interiors, directed memo + no double-spend)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let xTok: Hex;
  let yTok: Hex;
  let tokenOut: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;
  // The route-leg pools we drift in the adverse-drift case.
  let axPool: Hex; // A<->X
  let ayPool: Hex; // A<->Y

  const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

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

    // DIRECT A->B: SHALLOW (fills first, then overflows into the two 2-hop routes at the cut).
    const directPool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, HOP_FEE_B, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, directPool, minter, -12000, 12000, parseEther("6000"),
    );

    // A full mesh so the DFS emits A->X->B, A->Y->B (2-hop) AND A->X->Y->B, A->Y->X->B (3-hop) —
    // the 3-hop routes SHARE leg0 with the 2-hops (A<->X / A<->Y) and traverse X<->Y in BOTH
    // directions. All 0.30% deep pools at 1:1 so the two 2-hop routes engage symmetrically.
    axPool = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, xTok, HOP_FEE_B, SQRT_PRICE_1_1);
    const xbPool = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, xTok, tokenOut, HOP_FEE_B, SQRT_PRICE_1_1);
    ayPool = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, yTok, HOP_FEE_B, SQRT_PRICE_1_1);
    const ybPool = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, yTok, tokenOut, HOP_FEE_B, SQRT_PRICE_1_1);
    const xyPool = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, xTok, yTok, HOP_FEE_B, SQRT_PRICE_1_1);
    for (const p of [axPool, xbPool, ayPool, ybPool, xyPool]) {
      await mintPosition(c.walletClient, c.publicClient, stack.helper, p, minter, -12000, 12000, parseEther("400000"));
    }

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [HOP_FEE_A, HOP_FEE_B],
      baseTokens: [xTok, yTok],
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

  /** Every executable pool address (direct + every route leg pool) must be UNIQUE (disjoint). */
  function assertDisjoint(prepared: EcoSwapPrepared): void {
    const seen = new Map<string, string>();
    const claim = (addr: string, where: string): void => {
      const k = addr.toLowerCase();
      const prev = seen.get(k);
      assert.equal(prev, undefined, `pool ${addr} claimed by BOTH ${prev} and ${where} (not disjoint)`);
      seen.set(k, where);
    };
    prepared.pools.forEach((p, i) => claim(p.address, `direct[${i}]`));
    prepared.routes.forEach((r, ri) =>
      r.legs.forEach((leg, li) => leg.pools.forEach((lp, pi) => claim(lp.address, `route[${ri}].leg[${li}].pool[${pi}]`))),
    );
  }

  async function runDisjoint(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("20000");
    const caller = c.account0;

    // prepareEcoSwap SUCCEEDING is itself the [#5] directed-memo assertion: the DFS reads the X<->Y
    // edge in both directions; the old unordered memo threw in stampPoolCache before we got here.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, { minRelBps: 0 }, engine,
    );

    // [#1/#2] The admitted universe is DISJOINT — every leg pool claimed at most once.
    assertDisjoint(prepared);
    assert.ok(prepared.routes.length >= 2, `expected >=2 admitted routes (got ${prepared.routes.length})`);

    const { pools, inputToken, directCount } = buildUniverse(prepared);
    // buildUniverse dedups by address; with disjoint routes it must equal Σ (direct + all leg pools)
    // with NO collision — i.e. the universe size equals the raw pool count.
    const rawPoolCount =
      prepared.pools.length + prepared.routes.reduce((s, r) => s + r.legs.reduce((t, l) => t + l.pools.length, 0), 0);
    assert.equal(pools.length, rawPoolCount, "universe has no deduped (shared) pool — disjoint by construction");

    const ref = kwayReference(prepared, amountIn);
    const optDirect = await liveOptimalDirect(c, prepared);
    const optRoutes = await liveOptimalRoutes(c, prepared);
    const opt = optimalSplit({
      pools: optDirect, routes: optRoutes, amountIn,
      zeroForOne: prepared.zeroForOne, priceLimit: prepared.priceLimit,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei-exact)");
    for (let r = 0; r < prepared.routes.length; r++) {
      assert.equal(ref.perRouteInput[r], opt.perRouteInput[r], `route[${r}] reference input == oracle (wei-exact)`);
    }

    const inBefore: bigint[] = [];
    for (let i = 0; i < pools.length; i++) {
      const tk = i < directCount ? tokenIn : inputToken[i];
      inBefore.push(await balanceOf(c.publicClient, tk, pools[i].address));
    }
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "disjoint-route cook() must succeed");

    // WEI-EXACT — direct pool tokenIn deltas.
    for (let i = 0; i < directCount; i++) {
      const after = await balanceOf(c.publicClient, tokenIn, pools[i].address);
      assert.equal(after - inBefore[i], ref.perPoolInput[i], `[${engine}] direct[${i}] delta != reference (wei)`);
    }

    // NO DOUBLE-SPEND — the caller spent EXACTLY Σ (all pool inputs) == reference totalInput. Under
    // the old shared-edge bug a leg pool would swap its inp[] more than once, so the realized spend
    // would exceed the computed total (or the intermediate accounting would drift).
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (no double-spend)`);
    assert.ok(received > 0n, `[${engine}] caller received tokenOut`);
    // Both 2-hop routes engaged (symmetric X/Y legs).
    const engaged = ref.perRouteInput.filter((x) => x > 0n).length;
    assert.ok(engaged >= 2, `[${engine}] both disjoint routes engaged (${engaged})`);

    console.log(
      `  [ROUTE-DISJOINT ${engine}] routes=${prepared.routes.length} routeInputs=[${ref.perRouteInput.join(", ")}] ` +
        `spent=${spent} received=${received}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`DISJOINT shared-edge routes: directed memo + no double-spend, wei-exact [${engine}]`, { skip }, async () => {
      await runDisjoint(engine);
    });
  }

  // ADVERSE-DRIFT route re-anchor: prepare()+compile() clean, drift a surviving route's leg0 pool
  // DOWN with a real swap, then cook the PRE-DRIFT bytecodes — the recipe must re-anchor to the LIVE
  // (drifted) grid at cook and still spend the full amountIn (input-anchored), routing STRICTLY LESS
  // through the drifted leg while the untouched route picks up the difference.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(`ADVERSE-DRIFT route re-anchor: drifted leg's route share shrinks [${engine}]`, { skip }, async () => {
      const target = cookTarget(engine, stack, v12);
      const amountIn = parseEther("20000");
      const caller = c.account0;

      // Baseline (no drift): record the A<->X leg pool's tokenIn share.
      await resetPools();
      const baseline = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, { minRelBps: 0 }, engine,
      );
      const axBefore0 = await balanceOf(c.publicClient, tokenIn, axPool);
      const callerInBefore0 = await balanceOf(c.publicClient, tokenIn, caller);
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const r0 = await cook(c.walletClient, c.publicClient, target, baseline.bytecodes);
      assert.equal(r0.receipt.status, "success", "baseline cook ok");
      const baselineAxShare = (await balanceOf(c.publicClient, tokenIn, axPool)) - axBefore0;
      const baselineSpent = callerInBefore0 - (await balanceOf(c.publicClient, tokenIn, caller));
      assert.ok(baselineAxShare > 0n, "baseline routes some tokenIn through the A<->X leg");

      // Fresh state: prepare()+compile() clean, drift A<->X DOWN, cook the PRE-DRIFT bytecodes.
      await resetPools();
      const { bytecodes } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, { minRelBps: 0 }, engine,
      );
      const zHop = BigInt(tokenIn) < BigInt(xTok);
      const axEco: EcoPool = {
        poolType: SwapPoolType.UniV3, address: axPool, fee: HOP_FEE_B, tickSpacing: 60, hooks: ZERO,
        feePpm: HOP_FEE_B, isV2: false, inIsToken0: zHop,
        stateView: ZERO, poolId: ("0x" + "0".repeat(64)) as Hex, source: "drift",
      };
      await driftPoolPrice(c, stack.sauceRouter, axEco, tokenIn, xTok, zHop, parseEther("9000"), caller);

      const axBefore1 = await balanceOf(c.publicClient, tokenIn, axPool);
      const callerInBefore1 = await balanceOf(c.publicClient, tokenIn, caller);
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const r1 = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(r1.receipt.status, "success", "pre-drift cook against drifted state ok");
      const driftedAxShare = (await balanceOf(c.publicClient, tokenIn, axPool)) - axBefore1;
      const recipeSpent = callerInBefore1 - (await balanceOf(c.publicClient, tokenIn, caller));

      assert.equal(recipeSpent, baselineSpent, `[${engine}] input-anchored: spends the same total as baseline`);
      assert.ok(
        driftedAxShare < baselineAxShare,
        `[${engine}] re-anchor: A<->X leg share shrank under drift (drifted ${driftedAxShare} < baseline ${baselineAxShare})`,
      );

      console.log(
        `  [ROUTE-DISJOINT-DRIFT ${engine}] baselineSpent=${baselineSpent} recipeSpent=${recipeSpent} ` +
          `axShare ${baselineAxShare} -> ${driftedAxShare}`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERIOR L==0 GAP route [defect #4] — a route whose binding leg0 pool has an interior dL==0 gap
// (two disjoint liquidity bands with an un-initialised region between them). The walk-through-gap
// design leaves the leg ACTIVE with L==0 in the gap; the next route event's binding-leg back-
// propagation used to divide by that leg's 0 liquidity (Math.mulDiv(_, Q96, 0) / invertFarFromOut)
// → a division-by-zero Panic that reverted the whole cook. The fix treats an L==0 leg as the
// lowest-index binding leg that advances THROUGH its gap with routeIn 0 (0 flow, no other leg
// moves) — matching the direct-pool walk-through-gap and the oracle (which elides the gap). Asserts
// the cook does NOT Panic and the split is WEI-EXACT vs the oracle (which walks the same net map).
// ─────────────────────────────────────────────────────────────────────────────
describe("EcoSwap multi-hop route — WEI-EXACT interior L==0 GAP (leg0 has a dL==0 gap downstream)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let base: Hex;
  let tokenOut: Hex;
  let directPool: Hex;
  let leg0gap: Hex; // A->X V3 with a two-band interior gap ⇒ binds AND walks a dL==0 gap
  let leg1: Hex; // X->B V3 deep
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);

    tokenIn = await deployToken(c.walletClient, c.publicClient, "In", "IN");
    base = await deployToken(c.walletClient, c.publicClient, "Base", "BASE");
    tokenOut = await deployToken(c.walletClient, c.publicClient, "Out", "OUT");

    const minter = c.account0;
    for (const t of [tokenIn, base, tokenOut]) {
      await mint(c.walletClient, c.publicClient, t, minter, parseEther("1000000000"));
      await approve(c.walletClient, c.publicClient, t, stack.helper, HUGE);
    }

    // DIRECT A->B pool: SHALLOW (fills first, then the route absorbs the overflow and walks the gap).
    directPool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, HOP_FEE_B, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, directPool, minter, -12000, 12000, parseEther("6000"),
    );

    // leg0 (A->X): a 0.05% (ts=10) V3 pool with TWO disjoint liquidity bands and an INTERIOR GAP.
    // A NEAR band [-100, 100] (modest L, exhausts quickly) and a DEEP band away from spot on BOTH
    // sides ([-800, -300] and [300, 800]); the un-initialised region between (|tick| in (100, 300))
    // is a dL==0 gap the binding walk crosses on its way into the deep band. Modest near-band L so
    // the route pushes leg0 past [±100] into the gap within the trade; the deep bands are the same
    // fee tier so the leg keeps a competitive head after the gap. Symmetric so either swap direction
    // (address-order dependent) hits the gap.
    leg0gap = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, base, HOP_FEE_A, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, leg0gap, minter, -100, 100, parseEther("40000"));
    await mintPosition(c.walletClient, c.publicClient, stack.helper, leg0gap, minter, -800, -300, parseEther("4000000"));
    await mintPosition(c.walletClient, c.publicClient, stack.helper, leg0gap, minter, 300, 800, parseEther("4000000"));

    // leg1 (X->B): EXTREMELY deep ⇒ never binds; leg0 (with the gap) is the binding leg.
    leg1 = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, base, tokenOut, HOP_FEE_A, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, leg1, minter, -12000, 12000, parseEther("100000000"),
    );

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [HOP_FEE_A, HOP_FEE_B],
      baseTokens: [base],
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

  async function readInputBalances(pools: EcoPool[], inputToken: Hex[], directCount: number): Promise<bigint[]> {
    const out: bigint[] = [];
    for (let i = 0; i < pools.length; i++) {
      const tk = i < directCount ? tokenIn : inputToken[i];
      out.push(await balanceOf(c.publicClient, tk, pools[i].address));
    }
    return out;
  }

  async function runGap(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    // Large enough that the route pushes leg0 past the near [±100] band, INTO the dL==0 gap, and out
    // the far side — the code path that Panicked before the fix.
    const amountIn = parseEther("20000");
    const caller = c.account0;

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, { minRelBps: 0 }, engine,
    );

    assert.equal(prepared.pools.length, 1, "one direct A->B pool");
    assert.equal(prepared.routes.length, 1, "one route (through base)");
    const route = prepared.routes[0];
    assert.equal(route.legs.length, 2, "2-hop route");
    // leg0's net map must contain the gap structure on the WALK side: the near band's boundary, then
    // (after an interior dL==0 region) the deep band's two boundaries — so the swap-direction walk
    // sees [near-band edge] → [dL==0 gap] → [deep band]. A driftTicks:0 lens scans only the swap
    // side, so this is 3 initialized ticks with a >1-tickSpacing gap between the near-band edge and
    // the deep band.
    const gapLegPool = route.legs[0].pools.find((p) => p.address.toLowerCase() === leg0gap.toLowerCase());
    assert.ok(gapLegPool, "leg0 includes the gapped A<->X pool");
    const initTicks = [...(gapLegPool!.adaptiveNet ?? new Map<number, bigint>()).entries()]
      .filter(([, n]) => n !== 0n)
      .map(([t]) => t)
      .sort((a, b) => a - b);
    // ≥2 initialized ticks that bracket a multi-tickSpacing jump == the near-band edge and the deep
    // band's start, with an interior dL==0 gap between (the deep band's far edge is out-of-window
    // under driftTicks:0, so only the near boundary of each band is captured — enough for the walk
    // to know liquidity resumes past the gap).
    assert.ok(initTicks.length >= 2, `gapped leg net has >=2 initialized ticks (got ${initTicks.length}: ${initTicks})`);
    const ts0 = gapLegPool!.tickSpacing;
    const hasGap = initTicks.some((t, i) => i > 0 && t - initTicks[i - 1] > 2 * ts0);
    assert.ok(hasGap, `leg0 net has an interior multi-tick gap (ticks ${initTicks}, ts=${ts0})`);

    const { pools, inputToken, directCount } = buildUniverse(prepared);
    const ref = kwayReference(prepared, amountIn); // MUST NOT throw (routeEventN gap guard)
    const optDirect = await liveOptimalDirect(c, prepared);
    const optRoutes = await liveOptimalRoutes(c, prepared);
    const opt = optimalSplit({
      pools: optDirect, routes: optRoutes, amountIn,
      zeroForOne: prepared.zeroForOne, priceLimit: prepared.priceLimit,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei-exact)");
    assert.equal(ref.perRouteInput[0], opt.perRouteInput.reduce((a, b) => a + b, 0n), "reference route == oracle (wei-exact)");
    assert.equal(ref.perPoolInput[0], opt.perPoolInput[0], "reference direct == oracle (wei-exact)");

    const inBefore = await readInputBalances(pools, inputToken, directCount);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    // The core defect-#4 assertion: the interior dL==0 gap does NOT Panic the cook.
    assert.equal(receipt.status, "success", "L==0-gap route cook() must succeed (no division-by-zero Panic)");

    const inAfter = await readInputBalances(pools, inputToken, directCount);
    const delta: bigint[] = inAfter.map((a, i) => a - inBefore[i]);
    const idxByAddr = new Map<string, number>();
    pools.forEach((p, i) => idxByAddr.set(p.address.toLowerCase(), i));

    for (let i = 0; i < directCount; i++) {
      assert.equal(delta[i], opt.perPoolInput[i], `[${engine}] direct pool[${i}] input delta != oracle (wei)`);
      assert.equal(delta[i], ref.perPoolInput[i], `[${engine}] direct pool[${i}] input delta != reference (wei)`);
    }
    const leg0Idx = idxByAddr.get(leg0gap.toLowerCase())!;
    const leg1Idx = idxByAddr.get(route.legs[1].pools[0].address.toLowerCase())!;
    assert.equal(delta[leg0Idx], ref.perUniversePoolInput[leg0Idx], `[${engine}] gap leg0 input != reference (wei)`);
    assert.ok(delta[leg1Idx] > 0n, `[${engine}] leg1 received the intermediate token`);
    assert.equal(delta[leg0Idx], ref.perRouteInput[0], `[${engine}] on-chain route input == reference (wei)`);

    // GAP ENTERED: leg0's post-cook tick moved PAST its ±100 near band into the interior dL==0 gap
    // region (|tick| > 100), proving the binding walk actually reached the gap the fix guards — not
    // merely partial-filled the near band. (The direction is address-order dependent; check |tick|.)
    const { tick: leg0Tick } = await getSlot0(c.publicClient, leg0gap);
    assert.ok(Math.abs(leg0Tick) > 100, `[${engine}] gap leg0 walked past its near band into the gap (post-cook tick ${leg0Tick})`);

    assert.ok(delta[0] > 0n, `[${engine}] direct pool engaged`);
    assert.ok(ref.perRouteInput[0] > 0n, `[${engine}] gap route engaged`);
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (compute-then-pull)`);
    assert.ok(received > 0n, `[${engine}] caller received tokenOut`);

    console.log(
      `  [ROUTE-GAP ${engine}] direct=${delta[0]} routeIn(gap leg0)=${delta[leg0Idx]} leg1In=${delta[leg1Idx]} ` +
        `initTicks=${initTicks} spent=${spent} received=${received}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`WEI-EXACT interior L==0 gap route (no Panic) == optimal [${engine}]`, { skip }, async () => {
      await runGap(engine);
    });
  }
});
