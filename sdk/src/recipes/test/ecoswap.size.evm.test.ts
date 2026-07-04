/**
 * EcoSwap INTEGRAL SIZE (TwapRelayer) QUOTE-LADDER (QL) local-EVM integration — the OUT-amount
 * [min, cap] WINDOW (quotes REVERT on BOTH ends of the domain: TR03 below getTokenLimitMin(tokenOut),
 * TR3A above inventory × maxMultiplier), the LIVE window hoist + SEED-FLOOR grid design, the
 * FLAT-LADDER mode (a genuinely linear TWAP price), the SUB-MIN AWARD soft-skip, and the
 * callback-free approve-RELAYER sell() exec (pull == approve ALWAYS — the fork-proven verified
 * source behavior).
 *
 * SIZE is a QUOTE-LADDER family (segKind 19): prepare ships ONLY a descriptor [relayer, 0, 0,
 * feePpm, segKind=19, refIdx, 0…] and the on-chain solver (a) HOISTS the LIVE window per venue —
 * minOut = getTokenLimitMin(tokenOut), minIn = quoteBuy(tokenIn, tokenOut, minOut) — and RAISES the
 * ladder seed to minIn (a grid whose first slice quotes below the out-min would revert TR03 and
 * ZERO the ladder even when the full trade is quotable — the design this family adds), then (b)
 * builds the ladder LIVE from quoteSell (PROBE-THEN-DECODE; the head is CLAMPED flat — the TWAP
 * price is constant over amount, so strict head-descent would truncate at slice 1). EXEC probes
 * quoteSell(award) (a SUB-MIN award reverts TR03 ⇒ SOFT-SKIP into the terminal refund), approves
 * the RELAYER, sells with amountOutMin == the probe quote (same-tx wei-exact).
 *
 * The oracle prices SIZE via buildSizeQLLadder (the SAME seed floor + flat mode) driven by a
 * bit-exact TS replay of the fixture's linear-window curve, so oracle == solver to the WEI.
 *
 *   (1) SOLO in-window — minIn < amountIn/16 (the floor is dormant): full fill, received ==
 *       quoteSell(amountIn) wei-exact, the DELAY sink pulled EXACTLY amountIn, residue == 0.
 *   (2) LOW-END WINDOW RESCUE — amountIn/16 < minIn < amountIn: the UNFLOORED grid's first slice
 *       reverts TR03 (ladder would be EMPTY); the seed floor rescues it — full fill, wei-exact.
 *   (3) BELOW-MIN TRADE — amountIn < minIn: the ladder is ZERO (the venue self-drops), V3 absorbs
 *       the whole trade, never a DoS.
 *   (4) INVENTORY-CAP TRUNCATION (TR3A) — a thin relayer: the ladder truncates at the last
 *       in-window grid point; the solo cook spends EXACTLY the coverage, refunds the rest,
 *       residue == 0.
 *   (5) SUB-MIN AWARD SOFT-SKIP — a V3+SIZE universe tuned so the merge awards SIZE a PARTIAL
 *       first slice below minIn: the exec's quoteSell(award) reverts TR03, the venue SKIPS SOFT,
 *       the strand refunds to the caller (funds preserved), V3's fill lands — never a cook DoS.
 *   (6) ZERO-CACHE QUOTE — the window hoist + floored ladder run inside one eth_call.
 *   (7) ADVERSE TWAP DRIFT — the price moves AFTER compile; the pre-drift bytecodes re-anchor
 *       (SIZE's share shrinks vs V3).
 *
 * No fork / no RPC env. Runs on v1 (+ v12 when present), driven by ECO_ENGINE. Each cell runs on
 * its OWN fresh anvil. Mirrors ecoswap.metric.evm.test.ts.
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
  deploySizeRelayer,
  sizeRelayerFixtureAbi,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { buildSizeQLLadder, SIZE_PRECISION, type SizePool } from "../shared/size-math";
import { buildQLLadder } from "../shared/curve-math";

const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const PRECISION = SIZE_PRECISION; // 1e18
const SWAP_FEE = 500_000_000_000_000n; // 0.05% (1e18-scaled — the source's PRECISION fee)
const MAX_MULT = 950_000_000_000_000_000n; // 0.95e18 (both real chains)
// The DELAY sink the relayer forwards pulled input to (the real TwapDelay hedge queue). A plain
// codeless address — the pull is a vanilla ERC20 transferFrom.
const DELAY_SINK = "0x00000000000000000000000000000000DE1A0001" as Hex;
const ENGINE_CELLS = engineCells();

const SIZE_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
  HAS_TESSERA: false, HAS_ELFOMO: false, HAS_METRIC: false, HAS_LIQUIDCORE: false, HAS_SIZE: true,
};

function args(
  tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex,
  directCount: number, pools: bigint[][], qlv: bigint[][],
): unknown[] {
  return [
    [BigInt(tokenIn), BigInt(tokenOut), amountIn, BigInt(caller), MIN_SQRT_RATIO + 1n, BigInt(directCount)],
    pools, [], [], [], qlv,
  ];
}

// One QL SIZE descriptor row — [relayer, 0, 0, feePpm, 19, refIdx, 0…] (index.ts qlRowFor + pad12).
function szDescriptor(relayer: Hex, refIdx: number, feePpm: number): bigint[] {
  return [BigInt(relayer), 0n, 0n, BigInt(feePpm), 19n, BigInt(refIdx), 0n, 0n, 0n, 0n, 0n, 0n];
}

function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, BigInt(pool), BigInt(feePpm), BigInt(tickSpacing), 0n, BigInt(feePpm), 0n,
    inIsToken0 ? 1n : 0n, 0n, 0n, getSqrtRatioAtTick(tickSpacing), 0n, 0n, 0n, 0n, 0n, 0n,
  ];
}

// Bit-exact TS replay of the fixture's quoteSell (SizeRelayer.sol): linear fee + price inside the
// OUT window — the model returns 0 where the REAL view REVERTS (TR03 below minOut / TR3A above the
// inventory cap / TR24 zero), truncating both ladders in lockstep.
function szGetDy(price: bigint, minOut: bigint, capOut: bigint): (dx: bigint) => bigint {
  return (dx: bigint): bigint => {
    if (dx <= 0n) return 0n;
    const fee = (dx * SWAP_FEE) / PRECISION;
    const out = ((dx - fee) * price) / PRECISION;
    if (out < minOut || out > capOut) return 0n;
    return out;
  };
}

// The fixture quoteBuy's CEIL inversion — the minOut → minIn conversion (the window hoist).
function szMinIn(price: bigint, minOut: bigint): bigint {
  const calculatedIn = (minOut * PRECISION + price - 1n) / price;
  return (calculatedIn * PRECISION + (PRECISION - SWAP_FEE) - 1n) / (PRECISION - SWAP_FEE);
}

describe("EcoSwap INTEGRAL SIZE QL live-walk (local fixture) — out-window [min, cap] + seed-floor grid + flat ladder + callback-free sell exec", () => {
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

  async function deploy(price: bigint, minOut: bigint, outReserve: bigint): Promise<Hex> {
    return deploySizeRelayer(
      c.walletClient, c.publicClient, token0, token1, price, SWAP_FEE, minOut, outReserve, DELAY_SINK,
      c.walletClient.account as Account,
    );
  }

  const allowanceAbi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);
  async function allowanceOf(token: Hex, owner: Hex, spender: Hex): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: token, abi: allowanceAbi as Abi, functionName: "allowance", args: [owner, spender],
    })) as bigint;
  }

  /** The relayer's own LIVE quoteSell — the engine-independent ground truth (throws out-of-window). */
  async function onQuote(relayer: Hex, amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: relayer, abi: sizeRelayerFixtureAbi as Abi, functionName: "quoteSell", args: [token0, token1, amt],
    })) as bigint;
  }

  function offPool(relayer: Hex, price: bigint, minOut: bigint, outReserve: bigint): SizePool {
    const capOut = (outReserve * MAX_MULT) / PRECISION;
    const minIn = szMinIn(price, minOut);
    return {
      address: relayer,
      tokenIn: token0,
      tokenOut: token1,
      minOut,
      minIn,
      feePpm: Number((SWAP_FEE * 10n ** 6n) / PRECISION),
      source: "local-fixture",
      getDy: szGetDy(price, minOut, capOut),
      liveMinIn: minIn,
    };
  }

  // ── (1) SOLO in-window (the floor dormant: minIn < amountIn/16) — wei-exact + residue 0 ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const PRICE = 999_000_000_000_000_000n; // 0.999 tokenOut/tokenIn
    const MIN_OUT = 1_000n * E18;
    const RESERVE = 100_000n * E18;
    const relayer = await deploy(PRICE, MIN_OUT, RESERVE);
    const amountIn = 50_000n * E18; // amountIn/16 = 3125e18 > minIn ≈ 1001.5e18 ⇒ the floor is dormant
    const op = offPool(relayer, PRICE, MIN_OUT, RESERVE);
    assert.ok(op.liveMinIn < amountIn / 16n, "cell precondition: the seed floor is dormant");
    const ladder = buildSizeQLLadder(op, amountIn);
    assert.ok(ladder.length > 1, "the FLAT ladder walks multiple slices (the strict guard would have stopped at 1)");
    assert.equal(ladder.reduce((a, s) => a + s.capacity, 0n), amountIn, "ladder covers the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [szDescriptor(relayer, 0, op.feePpm)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: SIZE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const delayBefore = await balanceOf(c.publicClient, token0, DELAY_SINK);
    const onViewPre = await onQuote(relayer, amountIn);
    assert.equal(onViewPre, op.getDy(amountIn), "TS window model == the relayer quoteSell view (bit-exact)");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL SIZE cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;
    const pulled = (await balanceOf(c.publicClient, token0, DELAY_SINK)) - delayBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL SIZE venue)");
    assert.equal(pulled, amountIn, "the relayer pulled EXACTLY amountIn to the DELAY sink (pull == approve)");
    assert.equal(received, onViewPre, "received == quoteSell(amountIn) to the wei");
    assert.equal(await allowanceOf(token0, target, relayer), 0n, "no relayer allowance residue (pull == approve always)");
    console.log(
      `  [QL SIZE solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== quoteSell to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) LOW-END WINDOW RESCUE — amountIn/16 < minIn < amountIn: the seed floor saves the ladder ──
  async function runLowEndRescue(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const PRICE = 999_000_000_000_000_000n;
    const MIN_OUT = 10_000n * E18; // minIn ≈ 10_015e18 — ABOVE amountIn/16 = 3125e18
    const RESERVE = 100_000n * E18;
    const relayer = await deploy(PRICE, MIN_OUT, RESERVE);
    const amountIn = 50_000n * E18;
    const op = offPool(relayer, PRICE, MIN_OUT, RESERVE);
    assert.ok(op.liveMinIn > amountIn / 16n && op.liveMinIn < amountIn, "cell precondition: the floor is LOAD-BEARING");

    // The UNFLOORED grid's first slice sits below the window — the real view REVERTS TR03 there and
    // an unfloored ladder is EMPTY even though the full amountIn is quotable (the design premise).
    await assert.rejects(
      () => onQuote(relayer, amountIn / 16n),
      /TR03/,
      "the unfloored first slice REVERTS TR03 on the real surface",
    );
    assert.equal(buildQLLadder(op.getDy, amountIn, 0n, true).length, 0, "an UNFLOORED ladder would be EMPTY");
    const ladder = buildSizeQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "the seed-FLOORED ladder is non-empty");
    assert.ok(ladder[0].capacity >= op.liveMinIn, "the first slice starts at/above minIn (in-window by construction)");
    assert.equal(ladder.reduce((a, s) => a + s.capacity, 0n), amountIn, "the floored ladder covers the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [szDescriptor(relayer, 0, op.feePpm)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: SIZE_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const onViewPre = await onQuote(relayer, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "low-end-rescue cook() must succeed (the LIVE window hoist floors the grid)");

    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;
    assert.equal(spent, amountIn, "the FULL trade fills — the floor rescued the whole ladder");
    assert.equal(received, onViewPre, "received == quoteSell(amountIn) to the wei");
    console.log(`  [QL SIZE low-end rescue:${engine}] minIn=${op.liveMinIn} spent=${spent} received=${received} (unfloored ladder would be EMPTY)`);
  }

  // ── (3) BELOW-MIN TRADE — amountIn < minIn ⇒ a ZERO ladder; V3 absorbs; never a DoS ──
  async function runBelowMin(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const PRICE = 999_000_000_000_000_000n;
    const MIN_OUT = 10_000n * E18;
    const RESERVE = 100_000n * E18;
    const relayer = await deploy(PRICE, MIN_OUT, RESERVE);
    const amountIn = 5_000n * E18; // < minIn ≈ 10_015e18 — the venue cannot serve this trade at all
    const op = offPool(relayer, PRICE, MIN_OUT, RESERVE);
    assert.ok(amountIn < op.liveMinIn, "cell precondition: the whole trade sits below the venue min");
    assert.equal(buildSizeQLLadder(op, amountIn).length, 0, "the ladder is ZERO (grid clamped at amountIn < minIn ⇒ TR03)");

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [szDescriptor(relayer, 0, op.feePpm)];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: SIZE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const delayBefore = await balanceOf(c.publicClient, token0, DELAY_SINK);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "below-min cook() SUCCEEDS (zero ladder — the venue self-drops)");

    const pulled = (await balanceOf(c.publicClient, token0, DELAY_SINK)) - delayBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.equal(pulled, 0n, "the below-min SIZE venue received 0 (zero ladder — self-dropped)");
    assert.equal(v3In, spent, "the whole spent input landed on V3");
    assert.equal(spent, amountIn, "the trade still fills in full (V3 absorbs it)");
    assert.ok(received > 0n, "caller receives tokenOut via V3");
    console.log(`  [QL SIZE below-min:${engine}] SIZE=0 V3=${v3In} received=${received} (venue self-dropped, no DoS)`);
  }

  // ── (4) INVENTORY-CAP TRUNCATION (TR3A) — the ladder stops at the last in-window grid point ──
  async function runCapTruncation(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const PRICE = 999_000_000_000_000_000n;
    const MIN_OUT = 1_000n * E18;
    const RESERVE = 20_000n * E18; // cap = 19_000e18 out — the TR3A edge bites mid-grid
    const relayer = await deploy(PRICE, MIN_OUT, RESERVE);
    const amountIn = 50_000n * E18;
    const op = offPool(relayer, PRICE, MIN_OUT, RESERVE);
    const ladder = buildSizeQLLadder(op, amountIn);
    const coverage = ladder.reduce((a, s) => a + s.capacity, 0n);
    assert.ok(coverage > 0n && coverage < amountIn, `the ladder truncates strictly inside amountIn (coverage=${coverage})`);
    assert.equal(op.getDy(coverage + coverage / 3n), 0n, "grid points past the coverage are OUT-of-window (TR3A)");
    await assert.rejects(() => onQuote(relayer, amountIn), /TR3A/, "the full-size quote REVERTS TR3A on the real surface");

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [szDescriptor(relayer, 0, op.feePpm)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: SIZE_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const delayBefore = await balanceOf(c.publicClient, token0, DELAY_SINK);
    const onViewCov = await onQuote(relayer, coverage);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cap-truncation cook() must succeed (award bounded by the in-window ladder)");

    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;
    const pulled = (await balanceOf(c.publicClient, token0, DELAY_SINK)) - delayBefore;

    assert.equal(spent, coverage, "net spent == the ladder coverage (the un-fillable remainder refunded)");
    assert.equal(pulled, coverage, "pulled == the awarded coverage exactly");
    assert.equal(received, onViewCov, "received == quoteSell(coverage) to the wei");
    assert.equal(await allowanceOf(token0, target, relayer), 0n, "no relayer allowance residue");
    console.log(
      `  [QL SIZE cap-truncation:${engine}] amountIn=${amountIn} coverage=${coverage} received=${received} ` +
        `(TR3A truncated; remainder refunded; residue 0)`,
    );
  }

  // ── (5) SUB-MIN AWARD SOFT-SKIP — the merge awards SIZE a partial first slice below minIn ──
  async function runSubMinAward(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // TUNING: V3 (0.30% fee, 1:1, L=3e24) has a ~0.997 post-fee head that degrades with size; SIZE
    // is priced BELOW the head (so V3 fills first) but ABOVE V3's deep tail (so the cursor reaches
    // SIZE late, with only a sub-min remainder of the budget left). minOut = 10_000e18 makes
    // minIn ≈ 10_015e18 ≫ that remainder ⇒ the awarded partial slice is SUB-MIN.
    const PRICE = 989_500_000_000_000_000n; // 0.9895 ⇒ post-fee ≈ 0.98901
    const MIN_OUT = 10_000n * E18;
    const RESERVE = 100_000n * E18;
    const relayer = await deploy(PRICE, MIN_OUT, RESERVE);
    const amountIn = 20_000n * E18;
    const op = offPool(relayer, PRICE, MIN_OUT, RESERVE);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };

    const oracle = optimalSplit({ pools: [v3Opt, { size: op, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oSz = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oSz > 0n && oSz < op.liveMinIn, `cell precondition: the SIZE award is SUB-MIN (award=${oSz} < minIn=${op.liveMinIn})`);
    assert.ok(oV3 > 0n, "V3 takes the bulk");

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [szDescriptor(relayer, 0, op.feePpm)];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: SIZE_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const delayBefore = await balanceOf(c.publicClient, token0, DELAY_SINK);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "sub-min-award cook() SUCCEEDS (the exec probe soft-skips — never a DoS)");

    const pulled = (await balanceOf(c.publicClient, token0, DELAY_SINK)) - delayBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.equal(pulled, 0n, "the SUB-MIN award never executed (quoteSell(award) reverted TR03 ⇒ soft-skip)");
    assert.equal(v3In, oV3, "V3's award landed exactly (== oracle)");
    assert.equal(spent, oV3, "net spent == V3's take only — the stranded SIZE share REFUNDED to the caller");
    assert.equal(await allowanceOf(token0, target, relayer), 0n, "no approve ever happened (probe-first ordering) ⇒ residue 0");
    assert.ok(received > 0n, "caller receives V3's out");
    console.log(
      `  [QL SIZE sub-min award:${engine}] award=${oSz} < minIn=${op.liveMinIn} ⇒ soft-skip; ` +
        `V3=${v3In} spent=${spent} refund=${amountIn - spent} (funds preserved)`,
    );
  }

  // ── (6) ZERO-CACHE QUOTE ──
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

    const PRICE = 999_000_000_000_000_000n;
    const MIN_OUT = 10_000n * E18; // the floor is LOAD-BEARING in the quote too
    const RESERVE = 100_000n * E18;
    const relayer = await deploy(PRICE, MIN_OUT, RESERVE);
    const amountIn = 50_000n * E18;

    const { bytecodes } = compileSauce(
      solverSrc,
      args(token0, token1, amountIn, caller, 0, [], [szDescriptor(relayer, 0, 500)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: SIZE_DEFINES },
    );
    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(
      quoted, await onQuote(relayer, amountIn),
      "zero-cache QUOTE == quoteSell(amountIn) to the wei (window hoisted + floored ladder built live in the eth_call)",
    );
    console.log(`  [QL SIZE zero-cache quote:${engine}] quoted=${quoted} (== quoteSell, no prepared cache)`);
  }

  // ── (7) ADVERSE TWAP DRIFT — the price moves AFTER compile; SAME bytecodes re-anchor ──
  async function runDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const PRICE0 = 999_000_000_000_000_000n;
    const MIN_OUT = 1_000n * E18;
    const RESERVE = 100_000n * E18;
    const relayer = await deploy(PRICE0, MIN_OUT, RESERVE);
    const amountIn = 100_000n * E18;

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, token0, token1, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };

    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [szDescriptor(relayer, 0, 500)];
    const { bytecodes } = compileSauce(
      solverSrc, args(token0, token1, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: SIZE_DEFINES },
    );

    const oraclePre = optimalSplit({ pools: [v3Opt, { size: offPool(relayer, PRICE0, MIN_OUT, RESERVE), feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const szSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(szSharePre > 0n, "baseline oracle awards the SIZE venue a share");

    // ADVERSE DRIFT: the TWAP re-prices 0.8% lower AFTER compile (the fixture's settable price
    // stands in for the Uniswap-V3 observe move the real relayer would read).
    const PRICE1 = (PRICE0 * 992n) / 1000n;
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: relayer, abi: sizeRelayerFixtureAbi as Abi, functionName: "setPair",
        args: [token0, token1, PRICE1, SWAP_FEE, true], account: c.walletClient.account as Account, chain: c.walletClient.chain,
      }),
    });

    const oracleDrift = optimalSplit({ pools: [v3Opt, { size: offPool(relayer, PRICE1, MIN_OUT, RESERVE), feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const szShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(szShareDrift < szSharePre, `drift shrinks the SIZE share (${szShareDrift} < ${szSharePre})`);

    await approve(c.walletClient, c.publicClient, token0, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const delayBefore = await balanceOf(c.publicClient, token0, DELAY_SINK);
    const v3InBefore = await balanceOf(c.publicClient, token0, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drift cook() SUCCEEDS — the ladder re-read the live (worse) TWAP");

    const szIn = (await balanceOf(c.publicClient, token0, DELAY_SINK)) - delayBefore;
    const v3In = (await balanceOf(c.publicClient, token0, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, token0, caller));
    const received = (await balanceOf(c.publicClient, token1, caller)) - outBefore;

    assert.ok(v3In > 0n, "V3 funded post-drift");
    assert.equal(szIn, szShareDrift, "SIZE awarded input == drifted oracle (re-anchored to the live TWAP)");
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(szIn < szSharePre, `SIZE share ADAPTED down after the TWAP move (${szIn} < baseline ${szSharePre})`);
    assert.ok(received > 0n, "caller receives tokenOut");
    console.log(
      `  [QL SIZE+V3 TWAP-drift:${engine}] baseline SIZE share=${szSharePre} → re-anchored=${szIn} ` +
        `(V3 grew to ${v3In}); spent=${spent} received=${received}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL SIZE solo in-window [${engine}] — flat ladder, received == quoteSell wei-exact, residue 0`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL SIZE low-end window rescue [${engine}] — the seed floor saves an otherwise-empty ladder`, { skip }, async () => {
      await runLowEndRescue(engine);
    });
    it(`QL SIZE below-min trade [${engine}] — zero ladder, venue self-drops, V3 absorbs`, { skip }, async () => {
      await runBelowMin(engine);
    });
    it(`QL SIZE inventory-cap truncation [${engine}] — TR3A bounds the ladder, remainder refunds, residue 0`, { skip }, async () => {
      await runCapTruncation(engine);
    });
    it(`QL SIZE sub-min award soft-skip [${engine}] — TR03 at exec strands + refunds, never a DoS`, { skip }, async () => {
      await runSubMinAward(engine);
    });
    it(`QL SIZE zero-cache QUOTE [${engine}] — window hoist + floored ladder inside one eth_call`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL SIZE + V3 TWAP drift [${engine}] — split RE-ANCHORS to the live price`, { skip }, async () => {
      await runDriftSplit(engine);
    });
  }
});
