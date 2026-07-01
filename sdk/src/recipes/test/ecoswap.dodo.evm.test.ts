/**
 * EcoSwap DODO V2 PMM local-EVM integration — the engine `_swapDODOV2` exact-in-dy gate.
 *
 * Stands up a local DODO V2 PMM pool (the DodoV2Pool.sol fixture, whose PMMPricing/DODOMath/
 * DecimalMath mirror the off-chain `dodo-math.ts` replay bit-for-bit), deploys the Sauce engine,
 * and cooks an EcoSwap whose static-segment cursor consumes DODO segments (segKind 3) and
 * executes them via the unified swap(SwapParams{poolType:5}) → live `_swapDODOV2` (one atomic
 * sellBase/sellQuote per venue, orientation resolved on-chain from _BASE_TOKEN_()). Then asserts:
 *
 *   (1) SOLO DODO venue — the on-chain dy the caller receives == off-chain getDy(awarded share)
 *       to the WEI (the exact-in-dy gate: one atomic sell lands exactly the segment-summed output
 *       the merge accounted for). NO tolerance. Cross-checked against the fixture's own pre-swap
 *       querySellBase view (engine-independent ground truth).
 *   (2) TWO DODO venues — ONE EcoSwap splits across both; each leg's received output ==
 *       getDy(its awarded share) to the wei.
 *
 * The PMM math is OFF-CHAIN only: the on-chain solver supplies DODO as STATIC (capacity,
 * marginalOI) segments and never recomputes the PMM integral. We build the prepared args DIRECTLY
 * (DODO discovery uses a registry whose addresses are placeholders), then compile the production
 * solver template exactly as index.ts does and cook it.
 *
 * No fork / no RPC env needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when
 * the v12 artifacts are present). Driven by ECO_ENGINE (default v12).
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
  deployDodoV2Pool,
  dodoAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getDy, buildDodoSegments, RState, DODO_ONE, type DodoPool } from "../shared/dodo-math.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const ONE = DODO_ONE;
const ENGINE_CELLS = engineCells();

// DODO-only run: zero direct pools/routes/netCache; the DODO venues ride entirely inside routeSegs
// (segKind 3). The solver's 9 compiler args, in index.ts order.
function dodoArgs(
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  segs: bigint[][],
): unknown[] {
  // The integration (multihop) solver signature is main(cfg, pools, netCache, routing, segs):
  //   cfg   = [tokenIn, tokenOut, amountIn, caller, priceLimit, directCount] — bundled scalars
  //   pools = [] (no direct venue) ; netCache = [] ; routing = [] (no routes)
  //   segs  = the 6-col sampled-segment rows the bestKind===1 cursor consumes (segKind 3 = DODO).
  return [
    [
      BigInt(tokenIn),
      BigInt(tokenOut),
      amountIn,
      BigInt(caller),
      MIN_SQRT_RATIO + 1n, // priceLimit (unused by DODO; the merge ignores it for static segs)
      0n, // directCount — no direct pools
    ],
    [], // pools
    [], // netCache
    [], // routing
    segs,
  ];
}

// One DODO venue → its sampled segments as routeSegs rows. refIdx tags the on-chain per-venue
// accumulator (dinp[refIdx]); venue is the sellBase/sellQuote pool address. Built from the SAME
// buildDodoSegments the oracle uses, so the awarded Σ == the off-chain share by construction.
// segKind = 3 (DODO); a DODO segment is a flat post-fee slice ⇒ sqrtAdjNear == sqrtAdjFar.
function dodoSegRows(pool: DodoPool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildDodoSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-fee; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (a DODO segment is a flat slice)
    3n, // segKind = DODO
    BigInt(pool.address),
    0n, // venueAux (segs[6]) — unused for non-Mento kinds; padded to mirror production's 7-col seg shape
  ]);
}

// Interleave + sort routeSegs rows the way index.ts buildRouteSegs does: DESC by sqrtAdjNear,
// then DESC by sqrtAdjFar, then by refIdx. The on-chain static-segment cursor consumes them in
// array order, so the global price order MUST be materialized here (multiple venues interleaved).
function sortRouteSegs(rows: bigint[][]): bigint[][] {
  return rows.slice().sort((a, b) => {
    if (a[2] !== b[2]) return a[2] < b[2] ? 1 : -1;
    if (a[3] !== b[3]) return a[3] < b[3] ? 1 : -1;
    return Number(a[0] - b[0]);
  });
}

describe("EcoSwap DODO V2 PMM (local fixture) — engine _swapDODOV2 exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
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

    // Plenty of both tokens for funding pools + the caller's input.
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

  // Off-chain DodoPool descriptor for the deployed fixture. tokenIn is the pool's base token
  // (so the trade is sellBase → tokenOut quote). Base-scarce (ABOVE_ONE) so the curve has the
  // monotone rebalancing region the segment ladder walks.
  function offPool(address: Hex, over: Partial<DodoPool>): DodoPool {
    return {
      poolType: 5,
      address,
      baseToken: tokenIn,
      quoteToken: tokenOut,
      sellBase: true,
      i: 2n * ONE,
      K: ONE / 5n,
      B: 800_000n * ONE,
      Q: 1_420_000n * ONE,
      B0: 1_000_000n * ONE,
      Q0: 1_000_000n * ONE,
      lpFeeRate: 3n * 10n ** 15n,
      mtFeeRate: 0n,
      feePpm: 3000,
      R: RState.ABOVE_ONE,
      source: "local-fixture",
      ...over,
    };
  }

  function deployParams(op: DodoPool) {
    return {
      base: op.baseToken,
      quote: op.quoteToken,
      i: op.i,
      K: op.K,
      B: op.B,
      Q: op.Q,
      B0: op.B0,
      Q0: op.Q0,
      lpFeeRate: op.lpFeeRate,
      mtFeeRate: op.mtFeeRate,
    };
  }

  // ── (1) SOLO DODO venue — received == getDy(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const op = offPool(("0x" + "00".repeat(20)) as Hex, {});
    const pool = await deployDodoV2Pool(c.walletClient, c.publicClient, deployParams(op), caller);
    const opOnChain: DodoPool = { ...op, address: pool };

    // amountIn sized within the rebalancing region (< B0−B = 200k base). The merge awards the
    // WHOLE Σ to this one venue, so the awarded share == amountIn and the executed sell is
    // getDy(amountIn). (DODO's squared-index grid reaches the full amountIn at the last sample.)
    const amountIn = 100_000n * ONE;
    const segRows = dodoSegRows(opOnChain, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty DODO segment ladder");

    const { bytecodes } = compileSauce(
      solverSrc, dodoArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    // The Σ capacity the segment ladder covers (the share the merge will award this solo venue).
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);

    // The fixture's own on-chain querySellBase view, read on the PRE-swap state (the sell mutates
    // reserves). Engine-independent ground truth for the executed dy of the awarded share.
    const onViewPre = (await c.publicClient.readContract({
      address: pool, abi: dodoAbi, functionName: "querySellBase", args: [segSum],
    })) as bigint;

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo DODO cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    // The awarded Σ flowed into the one DODO venue.
    assert.equal(spent, segSum, "spent == the awarded Σ (the whole trade routed to DODO)");
    assert.equal(poolIn, segSum, "the DODO pool received the full input share");

    // WEI-EXACT-IN-DY: the on-chain executed dy (the caller's received tokenOut) equals the
    // off-chain getDy(awarded share) to the WEI. One atomic sellBase. NO tolerance.
    assert.equal(received, getDy(opOnChain, spent), "received == getDy(share) to the wei (exact-in-dy)");
    // Cross-check against the fixture's own on-chain PRE-swap view (independent of the off-chain
    // replay) — the engine executed exactly this view's output, to the wei.
    assert.equal(received, onViewPre, "received == on-chain querySellBase view (exact-in-dy)");

    console.log(`  [DODO solo:${engine}] spent=${spent} received=${received} (== getDy to the wei)`);
  }

  // ── (2) TWO DODO venues — split + per-leg exact-in-dy ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two base-scarce venues at different guide prices / depth → different marginal curves, so the
    // water-fill engages BOTH. A is shallower + lower-fee (draws first); B is deeper.
    const opA = offPool(("0x" + "00".repeat(20)) as Hex, {
      i: 2n * ONE, K: ONE / 5n, B: 80_000n * ONE, Q: 142_000n * ONE,
      B0: 100_000n * ONE, Q0: 100_000n * ONE, lpFeeRate: 2n * 10n ** 15n, feePpm: 2000,
    });
    const opB = offPool(("0x" + "00".repeat(20)) as Hex, {
      i: (19n * ONE) / 10n, K: ONE / 4n, B: 170_000n * ONE, Q: 260_000n * ONE,
      B0: 200_000n * ONE, Q0: 200_000n * ONE, lpFeeRate: 3n * 10n ** 15n, feePpm: 3000,
    });
    const poolA = await deployDodoV2Pool(c.walletClient, c.publicClient, deployParams(opA), caller);
    const poolB = await deployDodoV2Pool(c.walletClient, c.publicClient, deployParams(opB), caller);
    const opAon: DodoPool = { ...opA, address: poolA };
    const opBon: DodoPool = { ...opB, address: poolB };

    const amountIn = 20_000n * ONE;
    // Each venue's segments capped at amountIn (the same bound the oracle samples). refIdx 0/1.
    // The solver's static-segment cursor walks routeSegs in array order assuming a global
    // DESCENDING price (sqrtAdjNear) order — so the two venues' segments must be INTERLEAVED and
    // sorted exactly as index.ts buildRouteSegs does (adjNear DESC, then adjFar DESC, then refIdx).
    const segRows = sortRouteSegs([
      ...dodoSegRows(opAon, 0, amountIn),
      ...dodoSegRows(opBon, 1, amountIn),
    ]);

    const { bytecodes } = compileSauce(
      solverSrc, dodoArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const aInBefore = await balanceOf(c.publicClient, tokenIn, poolA);
    const bInBefore = await balanceOf(c.publicClient, tokenIn, poolB);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue DODO cook() must succeed");

    const aIn = (await balanceOf(c.publicClient, tokenIn, poolA)) - aInBefore;
    const bIn = (await balanceOf(c.publicClient, tokenIn, poolB)) - bInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // BOTH venues funded (interior cut).
    assert.ok(aIn > 0n && bIn > 0n, `both DODO venues are funded (A ${aIn}, B ${bIn})`);

    // PER-LEG WEI-EXACT-IN-DY: the caller's received tokenOut == getDy_A(aIn) + getDy_B(bIn)
    // (each venue executes one atomic sellBase on its awarded share). NO tolerance.
    const expected = getDy(opAon, aIn) + getDy(opBon, bIn);
    assert.equal(received, expected, "received == Σ getDy(per-venue share) to the wei");

    console.log(
      `  [DODO split:${engine}] A in=${aIn} B in=${bIn} received=${received} (== Σ getDy to the wei)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`DODO solo [${engine}] — received == getDy(share) to the wei (exact-in-dy)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`DODO split [${engine}] — two venues, per-leg exact-in-dy`, { skip }, async () => {
      await runSplit(engine);
    });
  }
});
