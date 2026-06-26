/**
 * EcoSwap PROD-MIRROR local EVM test — NO fork, NO live RPC.
 *
 * Reproduces a REAL production Uniswap-V3 pool's tick state on a fresh local
 * anvil (deploying the real V3 factory + the Sauce engine), then runs the
 * compiled EcoSwap recipe against the reconstructed pool.
 *
 * Sibling of ecoswap.evm.test.ts — same harness, same anvil discipline. The
 * difference: instead of hand-minting an arbitrary profile, it replays a
 * captured `ProdPoolSnapshot` (sqrtPriceX96 + active liquidity + initialized
 * tick window) via recipes/test/harness/reproduce-pool.ts and ASSERTS the
 * on-chain tick state matches the snapshot before swapping through it.
 *
 * Offline by design: it loads a CHECKED-IN SYNTHETIC snapshot
 * (fixtures/snapshots/synthetic-wethusdc-500.json) so the whole path is runnable
 * with no network. If a REAL captured snapshot is present (any *-500.json that
 * is NOT the synthetic one), it is preferred. Capture a real one with:
 *   BASE_RPC_URL=<url> npx tsx recipes/test/harness/prod-snapshot.ts
 *
 * Run: npx tsx --test recipes/test/ecoswap.prodmirror.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, type Hex, type Account } from "viem";

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
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  type Engine,
  selectedEngines,
  maybeDeployV12Stack,
  cookTarget,
  quoteRouter,
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
const SYNTHETIC = "synthetic-wethusdc-500.json";

const HUGE = parseEther("1000000000");

// Single engine per (heavy) file: the one selected engine (default v12;
// ECO_ENGINE=v1 forces v1). See harness/engine.ts.
const PROD_ENGINE: Engine = selectedEngines()[0];

/**
 * Load a snapshot for the prod-mirror test. Prefer a REAL captured *-500.json
 * (anything that isn't the synthetic fixture); else fall back to the synthetic
 * one. Returns the snapshot + whether it is synthetic + the filename used.
 */
function loadSnapshot(): { snap: ProdPoolSnapshot; synthetic: boolean; file: string } {
  let files: string[] = [];
  try {
    files = readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  const real = files.find((f) => f.endsWith("-500.json") && f !== SYNTHETIC);
  const file = real ?? SYNTHETIC;
  const snap = JSON.parse(readFileSync(join(SNAPSHOT_DIR, file), "utf-8")) as ProdPoolSnapshot;
  return { snap, synthetic: file === SYNTHETIC, file };
}

describe("EcoSwap prod-mirror (reproduced V3 tick state)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let snap: ProdPoolSnapshot;
  let synthetic: boolean;
  let repro: ReproducedPool;
  let diff: ReproductionDiff;
  let cleanSnapshot: Hex; // pristine reconstructed state (for the drift case)

  before(async () => {
    const loaded = loadSnapshot();
    snap = loaded.snap;
    synthetic = loaded.synthetic;
    console.log(
      `  [prod-mirror] using ${loaded.synthetic ? "SYNTHETIC" : "REAL"} snapshot ${loaded.file}` +
        ` (${snap.symbol0}/${snap.symbol1} fee=${snap.fee} tick=${snap.tick}, ${snap.ticks.length} boundaries)`,
    );

    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);

    // Full deploy + reconstruction, cached once per engine
    // (fixtures/anvil-state/prodmirror-v3-<engine>) so later runs loadState in
    // seconds. Recapture: RECAPTURE_ANVIL_STATE=1. See harness/state-cache.ts.
    const { manifest, fromCache } = await withCachedState<{
      stack: DeployedStack;
      v12: DeployedV12Stack | null;
      repro: ReproducedPool;
    }>({
      name: "prodmirror-v3",
      engine: PROD_ENGINE,
      c,
      build: async () => {
        await ensureMulticall3(c.publicClient, c.testClient);
        const s = await deployStack(c.walletClient, c.publicClient);
        const r = await reproducePool(c.walletClient, c.publicClient, s.factory, s.helper, snap, HUGE);
        const v = await maybeDeployV12Stack(c, c.walletClient.account as Account);
        if (v) await approve(c.walletClient, c.publicClient, r.token0, v.pot, HUGE);
        return { stack: s, v12: v, repro: r };
      },
    });
    console.log(
      `  [prod-mirror] state ${fromCache ? "LOADED from cache" : "RECONSTRUCTED + cached"} (engine ${PROD_ENGINE})`,
    );
    stack = manifest.stack;
    v12 = manifest.v12;
    repro = manifest.repro;

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  it("reproduces the snapshot's on-chain tick state", async () => {
    diff = await verifyReproduction(c.publicClient, repro.pool, snap, {
      baselineClamped: repro.baselineClamped,
    });

    console.log(
      `  [prod-mirror] reproduction diff:\n` +
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

    // sqrtPriceX96 must be EXACT (initialize sets it directly).
    assert.equal(diff.sqrtPriceMatch, true, "reproduced sqrtPriceX96 must equal snapshot");
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
  });

  it("runs EcoSwap through the reproduced prod pool", async () => {
    // zeroForOne: tokenIn = token0 < token1 = tokenOut (matches prepare's
    // downward tick scan and the snapshot's lower-boundary staircase).
    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = repro.token0;
    const tokenOut = repro.token1;
    const caller = c.account0;

    // Size the trade so it crosses several reconstructed initialized ticks but
    // stays within reconstructed liquidity. The synthetic pool holds ~750e18
    // active; ~100e18 walks down through multiple boundaries without exhausting.
    const amountIn = parseEther("100");

    // Local discovery config: ONLY the local UniV3 factory, ONLY the snapshot's
    // fee tier, baseTokens = the swap pair so the multi-hop route loop yields
    // zero routes (single reproduced pool → direct-only).
    const poolConfig: ChainPoolConfig = {
      factories: [
        {
          address: stack.factory,
          poolType: SwapPoolType.UniV3,
          factoryType: FactoryType.V3Standard,
          label: "Local UniV3 (prod-mirror)",
        },
      ],
      feeTiers: [snap.fee],
      baseTokens: [tokenIn, tokenOut],
    };

    // Fund + approve the caller for tokenIn.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

    const poolInBefore = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const poolOutBefore = await balanceOf(c.publicClient, tokenOut, repro.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { tick: tickBefore } = await getSlot0(c.publicClient, repro.pool);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      quoteRouter(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      undefined,
      PROD_ENGINE,
    );

    const v3Count = prepared.pools.filter((p) => !p.isV2).length;
    assert.equal(v3Count, 1, "should discover exactly the 1 reproduced V3 pool");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    assert.ok(prepared.brackets.length > 0, "should build brackets from reconstructed ticks");
    assert.ok(prepared.zeroForOne, "tokenIn < tokenOut → zeroForOne");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against reproduced prod geometry");

    const poolInAfter = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const poolOutAfter = await balanceOf(c.publicClient, tokenOut, repro.pool);
    const callerInAfter = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutAfter = await balanceOf(c.publicClient, tokenOut, caller);
    const { tick: tickAfter } = await getSlot0(c.publicClient, repro.pool);

    const spent = callerInBefore - callerInAfter;
    const received = callerOutAfter - callerOutBefore;

    assert.ok(spent > 0n, "caller should spend tokenIn");
    assert.ok(received > 0n, "caller should receive tokenOut > 0");
    assert.equal(poolInAfter - poolInBefore, spent, "pool tokenIn reserve increases by spent");
    assert.ok(poolOutBefore - poolOutAfter > 0n, "pool tokenOut reserve decreases");

    // zeroForOne moves the price DOWN — the live tick must have decreased,
    // i.e. the swap walked through reconstructed initialized ticks.
    assert.ok(
      tickAfter < tickBefore,
      `swap must cross reconstructed ticks (tick ${tickBefore} -> ${tickAfter})`,
    );

    // Oracle cross-check: deterministic local state == prepared state, so the
    // reference solver's single-pool allocation should track the on-chain spend.
    const ref = ecoSwapReference(prepared, amountIn);
    const refIn = ref.perPoolInput[0] ?? 0n;
    if (refIn > 0n) {
      const denom = refIn > spent ? refIn : spent;
      const rel = Number(refIn > spent ? refIn - spent : spent - refIn) / Number(denom);
      assert.ok(
        rel < 0.15 || (refIn > spent ? refIn - spent : spent - refIn) < parseEther("1"),
        `on-chain spend ${spent} vs oracle ${refIn} (rel ${rel})`,
      );
    }

    console.log(
      `  [prod-mirror] swap landed: spent=${spent} received=${received}` +
        ` tick ${tickBefore}->${tickAfter} (crossed ticks)` +
        ` oracle perPool[0]=${refIn} (${synthetic ? "synthetic" : "real"} snapshot)`,
    );
  });

  it("re-anchors to the live slot0 price when the pool drifts after prepare", async () => {
    await c.testClient.revert({ id: cleanSnapshot });

    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = repro.token0;
    const tokenOut = repro.token1;
    const caller = c.account0;
    const amountIn = parseEther("100");
    const poolConfig: ChainPoolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3 (prod-mirror)" },
      ],
      feeTiers: [snap.fee],
      baseTokens: [tokenIn, tokenOut],
    };

    // PREPARE against the clean (pre-drift) tick state.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, quoteRouter(PROD_ENGINE, stack, v12), caller, poolConfig, undefined, PROD_ENGINE,
    );
    const ref = ecoSwapReference(prepared, amountIn);
    const refV3 = ref.perPoolInput[0] ?? 0n;
    assert.ok(refV3 > 0n, "baseline allocates to the V3 pool");

    // DRIFT: push the V3 price down with a real swap of ~1/3 the baseline fill.
    const driftAmount = refV3 / 3n;
    await driftPoolPrice(c, stack.sauceRouter, prepared.pools[0], tokenIn, tokenOut, true, driftAmount, caller);
    const { sqrtPriceX96: driftedSqrt, tick: driftedTick } = await getSlot0(c.publicClient, repro.pool);

    // EXECUTE the pre-drift bytecodes — Phase B must read the NEW slot0 price.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against drifted slot0");

    const v3InDelta = (await balanceOf(c.publicClient, tokenIn, repro.pool)) - poolInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const { tick: afterTick } = await getSlot0(c.publicClient, repro.pool);

    // SINGLE-PASS semantics (input-anchored): the solver spends `amountIn` EXACTLY,
    // re-anchoring to the LIVE drifted slot0 price it reads at cook, not the stale
    // prepared price. With a SINGLE pool the whole trade lands here, so the runtime
    // fill ≈ amountIn regardless of drift — the drift just moves where the swap
    // starts (and thus ends), not how much is spent. (The OLD two-pass solver was
    // price-anchored: it filled only the gap to the prepared cut, so drift + recipe
    // ≈ baseline. Single-pass deliberately spends the user's full trade instead.)
    // The re-anchoring is proven by `driftedSqrt < prepared` (Phase B read the new
    // live price) combined with a successful, full-amount swap against it.
    assert.ok(v3InDelta > 0n, "pool still participates");
    assert.equal(v3InDelta, spent, "single pool → spent == its fill");
    assert.ok(spent <= amountIn, "never overspends");
    // Input-anchored: it deploys the LARGE majority of the trade (the drift pushed
    // the live price away from spot, trimming the prepared-window depth a little, so
    // it is not always a literal 100%). The >80% floor cleanly separates single-pass
    // (spends the trade) from the OLD two-pass gap-fill, which under this same drift
    // would have spent only ≈ baseline − drift ≈ 67% of amountIn.
    assert.ok(
      spent >= (amountIn * 80n) / 100n,
      `spends the large majority of the trade against the drifted price (spent ${spent} of ${amountIn})`,
    );
    assert.ok(driftedSqrt < BigInt(snap.sqrtPriceX96), "drift moved the live price below the prepared price");

    console.log(
      `  [prod-mirror] RUNTIME re-anchor (single-pass, input-anchored): ` +
        `drift ${driftAmount} then recipe spent ${spent} of amountIn ${amountIn} (baseline fill ${refV3}); ` +
        `tick ${driftedTick}->${afterTick}`,
    );
  });
});
