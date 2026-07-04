/**
 * EcoSwap ROUTE-LEG QL venues (leg-QL) — MERGE lane, local EVM, NO fork.
 *
 * A QL venue (here: a Curve StableSwap fixture) competes as a MEMBER of a route LEG: the
 * solver builds its ladder ON-CHAIN at setup on the leg's EDGE pair (sized by the chain-order
 * fold), and the merge's route events elect/consume it as a flat constant-price SLICE
 * alongside the leg's pool brackets (1b venue head fold, Phase A legMemberWins election,
 * Phase B slice inversion, Phase C/D slice apply + cursor advance). This test hand-builds the
 * `prepared` universe (bypassing prepare — the epic's lane order puts discovery last), stands
 * up REAL local pools (UniV3 via V3LiquidityHelper + the CurveStableSwap.sol fixture whose
 * get_dy mirrors curve-math.ts bit-for-bit), compiles via the PRODUCTION buildSolverArgs /
 * protocolDefines path, cooks, and asserts the merge's awards WEI-EXACT against BOTH mirrors:
 *
 *   (1) VENUE-ONLY LEG — direct A→B V3 pool + route A→X→B whose X→B leg is ONE Curve QL
 *       venue (no pools). The route is viable ONLY through the venue, so the leg0 pool's
 *       tokenIn delta == the route award pins the slice event math end-to-end: the BINDING
 *       slice fully crosses (gross = remCap, out = remOut) and back-propagates through the
 *       leg0 POOL bracket (invertFarFromOut — the venue sits on the LAST leg, so the
 *       upstream inversion is the pool arm), and on leg0-binding events the DOWNSTREAM
 *       slice absorbs min(flow, remCap). kwayReference (cursor-faithful solver mirror) ==
 *       optimalSplit (neutral oracle) == the cooked deltas, to the WEI.
 *   (2) MIXED LEG, TWO cases — route-only universe whose X→B leg carries a V3 pool AND a
 *       steeper Curve venue, terminated by the global budget clamp (routePartialN). WHICH
 *       member the clamp elects is amount-dependent (probe-verified against an instrumented
 *       reference on these exact fixtures): at 100000e18 the merge splits INSIDE the leg
 *       (both members funded) but the clamp elects the leg1 V3 POOL — full slice events
 *       only; at 2000e18 the clamp lands ON the slice mid-row (remaining cap ≈115.8e18;
 *       5000e18+ elect the pool), exercising the CLAMPED-slice arm — min(pflow, remCap)
 *       consume + qinp accrual + cursor advance — ON-CHAIN. tokenIn-side deltas wei-exact;
 *       the leg1 X-side per-member split assert lands with the exec lane.
 *   (3) DEAD UPSTREAM (hF==0) — a route whose leg0 has NO members folds the leg-QL venue's
 *       ladderCap to 0 (the chain-order sizing fold's hF==0 arm) ⇒ the venue builds a
 *       zero-row ladder (born exhausted) and contributes ZERO; the route is dead and the
 *       direct pool takes the whole trade. Driven through the QUOTE path too (eth_call +
 *       stateOverride, the quoteEcoSwap mechanics, MintableERC20 slots 4/5): quoted ==
 *       cooked amountOut to the wei.
 *
 * NOT YET COOKED: a venue UPSTREAM of a binding leg. Every case here puts the venue on the
 * LAST leg, so the Phase B upstream-slice sentinel/inversion (need >= remOut ⇒ crossed;
 * mulDiv(need, remCap, remOut)) and the Phase C upstream-slice inversion are pinned by the
 * ecoswap.math.test.ts vectors + the mirrors only, NOT by an on-chain cook. A venue-on-leg0
 * (or mid-leg 3-hop) case needs exec-side asserts to be meaningful — it rides with the
 * exec/prepare lanes.
 *
 * The leg-QL EXEC dispatch is the NEXT lane — a leg venue's awarded input is computed by the
 * merge (and pulled: spent == totalInput includes it) but not yet swapped, so the OUTPUT-side
 * cases (venue receives its share; quote == cook on a venue-funded route) are gated behind
 * ECO_LANE4=1 below and land with that lane.
 *
 * Run: ECO_ENGINE=both npx tsx --test src/recipes/test/ecoswap.legql.evm.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseEther,
  encodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  type Abi,
  type Account,
  type Hex,
} from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { compileSauce, ECOSWAP_DIR } from "./harness/compile";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deployToken,
  createAndInitPool,
  mintPosition,
  getSlot0,
  getLiquidity,
  mint,
  approve,
  balanceOf,
  deployCurveStableSwap,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { MIN_SQRT_RATIO, SwapPoolType } from "../shared/constants";
import type { EcoPool, EcoSwapPrepared, EcoLegQlVenue } from "../shared/types";
import { buildSolverArgs, protocolDefines } from "../ecoswap/index";
import { getSqrtRatioAtTick, OFFSET } from "./ecoswap.math";
import { kwayReference } from "./ecoswap.solver-reference";
import {
  optimalSplit,
  type OptimalPool,
  type OptimalRoute,
  type OptimalLegQlVenue,
} from "./ecoswap.optimal";
import type { CurvePool } from "../shared/curve-math";

const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");
const HUGE = parseEther("1000000000");
const E18 = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
const ENGINE_CELLS = engineCells();
// The leg-QL EXEC dispatch is the NEXT lane: output-side cases (the venue actually swaps its
// awarded share) are written but skipped until that lane flips this knob.
const LANE4 = process.env.ECO_LANE4 === "1";

// Fee tiers (V3 feePpm == fee tier for the canonical tiers).
const FEE_DIRECT = 3000;
const TS_DIRECT = 60;
const FEE_LEG0 = 500;
const TS_LEG0 = 10;
const FEE_LEG1V3 = 3000;
const TS_LEG1V3 = 60;
// Curve fixture params (fee is 1e10-scaled — the descriptor's qd[3] carries it verbatim).
const CURVE_DEEP_BAL = [1_000_000n * E18, 1_200_000n * E18];
const CURVE_DEEP_A = 1000n;
const CURVE_DEEP_FEE = 4_000_000n; // 0.04%
const CURVE_STEEP_BAL = [150_000n * E18, 150_000n * E18];
const CURVE_STEEP_A = 20n;
const CURVE_STEEP_FEE = 3_000_000n; // 0.03%, steep low-A curve — bends within the trade

describe("EcoSwap route-leg QL venues — merge WEI-EXACT (venue-only / mixed / dead-upstream legs)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  // Tokens RELABELED ascending by address (A < X < B) so EVERY edge (A→X, X→B, A→B) is
  // zeroForOne — one direction to hand-stamp, priceLimit = MIN_SQRT_RATIO + 1.
  let tokA: Hex; // tokenIn
  let tokX: Hex; // intermediate
  let tokB: Hex; // tokenOut
  let directPool: Hex; // A→B V3 (fee 3000)
  let leg0Pool: Hex; // A→X V3 (fee 500)
  let leg1V3Pool: Hex; // X→B V3 (fee 3000) — the mixed-leg pool member
  let curveDeep: Hex; // X→B Curve fixture (deep, 0.04%)
  let curveSteep: Hex; // X→B Curve fixture (steep low-A, 0.03%)
  let solverSrc: string;
  let cleanSnapshot: Hex;

  const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    solverSrc = readFileSync(SOLVER, "utf-8");

    const t1 = await deployToken(c.walletClient, c.publicClient, "TokOne", "T1");
    const t2 = await deployToken(c.walletClient, c.publicClient, "TokTwo", "T2");
    const t3 = await deployToken(c.walletClient, c.publicClient, "TokThree", "T3");
    [tokA, tokX, tokB] = [t1, t2, t3].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : 1,
    );

    const minter = c.account0;
    for (const t of [tokA, tokX, tokB]) {
      await mint(c.walletClient, c.publicClient, t, minter, parseEther("1000000000"));
      await approve(c.walletClient, c.publicClient, t, stack.helper, HUGE);
    }

    // DIRECT A→B: shallow-ish, engages at the global cut against the route.
    directPool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokA, tokB, FEE_DIRECT, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, directPool, minter, -12000, 12000, parseEther("8000"),
    );
    // ROUTE leg0 A→X: deep, one wide position ⇒ constant L over the walked region (empty net).
    leg0Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokA, tokX, FEE_LEG0, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, leg0Pool, minter, -12000, 12000, parseEther("5000000"),
    );
    // MIXED-leg X→B V3: deep, competes inside the leg against the steep Curve venue.
    leg1V3Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokX, tokB, FEE_LEG1V3, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, leg1V3Pool, minter, -12000, 12000, parseEther("5000000"),
    );
    // Curve X→B fixtures (both at ~1:1 spot; deep/cheap vs steep low-A).
    curveDeep = await deployCurveStableSwap(
      c.walletClient, c.publicClient, [tokX, tokB], CURVE_DEEP_BAL, [E18, E18], CURVE_DEEP_A, CURVE_DEEP_FEE, minter,
    );
    curveSteep = await deployCurveStableSwap(
      c.walletClient, c.publicClient, [tokX, tokB], CURVE_STEEP_BAL, [E18, E18], CURVE_STEEP_A, CURVE_STEEP_FEE, minter,
    );

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => anvil?.stop());

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    // Pin the cook block timestamp: the V3 oracle accumulator depends on block.timestamp,
    // which drifts across evm_revert (the established routes-test idiom).
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  // ── Hand-built descriptor/model builders (bypass prepare — the epic lands discovery last) ──

  /** Live-read a V3 pool and build the matching hand-stamped EcoPool (windowTop=0 ⇒ the
   *  on-chain walk staticcalls every boundary — the no-cache live walk; empty net matches a
   *  single wide position whose mint-bound ticks the walk never reaches). All edges are
   *  zeroForOne (tokens relabeled ascending), so the start boundary is the tick base. */
  async function v3EcoPool(address: Hex, feePpm: number, ts: number): Promise<{
    pool: EcoPool;
    opt: OptimalPool;
  }> {
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, address);
    const liquidity = await getLiquidity(c.publicClient, address);
    const base = Math.floor(tick / ts) * ts;
    const pool: EcoPool = {
      poolType: SwapPoolType.UniV3,
      address,
      fee: feePpm,
      tickSpacing: ts,
      hooks: ZERO,
      feePpm,
      isV2: false,
      inIsToken0: true,
      stateView: ZERO,
      poolId: ZERO32,
      stepRatio: getSqrtRatioAtTick(ts),
      windowTopShifted: 0n,
      windowBotShifted: 0n,
      extremeShifted: 0n,
      spotTickShifted: BigInt(base) + OFFSET,
      spotNearReal: sqrtPriceX96,
      spotActiveL: liquidity,
      adaptiveNet: new Map<number, bigint>(),
      source: "legql-fixture",
    };
    const opt: OptimalPool = {
      isV2: false, feePpm, sqrtPriceX96, tick, tickSpacing: ts, liquidity,
      net: new Map<number, bigint>(),
    };
    return { pool, opt };
  }

  /** The Curve fixture as (a) the EcoLegQlVenue descriptor the qlv row is built from and
   *  (b) the shared-math CurvePool model the oracle/reference ladder from — SAME builder
   *  (buildLegQlVenueLadder → buildCurveQLLadder) as the on-chain live get_dy ladder. */
  function curveVenue(address: Hex, balances: bigint[], A: bigint, fee: bigint): {
    venue: EcoLegQlVenue;
    model: CurvePool;
    olv: OptimalLegQlVenue;
  } {
    const model: CurvePool = {
      poolType: 3, address, i: 0, j: 1, A, aPrecision: 100n,
      balances: [...balances], rates: [E18, E18], feePpm10: fee, source: "legql-fixture",
    };
    const venue: EcoLegQlVenue = {
      family: "curve",
      desc: { address, i: 0, j: 1, feePpm: Number(fee), source: "legql-fixture" },
    };
    return { venue, model, olv: { family: "curve", model } };
  }

  // ── eth_call QUOTE drive (the quoteEcoSwap mechanics inline — hand-built prepared can't go
  // through quoteEcoSwap, which runs the real prepare; discovery lands in the prepare lane) ──
  const cookCallAbi = parseAbi(["function cook(bytes[] ingredients) payable returns (bytes returnData)"]);
  function decodeCookUint(ret: Hex, engine: Engine): bigint {
    if (!ret || ret === "0x") return 0n;
    if (engine === "v1") {
      const blob = decodeFunctionResult({ abi: cookCallAbi as Abi, functionName: "cook", data: ret }) as unknown as Hex;
      const hex = blob.slice(2);
      return hex.length >= 64 ? BigInt("0x" + hex.slice(-64)) : 0n;
    }
    const hex = ret.slice(2);
    return hex.length >= 64 ? BigInt("0x" + hex.slice(-64)) : 0n;
  }
  /** MintableERC20 layout: balanceOf slot 4, allowance slot 5 (the quoteEcoSwap doc note). */
  function mappingSlot(key: Hex, slot: bigint): Hex {
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
  }
  function nestedMappingSlot(a: Hex, b: Hex, slot: bigint): Hex {
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [b, mappingSlot(a, slot)]));
  }
  const OVERRIDE_AMOUNT = ("0x" + "0".repeat(32) + "f".repeat(32)) as Hex;

  /** Read-only cook via eth_call with the caller's balance + allowance injected through
   *  stateOverride (NO on-chain approve) — the quoteEcoSwap state-override quote, inline. */
  async function quoteViaStateOverride(
    engine: Engine,
    target: Hex,
    caller: Hex,
    bytecodes: Hex[],
  ): Promise<bigint> {
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({
      account: caller,
      to: target,
      data,
      gas: 2_000_000_000n,
      stateOverride: [
        {
          address: tokA,
          stateDiff: [
            { slot: mappingSlot(caller, 4n), value: OVERRIDE_AMOUNT },
            { slot: nestedMappingSlot(caller, target, 5n), value: OVERRIDE_AMOUNT },
          ],
        },
      ],
    });
    return decodeCookUint(ret as Hex, engine);
  }

  function compilePrepared(
    engine: Engine,
    prepared: EcoSwapPrepared,
    amountIn: bigint,
    caller: Hex,
  ): Hex[] {
    const { bytecodes } = compileSauce(
      solverSrc,
      buildSolverArgs(tokA, tokB, amountIn, caller, prepared),
      ECOSWAP_DIR,
      engine,
      { treeshake: true, defines: protocolDefines(prepared) },
    );
    return bytecodes;
  }

  // ── (1) VENUE-ONLY LEG — the X→B leg is ONE Curve QL venue; wei-exact vs both mirrors ──
  async function runVenueOnlyLeg(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("20000");

    const direct = await v3EcoPool(directPool, FEE_DIRECT, TS_DIRECT);
    const leg0 = await v3EcoPool(leg0Pool, FEE_LEG0, TS_LEG0);
    const cv = curveVenue(curveDeep, CURVE_DEEP_BAL, CURVE_DEEP_A, CURVE_DEEP_FEE);

    const prepared: EcoSwapPrepared = {
      pools: [direct.pool],
      routes: [
        {
          legs: [
            { hopIn: tokA, hopOut: tokX, zeroForOne: true, pools: [leg0.pool] },
            { hopIn: tokX, hopOut: tokB, zeroForOne: true, pools: [], qlVenues: [cv.venue] },
          ],
          intermediateTokens: [tokX],
        },
      ],
      brackets: [],
      zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
      expectedInputCovered: 0n,
    };

    // Cursor-faithful reference (mirrors the solver bit-for-bit; its internal slice-equality +
    // conservation gates throw on ANY drift) and the neutral oracle — both from the SAME live
    // reads. The reference's fold/ladder use the SHARED buildLegQlVenueLadder the solver replays.
    const ref = kwayReference(prepared, amountIn, undefined, [[undefined, [cv.olv]]]);
    const optRoute: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [leg0.opt] },
        { zeroForOne: true, pools: [], qlvs: [cv.olv] },
      ],
    };
    const opt = optimalSplit({
      pools: [direct.opt], routes: [optRoute], amountIn, zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei)");
    assert.equal(ref.perPoolInput[0], opt.perPoolInput[0], "direct award == oracle (wei)");
    assert.equal(ref.perRouteInput[0], opt.perRouteInput[0], "route award == oracle (wei)");
    assert.ok(ref.perRouteInput[0] > 0n, "route engaged (viable ONLY through the leg venue)");
    assert.ok(ref.perPoolInput[0] > 0n, "direct engaged (global cut split)");
    assert.ok(ref.perLegQlvInput[0] > 0n, "leg venue awarded input (the qinp mirror)");

    const bytecodes = compilePrepared(engine, prepared, amountIn, caller);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const directABefore = await balanceOf(c.publicClient, tokA, directPool);
    const leg0ABefore = await balanceOf(c.publicClient, tokA, leg0Pool);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "venue-only-leg cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const directIn = (await balanceOf(c.publicClient, tokA, directPool)) - directABefore;
    const leg0In = (await balanceOf(c.publicClient, tokA, leg0Pool)) - leg0ABefore;

    // WEI-EXACT: the pull is the merge's cum (compute-then-pull) — it INCLUDES the slice-bound
    // route events — and the per-universe-pool awards land exactly. The leg0 gross was
    // back-propagated THROUGH the venue's slice inversion every event, so leg0In == the route
    // award pins the on-chain slice arithmetic (Phase B/C/D) to the mirrors.
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (wei)`);
    assert.equal(directIn, ref.perUniversePoolInput[0], `[${engine}] direct pool award == reference (wei)`);
    assert.equal(leg0In, ref.perUniversePoolInput[1], `[${engine}] leg0 pool award == reference (wei)`);
    assert.equal(leg0In, ref.perRouteInput[0], `[${engine}] leg0 gross == route award (2-leg identity)`);

    console.log(
      `  [legQL venue-only:${engine}] direct=${directIn} route=${leg0In} venueAward=${ref.perLegQlvInput[0]} spent=${spent} (== mirrors, wei)`,
    );
  }

  // ── (2) MIXED LEG — X→B carries a V3 pool AND a Curve venue; the leg splits internally ──
  async function runMixedLeg(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    // Route-only universe (no direct pool): the trade terminates via the global budget clamp
    // (routePartialN). At THIS amount the clamp event elects the leg1 V3 POOL (probe-verified:
    // 4 binding-slice + 13 downstream non-binding full events, 0 clamped-slice hits), so this
    // cook pins the FULL slice events + the leg-internal split; the clamped-slice arm is
    // pinned by the 2000e18 cook below (runMixedSliceClamp).
    const amountIn = parseEther("100000");

    const leg0 = await v3EcoPool(leg0Pool, FEE_LEG0, TS_LEG0);
    const leg1 = await v3EcoPool(leg1V3Pool, FEE_LEG1V3, TS_LEG1V3);
    const cv = curveVenue(curveSteep, CURVE_STEEP_BAL, CURVE_STEEP_A, CURVE_STEEP_FEE);

    const prepared: EcoSwapPrepared = {
      pools: [],
      routes: [
        {
          legs: [
            { hopIn: tokA, hopOut: tokX, zeroForOne: true, pools: [leg0.pool] },
            { hopIn: tokX, hopOut: tokB, zeroForOne: true, pools: [leg1.pool], qlVenues: [cv.venue] },
          ],
          intermediateTokens: [tokX],
        },
      ],
      brackets: [],
      zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
      expectedInputCovered: 0n,
    };

    const ref = kwayReference(prepared, amountIn, undefined, [[undefined, [cv.olv]]]);
    const optRoute: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [leg0.opt] },
        { zeroForOne: true, pools: [leg1.opt], qlvs: [cv.olv] },
      ],
    };
    const opt = optimalSplit({
      pools: [], routes: [optRoute], amountIn, zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei)");
    assert.equal(ref.perRouteInput[0], opt.perRouteInput[0], "route award == oracle (wei)");
    // The SPLIT INSIDE THE LEG: the steeper/cheaper Curve venue draws first, bends, and the
    // V3 pool takes the tail — BOTH leg1 members funded in the mirrors.
    assert.ok(ref.perLegQlvInput[0] > 0n, "leg venue awarded input (leg-internal split)");
    assert.ok(ref.perUniversePoolInput[1] > 0n, "leg1 V3 pool awarded input (leg-internal split)");

    const bytecodes = compilePrepared(engine, prepared, amountIn, caller);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const leg0ABefore = await balanceOf(c.publicClient, tokA, leg0Pool);
    const leg1XBefore = await balanceOf(c.publicClient, tokX, leg1V3Pool);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "mixed-leg cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const leg0In = (await balanceOf(c.publicClient, tokA, leg0Pool)) - leg0ABefore;
    const leg1V3In = (await balanceOf(c.publicClient, tokX, leg1V3Pool)) - leg1XBefore;

    // tokenIn-side WEI gate (the merge): spent == cum; leg0 absorbs the whole route gross.
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (wei)`);
    assert.equal(leg0In, ref.perUniversePoolInput[0], `[${engine}] leg0 pool award == reference (wei)`);
    assert.equal(leg0In, ref.perRouteInput[0], `[${engine}] leg0 gross == route award (2-leg identity)`);
    // X-side: pre-exec-lane the leg's realized X drains through its POOL members only (the
    // venue's share is merged/pulled but not yet swapped), so the leg1 pool receives > 0 —
    // the exact per-member X split assert lands with the exec lane (ECO_LANE4).
    assert.ok(leg1V3In > 0n, `[${engine}] leg1 V3 pool received intermediate X`);

    console.log(
      `  [legQL mixed:${engine}] route=${leg0In} leg1V3award=${ref.perUniversePoolInput[1]} venueAward=${ref.perLegQlvInput[0]} spent=${spent} (tokenIn-side == mirrors, wei)`,
    );
  }

  // ── (2b) MIXED LEG, SLICE-CLAMP — same fixtures, sized so the clamp lands ON the slice ──
  async function runMixedSliceClamp(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    // Sized so the terminal routePartialN event elects the SLICE (probe-verified on these
    // exact fixtures: the clamp lands mid-row, remaining cap ≈115.8e18, consuming ≈114.96e18;
    // at 5000e18+ the leg1 V3 pool overtakes and the clamp elects it instead — the 100000e18
    // cook above). This executes the solver's CLAMPED-slice arm — min(pflow, remCap) consume
    // + qinp accrual + cursor bookkeeping — ON-CHAIN (any transcription drift that breaks its
    // uint256 arithmetic reverts the cook; the value-level pin is the reference's internal
    // clamped-slice equality gate, which throws while computing `ref` below, plus the X-side
    // split assert that lands with the exec lane). tokenIn-side deltas stay the wei gate.
    const amountIn = parseEther("2000");

    const leg0 = await v3EcoPool(leg0Pool, FEE_LEG0, TS_LEG0);
    const leg1 = await v3EcoPool(leg1V3Pool, FEE_LEG1V3, TS_LEG1V3);
    const cv = curveVenue(curveSteep, CURVE_STEEP_BAL, CURVE_STEEP_A, CURVE_STEEP_FEE);

    const prepared: EcoSwapPrepared = {
      pools: [],
      routes: [
        {
          legs: [
            { hopIn: tokA, hopOut: tokX, zeroForOne: true, pools: [leg0.pool] },
            { hopIn: tokX, hopOut: tokB, zeroForOne: true, pools: [leg1.pool], qlVenues: [cv.venue] },
          ],
          intermediateTokens: [tokX],
        },
      ],
      brackets: [],
      zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
      expectedInputCovered: 0n,
    };

    const ref = kwayReference(prepared, amountIn, undefined, [[undefined, [cv.olv]]]);
    const optRoute: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [leg0.opt] },
        { zeroForOne: true, pools: [leg1.opt], qlvs: [cv.olv] },
      ],
    };
    const opt = optimalSplit({
      pools: [], routes: [optRoute], amountIn, zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei)");
    assert.equal(ref.perRouteInput[0], opt.perRouteInput[0], "route award == oracle (wei)");
    assert.equal(ref.totalInput, amountIn, "route-only universe absorbs the whole budget (clamped)");
    // The clamp-on-slice geometry: the venue is strictly cheaper all the way to the clamp, so
    // it takes the WHOLE leg1 award and the V3 pool takes NONE. If either assert fires, the
    // fixture drifted and the clamp election must be RE-PROBED — the clamped-slice arm this
    // case exists to cover may no longer execute.
    assert.ok(ref.perLegQlvInput[0] > 0n, "leg venue awarded input (incl. the clamped partial)");
    assert.equal(ref.perUniversePoolInput[1], 0n, "leg1 V3 pool NOT funded (venue cheaper to the clamp)");

    const bytecodes = compilePrepared(engine, prepared, amountIn, caller);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const leg0ABefore = await balanceOf(c.publicClient, tokA, leg0Pool);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "slice-clamp cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const leg0In = (await balanceOf(c.publicClient, tokA, leg0Pool)) - leg0ABefore;

    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (wei)`);
    assert.equal(leg0In, ref.perUniversePoolInput[0], `[${engine}] leg0 pool award == reference (wei)`);
    assert.equal(leg0In, ref.perRouteInput[0], `[${engine}] leg0 gross == route award (2-leg identity)`);

    console.log(
      `  [legQL slice-clamp:${engine}] route=${leg0In} venueAward=${ref.perLegQlvInput[0]} spent=${spent} (clamp landed ON the slice)`,
    );
  }

  // ── (3) DEAD UPSTREAM (hF==0) — empty leg0 folds the leg venue's ladderCap to 0 ──
  async function runDeadUpstream(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("2000");

    const direct = await v3EcoPool(directPool, FEE_DIRECT, TS_DIRECT);
    const cv = curveVenue(curveDeep, CURVE_DEEP_BAL, CURVE_DEEP_A, CURVE_DEEP_FEE);

    // leg0 has NO members ⇒ its best head hF == 0 ⇒ the chain-order sizing fold zeroes the
    // leg1 venue's ladderCap ⇒ the on-chain build emits a ZERO-ROW ladder (born exhausted;
    // zero quote staticcalls) AND the route is dead — the venue contributes ZERO and the
    // direct pool takes the whole trade.
    const prepared: EcoSwapPrepared = {
      pools: [direct.pool],
      routes: [
        {
          legs: [
            { hopIn: tokA, hopOut: tokX, zeroForOne: true, pools: [] },
            { hopIn: tokX, hopOut: tokB, zeroForOne: true, pools: [], qlVenues: [cv.venue] },
          ],
          intermediateTokens: [tokX],
        },
      ],
      brackets: [],
      zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
      expectedInputCovered: 0n,
    };

    const ref = kwayReference(prepared, amountIn, undefined, [[undefined, [cv.olv]]]);
    const optRoute: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [] },
        { zeroForOne: true, pools: [], qlvs: [cv.olv] },
      ],
    };
    const opt = optimalSplit({
      pools: [direct.opt], routes: [optRoute], amountIn, zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
    });
    assert.equal(ref.perRouteInput[0], 0n, "dead route awarded nothing (reference)");
    assert.equal(opt.perRouteInput[0], 0n, "dead route awarded nothing (oracle)");
    assert.equal(ref.perLegQlvInput[0], 0n, "leg venue contributes ZERO (born-exhausted ladder)");
    assert.equal(ref.totalInput, opt.totalInput, "direct-only total == oracle (wei)");
    assert.equal(ref.totalInput, amountIn, "the direct pool absorbs the whole trade");

    const bytecodes = compilePrepared(engine, prepared, amountIn, caller);

    // QUOTE path FIRST (eth_call + stateOverride, NO on-chain approve — the override supplies
    // balance+allowance): a dead-route universe executes pool-only, so the read-only realized
    // output is exactly what the cook below lands.
    const quoted = await quoteViaStateOverride(engine, target, caller, bytecodes);
    assert.ok(quoted > 0n, `[${engine}] state-override quote returns a positive output`);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const callerBBefore = await balanceOf(c.publicClient, tokB, caller);
    const directABefore = await balanceOf(c.publicClient, tokA, directPool);
    const curveXBefore = await balanceOf(c.publicClient, tokX, curveDeep);
    const curveBBefore = await balanceOf(c.publicClient, tokB, curveDeep);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "dead-upstream cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const received = (await balanceOf(c.publicClient, tokB, caller)) - callerBBefore;
    const directIn = (await balanceOf(c.publicClient, tokA, directPool)) - directABefore;

    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (wei)`);
    assert.equal(directIn, ref.perUniversePoolInput[0], `[${engine}] direct pool took the whole trade (wei)`);
    // The venue contributed zero — its pool balances are untouched (holds post-exec-lane too:
    // the route is dead, nothing is awarded, nothing executes).
    assert.equal(await balanceOf(c.publicClient, tokX, curveDeep), curveXBefore, "venue X balance untouched");
    assert.equal(await balanceOf(c.publicClient, tokB, curveDeep), curveBBefore, "venue B balance untouched");
    // QUOTE == COOK: the state-override eth_call realized the same output the cook landed.
    assert.equal(quoted, received, `[${engine}] quoted amountOut == cooked amountOut (wei)`);

    console.log(
      `  [legQL dead-upstream:${engine}] quoted=${quoted} cooked=${received} spent=${spent} (venue contributed zero)`,
    );
  }

  // ── LANE-4-GATED — output-side cases (need the leg-QL EXEC dispatch; ECO_LANE4=1) ──
  async function runVenueOnlyOutput(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("20000");

    const direct = await v3EcoPool(directPool, FEE_DIRECT, TS_DIRECT);
    const leg0 = await v3EcoPool(leg0Pool, FEE_LEG0, TS_LEG0);
    const cv = curveVenue(curveDeep, CURVE_DEEP_BAL, CURVE_DEEP_A, CURVE_DEEP_FEE);
    const prepared: EcoSwapPrepared = {
      pools: [direct.pool],
      routes: [
        {
          legs: [
            { hopIn: tokA, hopOut: tokX, zeroForOne: true, pools: [leg0.pool] },
            { hopIn: tokX, hopOut: tokB, zeroForOne: true, pools: [], qlVenues: [cv.venue] },
          ],
          intermediateTokens: [tokX],
        },
      ],
      brackets: [],
      zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
      expectedInputCovered: 0n,
    };
    const ref = kwayReference(prepared, amountIn, undefined, [[undefined, [cv.olv]]]);
    const bytecodes = compilePrepared(engine, prepared, amountIn, caller);

    // Zero-cache QUOTE == COOK (the spec's quote case on a venue-funded route): the leg venue
    // executes its awarded share, so the read-only realized output equals the cook's.
    const quoted = await quoteViaStateOverride(engine, target, caller, bytecodes);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const callerBBefore = await balanceOf(c.publicClient, tokB, caller);
    const curveXBefore = await balanceOf(c.publicClient, tokX, curveDeep);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "venue-only-leg output cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const received = (await balanceOf(c.publicClient, tokB, caller)) - callerBBefore;
    const curveXIn = (await balanceOf(c.publicClient, tokX, curveDeep)) - curveXBefore;

    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (wei)`);
    // The venue was FUNDED with its intermediate-token share (the leg exec dispatch swapped
    // the realized X through the Curve pool) and the caller received the route's tokenOut.
    assert.ok(curveXIn > 0n, `[${engine}] leg venue funded with intermediate X`);
    assert.ok(received > 0n, `[${engine}] caller received tokenOut through the venue leg`);
    assert.equal(quoted, received, `[${engine}] quoted amountOut == cooked amountOut (wei)`);

    console.log(
      `  [legQL venue-only OUTPUT:${engine}] venueX=${curveXIn} received=${received} quoted=${quoted} spent=${spent}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`venue-only leg [${engine}] — Curve QL leg member, merge awards == mirrors wei-exact`, { skip }, async () => {
      await runVenueOnlyLeg(engine);
    });
    it(`mixed pool+venue leg [${engine}] — split INSIDE the leg (clamp elects the pool)`, { skip }, async () => {
      await runMixedLeg(engine);
    });
    it(`mixed leg slice-clamp [${engine}] — budget clamp lands ON the slice (routePartialN arm)`, { skip }, async () => {
      await runMixedSliceClamp(engine);
    });
    it(`dead upstream (hF==0) [${engine}] — venue contributes zero; state-override quote == cook`, { skip }, async () => {
      await runDeadUpstream(engine);
    });
    // Output-side (exec) cases — land with the leg-QL exec lane (ECO_LANE4=1 flips them on).
    it(
      `venue-only leg OUTPUT [${engine}] — venue executes its share; quote == cook (exec lane)`,
      { skip: skip || !LANE4 },
      async () => {
        await runVenueOnlyOutput(engine);
      },
    );
  }
});
