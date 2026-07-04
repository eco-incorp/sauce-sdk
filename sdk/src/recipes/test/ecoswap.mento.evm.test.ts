/**
 * EcoSwap Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager stablecoin exchange) QUOTE-LADDER
 * (QL) local-EVM integration — the callback-free live-walk broker.getAmountOut ladder + the live re-anchor.
 *
 * Mento is migrated to the QUOTE-LADDER framework (the same one Curve / WOOFi / LB use): prepare ships ONLY
 * a descriptor [exchangeProvider, exchangeId, _, feePpm, segKind=13, refIdx] — NO off-chain sampled segments
 * — and the on-chain solver BUILDS each Mento venue's price ladder in setup from LIVE cook-time
 * `broker.getAmountOut(provider, exchangeId, tokenIn, tokenOut, xIn)` (PROBE-THEN-DECODE — getAmountOut can
 * revert on a misconfigured exchange). The chain-wide Broker is cfg[7]; the descriptor's exchangeProvider
 * (qd[0]) + exchangeId (qd[1]) travel into the merged stream as msVen + msAux so the segKind-13 accumulator/
 * exec key the venue by (provider, exchangeId). Execution is UNCHANGED (callback-free: a live Broker
 * getAmountOut for the minOut + approve the BROKER + broker.swapIn — Mento PULLS via transferFrom into the
 * reserve). Then asserts:
 *
 *   (1) SOLO QL Mento — the on-chain ladder is built from live getAmountOut, covers [0, amountIn], and the
 *       caller-received dy == off-chain getAmountOut(share) == the Broker's own getAmountOut view, to the WEI.
 *   (2) QL Mento + a live V3 direct pool — the QL sampled-segment stream (bestKind 1) competes against the
 *       live V3 frontier (bestKind 3) in ONE merge; the per-venue split == the neutral oracle to the WEI.
 *   (3) QL Mento + QL Curve — TWO QL venues of DIFFERENT segKind (13 + 1) ride ONE qlv; the generalized
 *       ladder loop builds BOTH on-chain (dispatching per-row on segKind) and INTERLEAVES them; per-leg dy.
 *   (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared segments and returns the
 *       quote == getAmountOut(amountIn) to the wei. Proves the QL quote is prepare-optional.
 *   (5) ADVERSE DRIFT — move the bucket center price DOWN with setBuckets BEFORE cooking; the QL ladder reads
 *       the LIVE (moved) bucket state via getAmountOut at cook time and RE-ANCHORS (the Mento↔V3 split
 *       ADAPTS — the drifted Mento share SHRINKS, V3's grows), landing the DRIFTED split + exec at the live
 *       moved bucket state. This is the live-walk proof: no baked snapshot.
 *
 * No fork / no RPC env — a local fixture etches the whole stack. Runs on v1 (+ v12 when the v12 artifacts are
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
  deployMento,
  mentoBrokerAbi,
  deployCurveStableSwap,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { buildMentoQLLadder, mentoQuoteClosed, type MentoPool, type MentoClosedModel } from "../shared/mento-math";
import { getDy, type CurvePool } from "../shared/curve-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const RATE = E18; // par oracle rate both sides
const CENTER = E18; // 1:1 center price
const SPREAD_PPM = 100n; // 0.01% swap spread (1e6-scaled)
const ENGINE_CELLS = engineCells();

// Mento-only treeshake defines (HAS_MENTO lights the on-chain QL ladder build's Mento quote branch + the
// segKind-13 accumulator + the callback-free approve+swapIn exec; the live V3 frontier + merge core are
// unguarded so a mixed Mento+V3 universe still walks V3 with HAS_MENTO alone). Mirrors index.ts.
const MENTO_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: true, HAS_BALANCER_V3: false,
};
// Mento + Curve treeshake defines — BOTH QL adapter branches ship so the generalized qlv loop builds a
// segKind-13 (Mento) and a segKind-1 (Curve) ladder in one pass.
const MENTO_CURVE_DEFINES: Record<string, boolean> = { ...MENTO_DEFINES, HAS_CURVE: true, HAS_MENTO: true };

// The solver's 6 compiler args (index.ts order): cfg, pools, netCache, routing, segs, qlv. cfg[6] is the
// chain-wide Fluid resolver (0 — no Fluid), cfg[7] the chain-wide Mento Broker (the QL getAmountOut + exec
// swapIn target).
function args(
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  broker: Hex,
  directCount: number,
  pools: bigint[][],
  qlv: bigint[][],
): unknown[] {
  return [
    [BigInt(tokenIn), BigInt(tokenOut), amountIn, BigInt(caller), MIN_SQRT_RATIO + 1n, BigInt(directCount), 0n, BigInt(broker)],
    pools,
    [], // netCache
    [], // routing
    [], // segs — no static (non-QL) sampled venues in this universe
    qlv,
  ];
}

// One QL Mento descriptor: [exchangeProvider, exchangeId, _, feePpm, segKind=13, refIdx]. qd[0]=provider,
// qd[1]=exchangeId (bytes32 as uint256, intact). feePpm is informational (getAmountOut is post-spread).
function mentoDescriptor(provider: Hex, exchangeId: Hex, refIdx: number, feePpm: number): bigint[] {
  return [BigInt(provider), BigInt(exchangeId), 0n, BigInt(feePpm), 13n, BigInt(refIdx)];
}

function curveDescriptor(pool: Hex, refIdx: number, feePpm10: bigint): bigint[] {
  return [BigInt(pool), 0n, 1n, feePpm10, 1n, BigInt(refIdx)];
}

function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, BigInt(pool), BigInt(feePpm), BigInt(tickSpacing), 0n, BigInt(feePpm), 0n,
    inIsToken0 ? 1n : 0n, 0n, 0n, getSqrtRatioAtTick(tickSpacing), 0n, 0n, 0n, 0n, 0n, 0n,
  ];
}

describe("EcoSwap Mento V2 QL live-walk (local fixture) — on-chain getAmountOut ladder, exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the Mento asset0 (asset0 → asset1)
  let tokenOut: Hex; // == the Mento asset1
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

  // The CLOSED bucket model matching the deployed fixture's _netOut, for the neutral oracle's QL ladder
  // (mentoQuoteClosed == the live Broker view bit-for-bit ⇒ oracle == solver wei-exact). tokenIn == asset0.
  function closed(spreadPpm: bigint, depth: bigint, center: bigint): MentoClosedModel {
    return { zeroForOne: true, rate0: RATE, rate1: RATE, centerPrice: center, spreadPpm, depth, outCap: 0n };
  }
  function offMento(broker: Hex, provider: Hex, exchangeId: Hex, m: MentoClosedModel): MentoPool {
    return {
      broker, exchangeProvider: provider, exchangeId, tokenIn, tokenOut, cumIn: [], cumOut: [],
      feePpm: Number(m.spreadPpm), closed: m, source: "local-fixture",
    };
  }

  async function deploy(center: bigint, res0: bigint, res1: bigint, depth: bigint, minter: Account): Promise<{ broker: Hex; provider: Hex; exchangeId: Hex }> {
    return deployMento(c.walletClient, c.publicClient, tokenIn, tokenOut, RATE, RATE, center, SPREAD_PPM, res0, res1, depth, minter);
  }

  // The Broker's own on-chain getAmountOut view — the engine-independent ground truth for the executed dy.
  async function onQuery(broker: Hex, provider: Hex, exchangeId: Hex, amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: broker, abi: mentoBrokerAbi as Abi, functionName: "getAmountOut", args: [provider, exchangeId, tokenIn, tokenOut, amt],
    })) as bigint;
  }

  function offCurvePool(address: Hex, balances: bigint[], a: bigint, fee: bigint): CurvePool {
    return { poolType: 3, address, i: 0, j: 1, A: a, aPrecision: 100n, balances, rates: [E18, E18], feePpm10: fee, source: "local-fixture" };
  }

  // ── (1) SOLO QL Mento — received == getAmountOut(share) == on-chain view to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const DEPTH = 20_000_000n * E18; // deep ⇒ the QL ladder covers the whole trade
    const { broker, provider, exchangeId } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);
    const op = offMento(broker, provider, exchangeId, closed(SPREAD_PPM, DEPTH, CENTER));

    const amountIn = 100_000n * E18;
    const ladder = buildMentoQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL Mento ladder");
    assert.equal(ladder.reduce((a, s) => a + s.capacity, 0n), amountIn, "QL Mento ladder covers the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, broker, 0, [], [mentoDescriptor(provider, exchangeId, 0, Number(SPREAD_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: MENTO_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const brokerInBefore = await balanceOf(c.publicClient, tokenIn, broker);
    const onViewPre = await onQuery(broker, provider, exchangeId, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL Mento cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const brokerIn = (await balanceOf(c.publicClient, tokenIn, broker)) - brokerInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL Mento venue)");
    assert.equal(brokerIn, amountIn, "the Broker received the full input share (approve + pull)");
    assert.equal(received, mentoQuoteClosed(op.closed!, spent), "received == getAmountOut(share) closed model to the wei");
    assert.equal(received, onViewPre, "received == on-chain getAmountOut view to the wei (exact-in-dy)");
    assert.ok(received > 0n, "non-zero Mento fill through the callback-free approve+swapIn path");
    // RESIDUE SWEEP (the Metric USDT-class lesson): Broker.transferIn pulls EXACTLY amountIn via
    // safeTransferFrom on BOTH branches (verified mento-core Broker.sol) — pull == approve, so no
    // Broker allowance residue survives on the shared cooking contract.
    const residue = (await c.publicClient.readContract({
      address: tokenIn, abi: parseAbi(["function allowance(address, address) view returns (uint256)"]) as Abi,
      functionName: "allowance", args: [target, broker],
    })) as bigint;
    assert.equal(residue, 0n, "no Broker allowance residue (pull == approve)");

    console.log(
      `  [QL Mento solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== getAmountOut == on-chain view to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) QL Mento + a live V3 direct pool — bestKind 1 vs 3 in ONE merge; split == oracle wei-exact ──
  async function runMentoV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A shallower Mento (depth 2M ⇒ its quadratic slippage steepens sooner) vs a DEEP 1:1 V3 pool, sized so
    // the two marginal curves CROSS inside [0, amountIn] and BOTH venues receive input.
    const DEPTH = 2_000_000n * E18;
    const { broker, provider, exchangeId } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);
    const op = offMento(broker, provider, exchangeId, closed(SPREAD_PPM, DEPTH, CENTER));

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const amountIn = 100_000n * E18;
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({
      pools: [v3Opt, { mento: op, feePpm: 0 }],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oMento = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oMento > 0n, `oracle splits across V3 + Mento (V3 ${oV3}, Mento ${oMento})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [mentoDescriptor(provider, exchangeId, 0, Number(SPREAD_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, broker, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: MENTO_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const mentoInBefore = await balanceOf(c.publicClient, tokenIn, broker);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "Mento+V3 cook() must succeed");

    const mentoIn = (await balanceOf(c.publicClient, tokenIn, broker)) - mentoInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(mentoIn > 0n && v3In > 0n, `both venues funded (Mento ${mentoIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(mentoIn, oMento, "Mento awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL Mento+V3:${engine}] V3 in=${v3In} Mento in=${mentoIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) QL Mento + QL Curve — TWO QL venues of DIFFERENT segKind (13 + 1) in ONE qlv; per-leg exact-in-dy. ──
  async function runMentoCurve(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A mid-depth Curve (A=200, 0.02% fee) vs a deep-ish Mento (depth 3M) at a slightly wider spread — the
    // two marginal curves CROSS inside the trade, so BOTH QL venues fund and INTERLEAVE in the merged sort.
    const curveBal = [50_000n * E18, 50_000n * E18];
    const CURVE_A = 200n, CURVE_FEE = 2_000_000n; // 0.02% (1e10-scaled)
    const curve = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], curveBal, [E18, E18], CURVE_A, CURVE_FEE, caller);
    const opCurve = offCurvePool(curve, curveBal, CURVE_A, CURVE_FEE);

    const DEPTH = 3_000_000n * E18;
    const { broker, provider, exchangeId } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);
    const opMento = offMento(broker, provider, exchangeId, closed(SPREAD_PPM, DEPTH, CENTER));

    const amountIn = 50_000n * E18;
    const oracle = optimalSplit({ pools: [{ curve: opCurve, feePpm: 0 }, { mento: opMento, feePpm: 0 }], amountIn, zeroForOne: true });
    const oCurve = oracle.perPoolInput[0] ?? 0n;
    const oMento = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oCurve > 0n && oMento > 0n, `oracle splits across QL Curve + QL Mento (Curve ${oCurve}, Mento ${oMento})`);

    const qlv = [curveDescriptor(curve, 0, CURVE_FEE), mentoDescriptor(provider, exchangeId, 0, Number(SPREAD_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, broker, 0, [], qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: MENTO_CURVE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const curveInBefore = await balanceOf(c.publicClient, tokenIn, curve);
    const mentoInBefore = await balanceOf(c.publicClient, tokenIn, broker);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "QL Mento + QL Curve cook() must succeed");

    const curveIn = (await balanceOf(c.publicClient, tokenIn, curve)) - curveInBefore;
    const mentoIn = (await balanceOf(c.publicClient, tokenIn, broker)) - mentoInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(curveIn > 0n && mentoIn > 0n, `both QL venues funded (Curve ${curveIn}, Mento ${mentoIn})`);
    assert.equal(curveIn, oCurve, "Curve awarded input == oracle (wei-exact split)");
    assert.equal(mentoIn, oMento, "Mento awarded input == oracle (wei-exact split)");
    // PER-LEG WEI-EXACT: received == get_dy_Curve(curveIn) + getAmountOut_Mento(mentoIn). NO tolerance.
    assert.equal(received, getDy(opCurve, curveIn) + mentoQuoteClosed(opMento.closed!, mentoIn), "received == Σ per-venue view(share) to the wei");

    console.log(
      `  [QL Curve+Mento:${engine}] Curve in=${curveIn} Mento in=${mentoIn} received=${received} ` +
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

    const DEPTH = 20_000_000n * E18;
    const { broker, provider, exchangeId } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);

    const amountIn = 100_000n * E18;
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, broker, 0, [], [mentoDescriptor(provider, exchangeId, 0, Number(SPREAD_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: MENTO_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);
    const onView = await onQuery(broker, provider, exchangeId, amountIn);

    assert.equal(quoted, onView, "zero-cache QUOTE == on-chain getAmountOut(amountIn) to the wei (ladder built live in the eth_call)");
    console.log(`  [QL Mento zero-cache quote:${engine}] quoted=${quoted} (== getAmountOut(amountIn), no prepared cache)`);
  }

  // ── (5) ADVERSE DRIFT — move the bucket center price DOWN with setBuckets BEFORE cooking. Because the QL
  // ladder is built from LIVE getAmountOut at cook time (no baked snapshot), it RE-ANCHORS to the moved
  // buckets: a lower center price ⇒ fewer quote out ⇒ the Mento venue is less attractive, so the Mento↔V3
  // split ADAPTS (the Mento share SHRINKS, V3's grows). ──
  async function runAdverseDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const DEPTH = 2_000_000n * E18;
    const { broker, provider, exchangeId } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);

    const amountIn = 100_000n * E18;
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [mentoDescriptor(provider, exchangeId, 0, Number(SPREAD_PPM))];
    // Bytecode built against the PRE-drift universe — the descriptor carries NO bucket state, so the SAME
    // bytecode is cooked after the bucket move; only the LIVE getAmountOut the ladder reads changes.
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, broker, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: MENTO_DEFINES },
    );

    // Baseline (NO drift) oracle split — the Mento share the un-moved buckets would award.
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const opPre = offMento(broker, provider, exchangeId, closed(SPREAD_PPM, DEPTH, CENTER));
    const oraclePre = optimalSplit({ pools: [v3Opt, { mento: opPre, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const mentoSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(mentoSharePre > 0n, "baseline oracle awards the Mento venue a share");

    // ADVERSE DRIFT: re-center to a LOWER asset1-per-asset0 price (−2%) ⇒ each unit sells for fewer out ⇒
    // the Mento venue prices WORSE. The QL ladder re-reads this LIVE via getAmountOut.
    const movedCenter = (CENTER * 980n) / 1000n;
    const setHash = await c.walletClient.writeContract({
      address: broker, abi: mentoBrokerAbi as Abi, functionName: "setBuckets",
      args: [provider, exchangeId, RATE, RATE, movedCenter], account: caller, chain: c.walletClient.chain,
    });
    await c.publicClient.waitForTransactionReceipt({ hash: setHash });
    const opDrift = offMento(broker, provider, exchangeId, closed(SPREAD_PPM, DEPTH, movedCenter));
    const oracleDrift = optimalSplit({ pools: [v3Opt, { mento: opDrift, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const mentoShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(mentoShareDrift > 0n, "drifted oracle still awards the Mento venue a (smaller) share");
    assert.ok(mentoShareDrift < mentoSharePre, `adverse drift shrinks the Mento share (${mentoShareDrift} < ${mentoSharePre})`);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const mentoInBefore = await balanceOf(c.publicClient, tokenIn, broker);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "adverse-drift Mento+V3 cook() must succeed");

    const mentoIn = (await balanceOf(c.publicClient, tokenIn, broker)) - mentoInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(mentoIn > 0n && v3In > 0n, "both venues funded post-drift");
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(mentoIn, mentoShareDrift, "Mento awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(mentoIn < mentoSharePre, `Mento share ADAPTED down after adverse drift (${mentoIn} < baseline ${mentoSharePre})`);
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(
      `  [QL Mento+V3 adverse-drift:${engine}] baseline Mento share=${mentoSharePre} → drifted=${mentoIn} ` +
        `(V3 grew to ${v3In}); received=${received} (split RE-ANCHORED to live moved buckets)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL Mento solo [${engine}] — on-chain ladder, received == getAmountOut(share) wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL Mento + V3 [${engine}] — sampled stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runMentoV3(engine);
    });
    it(`QL Mento + QL Curve [${engine}] — two QL segKinds in one loop, interleave + split == oracle`, { skip }, async () => {
      await runMentoCurve(engine);
    });
    it(`QL Mento zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL Mento + V3 adverse-drift [${engine}] — split RE-ANCHORS to the live moved buckets`, { skip }, async () => {
      await runAdverseDriftSplit(engine);
    });
  }
});
