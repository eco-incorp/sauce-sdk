/**
 * EcoSwap Solidly STABLE (sAMM) QUOTE-LADDER (QL) local-EVM integration — the callback-free live-walk gate.
 *
 * Solidly STABLE is migrated to the QUOTE-LADDER framework (the same one the Curve StableSwap / CryptoSwap
 * pilots use): prepare ships ONLY a descriptor [poolAddr, _, _, feePpm, segKind=4, refIdx] — NO off-chain
 * sampled segments — and the on-chain solver BUILDS each stable venue's price ladder in setup from LIVE
 * cook-time `getAmountOut(xIn, tokenIn)` (PROBE-THEN-DECODE — getAmountOut can revert on _get_y non-
 * convergence at a large input — the SAME generalized qlv loop the Curve pilot uses, dispatched on the
 * descriptor segKind), emits the slices into the merged sampled-segment stream, bounded-insertion-SORTs it
 * DESC, and the SAME bestKind===1 cursor consumes it. Execution is UNCHANGED (callback-free: on-chain
 * getAmountOut for the exact out + transfer + pool.swap(a0Out, a1Out, to, "") — a stable pool is x3y+y3x,
 * NOT xy=k, so it must NOT go through the engine _swapV2). This test stands up local SolidlyStablePool.sol
 * fixtures (whose x3y+y3x invariant / bounded-Newton getAmountOut mirror the off-chain solidly-stable-math.ts
 * replay bit-for-bit) + a real V3 pool + a Curve StableSwap fixture, and asserts:
 *
 *   (1) SOLO QL stable — the on-chain ladder is built from live getAmountOut, covers [0, amountIn], and the
 *       caller-received dy == off-chain getAmountOutStable(awarded share) == the pool's own on-chain
 *       getAmountOut view, all to the WEI. NO tolerance.
 *   (2) QL stable + a live V3 direct pool — the QL sampled-segment stream (bestKind 1) competes against the
 *       live V3 frontier (bestKind 3) in ONE merge; the per-venue split == the neutral oracle to the WEI
 *       (Solidly via buildSolidlyStableQLLadder, V3 via v3Segments), both venues funded.
 *   (3) QL Solidly + QL Curve — TWO QL venues of DIFFERENT segKind (4 + 1) ride ONE qlv; the generalized
 *       ladder loop builds BOTH on-chain (dispatching the quote per-row on segKind) and INTERLEAVES them in
 *       the merged-stream sort; each leg received == its own view(share) to the wei, split == oracle.
 *   (4) ZERO-CACHE QUOTE — a read-only cook (eth_call) builds the ladder LIVE with NO prepared segments
 *       (only the descriptor) and returns the quote == getAmountOut(amountIn). Proves the QL quote is
 *       prepare-optional.
 *   (5) ADVERSE DRIFT — move the stable pool's price with a REAL swap BEFORE cooking; the QL ladder
 *       re-anchors to the drifted curve at cook time (the Solidly↔V3 split ADAPTS — the drifted stable share
 *       SHRINKS, V3's grows) and lands the DRIFTED oracle's split to the wei.
 *
 * No fork / no RPC env — local fixtures etch the whole stack. Runs on v1 (+ v12 when the v12 artifacts are
 * present), driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil (a cooked swap moves the pool
 * price, so cells must not share pool state). Mirrors ecoswap.crypto.evm.test.ts.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseEther,
  encodeFunctionData,
  decodeFunctionResult,
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
  deploySortedTokens,
  createAndInitPool,
  mintPosition,
  getSlot0,
  getLiquidity,
  mint,
  approve,
  balanceOf,
  erc20Abi,
  deploySolidlyStablePool,
  solidlyStableAbi,
  deployCurveStableSwap,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { getDy, type CurvePool } from "../shared/curve-math";
import {
  getAmountOutStable,
  buildSolidlyStableQLLadder,
  type SolidlyStablePool,
} from "../shared/solidly-stable-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const HUGE = parseEther("1000000000");
const E18 = 10n ** 18n;
const ENGINE_CELLS = engineCells();

// Solidly-stable-only treeshake defines (HAS_SOLIDLY_STABLE lights the on-chain QL ladder build's Solidly
// quote branch + the segKind-4 accumulator + the callback-free getAmountOut+transfer+swap exec; the live
// V3 frontier + merge core are unguarded (always on) so a mixed Solidly+V3 universe still walks V3 with
// HAS_SOLIDLY_STABLE alone). Mirrors index.ts protocolDefines.
const SOLIDLY_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: true, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
};

// Solidly + Curve treeshake defines — BOTH QL adapter branches ship so the generalized qlv loop builds
// both a segKind-4 (Solidly) and a segKind-1 (Curve StableSwap) ladder in one pass. This is the real
// production define set index.ts would emit for a Solidly+Curve universe.
const SOLIDLY_CURVE_DEFINES: Record<string, boolean> = {
  ...SOLIDLY_DEFINES,
  HAS_CURVE: true,
  HAS_SOLIDLY_STABLE: true,
};

// The solver's 6 compiler args (index.ts order): cfg, pools, netCache, routing, segs, qlv.
//   cfg = [tokenIn, tokenOut, amountIn, caller, priceLimit, directCount]
//   qlv = the QUOTE-LADDER venue descriptors [poolAddr, i, j, feePpm, segKind, refIdx] — NO sampled
//         values; the solver builds each ladder ON-CHAIN from live views. segs = [] (no static venues).
function args(
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  directCount: number,
  pools: bigint[][],
  qlv: bigint[][],
): unknown[] {
  return [
    [BigInt(tokenIn), BigInt(tokenOut), amountIn, BigInt(caller), MIN_SQRT_RATIO + 1n, BigInt(directCount)],
    pools,
    [], // netCache — V3 pool tuples use windowTop=0 (live ticks() staticcall), no cache
    [], // routing
    [], // segs — no static (non-QL) sampled venues in this universe
    qlv,
  ];
}

// One QL Solidly STABLE descriptor: [poolAddr, i, j, feePpm, segKind=4, refIdx]. i/j are UNUSED (Solidly
// quotes by tokenIn, not a coin index); feePpm is informational (getAmountOut is post-fee — the on-chain
// head needs no fee-adjust — so the descriptor's fee field is never read by the qlv loop).
function solidlyDescriptor(pool: Hex, refIdx: number, feePpm: number): bigint[] {
  return [BigInt(pool), 0n, 0n, BigInt(feePpm), 4n, BigInt(refIdx)];
}

// One QL Curve StableSwap descriptor: [poolAddr, i, j, feePpm10, segKind=1, refIdx].
function curveDescriptor(pool: Hex, refIdx: number, feePpm10: bigint): bigint[] {
  return [BigInt(pool), 0n, 1n, feePpm10, 1n, BigInt(refIdx)];
}

// A live V3 direct-pool tuple with windowTop=0 (no cache ⇒ the solver staticcalls ticks() for every
// boundary from the live spot). A single wide V3 position ⇒ constant active L over the walk region, so
// the live walk matches the oracle's v3Segments (empty net map) bit-for-bit. Mirrors index.ts buildPoolTuple.
function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, // poolType = UniV3
    BigInt(pool),
    BigInt(feePpm),
    BigInt(tickSpacing),
    0n, // hooks
    BigInt(feePpm),
    0n, // isV2
    inIsToken0 ? 1n : 0n,
    0n, // stateView (V4 only)
    0n, // poolId (V4 only)
    getSqrtRatioAtTick(tickSpacing), // stepRatio
    0n, // windowTopShifted = 0 ⇒ staticcall every boundary (live walk, no cache)
    0n, // windowBotShifted
    0n, // extremeShifted
    0n, // netStart
    0n, // netCount
    0n, // isKyber
  ];
}

describe("EcoSwap Solidly STABLE QL live-walk (local fixture) — on-chain ladder, exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == token0 (lower address)
  let tokenOut: Hex; // == token1
  let solverSrc: string;

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
    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, parseEther("500000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, parseEther("500000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  // Off-chain SolidlyStablePool descriptor for the deployed fixture (tokenIn = token0 ⇒ inIsToken0). The
  // reserves are the LIVE getReserves — the fixture's getAmountOut prices off stored reserves, so seeding
  // from them matches the fixture bit-for-bit for both the fresh and the drifted state.
  function offPool(address: Hex, reserveIn: bigint, reserveOut: bigint, feePpm: number): SolidlyStablePool {
    return {
      address, reserveIn, reserveOut, decIn: E18, decOut: E18,
      token0: tokenIn, inIsToken0: true, feePpm, source: "local-fixture",
    };
  }

  function offCurvePool(address: Hex, balances: bigint[], a: bigint, fee: bigint): CurvePool {
    return { poolType: 3, address, i: 0, j: 1, A: a, aPrecision: 100n, balances, rates: [E18, E18], feePpm10: fee, source: "local-fixture" };
  }

  // Read the fixture's live reserves (reserve0, reserve1).
  async function reserves(pool: Hex): Promise<[bigint, bigint]> {
    const r = (await c.publicClient.readContract({
      address: pool, abi: solidlyStableAbi as Abi, functionName: "getReserves",
    })) as readonly [bigint, bigint, bigint];
    return [r[0], r[1]];
  }

  // ── (1) SOLO QL Solidly — the on-chain ladder is built live; received == getAmountOutStable(share) WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const r0 = 1_000_000n * E18, r1 = 1_200_000n * E18, FEE = 100; // imbalanced, 0.01% sAMM tier
    const pool = await deploySolidlyStablePool(c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18, BigInt(FEE), r0, r1, caller);
    const op = offPool(pool, r0, r1, FEE);

    const amountIn = 100_000n * E18;
    // The off-chain QL ladder (buildSolidlyStableQLLadder) — the SAME ladder the solver builds on-chain
    // from live getAmountOut — must cover [0, amountIn] so the solo venue absorbs the whole trade.
    const ladder = buildSolidlyStableQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL ladder");
    assert.equal(ladder.reduce((a, s) => a + s.capacity, 0n), amountIn, "QL ladder covers the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [solidlyDescriptor(pool, 0, FEE)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: SOLIDLY_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    // The fixture's own on-chain getAmountOut view on the PRE-swap state — the engine-independent ground
    // truth for the executed dy of `amountIn`.
    const onViewPre = (await c.publicClient.readContract({
      address: pool, abi: solidlyStableAbi as Abi, functionName: "getAmountOut", args: [amountIn, tokenIn],
    })) as bigint;

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL Solidly cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL Solidly venue)");
    assert.equal(poolIn, amountIn, "the Solidly pool received the full input share (transfer-first)");
    assert.equal(received, getAmountOutStable(op, spent), "received == getAmountOutStable(share) to the wei (exact-in-dy)");
    assert.equal(received, onViewPre, "received == on-chain getAmountOut view (exact-in-dy)");
    assert.ok(received > 0n, "non-zero Solidly fill through the callback-free transfer+swap path");

    console.log(
      `  [QL Solidly solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== getAmountOutStable == getAmountOut to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) QL Solidly + a live V3 direct pool — bestKind 1 vs 3 in ONE merge; split == oracle wei-exact ──
  async function runSolidlyV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A SHALLOW-ish stable (500k/side, low 0.01% fee ⇒ draws FIRST) vs a DEEP 1:1 V3 pool (fee 0.3%,
    // ts 60, ONE wide position ⇒ constant L). The stable curve BENDS below the deep V3's post-fee
    // marginal within the trade, so the two marginal curves CROSS inside [0, amountIn] and BOTH venues fill.
    const sR = 500_000n * E18, FEE = 100;
    const pool = await deploySolidlyStablePool(c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18, BigInt(FEE), sR, sR, caller);
    const op = offPool(pool, sR, sR, FEE);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const amountIn = 300_000n * E18;
    // Neutral oracle: pool[0] = live V3 (empty net ⇒ constant-L walk), pool[1] = QL Solidly.
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({
      pools: [v3Opt, { solidlyStable: op, feePpm: 0 }],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oSolidly = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oSolidly > 0n, `oracle splits across V3 + Solidly (V3 ${oV3}, Solidly ${oSolidly})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [solidlyDescriptor(pool, 0, FEE)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: SOLIDLY_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const solidlyInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "Solidly+V3 cook() must succeed");

    const solidlyIn = (await balanceOf(c.publicClient, tokenIn, pool)) - solidlyInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(solidlyIn > 0n && v3In > 0n, `both venues funded (Solidly ${solidlyIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(solidlyIn, oSolidly, "Solidly awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL Solidly+V3:${engine}] V3 in=${v3In} Solidly in=${solidlyIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) QL Solidly + QL Curve — TWO QL venues of DIFFERENT segKind (4 + 1) in ONE qlv; the generalized
  // loop builds both + INTERLEAVES them in the sort; per-leg exact-in-dy; split == oracle. ──
  async function runSolidlyCurve(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A SHALLOW steep Curve (low A, 0.03% fee ⇒ draws FIRST but bends fast) vs a DEEP Solidly (1M/side,
    // 0.01% fee ⇒ flatter). The two marginal curves CROSS inside the trade, so BOTH QL venues (segKind
    // 1 + 4) receive input and their on-chain-built ladders INTERLEAVE in the merged-stream DESC sort.
    const curveBal = [150_000n * E18, 150_000n * E18];
    const CURVE_A = 20n, CURVE_FEE = 3_000_000n; // 0.03% (1e10-scaled), steep low-A curve
    const curve = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], curveBal, [E18, E18], CURVE_A, CURVE_FEE, caller);
    const opCurve = offCurvePool(curve, curveBal, CURVE_A, CURVE_FEE);

    const sR = 1_000_000n * E18, FEE = 100;
    const solidly = await deploySolidlyStablePool(c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18, BigInt(FEE), sR, sR, caller);
    const opSolidly = offPool(solidly, sR, sR, FEE);

    const amountIn = 300_000n * E18;
    // Neutral oracle: pool[0] = QL Curve (buildCurveQLLadder), pool[1] = QL Solidly (buildSolidlyStableQLLadder).
    const oracle = optimalSplit({ pools: [{ curve: opCurve, feePpm: 0 }, { solidlyStable: opSolidly, feePpm: 0 }], amountIn, zeroForOne: true });
    const oCurve = oracle.perPoolInput[0] ?? 0n;
    const oSolidly = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oCurve > 0n && oSolidly > 0n, `oracle splits across QL Curve + QL Solidly (Curve ${oCurve}, Solidly ${oSolidly})`);

    // ONE qlv carrying BOTH families: a segKind-1 Curve descriptor + a segKind-4 Solidly descriptor.
    const qlv = [curveDescriptor(curve, 0, CURVE_FEE), solidlyDescriptor(solidly, 0, FEE)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: SOLIDLY_CURVE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const curveInBefore = await balanceOf(c.publicClient, tokenIn, curve);
    const solidlyInBefore = await balanceOf(c.publicClient, tokenIn, solidly);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "QL Solidly + QL Curve cook() must succeed");

    const curveIn = (await balanceOf(c.publicClient, tokenIn, curve)) - curveInBefore;
    const solidlyIn = (await balanceOf(c.publicClient, tokenIn, solidly)) - solidlyInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(curveIn > 0n && solidlyIn > 0n, `both QL venues funded (Curve ${curveIn}, Solidly ${solidlyIn})`);
    assert.equal(curveIn, oCurve, "Curve awarded input == oracle (wei-exact split)");
    assert.equal(solidlyIn, oSolidly, "Solidly awarded input == oracle (wei-exact split)");
    // PER-LEG WEI-EXACT-IN-DY: received == get_dy_Curve(curveIn) + getAmountOutStable(solidlyIn). NO tolerance.
    assert.equal(received, getDy(opCurve, curveIn) + getAmountOutStable(opSolidly, solidlyIn), "received == Σ per-venue view(share) to the wei");

    console.log(
      `  [QL Curve+Solidly:${engine}] Curve in=${curveIn} Solidly in=${solidlyIn} received=${received} ` +
        `(two QL segKinds interleaved; split == oracle, dy wei-exact)`,
    );
  }

  // ── (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared cache/segments. ──
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

    const r0 = 1_000_000n * E18, r1 = 1_000_000n * E18, FEE = 100;
    const pool = await deploySolidlyStablePool(c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18, BigInt(FEE), r0, r1, caller);
    const op = offPool(pool, r0, r1, FEE);

    const amountIn = 100_000n * E18;
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [solidlyDescriptor(pool, 0, FEE)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: SOLIDLY_DEFINES },
    );
    // Caller is funded + approved from setup, so a READ-ONLY cook (rolled back) runs the transferFrom +
    // the QL ladder build + the swap, and returns the solver's tokenOut. NO prepared cache/segments — the
    // ladder is built from LIVE getAmountOut inside the eth_call (the zero-cache quote).
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(quoted, getAmountOutStable(op, amountIn), "zero-cache QUOTE == getAmountOutStable(amountIn) to the wei (ladder built live in the eth_call)");
    console.log(`  [QL Solidly zero-cache quote:${engine}] quoted=${quoted} (== getAmountOutStable(amountIn), no prepared cache)`);
  }

  // ── (5) ADVERSE DRIFT — move the Solidly pool's price with a REAL swap BEFORE cooking. Because the QL
  // ladder is built from LIVE getAmountOut at cook time (no baked snapshot), it RE-ANCHORS to the drifted
  // curve: the Solidly↔V3 split ADAPTS (the drifted stable share SHRINKS, V3's grows). ──
  async function runAdverseDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const sR = 500_000n * E18, FEE = 100;
    const solidly = await deploySolidlyStablePool(c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18, BigInt(FEE), sR, sR, caller);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);

    const amountIn = 300_000n * E18;
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [solidlyDescriptor(solidly, 0, FEE)];
    // Bytecode built against the PRE-drift universe — the descriptor carries NO pool prices, so the SAME
    // bytecode is cooked after drift; only the LIVE getAmountOut the ladder reads changes.
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: SOLIDLY_DEFINES },
    );

    // Baseline (NO drift) oracle split — the stable share the un-drifted universe would award.
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const opPre = offPool(solidly, sR, sR, FEE);
    const oraclePre = optimalSplit({ pools: [v3Opt, { solidlyStable: opPre, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const solidlySharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(solidlySharePre > 0n, "baseline oracle awards the Solidly venue a share");

    // ADVERSE DRIFT: a REAL token0→token1 swap on the stable pool imbalances it (more token0, less
    // token1) so subsequent token0→token1 swaps price WORSE. The fixture swap is TRANSFER-FIRST: transfer
    // the drift input, read the exact out on the stored reserves, then swap(0, out, ...) (the K-invariant
    // holds because out == getAmountOut on those reserves).
    const driftIn = 100_000n * E18;
    const driftOut = (await c.publicClient.readContract({
      address: solidly, abi: solidlyStableAbi as Abi, functionName: "getAmountOut", args: [driftIn, tokenIn],
    })) as bigint;
    await c.walletClient.writeContract({
      address: tokenIn, abi: erc20Abi as Abi, functionName: "transfer", args: [solidly, driftIn], account: caller, chain: null,
    });
    await c.walletClient.writeContract({
      address: solidly, abi: solidlyStableAbi as Abi, functionName: "swap", args: [0n, driftOut, caller, "0x"], account: caller, chain: null,
    });

    // The DRIFTED oracle — rebuilt from the pool's live post-drift reserves.
    const [dr0, dr1] = await reserves(solidly);
    const opDrift = offPool(solidly, dr0, dr1, FEE);
    const oracleDrift = optimalSplit({ pools: [v3Opt, { solidlyStable: opDrift, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const solidlyShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(solidlyShareDrift > 0n, "drifted oracle still awards the Solidly venue a (smaller) share");
    assert.ok(solidlyShareDrift < solidlySharePre, `adverse drift shrinks the Solidly share (${solidlyShareDrift} < ${solidlySharePre})`);

    // Cook the PRE-drift bytecode against the DRIFTED pool. The QL ladder re-anchors to the live curve.
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const solidlyInBefore = await balanceOf(c.publicClient, tokenIn, solidly);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "adverse-drift Solidly+V3 cook() must succeed");

    const solidlyIn = (await balanceOf(c.publicClient, tokenIn, solidly)) - solidlyInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(solidlyIn > 0n && v3In > 0n, "both venues funded post-drift");
    // RE-ANCHORED: the on-chain split matches the DRIFTED oracle (built from live post-drift state), NOT
    // the pre-drift baseline — the QL ladder walked the LIVE (drifted) curve.
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(solidlyIn, solidlyShareDrift, "Solidly awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(solidlyIn < solidlySharePre, `Solidly share ADAPTED down after adverse drift (${solidlyIn} < baseline ${solidlySharePre})`);

    console.log(
      `  [QL Solidly+V3 adverse-drift:${engine}] baseline Solidly share=${solidlySharePre} → drifted=${solidlyIn} ` +
        `(V3 grew to ${v3In}); received=${received} (split RE-ANCHORED to live drifted curve)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL Solidly solo [${engine}] — on-chain ladder, received == getAmountOutStable(share) wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL Solidly + V3 [${engine}] — sampled stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runSolidlyV3(engine);
    });
    it(`QL Solidly + QL Curve [${engine}] — two QL segKinds in one loop, interleave + split == oracle`, { skip }, async () => {
      await runSolidlyCurve(engine);
    });
    it(`QL Solidly zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL Solidly + V3 adverse-drift [${engine}] — split RE-ANCHORS to the live drifted curve`, { skip }, async () => {
      await runAdverseDriftSplit(engine);
    });
  }
});
