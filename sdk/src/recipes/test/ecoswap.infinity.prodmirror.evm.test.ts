/**
 * EcoSwap PROD-MIRROR (PancakeSwap Infinity CL) local EVM test — NO fork, NO live RPC.
 *
 * Replays the REAL BSC USDT/Beat pool (the venue's #1 TVL pool — hookless, fee 67 static,
 * ts 1, packed protocolFee 32|32) inside the ETCHED GENUINE singletons: the real Vault +
 * CLPoolManager + CLTickLens runtime are etched at their canonical (create3) addresses, the
 * pool is initialized at the snapshot price, its packed protocol fee is reproduced through
 * the REAL setProtocolFee (controller-slot poke), and the snapshot's SPARSE 34-boundary tick
 * profile is reconstructed (baseline + per-segment slabs via the Vault-lock helper). The
 * compiled EcoSwap recipe then runs discovery → walk → cook through the flat swapInfinityCL
 * path — reading live price + combining the live per-direction fee from the CLPoolManager by
 * poolId, exactly as on BSC. The engine fork tests prove the SWAP path against real pools;
 * this proves the RECIPE's walk math (fee combine + getPoolTickInfo boundary reads + net-cache
 * discipline) against the real tick profile.
 *
 * Offline by design: loads the checked-in `ProdInfinitySnapshot`
 * (fixtures/snapshots/bsc-infinity-*.json). Recapture with:
 *   BSC_RPC_URL=<url> npx tsx src/recipes/test/harness/infinity-snapshot.ts
 *
 * Run: ECO_ENGINE=both npx tsx --test src/recipes/test/ecoswap.infinity.prodmirror.evm.test.ts
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
  deploySortedTokens,
  etchInfinitySingletons,
  getInfinitySlot0,
  mint,
  approve,
  balanceOf,
  type DeployedStack,
  type DeployedV12Stack,
  type InfinitySingletons,
} from "./harness/setup";
import {
  reproduceInfinityPool,
  verifyInfinityReproduction,
  type ReproducedInfinityPool,
} from "./harness/reproduce-infinity-pool";
import { withCachedState } from "./harness/state-cache";
import type { ProdInfinitySnapshot } from "./harness/infinity-snapshot";
import { getSqrtRatioAtTick, bracketCapacity } from "./ecoswap.math";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { combineInfinityFee } from "../shared/infinity-math";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { driftPoolPrice } from "./harness/drift";
import { type Engine, selectedEngines, maybeDeployV12Stack, cookTarget } from "./harness/engine";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "fixtures", "snapshots");
const HUGE = parseEther("1000000000");

// Single engine for this heavy prod-mirror suite (ECO_ENGINE, default v12).
const PROD_ENGINE: Engine = selectedEngines()[0];

// The USDT/Beat profile is SPARSE at ts=1 (the nearest initialized boundary sits ~700 raw
// ticks below the live tick), so the default 256-tick lens band would never reach a real
// boundary. Widen the per-pool band so the lens window + the walk CROSS genuine boundaries
// (the wei-exact gate then exercises real net-cache rows, not just constant-L strides).
const LENS_TICKS = 1024;

function loadSnapshot(): ProdInfinitySnapshot | null {
  let files: string[] = [];
  try {
    files = readdirSync(SNAPSHOT_DIR).filter((f) => /^bsc-infinity-.*\.json$/.test(f));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(SNAPSHOT_DIR, files[0]), "utf-8")) as ProdInfinitySnapshot;
}

const snap = loadSnapshot();

describe("EcoSwap prod-mirror Infinity CL (reproduced BSC USDT/Beat pool)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let inf: InfinitySingletons;
  let tokenIn: Hex; // local token0 == snapshot currency0 (zeroForOne — USDT side)
  let tokenOut: Hex; // local token1 (Beat side)
  let repro: ReproducedInfinityPool;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  before(async () => {
    if (!snap) return;
    console.log(
      `  [infinity prod-mirror] ${snap.symbol0}/${snap.symbol1} fee=${snap.fee} ts=${snap.tickSpacing} ` +
        `protocolFee=${snap.protocolFee} tick=${snap.tick} activeLiquidity=${snap.liquidity}, ` +
        `${snap.ticks.length} boundaries`,
    );

    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);

    // Full deploy + reconstruction, cached once per engine
    // (fixtures/anvil-state/prodmirror-infinity-<engine>). Recapture: RECAPTURE_ANVIL_STATE=1.
    const { manifest, fromCache } = await withCachedState<{
      stack: DeployedStack;
      v12: DeployedV12Stack | null;
      inf: InfinitySingletons;
      tokenIn: Hex;
      tokenOut: Hex;
      repro: ReproducedInfinityPool;
    }>({
      name: "prodmirror-infinity",
      engine: PROD_ENGINE,
      c,
      build: async () => {
        await ensureMulticall3(c.publicClient, c.testClient);
        const s = await deployStack(c.walletClient, c.publicClient);
        const infs = await etchInfinitySingletons(c.publicClient, c.testClient);
        // Local tokens sorted token0 < token1 (mapped to currency0/currency1).
        // Decimals don't affect fidelity — CL swap math is over sqrtPrice + L.
        const tk = await deploySortedTokens(c.walletClient, c.publicClient);
        const r = await reproduceInfinityPool(
          c.walletClient, c.publicClient, c.testClient, infs.vault, infs.clPoolManager,
          tk.token0, tk.token1, snap!, HUGE, c.account0,
        );
        const v = await maybeDeployV12Stack(c, c.walletClient.account as Account);
        if (v) await approve(c.walletClient, c.publicClient, tk.token0, v.pot, HUGE);
        return {
          stack: s, v12: v, inf: infs, tokenIn: tk.token0, tokenOut: tk.token1, repro: r,
        };
      },
    });
    console.log(
      `  [infinity prod-mirror] state ${fromCache ? "LOADED from cache" : "RECONSTRUCTED + cached"} (engine ${PROD_ENGINE})`,
    );
    stack = manifest.stack;
    v12 = manifest.v12;
    inf = manifest.inf;
    tokenIn = manifest.tokenIn;
    tokenOut = manifest.tokenOut;
    repro = manifest.repro;

    poolConfig = {
      factories: [
        {
          address: inf.clPoolManager,
          poolType: SwapPoolType.PancakeInfinityCL,
          factoryType: FactoryType.PancakeInfinityCL,
          label: "Local Infinity CL (prod-mirror)",
          infinityVault: inf.vault,
          infinityTickLens: inf.clTickLens,
          infinityPresets: [{ fee: snap!.fee, tickSpacing: snap!.tickSpacing }],
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  it("reproduces the snapshot's slot0 (price + BOTH fee words) + active liquidity", async () => {
    if (!snap) {
      console.log("  [infinity prod-mirror] no snapshot present — skipping");
      return;
    }
    const diff = await verifyInfinityReproduction(c.publicClient, inf.clPoolManager, repro, snap);
    console.log(
      `  [infinity prod-mirror] reproduction: sqrtPriceMatch=${diff.sqrtPriceMatch} ` +
        `protocolFeeMatch=${diff.protocolFeeMatch} lpFeeMatch=${diff.lpFeeMatch} ` +
        `activeLiquidity snapshot=${diff.activeSnapshot} onchain=${diff.activeOnchain} ` +
        `match=${diff.activeLiquidityMatch} positions=${repro.positions.length}`,
    );
    assert.equal(diff.sqrtPriceMatch, true, "reproduced sqrtPriceX96 must equal snapshot");
    assert.equal(diff.protocolFeeMatch, true, "reproduced packed protocolFee must equal snapshot");
    assert.equal(diff.lpFeeMatch, true, "reproduced lpFee must equal snapshot");
    if (!repro.baselineClamped) {
      assert.equal(diff.activeLiquidityMatch, true, "reproduced active liquidity must equal snapshot");
    }
    assert.equal(diff.ok, true, "Infinity reproduction must be faithful");
  });

  it("runs EcoSwap through the reproduced prod Infinity pool — wei-exact vs the reference", async () => {
    if (!snap) return;
    const target = cookTarget(PROD_ENGINE, stack, v12);
    const caller = c.account0;

    // Size the trade to cross REAL boundaries: from the live price down past the first
    // initialized boundary below spot (the real profile's nearest net), priced with the LIVE
    // combined fee (prot ⊕ lp — the same number the solver combines on-chain).
    const combinedFee = combineInfinityFee(snap.protocolFee, snap.lpFee, true);
    const below = snap.ticks.map(([t]) => t).filter((t) => t < snap.tick);
    assert.ok(below.length > 0, "snapshot carries at least one boundary below spot");
    const firstBoundary = Math.max(...below);
    const targetTick = firstBoundary - 8 * snap.tickSpacing; // 8 ts past the first real boundary
    const sqrtNear = BigInt(snap.sqrtPriceX96);
    const sqrtFar = getSqrtRatioAtTick(targetTick);
    const amountIn = bracketCapacity(BigInt(snap.liquidity), sqrtNear, sqrtFar, combinedFee);
    assert.ok(amountIn > 0n, "computed a positive trade size");

    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn * 2n);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

    const vaultInBefore = await balanceOf(c.publicClient, tokenIn, inf.vault);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const before = await getInfinitySlot0(c.publicClient, inf.clPoolManager, repro.poolId);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(PROD_ENGINE, stack, v12),
      caller, poolConfig, { maxTicks: LENS_TICKS, bandTicks: LENS_TICKS }, PROD_ENGINE,
    );
    const infPools = prepared.pools.filter((p) => p.poolType === SwapPoolType.PancakeInfinityCL);
    assert.equal(infPools.length, 1, "discovers the Infinity pool");
    assert.equal(infPools[0].poolId, repro.poolId, "prepared poolId matches the reproduction");
    assert.equal(infPools[0].fee, snap.fee, "prepared keeps the KEY fee");
    assert.equal(infPools[0].feePpm, combinedFee, "prepared feePpm = the LIVE combined fee");
    assert.ok((infPools[0].windowTopShifted ?? 0n) > 0n, "builds a net-cache window from real ticks");
    assert.ok(
      (infPools[0].netRows?.length ?? 0) > 0,
      "the widened band captures REAL initialized boundaries in the cache",
    );

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against reproduced Infinity geometry");

    const vaultDelta = (await balanceOf(c.publicClient, tokenIn, inf.vault)) - vaultInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const after = await getInfinitySlot0(c.publicClient, inf.clPoolManager, repro.poolId);

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    assert.equal(vaultDelta, spent, "the Vault absorbs the exact input (funds custody)");
    assert.ok(after.sqrtPriceX96 < before.sqrtPriceX96, "zeroForOne swap lowers the price");
    assert.ok(after.tick <= firstBoundary, `walk crossed the REAL boundary (${before.tick} -> ${after.tick})`);

    // WEI-EXACT vs the reference (deterministic local state == prepared state).
    const ref = ecoSwapReference(prepared, amountIn);
    assert.equal(spent, ref.totalInput, "spent == reference totalInput EXACTLY");
    console.log(
      `  [infinity prod-mirror] spent=${spent} received=${received} tick ${before.tick} -> ${after.tick}\n` +
        `       vault tokenIn delta=${vaultDelta} reference total=${ref.totalInput} (wei-exact)`,
    );
  });

  it("re-anchors to the live CLPoolManager price when the pool drifts after prepare", async () => {
    if (!snap) return;
    const target = cookTarget(PROD_ENGINE, stack, v12);
    await c.testClient.revert({ id: cleanSnapshot });

    const caller = c.account0;
    const combinedFee = combineInfinityFee(snap.protocolFee, snap.lpFee, true);
    const sqrtNear = BigInt(snap.sqrtPriceX96);
    const sqrtFar = getSqrtRatioAtTick(snap.tick - 400 * snap.tickSpacing);
    const amountIn = bracketCapacity(BigInt(snap.liquidity), sqrtNear, sqrtFar, combinedFee);

    // PREPARE against the clean (pre-drift) reconstructed state.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(PROD_ENGINE, stack, v12),
      caller, poolConfig, { maxTicks: LENS_TICKS, bandTicks: LENS_TICKS }, PROD_ENGINE,
    );
    const pInf = prepared.pools.find((p) => p.poolType === SwapPoolType.PancakeInfinityCL)!;
    const before = await getInfinitySlot0(c.publicClient, inf.clPoolManager, repro.poolId);

    // DRIFT: push the price down with a REAL engine-routed swapInfinityCL swap of ~1/3 the trade.
    await driftPoolPrice(
      c, stack.sauceRouter, pInf, tokenIn, tokenOut, true, amountIn / 3n, caller,
      undefined, inf.vault,
    );
    const drifted = await getInfinitySlot0(c.publicClient, inf.clPoolManager, repro.poolId);
    assert.ok(drifted.sqrtPriceX96 < before.sqrtPriceX96, "drift moved the live price down");

    // EXECUTE the pre-drift bytecodes — SETUP must read the NEW live slot0 (+ live fee words).
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the drifted price");
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const after = await getInfinitySlot0(c.publicClient, inf.clPoolManager, repro.poolId);

    // Single-pass (input-anchored): the solver deploys the large majority of the trade against
    // the LIVE drifted price (the drift trimmed the prepared-window depth a little).
    assert.ok(spent >= (amountIn * 80n) / 100n, `spends the large majority (${spent} of ${amountIn})`);
    assert.ok(spent <= amountIn, "never overspends");
    assert.ok(after.sqrtPriceX96 < drifted.sqrtPriceX96, "the cook pushed past the drifted price");

    console.log(
      `  [infinity prod-mirror] RUNTIME re-anchor: drift ${amountIn / 3n} then recipe spent ${spent} ` +
        `of ${amountIn}; tick ${before.tick} -> ${drifted.tick} -> ${after.tick}`,
    );
  });
});
