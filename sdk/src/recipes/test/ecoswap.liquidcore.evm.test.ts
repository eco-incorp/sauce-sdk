/**
 * EcoSwap LIQUIDCORE (Liquid Labs, HyperEVM) QUOTE-LADDER (QL) local-EVM integration — the
 * PRECOMPILE-MOCK pattern (the pool prices off the HyperEVM BBO read precompile at its CANONICAL
 * 0x…080e address; the harness etches an input-keyed mock there — the exact pattern the real
 * HyperEVM integration needs), the probe-then-decode single-view ladder, and the callback-free
 * approve-POOL exec (pull == approve ALWAYS — the fork-proven real behavior).
 *
 * LiquidCore is a QUOTE-LADDER family (segKind 18): prepare ships ONLY a descriptor [pool, 0, 0,
 * feePpm, segKind=18, refIdx, 0…] — NO off-chain sampled ladder — and the on-chain solver builds
 * the venue's price ladder in setup from LIVE cook-time `pool.estimateSwap(tokenIn, tokenOut,
 * xNext)` (PROBE-THEN-DECODE — the REAL pool reverts on zero/unsupported inputs (0x1f2a2005 /
 * 0xc1ab6dc1) and returns 0 gracefully when drained; the fixture reproduces the classes). EXEC is
 * callback-free — live estimateSwap as minAmountOut, approve POOL, pool.swap (the pool pulls the
 * FULL input via transferFrom — pull == approve always, so residue == 0 by construction, asserted).
 *
 * The oracle prices LiquidCore via buildLiquidCoreQLLadder driven by a bit-exact TS replay of the
 * fixture's saturation curve, so oracle == solver to the WEI.
 *
 *   (1) SOLO QL LiquidCore — ladder built live off the etched BBO mock, covers [0, amountIn];
 *       received == estimateSwap(amountIn) == the TS replay, pulled == amountIn, residue == 0.
 *   (2) QL LiquidCore + a live V3 direct pool — split == the neutral oracle to the WEI.
 *   (3) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE, quote == estimateSwap(amountIn).
 *   (4) ADVERSE DRIFT via a BBO RE-POST — the book moves (setBbo at the CANONICAL precompile
 *       address) AFTER compile; the pre-drift bytecodes re-anchor (LiquidCore's share shrinks).
 *   (5) DRAINED POOL — zero output inventory quotes 0 gracefully: the venue self-drops, V3 absorbs,
 *       never a DoS.
 *   (6) OVERSIZE (the asymptotic cap) — the pool absorbs ANY input against a saturating output;
 *       pulled == the FULL award (pull == approve on oversize too — the fork-proven class),
 *       received == the capped quote, residue == 0.
 *   (7) DISCOVERY — discoverLiquidCorePoolsTyped resolves the pair's single pool via the fixture
 *       router's UNORDERED getPoolForPair (both orders), drops a drained pool, and never needs
 *       getPools (the zero-entry list is enumerated for diagnostics only).
 *
 * No fork / no RPC env — local fixtures deploy the whole stack. Runs on v1 (+ v12 when present),
 * driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil. Mirrors ecoswap.metric.evm.test.ts.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseEther,
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
  createAndInitPool,
  mintPosition,
  getSlot0,
  getLiquidity,
  mint,
  approve,
  balanceOf,
  deployLiquidCoreStack,
  liquidCorePoolFixtureAbi,
  liquidCoreRouterFixtureAbi,
  hlBboMockAbi,
  HL_BBO_ADDRESS,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO, SwapPoolType, FactoryType, type FactoryConfig } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { buildLiquidCoreQLLadder, type LiquidCorePool } from "../shared/liquidcore-math";
import { discoverLiquidCorePoolsTyped } from "../shared/pool-discovery";

const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const SCALE = 10n ** 6n;
const FEE_PPM = 500n; // 0.05% netted off the gross out
// The two spot-pair indexes the pool crosses (mirrors the real WHYPE/USDT0 pool reading 10107 +
// 10166 — one book per token, crossed via the shared numeraire).
const IDX0 = 10107n;
const IDX1 = 10166n;
// Near-1:1 books with a small spread (values are raw book integers; only the ratio matters).
const BID0 = 99_900_000n;
const ASK0 = 100_100_000n;
const BID1 = 99_950_000n;
const ASK1 = 100_050_000n;
const ENGINE_CELLS = engineCells();

// LiquidCore-only treeshake defines (HAS_LIQUIDCORE lights the qKind-18 ladder branch + the
// segKind-18 accumulator + the callback-free exec; the live V3 frontier + merge core are unguarded).
const LC_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
  HAS_TESSERA: false, HAS_ELFOMO: false, HAS_METRIC: false, HAS_LIQUIDCORE: true, HAS_SIZE: false,
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

// One QL LiquidCore descriptor row — the production 12-column shape (index.ts qlRowFor + pad12):
// [pool, 0, 0, feePpm, 18, refIdx, 0, 0, 0, 0, 0, 0] (the quote keys on the edge tokens).
function lcDescriptor(pool: Hex, refIdx: number, feePpm: number): bigint[] {
  return [BigInt(pool), 0n, 0n, BigInt(feePpm), 18n, BigInt(refIdx), 0n, 0n, 0n, 0n, 0n, 0n];
}

function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, BigInt(pool), BigInt(feePpm), BigInt(tickSpacing), 0n, BigInt(feePpm), 0n,
    inIsToken0 ? 1n : 0n, 0n, 0n, getSqrtRatioAtTick(tickSpacing), 0n, 0n, 0n, 0n, 0n, 0n,
  ];
}

// Bit-exact TS replay of the fixture's quote (LiquidCorePool.sol _quote): linear cross at
// bidIn/askOut, hyperbolic saturation on the OUT inventory, fee netted off the gross — the `getDy`
// quote model buildLiquidCoreQLLadder consumes. The REAL view REVERTS on zero/unsupported and
// returns 0 when drained — the model returns 0 for all those classes (probe-then-decode lockstep).
function lcGetDy(bidIn: bigint, askOut: bigint, availOut: bigint): (dx: bigint) => bigint {
  return (dx: bigint): bigint => {
    if (dx <= 0n) return 0n;
    const linear = (dx * bidIn) / askOut;
    if (availOut === 0n || linear === 0n) return 0n;
    const gross = (linear * availOut) / (linear + availOut);
    return (gross * (SCALE - FEE_PPM)) / SCALE;
  };
}

describe("EcoSwap LIQUIDCORE QL live-walk (local fixture) — BBO-precompile-mock pricing + probe-then-decode ladder + callback-free pool exec", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let token0: Hex;
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

  async function deploy(reserve0: bigint, reserve1: bigint): Promise<{ pool: Hex; router: Hex; bbo: Hex }> {
    return deployLiquidCoreStack(
      c.walletClient, c.publicClient, c.testClient,
      token0, token1, IDX0, IDX1, BID0, ASK0, BID1, ASK1, FEE_PPM, reserve0, reserve1,
      c.walletClient.account as Account,
    );
  }

  const allowanceAbi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);
  async function allowanceOf(token: Hex, owner: Hex, spender: Hex): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: token, abi: allowanceAbi as Abi, functionName: "allowance", args: [owner, spender],
    })) as bigint;
  }

  /** The pool's own LIVE quote — the engine-independent ground truth. */
  async function onQuote(pool: Hex, tin: Hex, tout: Hex, amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: pool, abi: liquidCorePoolFixtureAbi as Abi, functionName: "estimateSwap", args: [tin, tout, amt],
    })) as bigint;
  }

  // Off-chain LiquidCorePool model — the bit-exact saturation-curve replay (NO RPC).
  function offPool(m: { pool: Hex; router: Hex }, availOut: bigint, forward: boolean): LiquidCorePool {
    return {
      address: m.pool,
      router: m.router,
      tokenIn: forward ? token0 : token1,
      tokenOut: forward ? token1 : token0,
      feePpm: Number(FEE_PPM),
      source: "local-fixture",
      getDy: forward ? lcGetDy(BID0, ASK1, availOut) : lcGetDy(BID1, ASK0, availOut),
    };
  }

  // ── (1) SOLO — ladder off the etched BBO mock; received == estimateSwap wei-exact; residue 0 ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const RES = 200_000n * E18;
    const m = await deploy(RES, RES);
    const amountIn = 50_000n * E18;
    const op = offPool(m, RES, true);
    const ladder = buildLiquidCoreQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL LiquidCore ladder");
    assert.equal(
      ladder.reduce((a, s) => a + s.capacity, 0n), amountIn,
      "ladder covers the full amountIn (strictly-convex saturation curve — no early stop)",
    );

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [lcDescriptor(m.pool, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: LC_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const poolInBefore = await balanceOf(c.publicClient, token0, m.pool);
    const onViewPre = await onQuote(m.pool, token0, token1, amountIn);
    assert.equal(onViewPre, op.getDy(amountIn), "TS saturation model == the pool estimateSwap view (bit-exact)");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL LiquidCore cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, token0, m.pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL LiquidCore venue)");
    assert.equal(poolIn, amountIn, "the pool pulled the FULL input (pull == approve — the fork-proven class)");
    assert.equal(received, onViewPre, "received == pool estimateSwap at the live BBO to the wei");
    assert.equal(
      await allowanceOf(token0, target, m.pool), 0n,
      "no pool allowance residue (pull == approve always — no reset needed, asserted anyway)",
    );
    console.log(
      `  [QL LiquidCore solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== estimateSwap to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) QL LiquidCore + a live V3 direct pool — split == oracle wei-exact ──
  async function runLcV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const RES = 200_000n * E18;
    const m = await deploy(RES, RES);
    const amountIn = 100_000n * E18;
    const op = offPool(m, RES, true);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({ pools: [v3Opt, { liquidcore: op, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oLc = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oLc > 0n, `oracle splits across V3 + LiquidCore (V3 ${oV3}, LC ${oLc})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [lcDescriptor(m.pool, 0, Number(FEE_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: LC_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const lcInBefore = await balanceOf(c.publicClient, token0, m.pool);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "LiquidCore+V3 cook() must succeed");

    const lcIn = (await balanceOf(c.publicClient, token0, m.pool)) - lcInBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.ok(lcIn > 0n && v3In > 0n, `both venues funded (LC ${lcIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(lcIn, oLc, "LiquidCore awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL LiquidCore+V3:${engine}] V3 in=${v3In} LC in=${lcIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) ZERO-CACHE QUOTE ──
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

    const RES = 200_000n * E18;
    const m = await deploy(RES, RES);
    const amountIn = 50_000n * E18;

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [lcDescriptor(m.pool, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: LC_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(
      quoted, await onQuote(m.pool, token0, token1, amountIn),
      "zero-cache QUOTE == estimateSwap(amountIn) to the wei (ladder built live in the eth_call)",
    );
    console.log(`  [QL LiquidCore zero-cache quote:${engine}] quoted=${quoted} (== estimateSwap, no prepared cache)`);
  }

  // ── (4) ADVERSE DRIFT via a BBO RE-POST at the canonical precompile address — SAME bytecode ──
  async function runDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // DEEP reserves flatten the saturation curve so the baseline LiquidCore share spans several
    // slices — the 3% book re-post then visibly shrinks it (a 200k-deep pool at this size is so
    // curved the award is already the single first slice pre-drift, masking the re-anchor).
    const RES = 2_000_000n * E18;
    const m = await deploy(RES, RES);
    const amountIn = 100_000n * E18;

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [lcDescriptor(m.pool, 0, Number(FEE_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: LC_DEFINES },
    );

    const oraclePre = optimalSplit({ pools: [v3Opt, { liquidcore: offPool(m, RES, true), feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const lcSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(lcSharePre > 0n, "baseline oracle awards the LiquidCore venue a share");

    // ADVERSE DRIFT: the tokenIn book re-posts 3% lower (the Hyperliquid book moved — the
    // oracle-priced class re-anchors instantly). setBbo at the CANONICAL precompile address.
    const BID0_DRIFT = (BID0 * 970n) / 1000n;
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: HL_BBO_ADDRESS, abi: hlBboMockAbi as Abi, functionName: "setBbo",
        args: [IDX0, BID0_DRIFT, ASK0], account: c.walletClient.account as Account, chain: c.walletClient.chain,
      }),
    });

    const opDrift: LiquidCorePool = { ...offPool(m, RES, true), getDy: lcGetDy(BID0_DRIFT, ASK1, RES) };
    const oracleDrift = optimalSplit({ pools: [v3Opt, { liquidcore: opDrift, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const lcShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(lcShareDrift < lcSharePre, `drift shrinks the LiquidCore share (${lcShareDrift} < ${lcSharePre})`);

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const lcInBefore = await balanceOf(c.publicClient, token0, m.pool);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drift cook() SUCCEEDS — the ladder re-read the live (worse) book");

    const lcIn = (await balanceOf(c.publicClient, token0, m.pool)) - lcInBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.ok(v3In > 0n, "V3 funded post-drift");
    assert.equal(lcIn, lcShareDrift, "LiquidCore awarded input == drifted oracle (re-anchored to the re-posted book)");
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(lcIn < lcSharePre, `LiquidCore share ADAPTED down after the book re-post (${lcIn} < baseline ${lcSharePre})`);
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(
      `  [QL LiquidCore+V3 BBO-drift:${engine}] baseline LC share=${lcSharePre} → re-anchored=${lcIn} ` +
        `(V3 grew to ${v3In}); spent=${spent} received=${received}`,
    );
  }

  // ── (5) DRAINED POOL — zero output inventory quotes 0 gracefully; the venue self-drops ──
  async function runDrained(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const m = await deploy(200_000n * E18, 0n); // ZERO token1 inventory — the drained class
    const amountIn = 20_000n * E18;

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));

    assert.equal(await onQuote(m.pool, token0, token1, amountIn), 0n, "a DRAINED pool quotes 0 GRACEFULLY (the probed class)");

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [lcDescriptor(m.pool, 0, Number(FEE_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: LC_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const lcInBefore = await balanceOf(c.publicClient, token0, m.pool);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drained-pool cook() SUCCEEDS (probe-then-decode — never a DoS)");

    const lcIn = (await balanceOf(c.publicClient, token0, m.pool)) - lcInBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.equal(lcIn, 0n, "the DRAINED LiquidCore venue received 0 (zero ladder — self-dropped)");
    assert.equal(v3In, spent, "the whole spent input landed on V3");
    assert.equal(spent, amountIn, "the trade still fills in full (V3 absorbs it)");
    assert.ok(received > 0n, "caller receives tokenOut via V3");

    console.log(`  [QL LiquidCore drained:${engine}] LC=0 V3=${v3In} received=${received} (venue self-dropped, no DoS)`);
  }

  // ── (6) OVERSIZE — the asymptotic cap: the pool pulls the FULL award against a saturating out ──
  async function runOversize(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const RES_OUT = 1_000n * E18; // thin OUT inventory — the saturation cap bites hard
    const m = await deploy(E18, RES_OUT);
    const amountIn = 100_000n * E18; // ≫ the saturation knee
    const op = offPool(m, RES_OUT, true);
    const ladder = buildLiquidCoreQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty oversize ladder");
    assert.equal(
      ladder.reduce((a, s) => a + s.capacity, 0n), amountIn,
      "the saturation curve never flatlines to zero slice-out at these sizes — the ladder covers amountIn",
    );

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [lcDescriptor(m.pool, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: LC_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const poolInBefore = await balanceOf(c.publicClient, token0, m.pool);
    const onViewPre = await onQuote(m.pool, token0, token1, amountIn);
    assert.ok(onViewPre < RES_OUT, "the oversize quote is CAPPED below the inventory (graceful — the probed class)");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "oversize cook() must succeed (graceful capped quote, full pull)");

    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, token0, m.pool)) - poolInBefore;

    assert.equal(spent, amountIn, "net spent == the full award (the pool pulls 100% of the input on oversize)");
    assert.equal(poolIn, amountIn, "pulled == approved == amountIn (the fork-proven pull==approve class)");
    assert.equal(received, onViewPre, "received == the capped estimateSwap quote to the wei");
    assert.equal(
      await allowanceOf(token0, target, m.pool), 0n,
      "allowance residue == 0 after the oversize pull (pull == approve — no residue path)",
    );
    console.log(
      `  [QL LiquidCore oversize:${engine}] awarded=${amountIn} pulled=${poolIn} received=${received} ` +
        `(capped quote; residue 0)`,
    );
  }

  // ── (7) DISCOVERY — the typed discovery path against the fixture router (no cook) ──
  async function runDiscovery(): Promise<void> {
    await setup();
    const RES = 200_000n * E18;
    const m = await deploy(RES, RES);
    const client = createPublicClient({ transport: http(anvil.rpcUrl) });
    const cfg: FactoryConfig = {
      address: m.router, poolType: SwapPoolType.UniV2, factoryType: FactoryType.LiquidCore, label: "Local LiquidCore",
    };
    const amountIn = 50_000n * E18;

    // Forward: resolves the pair's single pool.
    const fwd = await discoverLiquidCorePoolsTyped(token0, token1, client as never, [cfg], amountIn);
    assert.equal(fwd.length, 1, "discovery surfaces the pair's single pool");
    assert.equal(fwd[0].address.toLowerCase(), m.pool.toLowerCase(), "the discovered pool IS the fixture pool");
    assert.equal(fwd[0].router.toLowerCase(), m.router.toLowerCase(), "the descriptor carries the enumerating router");

    // Reverse-argument order resolves the SAME pool (the unordered getPoolForPair — probed on the
    // real router).
    const rev = await discoverLiquidCorePoolsTyped(token1, token0, client as never, [cfg], amountIn);
    assert.equal(rev.length, 1, "reverse-order discovery also resolves");
    assert.equal(rev[0].address.toLowerCase(), m.pool.toLowerCase(), "getPoolForPair is UNORDERED (both orders, one pool)");

    // An unknown pair yields nothing (getPoolForPair → 0).
    const none = await discoverLiquidCorePoolsTyped(token0, m.router, client as never, [cfg], amountIn);
    assert.equal(none.length, 0, "an unknown pair discovers nothing (zero pool address)");

    // The real router's getPools list carries a zero entry — the fixture reproduces it (diagnostic
    // enumeration only; discovery never consumes getPools).
    const pools = (await client.readContract({
      address: m.router, abi: liquidCoreRouterFixtureAbi as Abi, functionName: "getPools",
    })) as Hex[];
    assert.equal(pools.length, 2, "getPools enumerates registered entries");
    assert.equal(BigInt(pools[0]), 0n, "the real list's ZERO entry is reproduced (consumers must filter)");

    // A DRAINED pool is dropped by the liveness probe.
    const drained = await deployLiquidCoreStack(
      c.walletClient, c.publicClient, c.testClient,
      token0, token1, IDX0, IDX1, BID0, ASK0, BID1, ASK1, FEE_PPM, RES, 0n,
      c.walletClient.account as Account,
    );
    const cfgDrained: FactoryConfig = {
      address: drained.router, poolType: SwapPoolType.UniV2, factoryType: FactoryType.LiquidCore, label: "Drained LiquidCore",
    };
    const dr = await discoverLiquidCorePoolsTyped(token0, token1, client as never, [cfgDrained], amountIn);
    assert.equal(dr.length, 0, "a drained pool (graceful-0 quote) is dropped by the liveness probe");

    console.log(`  [QL LiquidCore discovery] pool=${fwd[0].address} via unordered getPoolForPair; zero-entry + drained-drop pinned`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL LiquidCore solo [${engine}] — BBO-mock-priced ladder, received == estimateSwap wei-exact, residue 0`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL LiquidCore + V3 [${engine}] — QL stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runLcV3(engine);
    });
    it(`QL LiquidCore zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL LiquidCore + V3 BBO-drift [${engine}] — split RE-ANCHORS to the re-posted book`, { skip }, async () => {
      await runDriftSplit(engine);
    });
    it(`QL LiquidCore drained pool [${engine}] — graceful-0 quote, venue self-drops, no DoS`, { skip }, async () => {
      await runDrained(engine);
    });
    it(`QL LiquidCore oversize [${engine}] — full pull vs capped quote, residue 0`, { skip }, async () => {
      await runOversize(engine);
    });
  }
  it("QL LiquidCore discovery — unordered getPoolForPair, zero-entry list, drained-drop", async () => {
    await runDiscovery();
  });
});
