/**
 * EcoSwap Algebra-CL PROD-MIRROR local EVM test — NO fork, NO live RPC.
 *
 * Sibling of ecoswap.prodmirror.evm.test.ts (Uniswap V3) and
 * ecoswap.slipstream.prodmirror.evm.test.ts (Aerodrome Slipstream CL). It
 * reproduces a REAL production Algebra dynamic-fee CL pool's tick state on a
 * fresh local anvil (a BSC THENA-Fusion USDT/USDC stable pool, captured by
 * harness/algebra-snapshot.ts), then discovers it through the PRODUCTION Algebra
 * path (poolByPair(tokenA, tokenB) + globalState() dynamic fee via the local
 * AlgebraFactory + AlgebraPool adapter) and runs the compiled EcoSwap recipe
 * against it.
 *
 * WHAT SWAP-MATH PATH THIS EXERCISES  (be brutally honest)
 * ────────────────────────────────────────────────────────
 * The swap executes through the SAME AlgebraPool.sol adapter the SYNTHETIC
 * Algebra EVM test (ecoswap.algebra.evm.test.ts) uses: a thin adapter that wraps
 * a GENUINE Uniswap-v3-core inner pool and, on swap(), drives the inner pool and
 * re-enters the caller (the engine) via `algebraSwapCallback` — the REAL Algebra
 * engine path (sauce#186), NOT `uniswapV3SwapCallback`. So the mid-swap input pull
 * genuinely goes through the engine's algebraSwapCallback handler and the pool is
 * discovered via poolByPair with a dynamic fee read from globalState() — the
 * production Algebra discovery + execution path end to end.
 *
 * The swap CURVE math is real v3-core math (the inner pool). Algebra v1 (THENA
 * Fusion / Camelot / QuickSwap V3) per-tick liquidityNet + sqrtPrice grid + swap
 * step are byte-identical to Uniswap V3 — the ONLY difference vs V3 is the
 * dynamic (oracle-recomputed) fee and the callback selector, both of which ARE
 * exercised here (the captured dynamic fee threads into feePpm; the callback is
 * the real algebraSwapCallback). What this test does NOT do is etch the real
 * THENA CLPool bytecode: Algebra core mint requires its full dataStorage /
 * community-fee / plugin graph, so a bare etched CLPool runtime cannot be minted
 * into cleanly. Fidelity level: REAL captured pool STATE (exact sqrtPriceX96 +
 * full initialized-tick liquidityNet profile + active L + the live dynamic fee),
 * executed through genuine v3-core swap math over that exact state, via the REAL
 * engine algebraSwapCallback path and the REAL poolByPair+globalState discovery.
 * This matches the V3 / Slipstream prod-mirror tier (real STATE, reconstructed
 * pool) with the Algebra-specific callback + discovery paths genuinely exercised.
 *
 * Offline by design: it loads the CHECKED-IN captured snapshot
 * (fixtures/snapshots/bsc-algebra-USDTUSDC-60.json). Recapture the snapshot with:
 *   set -a; . sdk/.env; set +a
 *   npx tsx src/recipes/test/harness/algebra-snapshot.ts
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.algebra.prodmirror.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnits, type Hex, type Account, type Abi } from "viem";

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
  getLiquidity,
  deployAlgebraFactory,
  wrapAlgebraAdapter,
  getAlgebraGlobalState,
  algebraFactoryAbi,
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
  type ReproductionDiff,
} from "./harness/reproduce-pool";
import { withCachedState } from "./harness/state-cache";
import type { ProdPoolSnapshot } from "./harness/prod-snapshot";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { driftPoolPrice } from "./harness/drift";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "fixtures", "snapshots");
// The captured REAL BSC THENA-Fusion Algebra CL pool (USDT/USDC, tickSpacing 60,
// live dynamic fee 10 ppm — on-charter both-baseToken stable pair on BSC).
// Captured by harness/algebra-snapshot.ts.
const SNAPSHOT_FILE = "bsc-algebra-USDTUSDC-60.json";

// Both tokens are 18-decimal stables on BSC (USDT/USDC).
const HUGE = parseUnits("1000000000", 18);

// Uniswap-V3 / Algebra canonical MIN_TICK (the zeroForOne price-limit floor). A
// swap that terminates HERE has drained past all reconstructed liquidity to the
// price limit — NOT landed at a genuine interior liquidity cut. Both the wei-exact
// and drift cases assert the swap does NOT reach this, so a regression that zips a
// re-anchored fill to the price-limit extreme is caught.
const MIN_TICK = -887272;

// RECONSTRUCTED-BAND BUDGET (ts=60 USDT/USDC stable pool, live tick −8). The live
// band [−60, 0) is EXCEPTIONALLY deep — active L ≈ 2.05e24 for an 18-decimal stable
// pair — so ≈5416 tokens are needed just to walk DOWN from the live tick to the
// tick−60 boundary. Below −60 the profile thins by ~3 orders of magnitude, so the
// bands −60→−540 (and the sparse tail to −7260) add only ≈54 more tokens: the total
// gross tokenIn the reconstructed window absorbs from spot before the price-limit
// floor is ≈5470 tokens. Every trade below MUST stay inside this budget so its cut is
// a GENUINE interior liquidity cut (a real captured-state cut), not a window-edge
// MIN_TICK artifact. This is the REAL pool's shape (the window's Σ liquidityNet is
// exactly 0 — a fully conservative window), not a fixture limitation.

// Per-pool net-cache measure (mirrors the V3 / Slipstream prod-mirror): a scanned
// WINDOW (windowTopShifted > 0) is a populated per-pool cache, independent of how
// many initialized ticks fell inside it. Defined locally (not shared) to avoid races.
function cacheWindowedPools(
  pools: { isV2?: boolean; windowTopShifted?: bigint }[],
): number {
  return pools.filter((p) => !p.isV2 && (p.windowTopShifted ?? 0n) > 0n).length;
}

// Single engine per (heavy) file: the one selected engine (default v12;
// ECO_ENGINE=v1 forces v1). See harness/engine.ts.
const PROD_ENGINE: Engine = selectedEngines()[0];

function loadSnapshot(): ProdPoolSnapshot {
  return JSON.parse(readFileSync(join(SNAPSHOT_DIR, SNAPSHOT_FILE), "utf-8")) as ProdPoolSnapshot;
}

/** Manifest the cache stores/rehydrates: everything the test needs post-loadState. */
interface AlgManifest {
  stack: DeployedStack;
  v12: DeployedV12Stack | null;
  /**
   * The reproduced INNER v3-core pool (its `pool` field is the inner pool address —
   * this is what carries the reconstructed tick profile and what verifyReproduction
   * reads slot0/liquidity/ticks from). token0/token1/fee/tickSpacing are the pool's.
   */
  repro: ReproducedPool;
  /** The Algebra factory shim (poolByPair registry). */
  algebraFactory: Hex;
  /** The Algebra adapter (poolByPair → this) that wraps the inner pool. Discovery surfaces THIS. */
  adapter: Hex;
}

describe("EcoSwap Algebra-CL prod-mirror (reproduced real THENA-Fusion dynamic-fee tick state)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let algebraFactory: Hex;
  let adapter: Hex;
  let snap: ProdPoolSnapshot;
  let repro: ReproducedPool;
  let diff: ReproductionDiff;
  let cleanSnapshot: Hex; // pristine reconstructed state (for the drift case)

  before(async () => {
    snap = loadSnapshot();
    console.log(
      `  [algebra-prod-mirror] using REAL snapshot ${SNAPSHOT_FILE}` +
        ` (${snap.symbol0}/${snap.symbol1} dynamicFee=${snap.fee} tickSpacing=${snap.tickSpacing}` +
        ` tick=${snap.tick}, ${snap.ticks.length} boundaries)`,
    );

    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);

    // Full deploy + reconstruction, cached once per engine
    // (fixtures/anvil-state/algebra-prodmirror-<engine>) so later runs loadState in
    // seconds. Recapture: RECAPTURE_ANVIL_STATE=1. See harness/state-cache.ts.
    const { manifest, fromCache } = await withCachedState<AlgManifest>({
      name: "algebra-prodmirror",
      engine: PROD_ENGINE,
      c,
      build: async () => {
        await ensureMulticall3(c.publicClient, c.testClient);
        const s = await deployStack(c.walletClient, c.publicClient);
        // Reconstruct the captured Algebra pool's tick profile into a REAL v3-core
        // INNER pool at the captured dynamic fee (10 ppm) + tickSpacing (60). The
        // captured fee/tickSpacing come straight from the snapshot — reproducePool
        // enables the non-standard 10 ppm tier on the factory as needed.
        const r = await reproducePool(c.walletClient, c.publicClient, s.factory, s.helper, snap, HUGE);
        // Deploy the AlgebraFactory shim + wrap the inner pool in the AlgebraPool
        // adapter (globalState/ticks proxied off the inner pool; algebraSwapCallback
        // re-entry) and register it under poolByPair(token0, token1) so the
        // production Algebra discovery finds it. dynFee = the captured globalState fee.
        const af = await deployAlgebraFactory(c.walletClient, c.publicClient);
        const ad = await wrapAlgebraAdapter(
          c.walletClient, c.publicClient, af, r.pool, r.token0, r.token1, snap.fee,
        );
        const v = await maybeDeployV12Stack(c, c.walletClient.account as Account);
        if (v) await approve(c.walletClient, c.publicClient, r.token0, v.pot, HUGE);
        return { stack: s, v12: v, repro: r, algebraFactory: af, adapter: ad };
      },
    });
    console.log(
      `  [algebra-prod-mirror] state ${fromCache ? "LOADED from cache" : "RECONSTRUCTED + cached"} (engine ${PROD_ENGINE})`,
    );
    stack = manifest.stack;
    v12 = manifest.v12;
    repro = manifest.repro;
    algebraFactory = manifest.algebraFactory;
    adapter = manifest.adapter;

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  /**
   * poolConfig pointing discovery + the lens at the local AlgebraFactory shim
   * (poolByPair-keyed, FactoryType.AlgebraV3), carrying the snapshot's tickSpacing
   * as the Algebra fixed per-factory tickSpacing (the lens reads it from config, not
   * the pool). baseTokens = the swap pair so the multi-hop route loop yields zero
   * routes (single reproduced pool → direct-only), exactly as the V3 / Slipstream
   * prod-mirror. feeTiers is a formality for Algebra (poolByPair ignores tiers), but
   * carrying the dynamic fee keeps the config self-describing.
   */
  function algebraPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: algebraFactory,
          poolType: SwapPoolType.UniV3,
          factoryType: FactoryType.AlgebraV3,
          label: "Local Algebra (prod-mirror)",
          algebraTickSpacing: snap.tickSpacing,
        },
      ],
      feeTiers: [snap.fee],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  it("reproduces the snapshot's on-chain tick state (sqrt EXACT via globalState + boundary nets EXACT)", async () => {
    // verifyReproduction reads slot0/liquidity/ticks — the INNER v3-core pool carries
    // the reconstructed state, so we verify against repro.pool (the inner pool). The
    // adapter's globalState() proxies the same price/tick, asserted separately below.
    diff = await verifyReproduction(c.publicClient, repro.pool, snap, {
      baselineClamped: repro.baselineClamped,
    });

    console.log(
      `  [algebra-prod-mirror] reproduction diff:\n` +
        `    sqrtPriceX96 snapshot=${diff.sqrtSnapshot} onchain=${diff.sqrtOnchain} match=${diff.sqrtPriceMatch}\n` +
        `    active liquidity snapshot=${diff.activeSnapshot} onchain=${diff.activeOnchain} match=${diff.activeLiquidityMatch}\n` +
        `    boundaries checked (interior + b0)=${diff.boundariesChecked} net mismatches=${diff.netMismatches.length}\n` +
        `    right-edge truncation artifact=${
          diff.rightEdgeArtifact
            ? `tick ${diff.rightEdgeArtifact.tick}: snapshot ${diff.rightEdgeArtifact.snapshot} vs onchain ${diff.rightEdgeArtifact.onchain}`
            : "none"
        }\n` +
        `    baseline=${repro.baseline} clamped=${repro.baselineClamped} positions=${repro.positions.length}`,
    );

    // sqrtPriceX96 must be EXACT (initialize sets it directly from the globalState price).
    assert.equal(diff.sqrtPriceMatch, true, "reproduced sqrtPriceX96 must equal snapshot globalState price");
    // Active liquidity exact within the window (unless baseline was clamped).
    if (!repro.baselineClamped) {
      assert.equal(diff.activeLiquidityMatch, true, "reproduced active liquidity must equal snapshot");
    }
    // Every interior + b0 boundary's liquidityNet must match EXACTLY.
    assert.equal(
      diff.netMismatches.length,
      0,
      `interior boundary liquidityNet must match snapshot exactly (${diff.netMismatches
        .map((m) => `tick ${m.tick}: ${m.snapshot} vs ${m.onchain}`)
        .join("; ")})`,
    );
    assert.equal(diff.ok, true, "reproduction must be faithful");

    // The Algebra adapter's globalState() proxies the SAME live price/tick as the inner
    // pool (== the captured snapshot price) and reports the captured DYNAMIC fee.
    const gs = await getAlgebraGlobalState(c.publicClient, adapter);
    assert.equal(gs.sqrtPriceX96, BigInt(snap.sqrtPriceX96), "adapter globalState price == captured sqrtPriceX96");
    assert.equal(gs.feeZto, snap.fee, "adapter globalState reports the captured DYNAMIC fee (zeroToOne)");
    assert.equal(gs.feeOtz, snap.fee, "adapter globalState reports the captured DYNAMIC fee (oneToZero)");
    assert.ok((await getLiquidity(c.publicClient, adapter)) > 0n, "adapter proxies inner pool active liquidity > 0");

    // The Algebra shim resolves the adapter by poolByPair(token0, token1).
    const resolved = (await c.publicClient.readContract({
      address: algebraFactory,
      abi: algebraFactoryAbi as Abi,
      functionName: "poolByPair",
      args: [repro.token0, repro.token1],
    })) as Hex;
    assert.equal(resolved.toLowerCase(), adapter.toLowerCase(), "shim resolves the adapter by poolByPair");
  });

  it("runs EcoSwap through the reproduced Algebra pool (wei-exact vs the neutral oracle, real algebraSwapCallback)", async () => {
    // zeroForOne: tokenIn = token0 < token1 = tokenOut (matches prepare's downward
    // tick scan and the snapshot's lower-boundary staircase).
    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = repro.token0;
    const tokenOut = repro.token1;
    const caller = c.account0;

    // Size the trade so it crosses at least the tick−60 boundary but stays within the
    // reconstructed-band budget (see BUDGET note). The live tick −8 sits inside the
    // very deep [−60, 0) band (active L ≈ 2.05e24), so ≈5416 tokens are needed just to
    // walk DOWN to the tick−60 boundary. ~5430 tokens crosses tick −60 (and −120) and
    // lands at a GENUINE interior liquidity cut (≈ tick −180 region), comfortably below
    // the ~5470 budget ceiling / the price-limit floor (asserted below via
    // afterTick > MIN_TICK).
    const amountIn = parseUnits("5430", 18);

    const poolConfig = algebraPoolConfig(tokenIn, tokenOut);

    // Fund + approve the caller for tokenIn.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

    // The engine pulls tokenIn INTO the adapter (which forwards it to the inner pool),
    // and the adapter forwards the output to the caller. Track the INNER pool's reserves
    // (where the reconstructed liquidity + the executed swap live) and the caller's.
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const poolOutBefore = await balanceOf(c.publicClient, tokenOut, repro.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { tick: tickBefore } = await getSlot0(c.publicClient, repro.pool);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      undefined,
      PROD_ENGINE,
    );

    const v3Count = prepared.pools.filter((p) => !p.isV2).length;
    assert.equal(v3Count, 1, "should discover exactly the 1 reproduced Algebra pool");
    assert.equal(prepared.pools.length, 1, "exactly one direct pool");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    assert.equal(
      prepared.pools[0].poolType,
      SwapPoolType.UniV3,
      "Algebra pool surfaces as a UniV3-shaped row (poolType=1)",
    );
    assert.equal(
      prepared.pools[0].address.toLowerCase(),
      adapter.toLowerCase(),
      "the discovered pool is the Algebra adapter (via poolByPair)",
    );
    assert.equal(
      prepared.pools[0].feePpm,
      snap.fee,
      "the DYNAMIC fee read from globalState() threads into feePpm (Algebra dynamic-fee row)",
    );
    assert.ok(
      cacheWindowedPools(prepared.pools) > 0,
      "should build a per-pool net-cache window from reconstructed ticks",
    );
    assert.ok(prepared.zeroForOne, "tokenIn < tokenOut → zeroForOne");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against reproduced Algebra geometry (algebraSwapCallback serviced)");

    const poolInAfter = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const poolOutAfter = await balanceOf(c.publicClient, tokenOut, repro.pool);
    const callerInAfter = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutAfter = await balanceOf(c.publicClient, tokenOut, caller);
    const { tick: tickAfter } = await getSlot0(c.publicClient, repro.pool);

    const spent = callerInBefore - callerInAfter;
    const received = callerOutAfter - callerOutBefore;

    assert.ok(spent > 0n, "caller should spend tokenIn");
    assert.ok(received > 0n, "caller should receive tokenOut > 0");
    // The input pulled via algebraSwapCallback lands in the inner pool; the inner pool's
    // tokenIn reserve increases by exactly the spent amount.
    assert.equal(poolInAfter - poolInBefore, spent, "inner pool tokenIn reserve increases by spent (input pulled via algebraSwapCallback)");
    assert.ok(poolOutBefore - poolOutAfter > 0n, "inner pool tokenOut reserve decreases");

    // zeroForOne moves the price DOWN — the live tick must have decreased, i.e. the
    // swap walked through reconstructed initialized ticks.
    assert.ok(
      tickAfter < tickBefore,
      `swap must cross reconstructed ticks (tick ${tickBefore} -> ${tickAfter})`,
    );
    // ...and landed at a GENUINE interior liquidity cut, NOT drained to the
    // price-limit floor (a reconstructed-window artifact, not the pool's real cut).
    assert.ok(
      tickAfter > MIN_TICK,
      `swap lands at an interior cut, not the price-limit floor (tick ${tickAfter})`,
    );

    // WEI-EXACT oracle cross-check: deterministic local state == prepared state, so the
    // neutral oracle (ecoswap.optimal.ts, via the bit-for-bit ecoSwapReference adapter)
    // allocates EXACTLY the on-chain spend for the single reproduced pool.
    const ref = ecoSwapReference(prepared, amountIn);
    const refIn = ref.perPoolInput[0] ?? 0n;
    assert.ok(refIn > 0n, "oracle allocates to the reproduced pool");
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY (to the wei)");
    assert.equal(spent, refIn, "per-pool awarded input == oracle to the wei");
    assert.equal(poolInAfter - poolInBefore, refIn, "inner pool tokenIn delta == oracle per-pool input to the wei");

    console.log(
      `  [algebra-prod-mirror] swap landed: spent=${spent} received=${received}` +
        ` tick ${tickBefore}->${tickAfter} (crossed ticks)` +
        ` oracle totalInput=${ref.totalInput} perPool[0]=${refIn} (wei-exact, dynFee=${snap.fee})`,
    );
  });

  it("re-anchors to the live globalState price when the Algebra pool drifts after prepare", async () => {
    await c.testClient.revert({ id: cleanSnapshot });

    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = repro.token0;
    const tokenOut = repro.token1;
    const caller = c.account0;
    // The recipe's trade. Sized SMALL relative to the reconstructed-band budget so that,
    // AFTER a boundary-crossing drift, the re-anchored full-amountIn fill still lands at a
    // GENUINE interior liquidity cut, never at the price-limit floor. drift (5420) +
    // amountIn (20) = 5440 gross-in ≪ the ~5470 budget.
    const amountIn = parseUnits("20", 18);
    const poolConfig = algebraPoolConfig(tokenIn, tokenOut);
    const { tick: preparedTick } = await getSlot0(c.publicClient, repro.pool);

    // PREPARE against the clean (pre-drift) tick state. slippageBps:0 disables the internal
    // whole-trade amountOutMin floor: this test DELIBERATELY moves the price adversely (a large
    // boundary-crossing drift) to exercise Phase-B live re-anchoring — exactly the adverse move the
    // floor (computed on the PRE-drift expected output) guards against. The floor's MEV protection is
    // orthogonal to the re-anchoring this test proves (split correctness is asserted directly below),
    // so it is disabled here; the wei-exact + no-drift prod-mirror cases exercise the floor's default.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      { slippageBps: 0 },
      PROD_ENGINE,
    );
    const ref = ecoSwapReference(prepared, amountIn);
    const refV3 = ref.perPoolInput[0] ?? 0n;
    assert.ok(refV3 > 0n, "baseline allocates to the Algebra pool");

    // DRIFT: push the Algebra pool's price DOWN with a real swap routed through the
    // engine (which re-enters via algebraSwapCallback — the same path the recipe uses).
    // The live band [−60, 0) is EXCEPTIONALLY deep (≈5416 tokens just to walk from the
    // live tick down to the tick−60 boundary), so the drift is deliberately LARGE (5420
    // tokens) to move the live tick by an OBSERVABLE amount: it crosses tick −60 and
    // lands the live tick strictly below the prepared tick. A tiny drift here would leave
    // the live price essentially unchanged (sub-tick) and could NOT distinguish genuine
    // Phase-B live-price re-anchoring from stale-price behavior — so the drift must cross
    // a real initialized boundary. (This is why the drift is a fixed absolute size, not a
    // fraction of the tiny recipe fill.)
    const driftAmount = parseUnits("5420", 18);
    await driftPoolPrice(c, stack.sauceRouter, prepared.pools[0], tokenIn, tokenOut, true, driftAmount, caller);
    const { sqrtPriceX96: driftedSqrt, tick: driftedTick } = await getSlot0(c.publicClient, repro.pool);

    // The drift must have moved the LIVE tick by a discriminating amount — a re-anchoring
    // recipe reads a DIFFERENT price than it prepared against, so the test can distinguish
    // live-price re-anchoring from stale-price behavior only if the live tick changed.
    assert.ok(
      driftedTick < preparedTick,
      `drift crossed a real initialized boundary: live tick ${preparedTick} -> ${driftedTick}`,
    );
    assert.ok(driftedSqrt < BigInt(snap.sqrtPriceX96), "drift moved the live price below the prepared price");

    // EXECUTE the pre-drift bytecodes — Phase B must read the NEW globalState price.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against drifted globalState");

    const v3InDelta = (await balanceOf(c.publicClient, tokenIn, repro.pool)) - poolInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const { tick: afterTick } = await getSlot0(c.publicClient, repro.pool);

    // SINGLE-PASS RE-ANCHORING (input-anchored) — the SAME semantics the Uniswap-V3 /
    // Slipstream prod-mirror siblings assert. The solver re-reads the LIVE (drifted)
    // globalState price in Phase B and walks the pool's frontier from THERE, spending the
    // user's full `amountIn` against the drifted price. With a SINGLE pool the whole trade
    // lands here regardless of drift — the drift moves WHERE the fill starts (and ends),
    // not HOW MUCH is spent. The re-anchoring is proven by driftedTick < preparedTick
    // (Phase B read the new live price) combined with a successful full-amount swap from it.
    assert.ok(v3InDelta > 0n, "pool still participates");
    assert.equal(v3InDelta, spent, "single pool → spent == its fill");
    assert.ok(spent <= amountIn, "never overspends amountIn");
    // Input-anchored: it deploys the LARGE majority of the trade against the drifted
    // price. The >80% floor cleanly separates single-pass (spends the trade) from the OLD
    // two-pass gap-fill (which under this drift would have spent far less). With this small
    // `amountIn` well inside the post-drift depth the fill is a full 100%.
    assert.ok(
      spent >= (amountIn * 80n) / 100n,
      `spends the large majority of the trade against the drifted price (spent ${spent} of ${amountIn})`,
    );
    // ...and the re-anchored fill lands at a GENUINE interior liquidity cut, NOT the
    // price-limit floor — the discriminating guard: a regression that drains a re-anchored
    // fill to the price limit fails HERE.
    assert.ok(
      afterTick > MIN_TICK,
      `re-anchored fill lands at an interior cut, not the price-limit floor (tick ${afterTick})`,
    );
    // The fill walked DOWN from the drifted price (it moved the live tick further),
    // confirming it executed against the post-drift price rather than a stale one.
    assert.ok(
      afterTick <= driftedTick,
      `re-anchored fill walks down from the drifted price (drifted ${driftedTick} -> after ${afterTick})`,
    );

    console.log(
      `  [algebra-prod-mirror] RUNTIME re-anchor (single-pass, input-anchored): ` +
        `drift ${driftAmount} moved live tick ${preparedTick}->${driftedTick}; ` +
        `then recipe spent ${spent} of amountIn ${amountIn} (baseline fill ${refV3}); ` +
        `tick ${driftedTick}->${afterTick}`,
    );
  });
});
