/**
 * EcoSwap Maverick V2 (bin-based directional AMM) local-EVM integration — the engine `_swapMaverickV2`
 * + `maverickV2SwapCallback` exact-in-dy gate.
 *
 * Stands up a local Maverick V2 pool (the MaverickV2Pool.sol fixture, whose TickMath/SwapMath + tick
 * walk mirror the off-chain `maverick-math.ts` replay bit-for-bit), deploys the Sauce engine, and cooks
 * an EcoSwap whose static-segment cursor consumes Maverick segments (segKind 8) and executes them via the
 * unified swap(SwapParams{poolType:7}) → live `_swapMaverickV2`. Maverick is a CALLBACK pool: the engine
 * reads the pool's tokenA(), sets tokenAIn, calls pool.swap(recipient, SwapParams{amount, tokenAIn,
 * exactOutput:false, tickLimit: tokenAIn ? type(int32).max : type(int32).min}, hex"01") — NON-EMPTY data
 * selects the pool's callback funding mode — and the pool re-enters the engine's `maverickV2SwapCallback`
 * (4-arg: tokenIn, amountIn, amountOut, data) to PULL the input mid-swap — so it MUST execute through the
 * engine Router (NOT the callback-free path). Then asserts:
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
 * `maverickV2SwapCallback` (the FIXED engine — ../sauce PR #193 — passes hex"01" + a full-range per-
 * direction tickLimit type(int32).max/min, and the 4-arg callback funds the pool). The fixture is seeded
 * with its active tick at -3 so a tokenA-in swap walks UP through the tick book; tokenIn == the pool's
 * tokenA, so the engine's on-chain tokenAIn resolution is true. The trade (100k against ~1M/tick reserves)
 * fully consumes within a couple of ticks near the active tick, WELL before any tickLimit boundary — so
 * the executed dy == off-chain getDy (which walks the same book) == the pool's own calculateSwap to the
 * wei, whatever tickLimit the engine passes.
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
const ACTIVE_TICK = -3; // a tokenA-in swap walks UP from here; the trade consumes within a few ticks
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
    0n, // venueAux (segs[6]) — unused for non-Mento kinds; padded to mirror production's 7-col seg shape
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
  // Each cell runs on its OWN fresh anvil + freshly-deployed stack (setup() below): no shared mutable
  // node state between cells, so there is no snapshot/loadState reset race. A snapshot revert+re-snapshot
  // dance chained a revert onto a just-minted id (its consumed-id race dropped a cell to a 0-fill), and a
  // bare loadState MERGES (never CLEARS a live account, so a prior cell's pool code lingers → the next
  // CREATE collides, or with the nonce left to climb the pool drifts to a new address). A fresh chain per
  // cell removes all shared state — reset() just tears the anvil down and rebuilds. See setup().

  // Boot a fresh anvil + deploy the whole stack. Called by before() once and by reset() before every
  // subsequent cell, tearing the prior anvil down first — so each cell is fully isolated.
  async function setup(): Promise<void> {
    anvil?.stop();
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
  }

  before(setup);

  after(() => {
    anvil?.stop();
  });

  async function reset(): Promise<void> {
    await setup();
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
  // tokens. tokenAIn = true (tokenIn == tokenA), so the swap walks UP from -3 (consumes within a few ticks).
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

  // Off-chain MaverickPool descriptor for an ARBITRARY active tick + per-tick reserve map (tokenIn == tokenA).
  // Seeds the walk's starting price from the active tick's reserves — the same construction discovery uses.
  // Used by the cross-tick-0 cells (which the OLD tickLimit=0 engine could not fill / dropped at discovery).
  function offPoolAt(address: Hex, activeTick: number, reserves: Record<number, bigint>): MaverickPool {
    const ticks: MaverickTick[] = Object.entries(reserves)
      .map(([t, r]) => ({ tick: Number(t), reserveA: r, reserveB: r }))
      .sort((a, b) => a.tick - b.tick);
    const { sqrtLowerPrice, sqrtUpperPrice } = tickSqrtPrices(TICK_SPACING, activeTick);
    const active = ticks.find((t) => t.tick === activeTick)!;
    const activeL = getTickL(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice);
    const poolSqrtPrice = getSqrtPrice(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice, activeL);
    return {
      poolType: 7,
      address,
      tokenAIn: true,
      activeTick,
      poolSqrtPrice,
      tickSpacing: TICK_SPACING,
      fee: FEE,
      protocolFeeD3: 0n,
      ticks,
      feePpm: Number((FEE * 1_000_000n) / E18),
      source: "local-fixture",
    };
  }

  // ── Shared cross-tick-0 cell body ──
  // Deploys `op` (a pool the OLD tickLimit=0 engine mishandled), drives ONE EcoSwap over its PRODUCTION
  // buildMaverickSegments ladder, and asserts the on-chain fill == full-range getDy(consumed) == the
  // fixture's own full-range calculateSwap to the WEI — the wei-exactness the old cap hid.
  //
  // Two vestige facts are cross-checked against the FIXTURE's own view (the engine-independent ground truth,
  // parametrized by tickLimit — the fixture honors whatever the caller passes, mirroring the OLD vs FIXED
  // engine): `opts.minReceivedFloor` is a value the OLD tickLimit=0 walk could NOT exceed on this pool
  // (0 for an active tick above 0 that the walk breaks on immediately; the tick -1 single-tick out-liquidity
  // for a fill that crosses the tick-0 boundary into tick 0) — the executed fill must be STRICTLY GREATER,
  // proving the removal changes the number, not just that a swap lands. `opts.assertViewBeatsCap` (default
  // true) additionally asserts the fixture's full-range calculateSwap STRICTLY exceeds its tickLimit=0
  // calculateSwap on the SAME sampled input (only true when the sampled ladder itself reaches past tick 0 —
  // the boundary-crossing cell whose ladder stops AT tick 0 sets it false and relies on minReceivedFloor).
  async function runCrossTick0(
    engine: Engine,
    op0: MaverickPool,
    amountIn: bigint,
    opts: { minReceivedFloor: bigint; assertViewBeatsCap?: boolean },
  ): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const pool = await deployMaverickV2Pool(c.walletClient, c.publicClient, deployParams(op0), caller);
    const op: MaverickPool = { ...op0, address: pool };

    const segRows = maverickSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Maverick segment ladder (full-range: the pool is executable)");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);

    const { bytecodes } = compileSauce(
      solverSrc, maverickArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: getDy(op, segSum) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    // The fixture's own calculateSwap views on the SAME sampled input — full-range (engine passes
    // type(int32).max for tokenA-in) vs the OLD tickLimit=0 cap. The engine-independent ground truth.
    const onViewFull = (await c.publicClient.readContract({
      address: pool, abi: maverickV2PoolAbi, functionName: "calculateSwap",
      args: [segSum, true, false, 2_147_483_647],
    })) as readonly [bigint, bigint, bigint];
    const onViewOldCap = (await c.publicClient.readContract({
      address: pool, abi: maverickV2PoolAbi, functionName: "calculateSwap",
      args: [segSum, true, false, 0],
    })) as readonly [bigint, bigint, bigint];
    if (opts.assertViewBeatsCap ?? true) {
      assert.ok(
        onViewFull[1] > onViewOldCap[1],
        `fixture full-range view ${onViewFull[1]} > tickLimit=0 view ${onViewOldCap[1]} (the case the cap hid)`,
      );
    }

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cross-tick-0 Maverick cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, onViewFull[0], "spent == the input the full-range Maverick swap consumed");
    assert.equal(poolIn, onViewFull[0], "the Maverick pool received the consumed input via the callback");

    // WEI-EXACT-IN-DY across tick 0: the on-chain executed dy == off-chain full-range getDy(consumed) ==
    // the fixture's own full-range calculateSwap view. NO tolerance.
    assert.equal(received, getDy(op, spent), "received == full-range getDy(share) to the wei (cross-tick-0)");
    assert.equal(received, onViewFull[1], "received == full-range calculateSwap view to the wei");
    // The fill fills PAST what the OLD tickLimit=0 walk could reach on this pool.
    assert.ok(
      received > opts.minReceivedFloor,
      `received ${received} > old tickLimit=0 reach ${opts.minReceivedFloor} (the case the cap hid)`,
    );

    console.log(
      `  [Maverick cross-0:${engine}] activeTick=${op.activeTick} spent=${spent} received=${received} ` +
        `(old-cap reach<=${opts.minReceivedFloor}; == full-range getDy == calculateSwap to the wei)`,
    );
  }

  // ── (A) tokenA-in fill that walks THROUGH the tick-0 boundary (active -1, uniform book) ──
  // active tick -1 (< 0, so the OLD discovery gate KEPT it), uniform 500k/tick over ticks -2..3. A 600k
  // tokenA-in trade drains tick -1's out-side liquidity (500k) then crosses the tick-0 boundary INTO tick 0
  // for the remainder — the fill spans BOTH sides of tick 0. The received (~599.5k) therefore exceeds tick
  // -1's single-tick out-liquidity (500k), proving the fill walked THROUGH tick 0; wei-exact vs getDy +
  // calculateSwap. (The sampled ladder itself stops AT the tick-0 boundary — the marginal is smooth there —
  // so the fixture full-range vs tickLimit=0 views TIE on this input; the crossing is proven by the 500k
  // floor, not by a view delta. assertViewBeatsCap:false.)
  async function runCrossThroughTick0(engine: Engine): Promise<void> {
    const reserves: Record<number, bigint> = {};
    for (let t = -2; t <= 3; t++) reserves[t] = 500_000n * E18;
    const op = offPoolAt(("0x" + "00".repeat(20)) as Hex, -1, reserves);
    // Crossing the tick-0 boundary from tick -1 ⇒ received must exceed tick -1's single-tick out-liq (500k).
    await runCrossTick0(engine, op, 600_000n * E18, { minReceivedFloor: 500_000n * E18, assertViewBeatsCap: false });
  }

  // ── (B) tokenA-in pool with active tick ABOVE 0 (previously DROPPED by the discovery gate) ──
  // active tick +2 for a tokenA-in swap: the OLD discovery gate DROPPED this pool (tokenAIn && activeTick
  // > 0) and the OLD off-chain walk + tickLimit=0 engine returned 0 (they broke immediately, 2 > 0). The
  // FIXED full-range engine surfaces it and fills it wei-exact (walks UP from +2). This is the pool the
  // vestige removal RE-ENABLES; the fixture full-range view STRICTLY beats its tickLimit=0 view (0).
  async function runAboveTick0(engine: Engine): Promise<void> {
    const reserves: Record<number, bigint> = {};
    for (let t = 0; t <= 6; t++) reserves[t] = 500_000n * E18;
    const op = offPoolAt(("0x" + "00".repeat(20)) as Hex, 2, reserves);
    // The old tickLimit=0 walk breaks immediately (activeTick 2 > 0) → ZERO fill; the pool was also dropped.
    await runCrossTick0(engine, op, 800_000n * E18, { minReceivedFloor: 0n });
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

    // amountIn sized within the reachable depth (consumed within a few ticks of the active tick). The merge
    // awards the WHOLE Σ to this one venue, so the awarded share == the sampled cap and the swap is getDy(cap).
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
    // the engine-independent ground truth for the executed dy of the awarded share. tokenAIn=true. The
    // view's tickLimit is immaterial here — the trade consumes before any boundary — so 0 == full-range.
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
    // 0-fill here now means a dead treeshaken merge head, NOT a drifted chain.
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
    it(`Maverick cross-through-tick-0 [${engine}] — full-range fill walks past tick 0, wei-exact`, { skip }, async () => {
      await runCrossThroughTick0(engine);
    });
    it(`Maverick above-tick-0 [${engine}] — previously-dropped active>0 pool now fills wei-exact`, { skip }, async () => {
      await runAboveTick0(engine);
    });
  }
});
