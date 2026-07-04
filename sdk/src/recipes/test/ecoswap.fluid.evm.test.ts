/**
 * EcoSwap Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — a Liquidity-Layer-backed re-centering
 * AMM) QUOTE-LADDER (QL) local-EVM integration — the callback-free live-walk gate + the live-layer
 * re-anchor proof.
 *
 * Fluid is migrated to the QUOTE-LADDER framework (the same one WOOFi / Curve / every other non-CL family
 * uses): prepare ships ONLY a descriptor [poolAddr, swap0to1, _, feePpm, segKind=12, refIdx] — NO off-chain
 * sampled segments — and the on-chain solver BUILDS each Fluid venue's price ladder in setup from LIVE
 * cook-time `resolver.estimateSwapIn(dex, swap0to1, xNext, 0)` quote-differencing. estimateSwapIn is
 * GRACEFUL (the resolver's Solidity catch decodes the pool's FluidDexSwapResult revert and returns 0 for
 * ANY other underlying revert — utilization/borrow cap, paused), so the quote is a PLAIN single-return
 * call, 0 ⇒ stop, and the ladder SELF-TRUNCATES at the LIVE cap (the EulerSwap-inLimit class). NB it is a
 * CALL, not a staticcall (the real pool writes state on the ADDRESS_DEAD estimate path before its
 * result-revert), exactly like the exec's quote. The DIRECTION bit is derived ON-CHAIN per venue via the
 * resolver's getDexTokens vs the (edge) in-token — never trusted from off-chain data. Execution is
 * UNCHANGED (callback-free: live estimateSwapIn for the amountOutMin + `token.approve(pool, awarded)` +
 * `pool.swapIn(swap0to1, awarded, minOut, self)` — Fluid PULLS via safeTransferFrom, approve-first). This
 * test stands up local FluidDexPool.sol fixtures (whose layer math mirrors the closed-form replay below
 * bit-for-bit, with settable exchange rates / center price / out-caps) + a real V3 pool, and asserts:
 *
 *   (1) SOLO QL Fluid — the on-chain ladder is built from live estimateSwapIn, covers [0, amountIn], and
 *       the caller-received dy == the closed-form fixture replay == the resolver's own on-chain
 *       estimateSwapIn view, all to the WEI. NO tolerance.
 *   (2) QL Fluid + a live V3 direct pool — the QL sampled-segment stream (bestKind 1) competes against the
 *       live V3 frontier (bestKind 3) in ONE merge; the per-venue split == the neutral oracle to the WEI
 *       (Fluid via buildFluidQLLadder over the fixture replay, V3 via v3Segments), both venues funded.
 *   (3) REVERSE direction (token1 → token0) — the ladder + exec derive swap0to1 = false ON-CHAIN via
 *       getDexTokens (the direction bit is never trusted from the descriptor), received == the on-chain
 *       estimateSwapIn(swap0to1=false) view to the wei.
 *   (4) ZERO-CACHE QUOTE — a read-only cook (eth_call) builds the ladder LIVE with NO prepared segments
 *       (only the descriptor) and returns the quote == estimateSwapIn(amountIn). Genuinely 1-RPC-class:
 *       prepare-optional, zero sampled data (the deleted static path burned 24 estimateSwapIn RPCs per
 *       pool per prepare AND per quote).
 *   (5) ADVERSE DRIFT — the layer re-centers DOWN (setLayer) between compile and cook — the EXACT
 *       staleness class the deleted static segments suffered (the layer's exchange prices accrue every
 *       block). The QL ladder reads the LIVE (moved) layer at cook and RE-ANCHORS: the Fluid↔V3 split
 *       ADAPTS (the drifted Fluid share SHRINKS, V3's grows), landing the DRIFTED oracle's split wei-exact
 *       + exact-in-dy at the live moved layer. This is the live-walk proof: no baked snapshot.
 *   (6) UTILIZATION CAP — an out-cap makes estimateSwapIn quote 0 past the tradeable prefix; the on-chain
 *       ladder SELF-TRUNCATES at the live cap (graceful 0 ⇒ stop), the merge awards only the prefix
 *       (spent == oracle.totalInput < amountIn — compute-then-pull never over-pulls), received ==
 *       estimateSwapIn(spent).
 *
 * No fork / no RPC env — local fixtures etch the whole stack. Runs on v1 (+ v12 when the v12 artifacts are
 * present), driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil. Mirrors ecoswap.woofi.evm.test.ts.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
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
  deployFluidDexPool,
  fluidDexPoolAbi,
  fluidDexResolverAbi,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { buildFluidQLLadder, type FluidPool } from "../shared/fluid-math";

const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const FEE_SCALE = 10n ** 6n;
// A deep near-1:1 Fluid curve: exchange rates at par, 1:1 center price, 0.01% fee (100, 1e6-scaled). Both
// tokens 18-dec so the split engages venues on the flat part of the layer curve.
const FEE_PPM = 100n;
const RATE = E18; // par exchange rate both sides
const CENTER = E18; // 1:1 center price
// Utilization slippage depth (out reduced by amountIn²/DEPTH) — deep enough that a 100k swap stays near-1:1
// but the marginal genuinely descends so the split equalizes across venues of different depth.
const DEPTH = 20_000_000n * E18;
const ENGINE_CELLS = engineCells();

// Fluid-only treeshake defines (HAS_FLUID lights the on-chain QL ladder build's Fluid quote branch — the
// per-venue getDexTokens direction prelude + the graceful estimateSwapIn CALL — plus the segKind-12
// accumulator + the callback-free approve+swapIn exec; the live V3 frontier + merge core are unguarded
// (always on) so a mixed Fluid+V3 universe still walks V3 with HAS_FLUID alone). Mirrors index.ts
// protocolDefines.
const FLUID_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: true, HAS_MENTO: false, HAS_BALANCER_V3: false,
};

// The solver's 6 compiler args (index.ts order): cfg, pools, netCache, routing, segs, qlv. cfg[6] is the
// chain-wide Fluid DEX resolver (the estimateSwapIn quote + getDexTokens orientation target).
function args(
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  resolver: Hex,
  directCount: number,
  pools: bigint[][],
  qlv: bigint[][],
): unknown[] {
  return [
    [
      BigInt(tokenIn), BigInt(tokenOut), amountIn, BigInt(caller),
      MIN_SQRT_RATIO + 1n, BigInt(directCount), BigInt(resolver),
    ],
    pools,
    [], // netCache
    [], // routing
    [], // segs — the VESTIGIAL static stream (production always ships []; the QL ladders feed the merge)
    qlv,
  ];
}

// One QL Fluid descriptor: [poolAddr, swap0to1, j, feePpm, segKind=12, refIdx]. swap0to1 is informational
// (the solver derives the direction ON-CHAIN via the resolver's getDexTokens vs the in-token); feePpm is
// informational too (estimateSwapIn is post-fee — the on-chain head needs no fee-adjust).
function fluidDescriptor(pool: Hex, swap0to1: boolean, refIdx: number, feePpm: number): bigint[] {
  return [BigInt(pool), swap0to1 ? 1n : 0n, 0n, BigInt(feePpm), 12n, BigInt(refIdx)];
}

// A live V3 direct-pool tuple with windowTop=0 (no cache ⇒ the solver staticcalls ticks() for every
// boundary from the live spot). A single wide V3 position ⇒ constant active L over the walk region.
function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, BigInt(pool), BigInt(feePpm), BigInt(tickSpacing), 0n, BigInt(feePpm), 0n,
    inIsToken0 ? 1n : 0n, 0n, 0n, getSqrtRatioAtTick(tickSpacing), 0n, 0n, 0n, 0n, 0n, 0n,
  ];
}

describe("EcoSwap Fluid DEX (Instadapp FluidDexT1 Liquidity-Layer re-centering AMM) QL live-walk (local fixture) — on-chain ladder, exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let token0: Hex; // the Fluid token0 (swap0to1: token0 → token1)
  let token1: Hex; // the Fluid token1
  let solverSrc: string;

  async function setup(): Promise<void> {
    // Tear the prior anvil down and WAIT for it to fully exit (port released) before booting the next.
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

  before(setup);
  after(() => {
    anvil?.stop();
  });

  // ── The closed-form replay of the FluidDexPool.sol fixture's layer math (bit-for-bit) ──
  // grossOut = swap0to1 ? ((dx·r0/r1)·center/1e18) : ((dx·r1/r0)·1e18/center), minus the convex
  // utilization slip dx²/depth, minus the fee off the output, then the out-cap ⇒ 0 (the GRACEFUL
  // resolver contract). This is the fixture MODEL (the real Fluid pool has no closed form — the
  // prod-mirror instead prefetches the REAL resolver's quotes at the deterministic QL grid).
  function fixtureQuote(
    swap0to1: boolean, dx: bigint,
    rate0: bigint = RATE, rate1: bigint = RATE, center: bigint = CENTER,
    feePpm: bigint = FEE_PPM, depth: bigint = DEPTH, outCap: bigint = 0n,
  ): bigint {
    if (dx <= 0n) return 0n;
    let par: bigint;
    if (swap0to1) {
      const g = (dx * rate0) / rate1;
      par = (g * center) / E18;
    } else {
      const g2 = (dx * rate1) / rate0;
      par = (g2 * E18) / center;
    }
    if (depth !== 0n) {
      const slip = (dx * dx) / depth;
      par = par > slip ? par - slip : 0n;
    }
    const fee = (par * feePpm) / FEE_SCALE;
    const net = par > fee ? par - fee : 0n;
    if (outCap !== 0n && net > outCap) return 0n;
    return net;
  }

  // The oracle's FluidPool model for a deployed fixture — descriptor + the closed-form getDy replay.
  function offPool(pool: Hex, resolver: Hex, swap0to1: boolean, getDy: (dx: bigint) => bigint): FluidPool {
    return {
      address: pool, resolver, swap0to1,
      tokenIn: swap0to1 ? token0 : token1, tokenOut: swap0to1 ? token1 : token0,
      feePpm: Number(FEE_PPM), source: "local-fixture", getDy,
    };
  }

  // Deploy a Fluid pool (token0/token1) + its resolver, funded with both reserves. `depth` sets the
  // utilization slippage (larger ⇒ deeper/flatter). Reserves must cover the out.
  async function deploy(
    center: bigint, res0: bigint, res1: bigint, depth: bigint, minter: Account,
  ): Promise<{ pool: Hex; resolver: Hex }> {
    return deployFluidDexPool(
      c.walletClient, c.publicClient, token0, token1, RATE, RATE, center, FEE_PPM, res0, res1, depth, minter,
    );
  }

  // The resolver's own on-chain estimateSwapIn view — the engine-independent ground truth for the executed
  // dy. amountOutMin 0 ⇒ pure quote.
  async function onQuery(pool: Hex, resolver: Hex, swap0to1: boolean, amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: resolver, abi: fluidDexResolverAbi as Abi, functionName: "estimateSwapIn",
      args: [pool, swap0to1, amt, 0n],
    })) as bigint;
  }

  // ── (1) SOLO QL Fluid — the on-chain ladder is built live; received == estimateSwapIn(share) wei ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const { pool, resolver } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);
    const op = offPool(pool, resolver, true, (dx) => fixtureQuote(true, dx));

    const amountIn = 100_000n * E18;
    const ladder = buildFluidQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL ladder");
    assert.equal(ladder.reduce((a, s) => a + s.capacity, 0n), amountIn, "QL ladder covers the full amountIn");
    // The model IS the fixture: the closed-form replay == the resolver's live view at every grid point.
    assert.equal(await onQuery(pool, resolver, true, amountIn), fixtureQuote(true, amountIn),
      "closed-form fixture replay == on-chain estimateSwapIn (model bit-exact)");

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, resolver, 0, [], [fluidDescriptor(pool, true, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: FLUID_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const poolInBefore = await balanceOf(c.publicClient, token0, pool);

    const onViewPre = await onQuery(pool, resolver, true, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL Fluid cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, token0, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL Fluid venue)");
    assert.equal(poolIn, amountIn, "the Fluid pool received the full input share (approve + pull)");
    assert.equal(received, fixtureQuote(true, spent), "received == closed-form quote(share) to the wei (exact-in-dy)");
    assert.equal(received, onViewPre, "received == on-chain estimateSwapIn view (exact-in-dy)");
    assert.ok(received > 0n, "non-zero Fluid fill through the callback-free approve+swapIn path");

    console.log(
      `  [QL Fluid solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== estimateSwapIn to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) QL Fluid + a live V3 direct pool — bestKind 1 vs 3 in ONE merge; split == oracle wei-exact ──
  async function runFluidV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A shallower Fluid (smaller depth ⇒ steepens sooner) vs a DEEP 1:1 V3 pool, sized so the two
    // marginal curves CROSS inside [0, amountIn] and BOTH venues receive input.
    const FLUID_DEPTH = 8_000_000n * E18;
    const { pool, resolver } = await deploy(CENTER, 3_000_000n * E18, 3_000_000n * E18, FLUID_DEPTH, caller);
    const op = offPool(pool, resolver, true, (dx) => fixtureQuote(true, dx, RATE, RATE, CENTER, FEE_PPM, FLUID_DEPTH));

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const amountIn = 300_000n * E18;
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({
      pools: [v3Opt, { fluid: op, feePpm: 0 }],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oFluid = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oFluid > 0n, `oracle splits across V3 + Fluid (V3 ${oV3}, Fluid ${oFluid})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [fluidDescriptor(pool, true, 0, Number(FEE_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, resolver, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: FLUID_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const fluidInBefore = await balanceOf(c.publicClient, token0, pool);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "Fluid+V3 cook() must succeed");

    const fluidIn = (await balanceOf(c.publicClient, token0, pool)) - fluidInBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.ok(fluidIn > 0n && v3In > 0n, `both venues funded (Fluid ${fluidIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(fluidIn, oFluid, "Fluid awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL Fluid+V3:${engine}] V3 in=${v3In} Fluid in=${fluidIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) REVERSE direction (token1 → token0) — swap0to1=false derived ON-CHAIN via getDexTokens ──
  async function runReverse(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const { pool, resolver } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);

    const amountIn = 100_000n * E18;
    // tokenIn = token1 ⇒ swap0to1 = false. The DESCRIPTOR stamp is informational — the solver derives the
    // bit on-chain (getDexTokens[0] != tokenIn ⇒ flQz = 0), so ladder + exec quote the 1→0 direction.
    const { bytecodes } = compileSauce(
      solverSrc,
      args(token1, token0, amountIn, caller, resolver, 0, [], [fluidDescriptor(pool, false, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: FLUID_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token1, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token1, caller);
    const outBefore = await balanceOf(c.publicClient, token0, caller);
    const onViewPre = await onQuery(pool, resolver, false, amountIn);
    assert.equal(onViewPre, fixtureQuote(false, amountIn), "reverse closed-form replay == on-chain view");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "reverse-direction QL Fluid cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, token1, caller));
    const received = (await balanceOf(c.publicClient, token0, caller)) - outBefore;
    assert.equal(spent, amountIn, "spent == amountIn (whole trade through the reverse Fluid venue)");
    assert.equal(received, onViewPre, "received == on-chain estimateSwapIn(swap0to1=false) view to the wei");

    console.log(`  [QL Fluid reverse:${engine}] spent=${spent} received=${received} (direction derived on-chain)`);
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

    const { pool, resolver } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);

    const amountIn = 100_000n * E18;
    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, resolver, 0, [], [fluidDescriptor(pool, true, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: FLUID_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(quoted, fixtureQuote(true, amountIn), "zero-cache QUOTE == estimateSwapIn(amountIn) to the wei (ladder built live in the eth_call)");
    console.log(`  [QL Fluid zero-cache quote:${engine}] quoted=${quoted} (== estimateSwapIn(amountIn), no prepared data)`);
  }

  // ── (5) ADVERSE DRIFT — the layer re-centers DOWN between compile and cook. Because the QL ladder is
  // built from LIVE estimateSwapIn at cook time (no baked snapshot — the deleted static segs baked one),
  // it RE-ANCHORS to the moved layer: a lower center ⇒ fewer token1 out ⇒ the Fluid venue is less
  // attractive, so the Fluid↔V3 split ADAPTS (the Fluid share SHRINKS, V3's grows) and the exec is
  // exact-in-dy at the moved layer. ──
  async function runAdverseDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const FLUID_DEPTH = 8_000_000n * E18;
    const { pool, resolver } = await deploy(CENTER, 3_000_000n * E18, 3_000_000n * E18, FLUID_DEPTH, caller);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);

    const amountIn = 300_000n * E18;
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [fluidDescriptor(pool, true, 0, Number(FEE_PPM))];
    // Bytecode built against the PRE-drift universe — the descriptor carries NO layer state, so the SAME
    // bytecode is cooked after the move; only the LIVE estimateSwapIn the ladder reads changes.
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, resolver, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: FLUID_DEFINES },
    );

    // Baseline (NO drift) oracle split — the Fluid share the un-moved universe would award.
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const opPre = offPool(pool, resolver, true, (dx) => fixtureQuote(true, dx, RATE, RATE, CENTER, FEE_PPM, FLUID_DEPTH));
    const oraclePre = optimalSplit({ pools: [v3Opt, { fluid: opPre, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const fluidSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(fluidSharePre > 0n, "baseline oracle awards the Fluid venue a share");

    // ADVERSE DRIFT: the layer re-centers DOWN (−2% token1-per-token0) — the exact accrual/re-centering
    // staleness class the static prepare-sampled segments suffered. The QL ladder re-reads this LIVE.
    const movedCenter = (CENTER * 98n) / 100n;
    const setHash = await c.walletClient.writeContract({
      address: pool, abi: fluidDexPoolAbi as Abi, functionName: "setLayer",
      args: [RATE, RATE, movedCenter],
      account: c.walletClient.account as Account, chain: c.walletClient.chain,
    });
    await c.publicClient.waitForTransactionReceipt({ hash: setHash });
    const opDrift = offPool(pool, resolver, true, (dx) => fixtureQuote(true, dx, RATE, RATE, movedCenter, FEE_PPM, FLUID_DEPTH));
    assert.equal(await onQuery(pool, resolver, true, amountIn), opDrift.getDy(amountIn), "drifted replay == live view");
    const oracleDrift = optimalSplit({ pools: [v3Opt, { fluid: opDrift, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const fluidShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(fluidShareDrift < fluidSharePre, `adverse drift shrinks the Fluid share (${fluidShareDrift} < ${fluidSharePre})`);

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const fluidInBefore = await balanceOf(c.publicClient, token0, pool);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "adverse-drift Fluid+V3 cook() must succeed");

    const fluidIn = (await balanceOf(c.publicClient, token0, pool)) - fluidInBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    // RE-ANCHORED: the on-chain split matches the DRIFTED oracle (built from the moved live layer), NOT
    // the pre-drift baseline — the QL ladder walked the LIVE (moved) layer via estimateSwapIn.
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(fluidIn, fluidShareDrift, "Fluid awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");
    assert.ok(fluidIn < fluidSharePre, `Fluid share ADAPTED down after adverse drift (${fluidIn} < baseline ${fluidSharePre})`);

    console.log(
      `  [QL Fluid+V3 adverse-drift:${engine}] baseline Fluid share=${fluidSharePre} → drifted=${fluidIn} ` +
        `(V3 grew to ${v3In}); received=${received} (split RE-ANCHORED to the live moved layer)`,
    );
  }

  // ── (6) UTILIZATION CAP — the graceful 0-quote self-truncates the on-chain ladder at the live cap. ──
  async function runCapTruncation(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const { pool, resolver } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);
    // An out-cap ≈ the net out of ~60k tokenIn: grid points above it quote 0 (the fixture's
    // utilization/borrow cap surface — the SAME graceful-0 the real resolver returns past the cap).
    const OUT_CAP = fixtureQuote(true, 60_000n * E18);
    const capHash = await c.walletClient.writeContract({
      address: pool, abi: fluidDexPoolAbi as Abi, functionName: "setCaps", args: [0n, OUT_CAP],
      account: c.walletClient.account as Account, chain: c.walletClient.chain,
    });
    await c.publicClient.waitForTransactionReceipt({ hash: capHash });

    const amountIn = 200_000n * E18;
    const getDy = (dx: bigint): bigint => fixtureQuote(true, dx, RATE, RATE, CENTER, FEE_PPM, DEPTH, OUT_CAP);
    const op = offPool(pool, resolver, true, getDy);
    assert.equal(await onQuery(pool, resolver, true, amountIn), 0n, "past the cap the live view quotes 0 (graceful)");
    const oracle = optimalSplit({ pools: [{ fluid: op, feePpm: 0 }], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n && awarded < amountIn, `cap truncates the award below amountIn (${awarded})`);

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, resolver, 0, [], [fluidDescriptor(pool, true, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: FLUID_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const liveAtAward = await onQuery(pool, resolver, true, awarded);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cap-truncated QL Fluid cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    // compute-then-pull: only the tradeable prefix is pulled — no over-pull, no refund needed.
    assert.equal(spent, awarded, "spent == oracle award (the ladder self-truncated at the live cap)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput < amountIn");
    assert.equal(received, liveAtAward, "received == estimateSwapIn(awarded) to the wei");
    assert.ok(received > 0n && received <= OUT_CAP, "the filled out respects the cap");

    console.log(
      `  [QL Fluid cap:${engine}] amountIn=${amountIn} awarded=${awarded} received=${received} ` +
        `(ladder self-truncated at the live utilization cap)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL Fluid solo [${engine}] — on-chain ladder, received == estimateSwapIn(share) wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL Fluid + V3 [${engine}] — sampled stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runFluidV3(engine);
    });
    it(`QL Fluid reverse [${engine}] — swap0to1=false derived on-chain via getDexTokens`, { skip }, async () => {
      await runReverse(engine);
    });
    it(`QL Fluid zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared data`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL Fluid + V3 adverse-drift [${engine}] — split RE-ANCHORS to the live moved layer`, { skip }, async () => {
      await runAdverseDriftSplit(engine);
    });
    it(`QL Fluid utilization cap [${engine}] — graceful 0 self-truncates the ladder at the live cap`, { skip }, async () => {
      await runCapTruncation(engine);
    });
  }
});
