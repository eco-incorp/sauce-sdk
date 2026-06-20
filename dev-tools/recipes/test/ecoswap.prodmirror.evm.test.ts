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
import { parseEther, type Hex } from "viem";

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
} from "./harness/setup";
import {
  reproducePool,
  verifyReproduction,
  type ReproducedPool,
  type ReproductionDiff,
} from "./harness/reproduce-pool";
import type { ProdPoolSnapshot } from "./harness/prod-snapshot";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "fixtures", "snapshots");
const SYNTHETIC = "synthetic-wethusdc-500.json";

const HUGE = parseEther("1000000000");

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
  let snap: ProdPoolSnapshot;
  let synthetic: boolean;
  let repro: ReproducedPool;
  let diff: ReproductionDiff;

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
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);

    // Reproduce the prod pool locally from the snapshot.
    repro = await reproducePool(
      c.walletClient,
      c.publicClient,
      stack.factory,
      stack.helper,
      snap,
      HUGE,
    );
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
    await approve(c.walletClient, c.publicClient, tokenIn, stack.sauceRouter, amountIn);

    const poolInBefore = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const poolOutBefore = await balanceOf(c.publicClient, tokenOut, repro.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { tick: tickBefore } = await getSlot0(c.publicClient, repro.pool);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      stack.sauceRouter,
      caller,
      poolConfig,
    );

    const v3Count = prepared.pools.filter((p) => !p.isV2).length;
    assert.equal(v3Count, 1, "should discover exactly the 1 reproduced V3 pool");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    assert.ok(prepared.brackets.length > 0, "should build brackets from reconstructed ticks");
    assert.ok(prepared.zeroForOne, "tokenIn < tokenOut → zeroForOne");

    const { receipt } = await cook(c.walletClient, c.publicClient, stack.sauceRouter, bytecodes);
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
});
