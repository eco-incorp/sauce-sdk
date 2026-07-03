/**
 * EcoSwap DODO V2 PMM QUOTE-LADDER (QL) local-EVM integration — the on-chain querySell* ladder + the
 * engine `_swapDODOV2` exact-in-dy gate.
 *
 * DODO is migrated to the QUOTE-LADDER framework (the same one Curve / LB / WOOFi / Wombat / Fermi use):
 * prepare ships ONLY a descriptor [pool, isSellBase, _, feePpm, segKind=3, refIdx] — NO off-chain sampled
 * PMM segments — and the on-chain solver BUILDS each DODO venue's price ladder in setup from the pool's OWN
 * LIVE view. DODO is DIRECTIONAL: qd[1] isSellBase (tokenIn == pool._BASE_TOKEN_()) picks
 * `querySellBase(caller, xNext)[0]` (sell base → quote) or `querySellQuote(caller, xNext)[0]` (sell quote →
 * base); both are REVERT-class, so the ladder PROBES-THEN-DECODES. The trader passed to the query is
 * `caller` (cfg[3]) — the exec's `_swapDODOV2` MT fee-rate model keys on tx.origin == caller, so the quote's
 * MT fee matches the realized swap's. EXEC is UNCHANGED: swap(SwapParams{poolType:5}) → live `_swapDODOV2`
 * (orientation resolved on-chain from `_BASE_TOKEN_()`), so the awarded Σ lands the segment-summed output.
 *
 *   (1) SOLO QL DODO — the on-chain ladder is built from live querySell*, covers [0, amountIn] (pool deep
 *       enough), and the caller-received dy == off-chain getDy(share) == the pool's own querySellBase view,
 *       all to the WEI.
 *   (2) QL DODO + a live V3 direct pool — the QL sampled-segment stream (bestKind 1) competes against the
 *       live V3 frontier (bestKind 3) in ONE merge; the per-venue split == the neutral oracle to the WEI.
 *   (3) QL DODO + QL Curve — TWO QL venues of DIFFERENT segKind (3 + 1) ride ONE qlv; the generalized ladder
 *       loop builds BOTH on-chain and INTERLEAVES them; per-leg exact-in-dy.
 *   (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared segments and returns the
 *       quote == getDy(amountIn) to the wei. Proves the QL quote is prepare-optional.
 *   (5) ADVERSE DRIFT — move the DODO pool with a REAL sell BEFORE cooking the pre-drift bytecode; the QL
 *       ladder reads the LIVE (drifted) querySell* at cook time and the DODO↔V3 split RE-ANCHORS (the DODO
 *       share shrinks, V3's grows) to the drifted oracle, wei-exact.
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
  deployDodoV2Pool,
  dodoAbi,
  erc20Abi,
  deployCurveStableSwap,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { getDy as dodoGetDy, buildDodoQLLadder, RState, DODO_ONE, type DodoPool } from "../shared/dodo-math";
import { getDy as curveGetDy, type CurvePool } from "../shared/curve-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const ONE = DODO_ONE;
const ENGINE_CELLS = engineCells();

// DODO-only treeshake defines (HAS_DODO lights the on-chain QL ladder build's DODO quote branch + the
// segKind-3 accumulator + the engine poolType-5 exec; the live V3 frontier + merge core are unguarded).
const DODO_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: true, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
};
// DODO + Curve — BOTH QL adapter branches ship so the generalized qlv loop builds a segKind-3 (DODO) and a
// segKind-1 (Curve StableSwap) ladder in one pass.
const DODO_CURVE_DEFINES: Record<string, boolean> = { ...DODO_DEFINES, HAS_CURVE: true, HAS_DODO: true };

// The solver's 6 compiler args (index.ts order): cfg, pools, netCache, routing, segs, qlv.
function args(
  tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex,
  directCount: number, pools: bigint[][], qlv: bigint[][],
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

// One QL DODO descriptor: [pool, isSellBase(0/1), _, feePpm, segKind=3, refIdx]. isSellBase is qd[1] (the
// on-chain querySell* direction bit); feePpm is informational (querySell* is post-fee).
function dodoDescriptor(pool: Hex, refIdx: number, isSellBase: boolean, feePpm: number): bigint[] {
  return [BigInt(pool), isSellBase ? 1n : 0n, 0n, BigInt(feePpm), 3n, BigInt(refIdx)];
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

describe("EcoSwap DODO V2 PMM QL live-walk (local fixture) — on-chain querySell* ladder + engine _swapDODOV2", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the DODO pool's base token (isSellBase: base → quote)
  let tokenOut: Hex; // == the quote token
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

  // Off-chain DodoPool descriptor. tokenIn == base ⇒ sellBase → quote. Base-scarce (ABOVE_ONE) so the
  // curve has the monotone rebalancing region the QL ladder walks. Overridable per cell.
  function offPool(address: Hex, over: Partial<DodoPool>): DodoPool {
    return {
      poolType: 5, address, baseToken: tokenIn, quoteToken: tokenOut, sellBase: true,
      i: 2n * ONE, K: ONE / 5n, B: 800_000n * ONE, Q: 1_420_000n * ONE,
      B0: 1_000_000n * ONE, Q0: 1_000_000n * ONE,
      lpFeeRate: 3n * 10n ** 15n, mtFeeRate: 0n, feePpm: 3000, R: RState.ABOVE_ONE,
      source: "local-fixture", ...over,
    };
  }

  // Off-chain DodoPool descriptor for the OTHER direction: tokenIn == QUOTE ⇒ sellQuote → base. Quote-scarce
  // (BELOW_ONE: B > B0 so the fixture derives BELOW_ONE) so selling quote walks the monotone rebalancing
  // region [Q, Q0] via _generalIntegrate (the mirror of offPool's ABOVE_ONE sell-base region). base ==
  // tokenOut / quote == tokenIn so the engine `_swapDODOV2` (orientation from `_BASE_TOKEN_()`) calls sellQuote.
  function offPoolQuote(address: Hex, over: Partial<DodoPool>): DodoPool {
    return {
      poolType: 5, address, baseToken: tokenOut, quoteToken: tokenIn, sellBase: false,
      i: 2n * ONE, K: ONE / 5n, B: 1_420_000n * ONE, Q: 800_000n * ONE,
      B0: 1_000_000n * ONE, Q0: 1_000_000n * ONE,
      lpFeeRate: 3n * 10n ** 15n, mtFeeRate: 0n, feePpm: 3000, R: RState.BELOW_ONE,
      source: "local-fixture", ...over,
    };
  }

  function deployParams(op: DodoPool) {
    return {
      base: op.baseToken, quote: op.quoteToken, i: op.i, K: op.K, B: op.B, Q: op.Q,
      B0: op.B0, Q0: op.Q0, lpFeeRate: op.lpFeeRate, mtFeeRate: op.mtFeeRate,
    };
  }

  function offCurvePool(address: Hex, balances: bigint[], a: bigint, fee: bigint): CurvePool {
    return { poolType: 3, address, i: 0, j: 1, A: a, aPrecision: 100n, balances, rates: [ONE, ONE], feePpm10: fee, source: "local-fixture" };
  }

  // The fixture's own on-chain querySellBase view — the engine-independent ground truth. Returns [0]
  // (receiveQuoteAmount, net of the LP+MT fee). `caller` is the trader (matches the exec's tx.origin key).
  async function onQuerySellBase(pool: Hex, caller: Hex, amt: bigint): Promise<bigint> {
    const r = (await c.publicClient.readContract({
      address: pool, abi: dodoAbi as Abi, functionName: "querySellBase", args: [caller, amt],
    })) as readonly [bigint, bigint];
    return r[0];
  }

  // The querySellQuote counterpart (the other DODO direction) — returns [0] (receiveBaseAmount, net of
  // the LP+MT fee). Ground truth for the sell-quote (isSellBase=0) solver branch.
  async function onQuerySellQuote(pool: Hex, caller: Hex, amt: bigint): Promise<bigint> {
    const r = (await c.publicClient.readContract({
      address: pool, abi: dodoAbi as Abi, functionName: "querySellQuote", args: [caller, amt],
    })) as readonly [bigint, bigint];
    return r[0];
  }

  // Reconstruct the DodoPool from the pool's LIVE getPMMStateForCall — used after an adverse drift so the
  // oracle prices the SAME state the on-chain ladder reads at cook time. lpFeeRate/mtFeeRate are fixed.
  async function readOffPool(pool: Hex, base: DodoPool): Promise<DodoPool> {
    const s = (await c.publicClient.readContract({
      address: pool, abi: dodoAbi as Abi, functionName: "getPMMStateForCall", args: [],
    })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    return { ...base, address: pool, i: s[0], K: s[1], B: s[2], Q: s[3], B0: s[4], Q0: s[5], R: Number(s[6]) as RState };
  }

  // ── (1) SOLO QL DODO — the on-chain ladder is built live; received == getDy(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const op0 = offPool(("0x" + "00".repeat(20)) as Hex, {});
    const pool = await deployDodoV2Pool(c.walletClient, c.publicClient, deployParams(op0), caller);
    const op: DodoPool = { ...op0, address: pool };

    // amountIn sized within the rebalancing region (< B0-B = 200k base) so the curve stays convex ⇒ the QL
    // ladder covers the whole trade.
    const amountIn = 100_000n * ONE;
    const ladder = buildDodoQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL DODO ladder");
    const cover = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(cover, amountIn, "QL DODO ladder covers the full amountIn (pool deep enough)");

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [dodoDescriptor(pool, 0, true, op.feePpm)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: DODO_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const onViewPre = await onQuerySellBase(pool, caller, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL DODO cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL DODO venue)");
    assert.equal(poolIn, amountIn, "the DODO pool received the full input share (transfer-first engine)");
    assert.equal(received, dodoGetDy(op, spent), "received == getDy(share) to the wei (exact-in-dy)");
    assert.equal(received, onViewPre, "received == on-chain querySellBase view to the wei");
    assert.ok(received > 0n, "non-zero DODO fill through the engine _swapDODOV2 path");

    console.log(
      `  [QL DODO solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== getDy == on-chain querySellBase to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (1b) SOLO QL DODO sell-QUOTE — the OTHER direction (isSellBase=0) exercises the querySellQuote solver
  // branch; received == getDy(share) == the pool's own querySellQuote view to the WEI. The engine exec
  // (poolType 5) resolves the direction on-chain from `_BASE_TOKEN_()`, so a wrong direction bit / decode in
  // the querySellQuote branch would silently quote the wrong side — this cell is the direct coverage for it. ──
  async function runSoloQuote(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const op0 = offPoolQuote(("0x" + "00".repeat(20)) as Hex, {});
    const pool = await deployDodoV2Pool(c.walletClient, c.publicClient, deployParams(op0), caller);
    const op: DodoPool = { ...op0, address: pool };

    // amountIn within the rebalancing region (< Q0-Q = 200k quote) so the curve stays convex ⇒ the QL
    // ladder covers the whole trade.
    const amountIn = 100_000n * ONE;
    const ladder = buildDodoQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL DODO sell-quote ladder");
    const cover = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(cover, amountIn, "QL DODO sell-quote ladder covers the full amountIn (pool deep enough)");

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [dodoDescriptor(pool, 0, false, op.feePpm)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: DODO_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const onViewPre = await onQuerySellQuote(pool, caller, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL DODO sell-quote cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL DODO sell-quote venue)");
    assert.equal(poolIn, amountIn, "the DODO pool received the full quote input (transfer-first engine)");
    assert.equal(received, dodoGetDy(op, spent), "received == getDy(share) to the wei (exact-in-dy, sell-quote)");
    assert.equal(received, onViewPre, "received == on-chain querySellQuote view to the wei");
    assert.ok(received > 0n, "non-zero DODO fill through the engine _swapDODOV2 sellQuote path");

    console.log(
      `  [QL DODO sell-quote solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== getDy == on-chain querySellQuote to the wei; isSellBase=0 branch); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) QL DODO + a live V3 direct pool — bestKind 1 vs 3 in ONE merge; split == oracle wei-exact ──
  async function runDodoV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A CHEAP DODO near 1:1 (guide i=1, low fee) but SHALLOW (100k targets) vs a DEEP 1:1 V3 (0.30% fee):
    // the DODO near-region drains, its marginal drops below V3's, and V3 takes the deep tail — both fund.
    const op0 = offPool(("0x" + "00".repeat(20)) as Hex, {
      i: ONE, K: ONE / 10n, B0: 100_000n * ONE, Q0: 100_000n * ONE, B: 90_000n * ONE, Q: 110_000n * ONE,
      lpFeeRate: 5n * 10n ** 14n, mtFeeRate: 0n, feePpm: 500,
    });
    const pool = await deployDodoV2Pool(c.walletClient, c.publicClient, deployParams(op0), caller);
    const op: DodoPool = { ...op0, address: pool };

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const amountIn = 40_000n * ONE;
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({
      pools: [v3Opt, { dodo: op, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oDodo = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oDodo > 0n, `oracle splits across V3 + DODO (V3 ${oV3}, DODO ${oDodo})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [dodoDescriptor(pool, 0, true, op.feePpm)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: DODO_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const dodoInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "DODO+V3 cook() must succeed");

    const dodoIn = (await balanceOf(c.publicClient, tokenIn, pool)) - dodoInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(dodoIn > 0n && v3In > 0n, `both venues funded (DODO ${dodoIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(dodoIn, oDodo, "DODO awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL DODO+V3:${engine}] V3 in=${v3In} DODO in=${dodoIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) QL DODO + QL Curve — TWO QL venues of DIFFERENT segKind (3 + 1) in ONE qlv; per-leg exact-in-dy ──
  async function runDodoCurve(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A DEEP higher-fee Curve vs a CHEAP but SHALLOW near-1:1 DODO: the DODO draws first (cheaper fee) but
    // steepens fast (small targets), so its marginal crosses the Curve's and the DEEP Curve takes the tail —
    // BOTH QL venues fund and their on-chain-built ladders INTERLEAVE in the merged-stream DESC sort.
    const curveBal = [20_000n * ONE, 20_000n * ONE];
    const CURVE_A = 200n, CURVE_FEE = 3_000_000n; // 0.03% (1e10-scaled), dearer than DODO's 0.01% fee
    const curve = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], curveBal, [ONE, ONE], CURVE_A, CURVE_FEE, caller);
    const opCurve = offCurvePool(curve, curveBal, CURVE_A, CURVE_FEE);

    const op0 = offPool(("0x" + "00".repeat(20)) as Hex, {
      i: ONE, K: ONE / 5n, B0: 20_000n * ONE, Q0: 20_000n * ONE, B: 18_000n * ONE, Q: 22_000n * ONE,
      lpFeeRate: 1n * 10n ** 14n, mtFeeRate: 0n, feePpm: 100,
    });
    const pool = await deployDodoV2Pool(c.walletClient, c.publicClient, deployParams(op0), caller);
    const opDodo: DodoPool = { ...op0, address: pool };

    const amountIn = 15_000n * ONE;
    const oracle = optimalSplit({ pools: [{ curve: opCurve, feePpm: 0 }, { dodo: opDodo, feePpm: 0 }], amountIn, zeroForOne: true });
    const oCurve = oracle.perPoolInput[0] ?? 0n;
    const oDodo = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oCurve > 0n && oDodo > 0n, `oracle splits across QL Curve + QL DODO (Curve ${oCurve}, DODO ${oDodo})`);

    const qlv = [curveDescriptor(curve, 0, CURVE_FEE), dodoDescriptor(pool, 0, true, opDodo.feePpm)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: DODO_CURVE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const curveInBefore = await balanceOf(c.publicClient, tokenIn, curve);
    const dodoInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "QL DODO + QL Curve cook() must succeed");

    const curveIn = (await balanceOf(c.publicClient, tokenIn, curve)) - curveInBefore;
    const dodoIn = (await balanceOf(c.publicClient, tokenIn, pool)) - dodoInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(curveIn > 0n && dodoIn > 0n, `both QL venues funded (Curve ${curveIn}, DODO ${dodoIn})`);
    assert.equal(curveIn, oCurve, "Curve awarded input == oracle (wei-exact split)");
    assert.equal(dodoIn, oDodo, "DODO awarded input == oracle (wei-exact split)");
    // PER-LEG WEI-EXACT: received == get_dy_Curve(curveIn) + getDy_DODO(dodoIn). NO tolerance.
    assert.equal(received, curveGetDy(opCurve, curveIn) + dodoGetDy(opDodo, dodoIn), "received == Σ per-venue view(share) to the wei");

    console.log(
      `  [QL Curve+DODO:${engine}] Curve in=${curveIn} DODO in=${dodoIn} received=${received} ` +
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

    const op0 = offPool(("0x" + "00".repeat(20)) as Hex, {});
    const pool = await deployDodoV2Pool(c.walletClient, c.publicClient, deployParams(op0), caller);
    const op: DodoPool = { ...op0, address: pool };

    const amountIn = 100_000n * ONE;
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [dodoDescriptor(pool, 0, true, op.feePpm)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: DODO_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    // The pool absorbs the whole trade, so the quote == getDy(amountIn) to the wei (ladder built live).
    assert.equal(quoted, dodoGetDy(op, amountIn), "zero-cache QUOTE == getDy(amountIn) to the wei (ladder built live in the eth_call)");
    console.log(`  [QL DODO zero-cache quote:${engine}] quoted=${quoted} (== getDy(amountIn), no prepared cache)`);
  }

  // ── (5) ADVERSE DRIFT — move the DODO with a REAL sell BEFORE cooking; the live QL ladder re-anchors the
  // DODO↔V3 split to the drifted state. The bytecode carries NO PMM data — the SAME bytecode is cooked after
  // the drift; only the live querySell* the ladder reads changes. ──
  async function runDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A CHEAP near-1:1 DODO (draws before the 0.30% V3), sized so a real drift sell shrinks (but does not
    // zero) its share.
    const op0 = offPool(("0x" + "00".repeat(20)) as Hex, {
      i: ONE, K: ONE / 10n, B0: 100_000n * ONE, Q0: 100_000n * ONE, B: 90_000n * ONE, Q: 110_000n * ONE,
      lpFeeRate: 5n * 10n ** 14n, mtFeeRate: 0n, feePpm: 500,
    });
    const pool = await deployDodoV2Pool(c.walletClient, c.publicClient, deployParams(op0), caller);
    const opPre: DodoPool = { ...op0, address: pool };

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };

    const amountIn = 40_000n * ONE;
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [dodoDescriptor(pool, 0, true, opPre.feePpm)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: DODO_DEFINES },
    );

    // Baseline (pre-drift) oracle split — the DODO share the fresh pool would award.
    const oraclePre = optimalSplit({ pools: [v3Opt, { dodo: opPre, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const dodoSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(dodoSharePre > 0n, "baseline oracle awards the DODO venue a share");

    // ADVERSE DRIFT: a REAL sell of base INTO the DODO (transfer the base in, then call sellBase — the
    // transfer-first surface the engine uses) pushes it deeper into the base-scarce region (a prior trade
    // looks exactly like this on-chain), so its live querySellBase marginal drops.
    const driftAmt = 20_000n * ONE;
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: tokenIn, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, driftAmt],
        account: caller, chain: c.walletClient.chain,
      }),
    });
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: pool, abi: dodoAbi as Abi, functionName: "sellBase", args: [caller],
        account: caller, chain: c.walletClient.chain,
      }),
    });

    // Drifted oracle: reconstruct the DodoPool from the pool's LIVE PMM state after the drift sell.
    const opDrift = await readOffPool(pool, opPre);
    const oracleDrift = optimalSplit({ pools: [v3Opt, { dodo: opDrift, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const dodoShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(dodoShareDrift >= 0n && dodoShareDrift < dodoSharePre, `drift shrinks the DODO share (${dodoShareDrift} < ${dodoSharePre})`);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const dodoInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drift cook() SUCCEEDS — DODO ladder re-anchored to the live drifted state");

    const dodoIn = (await balanceOf(c.publicClient, tokenIn, pool)) - dodoInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(v3In > 0n, "V3 funded post-drift");
    assert.equal(dodoIn, dodoShareDrift, "DODO awarded input == drifted oracle (re-anchored to the live drifted state)");
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(dodoIn < dodoSharePre, `DODO share ADAPTED down after the drift (${dodoIn} < baseline ${dodoSharePre})`);
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(
      `  [QL DODO+V3 drift:${engine}] baseline DODO share=${dodoSharePre} → re-anchored=${dodoIn} ` +
        `(V3 grew to ${v3In}); spent=${spent} received=${received}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL DODO solo [${engine}] — on-chain ladder, received == getDy(share) wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL DODO sell-quote solo [${engine}] — querySellQuote (isSellBase=0) branch, received == getDy(share) wei-exact`, { skip }, async () => {
      await runSoloQuote(engine);
    });
    it(`QL DODO + V3 [${engine}] — sampled stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runDodoV3(engine);
    });
    it(`QL DODO + QL Curve [${engine}] — two QL segKinds in one loop, interleave + split == oracle`, { skip }, async () => {
      await runDodoCurve(engine);
    });
    it(`QL DODO zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL DODO + V3 adverse drift [${engine}] — split RE-ANCHORS to the live drifted state`, { skip }, async () => {
      await runDriftSplit(engine);
    });
  }
});
