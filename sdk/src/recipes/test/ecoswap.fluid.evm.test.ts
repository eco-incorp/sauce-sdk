/**
 * EcoSwap Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — a Liquidity-Layer-backed re-centering
 * AMM) local-EVM integration — the callback-free exec + the snapshotted-quote split model.
 *
 * Stands up a local Fluid DexT1 pool + its periphery DexReservesResolver (the FluidDexPool.sol fixture,
 * which prices internally off SETTABLE Liquidity-Layer state — exchange rates + center price + fee + a
 * utilization out-cap — but exposes only the REAL VERIFIED FluidDexT1 SURFACE: `constantsView()` (token0/
 * token1 live inside its struct — the pool has NO standalone token0()/token1() getters),
 * `swapIn(bool swap0to1, uint256 amountIn, uint256 amountOutMin, address to)` (approve-first pull; a
 * `FluidDexSwapResult(uint256)` REVERT when `to == ADDRESS_DEAD` — the estimate hook), and the resolver's
 * `getDexTokens(dex)` (orients the pair via the pool's constantsView) + `estimateSwapIn(dex, swap0to1,
 * amountIn, amountOutMin)` which try/catches that revert into a plain
 * uint256), deploys the Sauce engine, and cooks an EcoSwap whose static-segment cursor consumes Fluid
 * segments (segKind 12) and executes them CALLBACK-FREE: an on-chain
 * `resolver.estimateSwapIn(pool, swap0to1, +awarded, 0)` staticcall (reading the LIVE layer state, used as
 * amountOutMin) + `token.approve(pool, awarded)` + `pool.swapIn(swap0to1, +awarded, amountOutMin, self)`
 * (Fluid PULLS via safeTransferFrom — approve-first, unlike WOOFi's transfer-first path). Fluid DEX is NOT
 * xy=k, so the engine's _swapV2 would mis-price it; DexT1 re-enters its OWN Liquidity layer via operate(),
 * never the cooking contract, so the swap is callback-free and needs NO engine dispatch. Then asserts:
 *
 *   (1) SOLO Fluid venue — the on-chain dy the caller receives == the resolver's own LIVE
 *       `estimateSwapIn(+share)` to the WEI (the exec re-reads the live estimate). Per-pool input == the
 *       whole trade. NO tolerance on the exec gate; the off-chain ladder interpolation is only a
 *       segment/split diagnostic.
 *   (2) TWO Fluid venues — ONE EcoSwap splits across both; each leg's received output == the LIVE
 *       `estimateSwapIn` for its awarded share to the wei, and the post-fee marginals equalize within the
 *       sampled-grid bound.
 *   (3) TREESHAKE regression cell — compiles the PRODUCTION treeshake define set (HAS_FLUID only, all other
 *       segment flags false) and cooks a REAL Fluid fill: guards that HAS_FLUID was added to the
 *       segment-head price-merge guard + the accumulator branch + the exec block across the guard triple
 *       (else the segment head is dead under treeshake and the swap lands ZERO — the Balancer-class bug).
 *   (4) STATE MOVES between prepare and cook — the split is priced at the SNAPSHOT ladder, then the layer
 *       accrues / re-centers (setLayer) before the cook. The exec stays exact-vs-live-estimate (received ==
 *       the LIVE `estimateSwapIn(+awarded)` at the moved state), demonstrating the snapshotted-quote model:
 *       exact-on-grid at the snapshot, exact-vs-live-estimate at exec (the layer prices accrue every block
 *       + caps can shrink — more exogenous than a fee snapshot). The move is bounded/guarded (per-pool
 *       amountOutMin == the LIVE estimate + the whole-trade amountOutMin + the solver's terminal refund).
 *
 * The Fluid math is OFF-CHAIN only for the SPLIT: the on-chain solver supplies the curve as STATIC
 * (capacity, marginalOI) segments (built by differencing a LIVE resolver `estimateSwapIn` ladder sampled
 * off-chain) and never recomputes the layer math. We build the prepared args DIRECTLY, then compile the
 * production solver template exactly as index.ts does and cook it.
 *
 * ISOLATED per-cell chain (the fresh-anvil-per-cell pattern all *.evm.test.ts use): every cell runs on its
 * OWN fresh anvil + freshly-deployed engine (setup()). setup() awaits the prior anvil's `stopped` promise
 * before booting the next (the race-free pattern).
 *
 * No fork / no RPC env needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when the v12
 * artifacts are present). Driven by ECO_ENGINE (default v12). Mirrors ecoswap.fermi.evm.test.ts.
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
  deployFluidDexPool,
  fluidDexPoolAbi,
  fluidDexResolverAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import {
  getAmountOut as fluidGetAmountOut,
  buildFluidSegments,
  fluidSampleInputs,
  isqrt,
  type FluidPool,
} from "../shared/fluid-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
// A deep near-1:1 Fluid curve: exchange rates at par, 1:1 center price, 0.01% fee (100, 1e6-scaled). Both
// tokens 18-dec so the split engages both venues on the flat part of the layer curve.
const FEE_PPM = 100n;
const RATE = E18; // par exchange rate both sides
const CENTER = E18; // 1:1 center price
// Utilization slippage depth (out reduced by amountIn²/DEPTH) — deep enough that a 100k swap stays near-1:1
// but the marginal genuinely descends so the split equalizes across pools of different depth.
const DEPTH = 20_000_000n * E18;
const ENGINE_CELLS = engineCells();

// The PRODUCTION treeshake define set for a Fluid-only universe (no other segment-bearing protocol):
// index.ts protocolDefines folds every other HAS_* to false. The fast/no-define test path leaves all HAS_*
// at their source default `true`, masking any merge-head guard that omits HAS_FLUID — so this cell compiles
// with the real treeshaken set and a REAL cook asserts a non-zero Fluid fill.
const FLUID_ONLY_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: true,
};

// Fluid-only run: zero direct pools/routes/netCache; the Fluid venues ride entirely inside segs (segKind 12).
// The solver's 5 compiler args, in index.ts order (cfg, pools, netCache, routing, segs). cfg[6] carries the
// chain-wide Fluid resolver address (the estimateSwapIn quote target).
function fluidArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, resolver: Hex, segs: bigint[][]): unknown[] {
  return [
    [
      BigInt(tokenIn),
      BigInt(tokenOut),
      amountIn,
      BigInt(caller),
      MIN_SQRT_RATIO + 1n, // priceLimit (unused by static segments)
      0n, // directCount — no direct pools
      BigInt(resolver), // cfg[6] — chain-wide Fluid DEX resolver
    ],
    [], // pools
    [], // netCache
    [], // routing
    segs,
  ];
}

// One Fluid venue → its sampled segments as segs rows. refIdx tags the on-chain per-venue accumulator
// (flinp[refIdx]); venue is the DexT1 pool address. Built from the SAME buildFluidSegments the oracle uses,
// so the awarded Σ == the off-chain share by construction. segKind = 12; a Fluid segment is a flat post-fee
// slice ⇒ sqrtAdjNear == sqrtAdjFar.
function fluidSegRows(pool: FluidPool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildFluidSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-fee; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (a Fluid segment is a flat slice)
    12n, // segKind = Fluid (callback-free)
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

describe("EcoSwap Fluid DEX (Instadapp FluidDexT1 Liquidity-Layer re-centering AMM, local fixture) — Class-A callback-free exact-in-dy + state-snapshot split", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the Fluid token0 (swap0to1: token0 → token1)
  let tokenOut: Hex; // == the Fluid token1
  let solverSrc: string;

  async function setup(): Promise<void> {
    // Tear the prior anvil down and WAIT for it to fully exit (port released) before booting the next — a
    // fire-and-forget stop() raced the new startAnvil() under machine load and intermittently flaked a cook.
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
  // cook target is approved to pull it, and every pool holds enough tokenOut (token1) to satisfy the out.
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

  // Off-chain FluidPool descriptor for a deployed fixture — SAMPLES the resolver's LIVE estimateSwapIn
  // ladder over [0, amountIn] exactly as discovery does (no closed-form read; the real pool exposes none).
  async function offPool(pool: Hex, resolver: Hex, amountIn: bigint): Promise<FluidPool> {
    const cumIn = fluidSampleInputs(amountIn);
    const cumOut: bigint[] = [];
    for (const amt of cumIn) cumOut.push(await onQuery(pool, resolver, amt));
    return {
      address: pool, resolver, swap0to1: true, tokenIn, tokenOut, cumIn, cumOut,
      feePpm: Number(FEE_PPM), source: "local-fixture",
    };
  }

  // Deploy a Fluid pool (token0=tokenIn, token1=tokenOut) + its resolver, funded with both reserves.
  // `depth` sets the utilization slippage (larger ⇒ deeper/flatter). Reserves must cover the out.
  async function deploy(
    center: bigint, res0: bigint, res1: bigint, depth: bigint, minter: Account,
  ): Promise<{ pool: Hex; resolver: Hex }> {
    return deployFluidDexPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, RATE, RATE, center, FEE_PPM, res0, res1, depth, minter,
    );
  }

  // The resolver's own on-chain estimateSwapIn view — the engine-independent ground truth for the executed
  // dy (swap0to1 = true since tokenIn is token0). amountOutMin 0 ⇒ pure quote.
  async function onQuery(pool: Hex, resolver: Hex, amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: resolver, abi: fluidDexResolverAbi as Abi, functionName: "estimateSwapIn",
      args: [pool, true, amt, 0n],
    })) as bigint;
  }

  // ── (1) SOLO Fluid venue — received == estimateSwapIn(share) == on-chain estimate to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const { pool, resolver } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);

    // amountIn == the full sampled ladder cap ⇒ the merge awards the WHOLE Σ to this one venue.
    const amountIn = 100_000n * E18;
    const op = await offPool(pool, resolver, amountIn);
    const segRows = fluidSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Fluid segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    assert.equal(segSum, amountIn, "Fluid segments cover the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, fluidArgs(tokenIn, tokenOut, amountIn, caller, resolver, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: await onQuery(pool, resolver, segSum) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    const onViewPre = await onQuery(pool, resolver, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Fluid cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (the whole trade routed to the Fluid pool)");
    assert.equal(poolIn, amountIn, "the Fluid pool received the full input share (approve + pull)");

    // EXACT-VS-LIVE-ESTIMATE: received == the resolver's own LIVE estimateSwapIn(+share) view to the wei.
    assert.equal(received, onViewPre, "received == on-chain estimateSwapIn view (exact-vs-live-estimate)");
    assert.ok(received > 0n, "non-zero Fluid fill through the callback-free approve+swapIn path");

    console.log(`  [Fluid solo:${engine}] spent=${spent} received=${received} (== on-chain estimateSwapIn to the wei)`);
  }

  // ── (2) TWO Fluid venues — split + per-leg exact-in-dy + marginals equalize ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues at the same 1:1 center but DIFFERENT depth (utilization slippage) → different marginal
    // curves, so the water-fill engages BOTH and equalizes their post-fee marginals. A (larger depth) is
    // flatter/deeper, so it drives first + more; B (smaller depth) steepens sooner. The DexReservesResolver
    // is STATELESS (it only calls dex.swapIn(...,ADDRESS_DEAD)), so BOTH pools share ONE resolver — a single
    // chain-wide cfg[6] serves both venues (exactly the production shape: one resolver per chain).
    const DEPTH_A = 40_000_000n * E18; // deep/flat
    const DEPTH_B = 8_000_000n * E18; // shallower (steeper)
    const a = await deploy(CENTER, 5_000_000n * E18, 5_000_000n * E18, DEPTH_A, caller);
    const b = await deploy(CENTER, 5_000_000n * E18, 5_000_000n * E18, DEPTH_B, caller);
    const resolver = a.resolver; // shared chain-wide resolver

    const amountIn = 200_000n * E18;
    const opA = await offPool(a.pool, resolver, amountIn);
    const opB = await offPool(b.pool, resolver, amountIn);
    const segRows = sortSegs([...fluidSegRows(opA, 0, amountIn), ...fluidSegRows(opB, 1, amountIn)]);

    const { bytecodes } = compileSauce(
      solverSrc, fluidArgs(tokenIn, tokenOut, amountIn, caller, resolver, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [
      { pool: a.pool, expectedOut: await onQuery(a.pool, resolver, amountIn) },
      { pool: b.pool, expectedOut: await onQuery(b.pool, resolver, amountIn) },
    ]);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const aInBefore = await balanceOf(c.publicClient, tokenIn, a.pool);
    const bInBefore = await balanceOf(c.publicClient, tokenIn, b.pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue Fluid cook() must succeed");

    const aIn = (await balanceOf(c.publicClient, tokenIn, a.pool)) - aInBefore;
    const bIn = (await balanceOf(c.publicClient, tokenIn, b.pool)) - bInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(aIn > 0n && bIn > 0n, "both Fluid venues are funded");
    assert.ok(aIn > bIn, `deeper venue A draws more than B (A ${aIn} > B ${bIn})`);

    // PER-LEG EXACT-VS-LIVE-ESTIMATE: received == estimate_A(aIn) + estimate_B(bIn) on-chain (both via the
    // shared resolver targeting each pool).
    const expected = (await onQuery(a.pool, resolver, aIn)) + (await onQuery(b.pool, resolver, bIn));
    assert.equal(received, expected, "received == Σ on-chain estimateSwapIn(per-venue share) to the wei");

    // MARGINALS EQUALIZE within the GRID bound (exact-on-grid at the snapshot: the awarded inputs equal the
    // oracle bit-for-bit — checked by the wei-exact gate above; the realized post-fee marginal equalizes
    // only to within ONE sampled segment's price width).
    const margA = marginalAt(opA, aIn);
    const margB = marginalAt(opB, bIn);
    const diff = margA > margB ? margA - margB : margB - margA;
    const relPpm = margA > 0n ? (diff * 1_000_000n) / margA : 0n;
    assert.ok(relPpm <= 3000n, `Fluid split marginals equalize on the M=24 grid (rel ${relPpm} ppm; A ${margA} B ${margB})`);

    console.log(
      `  [Fluid split:${engine}] A in=${aIn} B in=${bIn} received=${received} ` +
        `(== Σ estimateSwapIn to the wei); marginals A=${margA} B=${margB} (${relPpm} ppm)`,
    );
  }

  // ── (3) SOLO Fluid under the PRODUCTION treeshake define set ──
  // Same trade as runSolo, but compiled with treeshake:true + Fluid-only defines (the exact compile a
  // production Fluid-without-other-segs cook carries). Guards the guard triple: if HAS_FLUID is missing
  // from the segment-head price-merge guard, the accumulator branch, OR the exec block, under treeshake the
  // Fluid head is never compared / never accumulated / never swapped and the swap lands ZERO (Balancer bug).
  async function runSoloTreeshake(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const { pool, resolver } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);

    const amountIn = 100_000n * E18;
    const op = await offPool(pool, resolver, amountIn);
    const segRows = fluidSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Fluid segment ladder");

    const { bytecodes } = compileSauce(
      solverSrc, fluidArgs(tokenIn, tokenOut, amountIn, caller, resolver, segRows), ECOSWAP_DIR, engine,
      { treeshake: true, defines: FLUID_ONLY_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: await onQuery(pool, resolver, amountIn) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "treeshaken Fluid-only cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // The merge MUST have routed the trade to Fluid — non-zero spend/receive is the regression gate.
    assert.ok(spent > 0n, "treeshaken Fluid-only: non-zero Fluid fill (guard triple alive)");
    assert.equal(received, await onQuery(pool, resolver, spent), "received == on-chain estimateSwapIn(share) to the wei (treeshaken path)");

    console.log(`  [Fluid treeshake:${engine}] spent=${spent} received=${received} (production define set)`);
  }

  // ── (4) STATE MOVES between prepare and cook — exec stays exact-in-dy at the LIVE layer state ──
  // The split is priced at the SNAPSHOT layer state (op captures the exchange rates / center price), the
  // segs are built from it, THEN the layer accrues / re-centers via setLayer before the cook. The exec
  // re-reads the LIVE state via the resolver estimateSwapIn, so the received dy == the LIVE estimate at the
  // MOVED state (exact-in-dy), NOT the snapshot dy — the documented Class-A snapshot model: exact-on-grid
  // at the snapshot, exact-in-dy at the live view. A re-centering that RAISES the token1-per-token0 center
  // price ⇒ MORE out; per-pool minOut (== the LIVE estimate) guards an adverse move. This is the same
  // class as the Fermi state-move / WOOFi oracle-snapshot / V3 fee-snapshot assumption — but MORE exogenous
  // (the layer prices accrue every block).
  async function runStateMoves(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Fund with EXTRA token1 so the moved-state (larger) output is still covered.
    const { pool, resolver } = await deploy(CENTER, 2_000_000n * E18, 4_000_000n * E18, DEPTH, caller);

    const amountIn = 100_000n * E18;
    const opSnapshot = await offPool(pool, resolver, amountIn); // the SNAPSHOT ladder the split is priced at
    const snapDy = await onQuery(pool, resolver, amountIn); // the snapshot estimate for the whole trade
    const segRows = fluidSegRows(opSnapshot, 0, amountIn); // segments PRICED at the snapshot
    const { bytecodes } = compileSauce(
      solverSrc, fluidArgs(tokenIn, tokenOut, amountIn, caller, resolver, segRows), ECOSWAP_DIR, engine,
    );

    // The layer MOVES between prepare (segs above) and cook: it re-centers to a BETTER token1-per-token0
    // price (center 1.01× ⇒ more out per unit) — a strictly better fill.
    const movedCenter = (CENTER * 101n) / 100n;
    const setHash = await c.walletClient.writeContract({
      address: pool, abi: fluidDexPoolAbi as Abi, functionName: "setLayer",
      args: [RATE, RATE, movedCenter],
      account: c.walletClient.account as Account, chain: c.walletClient.chain,
    });
    await c.publicClient.waitForTransactionReceipt({ hash: setHash });

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const liveOut = await onQuery(pool, resolver, amountIn); // LIVE estimate at the moved state — the exec ground truth
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: liveOut }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "state-moved Fluid cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // EXACT-VS-LIVE-ESTIMATE at the LIVE (moved) state — NOT the snapshot dy.
    assert.equal(spent, amountIn, "the whole trade routed to the single Fluid pool");
    assert.equal(received, liveOut, "received == on-chain LIVE estimateSwapIn view at the moved state");
    // The move was to a better center price (more out) ⇒ received strictly exceeds the snapshot estimate.
    assert.ok(received > snapDy, "moved (re-centered up) state yields more than the snapshot dy");

    console.log(
      `  [Fluid state-move:${engine}] spent=${spent} received=${received} ` +
        `(snapshot dy=${snapDy} < live dy — exact-vs-live-estimate at the moved state)`,
    );
  }

  // Post-fee out/in marginal price at a cumulative input `share` — a small finite-difference slice of
  // getAmountOut around `share` (the same coordinate the segments carry). Used only to check the split
  // equalized marginals.
  function marginalAt(pool: FluidPool, share: bigint): bigint {
    if (share <= 0n) return 0n;
    const eps = share / 1000n > 0n ? share / 1000n : 1n;
    const lo = share - eps > 0n ? share - eps : 0n;
    const dIn = share - lo;
    const dOut = fluidGetAmountOut(pool, share) - fluidGetAmountOut(pool, lo);
    if (dIn <= 0n || dOut <= 0n) return 0n;
    return isqrt((dOut * (1n << 192n)) / dIn);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Fluid solo [${engine}] — received == estimateSwapIn(share) == on-chain view to the wei (exact-in-dy)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Fluid split [${engine}] — two venues, per-leg exact-in-dy + marginals equalize`, { skip }, async () => {
      await runSplit(engine);
    });
    it(`Fluid solo treeshake [${engine}] — production define set lands a non-zero Fluid fill`, { skip }, async () => {
      await runSoloTreeshake(engine);
    });
    it(`Fluid state moves [${engine}] — split priced at snapshot, exec exact-in-dy at the live state`, { skip }, async () => {
      await runStateMoves(engine);
    });
  }
});
