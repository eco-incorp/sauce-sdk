/**
 * EcoSwap Fermi / propAMM (gattaca-com/propamm FermiSwapper — an OBRIC-style proactive AMM) QUOTE-LADDER
 * (QL) local-EVM integration — the live-walk quoteAmounts ladder + the callback-free exact-in-dy gate.
 *
 * Fermi is migrated to the QUOTE-LADDER framework (the same one Curve / LB / WOOFi / DODO / Wombat use):
 * prepare ships ONLY a descriptor [pool, _, _, feePpm, segKind=11, refIdx] — NO off-chain sampled ladder — and
 * the on-chain solver BUILDS each Fermi venue's price ladder in setup from LIVE cook-time
 * `quoteAmounts(tokenIn, tokenOut, +xNext)[1]` (the SECOND return is the exact-in out; PROBE-THEN-DECODE, as
 * the maker can pause / go stale). EXEC is UNCHANGED: callback-free — an on-chain quoteAmounts staticcall for
 * amountCheck + approve + `fermiSwapWithAllowances(...)` (propAMM PULLS via transferFrom).
 *
 * The oracle prices Fermi via buildFermiQLLadder over a ladder SAMPLED AT the geometric `qlLadderInputs`
 * points (the SAME points the on-chain ladder queries) — interpolation is exact at a sample point, so the
 * oracle reproduces the solver's live quoteAmounts ladder to the WEI and the split is wei-exact.
 *
 *   (1) SOLO QL Fermi — ladder built from live quoteAmounts, covers [0, amountIn], received ==
 *       quoteAmounts(share)[1] == the pool's own view, all to the WEI.
 *   (2) QL Fermi + a live V3 direct pool — the QL stream (bestKind 1) vs the live V3 frontier (bestKind 3) in
 *       ONE merge; the per-venue split == the neutral oracle to the WEI.
 *   (3) QL Fermi + QL Curve — TWO QL venues of DIFFERENT segKind (11 + 1) ride ONE qlv; interleave + split.
 *   (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared segments, quote ==
 *       quoteAmounts(amountIn)[1] to the wei.
 *   (5) ADVERSE DRIFT — the maker posts a SHALLOWER curve (setState) BEFORE cooking the pre-drift bytecode;
 *       the QL ladder reads the LIVE (worse) quoteAmounts and the Fermi↔V3 split RE-ANCHORS (Fermi share
 *       shrinks, V3's grows) to the drifted oracle, wei-exact.
 *
 * No fork / no RPC env — local fixtures etch the whole stack. Runs on v1 (+ v12 when the v12 artifacts are
 * present), driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil. Mirrors ecoswap.lb.evm.test.ts.
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
  deployFermiPool,
  fermiPoolAbi,
  deployCurveStableSwap,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { buildFermiQLLadder, type FermiPool } from "../shared/fermi-math";
import { qlLadderInputs, getDy as curveGetDy, type CurvePool } from "../shared/curve-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const FEE_PPM = 300n; // 0.03% (1e6-scaled), folded into the quote
const ENGINE_CELLS = engineCells();

// Fermi-only treeshake defines (HAS_FERMI lights the on-chain QL ladder build's Fermi quote branch + the
// segKind-11 accumulator + the callback-free exec; the live V3 frontier + merge core are unguarded).
const FERMI_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: true, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
};
// Fermi + Curve — BOTH QL adapter branches ship so the qlv loop builds a segKind-11 + a segKind-1 ladder.
const FERMI_CURVE_DEFINES: Record<string, boolean> = { ...FERMI_DEFINES, HAS_CURVE: true, HAS_FERMI: true };

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

// One QL Fermi descriptor: [pool, _, _, feePpm, segKind=11, refIdx]. Fermi quotes by tokenIn/tokenOut, so
// qd[1]/qd[2] are unused; feePpm is informational (quoteAmounts is post-fee).
function fermiDescriptor(pool: Hex, refIdx: number, feePpm: number): bigint[] {
  return [BigInt(pool), 0n, 0n, BigInt(feePpm), 11n, BigInt(refIdx)];
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

describe("EcoSwap Fermi / propAMM QL live-walk (local fixture) — on-chain quoteAmounts ladder + callback-free exec", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the Fermi X token (sellX: X → Y)
  let tokenOut: Hex; // == the Fermi Y token
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

  // Deploy a Fermi pool (X=tokenIn, Y=tokenOut) funded with X+Y reserves. `v0` sets the near-1:1 curve
  // (K=v0², base=v0). Larger v0 ⇒ flatter/deeper.
  async function deploy(v0: bigint, xRes: bigint, yRes: bigint, minter: Account): Promise<Hex> {
    return deployFermiPool(c.walletClient, c.publicClient, tokenIn, tokenOut, v0 * v0, v0, FEE_PPM, xRes, yRes, minter);
  }

  // The fixture's own on-chain quoteAmounts view — the engine-independent ground truth. Returns [1] (out).
  async function onQuery(pool: Hex, amt: bigint): Promise<bigint> {
    const r = (await c.publicClient.readContract({
      address: pool, abi: fermiPoolAbi as Abi, functionName: "quoteAmounts", args: [tokenIn, tokenOut, amt],
    })) as readonly [bigint, bigint];
    return r[1];
  }

  // Off-chain FermiPool descriptor — SAMPLES the fixture's LIVE quoteAmounts ladder AT the geometric
  // `qlLadderInputs` points (the SAME points the on-chain QL ladder queries), so buildFermiQLLadder's
  // interpolation is EXACT at every ladder point ⇒ oracle == solver to the wei.
  async function offPool(address: Hex, amountIn: bigint): Promise<FermiPool> {
    const cumIn = qlLadderInputs(amountIn);
    const cumOut: bigint[] = [];
    for (const amt of cumIn) cumOut.push(await onQuery(address, amt));
    return { address, tokenIn, tokenOut, cumIn, cumOut, feePpm: Number(FEE_PPM), source: "local-fixture" };
  }

  function offCurvePool(address: Hex, balances: bigint[], a: bigint, fee: bigint): CurvePool {
    return { poolType: 3, address, i: 0, j: 1, A: a, aPrecision: 100n, balances, rates: [E18, E18], feePpm10: fee, source: "local-fixture" };
  }

  // ── (1) SOLO QL Fermi — the on-chain ladder is built live; received == quoteAmounts(share)[1] wei ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const V0 = 10_000_000n * E18;
    const pool = await deploy(V0, 2_000_000n * E18, 2_000_000n * E18, caller);

    const amountIn = 100_000n * E18;
    const op = await offPool(pool, amountIn);
    const ladder = buildFermiQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL Fermi ladder");
    const cover = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(cover, amountIn, "QL Fermi ladder covers the full amountIn (pool deep enough)");

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [fermiDescriptor(pool, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: FERMI_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const onViewPre = await onQuery(pool, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL Fermi cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL Fermi venue)");
    assert.equal(poolIn, amountIn, "the Fermi pool pulled the full input share (approve + pull)");
    assert.equal(received, onViewPre, "received == on-chain quoteAmounts view to the wei");
    assert.ok(received > 0n, "non-zero Fermi fill through the callback-free approve+swap path");

    console.log(
      `  [QL Fermi solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== on-chain quoteAmounts to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) QL Fermi + a live V3 direct pool — split == oracle wei-exact ──
  async function runFermiV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A deep/flat Fermi (v0=50M, cheap 0.03% fee) vs a DEEP 1:1 V3 (0.30% fee): the Fermi fills the cheap
    // near region, its marginal drops below V3's, V3 takes the tail — both fund.
    const V0 = 50_000_000n * E18;
    const pool = await deploy(V0, 2_000_000n * E18, 2_000_000n * E18, caller);
    const amountIn = 100_000n * E18;
    const op = await offPool(pool, amountIn);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({ pools: [v3Opt, { fermi: op, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oFermi = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oFermi > 0n, `oracle splits across V3 + Fermi (V3 ${oV3}, Fermi ${oFermi})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [fermiDescriptor(pool, 0, Number(FEE_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: FERMI_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const fermiInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "Fermi+V3 cook() must succeed");

    const fermiIn = (await balanceOf(c.publicClient, tokenIn, pool)) - fermiInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(fermiIn > 0n && v3In > 0n, `both venues funded (Fermi ${fermiIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(fermiIn, oFermi, "Fermi awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL Fermi+V3:${engine}] V3 in=${v3In} Fermi in=${fermiIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) QL Fermi + QL Curve — TWO QL venues of DIFFERENT segKind (11 + 1) in ONE qlv ──
  async function runFermiCurve(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A deep/flat cheap Fermi (draws first) vs a SHALLOWER dearer Curve (steepens and takes a slice) — both
    // fund, ladders interleave in the merged DESC sort.
    const V0 = 50_000_000n * E18;
    const pool = await deploy(V0, 2_000_000n * E18, 2_000_000n * E18, caller);
    const amountIn = 60_000n * E18;
    const op = await offPool(pool, amountIn);

    const curveBal = [40_000n * E18, 40_000n * E18];
    const CURVE_A = 100n, CURVE_FEE = 4_000_000n; // 0.04% (1e10-scaled), dearer than Fermi's 0.03%
    const curve = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], curveBal, [E18, E18], CURVE_A, CURVE_FEE, caller);
    const opCurve = offCurvePool(curve, curveBal, CURVE_A, CURVE_FEE);

    const oracle = optimalSplit({ pools: [{ curve: opCurve, feePpm: 0 }, { fermi: op, feePpm: 0 }], amountIn, zeroForOne: true });
    const oCurve = oracle.perPoolInput[0] ?? 0n;
    const oFermi = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oCurve > 0n && oFermi > 0n, `oracle splits across QL Curve + QL Fermi (Curve ${oCurve}, Fermi ${oFermi})`);

    const qlv = [curveDescriptor(curve, 0, CURVE_FEE), fermiDescriptor(pool, 0, Number(FEE_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: FERMI_CURVE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const curveInBefore = await balanceOf(c.publicClient, tokenIn, curve);
    const fermiInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "QL Fermi + QL Curve cook() must succeed");

    const curveIn = (await balanceOf(c.publicClient, tokenIn, curve)) - curveInBefore;
    const fermiIn = (await balanceOf(c.publicClient, tokenIn, pool)) - fermiInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(curveIn > 0n && fermiIn > 0n, `both QL venues funded (Curve ${curveIn}, Fermi ${fermiIn})`);
    assert.equal(curveIn, oCurve, "Curve awarded input == oracle (wei-exact split)");
    assert.equal(fermiIn, oFermi, "Fermi awarded input == oracle (wei-exact split)");
    // PER-LEG WEI-EXACT: received == get_dy_Curve(curveIn) + the LIVE quoteAmounts(fermiIn)[1] (the exec
    // re-reads the exact live quote for the awarded share; the off-chain getAmountOut ladder is only exact
    // AT a ladder point, so use the on-chain view for the arbitrary awarded share). NO tolerance.
    assert.equal(received, curveGetDy(opCurve, curveIn) + (await onQuery(pool, fermiIn)), "received == Σ per-venue view(share) to the wei");

    console.log(
      `  [QL Curve+Fermi:${engine}] Curve in=${curveIn} Fermi in=${fermiIn} received=${received} ` +
        `(two QL segKinds interleaved; split == oracle, dy wei-exact)`,
    );
  }

  // ── (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared cache/segments ──
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

    const V0 = 10_000_000n * E18;
    const pool = await deploy(V0, 2_000_000n * E18, 2_000_000n * E18, caller);
    const amountIn = 100_000n * E18;

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [fermiDescriptor(pool, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: FERMI_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(quoted, await onQuery(pool, amountIn), "zero-cache QUOTE == quoteAmounts(amountIn)[1] to the wei (ladder built live in the eth_call)");
    console.log(`  [QL Fermi zero-cache quote:${engine}] quoted=${quoted} (== quoteAmounts(amountIn)[1], no prepared cache)`);
  }

  // ── (5) ADVERSE DRIFT — the maker posts a SHALLOWER curve (setState) BEFORE cooking; the live QL ladder
  // re-anchors the Fermi↔V3 split to the drifted (worse) state. The SAME bytecode is cooked after the drift. ──
  async function runDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const V0 = 50_000_000n * E18;
    const pool = await deploy(V0, 2_000_000n * E18, 2_000_000n * E18, caller);
    const amountIn = 100_000n * E18;
    const opPre = await offPool(pool, amountIn);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [fermiDescriptor(pool, 0, Number(FEE_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: FERMI_DEFINES },
    );

    const oraclePre = optimalSplit({ pools: [v3Opt, { fermi: opPre, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const fermiSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(fermiSharePre > 0n, "baseline oracle awards the Fermi venue a share");

    // ADVERSE DRIFT: the maker posts a SHALLOWER curve (v0/5 ⇒ steeper, more slippage), so the live
    // quoteAmounts marginal for the same input drops.
    const V0drift = V0 / 5n;
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: pool, abi: fermiPoolAbi as Abi, functionName: "setState",
        args: [V0drift * V0drift, V0drift], account: caller, chain: c.walletClient.chain,
      }),
    });

    const opDrift = await offPool(pool, amountIn); // re-sample the LIVE (shallower) quoteAmounts ladder
    const oracleDrift = optimalSplit({ pools: [v3Opt, { fermi: opDrift, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const fermiShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(fermiShareDrift < fermiSharePre, `drift shrinks the Fermi share (${fermiShareDrift} < ${fermiSharePre})`);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const fermiInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drift cook() SUCCEEDS — Fermi ladder re-anchored to the live drifted state");

    const fermiIn = (await balanceOf(c.publicClient, tokenIn, pool)) - fermiInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(v3In > 0n, "V3 funded post-drift");
    assert.equal(fermiIn, fermiShareDrift, "Fermi awarded input == drifted oracle (re-anchored to the live drifted state)");
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(fermiIn < fermiSharePre, `Fermi share ADAPTED down after the drift (${fermiIn} < baseline ${fermiSharePre})`);
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(
      `  [QL Fermi+V3 drift:${engine}] baseline Fermi share=${fermiSharePre} → re-anchored=${fermiIn} ` +
        `(V3 grew to ${v3In}); spent=${spent} received=${received}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL Fermi solo [${engine}] — on-chain ladder, received == quoteAmounts(share)[1] wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL Fermi + V3 [${engine}] — sampled stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runFermiV3(engine);
    });
    it(`QL Fermi + QL Curve [${engine}] — two QL segKinds in one loop, interleave + split == oracle`, { skip }, async () => {
      await runFermiCurve(engine);
    });
    it(`QL Fermi zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL Fermi + V3 adverse drift [${engine}] — split RE-ANCHORS to the live drifted state`, { skip }, async () => {
      await runDriftSplit(engine);
    });
  }
});
