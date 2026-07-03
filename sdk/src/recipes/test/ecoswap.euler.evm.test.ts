/**
 * EcoSwap EulerSwap (Euler vault-backed AMM, v1+v2) QUOTE-LADDER (QL) local-EVM integration — the live-walk
 * computeQuote ladder + the callback-free exact-in-dy gate + the vault-cap self-truncation.
 *
 * EulerSwap is migrated to the QUOTE-LADDER framework (the same one Curve / LB / WOOFi / DODO / Wombat /
 * Fermi use): prepare ships ONLY a descriptor [pool, _, _, feePpm, segKind=7, refIdx] — NO off-chain sampled
 * segments — and the on-chain solver BUILDS each EulerSwap venue's price ladder in setup from LIVE cook-time
 * `computeQuote(tokenIn, tokenOut, xNext, true)` (the exact-in dy; PROBE-THEN-DECODE, since computeQuote
 * REVERTS SwapLimitExceeded/Expired past the live vault inLimit/outLimit). EXEC is UNCHANGED: callback-free —
 * an on-chain computeQuote staticcall for minOut + transfer + getAssets-oriented `pool.swap(a0,a1,to,"")`
 * (EulerSwap's swap is V2-shaped; EMPTY data skips the flash callback, so the pool sweeps the pre-transferred
 * input + verifies the curve — NO engine SwapPoolType, since the asymmetric Euler curve is NOT xy=k).
 *
 * The oracle prices EulerSwap via buildEulerSwapQLLadder over the SAME geometric ladder points, replayed
 * through the closed-form `computeQuote` bigint (the fixture computeQuote mirrors it bit-for-bit), INCLUDING
 * the vault-cap self-truncation — so the oracle reproduces the solver's live computeQuote ladder to the WEI
 * and the split is wei-exact, even when the trade crosses the cap.
 *
 *   (1) SOLO QL EulerSwap — ladder built from live computeQuote, covers [0, amountIn], received ==
 *       computeQuote(amountIn) == the pool's own view, all to the WEI.
 *   (2) QL EulerSwap + a live V3 direct pool — the QL stream (bestKind 1) vs the live V3 frontier (bestKind 3)
 *       in ONE merge; the per-venue split == the neutral oracle to the WEI.
 *   (3) QL EulerSwap + QL Curve — TWO QL venues of DIFFERENT segKind (7 + 1) ride ONE qlv; interleave + split.
 *   (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared segments, quote ==
 *       computeQuote(amountIn) to the wei.
 *   (5) ADVERSE DRIFT — a REAL swap pushes the EulerSwap pool WORSE BEFORE cooking the pre-drift bytecode; the
 *       QL ladder reads the LIVE (worse) computeQuote and the EulerSwap↔V3 split RE-ANCHORS (Euler share
 *       shrinks, V3's grows) to the drifted oracle, wei-exact.
 *   (6) VAULT-CAP self-truncation — a trade sized so the geometric ladder crosses the LIVE vault output cap;
 *       the ladder self-truncates (computeQuote returns 0/reverts past the cap), the AWARD is BOUNDED below
 *       amountIn, the cook SUCCEEDS with NO exec revert (the audit's cap-revert DoS is fixed), and the
 *       remainder is returned by the guarded terminal refund — spent == the drifted-cap oracle to the WEI.
 *   (7) DISCOVERY — the real discoverEulerSwapPoolsTyped detects v1 (curve()+getParams()) AND v2
 *       (getDynamicParams()) and normalizes into the same wei-exact descriptor (a read path, engine-agnostic).
 *
 * No fork / no RPC env — local fixtures etch the whole stack. Runs on v1 (+ v12 when the v12 artifacts are
 * present), driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil. Mirrors ecoswap.fermi.evm.test.ts.
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
  deployEulerSwapPool,
  eulerSwapPoolAbi,
  deployCurveStableSwap,
  SQRT_PRICE_1_1,
  type EulerSwapParams,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO, SwapPoolType, FactoryType, type FactoryConfig } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { discoverEulerSwapPoolsTyped } from "../shared/pool-discovery";
import {
  computeQuote,
  buildEulerSwapQLLadder,
  type EulerSwapPool,
} from "../shared/eulerswap-math";
import { getDy as curveGetDy, type CurvePool } from "../shared/curve-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const CONC = (9n * E18) / 10n; // concentration 0.9 (concentrated near equilibrium)
const FEE = E18 / 1000n; // 0.1% (1e18-scaled)
const FEE_PPM = Number((FEE * 1_000_000n) / E18); // 1000
const ENGINE_CELLS = engineCells();

// EulerSwap-only treeshake defines (HAS_EULER lights the on-chain QL ladder build's EulerSwap quote branch +
// the segKind-7 accumulator + the callback-free exec; the live V3 frontier + merge core are unguarded). This
// is the exact compile a production EulerSwap-without-other-QL cook carries, so every cell running under it
// also guards the merge-head price-merge guard (a missing HAS_EULER there strands the QL head → ZERO fill).
const EULER_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: true, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
};
// EulerSwap + Curve — BOTH QL adapter branches ship so the qlv loop builds a segKind-7 + a segKind-1 ladder.
const EULER_CURVE_DEFINES: Record<string, boolean> = { ...EULER_DEFINES, HAS_CURVE: true, HAS_EULER: true };

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

// One QL EulerSwap descriptor: [pool, _, _, feePpm, segKind=7, refIdx]. EulerSwap quotes by tokenIn/tokenOut,
// so qd[1]/qd[2] are unused; feePpm is informational (computeQuote is post-fee).
function eulerDescriptor(pool: Hex, refIdx: number, feePpm: number): bigint[] {
  return [BigInt(pool), 0n, 0n, BigInt(feePpm), 7n, BigInt(refIdx)];
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

describe("EcoSwap EulerSwap QL live-walk (local fixture, v1+v2) — on-chain computeQuote ladder + callback-free exec", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == token0 (lower address) == the pool's asset0 (x side)
  let tokenOut: Hex; // == token1 == asset1 (y side)
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

  // Deploy a fixture EulerSwap pool at equilibrium (reserve == equilibrium). asset0 == tokenIn (x side),
  // asset1 == tokenOut (y side). `outCap1` caps the tokenOut side (the vault available cash); 0 ⇒ uncapped.
  async function deploy(rIn: bigint, rOut: bigint, outCap1 = 0n): Promise<Hex> {
    const params: EulerSwapParams = {
      reserve0: rIn, reserve1: rOut, equil0: rIn, equil1: rOut,
      priceX: E18, priceY: E18, concX: CONC, concY: CONC, fee: FEE, outCap0: 0n, outCap1,
    };
    return deployEulerSwapPool(c.walletClient, c.publicClient, tokenIn, tokenOut, params, c.walletClient.account as Account);
  }

  // Off-chain EulerSwapPool descriptor for the fixture (tokenIn == asset0). The CLOSED-FORM computeQuote
  // replay mirrors the fixture's on-chain computeQuote bit-for-bit at ANY input, so buildEulerSwapQLLadder
  // reproduces the solver's live ladder to the wei ⇒ oracle == solver. `outLimit` mirrors the vault output
  // cap so the oracle self-truncates at the SAME point the on-chain computeQuote does (the cap case).
  function offPool(address: Hex, rIn: bigint, rOut: bigint, eqIn: bigint, eqOut: bigint, outLimit = 0n): EulerSwapPool {
    return {
      address, inIsToken0: true,
      reserveIn: rIn, reserveOut: rOut, equilIn: eqIn, equilOut: eqOut,
      priceIn: E18, priceOut: E18, concIn: CONC, concOut: CONC, feeWad: FEE,
      inLimit: 0n, outLimit, feePpm: FEE_PPM, source: "local-fixture",
    };
  }

  function offCurvePool(address: Hex, balances: bigint[], a: bigint, fee: bigint): CurvePool {
    return { poolType: 3, address, i: 0, j: 1, A: a, aPrecision: 100n, balances, rates: [E18, E18], feePpm10: fee, source: "local-fixture" };
  }

  // The fixture's own on-chain computeQuote view (exact-in-dy ground truth). tokenIn == asset0 ⇒ out slot.
  async function onQuote(pool: Hex, amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: pool, abi: eulerSwapPoolAbi as Abi, functionName: "computeQuote", args: [tokenIn, tokenOut, amt, true],
    })) as bigint;
  }

  async function liveReserves(pool: Hex): Promise<[bigint, bigint]> {
    const r = (await c.publicClient.readContract({
      address: pool, abi: eulerSwapPoolAbi as Abi, functionName: "getReserves",
    })) as readonly [bigint, bigint, number];
    return [r[0], r[1]];
  }

  // ── (1) SOLO QL EulerSwap — the on-chain ladder is built live; received == computeQuote(amountIn) wei ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const r = 1_000_000n * E18;
    const pool = await deploy(r, r);
    const op = offPool(pool, r, r, r, r);

    const amountIn = 100_000n * E18;
    const ladder = buildEulerSwapQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL EulerSwap ladder");
    const cover = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(cover, amountIn, "QL EulerSwap ladder covers the full amountIn (pool deep enough, no cap)");

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [eulerDescriptor(pool, 0, FEE_PPM)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EULER_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const onViewPre = await onQuote(pool, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL EulerSwap cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL EulerSwap venue)");
    assert.equal(poolIn, amountIn, "the EulerSwap pool swept the full input share (transfer + V2-shaped swap)");
    assert.equal(received, onViewPre, "received == on-chain computeQuote view to the wei");
    assert.equal(received, computeQuote(op, spent), "received == off-chain computeQuote(share) to the wei (exact-in-dy)");
    assert.ok(received > 0n, "non-zero EulerSwap fill through the callback-free transfer+swap path");

    console.log(
      `  [QL Euler solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== on-chain computeQuote to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) QL EulerSwap + a live V3 direct pool — split == oracle wei-exact ──
  async function runEulerV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A cheaper (0.1%) EulerSwap vs a DEEP 1:1 V3 (0.30% fee): EulerSwap fills the cheap near region, its
    // marginal degrades with size below V3's, V3 takes the tail — both fund.
    const r = 1_000_000n * E18;
    const pool = await deploy(r, r);
    const op = offPool(pool, r, r, r, r);
    const amountIn = 300_000n * E18;

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({ pools: [v3Opt, { eulerSwap: op, feePpm: op.feePpm }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oEuler = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oEuler > 0n, `oracle splits across V3 + EulerSwap (V3 ${oV3}, Euler ${oEuler})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [eulerDescriptor(pool, 0, FEE_PPM)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EULER_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const eulerInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "EulerSwap+V3 cook() must succeed");

    const eulerIn = (await balanceOf(c.publicClient, tokenIn, pool)) - eulerInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(eulerIn > 0n && v3In > 0n, `both venues funded (Euler ${eulerIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(eulerIn, oEuler, "EulerSwap awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL Euler+V3:${engine}] V3 in=${v3In} Euler in=${eulerIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) QL EulerSwap + QL Curve — TWO QL venues of DIFFERENT segKind (7 + 1) in ONE qlv ──
  async function runEulerCurve(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A deep EulerSwap (draws first over its cheap near region) vs a SHALLOWER Curve (steepens fast and
    // takes a slice) — both fund, ladders interleave in the merged DESC sort.
    const r = 1_000_000n * E18;
    const pool = await deploy(r, r);
    const op = offPool(pool, r, r, r, r);
    const amountIn = 120_000n * E18;

    const curveBal = [60_000n * E18, 60_000n * E18];
    const CURVE_A = 100n, CURVE_FEE = 4_000_000n; // 0.04% (1e10-scaled)
    const curve = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], curveBal, [E18, E18], CURVE_A, CURVE_FEE, caller);
    const opCurve = offCurvePool(curve, curveBal, CURVE_A, CURVE_FEE);

    const oracle = optimalSplit({ pools: [{ curve: opCurve, feePpm: 0 }, { eulerSwap: op, feePpm: op.feePpm }], amountIn, zeroForOne: true });
    const oCurve = oracle.perPoolInput[0] ?? 0n;
    const oEuler = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oCurve > 0n && oEuler > 0n, `oracle splits across QL Curve + QL EulerSwap (Curve ${oCurve}, Euler ${oEuler})`);

    const qlv = [curveDescriptor(curve, 0, CURVE_FEE), eulerDescriptor(pool, 0, FEE_PPM)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EULER_CURVE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const curveInBefore = await balanceOf(c.publicClient, tokenIn, curve);
    const eulerInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "QL EulerSwap + QL Curve cook() must succeed");

    const curveIn = (await balanceOf(c.publicClient, tokenIn, curve)) - curveInBefore;
    const eulerIn = (await balanceOf(c.publicClient, tokenIn, pool)) - eulerInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(curveIn > 0n && eulerIn > 0n, `both QL venues funded (Curve ${curveIn}, Euler ${eulerIn})`);
    assert.equal(curveIn, oCurve, "Curve awarded input == oracle (wei-exact split)");
    assert.equal(eulerIn, oEuler, "EulerSwap awarded input == oracle (wei-exact split)");
    // PER-LEG WEI-EXACT: received == get_dy_Curve(curveIn) + computeQuote(eulerIn) (both closed-form exact
    // vs the on-chain views for the awarded shares). NO tolerance.
    assert.equal(received, curveGetDy(opCurve, curveIn) + computeQuote(op, eulerIn), "received == Σ per-venue view(share) to the wei");

    console.log(
      `  [QL Curve+Euler:${engine}] Curve in=${curveIn} Euler in=${eulerIn} received=${received} ` +
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

    const r = 1_000_000n * E18;
    const pool = await deploy(r, r);
    const amountIn = 100_000n * E18;

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [eulerDescriptor(pool, 0, FEE_PPM)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EULER_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(quoted, await onQuote(pool, amountIn), "zero-cache QUOTE == computeQuote(amountIn) to the wei (ladder built live in the eth_call)");
    console.log(`  [QL Euler zero-cache quote:${engine}] quoted=${quoted} (== computeQuote(amountIn), no prepared cache)`);
  }

  // ── (5) ADVERSE DRIFT — a REAL tokenIn→tokenOut swap pushes the EulerSwap pool WORSE BEFORE cooking; the
  // live QL ladder re-anchors the EulerSwap↔V3 split to the drifted (worse) state. SAME bytecode cooked after. ──
  async function runDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const r = 1_000_000n * E18;
    const pool = await deploy(r, r);
    const opPre = offPool(pool, r, r, r, r);
    const amountIn = 300_000n * E18;

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [eulerDescriptor(pool, 0, FEE_PPM)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EULER_DEFINES },
    );

    const oraclePre = optimalSplit({ pools: [v3Opt, { eulerSwap: opPre, feePpm: opPre.feePpm }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const eulerSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(eulerSharePre > 0n, "baseline oracle awards the EulerSwap venue a share");

    // ADVERSE DRIFT: a REAL tokenIn→tokenOut swap (add tokenIn, remove tokenOut) pushes the pool along the
    // curve so subsequent tokenIn→tokenOut computeQuote is WORSE (steeper, more slippage).
    const drift = 400_000n * E18;
    const driftOut = await onQuote(pool, drift);
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: tokenIn, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, drift], account: caller, chain: c.walletClient.chain,
      }),
    });
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: pool, abi: eulerSwapPoolAbi as Abi, functionName: "swap", args: [0n, driftOut, caller, "0x"], account: caller, chain: c.walletClient.chain,
      }),
    });

    const [r0d, r1d] = await liveReserves(pool);
    const opDrift = offPool(pool, r0d, r1d, r, r); // live reserves, ORIGINAL equilibrium
    const oracleDrift = optimalSplit({ pools: [v3Opt, { eulerSwap: opDrift, feePpm: opDrift.feePpm }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const eulerShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(eulerShareDrift < eulerSharePre, `drift shrinks the EulerSwap share (${eulerShareDrift} < ${eulerSharePre})`);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const eulerInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drift cook() SUCCEEDS — EulerSwap ladder re-anchored to the live drifted state");

    const eulerIn = (await balanceOf(c.publicClient, tokenIn, pool)) - eulerInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(v3In > 0n, "V3 funded post-drift");
    assert.equal(eulerIn, eulerShareDrift, "EulerSwap awarded input == drifted oracle (re-anchored to the live drifted state)");
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(eulerIn < eulerSharePre, `EulerSwap share ADAPTED down after the drift (${eulerIn} < baseline ${eulerSharePre})`);
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(
      `  [QL Euler+V3 drift:${engine}] baseline Euler share=${eulerSharePre} → re-anchored=${eulerIn} ` +
        `(V3 grew to ${v3In}); spent=${spent} received=${received}`,
    );
  }

  // ── (6) VAULT-CAP self-truncation — the geometric ladder crosses the LIVE vault output cap; the ladder
  // self-truncates (computeQuote returns 0/reverts past the cap), so the AWARD is BOUNDED below amountIn and
  // the cook SUCCEEDS with NO exec revert (the audit's cap-revert DoS is fixed). The guarded terminal refund
  // returns the un-awarded remainder. spent == the cap-truncated oracle to the WEI. ──
  async function runVaultCap(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const r = 1_000_000n * E18;
    // Output cap far below the ~98.8k out of a 100k full fill — so the ladder crosses it partway.
    const outCap = 50_000n * E18;
    const pool = await deploy(r, r, outCap);
    const op = offPool(pool, r, r, r, r, outCap); // oracle carries the SAME cap → self-truncates identically
    const amountIn = 100_000n * E18;

    const ladder = buildEulerSwapQLLadder(op, amountIn);
    const cover = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.ok(ladder.length > 0, "ladder emits pre-cap slices");
    assert.ok(cover < amountIn, `the ladder self-truncates below amountIn at the cap (cover ${cover} < ${amountIn})`);

    const oracle = optimalSplit({ pools: [{ eulerSwap: op, feePpm: op.feePpm }], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n && awarded < amountIn, `oracle award is bounded by the live cap (${awarded} < ${amountIn})`);

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [eulerDescriptor(pool, 0, FEE_PPM)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EULER_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    // PRE-swap on-chain view of the bounded award (the pool reserves move on the cook, so this must be read
    // before). awarded < cap ⇒ computeQuote returns the real value (> 0), NOT the 0 the cap yields past it.
    const onViewAwarded = await onQuote(pool, awarded);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    // THE FIX: the award is bounded by the live cap, so the exec computeQuote never cap-reverts — the cook
    // SUCCEEDS (the audit's cap-revert DoS is gone).
    assert.equal(receipt.status, "success", "vault-cap cook() SUCCEEDS — the ladder self-truncated below the cap, no exec revert");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.equal(spent, awarded, "spent == the cap-truncated oracle award to the wei");
    assert.ok(spent < amountIn, `award BOUNDED below amountIn (spent ${spent} < ${amountIn}) — the un-awarded input was refunded`);
    assert.ok(received > 0n, "the truncated EulerSwap slice DID fill (non-zero out)");
    assert.ok(received <= outCap, `received within the vault output cap (${received} <= ${outCap})`);
    assert.equal(received, computeQuote(op, spent), "received == computeQuote(awarded) to the wei (exact-in-dy on the bounded award)");
    assert.equal(received, onViewAwarded, "received == on-chain PRE-swap computeQuote(awarded) view to the wei");

    console.log(
      `  [QL Euler vault-cap:${engine}] cap=${outCap} → ladder self-truncated: spent=${spent} (< amountIn ${amountIn}) ` +
        `received=${received} (no exec revert — cap-revert DoS fixed)`,
    );
  }

  // ── (7) DISCOVERY: the REAL discoverEulerSwapPoolsTyped path detects v1 vs v2 via curve() ──
  async function runDiscovery(isV1: boolean): Promise<void> {
    await setup();
    const r = 1_000_000n * E18;
    const pool = await deployEulerSwapPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut,
      { reserve0: r, reserve1: r, equil0: r, equil1: r, priceX: E18, priceY: E18,
        concX: CONC, concY: CONC, fee: FEE, outCap0: 0n, outCap1: 0n },
      c.walletClient.account as Account, isV1,
    );

    const factory: FactoryConfig = {
      address: "0x00000000000000000000000000000000000000E5" as Hex,
      poolType: SwapPoolType.UniV2, factoryType: FactoryType.EulerSwap,
      label: "EulerSwap-fixture", eulerSwapPools: [pool],
    };

    const found = await discoverEulerSwapPoolsTyped(tokenIn, tokenOut, c.publicClient, [factory]);
    assert.equal(found.length, 1, `discovery surfaces the ${isV1 ? "v1" : "v2"} fixture pool`);
    const fp = found[0];
    assert.equal(fp.address.toLowerCase(), pool.toLowerCase(), "discovered the right pool");
    assert.ok(fp.source.includes(isV1 ? "v1" : "v2"), `source tags the version (${fp.source})`);
    assert.equal(fp.inIsToken0, true, "tokenIn == asset0 orientation");
    assert.equal(fp.feeWad, FEE, "fee read (v1 single / v2 fee0)");

    for (const dx of [1_000n * E18, 10_000n * E18, 100_000n * E18]) {
      const onView = await onQuote(pool, dx);
      assert.equal(computeQuote(fp, dx), onView, `discovered ${isV1 ? "v1" : "v2"} pool computeQuote == on-chain view @ ${dx}`);
    }
    console.log(`  [Euler discovery] ${isV1 ? "v1 (curve+getParams)" : "v2 (getDynamicParams)"} pool discovered + wei-exact vs on-chain view`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL EulerSwap solo [${engine}] — on-chain ladder, received == computeQuote(share) wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL EulerSwap + V3 [${engine}] — QL stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runEulerV3(engine);
    });
    it(`QL EulerSwap + QL Curve [${engine}] — two QL segKinds in one loop, interleave + split == oracle`, { skip }, async () => {
      await runEulerCurve(engine);
    });
    it(`QL EulerSwap zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL EulerSwap + V3 adverse drift [${engine}] — split RE-ANCHORS to the live drifted state`, { skip }, async () => {
      await runDriftSplit(engine);
    });
    it(`QL EulerSwap vault-cap [${engine}] — ladder self-truncates, award bounded, NO exec revert (DoS fixed)`, { skip }, async () => {
      await runVaultCap(engine);
    });
  }

  // Discovery is a read path (engine-independent) — run once per version, not per-engine.
  it("EulerSwap discovery — v1 pool detected via curve()+getParams(), wei-exact descriptor", async () => {
    await runDiscovery(true);
  });
  it("EulerSwap discovery — v2 pool detected via getDynamicParams(), wei-exact descriptor (coexists with v1)", async () => {
    await runDiscovery(false);
  });
});
