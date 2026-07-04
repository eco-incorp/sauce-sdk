/**
 * EcoSwap Tessera V (Wintermute TesseraSwap wrapper + private engine — treasury-funded prop-AMM)
 * QUOTE-LADDER (QL) local-EVM integration — the live-walk tesseraSwapViewAmounts ladder + the
 * callback-free exact-in-dy gate + the PRIORITY-FEE-threshold pin.
 *
 * Tessera is a QUOTE-LADDER family (segKind 15): prepare ships ONLY a descriptor [wrapper, _, _, feePpm,
 * segKind=15, refIdx] — NO off-chain sampled ladder — and the on-chain solver BUILDS each venue's price
 * ladder in setup from LIVE cook-time `tesseraSwapViewAmounts(tokenIn, tokenOut, +xNext)[1]` (the SECOND
 * return is the exact-in out; PROBE-THEN-DECODE — the view is revert-class: unsupported pair "T33" / zero
 * "T10", fork-probed on the REAL Base wrapper). EXEC is callback-free — a probe-then-decoded
 * viewAmounts staticcall for amountCheck + approve + `tesseraSwapWithAllowances(..., self, "")` (Tessera
 * PULLS via transferFrom and pays from its treasury).
 *
 * The oracle prices Tessera via buildTesseraQLLadder driven by a bit-exact TS replay of the fixture's
 * closed form (the same getDy-model contract the Fluid family uses), so oracle == solver to the WEI.
 *
 *   (1) SOLO QL Tessera — ladder built from live viewAmounts, covers [0, amountIn], received ==
 *       viewAmounts(share)[1] == the wrapper's own view, all to the WEI.
 *   (2) QL Tessera + a live V3 direct pool — the QL stream vs the live V3 frontier in ONE merge; the
 *       per-venue split == the neutral oracle to the WEI.
 *   (3) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared segments, quote ==
 *       viewAmounts(amountIn)[1] to the wei.
 *   (4) ADVERSE DRIFT — the maker posts a SHALLOWER curve (setState) BEFORE cooking the pre-drift
 *       bytecode; the QL ladder reads the LIVE (worse) view and the Tessera↔V3 split RE-ANCHORS.
 *   (5) PRIORITY-FEE THRESHOLD (the ship-blocker pin) — the fixture reproduces the fork-measured engine
 *       semantics (tx.gasprice > globalPrioFeeThresholddd1337 ⇒ the quote widens by a small spread; the
 *       swap NEVER reverts; quote+exec read the SAME tx.gasprice). Cook the SAME universe once BELOW and
 *       once ABOVE the threshold (legacy gasPrice-pinned txs): BOTH succeed, each fill == the
 *       same-gasprice oracle/on-chain view to the WEI, and the above-threshold fill is strictly smaller
 *       (the widened spread) — proving no discovery/exec guard is needed at any gas price.
 *
 * No fork / no RPC env — local fixtures etch the whole stack. Runs on v1 (+ v12 when the v12 artifacts
 * are present), driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil. Mirrors
 * ecoswap.fermi.evm.test.ts.
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
  deployTesseraSwap,
  tesseraSwapFixtureAbi,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { buildTesseraQLLadder, type TesseraPool } from "../shared/tessera-math";

const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const FEE_SCALE = 10n ** 6n;
const FEE_PPM = 300n; // 0.03% (1e6-scaled), folded into the quote
// The fixture's prio-fee knob — mirrors the REAL engine's globalPrioFeeThresholddd1337 (2 gwei) + the
// fork-observed sub-bp spread widening above it (here 100 ppm = 1 bp, big enough to assert on).
const PRIO_THRESHOLD = 2_000_000_000n; // 2 gwei
const PRIO_WIDEN_PPM = 100n; // 1 bp extra spread above the threshold
const ENGINE_CELLS = engineCells();

// Tessera-only treeshake defines (HAS_TESSERA lights the QL ladder's probe-then-decode branch + the
// segKind-15 accumulator + the callback-free exec; the live V3 frontier + merge core are unguarded).
const TESSERA_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
  HAS_TESSERA: true, HAS_ELFOMO: false,
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

// One QL Tessera descriptor: [wrapper, _, _, feePpm, segKind=15, refIdx]. Tessera quotes by
// tokenIn/tokenOut, so qd[1]/qd[2] are unused; feePpm is informational (viewAmounts is post-fee).
function tesseraDescriptor(pool: Hex, refIdx: number, feePpm: number): bigint[] {
  return [BigInt(pool), 0n, 0n, BigInt(feePpm), 15n, BigInt(refIdx)];
}

function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, BigInt(pool), BigInt(feePpm), BigInt(tickSpacing), 0n, BigInt(feePpm), 0n,
    inIsToken0 ? 1n : 0n, 0n, 0n, getSqrtRatioAtTick(tickSpacing), 0n, 0n, 0n, 0n, 0n, 0n,
  ];
}

// Bit-exact TS replay of the fixture's private closed form (sellX: X → Y) INCLUDING the prio-fee
// widening — the `getDy` quote model buildTesseraQLLadder consumes (the Fluid-family model contract).
// `above` selects the above-threshold branch (tx.gasprice > threshold) the fixture applies to BOTH the
// view and the swap.
function tesseraGetDy(K: bigint, base: bigint, above: boolean): (dx: bigint) => bigint {
  return (dx: bigint): bigint => {
    if (dx <= 0n || base === 0n || K === 0n) return 0n;
    const gross = K / base - K / (base + dx);
    if (gross === 0n) return 0n;
    const fee = (gross * FEE_PPM) / FEE_SCALE;
    let net = gross > fee ? gross - fee : 0n;
    if (net > 0n && above) {
      const widen = (net * PRIO_WIDEN_PPM) / FEE_SCALE;
      net = net > widen ? net - widen : 0n;
    }
    return net;
  };
}

describe("EcoSwap Tessera V QL live-walk (local fixture) — on-chain viewAmounts ladder + callback-free exec + prio-fee pin", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the Tessera X token (sellX: X → Y)
  let tokenOut: Hex; // == the Tessera Y token
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

  after(() => {
    anvil?.stop();
  });

  // Deploy a Tessera wrapper (X=tokenIn, Y=tokenOut) funded with X+Y treasury reserves. `v0` sets the
  // near-1:1 curve (K=v0², base=v0). Larger v0 ⇒ flatter/deeper.
  async function deploy(v0: bigint, xRes: bigint, yRes: bigint, minter: Account): Promise<Hex> {
    return deployTesseraSwap(
      c.walletClient, c.publicClient, tokenIn, tokenOut, v0 * v0, v0, FEE_PPM,
      PRIO_THRESHOLD, PRIO_WIDEN_PPM, xRes, yRes, minter,
    );
  }

  // The fixture's own on-chain view — the engine-independent ground truth. Returns [1] (out). NB an
  // eth_call carries gasPrice 0 on this anvil ⇒ the BELOW-threshold quote (the widened branch is
  // asserted via the TS model + realized balances in the prio cell).
  async function onView(pool: Hex, amt: bigint): Promise<bigint> {
    const r = (await c.publicClient.readContract({
      address: pool, abi: tesseraSwapFixtureAbi as Abi, functionName: "tesseraSwapViewAmounts",
      args: [tokenIn, tokenOut, amt],
    })) as readonly [bigint, bigint];
    return r[1];
  }

  // Off-chain TesseraPool model — the bit-exact closed-form replay (NO RPC), per tessera-math.ts.
  function offPool(address: Hex, v0: bigint, above = false): TesseraPool {
    return {
      address, tokenIn, tokenOut, feePpm: Number(FEE_PPM), source: "local-fixture",
      getDy: tesseraGetDy(v0 * v0, v0, above),
    };
  }

  // ── (1) SOLO QL Tessera — the on-chain ladder is built live; received == viewAmounts(share)[1] wei ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const V0 = 10_000_000n * E18;
    const pool = await deploy(V0, 2_000_000n * E18, 2_000_000n * E18, caller);

    const amountIn = 100_000n * E18;
    const op = offPool(pool, V0);
    const ladder = buildTesseraQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL Tessera ladder");
    const cover = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(cover, amountIn, "QL Tessera ladder covers the full amountIn (treasury deep enough)");

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [tesseraDescriptor(pool, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: TESSERA_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const onViewPre = await onView(pool, amountIn);
    assert.equal(onViewPre, op.getDy(amountIn), "TS closed-form model == the fixture view (bit-exact)");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL Tessera cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL Tessera venue)");
    assert.equal(poolIn, amountIn, "the wrapper pulled the full input share (approve + pull)");
    assert.equal(received, onViewPre, "received == on-chain tesseraSwapViewAmounts to the wei");
    assert.ok(received > 0n, "non-zero Tessera fill through the callback-free approve+swap path");

    console.log(
      `  [QL Tessera solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== on-chain viewAmounts to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) QL Tessera + a live V3 direct pool — split == oracle wei-exact ──
  async function runTesseraV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A deep/flat Tessera (v0=50M, cheap 0.03% fee) vs a DEEP 1:1 V3 (0.30% fee): Tessera fills the
    // cheap near region, its marginal drops below V3's, V3 takes the tail — both fund.
    const V0 = 50_000_000n * E18;
    const pool = await deploy(V0, 2_000_000n * E18, 2_000_000n * E18, caller);
    const amountIn = 100_000n * E18;
    const op = offPool(pool, V0);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({ pools: [v3Opt, { tessera: op, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oTes = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oTes > 0n, `oracle splits across V3 + Tessera (V3 ${oV3}, Tessera ${oTes})`);

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [tesseraDescriptor(pool, 0, Number(FEE_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: TESSERA_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const tesInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "Tessera+V3 cook() must succeed");

    const tesIn = (await balanceOf(c.publicClient, tokenIn, pool)) - tesInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(tesIn > 0n && v3In > 0n, `both venues funded (Tessera ${tesIn}, V3 ${v3In})`);
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(tesIn, oTes, "Tessera awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL Tessera+V3:${engine}] V3 in=${v3In} Tessera in=${tesIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared cache/segments ──
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
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [tesseraDescriptor(pool, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: TESSERA_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(quoted, await onView(pool, amountIn), "zero-cache QUOTE == viewAmounts(amountIn)[1] to the wei (ladder built live in the eth_call)");
    console.log(`  [QL Tessera zero-cache quote:${engine}] quoted=${quoted} (== viewAmounts(amountIn)[1], no prepared cache)`);
  }

  // ── (4) ADVERSE DRIFT — the maker posts a SHALLOWER curve (setState) BEFORE cooking; the live QL
  // ladder re-anchors the Tessera↔V3 split to the drifted (worse) state. SAME bytecode post-drift. ──
  async function runDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const V0 = 50_000_000n * E18;
    const pool = await deploy(V0, 2_000_000n * E18, 2_000_000n * E18, caller);
    const amountIn = 100_000n * E18;

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [tesseraDescriptor(pool, 0, Number(FEE_PPM))];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: TESSERA_DEFINES },
    );

    const oraclePre = optimalSplit({ pools: [v3Opt, { tessera: offPool(pool, V0), feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const tesSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(tesSharePre > 0n, "baseline oracle awards the Tessera venue a share");

    // ADVERSE DRIFT: the maker posts a SHALLOWER curve (v0/5 ⇒ steeper, more slippage).
    const V0drift = V0 / 5n;
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: pool, abi: tesseraSwapFixtureAbi as Abi, functionName: "setState",
        args: [V0drift * V0drift, V0drift], account: caller, chain: c.walletClient.chain,
      }),
    });

    const oracleDrift = optimalSplit({ pools: [v3Opt, { tessera: offPool(pool, V0drift), feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const tesShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(tesShareDrift < tesSharePre, `drift shrinks the Tessera share (${tesShareDrift} < ${tesSharePre})`);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const tesInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drift cook() SUCCEEDS — Tessera ladder re-anchored to the live drifted state");

    const tesIn = (await balanceOf(c.publicClient, tokenIn, pool)) - tesInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(v3In > 0n, "V3 funded post-drift");
    assert.equal(tesIn, tesShareDrift, "Tessera awarded input == drifted oracle (re-anchored to the live drifted state)");
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(tesIn < tesSharePre, `Tessera share ADAPTED down after the drift (${tesIn} < baseline ${tesSharePre})`);
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(
      `  [QL Tessera+V3 drift:${engine}] baseline Tessera share=${tesSharePre} → re-anchored=${tesIn} ` +
        `(V3 grew to ${v3In}); spent=${spent} received=${received}`,
    );
  }

  // ── (5) PRIORITY-FEE THRESHOLD — cook the SAME solo universe BELOW then ABOVE the ~2-gwei knob ──
  // The fixture reproduces the fork-measured REAL-engine semantics: tx.gasprice > threshold ⇒ the quote
  // widens (here 1 bp) on BOTH the view and the swap; the swap NEVER reverts; quote+exec read the SAME
  // tx.gasprice ⇒ the solver's same-tx quote-as-amountCheck is coherent at any gas price. Assert both
  // cooks land, each fill == the same-gasprice model to the WEI, and above < below.
  async function runPrioFee(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const V0 = 10_000_000n * E18;
    const pool = await deploy(V0, 2_000_000n * E18, 2_000_000n * E18, caller);
    const amountIn = 50_000n * E18;

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [tesseraDescriptor(pool, 0, Number(FEE_PPM))]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: TESSERA_DEFINES },
    );

    // BELOW the threshold (2 gwei exactly == in-band: the engine keys on tx.gasprice > threshold).
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore1 = await balanceOf(c.publicClient, tokenOut, caller);
    const { receipt: r1 } = await cook(c.walletClient, c.publicClient, target, bytecodes, undefined, PRIO_THRESHOLD);
    assert.equal(r1.status, "success", "below-threshold cook() must succeed");
    const receivedBelow = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore1;
    const expectBelow = tesseraGetDy(V0 * V0, V0, false)(amountIn);
    assert.equal(receivedBelow, expectBelow, "below-threshold fill == the in-band quote model to the wei");

    // ABOVE the threshold (5 gwei): the quote widens but the swap LANDS — the solver's live quote and
    // the exec's amountCheck read the SAME tx.gasprice, so the pair is coherent by construction (the
    // fork-proven REAL-engine behavior this fixture pins).
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore2 = await balanceOf(c.publicClient, tokenOut, caller);
    const { receipt: r2 } = await cook(c.walletClient, c.publicClient, target, bytecodes, undefined, 5_000_000_000n);
    assert.equal(r2.status, "success", "above-threshold cook() must succeed (NO revert above the prio-fee knob)");
    const receivedAbove = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore2;
    const expectAbove = tesseraGetDy(V0 * V0, V0, true)(amountIn);
    assert.equal(receivedAbove, expectAbove, "above-threshold fill == the WIDENED quote model to the wei");
    assert.ok(receivedAbove < receivedBelow, `above-threshold fill is strictly smaller (${receivedAbove} < ${receivedBelow} — the widened spread)`);

    console.log(
      `  [QL Tessera prio-fee:${engine}] below=${receivedBelow} above=${receivedAbove} ` +
        `(both landed; Δ=${receivedBelow - receivedAbove} = the ${PRIO_WIDEN_PPM}ppm widening — no guard needed)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL Tessera solo [${engine}] — on-chain ladder, received == viewAmounts(share)[1] wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL Tessera + V3 [${engine}] — QL stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runTesseraV3(engine);
    });
    it(`QL Tessera zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL Tessera + V3 adverse drift [${engine}] — split RE-ANCHORS to the live drifted state`, { skip }, async () => {
      await runDriftSplit(engine);
    });
    it(`QL Tessera priority-fee threshold [${engine}] — both regimes land, fills == same-gasprice model`, { skip }, async () => {
      await runPrioFee(engine);
    });
  }
});
