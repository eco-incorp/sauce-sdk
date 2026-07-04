/**
 * EcoSwap METRIC (metric.xyz oracle-anchored bin-curve OMM) QUOTE-LADDER (QL) local-EVM integration —
 * the TWO-STEP live quote (per-venue anchor hoist + per-slice quoteSwap at the frozen anchor), the
 * DIRECTIONAL price-limit convention (the resolved reverse-direction unknown), the callback-free
 * approve-ROUTER exec (the router services the pool's metricOmmSwapCallback itself), and the
 * staleness-revert self-drop.
 *
 * Metric is a QUOTE-LADDER family (segKind 17): prepare ships ONLY a descriptor [pool, xToY, _,
 * feePpm, segKind=17, refIdx, provider, router, 0, 0, 0, 0] — NO off-chain sampled ladder — and the
 * on-chain solver HOISTS `provider.getBidAndAskPrice()` once per venue (PROBE-THEN-DECODE — the REAL
 * provider reverts 0x9a0423af when the maker's post is stale; the fixture's setStale models the
 * class), then builds the venue's price ladder in setup from LIVE cook-time
 * `router.quoteSwap(pool, xToY, +xNext, limit, bid, ask)` at the FROZEN anchor (probe-then-decode;
 * decode the |negative out-delta|). EXEC is callback-free from the cooking contract's perspective —
 * derive provider/token0 via getImmutables, live quote as minAmountOut, approve ROUTER,
 * swapExactInput (the pool pays out first, then re-enters the ROUTER's own metricOmmSwapCallback).
 *
 * The oracle prices Metric via buildMetricQLLadder driven by a bit-exact TS replay of the fixture's
 * bin curve (the same getDy-model contract the Fluid/Tessera families use), so oracle == solver to
 * the WEI.
 *
 *   (1) SOLO QL Metric xToY — ladder built live at the hoisted anchor, covers [0, amountIn],
 *       received == router.quoteSwap(amountIn) == the TS bin-curve replay, all to the WEI.
 *   (2) SOLO QL Metric REVERSE (yToX) — the resolved convention's own cell: the price RISES, the
 *       unbounded limit is uint128.max (0 would quote (0,0) — the prior probe's trap), the out is
 *       |amount0Delta|; received == quoteSwap == the replay to the WEI.
 *   (3) QL Metric + a live V3 direct pool — the QL stream vs the live V3 frontier in ONE merge; the
 *       per-venue split == the neutral oracle to the WEI.
 *   (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared segments,
 *       quote == quoteSwap(amountIn)'s out to the wei.
 *   (5) ADVERSE DRIFT via a PROVIDER PRICE SHIFT — the maker re-posts a worse anchor
 *       (setBidAndAskPrice) BEFORE cooking the pre-drift bytecode; the hoist reads the LIVE (worse)
 *       anchor and the Metric↔V3 split RE-ANCHORS (Metric's share shrinks, wei-exact vs the drifted
 *       oracle).
 *   (6) STALE PROVIDER — setStale(true) (the 0x9a0423af class): the venue prelude's probe catches,
 *       the ladder is ZERO, the venue self-drops and the WHOLE trade lands on V3 — cook still
 *       succeeds (never a DoS), the Metric pool receives 0.
 *
 * No fork / no RPC env — local fixtures deploy the whole stack. Runs on v1 (+ v12 when the v12
 * artifacts are present), driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil. Mirrors
 * ecoswap.tessera.evm.test.ts.
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
  deployMetricStack,
  metricRouterFixtureAbi,
  metricProviderFixtureAbi,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import {
  buildMetricQLLadder,
  METRIC_LIMIT_MAX_U128,
  type MetricPool,
} from "../shared/metric-math";

const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const X64 = 1n << 64n;
const SCALE = 10n ** 6n;
const MAX_BINS = 4096n;
const FEE_PPM = 300n; // 0.03% (1e6-scaled), netted off the total gross out
const STEP_PPM = 500n; // 0.05% per-bin price degradation
const BIN_CAP = 2_000n * E18; // per-bin input capacity (both directions)
// The maker anchor: a near-1:1 X64 bid/ask with a 20 bp spread (bid 0.999, ask 1.001).
const BID0 = (X64 * 999n) / 1000n;
const ASK0 = (X64 * 1001n) / 1000n;
const ENGINE_CELLS = engineCells();

// Metric-only treeshake defines (HAS_METRIC lights the anchor-hoist prelude + the qKind-17 ladder
// branch + the segKind-17 accumulator + the callback-free exec; the live V3 frontier + merge core
// are unguarded).
const METRIC_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
  HAS_TESSERA: false, HAS_ELFOMO: false, HAS_METRIC: true,
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

// One QL Metric descriptor row — the production 12-column shape (index.ts qlRowFor + pad12):
// [pool, xToY, 0, feePpm, 17, refIdx, provider, router, 0, 0, 0, 0]. The provider rides qd[6] (the
// prelude anchor-hoist target); the router rides qd[7] (the quote/swap/approve target + msAux).
function metricDescriptor(pool: Hex, provider: Hex, router: Hex, xToY: boolean, refIdx: number, feePpm: number): bigint[] {
  return [
    BigInt(pool), xToY ? 1n : 0n, 0n, BigInt(feePpm), 17n, BigInt(refIdx),
    BigInt(provider), BigInt(router), 0n, 0n, 0n, 0n,
  ];
}

function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, BigInt(pool), BigInt(feePpm), BigInt(tickSpacing), 0n, BigInt(feePpm), 0n,
    inIsToken0 ? 1n : 0n, 0n, 0n, getSqrtRatioAtTick(tickSpacing), 0n, 0n, 0n, 0n, 0n, 0n,
  ];
}

// Bit-exact TS replay of the fixture's bin walk (MetricPool.sol _walk + the terminal fee), with the
// recipe's UNBOUNDED directional limit baked in (0 for xToY — no limit break; uint128.max for yToX)
// — the `getDy` quote model buildMetricQLLadder consumes (the Fluid/Tessera-family model contract).
// `availOut` is the pool's OUT-token inventory (the walk stops at it — whole bins only).
function metricGetDy(xToY: boolean, bid: bigint, ask: bigint, availOut: bigint): (dx: bigint) => bigint {
  return (dx: bigint): bigint => {
    if (dx <= 0n) return 0n;
    let remaining = dx;
    let gross = 0n;
    for (let k = 0n; k < MAX_BINS && remaining > 0n; k++) {
      let pk: bigint;
      if (xToY) {
        const down = k * STEP_PPM;
        if (down >= SCALE) break;
        pk = (bid * (SCALE - down)) / SCALE;
        if (pk === 0n) break;
        // priceLimit == 0 ⇒ no limit break (the unbounded xToY side).
      } else {
        pk = (ask * (SCALE + k * STEP_PPM)) / SCALE;
        if (pk >= METRIC_LIMIT_MAX_U128) break; // priceLimit == uint128.max (the unbounded yToX side)
      }
      const take = remaining < BIN_CAP ? remaining : BIN_CAP;
      const o = xToY ? (take * pk) / X64 : (take * X64) / pk;
      if (o === 0n) break;
      if (gross + o > availOut) break; // OUT inventory exhausted — partial fill (whole bins only)
      gross += o;
      remaining -= take;
    }
    return (gross * (SCALE - FEE_PPM)) / SCALE;
  };
}

describe("EcoSwap METRIC QL live-walk (local fixture) — anchor-hoisted quoteSwap ladder + directional limit + callback-free router exec", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let token0: Hex; // the Metric pool's token0 (X)
  let token1: Hex; // the Metric pool's token1 (Y)
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

  async function deploy(reserve0: bigint, reserve1: bigint): Promise<{ pool: Hex; router: Hex; provider: Hex }> {
    return deployMetricStack(
      c.walletClient, c.publicClient, token0, token1,
      BID0, ASK0, FEE_PPM, BIN_CAP, BIN_CAP, STEP_PPM, reserve0, reserve1,
      c.walletClient.account as Account,
    );
  }

  // The router's own on-chain quote at the LIVE provider anchor — the engine-independent ground
  // truth (returns the |negative out-delta| for the direction).
  async function onQuote(router: Hex, provider: Hex, pool: Hex, xToY: boolean, amt: bigint): Promise<bigint> {
    const [bid, ask] = (await c.publicClient.readContract({
      address: provider, abi: metricProviderFixtureAbi as Abi, functionName: "getBidAndAskPrice",
    })) as readonly [bigint, bigint];
    const limit = xToY ? 0n : METRIC_LIMIT_MAX_U128;
    const [a0, a1] = (await c.publicClient.readContract({
      address: router, abi: metricRouterFixtureAbi as Abi, functionName: "quoteSwap",
      args: [pool, xToY, amt, limit, bid, ask],
    })) as readonly [bigint, bigint];
    const outDelta = xToY ? a1 : a0;
    return outDelta < 0n ? -outDelta : 0n;
  }

  // Off-chain MetricPool model — the bit-exact bin-curve replay (NO RPC), per metric-math.ts.
  function offPool(
    stackAddrs: { pool: Hex; router: Hex; provider: Hex },
    xToY: boolean,
    bid: bigint,
    ask: bigint,
    availOut: bigint,
  ): MetricPool {
    return {
      address: stackAddrs.pool,
      provider: stackAddrs.provider,
      router: stackAddrs.router,
      xToY,
      tokenIn: xToY ? token0 : token1,
      tokenOut: xToY ? token1 : token0,
      feePpm: Number(FEE_PPM),
      source: "local-fixture",
      getDy: metricGetDy(xToY, bid, ask, availOut),
    };
  }

  // ── (1) SOLO xToY — ladder from the hoisted anchor; received == quoteSwap(share) wei-exact ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const RES = 200_000n * E18;
    const m = await deploy(RES, RES);
    const amountIn = 100_000n * E18;
    const op = offPool(m, true, BID0, ASK0, RES);
    const ladder = buildMetricQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL Metric ladder");
    const cover = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(cover, amountIn, "QL Metric ladder covers the full amountIn (inventory deep enough)");

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [metricDescriptor(m.pool, m.provider, m.router, true, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: METRIC_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const poolInBefore = await balanceOf(c.publicClient, token0, m.pool);
    const onViewPre = await onQuote(m.router, m.provider, m.pool, true, amountIn);
    assert.equal(onViewPre, op.getDy(amountIn), "TS bin-curve model == the router quoteSwap view (bit-exact)");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL Metric cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, token0, m.pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL Metric venue)");
    assert.equal(poolIn, amountIn, "the router pulled the full input share into the POOL (approve ROUTER + callback pull)");
    assert.equal(received, onViewPre, "received == router.quoteSwap at the live anchor to the wei");
    assert.ok(received > 0n, "non-zero Metric fill through the callback-free approve-router path");

    console.log(
      `  [QL Metric solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== quoteSwap to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) SOLO REVERSE (yToX) — the resolved directional-limit convention's own cell ──
  async function runReverse(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const RES = 200_000n * E18;
    const m = await deploy(RES, RES);
    const amountIn = 100_000n * E18; // token1 (Y) in — the price RISES, the unbounded limit is uint128.max
    const op = offPool(m, false, BID0, ASK0, RES);
    const ladder = buildMetricQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty REVERSE QL Metric ladder");
    assert.equal(
      ladder.reduce((a, s) => a + s.capacity, 0n), amountIn,
      "REVERSE ladder covers the full amountIn",
    );

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token1, token0, amountIn, caller, 0, [], [metricDescriptor(m.pool, m.provider, m.router, false, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: METRIC_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token1, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token1, caller);
    const outBefore = await balanceOf(c.publicClient, token0, caller);
    const onViewPre = await onQuote(m.router, m.provider, m.pool, false, amountIn);
    assert.equal(onViewPre, op.getDy(amountIn), "REVERSE TS model == quoteSwap (|amount0Delta| decode, limit=uint128.max)");
    assert.ok(onViewPre > 0n, "the reverse direction quotes sanely with the HIGH limit (the resolved convention)");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "REVERSE QL Metric cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, token1, caller));
    const received = (await balanceOf(c.publicClient, token0, caller)) - outBefore;
    assert.equal(spent, amountIn, "REVERSE spent == amountIn");
    assert.equal(received, onViewPre, "REVERSE received == quoteSwap(|amount0Delta|) to the wei");

    console.log(`  [QL Metric REVERSE:${engine}] spent=${spent} received=${received} (yToX, limit=uint128.max — wei-exact)`);
  }

  // ── (3) QL Metric + a live V3 direct pool — split == oracle wei-exact ──
  async function runMetricV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A near-1:1 Metric with a cheap 0.03% fee vs a DEEP 1:1 V3 (0.30% fee): Metric fills the cheap
    // near bins (bid 0.999 > V3's fee-adjusted 0.997 head), its per-bin marginal decays 0.05%/bin
    // below V3's, V3 takes the tail — both fund.
    const RES = 200_000n * E18;
    const m = await deploy(RES, RES);
    const amountIn = 100_000n * E18;
    const op = offPool(m, true, BID0, ASK0, RES);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({ pools: [v3Opt, { metric: op, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oMc = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oMc > 0n, `oracle splits across V3 + Metric (V3 ${oV3}, Metric ${oMc})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [metricDescriptor(m.pool, m.provider, m.router, true, 0, Number(FEE_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: METRIC_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const mcInBefore = await balanceOf(c.publicClient, token0, m.pool);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "Metric+V3 cook() must succeed");

    const mcIn = (await balanceOf(c.publicClient, token0, m.pool)) - mcInBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.ok(mcIn > 0n && v3In > 0n, `both venues funded (Metric ${mcIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(mcIn, oMc, "Metric awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL Metric+V3:${engine}] V3 in=${v3In} Metric in=${mcIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared cache ──
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
    const amountIn = 100_000n * E18;

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [metricDescriptor(m.pool, m.provider, m.router, true, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: METRIC_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(
      quoted, await onQuote(m.router, m.provider, m.pool, true, amountIn),
      "zero-cache QUOTE == quoteSwap(amountIn)'s out to the wei (anchor hoisted + ladder built live in the eth_call)",
    );
    console.log(`  [QL Metric zero-cache quote:${engine}] quoted=${quoted} (== quoteSwap out, no prepared cache)`);
  }

  // ── (5) ADVERSE DRIFT via a PROVIDER PRICE SHIFT — the maker re-posts a worse anchor BEFORE the
  // cook; the hoist reads the LIVE anchor and the Metric↔V3 split RE-ANCHORS. SAME bytecode. ──
  async function runDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const RES = 200_000n * E18;
    const m = await deploy(RES, RES);
    const amountIn = 100_000n * E18;

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [metricDescriptor(m.pool, m.provider, m.router, true, 0, Number(FEE_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: METRIC_DEFINES },
    );

    const oraclePre = optimalSplit({ pools: [v3Opt, { metric: offPool(m, true, BID0, ASK0, RES), feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const mcSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(mcSharePre > 0n, "baseline oracle awards the Metric venue a share");

    // ADVERSE DRIFT: the maker re-posts a 0.6% WORSE anchor (bid/ask scaled 0.994) — the Metric
    // curve re-anchors instantly (the oracle-anchored class), so its cheap region shrinks vs V3.
    const BID1 = (BID0 * 994n) / 1000n;
    const ASK1 = (ASK0 * 994n) / 1000n;
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: m.provider, abi: metricProviderFixtureAbi as Abi, functionName: "setBidAndAskPrice",
        args: [BID1, ASK1], account: c.walletClient.account as Account, chain: c.walletClient.chain,
      }),
    });

    const oracleDrift = optimalSplit({ pools: [v3Opt, { metric: offPool(m, true, BID1, ASK1, RES), feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const mcShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(mcShareDrift < mcSharePre, `drift shrinks the Metric share (${mcShareDrift} < ${mcSharePre})`);

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const mcInBefore = await balanceOf(c.publicClient, token0, m.pool);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drift cook() SUCCEEDS — the anchor hoist re-read the live (worse) post");

    const mcIn = (await balanceOf(c.publicClient, token0, m.pool)) - mcInBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.ok(v3In > 0n, "V3 funded post-drift");
    assert.equal(mcIn, mcShareDrift, "Metric awarded input == drifted oracle (re-anchored to the live re-post)");
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(mcIn < mcSharePre, `Metric share ADAPTED down after the maker re-post (${mcIn} < baseline ${mcSharePre})`);
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(
      `  [QL Metric+V3 provider-drift:${engine}] baseline Metric share=${mcSharePre} → re-anchored=${mcIn} ` +
        `(V3 grew to ${v3In}); spent=${spent} received=${received}`,
    );
  }

  // ── (6) STALE PROVIDER — the 0x9a0423af class: the prelude probe catches, the venue self-drops,
  // the WHOLE trade lands on V3 and the cook still succeeds (never a DoS). ──
  async function runStaleProvider(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const RES = 200_000n * E18;
    const m = await deploy(RES, RES);
    const amountIn = 50_000n * E18;

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [metricDescriptor(m.pool, m.provider, m.router, true, 0, Number(FEE_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: METRIC_DEFINES },
    );

    // The maker goes quiet AFTER prepare/compile: getBidAndAskPrice now REVERTS (the fixture models
    // the whole MAX_TIME_DELTA / Chainlink-guard revert family behind one switch).
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: m.provider, abi: metricProviderFixtureAbi as Abi, functionName: "setStale",
        args: [true], account: c.walletClient.account as Account, chain: c.walletClient.chain,
      }),
    });

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const mcInBefore = await balanceOf(c.publicClient, token0, m.pool);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "stale-provider cook() SUCCEEDS (probe-then-decode — never a DoS)");

    const mcIn = (await balanceOf(c.publicClient, token0, m.pool)) - mcInBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.equal(mcIn, 0n, "the STALE Metric venue received 0 (zero ladder — self-dropped)");
    assert.equal(v3In, spent, "the whole spent input landed on V3");
    assert.equal(spent, amountIn, "the trade still fills in full (V3 absorbs it)");
    assert.ok(received > 0n, "caller receives tokenOut via V3");

    console.log(`  [QL Metric stale-provider:${engine}] Metric=0 V3=${v3In} received=${received} (venue self-dropped, no DoS)`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL Metric solo xToY [${engine}] — anchor-hoisted ladder, received == quoteSwap wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL Metric solo REVERSE yToX [${engine}] — the directional-limit convention, wei-exact`, { skip }, async () => {
      await runReverse(engine);
    });
    it(`QL Metric + V3 [${engine}] — QL stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runMetricV3(engine);
    });
    it(`QL Metric zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL Metric + V3 provider-shift drift [${engine}] — split RE-ANCHORS to the live re-post`, { skip }, async () => {
      await runDriftSplit(engine);
    });
    it(`QL Metric stale provider [${engine}] — venue self-drops, V3 absorbs, no DoS`, { skip }, async () => {
      await runStaleProvider(engine);
    });
  }
});
