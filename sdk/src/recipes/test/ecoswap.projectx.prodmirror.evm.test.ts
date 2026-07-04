/**
 * EcoSwap Project X (HyperEVM) PROD-MIRROR local EVM test — NO fork, NO live RPC.
 *
 * Sibling of ecoswap.prodmirror.evm.test.ts (the Uniswap-V3 prod-mirror). Project X
 * is a FEE-KEYED Uniswap V3 fork whose factory enables NON-STANDARD tiers on top of
 * the canonical set (200→4, 400→8, 1000→20 — the TICK_SPACING_BY_FEE rows added with
 * the venue), so this file reproduces TWO real WHYPE/USDT0 Project X pools on one
 * fresh anvil and exercises the odd-tier machinery end-to-end:
 *
 *   - hyperevm-projectx-WHYPEUSD0-500.json — the DEEPEST WHYPE/USDT0 tier
 *     (fee=500, ts=10; L ≈ 5.7e17), and
 *   - hyperevm-projectx-WHYPEUSD0-400.json — the NON-STANDARD tier (fee=400,
 *     ts=8; the tier the default [100,500,3000,10000] menu would MISS, and whose
 *     tickSpacing the TICK_SPACING_BY_FEE fallback of 60 would mis-stride).
 *
 * WHY THE V3 HARNESS APPLIES UNCHANGED: Project X pools expose the standard
 * 7-field slot0 + ticks/liquidity/tickSpacing/fee surface and swap() re-enters via
 * the EXACT `uniswapV3SwapCallback` selector (verified on-chain — see the venue
 * entry in shared/constants.ts), authenticated by the engine's transient
 * expectedPool, not a factory check. So the captured `ProdPoolSnapshot`s replay
 * through reproduce-pool.ts / verifyReproduction with NO change; the local factory
 * gets the odd tier via its own production mechanism (enableFeeAmount(400, 8) —
 * the same getter/mapping shape the real Project X factory serves).
 *
 * RECONSTRUCTION FIDELITY: both snapshots are COMPLETE bitmap-driven profiles
 * (every initialized tick over the full range, block-pinned; Σnet invariants
 * verified at capture), so the baseline+increment reconstruction is exact at
 * EVERY boundary — no window-truncation artifacts (baseline == 0). The live
 * WHYPE/USDT0 pools carry one-sided range-order ladders whose windowed profile
 * dips below the window's left edge (un-mintable by the slab scheme) — the
 * complete capture is what makes them reproducible at all. See
 * harness/projectx-snapshot.ts.
 *
 * WHAT IS PINNED HERE
 *   1. reproduction fidelity (sqrt EXACT, every boundary net EXACT, both pools) +
 *      the non-standard tier registered on the factory (feeAmountTickSpacing(400)=8)
 *      + the shared TICK_SPACING_BY_FEE rows the walk stride depends on;
 *   2. the production relative-depth filter judges the thin 400 pool per-trade
 *      (default floor drops it; minRelBps=0 keeps it);
 *   3. discovery through the config-injected FULL Project X tier menu finds BOTH
 *      pools; ONE EcoSwap splits across them; every per-pool fill is WEI-EXACT vs
 *      the neutral oracle (the oracle walks the 400 pool on its 8-tick stride —
 *      a 60-stride regression would diverge and fail the exactness gate);
 *   4. a cook through ONLY the non-standard tier (stride-8 frontier walk through
 *      interior dL==0 gaps), wei-exact;
 *   5. an adverse-drift re-anchor case on the deep pool (real swap between
 *      prepare and cook; pre-drift bytecodes must re-read live slot0).
 *
 * Offline by design: it loads the CHECKED-IN captured snapshots. Recapture with:
 *   npx tsx src/recipes/test/harness/projectx-snapshot.ts        # deepest tier
 *   npx tsx src/recipes/test/harness/projectx-snapshot.ts 400    # non-standard tier
 * (HYPEREVM_RPC_URL optional; defaults to the public HyperEVM endpoint.)
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.projectx.prodmirror.evm.test.ts
 * Engines: default v12; ECO_ENGINE=v1 for the v1 cell (each engine keeps its own
 * anvil-state blob under fixtures/anvil-state/projectx-prodmirror-<engine>).
 * Recapture blobs after engine/reconstruction changes: RECAPTURE_ANVIL_STATE=1.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, type Hex, type Account, type Abi } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  mint,
  approve,
  balanceOf,
  getSlot0,
  v3FactoryAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  type Engine,
  selectedEngines,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import {
  reproducePool,
  verifyReproduction,
  type ReproducedPool,
} from "./harness/reproduce-pool";
import { withCachedState } from "./harness/state-cache";
import type { ProdPoolSnapshot } from "./harness/prod-snapshot";
import {
  SwapPoolType,
  FactoryType,
  feeToTickSpacing,
  type ChainPoolConfig,
} from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { driftPoolPrice } from "./harness/drift";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "fixtures", "snapshots");
// Captured by harness/projectx-snapshot.ts (COMPLETE bitmap-driven profiles).
const SNAPSHOT_DEEP = "hyperevm-projectx-WHYPEUSD0-500.json"; // deepest tier, ts=10
const SNAPSHOT_ODD = "hyperevm-projectx-WHYPEUSD0-400.json"; // non-standard tier, ts=8

/**
 * The full Project X tier menu (mirrors the production FactoryConfig.feeTiers for
 * the venue). Locally only the two reproduced tiers resolve to pools — the point
 * is that discovery PROBES the odd tiers at all (the default menu would skip 400).
 */
const PROJECTX_FEE_TIERS = [100, 200, 400, 500, 1000, 3000, 10000];

const HUGE = parseEther("1000000000");

// Uniswap-V3 canonical MIN_TICK (the zeroForOne price-limit floor). A swap that
// terminates HERE has drained past all reconstructed liquidity — NOT landed at a
// genuine interior cut. Both cook tests assert the walk stays interior.
const MIN_TICK = -887272;

// ── Reconstructed-pool budgets (from the captured COMPLETE profiles) ─────────
// Deep fee=500 pool: L ≈ 5.7e17 at spot tick −233555; ~1000 WHYPE moves it ≈295
// ticks (≈29 tickSpacings) — well inside the ~96-spacing per-pool walk budget and
// far above the pool's deep ladder, so every cut below is a genuine interior cut.
// Thin fee=400 pool: L ≈ 1.17e14 at spot tick −233697; its active band's nearest
// initialized boundary sits 127 spacings DOWN at −234712 (in-band capacity ≈0.72
// WHYPE; the 96-spacing budget absorbs ≈0.54 WHYPE). The fee-adjusted spot gap to
// the deep pool is ≈141 ticks, so a ≈295-tick deep-pool cut pulls the thin pool in
// for its (tiny) genuine share.

// Per-pool net-cache measure (mirrors the V3 prod-mirror): a scanned WINDOW
// (windowTopShifted > 0) is a populated per-pool cache, independent of how many
// initialized ticks fell inside it. Defined locally (not shared) to avoid races.
function cacheWindowedPools(
  pools: { isV2?: boolean; windowTopShifted?: bigint }[],
): number {
  return pools.filter((p) => !p.isV2 && (p.windowTopShifted ?? 0n) > 0n).length;
}

// Single engine per (heavy) file: the one selected engine (default v12;
// ECO_ENGINE=v1 forces v1). See harness/engine.ts.
const PROD_ENGINE: Engine = selectedEngines()[0];

function loadSnapshot(file: string): ProdPoolSnapshot {
  return JSON.parse(readFileSync(join(SNAPSHOT_DIR, file), "utf-8")) as ProdPoolSnapshot;
}

/** Manifest the cache stores/rehydrates: everything the test needs post-loadState. */
interface ProjectXManifest {
  stack: DeployedStack;
  v12: DeployedV12Stack | null;
  /** Deepest tier (fee=500, ts=10). */
  reproDeep: ReproducedPool;
  /** Non-standard tier (fee=400, ts=8) — SAME local token pair as reproDeep. */
  reproOdd: ReproducedPool;
}

describe("EcoSwap Project X prod-mirror (reproduced real HyperEVM CL tick state, non-standard tiers)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let snapDeep: ProdPoolSnapshot;
  let snapOdd: ProdPoolSnapshot;
  let reproDeep: ReproducedPool;
  let reproOdd: ReproducedPool;
  let cleanSnapshot: Hex; // pristine reconstructed state (re-taken after each revert)

  before(async () => {
    snapDeep = loadSnapshot(SNAPSHOT_DEEP);
    snapOdd = loadSnapshot(SNAPSHOT_ODD);
    console.log(
      `  [projectx-prod-mirror] using REAL snapshots:\n` +
        `    deep ${SNAPSHOT_DEEP} (fee=${snapDeep.fee} ts=${snapDeep.tickSpacing} tick=${snapDeep.tick}, ${snapDeep.ticks.length} boundaries)\n` +
        `    odd  ${SNAPSHOT_ODD} (fee=${snapOdd.fee} ts=${snapOdd.tickSpacing} tick=${snapOdd.tick}, ${snapOdd.ticks.length} boundaries)`,
    );
    assert.equal(snapDeep.fee, 500, "deep snapshot is the fee=500 tier");
    assert.equal(snapOdd.fee, 400, "odd snapshot is the non-standard fee=400 tier");

    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);

    // Full deploy + BOTH reconstructions, cached once per engine
    // (fixtures/anvil-state/projectx-prodmirror-<engine>) so later runs loadState
    // in seconds. Recapture: RECAPTURE_ANVIL_STATE=1. See harness/state-cache.ts.
    const { manifest, fromCache } = await withCachedState<ProjectXManifest>({
      name: "projectx-prodmirror",
      engine: PROD_ENGINE,
      c,
      build: async () => {
        await ensureMulticall3(c.publicClient, c.testClient);
        const s = await deployStack(c.walletClient, c.publicClient);
        // Deep pool first (deploys the shared local token pair). reproducePool
        // enables the snapshot's fee tier on the factory when it isn't a default —
        // for the odd pool that is enableFeeAmount(400, 8), the same fee-keyed
        // mechanism the real Project X factory serves.
        const rDeep = await reproducePool(c.walletClient, c.publicClient, s.factory, s.helper, snapDeep, HUGE);
        const rOdd = await reproducePool(
          c.walletClient, c.publicClient, s.factory, s.helper, snapOdd, HUGE,
          undefined,
          { token0: rDeep.token0, token1: rDeep.token1 },
        );
        const v = await maybeDeployV12Stack(c, c.walletClient.account as Account);
        if (v) await approve(c.walletClient, c.publicClient, rDeep.token0, v.pot, HUGE);
        return { stack: s, v12: v, reproDeep: rDeep, reproOdd: rOdd };
      },
    });
    console.log(
      `  [projectx-prod-mirror] state ${fromCache ? "LOADED from cache" : "RECONSTRUCTED + cached"} (engine ${PROD_ENGINE})`,
    );
    stack = manifest.stack;
    v12 = manifest.v12;
    reproDeep = manifest.reproDeep;
    reproOdd = manifest.reproOdd;

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  /** Revert to the pristine reconstructed state and re-arm the snapshot id. */
  async function resetToClean(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
  }

  /**
   * poolConfig pointing discovery + the lens at the LOCAL factory with the given
   * fee-tier menu (fee-keyed V3Standard — the production Project X path).
   * baseTokens = the swap pair so the multi-hop route loop yields zero routes.
   */
  function projectXPoolConfig(tokenIn: Hex, tokenOut: Hex, feeTiers: number[]): ChainPoolConfig {
    return {
      factories: [
        {
          address: stack.factory,
          poolType: SwapPoolType.UniV3,
          factoryType: FactoryType.V3Standard,
          label: "Local Project X CL (prod-mirror)",
          feeTiers,
        },
      ],
      feeTiers,
      baseTokens: [tokenIn, tokenOut],
    };
  }

  it("reproduces BOTH snapshots' on-chain tick state exactly (complete profiles: no truncation artifacts)", async () => {
    for (const [label, snap, repro] of [
      ["deep fee=500", snapDeep, reproDeep],
      ["odd fee=400", snapOdd, reproOdd],
    ] as const) {
      const diff = await verifyReproduction(c.publicClient, repro.pool, snap, {
        baselineClamped: repro.baselineClamped,
      });
      console.log(
        `  [projectx-prod-mirror] ${label} reproduction: sqrtMatch=${diff.sqrtPriceMatch}` +
          ` activeMatch=${diff.activeLiquidityMatch} boundaries=${diff.boundariesChecked}` +
          ` mismatches=${diff.netMismatches.length} rightEdge=${diff.rightEdgeArtifact ? "ARTIFACT" : "exact"}` +
          ` baseline=${repro.baseline}`,
      );
      // COMPLETE profile ⇒ baseline is exactly 0 and NOTHING is truncated: sqrt,
      // active L, every interior net AND the right edge must all be exact.
      assert.equal(repro.baselineClamped, false, `${label}: complete profile never clamps`);
      assert.equal(repro.baseline, 0n, `${label}: complete profile baseline == 0`);
      assert.equal(diff.sqrtPriceMatch, true, `${label}: reproduced sqrtPriceX96 must equal snapshot`);
      assert.equal(diff.activeLiquidityMatch, true, `${label}: reproduced active liquidity must equal snapshot`);
      assert.equal(
        diff.netMismatches.length,
        0,
        `${label}: every boundary liquidityNet must match exactly (${diff.netMismatches
          .map((m) => `tick ${m.tick}: ${m.snapshot} vs ${m.onchain}`)
          .join("; ")})`,
      );
      assert.equal(diff.rightEdgeArtifact, null, `${label}: complete profile has no right-edge artifact`);
      assert.equal(diff.ok, true, `${label}: reproduction must be faithful`);
    }

    // The NON-STANDARD tier is genuinely registered on the factory: the fee-keyed
    // getter serves 400 → 8 exactly like the real Project X factory
    // (feeAmountTickSpacing on-chain verified 2026-07-03; see constants.ts).
    const ts400 = Number(
      await c.publicClient.readContract({
        address: stack.factory,
        abi: v3FactoryAbi as Abi,
        functionName: "feeAmountTickSpacing",
        args: [400],
      }),
    );
    assert.equal(ts400, 8, "factory serves the non-standard tier: feeAmountTickSpacing(400) == 8");

    // Pin the SHARED TICK_SPACING_BY_FEE rows the venue added — the lens derives
    // every walk stride from this map (fee-keyed), so a dropped row would silently
    // fall back to 60 and mis-stride the odd tier's frontier walk.
    assert.equal(feeToTickSpacing(400), 8, "TICK_SPACING_BY_FEE carries 400 → 8 (Project X)");
    assert.equal(feeToTickSpacing(200), 4, "TICK_SPACING_BY_FEE carries 200 → 4 (Project X)");
    assert.equal(feeToTickSpacing(1000), 20, "TICK_SPACING_BY_FEE carries 1000 → 20 (Project X)");
    assert.equal(snapOdd.tickSpacing, feeToTickSpacing(snapOdd.fee), "captured pool grid == mapped stride");
    assert.equal(snapDeep.tickSpacing, feeToTickSpacing(snapDeep.fee), "standard tier grid == mapped stride");
  });

  it("relative-depth filter judges the thin odd-tier pool per-trade (default floor drops it; 0 keeps it)", async () => {
    const tokenIn = reproDeep.token0;
    const tokenOut = reproDeep.token1;
    const caller = c.account0;
    const amountIn = parseEther("1000");
    const poolConfig = projectXPoolConfig(tokenIn, tokenOut, PROJECTX_FEE_TIERS);

    // DEFAULT floor (1% of Σ in-range capacity): the thin 400 pool is ~0.02% of
    // the deep pool's capacity — the lens (single source of survivorship) drops it.
    const { prepared: preparedDefault } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      undefined,
      PROD_ENGINE,
    );
    assert.equal(preparedDefault.pools.length, 1, "default relative-depth floor keeps only the deep pool");
    assert.equal(preparedDefault.pools[0].feePpm, 500, "the survivor is the deep fee=500 pool");

    // minRelBps: 0 disables the floor — both discovered pools survive.
    const { prepared: preparedAll } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      { minRelBps: 0 },
      PROD_ENGINE,
    );
    assert.equal(preparedAll.pools.length, 2, "minRelBps=0 keeps both reproduced pools");
    console.log(
      `  [projectx-prod-mirror] relative-depth: default floor -> 1 survivor (fee 500); minRelBps=0 -> 2`,
    );
  });

  it("discovers both tiers via the injected menu and splits — every per-pool fill WEI-EXACT vs the oracle", async () => {
    // zeroForOne: tokenIn = token0 < token1 = tokenOut (matches prepare's downward
    // tick scan and both snapshots' lower-boundary staircases).
    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = reproDeep.token0;
    const tokenOut = reproDeep.token1;
    const caller = c.account0;

    // ~1000 WHYPE-equivalents: the deep pool's cut lands ≈295 ticks below its spot
    // — past the thin pool's fee-adjusted spot gap (≈141 ticks), so the merge pulls
    // the odd-tier pool in for its genuine (tiny) share; both walks stay well
    // inside the per-pool budget (≈29 of 96 spacings deep, ≈19 thin). See the
    // budget note at the top.
    const amountIn = parseEther("1000");
    const poolConfig = projectXPoolConfig(tokenIn, tokenOut, PROJECTX_FEE_TIERS);

    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      { minRelBps: 0 }, // keep the thin odd-tier pool (its depth is judged above)
      PROD_ENGINE,
    );

    // Discovery through the injected menu found EXACTLY the two reproduced pools,
    // and the lens threaded each tier's REAL stride into the prepared rows.
    assert.equal(prepared.pools.length, 2, "discovers exactly the 2 reproduced Project X pools");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    const fees = prepared.pools.map((p) => p.feePpm).sort((a, b) => a - b);
    assert.deepEqual(fees, [400, 500], "both tiers discovered incl. the non-standard 400");
    const oddIdx = prepared.pools.findIndex((p) => p.feePpm === 400);
    const deepIdx = prepared.pools.findIndex((p) => p.feePpm === 500);
    assert.equal(prepared.pools[oddIdx].tickSpacing, 8, "odd tier walks the 8-tick stride (TICK_SPACING_BY_FEE)");
    assert.equal(prepared.pools[deepIdx].tickSpacing, 10, "deep tier walks the 10-tick stride");
    assert.equal(
      prepared.pools[oddIdx].address.toLowerCase(),
      reproOdd.pool.toLowerCase(),
      "fee-keyed getPool resolved the odd-tier pool",
    );
    assert.ok(cacheWindowedPools(prepared.pools) === 2, "both pools ship a per-pool net-cache window");
    assert.ok(prepared.zeroForOne, "tokenIn < tokenOut → zeroForOne");

    const deepInBefore = await balanceOf(c.publicClient, tokenIn, reproDeep.pool);
    const oddInBefore = await balanceOf(c.publicClient, tokenIn, reproOdd.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { tick: deepTickBefore } = await getSlot0(c.publicClient, reproDeep.pool);
    const { tick: oddTickBefore } = await getSlot0(c.publicClient, reproOdd.pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against both reproduced tiers");

    const deepInDelta = (await balanceOf(c.publicClient, tokenIn, reproDeep.pool)) - deepInBefore;
    const oddInDelta = (await balanceOf(c.publicClient, tokenIn, reproOdd.pool)) - oddInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const { tick: deepTickAfter } = await getSlot0(c.publicClient, reproDeep.pool);
    const { tick: oddTickAfter } = await getSlot0(c.publicClient, reproOdd.pool);

    assert.ok(spent > 0n && received > 0n, "caller spends tokenIn and receives tokenOut");
    assert.equal(deepInDelta + oddInDelta, spent, "compute-then-pull: pool deltas sum to the caller's spend");

    // WEI-EXACT oracle cross-check (the discriminating gate): deterministic local
    // state == prepared state, so the neutral oracle (ecoswap.optimal.ts via the
    // bit-for-bit ecoSwapReference adapter) must allocate EXACTLY what landed
    // on-chain — per pool. The oracle walks the odd pool on its 8-tick stride; a
    // stride regression (e.g. the 60 fallback) diverges here at the first step.
    const ref = ecoSwapReference(prepared, amountIn);
    assert.equal(spent, ref.totalInput, "spent == oracle totalInput EXACTLY (to the wei)");
    assert.equal(deepInDelta, ref.perPoolInput[deepIdx], "deep-pool fill == oracle to the wei");
    assert.equal(oddInDelta, ref.perPoolInput[oddIdx], "odd-tier fill == oracle to the wei");
    assert.ok(ref.perPoolInput[oddIdx] > 0n, "the merge pulls the odd tier in for a genuine share");

    // Both pools actually moved (crossed reconstructed grid steps downward) and
    // landed at interior cuts, not the price-limit floor.
    assert.ok(deepTickAfter < deepTickBefore, `deep pool walked (tick ${deepTickBefore} -> ${deepTickAfter})`);
    assert.ok(oddTickAfter < oddTickBefore, `odd pool walked (tick ${oddTickBefore} -> ${oddTickAfter})`);
    assert.ok(deepTickAfter > MIN_TICK && oddTickAfter > MIN_TICK, "interior cuts, not the price-limit floor");

    console.log(
      `  [projectx-prod-mirror] split landed: spent=${spent} received=${received}` +
        ` deep=${deepInDelta} (tick ${deepTickBefore}->${deepTickAfter})` +
        ` odd=${oddInDelta} (tick ${oddTickBefore}->${oddTickAfter}) — all wei-exact vs oracle`,
    );
  });

  it("cooks through ONLY the non-standard tier (stride-8 walk through dL==0 gaps), wei-exact", async () => {
    await resetToClean();

    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = reproOdd.token0;
    const tokenOut = reproOdd.token1;
    const caller = c.account0;

    // 0.25 WHYPE-equivalents ≈ a 358-tick (≈45-spacing) walk INSIDE the thin
    // pool's active band (in-band capacity to its nearest initialized boundary at
    // −234712 is ≈0.72; the 96-spacing budget ≈0.54). Every stepped boundary in
    // between is an interior dL==0 gap on the 8-tick grid — the walk must step
    // THROUGH them (liquidity is known ahead: the pool's deepest initialized tick
    // sits far below at −246880).
    const amountIn = parseEther("0.25");
    const poolConfig = projectXPoolConfig(tokenIn, tokenOut, [snapOdd.fee]);

    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

    const poolInBefore = await balanceOf(c.publicClient, tokenIn, reproOdd.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { tick: tickBefore } = await getSlot0(c.publicClient, reproOdd.pool);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      undefined, // single pool → the relative floor is trivially passed
      PROD_ENGINE,
    );

    assert.equal(prepared.pools.length, 1, "discovers exactly the odd-tier pool");
    assert.equal(prepared.pools[0].feePpm, snapOdd.fee, "feePpm == 400 (fee-keyed discovery)");
    assert.equal(prepared.pools[0].tickSpacing, snapOdd.tickSpacing, "prepared stride == the real 8-tick grid");
    assert.ok(cacheWindowedPools(prepared.pools) > 0, "per-pool net-cache window built");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed on the non-standard tier");

    const poolInDelta = (await balanceOf(c.publicClient, tokenIn, reproOdd.pool)) - poolInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const { tick: tickAfter } = await getSlot0(c.publicClient, reproOdd.pool);

    assert.ok(spent > 0n && received > 0n, "caller spends and receives");
    assert.equal(poolInDelta, spent, "single pool → spent == its fill");

    // WEI-EXACT vs the neutral oracle — the stride proof: the oracle computes the
    // frontier on the 8-tick grid from TICK_SPACING_BY_FEE; if the on-chain walk
    // used any other stride the fill would diverge.
    const ref = ecoSwapReference(prepared, amountIn);
    assert.equal(spent, ref.totalInput, "spent == oracle totalInput EXACTLY (to the wei)");
    assert.equal(poolInDelta, ref.perPoolInput[0], "pool fill == oracle to the wei");

    assert.ok(tickAfter < tickBefore, `walked down through dL==0 gaps (tick ${tickBefore} -> ${tickAfter})`);
    assert.ok(tickAfter > -234712, "stayed INSIDE the active band (never crossed the −234712 boundary)");

    console.log(
      `  [projectx-prod-mirror] odd-tier cook: spent=${spent} received=${received}` +
        ` tick ${tickBefore}->${tickAfter} (stride 8) — wei-exact vs oracle`,
    );
  });

  it("re-anchors to the live slot0 price when the deep pool drifts after prepare", async () => {
    await resetToClean();

    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = reproDeep.token0;
    const tokenOut = reproDeep.token1;
    const caller = c.account0;
    // 100 WHYPE-equivalents ≈ a 30-tick fill on the deep pool; the drift below
    // (1/3 of the baseline fill) moves the live tick ≈10 ticks — crossing real
    // reconstructed grid ticks, observable in slot0.
    const amountIn = parseEther("100");
    const poolConfig = projectXPoolConfig(tokenIn, tokenOut, [snapDeep.fee]);
    const { tick: preparedTick } = await getSlot0(c.publicClient, reproDeep.pool);

    // PREPARE against the clean (pre-drift) tick state.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      undefined,
      PROD_ENGINE,
    );
    assert.equal(prepared.pools.length, 1, "single deep pool");
    const ref = ecoSwapReference(prepared, amountIn);
    const refDeep = ref.perPoolInput[0] ?? 0n;
    assert.ok(refDeep > 0n, "baseline allocates to the deep pool");

    // DRIFT: push the price DOWN with a REAL swap through the engine's swapV3 /
    // uniswapV3SwapCallback path (harness/drift.ts) — ≈1/3 the baseline fill.
    const driftAmount = refDeep / 3n;
    await driftPoolPrice(c, stack.sauceRouter, prepared.pools[0], tokenIn, tokenOut, true, driftAmount, caller);
    const { sqrtPriceX96: driftedSqrt, tick: driftedTick } = await getSlot0(c.publicClient, reproDeep.pool);
    assert.ok(
      driftedTick < preparedTick,
      `drift moved the live tick observably (${preparedTick} -> ${driftedTick})`,
    );
    assert.ok(driftedSqrt < BigInt(snapDeep.sqrtPriceX96), "drift moved the live price below the prepared price");

    // EXECUTE the pre-drift bytecodes — Phase B must read the NEW slot0 price.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, reproDeep.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against drifted slot0");

    const poolInDelta = (await balanceOf(c.publicClient, tokenIn, reproDeep.pool)) - poolInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const { tick: afterTick } = await getSlot0(c.publicClient, reproDeep.pool);

    // SINGLE-PASS RE-ANCHORING (input-anchored) — the SAME semantics the V3 and
    // Slipstream prod-mirror siblings assert: the solver re-reads the LIVE
    // (drifted) slot0 in Phase B and walks from THERE, spending the user's trade
    // against the drifted price (the drift moves WHERE the fill starts, not HOW
    // MUCH is spent). Re-anchoring is proven by driftedTick < preparedTick plus a
    // successful full-amount swap from it.
    assert.ok(poolInDelta > 0n, "pool still participates");
    assert.equal(poolInDelta, spent, "single pool → spent == its fill");
    assert.ok(spent <= amountIn, "never overspends amountIn");
    assert.ok(
      spent >= (amountIn * 80n) / 100n,
      `spends the large majority of the trade against the drifted price (spent ${spent} of ${amountIn})`,
    );
    assert.ok(afterTick > MIN_TICK, `re-anchored fill lands at an interior cut (tick ${afterTick})`);
    assert.ok(
      afterTick <= driftedTick,
      `re-anchored fill walks down from the drifted price (drifted ${driftedTick} -> after ${afterTick})`,
    );

    console.log(
      `  [projectx-prod-mirror] RUNTIME re-anchor (single-pass, input-anchored): ` +
        `drift ${driftAmount} moved live tick ${preparedTick}->${driftedTick}; ` +
        `then recipe spent ${spent} of amountIn ${amountIn} (baseline fill ${refDeep}); ` +
        `tick ${driftedTick}->${afterTick}`,
    );
  });
});
