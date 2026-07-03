/**
 * EcoSwap Trader Joe LB (Liquidity Book) QUOTE-LADDER (QL) local-EVM integration — the live-walk
 * getSwapOut ladder + the amountInLeft live-capacity cap (the OutOfLiquidity-DoS fix).
 *
 * LB is migrated to the QUOTE-LADDER framework (the same one Curve / WOOFi / Mento use): prepare ships ONLY
 * a descriptor [pair, swapForY, _, feePpm, segKind=2, refIdx] — NO off-chain sampled per-bin segments — and
 * the on-chain solver BUILDS each LB venue's price ladder in setup from LIVE cook-time
 * `getSwapOut(xIn, swapForY) → (amountInLeft, amountOut, fee)` (the GRACEFUL LB view — returns the
 * UNFILLABLE remainder instead of reverting). LB is the one QL family whose slice capacity is NOT xIn-cum:
 * the pool absorbs only `effAbsorbed = xIn − amountInLeft`, so the slice capacity is `effAbsorbed − cum` and
 * `cum` advances to `effAbsorbed` — bounding the awarded LB input to the LIVE fillable bin capacity, so the
 * transfer-first engine exec (unchanged: swap(SwapParams{poolType:6}) → _swapTraderJoeLB) never over-asks.
 * That is the DoS fix: a shallow / shrunk pool can no longer be awarded more than it can absorb.
 *
 *   (1) SOLO QL LB — the on-chain ladder is built from live getSwapOut, covers [0, amountIn] (pool deep
 *       enough), and the caller-received dy == off-chain getSwapOut(awarded share) == the pool's own
 *       getSwapOut view, all to the WEI (a bin is a flat constant-sum slice ⇒ no curvature). NO tolerance.
 *   (2) QL LB + a live V3 direct pool — the QL sampled-segment stream (bestKind 1) competes against the
 *       live V3 frontier (bestKind 3) in ONE merge; the per-venue split == the neutral oracle to the WEI.
 *   (3) QL LB + QL Curve — TWO QL venues of DIFFERENT segKind (2 + 1) ride ONE qlv; the generalized ladder
 *       loop builds BOTH on-chain (dispatching per-row on segKind) and INTERLEAVES them; per-leg exact-in-dy.
 *   (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared segments and returns the
 *       quote == getSwapOut(absorbed) to the wei. Proves the QL quote is prepare-optional.
 *   (5) BIN-SHRINK / adverse drift — SHRINK the pool's bins on-chain BEFORE cooking; the QL ladder reads the
 *       LIVE (shrunk) getSwapOut at cook time and CAPS the award at the live fillable capacity — the cook
 *       SUCCEEDS (no LBPair__OutOfLiquidity revert) and the LB↔V3 split RE-ANCHORS (the LB share shrinks,
 *       V3's grows). This is the audit's OutOfLiquidity-DoS fix, proven end-to-end.
 *
 * No fork / no RPC env — local fixtures etch the whole stack. Runs on v1 (+ v12 when the v12 artifacts are
 * present), driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil. Mirrors ecoswap.woofi.evm.test.ts.
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
  deployLBPair,
  lbPairAbi,
  deployCurveStableSwap,
  SQRT_PRICE_1_1,
  type LbBinSeed,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO, SwapPoolType } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { getSwapOut as lbGetSwapOut, getSwapOutWithLeft, buildLbQLLadder, type LbPool } from "../shared/lb-math";
import { getDy, type CurvePool } from "../shared/curve-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const ANCHOR = 1 << 23; // LB id of price 1.0
const ENGINE_CELLS = engineCells();

// LB-only treeshake defines (HAS_LB lights the on-chain QL ladder build's LB quote branch + the segKind-2
// accumulator + the engine poolType-6 exec; the live V3 frontier + merge core are unguarded (always on) so
// a mixed LB+V3 universe still walks V3 with HAS_LB alone). Mirrors index.ts protocolDefines.
const LB_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: true, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
};

// LB + Curve treeshake defines — BOTH QL adapter branches ship so the generalized qlv loop builds a
// segKind-2 (LB) and a segKind-1 (Curve StableSwap) ladder in one pass.
const LB_CURVE_DEFINES: Record<string, boolean> = { ...LB_DEFINES, HAS_CURVE: true, HAS_LB: true };

// The solver's 6 compiler args (index.ts order): cfg, pools, netCache, routing, segs, qlv.
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
    [], // netCache
    [], // routing
    [], // segs — no static (non-QL) sampled venues in this universe
    qlv,
  ];
}

// One QL LB descriptor: [pair, swapForY(0/1), _, feePpm, segKind=2, refIdx]. swapForY is qd[1] (the on-chain
// getSwapOut direction bit); feePpm is informational (getSwapOut is post-fee — the head needs no fee-adjust).
function lbDescriptor(pair: Hex, refIdx: number, swapForY: boolean, feePpm: number): bigint[] {
  return [BigInt(pair), swapForY ? 1n : 0n, 0n, BigInt(feePpm), 2n, BigInt(refIdx)];
}

// One QL Curve StableSwap descriptor: [poolAddr, i, j, feePpm10, segKind=1, refIdx].
function curveDescriptor(pool: Hex, refIdx: number, feePpm10: bigint): bigint[] {
  return [BigInt(pool), 0n, 1n, feePpm10, 1n, BigInt(refIdx)];
}

// A live V3 direct-pool tuple with windowTop=0 (no cache ⇒ the solver staticcalls ticks() for every
// boundary from the live spot). A single wide V3 position ⇒ constant active L over the walk region.
function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, BigInt(pool), BigInt(feePpm), BigInt(tickSpacing), 0n, BigInt(feePpm), 0n,
    inIsToken0 ? 1n : 0n, 0n, 0n, getSqrtRatioAtTick(tickSpacing), 0n, 0n, 0n, 0n, 0n, 0n,
  ];
}

describe("EcoSwap Trader Joe LB QL live-walk (local fixture) — on-chain getSwapOut ladder + live-capacity cap", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the LB pair's tokenX (swapForY: X → Y)
  let tokenOut: Hex; // == the LB pair's tokenY
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
    tokenIn = tk.token0;
    tokenOut = tk.token1;
    solverSrc = readFileSync(SOLVER, "utf-8");
    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, parseEther("500000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, parseEther("500000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, parseEther("1000000000"));
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, parseEther("1000000000"));
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  // Build the off-chain LbPool descriptor for a set of seeded bins (tokenIn == tokenX ⇒ swapForY).
  function makeLb(opts: {
    address: Hex;
    binStep: number;
    baseFactor?: number;
    activeId?: number;
    count?: number;
    reserve?: bigint;
  }): { off: LbPool; bins: LbBinSeed[]; activeId: number; baseFactor: number } {
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
    return { off, bins, activeId, baseFactor };
  }

  // The fixture's own on-chain getSwapOut view — the engine-independent ground truth. Returns amountOut ([1]).
  async function onSwapOut(pair: Hex, amt: bigint): Promise<{ amountInLeft: bigint; amountOut: bigint }> {
    const r = (await c.publicClient.readContract({
      address: pair, abi: lbPairAbi as Abi, functionName: "getSwapOut", args: [amt, true],
    })) as readonly [bigint, bigint, bigint];
    return { amountInLeft: r[0], amountOut: r[1] };
  }

  function offCurvePool(address: Hex, balances: bigint[], a: bigint, fee: bigint): CurvePool {
    return { poolType: 3, address, i: 0, j: 1, A: a, aPrecision: 100n, balances, rates: [E18, E18], feePpm10: fee, source: "local-fixture" };
  }

  // ── (1) SOLO QL LB — the on-chain ladder is built live; received == getSwapOut(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // 0.20% bin step, deep book (count 40, reserve 1e18/bin ⇒ ~40e18 out reserve each side): amountIn well
    // within capacity ⇒ the QL ladder covers the whole trade.
    const m = makeLb({ address: ("0x" + "00".repeat(20)) as Hex, binStep: 20, count: 40, reserve: E18 });
    const pair = await deployLBPair(
      c.walletClient, c.publicClient, tokenIn, tokenOut, m.off.binStep, m.baseFactor, m.activeId, m.bins, caller,
    );
    const op: LbPool = { ...m.off, address: pair };

    const amountIn = 8n * E18;
    const ladder = buildLbQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL LB ladder");
    // The pool absorbs the whole trade ⇒ Σ slice capacity (effAbsorbed at the cut) == amountIn.
    const cover = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(cover, amountIn, "QL LB ladder covers the full amountIn (pool deep enough)");

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [lbDescriptor(pair, 0, true, op.baseFactor)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: LB_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pair);
    const onViewPre = await onSwapOut(pair, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL LB cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pair)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL LB venue)");
    assert.equal(poolIn, amountIn, "the LB pair received the full input share (transfer-first)");
    assert.equal(received, lbGetSwapOut(op, spent), "received == getSwapOut(share) to the wei (exact-out)");
    assert.equal(received, onViewPre.amountOut, "received == on-chain getSwapOut view to the wei");
    assert.ok(received > 0n, "non-zero LB fill through the engine _swapTraderJoeLB path");

    console.log(
      `  [QL LB solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== getSwapOut == on-chain view to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) QL LB + a live V3 direct pool — bestKind 1 vs 3 in ONE merge; split == oracle wei-exact ──
  async function runLbV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A CHEAP LB (0.05% bin step ⇒ base fee 0.025%, best-priced at spot so it draws first) but SHALLOW
    // (1e18/bin) vs a DEEP 1:1 V3 pool (0.30% fee): the LB near bins drain, its marginal drops below V3's,
    // and V3 takes the deep tail — both venues fund and their marginals equalize at the cut.
    const m = makeLb({ address: ("0x" + "00".repeat(20)) as Hex, binStep: 5, count: 12, reserve: E18 });
    const pair = await deployLBPair(
      c.walletClient, c.publicClient, tokenIn, tokenOut, m.off.binStep, m.baseFactor, m.activeId, m.bins, caller,
    );
    const op: LbPool = { ...m.off, address: pair };

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const amountIn = 40n * E18;
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({
      pools: [v3Opt, { lb: op, feePpm: 0 }],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oLb = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oLb > 0n, `oracle splits across V3 + LB (V3 ${oV3}, LB ${oLb})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [lbDescriptor(pair, 0, true, op.baseFactor)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: LB_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const lbInBefore = await balanceOf(c.publicClient, tokenIn, pair);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "LB+V3 cook() must succeed");

    const lbIn = (await balanceOf(c.publicClient, tokenIn, pair)) - lbInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(lbIn > 0n && v3In > 0n, `both venues funded (LB ${lbIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(lbIn, oLb, "LB awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL LB+V3:${engine}] V3 in=${v3In} LB in=${lbIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) QL LB + QL Curve — TWO QL venues of DIFFERENT segKind (2 + 1) in ONE qlv; per-leg exact-in-dy. ──
  async function runLbCurve(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A SHALLOW higher-fee Curve (2000e18/side, A=100, 0.03% fee) vs a CHEAP LB (0.02% bin step ⇒ base fee
    // 0.01%, so LB draws first) with a deep-ish book (50e18/bin): the LB near bins fill, its marginal drops
    // to the Curve's, and the (shallow) Curve takes a slice — BOTH QL venues fund and their on-chain-built
    // ladders INTERLEAVE in the merged-stream DESC sort.
    const curveBal = [2_000n * E18, 2_000n * E18];
    const CURVE_A = 100n, CURVE_FEE = 3_000_000n; // 0.03% (1e10-scaled), dearer than LB's 0.01% base fee
    const curve = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], curveBal, [E18, E18], CURVE_A, CURVE_FEE, caller);
    const opCurve = offCurvePool(curve, curveBal, CURVE_A, CURVE_FEE);

    const m = makeLb({ address: ("0x" + "00".repeat(20)) as Hex, binStep: 2, count: 48, reserve: 50n * E18 });
    const pair = await deployLBPair(
      c.walletClient, c.publicClient, tokenIn, tokenOut, m.off.binStep, m.baseFactor, m.activeId, m.bins, caller,
    );
    const opLb: LbPool = { ...m.off, address: pair };

    const amountIn = 2_500n * E18;
    const oracle = optimalSplit({ pools: [{ curve: opCurve, feePpm: 0 }, { lb: opLb, feePpm: 0 }], amountIn, zeroForOne: true });
    const oCurve = oracle.perPoolInput[0] ?? 0n;
    const oLb = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oCurve > 0n && oLb > 0n, `oracle splits across QL Curve + QL LB (Curve ${oCurve}, LB ${oLb})`);

    const qlv = [curveDescriptor(curve, 0, CURVE_FEE), lbDescriptor(pair, 0, true, opLb.baseFactor)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: LB_CURVE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const curveInBefore = await balanceOf(c.publicClient, tokenIn, curve);
    const lbInBefore = await balanceOf(c.publicClient, tokenIn, pair);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "QL LB + QL Curve cook() must succeed");

    const curveIn = (await balanceOf(c.publicClient, tokenIn, curve)) - curveInBefore;
    const lbIn = (await balanceOf(c.publicClient, tokenIn, pair)) - lbInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(curveIn > 0n && lbIn > 0n, `both QL venues funded (Curve ${curveIn}, LB ${lbIn})`);
    assert.equal(curveIn, oCurve, "Curve awarded input == oracle (wei-exact split)");
    assert.equal(lbIn, oLb, "LB awarded input == oracle (wei-exact split)");
    // PER-LEG WEI-EXACT: received == get_dy_Curve(curveIn) + getSwapOut_LB(lbIn). NO tolerance.
    assert.equal(received, getDy(opCurve, curveIn) + lbGetSwapOut(opLb, lbIn), "received == Σ per-venue view(share) to the wei");

    console.log(
      `  [QL Curve+LB:${engine}] Curve in=${curveIn} LB in=${lbIn} received=${received} ` +
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

    const m = makeLb({ address: ("0x" + "00".repeat(20)) as Hex, binStep: 20, count: 40, reserve: E18 });
    const pair = await deployLBPair(
      c.walletClient, c.publicClient, tokenIn, tokenOut, m.off.binStep, m.baseFactor, m.activeId, m.bins, caller,
    );
    const op: LbPool = { ...m.off, address: pair };

    const amountIn = 8n * E18;
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [lbDescriptor(pair, 0, true, op.baseFactor)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: LB_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    // The pool absorbs the whole trade, so the quote == getSwapOut(amountIn) to the wei (ladder built live).
    assert.equal(quoted, lbGetSwapOut(op, amountIn), "zero-cache QUOTE == getSwapOut(amountIn) to the wei (ladder built live in the eth_call)");
    console.log(`  [QL LB zero-cache quote:${engine}] quoted=${quoted} (== getSwapOut(amountIn), no prepared cache)`);
  }

  // ── (5) BIN-SHRINK / adverse drift — SHRINK the pool's bins BEFORE cooking; the QL ladder built live at
  // cook time CAPS the award at the shrunk live capacity, so the cook SUCCEEDS (no OutOfLiquidity revert) and
  // the LB↔V3 split RE-ANCHORS (LB share shrinks, V3 grows). The bytecode carries NO bin data — the SAME
  // bytecode is cooked after the shrink; only the live getSwapOut the ladder reads changes. ──
  async function runBinShrinkSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A LB pool with a DEEP book at prepare time (count 48, 5e18/bin), CHEAP (0.05% bin step ⇒ 0.025% base
    // fee) so it draws before the 0.30% V3.
    const PRE_RESERVE = 5n * E18;
    const m = makeLb({ address: ("0x" + "00".repeat(20)) as Hex, binStep: 5, count: 48, reserve: PRE_RESERVE });
    const pair = await deployLBPair(
      c.walletClient, c.publicClient, tokenIn, tokenOut, m.off.binStep, m.baseFactor, m.activeId, m.bins, caller,
    );
    const opPre: LbPool = { ...m.off, address: pair };

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);

    const amountIn = 200n * E18;
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [lbDescriptor(pair, 0, true, opPre.baseFactor)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: LB_DEFINES },
    );

    // Baseline (pre-shrink) oracle split — the LB share the deep book would award.
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oraclePre = optimalSplit({ pools: [v3Opt, { lb: opPre, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const lbSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(lbSharePre > 0n, "baseline oracle awards the LB venue a share");

    // ADVERSE DRIFT: SHRINK the drained (Y) side of the near bins from 5e18 to 2e18 (a liquidity burn / a
    // prior swap that partly drained the near bins looks exactly like this on-chain), collapsing the LB's
    // fillable capacity below the deep-book award.
    const SHRUNK = 2n * E18;
    for (let id = m.activeId - 48; id <= m.activeId; id++) {
      await c.publicClient.waitForTransactionReceipt({
        hash: await c.walletClient.writeContract({
          address: pair, abi: lbPairAbi as Abi, functionName: "setBin",
          args: [id, PRE_RESERVE, SHRUNK], account: caller, chain: c.walletClient.chain,
        }),
      });
    }
    // Drifted oracle: the SAME pool with the shrunk Y-side bins.
    const shrunkBins = opPre.bins.map((b) => ({ id: b.id, reserveX: b.reserveX, reserveY: b.id <= m.activeId ? SHRUNK : b.reserveY }));
    const opDrift: LbPool = { ...opPre, bins: shrunkBins };
    const oracleDrift = optimalSplit({ pools: [v3Opt, { lb: opDrift, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const lbShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    // The LB fillable capacity collapsed, so its awarded share must shrink (V3 takes the rest).
    assert.ok(lbShareDrift > 0n && lbShareDrift < lbSharePre, `bin-shrink shrinks the LB share (${lbShareDrift} < ${lbSharePre})`);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const lbInBefore = await balanceOf(c.publicClient, tokenIn, pair);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    // THE DoS-FIX ASSERTION: even though the bytecode was built for the DEEP book, the live QL ladder caps
    // the LB award at the SHRUNK live capacity, so the transfer-first _swapTraderJoeLB never over-asks — the
    // cook SUCCEEDS (the old static per-bin award would have over-asked and reverted LBPair__OutOfLiquidity).
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "bin-shrink cook() SUCCEEDS — LB award capped at live capacity (no OutOfLiquidity)");

    const lbIn = (await balanceOf(c.publicClient, tokenIn, pair)) - lbInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(lbIn > 0n && v3In > 0n, "both venues funded post-shrink");
    assert.equal(lbIn, lbShareDrift, "LB awarded input == drifted oracle (re-anchored to the live shrunk capacity)");
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(lbIn < lbSharePre, `LB share ADAPTED down after the bin shrink (${lbIn} < baseline ${lbSharePre})`);
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(
      `  [QL LB+V3 bin-shrink:${engine}] baseline LB share=${lbSharePre} → capped=${lbIn} ` +
        `(V3 grew to ${v3In}); cook SUCCEEDED (no OutOfLiquidity); received=${received}`,
    );
  }

  // ── (6) BIN CAPACITY CAP (DoS fix, solo) — amountIn FAR EXCEEDS the pool's fillable capacity. The QL
  // ladder caps the awarded LB input at the LIVE absorbable capacity (effAbsorbed), so the transfer-first
  // _swapTraderJoeLB never over-asks: the cook SUCCEEDS (the old static per-bin award would over-ask ⇒
  // LBPair__OutOfLiquidity) and spends only what the pool can absorb. received == getSwapOut(spent). ──
  async function runCapacityCap(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A SHALLOW book (count 24, 2e18/bin ⇒ ~50e18 fillable Y) but a MUCH larger amountIn.
    const m = makeLb({ address: ("0x" + "00".repeat(20)) as Hex, binStep: 20, count: 24, reserve: 2n * E18 });
    const pair = await deployLBPair(
      c.walletClient, c.publicClient, tokenIn, tokenOut, m.off.binStep, m.baseFactor, m.activeId, m.bins, caller,
    );
    const op: LbPool = { ...m.off, address: pair };

    const amountIn = 200n * E18; // >> the pool's ~50e18 fillable capacity
    const ladder = buildLbQLLadder(op, amountIn);
    const ladderCap = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.ok(ladderCap > 0n && ladderCap < amountIn, `ladder capacity ${ladderCap} is capped below amountIn ${amountIn} (live-capacity bound)`);

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [lbDescriptor(pair, 0, true, op.baseFactor)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: LB_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    // THE DoS-FIX ASSERTION: the awarded input is capped at the live capacity, so the cook SUCCEEDS instead
    // of reverting LBPair__OutOfLiquidity (which an award of the full amountIn to a transfer-first LB would).
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "capacity-capped LB cook() SUCCEEDS (award bounded to live capacity, no OutOfLiquidity)");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(spent > 0n && spent < amountIn, `spent ${spent} capped below amountIn ${amountIn} (only the fillable capacity)`);
    assert.equal(spent, ladderCap, "spent == the QL ladder's live-capped capacity (Σ slice capacity)");
    assert.equal(received, lbGetSwapOut(op, spent), "received == getSwapOut(spent) to the wei");
    assert.ok(received > 0n, "caller receives tokenOut for the fillable share");

    console.log(
      `  [QL LB capacity-cap:${engine}] amountIn=${amountIn} spent=${spent} (< amountIn — capped at live capacity) ` +
        `received=${received}; cook SUCCEEDED (no OutOfLiquidity)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL LB solo [${engine}] — on-chain ladder, received == getSwapOut(share) wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL LB + V3 [${engine}] — sampled stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runLbV3(engine);
    });
    it(`QL LB + QL Curve [${engine}] — two QL segKinds in one loop, interleave + split == oracle`, { skip }, async () => {
      await runLbCurve(engine);
    });
    it(`QL LB zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL LB + V3 bin-shrink [${engine}] — split RE-ANCHORS to the live shrunk capacity (adverse drift)`, { skip }, async () => {
      await runBinShrinkSplit(engine);
    });
    it(`QL LB capacity-cap [${engine}] — award capped at live capacity, no OutOfLiquidity (DoS fix)`, { skip }, async () => {
      await runCapacityCap(engine);
    });
  }
});
