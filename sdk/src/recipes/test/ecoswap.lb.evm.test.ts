/**
 * EcoSwap Trader Joe LB (Liquidity Book) local-EVM integration — the engine `_swapTraderJoeLB`
 * exact-out gate.
 *
 * Stands up a local LB pair (the TraderJoeLBPair.sol fixture, whose getPriceFromId 128.128 pow +
 * constant-sum per-bin drain + static base fee mirror the off-chain `lb-math.ts` replay
 * bit-for-bit), deploys the Sauce engine, and cooks an EcoSwap whose static-segment cursor
 * consumes LB segments (segKind 2) and executes them via the unified swap(SwapParams{poolType:6})
 * → live `_swapTraderJoeLB` (one atomic transfer-first `pool.swap(swapForY, recipient)` per venue,
 * orientation resolved on-chain from `getTokenX()`). Then asserts:
 *
 *   (1) SOLO LB venue — the on-chain output the caller receives == off-chain getSwapOut(awarded
 *       share) to the WEI (LB bins are constant-sum at fixed prices, so the realized output is
 *       EXACT for the share — no curvature, no sampling error). NO tolerance. Cross-checked against
 *       the fixture's own pre-swap getSwapOut view (engine-independent ground truth).
 *   (2) TWO LB venues — ONE EcoSwap splits across both; each leg's received output ==
 *       getSwapOut(its awarded share) to the wei, and the cheaper (tighter-step) venue draws more.
 *
 * The LB bin math is OFF-CHAIN only: the on-chain solver supplies LB as STATIC per-bin (capacity,
 * marginalOI) flat segments and never recomputes the bin price. We build the prepared args DIRECTLY
 * (LB discovery uses a factory whose addresses are placeholders here), then compile the production
 * solver template exactly as index.ts does and cook it.
 *
 * No fork / no RPC env needed — a local fixture deploys the whole stack. Runs on v1 (+ v12 when the
 * v12 artifacts are present). Driven by ECO_ENGINE (default v12).
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
  deployLBPair,
  lbPairAbi,
  type LbBinSeed,
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
import { getSwapOut, buildLbSegments, type LbPool } from "../shared/lb-math.js";
import { SwapPoolType } from "../shared/constants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const ANCHOR = 1 << 23; // LB id of price 1.0
const ENGINE_CELLS = engineCells();

// LB-only run: zero direct pools/routes/netCache; the LB venues ride entirely inside segs
// (segKind 2). The solver's 6-arg integration signature, in index.ts order.
function lbArgs(
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  segs: bigint[][],
): unknown[] {
  // main(cfg, pools, netCache, routing, segs, qlv):
  //   cfg   = [tokenIn, tokenOut, amountIn, caller, priceLimit, directCount] — bundled scalars
  //   pools = [] (no direct venue) ; netCache = [] ; routing = [] (no routes)
  //   segs  = the 6-col sampled-segment rows the bestKind===1 cursor consumes (segKind 2 = LB).
  //   qlv   = [] (no QL Quote-Ladder descriptors — LB is a static sampled venue).
  return [
    [
      BigInt(tokenIn),
      BigInt(tokenOut),
      amountIn,
      BigInt(caller),
      MIN_SQRT_RATIO + 1n, // priceLimit (unused by LB; the merge ignores it for static segs)
      0n, // directCount — no direct pools
    ],
    [], // pools
    [], // netCache
    [], // routing
    segs,
    [], // qlv — no QL (Quote-Ladder) descriptors in this static-segment universe
  ];
}

// One LB venue → its per-bin flat segments as routeSegs rows. refIdx tags the on-chain per-venue
// accumulator; venue is the pair address. Built from the SAME buildLbSegments the oracle uses, so
// the awarded Σ == the off-chain share by construction. segKind = 2 (LB); an LB bin is a flat
// constant-sum slice ⇒ sqrtAdjNear == sqrtAdjFar.
function lbSegRows(pool: LbPool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildLbSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-fee; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (an LB bin is a flat slice)
    2n, // segKind = LB
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

describe("EcoSwap Trader Joe LB (local fixture) — engine _swapTraderJoeLB exact-out", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // = tokenX of every LB pair (swapForY: X → Y)
  let tokenOut: Hex; // = tokenY
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

  // Off-chain LbPool descriptor for a deployed fixture. tokenIn is the pair's tokenX, so the trade
  // is swapForY (X → Y). Bins span both sides of the active id, each holding the same per-bin
  // reserve in both tokens (uniform capacity; the only price variation is the bin step).
  function makeLb(opts: {
    address: Hex;
    binStep: number;
    baseFactor?: number;
    activeId?: number;
    count?: number;
    reserve?: bigint;
  }): { off: LbPool; bins: LbBinSeed[]; activeId: number } {
    const activeId = opts.activeId ?? ANCHOR;
    const count = opts.count ?? 24;
    const baseFactor = opts.baseFactor ?? 5000;
    const reserve = opts.reserve ?? E18;
    const bins: LbBinSeed[] = [];
    for (let id = activeId - count; id <= activeId + count; id++) {
      bins.push({ id, reserveX: reserve, reserveY: reserve });
    }
    const off: LbPool = {
      poolType: SwapPoolType.TraderJoeLB,
      address: opts.address,
      binStep: opts.binStep,
      baseFactor,
      activeId,
      swapForY: true, // tokenIn == tokenX
      bins: bins.map((b) => ({ id: b.id, reserveX: b.reserveX, reserveY: b.reserveY })),
      source: "local-fixture",
    };
    return { off, bins, activeId };
  }

  // ── (1) SOLO LB venue — received == getSwapOut(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // 0.20% bin step, small per-bin reserves so a moderate amountIn spans several bins.
    const m = makeLb({ address: ("0x" + "00".repeat(20)) as Hex, binStep: 20, count: 24, reserve: E18 });
    const pair = await deployLBPair(
      c.walletClient, c.publicClient, tokenIn, tokenOut, m.off.binStep, m.off.baseFactor, m.activeId, m.bins, caller,
    );
    const op: LbPool = { ...m.off, address: pair };

    // amountIn sized to consume several bins but stay within the seeded book. The seg ladder
    // covers AT LEAST amountIn (the last bin enters whole once cumulative capacity tips over), so
    // with only one venue the merge fills up to the full amountIn and the executed swap is
    // getSwapOut(amountIn). (Unlike a sampled grid, the LB per-bin Σ can EXCEED amountIn by the
    // last bin's slack — the merge still caps the spend at amountIn.)
    const amountIn = 8n * E18;
    const segRows = lbSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty LB segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    assert.ok(segSum >= amountIn, "LB seg ladder covers at least amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, lbArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pair);

    // The fixture's own on-chain getSwapOut view, read on the PRE-swap state (the swap mutates
    // bins). Engine-independent ground truth for the executed output of the full amountIn.
    const onViewPre = (await c.publicClient.readContract({
      address: pair, abi: lbPairAbi, functionName: "getSwapOut", args: [amountIn, true],
    })) as bigint;

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo LB cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pair)) - poolInBefore;

    // The whole amountIn flowed into the one LB venue (the merge caps the spend at amountIn).
    assert.equal(spent, amountIn, "spent == amountIn (the whole trade routed to LB)");
    assert.equal(poolIn, amountIn, "the LB pair received the full input share");

    // WEI-EXACT-OUT: the on-chain executed output (the caller's received tokenOut) equals the
    // off-chain getSwapOut(awarded share) to the WEI. One atomic pool.swap. NO tolerance.
    assert.equal(received, getSwapOut(op, spent), "received == getSwapOut(share) to the wei (exact-out)");
    // Cross-check against the fixture's own on-chain PRE-swap view (independent of the off-chain
    // replay) — the engine executed exactly this view's output, to the wei.
    assert.equal(received, onViewPre, "received == on-chain getSwapOut view (exact-out)");

    console.log(`  [LB solo:${engine}] spent=${spent} received=${received} (== getSwapOut to the wei)`);
  }

  // ── (2) TWO LB venues — split + per-leg exact-out ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Same per-bin reserves + same active spot (price 1.0); the ONLY difference is binStep → the
    // tighter-step pair has the higher fee-adjusted marginal (smaller fee + slower price decay),
    // so it fills first; small per-bin reserves force its near bins to run out and the wider pair
    // to take a slice. Two distinct local fixtures.
    const mTight = makeLb({ address: ("0x" + "00".repeat(20)) as Hex, binStep: 5, count: 32, reserve: E18 });
    const mWide = makeLb({ address: ("0x" + "00".repeat(20)) as Hex, binStep: 50, count: 32, reserve: E18 });
    const pairTight = await deployLBPair(
      c.walletClient, c.publicClient, tokenIn, tokenOut, mTight.off.binStep, mTight.off.baseFactor, mTight.activeId, mTight.bins, caller,
    );
    const pairWide = await deployLBPair(
      c.walletClient, c.publicClient, tokenIn, tokenOut, mWide.off.binStep, mWide.off.baseFactor, mWide.activeId, mWide.bins, caller,
    );
    const opTight: LbPool = { ...mTight.off, address: pairTight };
    const opWide: LbPool = { ...mWide.off, address: pairWide };

    const amountIn = 20n * E18;
    // Each venue's segments capped at amountIn (the same bound the oracle samples). refIdx 0/1.
    // The solver's static-segment cursor walks routeSegs in array order assuming a global
    // DESCENDING price (sqrtAdjNear) order — so the two venues' segments must be INTERLEAVED and
    // sorted exactly as index.ts buildRouteSegs does (adjNear DESC, then adjFar DESC, then refIdx).
    const segRows = sortRouteSegs([
      ...lbSegRows(opTight, 0, amountIn),
      ...lbSegRows(opWide, 1, amountIn),
    ]);

    const { bytecodes } = compileSauce(
      solverSrc, lbArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const tInBefore = await balanceOf(c.publicClient, tokenIn, pairTight);
    const wInBefore = await balanceOf(c.publicClient, tokenIn, pairWide);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue LB cook() must succeed");

    const tIn = (await balanceOf(c.publicClient, tokenIn, pairTight)) - tInBefore;
    const wIn = (await balanceOf(c.publicClient, tokenIn, pairWide)) - wInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // BOTH venues funded (interior cut); the tighter-step venue draws strictly more.
    assert.ok(tIn > 0n && wIn > 0n, `both LB venues are funded (tight ${tIn}, wide ${wIn})`);
    assert.ok(tIn > wIn, `tighter-step LB draws more (${tIn} > ${wIn})`);

    // PER-LEG WEI-EXACT-OUT: the caller's received tokenOut == getSwapOut_tight(tIn) +
    // getSwapOut_wide(wIn) (each venue executes one atomic swap on its awarded share). NO tolerance.
    const expected = getSwapOut(opTight, tIn) + getSwapOut(opWide, wIn);
    assert.equal(received, expected, "received == Σ getSwapOut(per-venue share) to the wei");

    console.log(
      `  [LB split:${engine}] tight in=${tIn} wide in=${wIn} received=${received} (== Σ getSwapOut to the wei)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`LB solo [${engine}] — received == getSwapOut(share) to the wei (exact-out)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`LB split [${engine}] — two venues, per-leg exact-out`, { skip }, async () => {
      await runSplit(engine);
    });
  }
});
