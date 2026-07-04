/**
 * EcoSwap PANCAKESWAP STABLESWAP (BSC legacy-Curve Solidity port) QUOTE-LADDER (QL) local-EVM
 * integration — the uint256-index StableSwap gate (segKind 20, the CryptoSwap segKind-9 execution
 * class with a getPairInfo-keyed discovery).
 *
 * PancakeStableSwap is a QUOTE-LADDER family: prepare ships ONLY a descriptor [pool, i, j, feePpm,
 * segKind=20, refIdx, 0…] — NO off-chain sampled ladder — and the on-chain solver builds the
 * venue's price ladder in setup from LIVE cook-time `get_dy(uint256 i, uint256 j, xNext)`
 * (PROBE-THEN-DECODE — an EMPTY pool's get_D divides by zero and REVERTS, the real drained class;
 * zero/oversize quote gracefully). EXEC is callback-free — coins(0) orients i/j on-chain
 * (derive-don't-trust), live get_dy as `min_dy − 1` (the view/exchange ROUNDING-FORM split: the
 * real source computes the view's dy SCALE-then-fee but the exchange's fee-then-SCALE, so a
 * mixed-decimal pool can land EXACTLY 1 wei below the view — pinned by cell 6), approve POOL,
 * exchange(i, j, Σ, min_dy) — exchange pulls EXACTLY dx via transferFrom (pull == approve, so
 * residue == 0 by construction, asserted).
 *
 * The oracle prices the venue via buildPancakeStableQLLadder driven by the bit-exact
 * pancakeStableGetDy replay (curve-math getD/getY at the LEGACY A_PRECISION=1 + the VIEW-form
 * rounding), so oracle == solver to the WEI.
 *
 *   (1) SOLO — ladder covers [0, amountIn]; received == get_dy(amountIn) == the replay (18-dec ⇒
 *       both rounding forms coincide), pulled == amountIn, residue == 0.
 *   (2) + a live V3 direct pool — split == the neutral oracle to the WEI.
 *   (3) QL Curve (segKind 1, int128) + QL PancakeStable (segKind 20, uint256) in ONE qlv — the
 *       generalized ladder loop builds both, interleaves them in the sort, per-leg dy wei-exact.
 *   (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE, quote == get_dy(amountIn).
 *   (5) ADVERSE DRIFT via a REAL exchange — the pre-drift bytecodes re-anchor (the pancake share
 *       shrinks, V3 grows), split == the drifted oracle wei-exact.
 *   (6) MIXED-DECIMAL ROUNDING SPLIT — a 6/18-dec pool at a scanned dx where the exchange dy is
 *       EXACTLY 1 wei below the view quote: the cook SUCCEEDS (min_dy = quote − 1) and received ==
 *       the EXCHANGE-form replay (the raw view quote as min_dy would have reverted).
 *   (7) DRAINED POOL — a zero out-balance REVERTS get_dy (the real class): the venue self-drops
 *       (probe-then-decode), V3 absorbs, never a DoS. Residue 0.
 *   (8) DISCOVERY — production discoverPancakeStablePoolsTyped resolves the pool via getPairInfo
 *       BOTH argument orders (order-independent), stamps i/j per direction, reads feePpm from
 *       fee(), returns [] for an unknown pair (zero struct), and drops a drained pool.
 *
 * No fork / no RPC env — local fixtures deploy the whole stack. Runs on v1 (+ v12 when present),
 * driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil. Mirrors ecoswap.crypto.evm.test.ts.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseEther,
  parseUnits,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  createPublicClient,
  http,
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
  deploySortedTokens,
  deployToken,
  createAndInitPool,
  mintPosition,
  getSlot0,
  getLiquidity,
  mint,
  approve,
  balanceOf,
  deployCurveStableSwap,
  deployPancakeStableSwap,
  pancakeStableFixtureAbi,
  pancakeStableFactoryFixtureAbi,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO, SwapPoolType, FactoryType, type FactoryConfig } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { getDy, type CurvePool } from "../shared/curve-math";
import {
  pancakeStableGetDy,
  pancakeStableExchangeDy,
  buildPancakeStableQLLadder,
  type PancakeStablePool,
  type PancakeStableState,
} from "../shared/pancakestable-math";
import { discoverPancakeStablePoolsTyped } from "../shared/pool-discovery";

const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const ENGINE_CELLS = engineCells();

// The real USDT/USDC pool's parameters (probed 2026-07-04): A=1000, fee=1e6 (0.01% of 1e10),
// admin_fee at the Curve-classic 50%.
const A_PARAM = 1000n;
const FEE = 1_000_000n;
const ADMIN_FEE = 5_000_000_000n;

// PancakeStable-only treeshake defines (HAS_PANCAKE_STABLE lights the qKind-20 ladder branch +
// the segKind-20 accumulator + the callback-free exec; the live V3 frontier + merge core are
// unguarded). Mirrors index.ts protocolDefines.
const PKS_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
  HAS_TESSERA: false, HAS_ELFOMO: false, HAS_METRIC: false, HAS_LIQUIDCORE: false, HAS_SIZE: false,
  HAS_PANCAKE_STABLE: true,
};

// Curve StableSwap (segKind 1) + PancakeStable (segKind 20) — the interleave cell's define set.
const CURVE_PKS_DEFINES: Record<string, boolean> = {
  ...PKS_DEFINES,
  HAS_CURVE: true,
};

// The solver's 6 compiler args (index.ts order): cfg, pools, netCache, routing, segs, qlv.
function args(
  tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex,
  directCount: number, pools: bigint[][], qlv: bigint[][],
): unknown[] {
  return [
    [BigInt(tokenIn), BigInt(tokenOut), amountIn, BigInt(caller), MIN_SQRT_RATIO + 1n, BigInt(directCount)],
    pools, [], [], [], qlv,
  ];
}

// One QL PancakeStable descriptor row — the production shape (index.ts qlRowFor):
// [pool, i, j, feePpm, 20, refIdx]. i/j are the UINT256 coin indices getPairInfo orients.
function pksDescriptor(pool: Hex, i: number, j: number, refIdx: number, feePpm = 100): bigint[] {
  return [BigInt(pool), BigInt(i), BigInt(j), BigInt(feePpm), 20n, BigInt(refIdx)];
}

// One QL Curve StableSwap descriptor: [poolAddr, i, j, feePpm10, segKind=1, refIdx].
function curveDescriptor(pool: Hex, refIdx: number, feePpm10: bigint): bigint[] {
  return [BigInt(pool), 0n, 1n, feePpm10, 1n, BigInt(refIdx)];
}

function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, BigInt(pool), BigInt(feePpm), BigInt(tickSpacing), 0n, BigInt(feePpm), 0n,
    inIsToken0 ? 1n : 0n, 0n, 0n, getSqrtRatioAtTick(tickSpacing), 0n, 0n, 0n, 0n, 0n, 0n,
  ];
}

describe("EcoSwap PANCAKE STABLESWAP QL live-walk (local fixture) — uint256-index get_dy ladder + callback-free exchange", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let token0: Hex; // sorted lower — coins(0) when passed [token0, token1]
  let token1: Hex;
  let solverSrc: string;

  async function setup(): Promise<void> {
    const prev = anvil;
    prev?.stop();
    await prev?.stopped;
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    token0 = tk.token0;
    token1 = tk.token1;
    solverSrc = readFileSync(SOLVER, "utf-8");
    await mint(c.walletClient, c.publicClient, token0, c.account0, parseEther("500000000"));
    await mint(c.walletClient, c.publicClient, token1, c.account0, parseEther("500000000"));
    await approve(c.walletClient, c.publicClient, token0, stack.helper, parseEther("1000000000"));
    await approve(c.walletClient, c.publicClient, token1, stack.helper, parseEther("1000000000"));
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
  }

  after(() => {
    anvil?.stop();
  });

  async function deployPool(
    bal0: bigint,
    bal1: bigint,
    a: bigint = A_PARAM,
    fee: bigint = FEE,
  ): Promise<{ pool: Hex; factory: Hex }> {
    return deployPancakeStableSwap(
      c.walletClient, c.publicClient,
      [token0, token1], [bal0, bal1], [E18, E18], a, fee, ADMIN_FEE,
      c.walletClient.account as Account,
    );
  }

  const allowanceAbi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);
  async function allowanceOf(token: Hex, owner: Hex, spender: Hex): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: token, abi: allowanceAbi as Abi, functionName: "allowance", args: [owner, spender],
    })) as bigint;
  }

  /** The pool's own LIVE get_dy view — the engine-independent ground truth. */
  async function onGetDy(pool: Hex, i: number, j: number, dx: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: pool, abi: pancakeStableFixtureAbi as Abi, functionName: "get_dy",
      args: [BigInt(i), BigInt(j), dx],
    })) as bigint;
  }

  /** Read live balances off the pool (for the post-drift oracle rebuild). */
  async function liveBalances(pool: Hex): Promise<[bigint, bigint]> {
    const b0 = (await c.publicClient.readContract({
      address: pool, abi: pancakeStableFixtureAbi as Abi, functionName: "balances", args: [0n],
    })) as bigint;
    const b1 = (await c.publicClient.readContract({
      address: pool, abi: pancakeStableFixtureAbi as Abi, functionName: "balances", args: [1n],
    })) as bigint;
    return [b0, b1];
  }

  // Off-chain PancakeStablePool oracle model — the VIEW-form replay (== the on-chain ladder quote)
  // over the given balances. 18-dec both sides here (rates 1e18/1e18) ⇒ view == exchange form.
  function offPool(pool: Hex, bal0: bigint, bal1: bigint, a: bigint = A_PARAM, fee: bigint = FEE, i = 0, j = 1, rates: [bigint, bigint] = [E18, E18]): PancakeStablePool {
    const state: PancakeStableState = { A: a, fee, balances: [bal0, bal1], rates };
    return {
      address: pool,
      factory: "0x0000000000000000000000000000000000000000",
      i, j,
      tokenIn: i === 0 ? token0 : token1,
      tokenOut: j === 1 ? token1 : token0,
      feePpm: 100,
      source: "local-fixture",
      getDy: (dx: bigint) => pancakeStableGetDy(state, i, j, dx),
    };
  }

  function offCurvePool(address: Hex, balances: bigint[], a: bigint, fee: bigint): CurvePool {
    return { poolType: 3, address, i: 0, j: 1, A: a, aPrecision: 100n, balances, rates: [E18, E18], feePpm10: fee, source: "local-fixture" };
  }

  // ── (1) SOLO — ladder built from live get_dy; received == get_dy == replay; residue 0 ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const BAL = 1_000_000n * E18;
    const { pool } = await deployPool(BAL, BAL);
    const amountIn = 100_000n * E18;
    const op = offPool(pool, BAL, BAL);
    const ladder = buildPancakeStableQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL PancakeStable ladder");
    assert.equal(
      ladder.reduce((a, s) => a + s.capacity, 0n), amountIn,
      "ladder covers the full amountIn (strictly-convex A-invariant — no early stop)",
    );

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [pksDescriptor(pool, 0, 1, 0)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: PKS_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const poolInBefore = await balanceOf(c.publicClient, token0, pool);
    const onViewPre = await onGetDy(pool, 0, 1, amountIn);
    assert.equal(onViewPre, op.getDy(amountIn), "TS view-form replay == the pool get_dy view (bit-exact)");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL PancakeStable cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, token0, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL PancakeStable venue)");
    assert.equal(poolIn, amountIn, "the pool pulled EXACTLY dx (exchange transferFrom — pull == approve)");
    // 18-dec pair ⇒ the view and exchange rounding forms coincide: received == get_dy exactly.
    assert.equal(received, onViewPre, "received == pool get_dy(amountIn) to the wei (exact-in-dy)");
    const stateNow: PancakeStableState = { A: A_PARAM, fee: FEE, balances: [BAL, BAL], rates: [E18, E18] };
    assert.equal(received, pancakeStableExchangeDy(stateNow, 0, 1, amountIn), "received == exchange-form replay");
    // RESIDUE SWEEP (the Metric USDT-class lesson): exchange pulls EXACTLY dx via transferFrom
    // (VERIFIED source) — pull == approve, so no allowance residue survives on the shared cooking
    // contract (a residue would brick later cooks on nonzero→nonzero-revert tokens).
    assert.equal(await allowanceOf(token0, target, pool), 0n, "no pool allowance residue (pull == approve)");

    console.log(
      `  [QL PancakeStable solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== get_dy to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) + a live V3 direct pool — split == oracle wei-exact ──
  async function runPksV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A SHALLOW-ish stable pool (200k/side, A=100, 0.01% fee ⇒ draws FIRST but bends inside the
    // trade) vs a DEEP 1:1 V3 pool (0.3%, one wide position ⇒ constant L). The A-invariant bends
    // below the deep V3 post-fee marginal within the trade, so the marginal curves CROSS and BOTH
    // venues receive input (verified numerically: ≈146k V3 / ≈154k PKS at 300k in).
    const BAL = 200_000n * E18;
    const PKS_A = 100n;
    const { pool } = await deployPool(BAL, BAL, PKS_A);
    const op = offPool(pool, BAL, BAL, PKS_A);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const amountIn = 300_000n * E18;
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({
      pools: [v3Opt, { pancakeStable: op, feePpm: 0 } as OptimalPool],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oPks = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oPks > 0n, `oracle splits across V3 + PancakeStable (V3 ${oV3}, PKS ${oPks})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [pksDescriptor(pool, 0, 1, 0)];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: PKS_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const pksInBefore = await balanceOf(c.publicClient, token0, pool);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "PancakeStable+V3 cook() must succeed");

    const pksIn = (await balanceOf(c.publicClient, token0, pool)) - pksInBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.ok(pksIn > 0n && v3In > 0n, `both venues funded (PKS ${pksIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(pksIn, oPks, "PancakeStable awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL PancakeStable+V3:${engine}] V3 in=${v3In} PKS in=${pksIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) QL Curve (segKind 1, int128) + QL PancakeStable (segKind 20, uint256) in ONE qlv ──
  async function runCurvePks(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A SHALLOW steep Curve (A=20, 0.03% fee, 150k/side ⇒ draws FIRST but bends fast) vs a
    // MID-DEPTH PancakeStable (200k/side, A=50, 0.04%). The marginal curves CROSS inside the
    // trade, so BOTH QL venues (segKind 1 + 20) receive input and their on-chain ladders
    // INTERLEAVE in the DESC sort (verified numerically: ≈108k Curve / ≈192k PKS at 300k in).
    const curveBal = [150_000n * E18, 150_000n * E18];
    const CURVE_A = 20n, CURVE_FEE = 3_000_000n;
    const curve = await deployCurveStableSwap(c.walletClient, c.publicClient, [token0, token1], curveBal, [E18, E18], CURVE_A, CURVE_FEE, caller);
    const opCurve = offCurvePool(curve, curveBal, CURVE_A, CURVE_FEE);

    const BAL = 200_000n * E18;
    const PKS_A = 50n, PKS_FEE = 4_000_000n;
    const { pool } = await deployPool(BAL, BAL, PKS_A, PKS_FEE);
    const opPks = offPool(pool, BAL, BAL, PKS_A, PKS_FEE);

    const amountIn = 300_000n * E18;
    const oracle = optimalSplit({
      pools: [{ curve: opCurve, feePpm: 0 } as OptimalPool, { pancakeStable: opPks, feePpm: 0 } as OptimalPool],
      amountIn, zeroForOne: true,
    });
    const oCurve = oracle.perPoolInput[0] ?? 0n;
    const oPks = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oCurve > 0n && oPks > 0n, `oracle splits across QL Curve + QL PancakeStable (Curve ${oCurve}, PKS ${oPks})`);

    const qlv = [curveDescriptor(curve, 0, CURVE_FEE), pksDescriptor(pool, 0, 1, 0)];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 0, [], qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: CURVE_PKS_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const curveInBefore = await balanceOf(c.publicClient, token0, curve);
    const pksInBefore = await balanceOf(c.publicClient, token0, pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "QL Curve + QL PancakeStable cook() must succeed");

    const curveIn = (await balanceOf(c.publicClient, token0, curve)) - curveInBefore;
    const pksIn = (await balanceOf(c.publicClient, token0, pool)) - pksInBefore;
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.ok(curveIn > 0n && pksIn > 0n, `both QL venues funded (Curve ${curveIn}, PKS ${pksIn})`);
    assert.equal(curveIn, oCurve, "Curve awarded input == oracle (wei-exact split)");
    assert.equal(pksIn, oPks, "PancakeStable awarded input == oracle (wei-exact split)");
    // PER-LEG WEI-EXACT-IN-DY: received == curve get_dy(curveIn) + pancake get_dy(pksIn) (18-dec ⇒
    // the exchange form == the view form on both). NO tolerance.
    assert.equal(
      received, getDy(opCurve, curveIn) + opPks.getDy(pksIn),
      "received == Σ per-venue get_dy(share) to the wei",
    );

    console.log(
      `  [QL Curve+PancakeStable:${engine}] Curve in=${curveIn} PKS in=${pksIn} received=${received} ` +
        `(segKind 1 + 20 interleaved; split == oracle, dy wei-exact)`,
    );
  }

  // ── (4) ZERO-CACHE QUOTE ──
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

  async function runZeroCacheQuote(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const BAL = 1_000_000n * E18;
    const { pool } = await deployPool(BAL, BAL);
    const amountIn = 100_000n * E18;

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [pksDescriptor(pool, 0, 1, 0)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: PKS_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(
      quoted, await onGetDy(pool, 0, 1, amountIn),
      "zero-cache QUOTE == get_dy(amountIn) to the wei (ladder built live in the eth_call)",
    );
    console.log(`  [QL PancakeStable zero-cache quote:${engine}] quoted=${quoted} (== get_dy, no prepared cache)`);
  }

  // ── (5) ADVERSE DRIFT via a REAL exchange — the pre-drift bytecodes re-anchor ──
  async function runAdverseDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const BAL = 500_000n * E18;
    const { pool } = await deployPool(BAL, BAL);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };

    const amountIn = 300_000n * E18;
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [pksDescriptor(pool, 0, 1, 0)];
    // Bytecode built against the PRE-drift universe — the descriptor carries NO pool state, so the
    // SAME bytecode is cooked after drift; only the LIVE get_dy the ladder reads changes.
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: PKS_DEFINES },
    );

    const oraclePre = optimalSplit({
      pools: [v3Opt, { pancakeStable: offPool(pool, BAL, BAL), feePpm: 0 } as OptimalPool],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const pksSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(pksSharePre > 0n, "baseline oracle awards the PancakeStable venue a share");

    // ADVERSE DRIFT: a REAL coin0→coin1 exchange imbalances the pool (more coin0, less coin1) so
    // subsequent coin0→coin1 swaps price WORSE.
    const driftIn = 50_000n * E18;
    await approve(c.walletClient, c.publicClient, token0, pool, driftIn);
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: pool, abi: pancakeStableFixtureAbi as Abi, functionName: "exchange",
        args: [0n, 1n, driftIn, 0n], account: caller, chain: c.walletClient.chain,
      }),
    });
    // The DRIFTED oracle — rebuilt from the pool's LIVE post-drift booked balances (the fixture
    // takes the admin fee out of balances exactly like the real pool, so the live read IS the
    // ground truth the on-chain ladder quotes against).
    const [b0, b1] = await liveBalances(pool);
    const oracleDrift = optimalSplit({
      pools: [v3Opt, { pancakeStable: offPool(pool, b0, b1), feePpm: 0 } as OptimalPool],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const pksShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(pksShareDrift > 0n, "drifted oracle still awards the venue a (smaller) share");
    assert.ok(pksShareDrift < pksSharePre, `adverse drift shrinks the pancake share (${pksShareDrift} < ${pksSharePre})`);

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const pksInBefore = await balanceOf(c.publicClient, token0, pool);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "adverse-drift PancakeStable+V3 cook() must succeed");

    const pksIn = (await balanceOf(c.publicClient, token0, pool)) - pksInBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.ok(pksIn > 0n && v3In > 0n, "both venues funded post-drift");
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(pksIn, pksShareDrift, "PancakeStable awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(pksIn < pksSharePre, `pancake share ADAPTED down after adverse drift (${pksIn} < baseline ${pksSharePre})`);

    console.log(
      `  [QL PancakeStable+V3 adverse-drift:${engine}] baseline share=${pksSharePre} → re-anchored=${pksIn} ` +
        `(V3 grew to ${v3In}); received=${received} (split RE-ANCHORED to the live drifted curve)`,
    );
  }

  // ── (6) MIXED-DECIMAL ROUNDING SPLIT — the min_dy − 1 gate ──
  // A 6-dec out-coin pool (rates [1e18, 1e30]) at a SCANNED dx where the exchange's fee-then-SCALE
  // dy lands EXACTLY 1 wei below the view's SCALE-then-fee quote. The exec passes min_dy = quote − 1,
  // so the cook SUCCEEDS and received == the EXCHANGE-form replay (the raw view quote as min_dy
  // would revert "Exchange resulted in fewer coins than expected" — the DoS this arm exists for).
  async function runMixedDecimalRounding(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // token6 — a 6-decimal out-coin. Sort against token0 so coins order is well-defined.
    const token6 = await deployToken(c.walletClient, c.publicClient, "SixDec", "SIX", 6);
    await mint(c.walletClient, c.publicClient, token6, c.account0, parseUnits("500000000", 6));
    const [cA, cB]: [Hex, Hex] = BigInt(token0) < BigInt(token6) ? [token0, token6] : [token6, token0];
    const decA = cA === token6 ? 6 : 18;
    const decB = cB === token6 ? 6 : 18;
    const rates: [bigint, bigint] = [
      E18 * 10n ** BigInt(18 - decA),
      E18 * 10n ** BigInt(18 - decB),
    ];
    // A SMALL pool (10k/side, A=100) — real curvature, so the QL ladder's integer heads stay
    // STRICTLY descending and the ladder covers the scanned dx in full (a deep pool at these
    // sizes is so flat that consecutive heads round EQUAL and the non-descending guard truncates
    // the ladder — then only the first slice would be awarded).
    const PKS_A6 = 100n;
    const balA = parseUnits("10000", decA);
    const balB = parseUnits("10000", decB);
    const { pool } = await deployPancakeStableSwap(
      c.walletClient, c.publicClient, [cA, cB], [balA, balB], rates, PKS_A6, FEE, ADMIN_FEE,
      c.walletClient.account as Account,
    );

    // Swap 18-dec → 6-dec (the scaled-down out side is where the rounding forms split).
    const inIs18 = decA === 18;
    const i = inIs18 ? 0 : 1;
    const j = 1 - i;
    const tokenIn = inIs18 ? cA : cB;
    const tokenOut = inIs18 ? cB : cA;
    const state: PancakeStableState = { A: PKS_A6, fee: FEE, balances: [balA, balB], rates };
    const opScan: PancakeStablePool = {
      address: pool, factory: "0x0000000000000000000000000000000000000000",
      i, j, tokenIn, tokenOut, feePpm: 100, source: "local-fixture",
      getDy: (v: bigint) => pancakeStableGetDy(state, i, j, v),
    };

    // SCAN for a dx where (a) the exchange form lands exactly 1 wei BELOW the view form (the
    // proven worst case) AND (b) the QL ladder covers dx in FULL (so the merge awards the whole
    // dx and the exec quotes get_dy(dx) — the exact pairing the −1 gate protects). Deterministic
    // given the fixed pool state; assert we find one (hit at k=3 with these parameters).
    let dx = 0n;
    for (let k = 0; k <= 20_000; k++) {
      const cand = 1_000n * E18 + BigInt(k) * 10n ** 14n + 7n; // sub-quantum offsets shift the remainders
      const g = pancakeStableGetDy(state, i, j, cand);
      const e = pancakeStableExchangeDy(state, i, j, cand);
      assert.ok(e >= g - 1n, "exchange dy never lands more than 1 wei below the view (proven bound)");
      if (e !== g - 1n || g <= 1n) continue;
      const lad = buildPancakeStableQLLadder(opScan, cand);
      if (lad.reduce((a, s2) => a + s2.capacity, 0n) !== cand) continue;
      dx = cand;
      break;
    }
    assert.ok(dx > 0n, "found a full-cover dx where exchange dy == view dy − 1 (the mixed-decimal split)");
    const viewDy = pancakeStableGetDy(state, i, j, dx);
    const exchDy = pancakeStableExchangeDy(state, i, j, dx);
    assert.equal(await onGetDy(pool, i, j, dx), viewDy, "on-chain get_dy == view-form replay at the scanned dx");

    const { bytecodes } = compileSauce(
      solverSrc,
      args(tokenIn, tokenOut, dx, caller, 0, [], [pksDescriptor(pool, i, j, 0)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: PKS_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, tokenIn, target, dx);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(
      receipt.status, "success",
      "mixed-decimal cook() SUCCEEDS at the exact −1-wei rounding split (min_dy = quote − 1)",
    );
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    assert.equal(received, exchDy, "received == the EXCHANGE-form dy (1 wei below the view quote)");
    assert.equal(received, viewDy - 1n, "the split case is real: received == view quote − 1 wei");
    assert.equal(await allowanceOf(tokenIn, target, pool), 0n, "no allowance residue on the mixed-decimal pool");

    console.log(
      `  [QL PancakeStable mixed-dec:${engine}] dx=${dx} viewDy=${viewDy} exchangeDy=${exchDy} ` +
        `(cook survived the −1-wei rounding split; residue 0)`,
    );
  }

  // ── (7) DRAINED POOL — a zero out-balance REVERTS get_dy: the venue self-drops, V3 absorbs ──
  async function runDrained(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const { pool } = await deployPool(200_000n * E18, 0n); // ZERO coin1 balance — the drained class
    const amountIn = 20_000n * E18;

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));

    await assert.rejects(
      onGetDy(pool, 0, 1, amountIn),
      "an EMPTY pool REVERTS get_dy (get_D divides by zero — the real probed class)",
    );

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [pksDescriptor(pool, 0, 1, 0)];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: PKS_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const pksInBefore = await balanceOf(c.publicClient, token0, pool);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drained-pool cook() SUCCEEDS (probe-then-decode — never a DoS)");

    const pksIn = (await balanceOf(c.publicClient, token0, pool)) - pksInBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.equal(pksIn, 0n, "the DRAINED PancakeStable venue received 0 (revert probe ⇒ zero ladder — self-dropped)");
    assert.equal(v3In, spent, "the whole spent input landed on V3");
    assert.equal(spent, amountIn, "the trade still fills in full (V3 absorbs it)");
    assert.ok(received > 0n, "caller receives tokenOut via V3");

    console.log(`  [QL PancakeStable drained:${engine}] PKS=0 V3=${v3In} received=${received} (venue self-dropped, no DoS)`);
  }

  // ── (8) DISCOVERY — the production typed path against the fixture factory (no cook) ──
  async function runDiscovery(): Promise<void> {
    await setup();
    const BAL = 200_000n * E18;
    const { pool, factory } = await deployPool(BAL, BAL);
    const client = createPublicClient({ transport: http(anvil.rpcUrl) });
    const cfg: FactoryConfig = {
      address: factory, poolType: SwapPoolType.Curve, factoryType: FactoryType.PancakeStableSwap, label: "Local PancakeStableSwap",
    };
    const amountIn = 50_000n * E18;

    // Forward: resolves the pair's pool; i/j oriented off the SORTED token0/token1.
    const fwd = await discoverPancakeStablePoolsTyped(token0, token1, client as never, [cfg], amountIn);
    assert.equal(fwd.length, 1, "discovery surfaces the pair's single pool");
    assert.equal(fwd[0].address.toLowerCase(), pool.toLowerCase(), "the discovered pool IS the fixture pool");
    assert.equal(fwd[0].factory.toLowerCase(), factory.toLowerCase(), "the descriptor carries the resolving factory");
    assert.equal(fwd[0].i, 0, "tokenIn == sorted token0 ⇒ i = 0");
    assert.equal(fwd[0].j, 1, "tokenOut == sorted token1 ⇒ j = 1");
    assert.equal(fwd[0].feePpm, 100, "feePpm read from fee() (1e6 of 1e10 ⇒ 100 ppm)");

    // Reverse direction: getPairInfo is ORDER-INDEPENDENT; the indices flip with the direction.
    const rev = await discoverPancakeStablePoolsTyped(token1, token0, client as never, [cfg], amountIn);
    assert.equal(rev.length, 1, "reverse-direction discovery also resolves (order-independent getPairInfo)");
    assert.equal(rev[0].address.toLowerCase(), pool.toLowerCase(), "same pool both directions");
    assert.equal(rev[0].i, 1, "reverse direction: tokenIn == token1 ⇒ i = 1");
    assert.equal(rev[0].j, 0, "reverse direction: j = 0");

    // An unknown pair yields nothing (the ZERO struct — no revert).
    const none = await discoverPancakeStablePoolsTyped(token0, factory, client as never, [cfg], amountIn);
    assert.equal(none.length, 0, "an unknown pair discovers nothing (zero getPairInfo struct)");

    // A DRAINED pool is dropped by the liveness probe (get_dy REVERTS on the empty pool).
    const drained = await deployPancakeStableSwap(
      c.walletClient, c.publicClient, [token0, token1], [BAL, 0n], [E18, E18], A_PARAM, FEE, ADMIN_FEE,
      c.walletClient.account as Account,
    );
    const cfgDrained: FactoryConfig = {
      address: drained.factory, poolType: SwapPoolType.Curve, factoryType: FactoryType.PancakeStableSwap, label: "Drained PancakeStableSwap",
    };
    const dr = await discoverPancakeStablePoolsTyped(token0, token1, client as never, [cfgDrained], amountIn);
    assert.equal(dr.length, 0, "a drained pool (revert-class get_dy) is dropped by the liveness probe");

    // Enumeration diagnostics mirror the real factory (pairLength/swapPairContract).
    const len = (await client.readContract({
      address: factory, abi: pancakeStableFactoryFixtureAbi as Abi, functionName: "pairLength",
    })) as bigint;
    assert.equal(len, 1n, "pairLength enumerates the registered pool");

    console.log(`  [QL PancakeStable discovery] pool=${fwd[0].address} via order-independent getPairInfo; direction stamping + drained-drop pinned`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL PancakeStable solo [${engine}] — live get_dy ladder, received == get_dy wei-exact, residue 0`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL PancakeStable + V3 [${engine}] — QL stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runPksV3(engine);
    });
    it(`QL Curve + QL PancakeStable [${engine}] — segKind 1 + 20 in one loop, interleave + split == oracle`, { skip }, async () => {
      await runCurvePks(engine);
    });
    it(`QL PancakeStable zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL PancakeStable + V3 adverse-drift [${engine}] — split RE-ANCHORS to the live drifted curve`, { skip }, async () => {
      await runAdverseDriftSplit(engine);
    });
    it(`QL PancakeStable mixed-decimal [${engine}] — exchange dy == view − 1 wei, min_dy − 1 survives`, { skip }, async () => {
      await runMixedDecimalRounding(engine);
    });
    it(`QL PancakeStable drained pool [${engine}] — revert-class get_dy, venue self-drops, no DoS`, { skip }, async () => {
      await runDrained(engine);
    });
  }
  it("QL PancakeStable discovery — order-independent getPairInfo, direction stamping, drained-drop", async () => {
    await runDiscovery();
  });
});
