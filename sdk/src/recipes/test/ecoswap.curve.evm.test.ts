/**
 * EcoSwap Curve StableSwap QUOTE-LADDER (QL) local-EVM integration — the LIVE-WALK pilot.
 *
 * Curve is the FIRST venue migrated to the QUOTE-LADDER framework: prepare ships ONLY a descriptor
 * (poolAddr, coin indices i/j, fee) — NO off-chain sampled segments — and the on-chain solver BUILDS
 * each Curve venue's price ladder in setup from LIVE cook-time `get_dy` (probe-then-decode), emits the
 * slices into the merged sampled-segment stream, bounded-insertion-SORTs it DESC, and the SAME
 * bestKind===1 cursor consumes it. Execution is unchanged (engine swap(SwapParams{poolType:3}) →
 * _swapCurve, one atomic exchange per venue). This test stands up local CurveStableSwap.sol fixtures
 * (whose get_dy/get_D/get_y mirror the off-chain curve-math.ts replay bit-for-bit) + a real V3 pool,
 * and asserts:
 *
 *   (1) SOLO QL Curve — the on-chain ladder is built from live get_dy, covers [0, amountIn], and the
 *       caller-received dy == off-chain get_dy(awarded share) to the WEI (== the pool's own on-chain
 *       get_dy view). NO tolerance.
 *   (2) TWO QL Curve venues — ONE EcoSwap builds BOTH ladders on-chain, merges + SORTs them into one
 *       DESC stream, and splits; each leg received == get_dy(share) to the wei, and the split ==
 *       the neutral oracle (buildCurveQLLadder) to the wei.
 *   (3) QL Curve + a live V3 direct pool — the QL sampled-segment stream (bestKind 1) competes against
 *       the live V3 frontier (bestKind 3) in ONE merge; the per-venue split == the neutral oracle to
 *       the WEI (Curve via buildCurveQLLadder, V3 via v3Segments), both venues funded.
 *
 * No fork / no RPC env — local fixtures etch the whole stack. Runs on v1 (+ v12 when the v12 artifacts
 * are present), driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil (a cooked exchange moves
 * the pool price, so cells must not share pool state).
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, encodeFunctionData, decodeFunctionResult, parseAbi, type Abi, type Account, type Hex } from "viem";

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
  deployCurveStableSwap,
  curveAbi,
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
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { getDy, buildCurveQLLadder, type CurvePool } from "../shared/curve-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const HUGE = parseEther("1000000000");
const E18 = 10n ** 18n;
const ENGINE_CELLS = engineCells();

// Curve-only treeshake defines (a Curve-only universe): HAS_CURVE lights the on-chain QL ladder build
// + the segKind-1 exec; the live V3 frontier + merge core are unguarded (always on) so a mixed Curve+V3
// universe still walks V3 with HAS_CURVE alone. This mirrors what index.ts protocolDefines emits.
const CURVE_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: true, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
};

// The solver's 6 compiler args (index.ts order): cfg, pools, netCache, routing, segs, qlv.
//   cfg = [tokenIn, tokenOut, amountIn, caller, priceLimit, directCount]
//   qlv = the QUOTE-LADDER venue descriptors [poolAddr, i, j, feePpm, segKind, refIdx] — NO sampled
//         values; the solver builds each ladder ON-CHAIN from live get_dy. segs = [] (no static venues).
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

// One QL Curve descriptor: [poolAddr, i, j, feePpm, segKind=1, refIdx].
function curveDescriptor(pool: Hex, refIdx: number, feePpm10: bigint): bigint[] {
  return [BigInt(pool), 0n, 1n, feePpm10, 1n, BigInt(refIdx)];
}

// A live V3 direct-pool tuple with windowTop=0 (no cache ⇒ the solver staticcalls ticks() for every
// boundary from the live spot). Fields mirror index.ts buildPoolTuple. A single wide V3 position ⇒
// constant active L over the walk region (no in-range initialized tick), so the live walk matches the
// oracle's v3Segments (empty net map) bit-for-bit.
function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, // poolType = UniV3
    BigInt(pool),
    BigInt(feePpm), // fee tier
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

describe("EcoSwap Curve StableSwap QL live-walk (local fixture) — on-chain ladder, exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
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

  function offPool(address: Hex, balances: bigint[], a: bigint, fee: bigint): CurvePool {
    return { poolType: 3, address, i: 0, j: 1, A: a, aPrecision: 100n, balances, rates: [E18, E18], feePpm10: fee, source: "local-fixture" };
  }

  // ── (1) SOLO QL Curve — the on-chain ladder is built live; received == get_dy(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const balances = [1_000_000n * E18, 1_200_000n * E18];
    const A = 1000n, FEE = 4_000_000n;
    const pool = await deployCurveStableSwap(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], balances, [E18, E18], A, FEE, caller,
    );
    const op = offPool(pool, balances, A, FEE);

    const amountIn = 150_000n * E18;
    // The off-chain QL ladder (buildCurveQLLadder) — the SAME ladder the solver builds on-chain from
    // live get_dy — must cover [0, amountIn] so the solo venue absorbs the whole trade.
    const ladder = buildCurveQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL ladder");
    assert.equal(ladder.reduce((a, s) => a + s.capacity, 0n), amountIn, "QL ladder covers the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [curveDescriptor(pool, 0, FEE)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: CURVE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    const onViewPre = (await c.publicClient.readContract({
      address: pool, abi: curveAbi, functionName: "get_dy", args: [0n, 1n, amountIn],
    })) as bigint;

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL Curve cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL Curve venue)");
    assert.equal(poolIn, amountIn, "the Curve pool received the full input share");
    // WEI-EXACT-IN-DY: the received tokenOut == off-chain get_dy(share) == the pool's own get_dy view.
    assert.equal(received, getDy(op, spent), "received == get_dy(share) to the wei (exact-in-dy)");
    assert.equal(received, onViewPre, "received == on-chain get_dy view (exact-in-dy)");

    // The whole-cook gasUsed is a proxy for the ladder cost (build = QL_S slices × probe+decode
    // staticcalls + differencing + head + sort). Logged so the ladder overhead is visible per engine.
    console.log(
      `  [QL Curve solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== get_dy to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) TWO QL Curve venues — on-chain multi-venue build + SORT + split; per-leg exact-in-dy ──
  async function runTwoVenue(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues, same 1:1 spot, different A/fee ⇒ different marginal curves ⇒ the merge splits and the
    // two on-chain-built ladders INTERLEAVE in the merged-stream sort (the multi-venue path Lanes 4+ need).
    const balA = [1_000_000n * E18, 1_000_000n * E18];
    const balB = [1_000_000n * E18, 1_000_000n * E18];
    const AA = 100n, FA = 1_000_000n;
    const AB = 50n, FB = 4_000_000n;
    const poolA = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], balA, [E18, E18], AA, FA, caller);
    const poolB = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], balB, [E18, E18], AB, FB, caller);
    const opA = offPool(poolA, balA, AA, FA);
    const opB = offPool(poolB, balB, AB, FB);

    const amountIn = 600_000n * E18;
    // Neutral oracle: BOTH venues via buildCurveQLLadder (the IDENTICAL ladder the solver builds on-chain).
    const oracle = optimalSplit({ pools: [{ curve: opA, feePpm: 0 }, { curve: opB, feePpm: 0 }], amountIn, zeroForOne: true });
    const oAwA = oracle.perPoolInput[0] ?? 0n;
    const oAwB = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oAwA > 0n && oAwB > 0n, "oracle splits across both QL Curve venues");

    const qlv = [curveDescriptor(poolA, 0, FA), curveDescriptor(poolB, 1, FB)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: CURVE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const aInBefore = await balanceOf(c.publicClient, tokenIn, poolA);
    const bInBefore = await balanceOf(c.publicClient, tokenIn, poolB);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue QL Curve cook() must succeed");

    const aIn = (await balanceOf(c.publicClient, tokenIn, poolA)) - aInBefore;
    const bIn = (await balanceOf(c.publicClient, tokenIn, poolB)) - bInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(aIn > 0n && bIn > 0n, "both QL Curve venues funded");
    // WEI-EXACT SPLIT: the on-chain per-venue awarded input == the neutral oracle to the WEI (the
    // solver built the SAME ladders + the SAME merged-stream sort as the oracle's buildCurveQLLadder).
    assert.equal(aIn, oAwA, "venue A awarded input == oracle (wei-exact split)");
    assert.equal(bIn, oAwB, "venue B awarded input == oracle (wei-exact split)");
    // PER-LEG WEI-EXACT-IN-DY: received == Σ get_dy(per-venue share). NO tolerance.
    assert.equal(received, getDy(opA, aIn) + getDy(opB, bIn), "received == Σ get_dy(share) to the wei");

    console.log(`  [QL Curve×2:${engine}] A in=${aIn} B in=${bIn} received=${received} (split == oracle, dy wei-exact)`);
  }

  // ── (3) QL Curve + a live V3 direct pool — bestKind 1 vs 3 in ONE merge; split == oracle wei-exact ──
  async function runCurveV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // SHALLOW + STEEP Curve (low A, low fee) vs a DEEP 1:1 V3 pool (fee 0.3%, ts 60, ONE wide position
    // ⇒ constant L). Both sit at spot 1:1. The lower-fee Curve draws FIRST, but its shallow low-A curve
    // BENDS below the deep V3's post-fee marginal within the trade, handing the tail to V3 — so the two
    // marginal curves CROSS inside [0, amountIn] and BOTH venues receive input.
    const balances = [150_000n * E18, 150_000n * E18];
    const A = 20n, FEE = 3_000_000n; // 0.03% (1e10-scaled), steep low-A curve
    const curve = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], balances, [E18, E18], A, FEE, caller);
    const op = offPool(curve, balances, A, FEE);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("5000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const amountIn = 300_000n * E18;
    // Neutral oracle: pool[0] = live V3 (empty net ⇒ constant-L walk), pool[1] = QL Curve.
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({
      pools: [v3Opt, { curve: op, feePpm: 0 }],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oCurve = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oCurve > 0n, `oracle splits across V3 + Curve (V3 ${oV3}, Curve ${oCurve})`);

    // Universe: ONE direct V3 pool (directCount=1) + ONE QL Curve venue (qlv).
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [curveDescriptor(curve, 0, FEE)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: CURVE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const curveInBefore = await balanceOf(c.publicClient, tokenIn, curve);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "Curve+V3 cook() must succeed");

    const curveIn = (await balanceOf(c.publicClient, tokenIn, curve)) - curveInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(curveIn > 0n && v3In > 0n, `both venues funded (Curve ${curveIn}, V3 ${v3In})`);
    // WEI-EXACT SPLIT vs the neutral oracle: the QL Curve stream (bestKind 1) and the live V3 frontier
    // (bestKind 3) competed in ONE merge and landed the IDENTICAL per-venue inputs the oracle computed.
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(curveIn, oCurve, "Curve awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL Curve+V3:${engine}] V3 in=${v3In} Curve in=${curveIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (c) ZERO-CACHE QUOTE — a read-only cook (eth_call) builds the ladder LIVE with NO prepared
  // cache/segments (only the descriptor), returns the quote. Proves the QL quote is prepare-optional. ──
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

    const balances = [1_000_000n * E18, 1_200_000n * E18];
    const A = 1000n, FEE = 4_000_000n;
    const pool = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], balances, [E18, E18], A, FEE, caller);
    const op = offPool(pool, balances, A, FEE);

    const amountIn = 120_000n * E18;
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [curveDescriptor(pool, 0, FEE)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: CURVE_DEFINES },
    );
    // Caller is funded + approved from setup, so a READ-ONLY cook (rolled back) runs the transferFrom +
    // the QL ladder build + the exchange, and returns the solver's tokenOut. NO prepared cache/segments —
    // the ladder is built from LIVE get_dy inside the eth_call (the zero-cache quote).
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(quoted, getDy(op, amountIn), "zero-cache QUOTE == get_dy(amountIn) to the wei (ladder built live in the eth_call)");
    console.log(`  [QL Curve zero-cache quote:${engine}] quoted=${quoted} (== get_dy(amountIn), no prepared cache)`);
  }

  // ── (d) THE MONEY TEST — ADVERSE DRIFT. Compile the bytecode, then move the Curve pool's price with a
  // REAL swap BEFORE cooking. Because the QL ladder is built from LIVE get_dy at cook time (no baked
  // snapshot), it RE-ANCHORS to the drifted curve: the Curve↔V3 split ADAPTS (the drifted Curve's share
  // SHRINKS, V3's grows) and the output tracks the LIVE curve — the proof that QL live-walks. ──
  async function runAdverseDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const balances = [150_000n * E18, 150_000n * E18];
    const A = 20n, FEE = 3_000_000n;
    const curve = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], balances, [E18, E18], A, FEE, caller);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("5000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);

    const amountIn = 300_000n * E18;
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [curveDescriptor(curve, 0, FEE)];
    // Bytecode built against the PRE-drift universe — the descriptor carries NO pool prices, so the SAME
    // bytecode is cooked after drift; only the LIVE get_dy the ladder reads changes.
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: CURVE_DEFINES },
    );

    // Baseline (NO drift) oracle split — the Curve share the un-drifted universe would award.
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const opPre = offPool(curve, balances, A, FEE);
    const oraclePre = optimalSplit({ pools: [v3Opt, { curve: opPre, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const curveSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(curveSharePre > 0n, "baseline oracle awards the Curve venue a share");

    // ADVERSE DRIFT: a REAL tokenIn→tokenOut exchange on the Curve pool imbalances it (more tokenIn,
    // less tokenOut) so subsequent tokenIn→tokenOut swaps price WORSE — the Curve venue is now less
    // attractive than before.
    const driftIn = 25_000n * E18;
    await approve(c.walletClient, c.publicClient, tokenIn, curve, driftIn);
    await c.walletClient.writeContract({
      address: curve, abi: curveAbi as Abi, functionName: "exchange", args: [0n, 1n, driftIn, 0n],
      account: caller, chain: null,
    });
    // The DRIFTED oracle — rebuilt from the pool's post-drift balances (the state the on-chain ladder
    // will read live). The drifted Curve share must SHRINK (adverse drift) and V3's must GROW.
    const b0 = (await c.publicClient.readContract({ address: curve, abi: curveAbi as Abi, functionName: "balances", args: [0n] })) as bigint;
    const b1 = (await c.publicClient.readContract({ address: curve, abi: curveAbi as Abi, functionName: "balances", args: [1n] })) as bigint;
    const opDrift = offPool(curve, [b0, b1], A, FEE);
    const oracleDrift = optimalSplit({ pools: [v3Opt, { curve: opDrift, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const curveShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(curveShareDrift < curveSharePre, `adverse drift shrinks the Curve share (${curveShareDrift} < ${curveSharePre})`);

    // Cook the PRE-drift bytecode against the DRIFTED pool. The QL ladder re-anchors to the live curve.
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const curveInBefore = await balanceOf(c.publicClient, tokenIn, curve);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "adverse-drift Curve+V3 cook() must succeed");

    const curveIn = (await balanceOf(c.publicClient, tokenIn, curve)) - curveInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(curveIn > 0n && v3In > 0n, "both venues funded post-drift");
    // RE-ANCHORED: the on-chain split matches the DRIFTED oracle (built from live post-drift state), NOT
    // the pre-drift baseline — the QL ladder walked the LIVE (drifted) curve.
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(curveIn, curveShareDrift, "Curve awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    // The split ADAPTED: the drifted Curve share is strictly below the pre-drift baseline.
    assert.ok(curveIn < curveSharePre, `Curve share ADAPTED down after adverse drift (${curveIn} < baseline ${curveSharePre})`);

    console.log(
      `  [QL Curve+V3 adverse-drift:${engine}] baseline Curve share=${curveSharePre} → drifted=${curveIn} ` +
        `(V3 grew to ${v3In}); received=${received} (split RE-ANCHORED to live drifted curve)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL Curve solo [${engine}] — on-chain ladder, received == get_dy(share) wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL Curve ×2 [${engine}] — multi-venue on-chain build + sort + split, wei-exact`, { skip }, async () => {
      await runTwoVenue(engine);
    });
    it(`QL Curve + V3 [${engine}] — sampled stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runCurveV3(engine);
    });
    it(`QL Curve zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL Curve + V3 adverse-drift [${engine}] — split RE-ANCHORS to the live drifted curve`, { skip }, async () => {
      await runAdverseDriftSplit(engine);
    });
  }
});
