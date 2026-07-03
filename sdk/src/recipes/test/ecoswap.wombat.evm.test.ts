/**
 * EcoSwap Wombat (single-sided stableswap) QUOTE-LADDER (QL) local-EVM integration — the live-walk
 * quotePotentialSwap ladder + the callback-free exact-in-dy gate.
 *
 * Wombat is migrated to the QUOTE-LADDER framework (the same one Curve / LB / WOOFi / DODO / Fermi use):
 * prepare ships ONLY a descriptor [pool, _, _, feePpm, segKind=5, refIdx] — NO off-chain sampled coverage-
 * ratio segments — and the on-chain solver BUILDS each Wombat venue's price ladder in setup from LIVE
 * cook-time `quotePotentialSwap(tokenIn, tokenOut, xNext)[0]` (the post-haircut out; PROBE-THEN-DECODE, as
 * it reverts on CASH_NOT_ENOUGH / a paused asset). EXEC is UNCHANGED: callback-free — an on-chain
 * quotePotentialSwap staticcall for the minOut + approve + `pool.swap(...)` (Wombat PULLS via transferFrom).
 *
 *   (1) SOLO QL Wombat — the on-chain ladder is built from live quotePotentialSwap, covers [0, amountIn]
 *       (pool deep enough), and the caller-received dy == off-chain quotePotentialSwap(share) == the pool's
 *       own quotePotentialSwap view, all to the WEI.
 *   (2) QL Wombat + a live V3 direct pool — the QL sampled-segment stream (bestKind 1) competes against the
 *       live V3 frontier (bestKind 3) in ONE merge; the per-venue split == the neutral oracle to the WEI.
 *   (3) QL Wombat + QL Curve — TWO QL venues of DIFFERENT segKind (5 + 1) ride ONE qlv; the generalized
 *       ladder loop builds BOTH on-chain and INTERLEAVES them; per-leg exact-in-dy.
 *   (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared segments and returns the
 *       quote == quotePotentialSwap(amountIn) to the wei. Proves the QL quote is prepare-optional.
 *   (5) ADVERSE DRIFT — drain the pool's to-asset with a REAL swap BEFORE cooking the pre-drift bytecode;
 *       the QL ladder reads the LIVE (drifted) quotePotentialSwap at cook time and the Wombat↔V3 split
 *       RE-ANCHORS (the Wombat share shrinks, V3's grows) to the drifted oracle, wei-exact.
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
  deployWombatPool,
  wombatPoolAbi,
  deployCurveStableSwap,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { quotePotentialSwap, buildWombatQLLadder, type WombatPool } from "../shared/wombat-math";
import { getDy as curveGetDy, type CurvePool } from "../shared/curve-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const AMP = 2n * 10n ** 15n; // 0.002e18 = 0.2% (canonical Wombat main-pool amp)
const HC = 10n ** 14n; // 0.0001e18 = 0.01% haircut
const ENGINE_CELLS = engineCells();

// Wombat-only treeshake defines (HAS_WOMBAT lights the on-chain QL ladder build's Wombat quote branch +
// the segKind-5 accumulator + the callback-free exec; the live V3 frontier + merge core are unguarded).
const WOMBAT_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: true,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
};
// Wombat + Curve — BOTH QL adapter branches ship so the generalized qlv loop builds a segKind-5 (Wombat)
// and a segKind-1 (Curve StableSwap) ladder in one pass.
const WOMBAT_CURVE_DEFINES: Record<string, boolean> = { ...WOMBAT_DEFINES, HAS_CURVE: true, HAS_WOMBAT: true };

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

// One QL Wombat descriptor: [pool, _, _, feePpm, segKind=5, refIdx]. Wombat quotes by fromToken/toToken,
// so qd[1]/qd[2] are unused; feePpm is informational (quotePotentialSwap is post-haircut).
function wombatDescriptor(pool: Hex, refIdx: number, feePpm: number): bigint[] {
  return [BigInt(pool), 0n, 0n, BigInt(feePpm), 5n, BigInt(refIdx)];
}

// One QL Curve StableSwap descriptor: [poolAddr, i, j, feePpm10, segKind=1, refIdx].
function curveDescriptor(pool: Hex, refIdx: number, feePpm10: bigint): bigint[] {
  return [BigInt(pool), 0n, 1n, feePpm10, 1n, BigInt(refIdx)];
}

// A live V3 direct-pool tuple with windowTop=0 (no cache ⇒ the solver staticcalls ticks() from live spot).
function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, BigInt(pool), BigInt(feePpm), BigInt(tickSpacing), 0n, BigInt(feePpm), 0n,
    inIsToken0 ? 1n : 0n, 0n, 0n, getSqrtRatioAtTick(tickSpacing), 0n, 0n, 0n, 0n, 0n, 0n,
  ];
}

describe("EcoSwap Wombat QL live-walk (local fixture) — on-chain quotePotentialSwap ladder + callback-free exec", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == token0 (lower address)
  let tokenOut: Hex; // == token1
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

  // Off-chain WombatPool descriptor for the deployed fixture (tokenIn = token0, tokenOut = token1).
  function offPool(
    address: Hex, fromCash: bigint, fromLiability: bigint, toCash: bigint, toLiability: bigint,
    haircutRate: bigint = HC, feePpm: number = 100,
  ): WombatPool {
    return {
      address, fromCash, fromLiability, toCash, toLiability, ampFactor: AMP, haircutRate,
      decIn: E18, decOut: E18, tokenIn, tokenOut, feePpm, source: "local-fixture",
    };
  }

  // Reconstruct the WombatPool from the fixture's LIVE cash/liability — used after an adverse drift so the
  // oracle prices the SAME state the on-chain ladder reads at cook time.
  async function readOffPool(pool: Hex, base: WombatPool): Promise<WombatPool> {
    const [cash0, liab0, cash1, liab1] = (await Promise.all(
      ["cash0", "liability0", "cash1", "liability1"].map((fn) =>
        c.publicClient.readContract({ address: pool, abi: wombatPoolAbi as Abi, functionName: fn, args: [] }),
      ),
    )) as bigint[];
    // tokenIn == token0 ⇒ from = 0-side, to = 1-side.
    return { ...base, address: pool, fromCash: cash0, fromLiability: liab0, toCash: cash1, toLiability: liab1 };
  }

  // The fixture's own on-chain quotePotentialSwap view — the engine-independent ground truth. Returns [0].
  async function onQuote(pool: Hex, amt: bigint): Promise<bigint> {
    const r = (await c.publicClient.readContract({
      address: pool, abi: wombatPoolAbi as Abi, functionName: "quotePotentialSwap", args: [tokenIn, tokenOut, amt],
    })) as readonly [bigint, bigint];
    return r[0];
  }

  function offCurvePool(address: Hex, balances: bigint[], a: bigint, fee: bigint): CurvePool {
    return { poolType: 3, address, i: 0, j: 1, A: a, aPrecision: 100n, balances, rates: [E18, E18], feePpm10: fee, source: "local-fixture" };
  }

  // ── (1) SOLO QL Wombat — the on-chain ladder is built live; received == quotePotentialSwap(share) wei ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const cash = 1_000_000n * E18;
    const pool = await deployWombatPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18,
      cash, cash, cash, cash, AMP, HC, 0n, cash, caller,
    );
    const op = offPool(pool, cash, cash, cash, cash);

    const amountIn = 100_000n * E18;
    const ladder = buildWombatQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL Wombat ladder");
    const cover = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(cover, amountIn, "QL Wombat ladder covers the full amountIn (pool deep enough)");

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [wombatDescriptor(pool, 0, op.feePpm)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: WOMBAT_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const onViewPre = await onQuote(pool, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL Wombat cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL Wombat venue)");
    assert.equal(poolIn, amountIn, "the Wombat pool pulled the full input share (approve + pull)");
    assert.equal(received, quotePotentialSwap(op, spent), "received == quotePotentialSwap(share) to the wei");
    assert.equal(received, onViewPre, "received == on-chain quotePotentialSwap view to the wei");
    assert.ok(received > 0n, "non-zero Wombat fill through the callback-free approve+swap path");

    console.log(
      `  [QL Wombat solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== quotePotentialSwap to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) QL Wombat + a live V3 direct pool — split == oracle wei-exact ──
  async function runWombatV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A CHEAP Wombat (0.01% haircut, near-1:1) shallower than a DEEP 1:1 V3 (0.30% fee): the Wombat near
    // region fills, its marginal drops below V3's, V3 takes the deep tail — both fund.
    const cash = 100_000n * E18;
    const pool = await deployWombatPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18,
      cash, cash, cash, cash, AMP, HC, 0n, cash, caller,
    );
    const op = offPool(pool, cash, cash, cash, cash);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const amountIn = 80_000n * E18;
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({ pools: [v3Opt, { wombat: op, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oWom = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oWom > 0n, `oracle splits across V3 + Wombat (V3 ${oV3}, Wombat ${oWom})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [wombatDescriptor(pool, 0, op.feePpm)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: WOMBAT_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const womInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "Wombat+V3 cook() must succeed");

    const womIn = (await balanceOf(c.publicClient, tokenIn, pool)) - womInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(womIn > 0n && v3In > 0n, `both venues funded (Wombat ${womIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(womIn, oWom, "Wombat awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL Wombat+V3:${engine}] V3 in=${v3In} Wombat in=${womIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) QL Wombat + QL Curve — TWO QL venues of DIFFERENT segKind (5 + 1) in ONE qlv ──
  async function runWombatCurve(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A CHEAP shallow Wombat (draws first) vs a DEEP dearer Curve (takes the tail) — both fund, ladders
    // interleave in the merged DESC sort.
    const wCash = 80_000n * E18;
    const pool = await deployWombatPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18,
      wCash, wCash, wCash, wCash, AMP, 5n * 10n ** 13n, 0n, wCash, caller,
    );
    const opWom = offPool(pool, wCash, wCash, wCash, wCash, 5n * 10n ** 13n, 50);

    const curveBal = [200_000n * E18, 200_000n * E18];
    const CURVE_A = 200n, CURVE_FEE = 3_000_000n; // 0.03% (1e10-scaled)
    const curve = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], curveBal, [E18, E18], CURVE_A, CURVE_FEE, caller);
    const opCurve = offCurvePool(curve, curveBal, CURVE_A, CURVE_FEE);

    const amountIn = 50_000n * E18;
    const oracle = optimalSplit({ pools: [{ curve: opCurve, feePpm: 0 }, { wombat: opWom, feePpm: 0 }], amountIn, zeroForOne: true });
    const oCurve = oracle.perPoolInput[0] ?? 0n;
    const oWom = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oCurve > 0n && oWom > 0n, `oracle splits across QL Curve + QL Wombat (Curve ${oCurve}, Wombat ${oWom})`);

    const qlv = [curveDescriptor(curve, 0, CURVE_FEE), wombatDescriptor(pool, 0, opWom.feePpm)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: WOMBAT_CURVE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const curveInBefore = await balanceOf(c.publicClient, tokenIn, curve);
    const womInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "QL Wombat + QL Curve cook() must succeed");

    const curveIn = (await balanceOf(c.publicClient, tokenIn, curve)) - curveInBefore;
    const womIn = (await balanceOf(c.publicClient, tokenIn, pool)) - womInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(curveIn > 0n && womIn > 0n, `both QL venues funded (Curve ${curveIn}, Wombat ${womIn})`);
    assert.equal(curveIn, oCurve, "Curve awarded input == oracle (wei-exact split)");
    assert.equal(womIn, oWom, "Wombat awarded input == oracle (wei-exact split)");
    // PER-LEG WEI-EXACT: received == get_dy_Curve(curveIn) + quotePotentialSwap_Wombat(womIn). NO tolerance.
    assert.equal(received, curveGetDy(opCurve, curveIn) + quotePotentialSwap(opWom, womIn), "received == Σ per-venue view(share) to the wei");

    console.log(
      `  [QL Curve+Wombat:${engine}] Curve in=${curveIn} Wombat in=${womIn} received=${received} ` +
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

    const cash = 1_000_000n * E18;
    const pool = await deployWombatPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18,
      cash, cash, cash, cash, AMP, HC, 0n, cash, caller,
    );
    const op = offPool(pool, cash, cash, cash, cash);

    const amountIn = 100_000n * E18;
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [wombatDescriptor(pool, 0, op.feePpm)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: WOMBAT_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(quoted, quotePotentialSwap(op, amountIn), "zero-cache QUOTE == quotePotentialSwap(amountIn) to the wei (ladder built live in the eth_call)");
    console.log(`  [QL Wombat zero-cache quote:${engine}] quoted=${quoted} (== quotePotentialSwap(amountIn), no prepared cache)`);
  }

  // ── (5) ADVERSE DRIFT — drain the to-asset with a REAL swap BEFORE cooking; the live QL ladder re-anchors
  // the Wombat↔V3 split to the drifted state. The SAME bytecode is cooked after the drift. ──
  async function runDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const cash = 100_000n * E18;
    // Fund with EXTRA token1 so the drift swap + the recipe's Wombat share both pay out.
    const pool = await deployWombatPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18,
      cash, cash, cash, cash, AMP, HC, 0n, 2n * cash, caller,
    );
    const opPre = offPool(pool, cash, cash, cash, cash);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };

    const amountIn = 80_000n * E18;
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [wombatDescriptor(pool, 0, opPre.feePpm)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: WOMBAT_DEFINES },
    );

    const oraclePre = optimalSplit({ pools: [v3Opt, { wombat: opPre, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const womSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(womSharePre > 0n, "baseline oracle awards the Wombat venue a share");

    // ADVERSE DRIFT: a REAL swap of tokenIn INTO the Wombat drains its to-asset (a prior trade looks
    // exactly like this on-chain), collapsing its post-drift marginal.
    const driftAmt = 60_000n * E18;
    await approve(c.walletClient, c.publicClient, tokenIn, pool, driftAmt);
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: pool, abi: wombatPoolAbi as Abi, functionName: "swap",
        args: [tokenIn, tokenOut, driftAmt, 0n, caller, 2n ** 63n], account: caller, chain: c.walletClient.chain,
      }),
    });

    const opDrift = await readOffPool(pool, opPre);
    const oracleDrift = optimalSplit({ pools: [v3Opt, { wombat: opDrift, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const womShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(womShareDrift < womSharePre, `drift shrinks the Wombat share (${womShareDrift} < ${womSharePre})`);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const womInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drift cook() SUCCEEDS — Wombat ladder re-anchored to the live drifted state");

    const womIn = (await balanceOf(c.publicClient, tokenIn, pool)) - womInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(v3In > 0n, "V3 funded post-drift");
    assert.equal(womIn, womShareDrift, "Wombat awarded input == drifted oracle (re-anchored to the live drifted state)");
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(womIn < womSharePre, `Wombat share ADAPTED down after the drift (${womIn} < baseline ${womSharePre})`);
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(
      `  [QL Wombat+V3 drift:${engine}] baseline Wombat share=${womSharePre} → re-anchored=${womIn} ` +
        `(V3 grew to ${v3In}); spent=${spent} received=${received}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL Wombat solo [${engine}] — on-chain ladder, received == quotePotentialSwap(share) wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL Wombat + V3 [${engine}] — sampled stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runWombatV3(engine);
    });
    it(`QL Wombat + QL Curve [${engine}] — two QL segKinds in one loop, interleave + split == oracle`, { skip }, async () => {
      await runWombatCurve(engine);
    });
    it(`QL Wombat zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL Wombat + V3 adverse drift [${engine}] — split RE-ANCHORS to the live drifted state`, { skip }, async () => {
      await runDriftSplit(engine);
    });
  }
});
