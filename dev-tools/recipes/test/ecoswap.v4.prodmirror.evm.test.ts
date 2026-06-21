/**
 * EcoSwap PROD-MIRROR (Uniswap V4) local EVM test — NO fork, NO live RPC.
 *
 * Replays a REAL Base Uniswap-V4 pool's tick state inside the ETCHED PoolManager:
 * the real PoolManager + StateView runtime are etched at their canonical addresses,
 * a pool is initialised at the snapshot price, and the snapshot's liquidity profile
 * is reconstructed (baseline + per-segment slabs via the V4 helper). The compiled
 * EcoSwap recipe then runs through it via the unified swap(SwapParams) / poolType=
 * UniV4 path — reading live price from StateView by poolId, exactly as on Base.
 *
 * Offline by design: loads a checked-in `ProdV4Snapshot` (fixtures/snapshots/
 * base-v4-*.json). Recapture with:
 *   BASE_RPC_URL=<url> npx tsx recipes/test/harness/v4-snapshot.ts
 *
 * Run: npx tsx --test recipes/test/ecoswap.v4.prodmirror.evm.test.ts
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
  deploySortedTokens,
  etchV4Singletons,
  mint,
  approve,
  balanceOf,
  getV4Slot0,
  type DeployedStack,
} from "./harness/setup";
import { reproduceV4Pool, verifyV4Reproduction, type ReproducedV4Pool } from "./harness/reproduce-v4-pool";
import type { ProdV4Snapshot } from "./harness/v4-snapshot";
import { getSqrtRatioAtTick, bracketCapacity, FEE_DENOM, isqrt } from "./ecoswap.math";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { driftPoolPrice } from "./harness/drift";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "fixtures", "snapshots");
const HUGE = parseEther("1000000000");

function loadSnapshot(): ProdV4Snapshot | null {
  let files: string[] = [];
  try {
    files = readdirSync(SNAPSHOT_DIR).filter((f) => /-v4-.*\.json$/.test(f));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(SNAPSHOT_DIR, files[0]), "utf-8")) as ProdV4Snapshot;
}

const snap = loadSnapshot();

describe("EcoSwap prod-mirror V4 (reproduced Base singleton pool)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let poolManager: Hex;
  let stateView: Hex;
  let tokenIn: Hex; // local token0 == snapshot currency0 (zeroForOne)
  let tokenOut: Hex; // local token1
  let repro: ReproducedV4Pool;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex; // pristine reconstructed state (for the drift case)

  before(async () => {
    if (!snap) return;
    console.log(
      `  [v4 prod-mirror] WETH/USDC fee=${snap.fee} tick=${snap.tick} ` +
        `activeLiquidity=${snap.liquidity}, ${snap.ticks.length} boundaries`,
    );

    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);

    const v4 = await etchV4Singletons(c.publicClient, c.testClient);
    poolManager = v4.poolManager;
    stateView = v4.stateView;

    // Local tokens sorted token0 < token1 (mapped to currency0/currency1). Decimals
    // don't affect fidelity — V4 swap math is over sqrtPrice + L.
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    repro = await reproduceV4Pool(
      c.walletClient, c.publicClient, poolManager, tokenIn, tokenOut, snap, HUGE,
    );

    poolConfig = {
      factories: [
        { address: poolManager, stateView, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Local UniV4 (prod-mirror)" },
      ],
      feeTiers: [snap.fee],
      baseTokens: [tokenIn, tokenOut],
    };

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  it("reproduces the snapshot's V4 slot0 + active liquidity", async () => {
    if (!snap) {
      console.log("  [v4 prod-mirror] no snapshot present — skipping");
      return;
    }
    const diff = await verifyV4Reproduction(c.publicClient, stateView, repro, snap);
    console.log(
      `  [v4 prod-mirror] reproduction: sqrtPriceMatch=${diff.sqrtPriceMatch} ` +
        `activeLiquidity snapshot=${diff.activeSnapshot} onchain=${diff.activeOnchain} match=${diff.activeLiquidityMatch} ` +
        `positions=${repro.positions.length}`,
    );
    assert.equal(diff.sqrtPriceMatch, true, "reproduced V4 sqrtPriceX96 must equal snapshot");
    if (!repro.baselineClamped) {
      assert.equal(diff.activeLiquidityMatch, true, "reproduced V4 active liquidity must equal snapshot");
    }
    assert.equal(diff.ok, true, "V4 reproduction must be faithful");
  });

  it("runs EcoSwap through the reproduced prod V4 pool", async () => {
    if (!snap) return;
    const caller = c.account0;

    // Size the trade to cross ~8 tickSpacings from the live price (bracket formula
    // with active L), comfortably inside the captured ±window.
    const sqrtNear = BigInt(snap.sqrtPriceX96); // zeroForOne: out/in == real sqrt
    const sqrtFar = getSqrtRatioAtTick(snap.tick - 8 * snap.tickSpacing);
    const amountIn = bracketCapacity(BigInt(snap.liquidity), sqrtNear, sqrtFar, snap.fee);
    assert.ok(amountIn > 0n, "computed a positive trade size");

    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn * 2n);
    await approve(c.walletClient, c.publicClient, tokenIn, stack.sauceRouter, amountIn);

    const pmInBefore = await balanceOf(c.publicClient, tokenIn, poolManager);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const before = await getV4Slot0(c.publicClient, stateView, repro.poolId);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, stack.sauceRouter, caller, poolConfig,
    );
    assert.equal(prepared.pools.filter((p) => p.poolType === SwapPoolType.UniV4).length, 1, "discovers the V4 pool");
    assert.ok(prepared.pools[0].poolId === repro.poolId, "prepared poolId matches reproduced pool");
    assert.ok(prepared.brackets.length > 0, "builds brackets from reconstructed V4 ticks");

    const { receipt } = await cook(c.walletClient, c.publicClient, stack.sauceRouter, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against reproduced V4 geometry");

    const pmInDelta = (await balanceOf(c.publicClient, tokenIn, poolManager)) - pmInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const after = await getV4Slot0(c.publicClient, stateView, repro.poolId);

    assert.ok(spent > 0n, "caller should spend tokenIn");
    assert.ok(received > 0n, "caller should receive tokenOut");
    assert.equal(pmInDelta, spent, "PoolManager tokenIn balance increases by spent");
    assert.ok(after.sqrtPriceX96 < before.sqrtPriceX96, "zeroForOne swap should lower the V4 price");
    assert.ok(after.tick < before.tick, `swap crosses reconstructed ticks (${before.tick} -> ${after.tick})`);

    // Oracle cross-check.
    const ref = ecoSwapReference(prepared, amountIn);
    const refIn = ref.perPoolInput[0] ?? 0n;
    if (refIn > 0n) {
      const diff = refIn > spent ? refIn - spent : spent - refIn;
      const rel = Number(diff) / Number(refIn > spent ? refIn : spent);
      assert.ok(rel < 0.15 || diff < parseEther("1"), `on-chain spend ${spent} vs oracle ${refIn} (rel ${rel})`);
    }

    console.log(
      `  [v4 prod-mirror] spent=${spent} received=${received} tick ${before.tick} -> ${after.tick}\n` +
        `       PoolManager tokenIn delta=${pmInDelta} oracle perPool[0]=${refIn}`,
    );
  });

  it("re-anchors to the live StateView price when the pool drifts after prepare", async () => {
    if (!snap) return;
    await c.testClient.revert({ id: cleanSnapshot });

    const caller = c.account0;
    const sqrtNear = BigInt(snap.sqrtPriceX96);
    const sqrtFar = getSqrtRatioAtTick(snap.tick - 8 * snap.tickSpacing);
    const amountIn = bracketCapacity(BigInt(snap.liquidity), sqrtNear, sqrtFar, snap.fee);

    // PREPARE against the clean (pre-drift) singleton state.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, stack.sauceRouter, caller, poolConfig,
    );
    const ref = ecoSwapReference(prepared, amountIn);
    const refV4 = ref.perPoolInput[0] ?? 0n;
    assert.ok(refV4 > 0n, "baseline allocates to the V4 pool");

    // DRIFT: push the V4 price down with a real swap of ~1/3 the baseline fill.
    const driftAmount = refV4 / 3n;
    await driftPoolPrice(c, stack.sauceRouter, prepared.pools[0], tokenIn, tokenOut, true, driftAmount, caller);
    const drifted = await getV4Slot0(c.publicClient, stateView, repro.poolId);

    // EXECUTE the pre-drift bytecodes — Phase B must read the NEW StateView price.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, stack.sauceRouter, amountIn);
    const pmInBefore = await balanceOf(c.publicClient, tokenIn, poolManager);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, stack.sauceRouter, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against drifted V4 price");

    const v4InDelta = (await balanceOf(c.publicClient, tokenIn, poolManager)) - pmInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const after = await getV4Slot0(c.publicClient, stateView, repro.poolId);

    const within = (a: bigint, b: bigint, tol: number) => {
      const hi = a > b ? a : b;
      const lo = a > b ? b : a;
      return hi === 0n ? true : Number(hi - lo) / Number(hi) < tol;
    };

    // Re-anchoring: the recipe filled only the REMAINING gap to the cut from the
    // drifted live price (drift + recipe ≈ baseline V4 fill).
    assert.ok(v4InDelta > 0n, "pool still participates");
    assert.ok(v4InDelta < refV4, `V4 fill adapts DOWN vs baseline (got ${v4InDelta}, baseline ${refV4})`);
    assert.ok(within(driftAmount + v4InDelta, refV4, 0.03), `drift(${driftAmount}) + recipe(${v4InDelta}) ≈ baseline (${refV4})`);
    assert.equal(v4InDelta, spent, "single pool → spent == its fill");
    assert.ok(spent <= amountIn, "never overspends");
    assert.ok(drifted.sqrtPriceX96 < sqrtNear, "drift moved the live price below the prepared price");

    // Despite the drift, the pool ends at the same fee-adjusted cut.
    const feeAdj = (after.sqrtPriceX96 * isqrt((FEE_DENOM - BigInt(snap.fee)) * FEE_DENOM)) / FEE_DENOM;
    const rel = ref.cutSqrtAdj === 0n ? 0 : Number(feeAdj > ref.cutSqrtAdj ? feeAdj - ref.cutSqrtAdj : ref.cutSqrtAdj - feeAdj) / Number(ref.cutSqrtAdj);
    assert.ok(rel < 0.01, `V4 re-anchored to the cut (feeAdj ${feeAdj} vs cut ${ref.cutSqrtAdj}, rel ${rel})`);

    console.log(
      `  [v4 prod-mirror] RUNTIME re-anchoring: drift ${driftAmount} + recipe ${v4InDelta} ≈ baseline ${refV4}; ` +
        `spent=${spent} tick ${drifted.tick}->${after.tick} feeAdj=${feeAdj} cut=${ref.cutSqrtAdj} (rel ${rel})`,
    );
  });
});
