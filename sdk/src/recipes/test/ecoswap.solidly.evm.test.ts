/**
 * EcoSwap Solidly STABLE (sAMM) local-EVM integration — the callback-free exact-in-dy gate.
 *
 * Stands up a local Solidly stable pool (the SolidlyStablePool.sol fixture, whose x3y+y3x invariant /
 * bounded-Newton getAmountOut mirror the off-chain `solidly-stable-math.ts` replay bit-for-bit),
 * deploys the Sauce engine, and cooks an EcoSwap whose static-segment cursor consumes Solidly-stable
 * segments (segKind 4) and executes them CALLBACK-FREE: an on-chain `pool.getAmountOut(awarded,
 * tokenIn)` staticcall + transfer + `pool.swap(a0, a1, to, "")` (NO engine SwapPoolType — a stable pool
 * is x3y+y3x, NOT xy=k, so it must NOT go through _swapV2). Then asserts:
 *
 *   (1) SOLO stable venue — the on-chain dy the caller receives == off-chain getAmountOutStable(awarded
 *       share) AND == the pool's own getAmountOut view to the WEI (the exact-in-dy gate: the pool view
 *       IS the swap math). NO tolerance.
 *   (2) TWO stable venues — ONE EcoSwap splits across both; each leg's received output ==
 *       getAmountOut(its awarded share) to the wei, and the post-fee marginals equalize within the
 *       sampled-grid bound (the documented exact-on-grid standard).
 *
 * The stable math is OFF-CHAIN only for the SPLIT: the on-chain solver supplies the curve as STATIC
 * (capacity, marginalOI) segments and never recomputes the invariant. We build the prepared args
 * DIRECTLY (Solidly discovery uses a factory whose addresses are placeholders here), then compile the
 * production solver template exactly as index.ts does and cook it.
 *
 * No fork / no RPC env needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when the v12
 * artifacts are present). Driven by ECO_ENGINE (default v12). Mirrors ecoswap.curve.evm.test.ts.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { compileSauce, ECOSWAP_DIR } from "./harness/compile";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  mint,
  approve,
  balanceOf,
  deploySolidlyStablePool,
  solidlyStableAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import {
  getAmountOutStable,
  buildSolidlyStableSegments,
  type SolidlyStablePool,
} from "../shared/solidly-stable-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const ENGINE_CELLS = engineCells();

// Solidly-stable-only run: zero direct pools/routes/netCache; the stable venues ride entirely inside
// segs (segKind 4). The solver's 5 compiler args, in index.ts order (cfg, pools, netCache, routing, segs).
function stableArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, segs: bigint[][]): unknown[] {
  return [
    [
      BigInt(tokenIn),
      BigInt(tokenOut),
      amountIn,
      BigInt(caller),
      MIN_SQRT_RATIO + 1n, // priceLimit (unused by static segments)
      0n, // directCount — no direct pools
    ],
    [], // pools
    [], // netCache
    [], // routing
    segs,
    [], // qlv — no QL (Quote-Ladder) descriptors in this static-segment universe
  ];
}

// One stable venue → its sampled segments as segs rows. refIdx tags the on-chain per-venue accumulator
// (sinp[refIdx]); venue is the pool address. Built from the SAME buildSolidlyStableSegments the oracle
// uses, so the awarded Σ == the off-chain share by construction. segKind = 4.
function stableSegRows(pool: SolidlyStablePool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildSolidlyStableSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-fee; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (a stable segment is a flat slice)
    4n, // segKind = Solidly stable (callback-free)
    BigInt(pool.address),
    0n, // venueAux (segs[6]) — unused for non-Mento kinds; padded to mirror production's 7-col seg shape
  ]);
}

// Interleave + sort segs rows the way index.ts buildSegs does: DESC by sqrtAdjNear, then DESC by
// sqrtAdjFar, then by refIdx. The on-chain static-segment cursor consumes them in array order, so the
// global price order MUST be materialized here.
function sortSegs(rows: bigint[][]): bigint[][] {
  return rows.slice().sort((a, b) => {
    if (a[2] !== b[2]) return a[2] < b[2] ? 1 : -1;
    if (a[3] !== b[3]) return a[3] < b[3] ? 1 : -1;
    return Number(a[0] - b[0]);
  });
}

describe("EcoSwap Solidly STABLE (sAMM, local fixture) — callback-free exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == token0 (lower address)
  let tokenOut: Hex; // == token1
  let solverSrc: string;
  // Each cell runs on its OWN fresh anvil + freshly-deployed stack (setup() below): no shared
  // mutable node state between cells, so there is no snapshot/loadState reset race (the old
  // revert+re-snapshot dance dropped a cell to a 0-fill; a bare loadState MERGES and drifts each
  // cell's pool address). reset() just tears the anvil down and rebuilds. See setup().

  // Boot a fresh anvil + deploy the whole stack. Called by before() once and by reset() before
  // every subsequent cell, tearing the prior anvil down first — so each cell is fully isolated.
  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;
    solverSrc = readFileSync(SOLVER, "utf-8");

    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, parseEther("50000000"));

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
  }

  before(setup);

  after(() => {
    anvil?.stop();
  });

  async function reset(): Promise<void> {
    await setup();
  }

  // Off-chain SolidlyStablePool descriptor for the deployed fixture (tokenIn = token0 ⇒ inIsToken0).
  function offPool(address: Hex, reserveIn: bigint, reserveOut: bigint, feePpm: number): SolidlyStablePool {
    return {
      address,
      reserveIn,
      reserveOut,
      decIn: E18,
      decOut: E18,
      token0: tokenIn,
      inIsToken0: true,
      feePpm,
      source: "local-fixture",
    };
  }

  // ── (1) SOLO stable venue — received == getAmountOut(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Imbalanced reserves, fee 0.01% (100 ppm — the canonical sAMM tier).
    const r0 = 1_000_000n * E18;
    const r1 = 1_200_000n * E18;
    const FEE = 100;
    const pool = await deploySolidlyStablePool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18, BigInt(FEE), r0, r1, caller,
    );
    const op = offPool(pool, r0, r1, FEE);

    // amountIn == the full sampled ladder cap ⇒ the merge awards the WHOLE Σ to this one venue.
    const amountIn = 100_000n * E18;
    const segRows = stableSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Solidly-stable segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    assert.equal(segSum, amountIn, "stable segments cover the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, stableArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    // The fixture's own on-chain getAmountOut view on the PRE-swap state — the engine-independent
    // ground truth for the executed dy of `amountIn`.
    const onViewPre = (await c.publicClient.readContract({
      address: pool, abi: solidlyStableAbi, functionName: "getAmountOut", args: [amountIn, tokenIn],
    })) as bigint;

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Solidly-stable cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (the whole trade routed to the stable pool)");
    assert.equal(poolIn, amountIn, "the stable pool received the full input share");

    // WEI-EXACT-IN-DY: the on-chain received tokenOut == off-chain getAmountOutStable(awarded share)
    // == the pool's own PRE-swap getAmountOut view, all to the WEI. NO tolerance.
    assert.equal(received, getAmountOutStable(op, spent), "received == getAmountOutStable(share) to the wei");
    assert.equal(received, onViewPre, "received == on-chain getAmountOut view (exact-in-dy)");

    console.log(`  [Solidly solo:${engine}] spent=${spent} received=${received} (== getAmountOut to the wei)`);
  }

  // ── (2) TWO stable venues — split + per-leg exact-in-dy + marginals equalize ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues at the SAME spot (balanced 1:1) but different fee / depth → different marginal
    // curves, so the water-fill engages BOTH and equalizes their post-fee marginals.
    const aR0 = 2_000_000n * E18, aR1 = 2_000_000n * E18, FA = 100; // deep, low fee → draws first + more
    const bR0 = 1_000_000n * E18, bR1 = 1_000_000n * E18, FB = 500; // shallower, higher fee
    const poolA = await deploySolidlyStablePool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18, BigInt(FA), aR0, aR1, caller,
    );
    const poolB = await deploySolidlyStablePool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18, BigInt(FB), bR0, bR1, caller,
    );
    const opA = offPool(poolA, aR0, aR1, FA);
    const opB = offPool(poolB, bR0, bR1, FB);

    const amountIn = 800_000n * E18;
    const segRows = sortSegs([...stableSegRows(opA, 0, amountIn), ...stableSegRows(opB, 1, amountIn)]);

    const { bytecodes } = compileSauce(
      solverSrc, stableArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const aInBefore = await balanceOf(c.publicClient, tokenIn, poolA);
    const bInBefore = await balanceOf(c.publicClient, tokenIn, poolB);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue Solidly-stable cook() must succeed");

    const aIn = (await balanceOf(c.publicClient, tokenIn, poolA)) - aInBefore;
    const bIn = (await balanceOf(c.publicClient, tokenIn, poolB)) - bInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(aIn > 0n && bIn > 0n, "both stable venues are funded");
    assert.ok(aIn > bIn, `deep/low-fee venue A draws more than B (A ${aIn} > B ${bIn})`);

    // PER-LEG WEI-EXACT-IN-DY: received == getAmountOut_A(aIn) + getAmountOut_B(bIn). NO tolerance.
    const expected = getAmountOutStable(opA, aIn) + getAmountOutStable(opB, bIn);
    assert.equal(received, expected, "received == Σ getAmountOut(per-venue share) to the wei");

    // MARGINALS EQUALIZE within the GRID bound. The SPLIT is exact-on-grid (the awarded inputs equal
    // the oracle bit-for-bit — checked by the wei-exact gate above), but the realized post-fee marginal
    // each venue reaches equalizes only to within ONE sampled segment's price width. The sAMM curve is
    // very FLAT near peg, so a single M=24 segment spans a wider price band than a steeper curve would:
    // the measured cut gap is ≈2000 ppm at M=24 and converges (≈500 ppm at M=200) as the grid tightens —
    // the documented exact-on-grid standard (the SPLIT is exact; the marginal equalizes to the grid).
    const margA = marginalAt(opA, aIn);
    const margB = marginalAt(opB, bIn);
    const diff = margA > margB ? margA - margB : margB - margA;
    const relPpm = margA > 0n ? (diff * 1_000_000n) / margA : 0n;
    assert.ok(relPpm <= 2500n, `Solidly split marginals equalize on the M=24 grid (rel ${relPpm} ppm; A ${margA} B ${margB})`);

    console.log(
      `  [Solidly split:${engine}] A in=${aIn} B in=${bIn} received=${received} ` +
        `(== Σ getAmountOut to the wei); marginals A=${margA} B=${margB} (${relPpm} ppm)`,
    );
  }

  // Post-fee out/in marginal price at a cumulative input `share` — a small finite-difference slice of
  // getAmountOutStable around `share` (the same coordinate the segments carry). Used only to check the
  // split equalized marginals.
  function marginalAt(pool: SolidlyStablePool, share: bigint): bigint {
    if (share <= 0n) return 0n;
    const eps = share / 1000n > 0n ? share / 1000n : 1n;
    const lo = share - eps > 0n ? share - eps : 0n;
    const dIn = share - lo;
    const dOut = getAmountOutStable(pool, share) - getAmountOutStable(pool, lo);
    if (dIn <= 0n || dOut <= 0n) return 0n;
    return isqrt((dOut * (1n << 192n)) / dIn);
  }
  function isqrt(x: bigint): bigint {
    if (x <= 0n) return 0n;
    let z = x;
    let y = (z + 1n) / 2n;
    while (y < z) {
      z = y;
      y = (x / y + y) / 2n;
    }
    return z;
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Solidly stable solo [${engine}] — received == getAmountOut(share) to the wei (exact-in-dy)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Solidly stable split [${engine}] — two venues, per-leg exact-in-dy + marginals equalize`, { skip }, async () => {
      await runSplit(engine);
    });
  }
});
