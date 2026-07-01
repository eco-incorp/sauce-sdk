/**
 * EcoSwap Maverick V2 (bin-based directional AMM) local-EVM integration — the engine `_swapMaverickV2`
 * + `maverickV2SwapCallback` exact-in-dy gate.
 *
 * Stands up a local Maverick V2 pool (the MaverickV2Pool.sol fixture, whose TickMath/SwapMath + tick
 * walk mirror the off-chain `maverick-math.ts` replay bit-for-bit), deploys the Sauce engine, and cooks
 * an EcoSwap whose static-segment cursor consumes Maverick segments (segKind 8) and executes them via the
 * unified swap(SwapParams{poolType:7}) → live `_swapMaverickV2`. Maverick is a CALLBACK pool: the engine
 * reads the pool's tokenA(), sets tokenAIn, calls pool.swap(recipient, SwapParams{amount, tokenAIn,
 * exactOutput:false, tickLimit:0}, ""), and the pool re-enters the engine's `maverickV2SwapCallback` to
 * PULL the input mid-swap — so it MUST execute through the engine Router (NOT the callback-free path).
 * Then asserts:
 *
 *   (1) SOLO Maverick venue — the on-chain dy the caller receives == off-chain getDy(awarded share) AND
 *       == the fixture's own on-chain MaverickV2Quoter-analogue calculateSwap(awarded) view to the WEI
 *       (the exact-in-dy gate: the quoter IS the swap math). NO tolerance.
 *   (2) TWO Maverick venues — ONE EcoSwap splits across both; each leg's received output ==
 *       getDy(its awarded share) to the wei.
 *   (3) TREESHAKE regression cell — compiles the PRODUCTION treeshake define set (HAS_MAVERICK only, all
 *       other segment flags false) and cooks a REAL Maverick fill: guards that HAS_MAVERICK was added to
 *       the segment-head price-merge guard + the accumulator branch + the exec block across the guard
 *       triple (else the segment head is dead under treeshake and the swap lands ZERO — the bug that bit
 *       Balancer). Mirrors ecoswap.euler.evm.test.ts.
 *
 * The Maverick bin math is OFF-CHAIN only for the SPLIT: the on-chain solver supplies Maverick as STATIC
 * (capacity, marginalOI) segments and never recomputes the bin walk. We build the prepared args DIRECTLY
 * (Maverick discovery uses a factory whose address is a placeholder), then compile the production solver
 * template exactly as index.ts does and cook it.
 *
 * ENGINE PATH (verified here): Maverick executes through the engine `_swapMaverickV2` + the pool's
 * `maverickV2SwapCallback`. The engine hardcodes `tickLimit: 0`, which caps a tokenA-in swap at tick 0.
 * The fixture is seeded with its active tick at -3 (below 0) so a tokenA-in swap walks UP toward tick 0 —
 * the ONLY config the engine's tickLimit=0 fills (see maverick-math.ts). tokenIn == the pool's tokenA, so
 * the engine's on-chain tokenAIn resolution is true and the swap rises through the tick book.
 *
 * No fork / no RPC env needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when the v12
 * artifacts are present). Driven by ECO_ENGINE (default v12). Mirrors ecoswap.dodo.evm.test.ts.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, type Abi, type Account, type Hex } from "viem";

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
  erc20Abi,
  deployMaverickV2Pool,
  maverickV2PoolAbi,
  type MaverickDeployParams,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import {
  getDy,
  buildMaverickSegments,
  getTickL,
  getSqrtPrice,
  tickSqrtPrices,
  type MaverickPool,
  type MaverickTick,
} from "../shared/maverick-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const FEE = E18 / 1000n; // 0.1% directional fee (1e18-scaled)
const TICK_SPACING = 10;
const ACTIVE_TICK = -3; // below 0 so a tokenA-in swap walks UP toward the engine tickLimit=0
const ENGINE_CELLS = engineCells();

// The PRODUCTION treeshake define set for a Maverick-only universe (no other segment-bearing protocol):
// index.ts protocolDefines folds every other HAS_* to false. The fast/no-define test path leaves all HAS_*
// at their source default `true`, masking any merge-head guard that omits HAS_MAVERICK — so this cell
// compiles with the real treeshaken set and a REAL cook asserts a non-zero Maverick fill.
const MAVERICK_ONLY_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: true,
};

// Maverick-only run: zero direct pools/routes/netCache; the Maverick venues ride entirely inside segs
// (segKind 8). The solver's 5 compiler args, in index.ts order (cfg, pools, netCache, routing, segs).
function maverickArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, segs: bigint[][]): unknown[] {
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
  ];
}

// One Maverick venue → its sampled segments as segs rows. refIdx tags the on-chain per-venue accumulator
// (minp[refIdx]); venue is the pool address. Built from the SAME buildMaverickSegments the oracle uses, so
// the awarded Σ == the off-chain share by construction. segKind = 8; a Maverick segment is a flat post-fee
// slice ⇒ sqrtAdjNear == sqrtAdjFar.
function maverickSegRows(pool: MaverickPool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildMaverickSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-fee; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (a Maverick segment is a flat slice)
    8n, // segKind = Maverick V2 (engine callback path)
    BigInt(pool.address),
  ]);
}

// Interleave + sort segs rows the way index.ts buildSegs does: DESC by sqrtAdjNear, then DESC by
// sqrtAdjFar, then by refIdx. The on-chain static-segment cursor consumes them in array order.
function sortSegs(rows: bigint[][]): bigint[][] {
  return rows.slice().sort((a, b) => {
    if (a[2] !== b[2]) return a[2] < b[2] ? 1 : -1;
    if (a[3] !== b[3]) return a[3] < b[3] ? 1 : -1;
    return Number(a[0] - b[0]);
  });
}

describe("EcoSwap Maverick V2 (bin-based directional AMM, local fixture) — engine _swapMaverickV2 exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the pool's tokenA (tokenAIn) — the price-rising side
  let tokenOut: Hex; // == the pool's tokenB
  let solverSrc: string;
  // ONE immutable base snapshot taken in before() (after Multicall3 etch + engine deploy + caller
  // funding). Every cell reverts to THIS id then re-snapshots the SAME base state — we never chain a
  // revert onto a snapshot taken right after a prior revert. Each cell (re)deploys its Maverick pool +
  // sets approvals AFTER the revert and asserts the pre-cook invariants, so the compiled args always
  // match live on-chain state (the 0-fill flake was a chained revert→re-snapshot→revert drifting the
  // fresh-pool/approval state out from under the args).
  let cleanBase: Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0; // pool tokenA (the input side) — swap rises through ticks
    tokenOut = tk.token1; // pool tokenB (the output side)
    solverSrc = readFileSync(SOLVER, "utf-8");

    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, parseEther("50000000"));

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    cleanBase = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  // Revert to the immutable base and immediately re-snapshot it. anvil consumes a snapshot id on
  // revert, so we mint a fresh id — but ALWAYS off the same base state (nothing runs between the
  // revert and the snapshot), never off a post-cook state. This is the deterministic setup the cells
  // build their pool + approvals on top of.
  async function reset(): Promise<void> {
    await c.testClient.revert({ id: cleanBase });
    cleanBase = await c.testClient.snapshot();
  }

  // Assert the pre-cook invariants the compiled args assume: the caller can pay `amountIn` of tokenIn,
  // the cook target (SauceRouter / V12Pot) is approved to pull it, and every Maverick pool holds enough
  // tokenOut reserve to satisfy the expected output. A failure here localizes a bad setup BEFORE cook,
  // instead of surfacing as a silent 0-fill after a successful-but-mis-routed cook.
  async function assertPreCook(
    caller: Hex, target: Hex, amountIn: bigint, pools: { pool: Hex; expectedOut: bigint }[],
  ): Promise<void> {
    const callerIn = await balanceOf(c.publicClient, tokenIn, caller);
    assert.ok(callerIn >= amountIn, `caller tokenIn balance ${callerIn} >= amountIn ${amountIn}`);
    const allowance = (await c.publicClient.readContract({
      address: tokenIn, abi: erc20Abi as Abi, functionName: "allowance", args: [caller, target],
    })) as bigint;
    assert.ok(allowance >= amountIn, `cook target allowance ${allowance} >= amountIn ${amountIn}`);
    for (const { pool, expectedOut } of pools) {
      const poolOut = await balanceOf(c.publicClient, tokenOut, pool);
      assert.ok(poolOut >= expectedOut, `pool ${pool} tokenOut reserve ${poolOut} >= expected out ${expectedOut}`);
    }
  }

  // Build a symmetric tick book around ACTIVE_TICK (-3..+3), each tick with `reservePerSide` of both
  // tokens. tokenAIn = true (tokenIn == tokenA), so the swap walks UP from -3 toward the engine tickLimit=0.
  function makeTicks(reservePerSide: bigint): MaverickTick[] {
    const ticks: MaverickTick[] = [];
    for (let t = ACTIVE_TICK - 1; t <= ACTIVE_TICK + 6; t++) {
      ticks.push({ tick: t, reserveA: reservePerSide, reserveB: reservePerSide });
    }
    return ticks;
  }

  // Off-chain MaverickPool descriptor for the deployed fixture (tokenIn == tokenA).
  function offPool(address: Hex, reservePerSide: bigint): MaverickPool {
    const ticks = makeTicks(reservePerSide);
    const { sqrtLowerPrice, sqrtUpperPrice } = tickSqrtPrices(TICK_SPACING, ACTIVE_TICK);
    const active = ticks.find((t) => t.tick === ACTIVE_TICK)!;
    const activeL = getTickL(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice);
    const poolSqrtPrice = getSqrtPrice(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice, activeL);
    return {
      poolType: 7,
      address,
      tokenAIn: true,
      activeTick: ACTIVE_TICK,
      poolSqrtPrice,
      tickSpacing: TICK_SPACING,
      fee: FEE,
      protocolFeeD3: 0n,
      ticks,
      feePpm: Number((FEE * 1_000_000n) / E18),
      source: "local-fixture",
    };
  }

  function deployParams(op: MaverickPool): MaverickDeployParams {
    return {
      tokenA: tokenIn,
      tokenB: tokenOut,
      tickSpacing: op.tickSpacing,
      feeAIn: op.fee,
      feeBIn: op.fee,
      protocolFeeRatioD3: Number(op.protocolFeeD3),
      ticks: op.ticks,
      activeTick: op.activeTick,
      poolSqrtPrice: op.poolSqrtPrice,
    };
  }

  // ── (1) SOLO Maverick venue — received == getDy(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Per-tick reserves > 2^78 wei so the getTickL precision-bump path is not taken (the deep-pool regime
    // real Maverick WETH/USDC ticks sit in; the fixture matches the off-chain replay bit-for-bit there).
    const reservePerSide = 1_000_000n * E18;
    const op = offPool(("0x" + "00".repeat(20)) as Hex, reservePerSide);
    const pool = await deployMaverickV2Pool(c.walletClient, c.publicClient, deployParams(op), caller);
    const opOnChain: MaverickPool = { ...op, address: pool };

    // amountIn sized within the reachable depth (the -3..0 walk under tickLimit=0). The merge awards the
    // WHOLE Σ to this one venue, so the awarded share == the sampled cap and the executed swap is getDy(cap).
    const amountIn = 100_000n * E18;
    const segRows = maverickSegRows(opOnChain, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Maverick segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);

    const { bytecodes } = compileSauce(
      solverSrc, maverickArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    // Pre-cook invariants: caller funded, target approved, the pool holds the tokenOut it must pay.
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: getDy(opOnChain, segSum) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    // The fixture's own on-chain calculateSwap view (the MaverickV2Quoter analogue) on the PRE-swap state —
    // the engine-independent ground truth for the executed dy of the awarded share. tokenAIn=true, tickLimit=0.
    const onView = (await c.publicClient.readContract({
      address: pool, abi: maverickV2PoolAbi, functionName: "calculateSwap", args: [segSum, true, false, 0],
    })) as readonly [bigint, bigint, bigint];
    const onViewIn = onView[0];
    const onViewOut = onView[1];

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Maverick cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    // The engine consumed exactly the amount the quoter says (which may be < segSum if the tick-limit
    // depth binds; the sampler capped at maxInput so segSum == consumable here). The Maverick pool pulled
    // that input via the callback; any un-consumed slice was terminal-refunded.
    assert.equal(spent, onViewIn, "spent == the input the Maverick swap consumed (callback pull)");
    assert.equal(poolIn, onViewIn, "the Maverick pool received the consumed input via maverickV2SwapCallback");

    // WEI-EXACT-IN-DY: the on-chain executed dy (the caller's received tokenOut) equals the off-chain
    // getDy(consumed share) to the WEI, AND equals the fixture's own on-chain calculateSwap view. NO tolerance.
    assert.equal(received, getDy(opOnChain, spent), "received == getDy(share) to the wei (exact-in-dy)");
    assert.equal(received, onViewOut, "received == on-chain calculateSwap view (exact-in-dy)");
    assert.ok(received > 0n, "non-zero Maverick fill through the engine _swapMaverickV2 callback path");

    console.log(`  [Maverick solo:${engine}] spent=${spent} received=${received} (== getDy == calculateSwap to the wei)`);
  }

  // ── (2) TWO Maverick venues — split + per-leg exact-in-dy ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues at the SAME active tick / price but different depth → different marginal curves, so the
    // water-fill engages BOTH. A is deeper ⇒ draws first + more. Both reserves > 2^78 (no getTickL bump).
    const opA = offPool(("0x" + "00".repeat(20)) as Hex, 1_000_000n * E18);
    const opB = offPool(("0x" + "00".repeat(20)) as Hex, 400_000n * E18);
    const poolA = await deployMaverickV2Pool(c.walletClient, c.publicClient, deployParams(opA), caller);
    const poolB = await deployMaverickV2Pool(c.walletClient, c.publicClient, deployParams(opB), caller);
    const opAon: MaverickPool = { ...opA, address: poolA };
    const opBon: MaverickPool = { ...opB, address: poolB };

    const amountIn = 150_000n * E18;
    const segRows = sortSegs([...maverickSegRows(opAon, 0, amountIn), ...maverickSegRows(opBon, 1, amountIn)]);

    const { bytecodes } = compileSauce(
      solverSrc, maverickArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    // Pre-cook invariants: caller funded, target approved, each venue holds enough tokenOut to pay its
    // awarded share (bound each by the full-amount getDy — a superset of its actual leg).
    await assertPreCook(caller, target, amountIn, [
      { pool: poolA, expectedOut: getDy(opAon, amountIn) },
      { pool: poolB, expectedOut: getDy(opBon, amountIn) },
    ]);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const aInBefore = await balanceOf(c.publicClient, tokenIn, poolA);
    const bInBefore = await balanceOf(c.publicClient, tokenIn, poolB);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue Maverick cook() must succeed");

    const aIn = (await balanceOf(c.publicClient, tokenIn, poolA)) - aInBefore;
    const bIn = (await balanceOf(c.publicClient, tokenIn, poolB)) - bInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(aIn > 0n && bIn > 0n, `both Maverick venues are funded (A ${aIn}, B ${bIn})`);
    assert.ok(aIn > bIn, `deep venue A draws more than B (A ${aIn} > B ${bIn})`);

    // PER-LEG WEI-EXACT-IN-DY: received == getDy_A(aIn) + getDy_B(bIn) (each venue executes one atomic
    // engine swap on its awarded share). NO tolerance.
    const expected = getDy(opAon, aIn) + getDy(opBon, bIn);
    assert.equal(received, expected, "received == Σ getDy(per-venue share) to the wei");

    console.log(`  [Maverick split:${engine}] A in=${aIn} B in=${bIn} received=${received} (== Σ getDy to the wei)`);
  }

  // ── (3) SOLO Maverick under the PRODUCTION treeshake define set ──
  // Same trade as runSolo, but compiled with treeshake:true + Maverick-only defines (the exact compile a
  // production Maverick-without-other-segs cook carries). Guards the guard triple at the call boundary: if
  // HAS_MAVERICK is missing from the segment-head price-merge guard, the accumulator branch, OR the exec
  // block, under treeshake the Maverick head is never compared / never accumulated / never swapped and the
  // swap lands ZERO (the bug that bit Balancer).
  async function runSoloTreeshake(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const op = offPool(("0x" + "00".repeat(20)) as Hex, 1_000_000n * E18);
    const pool = await deployMaverickV2Pool(c.walletClient, c.publicClient, deployParams(op), caller);
    const opOnChain: MaverickPool = { ...op, address: pool };

    const amountIn = 100_000n * E18;
    const segRows = maverickSegRows(opOnChain, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Maverick segment ladder");

    const { bytecodes } = compileSauce(
      solverSrc, maverickArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
      { treeshake: true, defines: MAVERICK_ONLY_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    // Pre-cook invariants: caller funded, target approved, the pool holds the tokenOut it must pay.
    // Deterministic setup is what makes the guard-triple regression gate (spent>0) meaningful — a
    // 0-fill here now means a dead treeshaken merge head, NOT a drifted snapshot.
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: getDy(opOnChain, segSum) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "treeshaken Maverick-only cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // The merge MUST have routed the trade to Maverick — non-zero spend/receive is the regression gate.
    assert.ok(spent > 0n, "treeshaken Maverick-only: non-zero Maverick fill (guard triple alive)");
    assert.equal(received, getDy(opOnChain, spent), "received == getDy(share) to the wei (treeshaken path)");

    console.log(`  [Maverick treeshake:${engine}] spent=${spent} received=${received} (production define set)`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Maverick solo [${engine}] — received == getDy(share) == calculateSwap to the wei (exact-in-dy)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Maverick split [${engine}] — two venues, per-leg exact-in-dy`, { skip }, async () => {
      await runSplit(engine);
    });
    it(`Maverick solo treeshake [${engine}] — production define set lands a non-zero Maverick fill`, { skip }, async () => {
      await runSoloTreeshake(engine);
    });
  }
});
