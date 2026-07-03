/**
 * EcoSwap WOOFi (WooPPV2 synthetic proactive market maker, sPMM v2) QUOTE-LADDER (QL) local-EVM
 * integration — the callback-free live-walk gate + the live-oracle re-anchor proof.
 *
 * WOOFi is migrated to the QUOTE-LADDER framework (the same one the Curve StableSwap / CryptoSwap pilots
 * use): prepare ships ONLY a descriptor [poolAddr, _, _, feePpm, segKind=10, refIdx] — NO off-chain sampled
 * segments — and the on-chain solver BUILDS each WOOFi venue's price ladder in setup from LIVE cook-time
 * `tryQuery(tokenIn, tokenOut, xIn)` (the GRACEFUL WooPPV2 quote — NEVER reverts, returns 0 on a cap /
 * feasibility failure — decoded [0]; a PLAIN staticcall, treat 0 as stop, the SAME generalized qlv loop the
 * Curve pilot uses, dispatched on the descriptor segKind), emits the slices into the merged sampled-segment
 * stream, bounded-insertion-SORTs it DESC, and the SAME bestKind===1 cursor consumes it. Execution is
 * UNCHANGED (callback-free: on-chain `query` for the minToAmount + `token.transfer(pool, awarded)` — WooPPV2
 * is TRANSFER-FIRST — + `pool.swap(tokenIn, tokenOut, awarded, minTo, self, caller)`). WOOFi is oracle-priced
 * (NOT xy=k), so the engine's _swapV2 would mis-price it; the transfer-first swap needs NO engine dispatch.
 * This test stands up local WooFiPool.sol fixtures (whose _calc* sPMM quote / tryQuery / query mirror the
 * off-chain woofi-math.ts replay bit-for-bit, with a settable WooracleV2 state) + a real V3 pool + a Curve
 * StableSwap fixture, and asserts:
 *
 *   (1) SOLO QL WOOFi — the on-chain ladder is built from live tryQuery, covers [0, amountIn], and the
 *       caller-received dy == off-chain query(awarded share) == the pool's own on-chain query view, all to
 *       the WEI. NO tolerance.
 *   (2) QL WOOFi + a live V3 direct pool — the QL sampled-segment stream (bestKind 1) competes against the
 *       live V3 frontier (bestKind 3) in ONE merge; the per-venue split == the neutral oracle to the WEI
 *       (WOOFi via buildWooFiQLLadder, V3 via v3Segments), both venues funded.
 *   (3) QL WOOFi + QL Curve — TWO QL venues of DIFFERENT segKind (10 + 1) ride ONE qlv; the generalized
 *       ladder loop builds BOTH on-chain (dispatching the quote per-row on segKind) and INTERLEAVES them in
 *       the merged-stream sort; each leg received == its own view(share) to the wei, split == oracle.
 *   (4) ZERO-CACHE QUOTE — a read-only cook (eth_call) builds the ladder LIVE with NO prepared segments
 *       (only the descriptor) and returns the quote == query(amountIn). Proves the QL quote is prepare-optional.
 *   (5) ADVERSE DRIFT — move the WooracleV2 price DOWN with setState BEFORE cooking; the QL ladder reads the
 *       LIVE (moved) oracle via tryQuery at cook time and RE-ANCHORS (the WOOFi↔V3 split ADAPTS — the
 *       drifted WOOFi share SHRINKS, V3's grows), landing the DRIFTED oracle's split + exact-in-dy at the
 *       live moved oracle. This is the live-walk proof: no baked snapshot.
 *
 * No fork / no RPC env — local fixtures etch the whole stack. Runs on v1 (+ v12 when the v12 artifacts are
 * present), driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil. Mirrors ecoswap.crypto.evm.test.ts.
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
  deployWooFiPool,
  wooFiPoolAbi,
  deployCurveStableSwap,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { getDy, type CurvePool } from "../shared/curve-math";
import { query as wooFiQuery, buildWooFiQLLadder, type WooFiPool } from "../shared/woofi-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const HUGE = parseEther("1000000000");
const E18 = 10n ** 18n;
const E8 = 10n ** 8n;
// Canonical stablecoin sPMM params: base priced at $1 (1e8), 1 bp spread (1e14 WAD), a small gamma
// coefficient (1e9 WAD), 0.025% feeRate (25, 1e5-scaled). Both tokens 18-dec so the split engages both
// venues on the flat part of the curve. priceDec = 1e8 (WooracleV2 canonical).
const PRICE = E8;
const SPREAD = 10n ** 14n;
const COEFF = 10n ** 9n;
const FEE_RATE = 25n;
const PRICE_DEC = E8;
const ENGINE_CELLS = engineCells();

// WOOFi-only treeshake defines (HAS_WOOFI lights the on-chain QL ladder build's WOOFi quote branch + the
// segKind-10 accumulator + the callback-free query+transfer+swap exec; the live V3 frontier + merge core
// are unguarded (always on) so a mixed WOOFi+V3 universe still walks V3 with HAS_WOOFI alone). Mirrors
// index.ts protocolDefines.
const WOOFI_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: true,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
};

// WOOFi + Curve treeshake defines — BOTH QL adapter branches ship so the generalized qlv loop builds both a
// segKind-10 (WOOFi) and a segKind-1 (Curve StableSwap) ladder in one pass. The real production define set
// index.ts would emit for a WOOFi+Curve universe.
const WOOFI_CURVE_DEFINES: Record<string, boolean> = {
  ...WOOFI_DEFINES,
  HAS_CURVE: true,
  HAS_WOOFI: true,
};

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

// One QL WOOFi descriptor: [poolAddr, i, j, feePpm, segKind=10, refIdx]. i/j are UNUSED (WOOFi quotes by
// tokenIn/tokenOut, not a coin index); feePpm is informational (query is post-fee — the on-chain head
// needs no fee-adjust — so the descriptor's fee field is never read by the qlv loop).
function wooFiDescriptor(pool: Hex, refIdx: number, feePpm: number): bigint[] {
  return [BigInt(pool), 0n, 0n, BigInt(feePpm), 10n, BigInt(refIdx)];
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

describe("EcoSwap WOOFi (WooPPV2 sPMM) QL live-walk (local fixture) — on-chain ladder, exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the WOOFi base token (sellBase: base → quote)
  let tokenOut: Hex; // == the WOOFi quote token
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
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  // Off-chain WooFiPool descriptor for a deployed fixture: tokenIn is the base (sellBase), tokenOut the
  // quote, both 18-dec, price scale 1e8. price/spread/coeff are the LIVE oracle state (the QL ladder reads
  // it live via tryQuery, so this is seeded from whatever the pool holds at read time).
  function offPool(address: Hex, price: bigint, spread: bigint, coeff: bigint): WooFiPool {
    return {
      address, tokenIn, tokenOut, sellBase: true,
      price, spread, coeff, priceDec: PRICE_DEC, quoteDec: E18, baseDec: E18,
      feeRate: FEE_RATE, feePpm: 250, source: "local-fixture",
    };
  }

  // Deploy a WOOFi pool (base=tokenIn, quote=tokenOut) funded with base+quote reserves.
  async function deploy(coeff: bigint, baseRes: bigint, quoteRes: bigint, minter: Account): Promise<Hex> {
    return deployWooFiPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut,
      PRICE_DEC, E18, E18, PRICE, SPREAD, coeff, FEE_RATE, baseRes, quoteRes, minter,
    );
  }

  // The fixture's own on-chain query view — the engine-independent ground truth for the executed dy.
  async function onQuery(pool: Hex, amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: pool, abi: wooFiPoolAbi as Abi, functionName: "query", args: [tokenIn, tokenOut, amt],
    })) as bigint;
  }

  function offCurvePool(address: Hex, balances: bigint[], a: bigint, fee: bigint): CurvePool {
    return { poolType: 3, address, i: 0, j: 1, A: a, aPrecision: 100n, balances, rates: [E18, E18], feePpm10: fee, source: "local-fixture" };
  }

  // ── (1) SOLO QL WOOFi — the on-chain ladder is built live; received == query(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const pool = await deploy(COEFF, 2_000_000n * E18, 2_000_000n * E18, caller);
    const op = offPool(pool, PRICE, SPREAD, COEFF);

    const amountIn = 100_000n * E18;
    const ladder = buildWooFiQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL ladder");
    assert.equal(ladder.reduce((a, s) => a + s.capacity, 0n), amountIn, "QL ladder covers the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [wooFiDescriptor(pool, 0, 250)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: WOOFI_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    const onViewPre = await onQuery(pool, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL WOOFi cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL WOOFi venue)");
    assert.equal(poolIn, amountIn, "the WOOFi pool received the full input share (transfer-first)");
    assert.equal(received, wooFiQuery(op, spent), "received == query(share) to the wei (exact-in-dy)");
    assert.equal(received, onViewPre, "received == on-chain query view (exact-in-dy)");
    assert.ok(received > 0n, "non-zero WOOFi fill through the callback-free transfer+swap path");

    console.log(
      `  [QL WOOFi solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== query == on-chain query to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) QL WOOFi + a live V3 direct pool — bestKind 1 vs 3 in ONE merge; split == oracle wei-exact ──
  async function runWooFiV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A shallower WOOFi (bigger gamma coeff ⇒ steepens sooner) vs a DEEP 1:1 V3 pool, sized so the two
    // marginal curves CROSS inside [0, amountIn] and BOTH venues receive input.
    const pool = await deploy(COEFF * 8n, 1_000_000n * E18, 1_000_000n * E18, caller);
    const op = offPool(pool, PRICE, SPREAD, COEFF * 8n);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const amountIn = 300_000n * E18;
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({
      pools: [v3Opt, { woofi: op, feePpm: 0 }],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oWoo = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oWoo > 0n, `oracle splits across V3 + WOOFi (V3 ${oV3}, WOOFi ${oWoo})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [wooFiDescriptor(pool, 0, 250)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: WOOFI_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const wooInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "WOOFi+V3 cook() must succeed");

    const wooIn = (await balanceOf(c.publicClient, tokenIn, pool)) - wooInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(wooIn > 0n && v3In > 0n, `both venues funded (WOOFi ${wooIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(wooIn, oWoo, "WOOFi awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL WOOFi+V3:${engine}] V3 in=${v3In} WOOFi in=${wooIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) QL WOOFi + QL Curve — TWO QL venues of DIFFERENT segKind (10 + 1) in ONE qlv; the generalized
  // loop builds both + INTERLEAVES them in the sort; per-leg exact-in-dy; split == oracle. ──
  async function runWooFiCurve(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A mid-depth Curve (A=50, 0.005% fee — CHEAPER than WOOFi's 0.025% so it draws FIRST — but bends on
    // its 200k depth) vs a STEEPER WOOFi (bigger gamma coeff ⇒ its marginal falls with size). The two
    // marginal curves CROSS inside the trade, so BOTH QL venues (segKind 1 + 10) receive input and their
    // on-chain-built ladders INTERLEAVE in the merged-stream DESC sort.
    const curveBal = [200_000n * E18, 200_000n * E18];
    const CURVE_A = 50n, CURVE_FEE = 500_000n; // 0.005% (1e10-scaled), cheaper than WOOFi
    const curve = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], curveBal, [E18, E18], CURVE_A, CURVE_FEE, caller);
    const opCurve = offCurvePool(curve, curveBal, CURVE_A, CURVE_FEE);

    const wooCoeff = COEFF * 100n; // steeper gamma so the WOOFi marginal bends within the trade
    const pool = await deploy(wooCoeff, 2_000_000n * E18, 2_000_000n * E18, caller);
    const opWoo = offPool(pool, PRICE, SPREAD, wooCoeff);

    const amountIn = 300_000n * E18;
    const oracle = optimalSplit({ pools: [{ curve: opCurve, feePpm: 0 }, { woofi: opWoo, feePpm: 0 }], amountIn, zeroForOne: true });
    const oCurve = oracle.perPoolInput[0] ?? 0n;
    const oWoo = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oCurve > 0n && oWoo > 0n, `oracle splits across QL Curve + QL WOOFi (Curve ${oCurve}, WOOFi ${oWoo})`);

    // ONE qlv carrying BOTH families: a segKind-1 Curve descriptor + a segKind-10 WOOFi descriptor.
    const qlv = [curveDescriptor(curve, 0, CURVE_FEE), wooFiDescriptor(pool, 0, 250)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: WOOFI_CURVE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const curveInBefore = await balanceOf(c.publicClient, tokenIn, curve);
    const wooInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "QL WOOFi + QL Curve cook() must succeed");

    const curveIn = (await balanceOf(c.publicClient, tokenIn, curve)) - curveInBefore;
    const wooIn = (await balanceOf(c.publicClient, tokenIn, pool)) - wooInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(curveIn > 0n && wooIn > 0n, `both QL venues funded (Curve ${curveIn}, WOOFi ${wooIn})`);
    assert.equal(curveIn, oCurve, "Curve awarded input == oracle (wei-exact split)");
    assert.equal(wooIn, oWoo, "WOOFi awarded input == oracle (wei-exact split)");
    // PER-LEG WEI-EXACT-IN-DY: received == get_dy_Curve(curveIn) + query(wooIn). NO tolerance.
    assert.equal(received, getDy(opCurve, curveIn) + wooFiQuery(opWoo, wooIn), "received == Σ per-venue view(share) to the wei");

    console.log(
      `  [QL Curve+WOOFi:${engine}] Curve in=${curveIn} WOOFi in=${wooIn} received=${received} ` +
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

    const pool = await deploy(COEFF, 2_000_000n * E18, 2_000_000n * E18, caller);
    const op = offPool(pool, PRICE, SPREAD, COEFF);

    const amountIn = 100_000n * E18;
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [wooFiDescriptor(pool, 0, 250)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: WOOFI_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(quoted, wooFiQuery(op, amountIn), "zero-cache QUOTE == query(amountIn) to the wei (ladder built live in the eth_call)");
    console.log(`  [QL WOOFi zero-cache quote:${engine}] quoted=${quoted} (== query(amountIn), no prepared cache)`);
  }

  // ── (5) ADVERSE DRIFT — move the WooracleV2 price DOWN with setState BEFORE cooking. Because the QL
  // ladder is built from LIVE tryQuery at cook time (no baked snapshot), it RE-ANCHORS to the moved oracle:
  // a lower base price ⇒ fewer quote out ⇒ the WOOFi venue is less attractive, so the WOOFi↔V3 split ADAPTS
  // (the WOOFi share SHRINKS, V3's grows) and the exec is exact-in-dy at the moved oracle. ──
  async function runAdverseDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Fund the pool with EXTRA base so the moved-price (smaller quote-out) still leaves the base side deep.
    const pool = await deploy(COEFF * 8n, 1_500_000n * E18, 1_500_000n * E18, caller);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);

    const amountIn = 300_000n * E18;
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [wooFiDescriptor(pool, 0, 250)];
    // Bytecode built against the PRE-drift universe — the descriptor carries NO oracle state, so the SAME
    // bytecode is cooked after the price move; only the LIVE tryQuery the ladder reads changes.
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: WOOFI_DEFINES },
    );

    // Baseline (NO drift) oracle split — the WOOFi share the un-moved universe would award.
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const opPre = offPool(pool, PRICE, SPREAD, COEFF * 8n);
    const oraclePre = optimalSplit({ pools: [v3Opt, { woofi: opPre, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const wooSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(wooSharePre > 0n, "baseline oracle awards the WOOFi venue a share");

    // ADVERSE DRIFT: a keeper posts a LOWER base price (−2%) ⇒ each base sells for fewer quote ⇒ the WOOFi
    // venue prices WORSE for a base→quote trade. The QL ladder re-reads this LIVE via tryQuery.
    const movedPrice = (PRICE * 980n) / 1000n;
    const setHash = await c.walletClient.writeContract({
      address: pool, abi: wooFiPoolAbi as Abi, functionName: "setState",
      args: [movedPrice, SPREAD, COEFF * 8n, true], account: caller, chain: null,
    });
    await c.publicClient.waitForTransactionReceipt({ hash: setHash });
    const opDrift = offPool(pool, movedPrice, SPREAD, COEFF * 8n);
    const oracleDrift = optimalSplit({ pools: [v3Opt, { woofi: opDrift, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const wooShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(wooShareDrift > 0n, "drifted oracle still awards the WOOFi venue a (smaller) share");
    assert.ok(wooShareDrift < wooSharePre, `adverse drift shrinks the WOOFi share (${wooShareDrift} < ${wooSharePre})`);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const wooInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "adverse-drift WOOFi+V3 cook() must succeed");

    const wooIn = (await balanceOf(c.publicClient, tokenIn, pool)) - wooInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(wooIn > 0n && v3In > 0n, "both venues funded post-drift");
    // RE-ANCHORED: the on-chain split matches the DRIFTED oracle (built from the moved live oracle), NOT the
    // pre-drift baseline — the QL ladder walked the LIVE (moved) oracle via tryQuery.
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(wooIn, wooShareDrift, "WOOFi awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    // EXACT-IN-DY at the LIVE (moved) oracle: the received includes the WOOFi leg priced at the moved oracle.
    assert.ok(received > 0n, "caller receives tokenOut");
    assert.ok(wooIn < wooSharePre, `WOOFi share ADAPTED down after adverse drift (${wooIn} < baseline ${wooSharePre})`);

    console.log(
      `  [QL WOOFi+V3 adverse-drift:${engine}] baseline WOOFi share=${wooSharePre} → drifted=${wooIn} ` +
        `(V3 grew to ${v3In}); received=${received} (split RE-ANCHORED to live moved oracle)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL WOOFi solo [${engine}] — on-chain ladder, received == query(share) wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL WOOFi + V3 [${engine}] — sampled stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runWooFiV3(engine);
    });
    it(`QL WOOFi + QL Curve [${engine}] — two QL segKinds in one loop, interleave + split == oracle`, { skip }, async () => {
      await runWooFiCurve(engine);
    });
    it(`QL WOOFi zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL WOOFi + V3 adverse-drift [${engine}] — split RE-ANCHORS to the live moved oracle`, { skip }, async () => {
      await runAdverseDriftSplit(engine);
    });
  }
});
