/**
 * EcoSwap Maverick V2 (bin-based directional AMM) local-EVM integration — the on-chain LIVE bin-WALK
 * (segKind 8) + the engine `_swapMaverickV2` / `maverickV2SwapCallback` exact-in-dy gate.
 *
 * Stands up a local Maverick V2 pool (the MaverickV2Pool.sol fixture, whose TickMath/SwapMath + tick walk
 * mirror the off-chain `maverick-math.ts` replay bit-for-bit), deploys the Sauce engine, and cooks an
 * EcoSwap whose segKind-8 QUOTE-LADDER branch WALKS the pool's bin book ON-CHAIN from its LIVE active
 * tick/price (reading getState()[5] activeTick + getTick(int32)[reserveA,reserveB] + fee(tokenAIn)) — one
 * ladder slice per crossed tick, identical to the neutral oracle's buildMaverickWalkLadder ⇒ solver ==
 * oracle by construction. The awarded Σ then executes via the unified swap(SwapParams{poolType:7}) → live
 * `_swapMaverickV2`. Maverick is a CALLBACK pool: the engine reads the pool's tokenA(), sets tokenAIn,
 * calls pool.swap(recipient, SwapParams{amount, tokenAIn, exactOutput:false, tickLimit: tokenAIn ?
 * type(int32).max : type(int32).min}, hex"01") — NON-EMPTY data selects the pool's callback funding mode —
 * and the pool re-enters the engine's `maverickV2SwapCallback` (4-arg) to PULL the input mid-swap — so it
 * MUST execute through the engine Router (NOT callback-free). The EXEC path is UNCHANGED by this lane; only
 * the SPLIT source moved on-chain (a live bin-walk instead of prepare's off-chain sampled segments).
 *
 * Asserts:
 *   (1) SOLO Maverick — a multi-tick fill: the on-chain dy == off-chain getDy(spent) == the fixture's own
 *       MaverickV2Quoter-analogue calculateSwap(spent) to the WEI (exact-in-dy). NO tolerance.
 *   (2) SPLIT — TWO Maverick venues of different depth; ONE EcoSwap splits across both, the per-venue
 *       awarded input == the neutral oracle's optimalSplit award (solver == oracle wei-exact, the payoff of
 *       the shared bin-walk ladder), and received == Σ getDy(per-venue share) to the wei. A second split
 *       cell runs at a NEGATIVE active tick (-3) with DISTINCT per-tick reserves: a mis-encoded signed-int32
 *       getTick arg would read a wrong-but-populated neighbour tick (different L → different capacity ladder)
 *       and diverge the on-chain split from the oracle — undetectable with a uniform reserve book.
 *   (3) TREESHAKE regression — compiles the PRODUCTION treeshake define set (HAS_MAVERICK only) and cooks a
 *       REAL Maverick fill: guards HAS_MAVERICK across the QL-emit guard + the accumulator branch + the exec
 *       block (else the walk is dead under treeshake and the swap lands ZERO — the bug that bit Balancer).
 *   (4) NEGATIVE / cross-tick-0 — active tick -3, -1 (crosses tick 0), and +2: exercises the signed-int32
 *       getState()[5] decode + the negative getTick(int32) ARG encode across the sign boundary, asserting
 *       the walk fills wei-exact vs the fixture's own full-range calculateSwap. This VALIDATES the negative
 *       tick path (the standalone reference prover only reached activeTick=+7 / positive ticks).
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
  buildMaverickWalkLadder,
  getTickL,
  getSqrtPrice,
  tickSqrtPrices,
  type MaverickPool,
  type MaverickTick,
} from "../shared/maverick-math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const FEE = E18 / 1000n; // 0.1% directional fee (1e18-scaled)
const TICK_SPACING = 10;
const ACTIVE_TICK = -3; // a tokenA-in swap walks UP from here (crosses NEGATIVE ticks -3,-2,-1 then 0,1,2,3)
const ENGINE_CELLS = engineCells();

// The PRODUCTION treeshake define set for a Maverick-only universe (no other segment/QL-bearing protocol):
// index.ts protocolDefines folds every other HAS_* to false. The fast/no-define test path leaves all HAS_*
// at their source default `true`, masking any guard that omits HAS_MAVERICK — so this cell compiles with the
// real treeshaken set and a REAL cook asserts a non-zero Maverick fill.
const MAVERICK_ONLY_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: true,
};

// Maverick-only run: zero direct pools/routes/netCache/segs; the Maverick venues ride entirely inside qlv
// (segKind 8 — the on-chain live bin-walk). The solver's 6 compiler args, in index.ts order
// (cfg, pools, netCache, routing, segs, qlv).
function maverickArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, qlv: bigint[][]): unknown[] {
  return [
    [
      BigInt(tokenIn),
      BigInt(tokenOut),
      amountIn,
      BigInt(caller),
      MIN_SQRT_RATIO + 1n, // priceLimit (unused by the Maverick bin-walk)
      0n, // directCount — no direct pools
    ],
    [], // pools
    [], // netCache
    [], // routing
    [], // segs — no STATIC sampled-segment venues in this Maverick-only universe
    qlv,
  ];
}

// One Maverick venue → its qlv descriptor row (the 10-column QL width). segKind 8; qd[1]=tokenAIn,
// qd[2]=tickSpacing; qd[3]=feePpm; qd[5]=refIdx (the on-chain per-venue accumulator minp[refIdx]). fee +
// activeTick + per-tick reserves are read LIVE on-chain — the descriptor carries only the walk seeds.
// Mirrors index.ts buildQLVenues' maverickRows + pad10.
function maverickQlvRow(pool: MaverickPool, refIdx: number): bigint[] {
  return [
    BigInt(pool.address),
    pool.tokenAIn ? 1n : 0n,
    BigInt(pool.tickSpacing),
    BigInt(pool.feePpm),
    8n,
    BigInt(refIdx),
    0n, 0n, 0n, 0n,
  ];
}

describe("EcoSwap Maverick V2 (bin AMM, local fixture) — on-chain live bin-walk + engine _swapMaverickV2", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the pool's tokenA (tokenAIn) — the price-rising side
  let tokenOut: Hex; // == the pool's tokenB
  let solverSrc: string;
  // Each cell runs on its OWN fresh anvil + freshly-deployed stack (setup() below): no shared mutable node
  // state between cells. A fresh chain per cell removes all shared state — reset() tears anvil down + rebuilds.

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

  // Assert the pre-cook invariants the compiled args assume: the caller can pay `amountIn` of tokenIn, the
  // cook target (SauceRouter / V12Pot) is approved to pull it, and every Maverick pool holds enough tokenOut
  // reserve to satisfy the expected output.
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

  // Off-chain MaverickPool descriptor for an active tick + per-tick reserve map (tokenIn == tokenA). Seeds
  // the walk's starting price from the active tick's reserves — the same construction discovery uses.
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

  // Uniform book of `reservePerSide` on both tokens over [ACTIVE_TICK-1, ACTIVE_TICK+6] (tokenAIn walks UP).
  function offPool(address: Hex, reservePerSide: bigint): MaverickPool {
    const reserves: Record<number, bigint> = {};
    for (let t = ACTIVE_TICK - 1; t <= ACTIVE_TICK + 6; t++) reserves[t] = reservePerSide;
    return offPoolAt(address, ACTIVE_TICK, reserves);
  }

  // Book with a DISTINCT reserve at every tick over [loT, hiT] (mk(t) per tick). Unlike the uniform books,
  // a DISTINCT-per-tick reserve makes a mis-indexed getTick read OBSERVABLE: reading a wrong-but-populated
  // neighbour tick returns a DIFFERENT reserve ⇒ a different L ⇒ a different capacity ladder ⇒ the on-chain
  // split diverges from the oracle (which reads the correct in-memory book by tick number, not via the
  // signed-int32 getTick arg). Keep every mk(t) > 2^78 wei so the getTickL precision-bump path is NOT taken.
  function offPoolGradient(
    address: Hex, activeTick: number, loT: number, hiT: number, mk: (t: number) => bigint,
  ): MaverickPool {
    const reserves: Record<number, bigint> = {};
    for (let t = loT; t <= hiT; t++) reserves[t] = mk(t);
    return offPoolAt(address, activeTick, reserves);
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

  // The Σ capacity the bin-walk ladder can absorb for `amountIn` (== the awarded Σ for a SOLO venue). The
  // on-chain walk emits the SAME ladder, so the solver awards exactly this to a solo Maverick venue.
  function ladderCapacity(op: MaverickPool, amountIn: bigint): bigint {
    return buildMaverickWalkLadder(op, amountIn).reduce((a, s) => a + s.capacity, 0n);
  }

  // ── (1) SOLO Maverick venue — a MULTI-TICK fill: received == getDy(spent) == calculateSwap to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Per-tick reserves > 2^78 wei so the getTickL precision-bump path is NOT taken (the deep-pool regime
    // real Maverick WETH/USDC ticks sit in; the fixture matches the off-chain replay bit-for-bit there).
    const reservePerSide = 1_000_000n * E18;
    const op = offPool(("0x" + "00".repeat(20)) as Hex, reservePerSide);
    const pool = await deployMaverickV2Pool(c.walletClient, c.publicClient, deployParams(op), caller);
    const opOnChain: MaverickPool = { ...op, address: pool };

    // amountIn crosses several ticks from the active tick (multi-slice walk) but stays within the reachable
    // depth (7 ticks ahead) + the QL_S=8 emit cap, so the solo merge awards the WHOLE ladder capacity.
    const amountIn = 3_500_000n * E18;
    const cap = ladderCapacity(opOnChain, amountIn);
    assert.equal(cap, amountIn, "multi-tick walk covers the whole amountIn (within reach + emit cap)");
    const walkSlices = buildMaverickWalkLadder(opOnChain, amountIn).length;
    assert.ok(walkSlices >= 2, `the solo fill crosses multiple ticks (${walkSlices} ladder slices)`);

    const qlv = [maverickQlvRow(opOnChain, 0)];
    const { bytecodes } = compileSauce(
      solverSrc, maverickArgs(tokenIn, tokenOut, amountIn, caller, qlv), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: getDy(opOnChain, amountIn) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    // The fixture's own on-chain calculateSwap view (the MaverickV2Quoter analogue) on the PRE-swap state —
    // the engine-independent ground truth. tokenAIn=true; full-range tickLimit (walks UP from -3).
    const onView = (await c.publicClient.readContract({
      address: pool, abi: maverickV2PoolAbi, functionName: "calculateSwap",
      args: [amountIn, true, false, 2_147_483_647],
    })) as readonly [bigint, bigint, bigint];

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Maverick cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, onView[0], "spent == the input the Maverick swap consumed (callback pull)");
    assert.equal(poolIn, onView[0], "the Maverick pool received the consumed input via maverickV2SwapCallback");
    // WEI-EXACT-IN-DY: on-chain dy == off-chain getDy(spent) == the fixture's calculateSwap view. NO tolerance.
    assert.equal(received, getDy(opOnChain, spent), "received == getDy(spent) to the wei (exact-in-dy)");
    assert.equal(received, onView[1], "received == on-chain calculateSwap view (exact-in-dy)");
    assert.ok(received > 0n, "non-zero Maverick fill through the engine _swapMaverickV2 callback path");

    console.log(`  [Maverick solo:${engine}] spent=${spent} received=${received} slices=${walkSlices} (== getDy == calculateSwap)`);
  }

  // ── (2) TWO Maverick venues — split + per-venue exact-in-dy + solver == oracle ──
  // Two venues at the SAME active tick / price but DIFFERENT depth → different marginal curves, so the
  // water-fill engages BOTH. A is deeper ⇒ draws first + more. amountIn crosses multiple ticks in BOTH so
  // each emits a MULTI-slice descending ladder the merge can interleave (a single within-tick flat slice
  // would let the better-priced venue take the whole trade). Both reserves > 2^78 (no getTickL bump).
  async function runSplit(engine: Engine): Promise<void> {
    const opA = offPool(("0x" + "00".repeat(20)) as Hex, 1_000_000n * E18);
    const opB = offPool(("0x" + "00".repeat(20)) as Hex, 400_000n * E18);
    await runSplitCore(engine, opA, opB, 1_500_000n * E18, "split");
  }

  // (2b) NEGATIVE-tick split with DISTINCT per-tick reserves — the ROBUST negative getTick(int32) ARG
  // validation. Both venues sit at active tick -3 (a tokenA-in walk rises UP through the NEGATIVE ticks
  // -3,-2,-1 then 0,1,2,3), and every tick carries a DISTINCT reserve, so the on-chain walk MUST encode the
  // correct signed-int32 getTick arg at each negative tick to read the right L. A wrong-but-populated read
  // (a mis-encoded negative arg landing on a neighbour) would yield a different capacity ladder and DIVERGE
  // the on-chain split from the oracle — caught by the solver == oracle assertions in runSplitCore (the
  // uniform books can't catch that: a neighbour returns identical reserves). A is 2.5× deeper than B ⇒ draws
  // more. Every mk(t) > 2^78 (no getTickL precision-bump).
  async function runSplitNegDistinct(engine: Engine): Promise<void> {
    const zero = ("0x" + "00".repeat(20)) as Hex;
    const opA = offPoolGradient(zero, -3, -4, 3, (t) => (1_000_000n + BigInt(t + 4) * 70_000n) * E18);
    const opB = offPoolGradient(zero, -3, -4, 3, (t) => (400_000n + BigInt(t + 4) * 30_000n) * E18);
    await runSplitCore(engine, opA, opB, 1_500_000n * E18, "split-neg-distinct");
  }

  // Shared two-venue split body — deploy both `op*` fixtures, run the neutral oracle over the shared bin-walk
  // ladder, cook, and assert the on-chain per-venue award == the oracle award (solver == oracle wei-exact) +
  // per-venue received == the fixture's own calculateSwap. Reused by the uniform (positive) and the
  // negative-distinct-reserve callers above.
  async function runSplitCore(
    engine: Engine, opA0: MaverickPool, opB0: MaverickPool, amountIn: bigint, label: string,
  ): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const opA = opA0;
    const opB = opB0;
    const poolA = await deployMaverickV2Pool(c.walletClient, c.publicClient, deployParams(opA), caller);
    const poolB = await deployMaverickV2Pool(c.walletClient, c.publicClient, deployParams(opB), caller);
    const opAon: MaverickPool = { ...opA, address: poolA };
    const opBon: MaverickPool = { ...opB, address: poolB };

    // NEUTRAL ORACLE — the shared bin-walk ladder (buildMaverickWalkLadder, == the on-chain walk) feeds
    // optimalSplit; its per-pool award is what the on-chain solver MUST reproduce wei-exact.
    const optPools: OptimalPool[] = [
      { maverick: opAon, feePpm: opAon.feePpm },
      { maverick: opBon, feePpm: opBon.feePpm },
    ];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awardedA = oracle.perPoolInput[0] ?? 0n;
    const awardedB = oracle.perPoolInput[1] ?? 0n;
    assert.ok(awardedA > 0n && awardedB > 0n, `oracle splits across both venues (A ${awardedA}, B ${awardedB})`);

    const qlv = [maverickQlvRow(opAon, 0), maverickQlvRow(opBon, 1)];
    const { bytecodes } = compileSauce(
      solverSrc, maverickArgs(tokenIn, tokenOut, amountIn, caller, qlv), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [
      { pool: poolA, expectedOut: getDy(opAon, amountIn) },
      { pool: poolB, expectedOut: getDy(opBon, amountIn) },
    ]);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const aInBefore = await balanceOf(c.publicClient, tokenIn, poolA);
    const bInBefore = await balanceOf(c.publicClient, tokenIn, poolB);
    const aOutBefore = await balanceOf(c.publicClient, tokenOut, poolA);
    const bOutBefore = await balanceOf(c.publicClient, tokenOut, poolB);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue Maverick cook() must succeed");

    const aIn = (await balanceOf(c.publicClient, tokenIn, poolA)) - aInBefore;
    const bIn = (await balanceOf(c.publicClient, tokenIn, poolB)) - bInBefore;
    const aOut = aOutBefore - (await balanceOf(c.publicClient, tokenOut, poolA));
    const bOut = bOutBefore - (await balanceOf(c.publicClient, tokenOut, poolB));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(aIn > 0n && bIn > 0n, `both Maverick venues are funded (A ${aIn}, B ${bIn})`);
    assert.ok(aIn > bIn, `deep venue A draws more than B (A ${aIn} > B ${bIn})`);
    // SOLVER == ORACLE (wei-exact): the on-chain per-venue award == the neutral oracle's optimalSplit award
    // (both consume the IDENTICAL bin-walk ladder). This is the payoff of the shared-grid live walk.
    assert.equal(aIn, awardedA, "on-chain venue-A award == oracle award (solver == oracle wei-exact)");
    assert.equal(bIn, awardedB, "on-chain venue-B award == oracle award (solver == oracle wei-exact)");
    // PER-VENUE WEI-EXACT-IN-DY vs the fixture's OWN quoter (the engine-independent ground truth for each
    // fixture pool — the SAME standard the prod-mirror uses vs the real MaverickV2Quoter). NO tolerance. (The
    // off-chain maverick-math getDy replay is the split GRID source — validated wei-exact vs the real quoter
    // in the prod-mirror; the mock fixture's helper rounding can differ from it by a few wei RIGHT AT a
    // drain/partial boundary, so the fixture's own calculateSwap is the exec ground truth here.)
    const csA = (await c.publicClient.readContract({
      address: poolA, abi: maverickV2PoolAbi, functionName: "calculateSwap", args: [aIn, true, false, 2_147_483_647],
    })) as readonly [bigint, bigint, bigint];
    const csB = (await c.publicClient.readContract({
      address: poolB, abi: maverickV2PoolAbi, functionName: "calculateSwap", args: [bIn, true, false, 2_147_483_647],
    })) as readonly [bigint, bigint, bigint];
    assert.equal(aOut, csA[1], "venue A: on-chain out == the fixture's calculateSwap(aIn) to the wei");
    assert.equal(bOut, csB[1], "venue B: on-chain out == the fixture's calculateSwap(bIn) to the wei");
    assert.equal(received, aOut + bOut, "received == Σ per-venue out (the caller collects both legs)");

    console.log(`  [Maverick ${label}:${engine}] A in=${aIn} B in=${bIn} received=${received} (solver==oracle, ==Σ calculateSwap)`);
  }

  // ── (3) SOLO Maverick under the PRODUCTION treeshake define set ──
  async function runSoloTreeshake(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const op = offPool(("0x" + "00".repeat(20)) as Hex, 1_000_000n * E18);
    const pool = await deployMaverickV2Pool(c.walletClient, c.publicClient, deployParams(op), caller);
    const opOnChain: MaverickPool = { ...op, address: pool };

    const amountIn = 2_000_000n * E18;
    const qlv = [maverickQlvRow(opOnChain, 0)];
    const { bytecodes } = compileSauce(
      solverSrc, maverickArgs(tokenIn, tokenOut, amountIn, caller, qlv), ECOSWAP_DIR, engine,
      { treeshake: true, defines: MAVERICK_ONLY_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: getDy(opOnChain, amountIn) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "treeshaken Maverick-only cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // The merge MUST have routed the trade to Maverick — non-zero spend/receive is the regression gate for
    // the HAS_MAVERICK guard triple (QL-emit guard + accumulator + exec).
    assert.ok(spent > 0n, "treeshaken Maverick-only: non-zero Maverick fill (guard triple alive)");
    assert.equal(received, getDy(opOnChain, spent), "received == getDy(spent) to the wei (treeshaken path)");

    console.log(`  [Maverick treeshake:${engine}] spent=${spent} received=${received} (production define set)`);
  }

  // ── (4) NEGATIVE / cross-tick-0 body — validate the signed-int32 activeTick decode + negative getTick arg ──
  // Deploys `op` (an active tick at/below 0, so the walk reads a NEGATIVE getState()[5] and passes NEGATIVE
  // getTick(int32) args), drives ONE EcoSwap over its LIVE bin-walk, and asserts the on-chain fill == the
  // fixture's own full-range calculateSwap to the WEI — the negative-tick correctness the standalone
  // reference prover (which only reached activeTick=+7) could not validate. `minReceivedFloor` is a value a
  // walk that could not cross past tick 0 would NOT exceed (proves the crossing).
  async function runCrossTick0(
    engine: Engine, op0: MaverickPool, amountIn: bigint, minReceivedFloor: bigint,
  ): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const pool = await deployMaverickV2Pool(c.walletClient, c.publicClient, deployParams(op0), caller);
    const op: MaverickPool = { ...op0, address: pool };

    const cap = ladderCapacity(op, amountIn);
    assert.equal(cap, amountIn, "the walk covers the whole amountIn (within reach)");

    const qlv = [maverickQlvRow(op, 0)];
    const { bytecodes } = compileSauce(
      solverSrc, maverickArgs(tokenIn, tokenOut, amountIn, caller, qlv), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: getDy(op, amountIn) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    // The fixture's own full-range calculateSwap view (engine passes type(int32).max for tokenA-in) — the
    // engine-independent ground truth across the sign boundary.
    const onViewFull = (await c.publicClient.readContract({
      address: pool, abi: maverickV2PoolAbi, functionName: "calculateSwap",
      args: [amountIn, true, false, 2_147_483_647],
    })) as readonly [bigint, bigint, bigint];

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cross-tick-0 Maverick cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, onViewFull[0], "spent == the input the full-range Maverick swap consumed");
    assert.equal(poolIn, onViewFull[0], "the Maverick pool received the consumed input via the callback");
    // WEI-EXACT across the sign boundary: on-chain dy == off-chain getDy(spent) == calculateSwap. NO tolerance.
    assert.equal(received, getDy(op, spent), "received == full-range getDy(spent) to the wei (signed-int32 walk)");
    assert.equal(received, onViewFull[1], "received == full-range calculateSwap view to the wei");
    assert.ok(received > minReceivedFloor, `received ${received} > floor ${minReceivedFloor} (the walk crossed past tick 0)`);

    console.log(
      `  [Maverick cross-0:${engine}] activeTick=${op.activeTick} spent=${spent} received=${received} ` +
        `(signed-int32 decode + negative getTick arg; == getDy == calculateSwap to the wei)`,
    );
  }

  // (A) tokenA-in fill that walks THROUGH the tick-0 boundary — active -1, uniform 500k/tick over -2..3. A
  // 600k trade drains tick -1's out-side (500k) then crosses tick 0 for the remainder — received (~599.5k)
  // exceeds tick -1's single-tick out-liquidity (500k), proving the walk read NEGATIVE getTick args (-1) then
  // crossed to tick 0. wei-exact vs the fixture's own calculateSwap.
  async function runCrossThroughTick0(engine: Engine): Promise<void> {
    const reserves: Record<number, bigint> = {};
    for (let t = -2; t <= 3; t++) reserves[t] = 500_000n * E18;
    const op = offPoolAt(("0x" + "00".repeat(20)) as Hex, -1, reserves);
    await runCrossTick0(engine, op, 600_000n * E18, 500_000n * E18);
  }

  // (B) tokenA-in pool with active tick ABOVE 0 — active +2 over ticks 0..6. Sanity that the positive-tick
  // walk (the reference-validated regime) still fills wei-exact through the new QL path.
  async function runAboveTick0(engine: Engine): Promise<void> {
    const reserves: Record<number, bigint> = {};
    for (let t = 0; t <= 6; t++) reserves[t] = 500_000n * E18;
    const op = offPoolAt(("0x" + "00".repeat(20)) as Hex, 2, reserves);
    await runCrossTick0(engine, op, 800_000n * E18, 0n);
  }

  // ── (5) ADVERSE-DRIFT RE-ANCHOR — the descriptor carries NO price/tick, so the walk MUST re-read live ──
  // Compile the solver against a pool at active -3, then MOVE the pool's active tick/price ADVERSELY (up to
  // +1 — a tokenA-in swap now starts at a worse price) BEFORE cooking. The Maverick descriptor ships only
  // {tokenAIn, tickSpacing}; fee + activeTick + per-tick reserves are read on-chain — so the SAME pre-drift
  // bytecode re-anchors to the drifted live state. Asserts the executed dy == the DRIFTED pool's own
  // calculateSwap (proving the walk used the live post-drift state) AND != the pre-drift baseline (proving
  // the drift actually changed the fill). This is the descriptor-only-live-walk value prop.
  async function runAdverseDrift(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const reserves: Record<number, bigint> = {};
    for (let t = -4; t <= 3; t++) reserves[t] = 1_000_000n * E18;
    const op = offPoolAt(("0x" + "00".repeat(20)) as Hex, -3, reserves);
    const pool = await deployMaverickV2Pool(c.walletClient, c.publicClient, deployParams(op), caller);
    const opOnChain: MaverickPool = { ...op, address: pool };

    const amountIn = 2_500_000n * E18; // crosses a few ticks either way, within reach (7 ticks ahead of +1)
    const baseline = getDy(opOnChain, amountIn); // the PRE-drift fill (active -3) — must NOT be what we get

    const qlv = [maverickQlvRow(opOnChain, 0)];
    const { bytecodes } = compileSauce(
      solverSrc, maverickArgs(tokenIn, tokenOut, amountIn, caller, qlv), ECOSWAP_DIR, engine,
    );

    // DRIFT: move the active tick -3 → +1 (adverse for tokenA-in) with its live within-tick price. The
    // reserves per tick are unchanged (already seeded -4..+3), so the walk from +1 fills ticks +1..+3.
    const drifted = offPoolAt(pool, 1, reserves);
    await c.walletClient.writeContract({
      address: pool, abi: maverickV2PoolAbi as Abi, functionName: "setActive",
      args: [1, drifted.poolSqrtPrice], account: caller, chain: null,
    });
    const st = (await c.publicClient.readContract({
      address: pool, abi: maverickV2PoolAbi, functionName: "getState",
    })) as { activeTick: number };
    assert.equal(Number(st.activeTick), 1, "the pool drifted to active tick +1");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "post-drift Maverick cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const driftView = (await c.publicClient.readContract({
      address: pool, abi: maverickV2PoolAbi, functionName: "calculateSwap",
      args: [spent, true, false, 2_147_483_647],
    })) as readonly [bigint, bigint, bigint];

    assert.ok(received > 0n, "non-zero fill after the adverse drift");
    // RE-ANCHOR: the executed dy == the DRIFTED pool's own calculateSwap(spent) to the wei ⇒ the walk read
    // the live post-drift state (not the stale -3 it was compiled against).
    assert.equal(received, driftView[1], "received == DRIFTED calculateSwap(spent) to the wei (live re-anchor)");
    assert.notEqual(received, baseline, "the adverse drift changed the fill (re-anchored, not the -3 baseline)");

    console.log(`  [Maverick drift:${engine}] spent=${spent} received=${received} baseline(@-3)=${baseline} (re-anchored to +1)`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Maverick solo [${engine}] — multi-tick walk, received == getDy == calculateSwap to the wei`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Maverick split [${engine}] — two venues, solver == oracle + per-venue exact-in-dy`, { skip }, async () => {
      await runSplit(engine);
    });
    it(`Maverick split neg-distinct [${engine}] — negative-tick DISTINCT-reserve split, solver == oracle`, { skip }, async () => {
      await runSplitNegDistinct(engine);
    });
    it(`Maverick solo treeshake [${engine}] — production define set lands a non-zero Maverick fill`, { skip }, async () => {
      await runSoloTreeshake(engine);
    });
    it(`Maverick cross-through-tick-0 [${engine}] — signed-int32 walk crosses tick 0, wei-exact`, { skip }, async () => {
      await runCrossThroughTick0(engine);
    });
    it(`Maverick above-tick-0 [${engine}] — positive-tick walk fills wei-exact via the QL path`, { skip }, async () => {
      await runAboveTick0(engine);
    });
    it(`Maverick adverse-drift [${engine}] — descriptor-only walk re-anchors to live post-drift state`, { skip }, async () => {
      await runAdverseDrift(engine);
    });
  }
});
