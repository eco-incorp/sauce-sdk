/**
 * EcoSwap EKUBO V3 (till-based flash-accounting singleton CL) QUOTE-LADDER (QL) local-EVM
 * integration — the virtual-pool plain-CALL-quote gate (segKind 21).
 *
 * Ekubo is a QUOTE-LADDER family: prepare ships ONLY a descriptor [router, isToken1, 0, feePpm,
 * segKind=21, refIdx, token0, token1, config, poolId] — NO off-chain sampled ladder AND NO port of
 * Ekubo's bespoke micro-tick math — and the on-chain solver builds the venue's price ladder in
 * setup from LIVE cook-time `MEVCaptureRouter.quote(key, isToken1, +xNext, 0, 0)` — a PLAIN CALL
 * (the real lock protocol TSTOREs ⇒ staticcall-illegal; the fixture quote WRITES a nonce to pin
 * exactly that property), PROBE-THEN-DECODE (PoolNotInitialized ⇒ the venue self-drops; an
 * OVERSIZE ask PARTIAL-FILLS gracefully and the differenced ladder flatlines), decoding |the
 * negative out int128 LANE| of the packed PoolBalanceUpdate. EXEC is callback-free (the E0-pinned
 * Option A): in-tx re-quote → decode the CONSUMED input + out → approve ROUTER for EXACTLY
 * consumed → the FULL-FILL swap(key, isToken1, +consumed, 0, 0, threshold = quoted out, self) —
 * the router pulls exactly consumed via transferFrom(swapper → Core till) ⇒ pull == approve ⇒
 * residue == 0 (asserted); an over-award's unconsumed remainder rides the terminal refund.
 *
 * The oracle prices the venue via buildEkuboQLLadder driven by the bit-exact fixture-curve replay
 * (fee-on-input CEIL at 0.64 fixed + constant-product on the net + the maxIn liquidity cap), so
 * oracle == solver to the WEI.
 *
 *   (1) SOLO — ladder covers [0, amountIn]; received == quote(amountIn) == the replay; the Core
 *       till pulled EXACTLY amountIn; allowance residue == 0.
 *   (2) + a live V3 direct pool — split == the neutral oracle to the WEI.
 *   (3) REVERSE direction (tokenIn == the key's token1) — the isToken1 decode-lane cell (in =
 *       delta1 LOW lane, out = |delta0 HIGH lane|), wei-exact + residue 0.
 *   (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE, quote == quote(amountIn).
 *   (5) ADVERSE DRIFT via a REAL fixture-router swap — the pre-drift bytecodes re-anchor (the
 *       Ekubo share shrinks, V3 grows), split == the drifted oracle wei-exact.
 *   (6) PARTIAL-FILL LIQUIDITY CAP — maxIn < amountIn: the quote flatlines, the ladder truncates,
 *       the exec swaps ONLY the quoted consumed (full-fill invariant preserved), the unconsumed
 *       award rides the terminal refund; pulled == cap, residue == 0.
 *   (7) DEAD VENUE — an UNREGISTERED pool key (the real PoolNotInitialized class): the venue
 *       self-drops (probe-then-decode), V3 absorbs, never a DoS.
 *   (8) DISCOVERY — production discoverEkuboPoolsTyped against the fixture Core: ONE raw batched
 *       sload over the preset menu, only the registered config survives, direction stamped per
 *       edge, poolId == the fixture's derivation, a drained pool drops at the quote probe.
 *
 * No fork / no RPC env — local fixtures deploy the whole stack. Runs on v1 (+ v12 when present),
 * driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil. Mirrors
 * ecoswap.pancakestable.evm.test.ts.
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
  deployEkuboFixture,
  ekuboCoreFixtureAbi,
  ekuboRouterFixtureAbi,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO, SwapPoolType, FactoryType, type FactoryConfig } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import {
  buildEkuboQLLadder,
  ekuboConcentratedConfig,
  ekuboPoolId,
  ekuboFeePpm,
  type EkuboPool,
} from "../shared/ekubo-math";
import { discoverEkuboPoolsTyped } from "../shared/pool-discovery";

const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const ENGINE_CELLS = engineCells();

// The fixture pool's fee — the REAL 0.05% preset word (round(0.0005 × 2^64), live-confirmed).
const FEE_005 = 9223372036854776n;
// The fixture's registered concentrated config (0.05% / ts 4988 — the live ETH volatile tier).
const CONFIG_005 = ekuboConcentratedConfig(FEE_005, 4988);

// Ekubo-only treeshake defines (HAS_EKUBO lights the qKind-21 ladder branch + the key stash +
// the segKind-21 accumulator + the callback-free exec; the live V3 frontier + merge core are
// unguarded). Mirrors index.ts protocolDefines.
const EK_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
  HAS_TESSERA: false, HAS_ELFOMO: false, HAS_METRIC: false, HAS_LIQUIDCORE: false, HAS_SIZE: false,
  HAS_PANCAKE_STABLE: false, HAS_EKUBO: true,
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

// One QL Ekubo descriptor row — the production shape (index.ts qlRowFor):
// [router, isToken1, 0, feePpm, 21, refIdx, token0, token1, config, poolId].
function ekDescriptor(
  router: Hex, isToken1: boolean, refIdx: number,
  token0: Hex, token1: Hex, config: Hex,
): bigint[] {
  return [
    BigInt(router), isToken1 ? 1n : 0n, 0n, BigInt(ekuboFeePpm(FEE_005)), 21n, BigInt(refIdx),
    BigInt(token0), BigInt(token1), BigInt(config), BigInt(ekuboPoolId(token0, token1, config)),
  ];
}

function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, BigInt(pool), BigInt(feePpm), BigInt(tickSpacing), 0n, BigInt(feePpm), 0n,
    inIsToken0 ? 1n : 0n, 0n, 0n, getSqrtRatioAtTick(tickSpacing), 0n, 0n, 0n, 0n, 0n, 0n,
  ];
}

/** The fixture curve replay — BIT-EXACT vs EkuboRouterFixture._compute: consumed = min(dx, maxIn);
 *  feeAmt = ceil(consumed·fee / 2^64) (the real computeFee shape); out = floor(net·rOut/(rIn+net)).
 *  Returns the cumulative |out| for total input dx — flatlining past maxIn (the partial-fill class). */
function fixtureGetDy(
  s: { rIn: bigint; rOut: bigint; fee: bigint; maxIn: bigint },
  dx: bigint,
): bigint {
  const consumed = dx <= s.maxIn ? dx : s.maxIn;
  const feeAmt = (consumed * s.fee + (1n << 64n) - 1n) >> 64n;
  const net = consumed - feeAmt;
  if (s.rIn <= 0n || s.rOut <= 0n || net <= 0n) return 0n;
  return (net * s.rOut) / (s.rIn + net);
}

/** The consumed input the fixture swap will pull for an award of dx (the full-fill amount). */
function fixtureConsumed(maxIn: bigint, dx: bigint): bigint {
  return dx <= maxIn ? dx : maxIn;
}

describe("EcoSwap EKUBO QL live-walk (local fixture) — plain-CALL router.quote ladder + full-fill swap exec", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let token0: Hex; // sorted lower — the PoolKey token0
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

  async function deployPool(
    r0: bigint, r1: bigint,
    opts: { maxIn0?: bigint; maxIn1?: bigint } = {},
  ): Promise<{ core: Hex; router: Hex; poolId: Hex }> {
    return deployEkuboFixture(
      c.walletClient, c.publicClient, [token0, token1], [r0, r1], FEE_005, CONFIG_005,
      { ...opts, minter: c.walletClient.account as Account },
    );
  }

  const allowanceAbi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);
  async function allowanceOf(token: Hex, owner: Hex, spender: Hex): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: token, abi: allowanceAbi as Abi, functionName: "allowance", args: [owner, spender],
    })) as bigint;
  }

  /** The fixture router's LIVE quote (eth_call) — the engine-independent ground truth: |out lane|. */
  async function onQuote(router: Hex, isToken1: boolean, dx: bigint): Promise<bigint> {
    const [bu] = (await c.publicClient.readContract({
      address: router, abi: ekuboRouterFixtureAbi as Abi, functionName: "quote",
      args: [{ token0, token1, config: CONFIG_005 }, isToken1, dx, 0n, 0n],
    })) as readonly [Hex, Hex];
    const word = BigInt(bu);
    const lane = isToken1 ? word >> 128n : word & ((1n << 128n) - 1n);
    return lane > (1n << 127n) - 1n ? (1n << 128n) - lane : 0n;
  }

  /** Read the live fixture reserves (for the post-drift oracle rebuild). */
  async function liveReserves(core: Hex, poolId: Hex): Promise<[bigint, bigint, bigint, bigint]> {
    const p = (await c.publicClient.readContract({
      address: core, abi: ekuboCoreFixtureAbi as Abi, functionName: "pools", args: [poolId],
    })) as readonly [Hex, Hex, bigint, bigint, bigint, bigint, bigint, boolean];
    return [p[2], p[3], p[5], p[6]]; // r0, r1, maxIn0, maxIn1
  }

  // Off-chain EkuboPool oracle model over the given state (the bit-exact fixture replay).
  function offPool(
    router: Hex, isToken1: boolean,
    r0: bigint, r1: bigint, maxIn: bigint = (1n << 120n) - 1n,
  ): EkuboPool {
    const s = isToken1
      ? { rIn: r1, rOut: r0, fee: FEE_005, maxIn }
      : { rIn: r0, rOut: r1, fee: FEE_005, maxIn };
    return {
      router, token0, token1, config: CONFIG_005, isToken1,
      poolId: ekuboPoolId(token0, token1, CONFIG_005),
      tokenIn: isToken1 ? token1 : token0,
      tokenOut: isToken1 ? token0 : token1,
      feePpm: ekuboFeePpm(FEE_005), source: "local-fixture",
      getDy: (dx: bigint) => fixtureGetDy(s, dx),
    };
  }

  // ── (1) SOLO — ladder built from live plain-CALL quotes; received == quote == replay; residue 0 ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const R = 1_000_000n * E18;
    const { core, router } = await deployPool(R, R);
    const amountIn = 100_000n * E18;
    const op = offPool(router, false, R, R);
    const ladder = buildEkuboQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL Ekubo ladder");
    assert.equal(
      ladder.reduce((a, s) => a + s.capacity, 0n), amountIn,
      "ladder covers the full amountIn (strictly-convex CP curve — no early stop)",
    );

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [ekDescriptor(router, false, 0, token0, token1, CONFIG_005)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EK_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const coreInBefore = await balanceOf(c.publicClient, token0, core);
    const onViewPre = await onQuote(router, false, amountIn);
    assert.equal(onViewPre, op.getDy(amountIn), "TS fixture replay == the router quote (bit-exact)");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL Ekubo cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;
    const coreIn = (await balanceOf(c.publicClient, token0, core)) - coreInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL Ekubo venue)");
    assert.equal(coreIn, amountIn, "the Core till pulled EXACTLY the consumed input (transferFrom — pull == approve)");
    assert.equal(received, onViewPre, "received == router quote(amountIn) to the wei (exact-in)");
    // RESIDUE SWEEP: the exec approves EXACTLY the quoted consumed input and the router's payFrom
    // pulls exactly that (source-verified + fork-proven on the real router) — no reset needed.
    assert.equal(await allowanceOf(token0, target, router), 0n, "no router allowance residue (pull == approve)");

    console.log(
      `  [QL Ekubo solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== quote to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) + a live V3 direct pool — split == oracle wei-exact ──
  async function runEkV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A MID-DEPTH Ekubo CP pool (1M/side, 0.05% — draws FIRST but bends convexly) vs a DEEP 1:1 V3
    // pool (0.3%, one wide position ⇒ constant L). The CP marginal bends below the deep V3
    // post-fee marginal inside the trade, so the curves CROSS and BOTH venues receive input.
    const R = 1_000_000n * E18;
    const { router } = await deployPool(R, R);
    const op = offPool(router, false, R, R);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const amountIn = 300_000n * E18;
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({
      pools: [v3Opt, { ekubo: op, feePpm: 0 } as OptimalPool],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oEk = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oEk > 0n, `oracle splits across V3 + Ekubo (V3 ${oV3}, EK ${oEk})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [ekDescriptor(router, false, 0, token0, token1, CONFIG_005)];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EK_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const ekOutPre = await onQuote(router, false, oEk);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "Ekubo+V3 cook() must succeed");

    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;
    const ekIn = spent - v3In;

    assert.ok(ekIn > 0n && v3In > 0n, `both venues funded (EK ${ekIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(ekIn, oEk, "Ekubo awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");
    assert.ok(received >= ekOutPre, "received covers the Ekubo leg's pre-cook quote of its award");

    console.log(`  [QL Ekubo+V3:${engine}] V3 in=${v3In} EK in=${ekIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) REVERSE direction — the isToken1 decode-lane cell (in = LOW lane, out = |HIGH lane|) ──
  async function runReverse(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const R = 1_000_000n * E18;
    const { core, router } = await deployPool(R, R);
    const amountIn = 100_000n * E18;
    const op = offPool(router, true, R, R); // tokenIn == token1 ⇒ isToken1

    const { bytecodes } = compileSauce(
      solverSrc,
      // tokenIn = token1, tokenOut = token0 — the solver derives isToken1 from qTokIn == qd[7].
      args(token1, token0, amountIn, caller, 0, [], [ekDescriptor(router, true, 0, token0, token1, CONFIG_005)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EK_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token1, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token1, caller);
    const outBefore = await balanceOf(c.publicClient, token0, caller);
    const coreInBefore = await balanceOf(c.publicClient, token1, core);
    const onViewPre = await onQuote(router, true, amountIn);
    assert.equal(onViewPre, op.getDy(amountIn), "reverse TS replay == the router quote (bit-exact)");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "REVERSE QL Ekubo cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, token1, caller));
    const received = (await balanceOf(c.publicClient, token0, caller)) - outBefore;
    const coreIn = (await balanceOf(c.publicClient, token1, core)) - coreInBefore;

    assert.equal(spent, amountIn, "reverse: spent == amountIn");
    assert.equal(coreIn, amountIn, "reverse: the Core till pulled exactly the input");
    assert.equal(received, onViewPre, "reverse: received == quote to the wei (|delta0 HIGH lane| decode)");
    assert.equal(await allowanceOf(token1, target, router), 0n, "reverse: no allowance residue");

    console.log(`  [QL Ekubo reverse:${engine}] spent=${spent} received=${received} (isToken1 lane decode wei-exact)`);
  }

  // ── (4) ZERO-CACHE QUOTE ──
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

    const R = 1_000_000n * E18;
    const { router } = await deployPool(R, R);
    const amountIn = 100_000n * E18;

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [ekDescriptor(router, false, 0, token0, token1, CONFIG_005)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EK_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(
      quoted, await onQuote(router, false, amountIn),
      "zero-cache QUOTE == router quote(amountIn) to the wei (plain-CALL ladder built live in the eth_call)",
    );
    console.log(`  [QL Ekubo zero-cache quote:${engine}] quoted=${quoted} (== quote, no prepared cache)`);
  }

  // ── (5) ADVERSE DRIFT via a REAL fixture-router swap — the pre-drift bytecodes re-anchor ──
  async function runAdverseDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const R = 1_000_000n * E18;
    const { core, router, poolId } = await deployPool(R, R);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };

    const amountIn = 300_000n * E18;
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [ekDescriptor(router, false, 0, token0, token1, CONFIG_005)];
    // Bytecode built against the PRE-drift universe — the descriptor carries NO pool state, so the
    // SAME bytecode is cooked after drift; only the LIVE quote the ladder reads changes.
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EK_DEFINES },
    );

    const oraclePre = optimalSplit({
      pools: [v3Opt, { ekubo: offPool(router, false, R, R), feePpm: 0 } as OptimalPool],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const ekSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(ekSharePre > 0n, "baseline oracle awards the Ekubo venue a share");

    // ADVERSE DRIFT: a REAL token0→token1 swap through the fixture router imbalances the pool
    // (more token0 reserve, less token1) so subsequent token0→token1 swaps price WORSE.
    const driftIn = 50_000n * E18;
    await approve(c.walletClient, c.publicClient, token0, router, driftIn);
    const driftOut = await onQuote(router, false, driftIn);
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: router, abi: ekuboRouterFixtureAbi as Abi, functionName: "swap",
        args: [{ token0, token1, config: CONFIG_005 }, false, driftIn, 0n, 0n, driftOut, caller],
        account: caller, chain: c.walletClient.chain,
      }),
    });
    // The DRIFTED oracle — rebuilt from the pool's LIVE post-drift reserves (the fixture books the
    // NET input into the curve exactly like the replay, so the live read IS the ground truth).
    const [r0, r1] = await liveReserves(core, poolId);
    const oracleDrift = optimalSplit({
      pools: [v3Opt, { ekubo: offPool(router, false, r0, r1), feePpm: 0 } as OptimalPool],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const ekShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(ekShareDrift > 0n, "drifted oracle still awards the venue a (smaller) share");
    assert.ok(ekShareDrift < ekSharePre, `adverse drift shrinks the Ekubo share (${ekShareDrift} < ${ekSharePre})`);

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "adverse-drift Ekubo+V3 cook() must succeed");

    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;
    const ekIn = spent - v3In;

    assert.ok(ekIn > 0n && v3In > 0n, "both venues funded post-drift");
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(ekIn, ekShareDrift, "Ekubo awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(ekIn < ekSharePre, `Ekubo share ADAPTED down after adverse drift (${ekIn} < baseline ${ekSharePre})`);

    console.log(
      `  [QL Ekubo+V3 adverse-drift:${engine}] baseline share=${ekSharePre} → re-anchored=${ekIn} ` +
        `(V3 grew to ${v3In}); received=${received} (split RE-ANCHORED to the live drifted curve)`,
    );
  }

  // ── (6) PARTIAL-FILL LIQUIDITY CAP — the quote flatlines; the exec swaps ONLY the consumed ──
  async function runPartialFillCap(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const R = 1_000_000n * E18;
    const CAP = 30_000n * E18; // the pool's whole fillable token0 input — well below amountIn
    const { core, router } = await deployPool(R, R, { maxIn0: CAP });
    const amountIn = 100_000n * E18;
    const op = offPool(router, false, R, R, CAP);

    // The ladder flatlines past CAP: the differenced slice-out dies within one slice of the cap,
    // so the merge awards Σ ladder capacities ∈ [CAP, CAP + one slice) — the oracle mirrors it.
    const ladder = buildEkuboQLLadder(op, amountIn);
    const award = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.ok(award >= CAP && award < amountIn, `ladder truncates near the cap (award=${award}, cap=${CAP})`);

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [ekDescriptor(router, false, 0, token0, token1, CONFIG_005)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EK_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const coreInBefore = await balanceOf(c.publicClient, token0, core);
    const consumed = fixtureConsumed(CAP, award);
    const onViewPre = await onQuote(router, false, award); // == the flatlined out at the cap

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "partial-fill-cap cook() must succeed (full-fill of the CONSUMED amount)");

    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;
    const coreIn = (await balanceOf(c.publicClient, token0, core)) - coreInBefore;

    assert.equal(consumed, CAP, "the quoted consumed input IS the liquidity cap");
    assert.equal(coreIn, CAP, "the Core till pulled EXACTLY the consumed input (never the over-award)");
    assert.equal(spent, CAP, "net caller spend == consumed (the unconsumed award rode the terminal refund)");
    assert.equal(received, onViewPre, "received == the flatlined quote (wei-exact at the cap)");
    assert.equal(await allowanceOf(token0, target, router), 0n, "no allowance residue (approve == consumed == pull)");

    console.log(
      `  [QL Ekubo partial-fill cap:${engine}] award=${award} consumed=${consumed} received=${received} ` +
        `(exec swapped only the quoted consumed; remainder refunded)`,
    );
  }

  // ── (7) DEAD VENUE — an unregistered pool key (PoolNotInitialized): self-drop, V3 absorbs ──
  async function runDeadVenue(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const R = 1_000_000n * E18;
    const { core, router } = await deployPool(R, R);
    // A DIFFERENT config that was never registered — the real PoolNotInitialized class.
    const deadConfig = ekuboConcentratedConfig(553402322211287n, 100);
    const amountIn = 20_000n * E18;

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));

    await assert.rejects(
      c.publicClient.readContract({
        address: router, abi: ekuboRouterFixtureAbi as Abi, functionName: "quote",
        args: [{ token0, token1, config: deadConfig }, false, amountIn, 0n, 0n],
      }),
      "an UNREGISTERED pool key REVERTS the quote (PoolNotInitialized — the real class)",
    );

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [ekDescriptor(router, false, 0, token0, token1, deadConfig)];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: EK_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const coreInBefore = await balanceOf(c.publicClient, token0, core);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "dead-venue cook() SUCCEEDS (probe-then-decode — never a DoS)");

    const coreIn = (await balanceOf(c.publicClient, token0, core)) - coreInBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.equal(coreIn, 0n, "the DEAD Ekubo venue received 0 (revert probe ⇒ zero ladder — self-dropped)");
    assert.equal(v3In, spent, "the whole spent input landed on V3");
    assert.equal(spent, amountIn, "the trade still fills in full (V3 absorbs it)");
    assert.ok(received > 0n, "caller receives tokenOut via V3");

    console.log(`  [QL Ekubo dead venue:${engine}] EK=0 V3=${v3In} received=${received} (venue self-dropped, no DoS)`);
  }

  // ── (8) DISCOVERY — the production preset-clone path against the fixture Core (no cook) ──
  async function runDiscovery(): Promise<void> {
    await setup();
    const R = 200_000n * E18;
    const { core, router } = await deployPool(R, R);
    const client = createPublicClient({ transport: http(anvil.rpcUrl) });
    const cfg: FactoryConfig = {
      address: core, poolType: SwapPoolType.UniV2, factoryType: FactoryType.Ekubo, label: "Local Ekubo",
      ekuboRouter: router,
      // A 3-entry menu — only the 0.05%/4988 config is registered; the others must DROP at the
      // batched raw-sload liveness probe (their poolState words read 0).
      ekuboPresets: [
        { fee: 553402322211287n, tickSpacing: 100 },
        { fee: FEE_005, tickSpacing: 4988 },
        { fee: 55340232221128655n, tickSpacing: 4988 },
      ],
    };
    const amountIn = 50_000n * E18;

    // Forward: exactly the registered preset survives; direction stamped off the sorted pair.
    const fwd = await discoverEkuboPoolsTyped(token0, token1, client as never, [cfg], amountIn);
    assert.equal(fwd.length, 1, "discovery surfaces exactly the ONE registered preset (2 dead candidates dropped)");
    assert.equal(fwd[0].router.toLowerCase(), router.toLowerCase(), "the descriptor carries the config's router");
    assert.equal(fwd[0].token0.toLowerCase(), token0.toLowerCase(), "sorted token0");
    assert.equal(fwd[0].token1.toLowerCase(), token1.toLowerCase(), "sorted token1");
    assert.equal(fwd[0].config.toLowerCase(), CONFIG_005.toLowerCase(), "the surviving config IS the registered preset");
    assert.equal(
      fwd[0].poolId.toLowerCase(), ekuboPoolId(token0, token1, CONFIG_005).toLowerCase(),
      "poolId == the keccak key derivation (== the fixture's registry key)",
    );
    assert.equal(fwd[0].isToken1, false, "tokenIn == sorted token0 ⇒ isToken1 = false");
    assert.equal(fwd[0].feePpm, 500, "feePpm == round(fee × 1e6 / 2^64) = 500 (0.05%)");
    assert.ok(fwd[0].headOI > 0n, "liveness head > 0");

    // Reverse direction: same pool, flipped isToken1 stamp.
    const rev = await discoverEkuboPoolsTyped(token1, token0, client as never, [cfg], amountIn);
    assert.equal(rev.length, 1, "reverse-direction discovery also resolves (one sorted key)");
    assert.equal(rev[0].poolId.toLowerCase(), fwd[0].poolId.toLowerCase(), "same virtual pool both directions");
    assert.equal(rev[0].isToken1, true, "reverse direction: tokenIn == token1 ⇒ isToken1 = true");

    // A DRAINED pool (zero out-reserve) quotes 0 — dropped by the liveness quote probe.
    const drained = await deployEkuboFixture(
      c.walletClient, c.publicClient, [token0, token1], [R, 0n], FEE_005, CONFIG_005,
      { minter: c.walletClient.account as Account },
    );
    const cfgDrained: FactoryConfig = {
      address: drained.core, poolType: SwapPoolType.UniV2, factoryType: FactoryType.Ekubo,
      label: "Drained Ekubo", ekuboRouter: drained.router,
      ekuboPresets: [{ fee: FEE_005, tickSpacing: 4988 }],
    };
    const dr = await discoverEkuboPoolsTyped(token0, token1, client as never, [cfgDrained], amountIn);
    assert.equal(dr.length, 0, "a drained pool (zero quote) is dropped by the liveness probe");

    // A router-less config is skipped defensively.
    const cfgNoRouter: FactoryConfig = {
      address: core, poolType: SwapPoolType.UniV2, factoryType: FactoryType.Ekubo, label: "No router",
    };
    const nr = await discoverEkuboPoolsTyped(token0, token1, client as never, [cfgNoRouter], amountIn);
    assert.equal(nr.length, 0, "a config without ekuboRouter discovers nothing (defensive skip)");

    console.log(
      `  [QL Ekubo discovery] pool=${fwd[0].poolId.slice(0, 10)}… via ONE batched raw sload over 3 presets; ` +
        `direction stamping + dead/drained drops pinned`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL Ekubo solo [${engine}] — plain-CALL quote ladder, received == quote wei-exact, residue 0`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL Ekubo + V3 [${engine}] — QL stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runEkV3(engine);
    });
    it(`QL Ekubo REVERSE [${engine}] — isToken1 lane decode (in = LOW, out = |HIGH|), wei-exact`, { skip }, async () => {
      await runReverse(engine);
    });
    it(`QL Ekubo zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL Ekubo + V3 adverse-drift [${engine}] — split RE-ANCHORS to the live drifted curve`, { skip }, async () => {
      await runAdverseDriftSplit(engine);
    });
    it(`QL Ekubo partial-fill cap [${engine}] — flatlined ladder, exec swaps only the consumed, remainder refunded`, { skip }, async () => {
      await runPartialFillCap(engine);
    });
    it(`QL Ekubo dead venue [${engine}] — PoolNotInitialized probe, venue self-drops, no DoS`, { skip }, async () => {
      await runDeadVenue(engine);
    });
  }
  it("QL Ekubo discovery — batched raw-sload preset probe, direction stamping, dead/drained drops", async () => {
    await runDiscovery();
  });
});
