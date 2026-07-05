/**
 * EcoSwap PancakeSwap INFINITY CL — LOCAL EVM integration test (NO fork, NO mocks for the
 * venue itself).
 *
 * Boots a fresh anvil, etches the GENUINE BSC Infinity singletons (Vault + CLPoolManager +
 * CLTickLens — runtime captured by harness/infinity-snapshot.ts; pools are VIRTUAL inside the
 * managers, so etch-at-canonical-address is the only faithful local deployment — the V4
 * PoolManager/StateView precedent), re-animates the fresh storage (Vault app registration +
 * the protocolFeeController poke → the REAL setProtocolFee reproduces the live packed 12+12
 * protocol fee through the genuine code path), initializes pools + mints multi-position tick
 * profiles through the InfinityLiquidityHelper (lock → lockAcquired → modifyLiquidity →
 * sync/settle — the verified Vault order), deploys the REAL engine (Router → SauceRouter [+
 * V12Pot]), and runs the compiled EcoSwap recipe end-to-end via the flat swapInfinityCL
 * entrypoint (the engine's lockAcquired services the Vault lock mid-swap).
 *
 * Cells (× both engines via ECO_ENGINE):
 *   1. Infinity-only 2-pool split — WEI-EXACT vs the reference (Vault tokenIn delta ==
 *      Σ ref.perPoolInput exactly; compute-then-pull spends amountIn exactly) + LIVE fee
 *      combine (nonzero packed protocolFee ⇒ feePpm = prot⊕lp, asserted on prepared) +
 *      post-swap fee-adjusted marginal equalization.
 *   2. Infinity + V3 mixed split — per-venue deltas wei-exact vs the reference, marginals
 *      equalize ACROSS families.
 *   3. Zero-cache quote == cook (the 1-RPC quote path staticcalls every boundary live —
 *      getPoolTickInfo — and must agree with the cached cook to the wei).
 *   4. Drift re-anchor — a real engine-routed swapInfinityCL swap moves the pool AFTER
 *      prepare; the pre-drift bytecodes re-anchor to the LIVE slot0 (single-pass input-anchored
 *      semantics).
 *   5. Hook-tier policy at discovery (engine-independent): a hooked static-fee pool (genuine
 *      initialize through a bitmap-validated mock hook) is EXCLUDED by default, still excluded
 *      when listed with an EMPTY allowlist (Tier B ships default-off), and admitted with the
 *      poolIdToPoolKey-recovered key only when its hook is allowlisted.
 *
 * Run: ECO_ENGINE=both npx tsx --test src/recipes/test/ecoswap.infinity.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Abi, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  createAndInitPool,
  mintPosition,
  mint,
  approve,
  balanceOf,
  getSlot0,
  etchInfinitySingletons,
  deployInfinityHelper,
  deployInfinityMockHook,
  setupInfinityPool,
  setInfinityProtocolFee,
  getInfinitySlot0,
  getInfinityLiquidity,
  encodeInfinityParams,
  infinityHelperAbi,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
  type InfinitySingletons,
} from "./harness/setup";
import { writeAndWait } from "./harness/deploy";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { driftPoolPrice } from "./harness/drift";
import { SwapPoolType, FactoryType, type ChainPoolConfig, type FactoryConfig } from "../shared/constants";
import { combineInfinityFee } from "../shared/infinity-math";
import { discoverInfinityCLPoolsTyped } from "../shared/pool-discovery";
import { ecoSwap, quoteEcoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { feeAdjust, toOutIn } from "./ecoswap.math";

const HUGE = parseEther("1000000000");
const ENGINE_CELLS = engineCells();
// The REAL BSC packed 12+12 protocol fee (32 | 32 — every probed static-fee pool carries it),
// reproduced locally through the genuine setProtocolFee path so the LIVE fee combine is
// load-bearing in every cell, exactly as on BSC.
const PROTOCOL_FEE = 131104;
// MintableERC20 fixture storage layout (balances slot 4 / allowances slot 5) — the quote's
// eth_call state override writes these directly.
const MINTABLE_ERC20_SLOTS = { balanceSlot: 4n, allowanceSlot: 5n };

describe("EcoSwap PancakeSwap Infinity CL (etched genuine Vault + CLPoolManager)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let inf: InfinitySingletons;
  let helper: Hex;
  let mockHook: Hex;
  let tokenIn: Hex; // token0 (zeroForOne)
  let tokenOut: Hex; // token1
  let poolIdA: Hex; // Infinity fee 67 / ts 1 (the USDT/Beat class) — multi-position profile
  let poolIdB: Hex; // Infinity fee 3000 / ts 60 (the V4-parity class)
  let v3Pool: Hex; // Uniswap V3 fee 500 (the mixed-split partner)
  let infOnlyConfig: ChainPoolConfig;
  let mixedConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  const infinityEntry = (over: Partial<FactoryConfig> = {}): FactoryConfig => ({
    address: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b" as Hex, // canonical CLPM (etched)
    poolType: SwapPoolType.PancakeInfinityCL,
    factoryType: FactoryType.PancakeInfinityCL,
    label: "Local Infinity CL",
    infinityVault: "0x238a358808379702088667322f80aC48bAd5e6c4" as Hex, // canonical Vault (etched)
    infinityTickLens: "0x8BcF30285413F25032fb983C2bF4deFe29a33f3a" as Hex,
    infinityPresets: [
      { fee: 67, tickSpacing: 1 },
      { fee: 3000, tickSpacing: 60 },
    ],
    ...over,
  });

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    inf = await etchInfinitySingletons(c.publicClient, c.testClient);
    helper = await deployInfinityHelper(c.walletClient, c.publicClient, inf.vault, inf.clPoolManager);
    mockHook = await deployInfinityMockHook(c.walletClient, c.publicClient);

    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, HUGE);
    await mint(c.walletClient, c.publicClient, tokenOut, minter, HUGE);
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // ── Pool A: Infinity fee 67 / ts 1 at 1:1 with a REAL multi-position profile (three
    // nested ranges ⇒ initialized boundaries at ±150/±400/±1000 the walk crosses).
    poolIdA = await setupInfinityPool(
      c.walletClient, c.publicClient, helper, tokenIn, tokenOut,
      67, 1, SQRT_PRICE_1_1, -1000, 1000, parseEther("200000"), parseEther("50000000"),
    );
    const keyA = {
      currency0: tokenIn, currency1: tokenOut, hooks: "0x0000000000000000000000000000000000000000" as Hex,
      poolManager: inf.clPoolManager, fee: 67, parameters: encodeInfinityParams(1),
    };
    for (const [lo, hi, L] of [
      [-400, 400, parseEther("150000")],
      [-150, 150, parseEther("100000")],
    ] as const) {
      await writeAndWait(c.walletClient, c.publicClient, {
        address: helper, abi: infinityHelperAbi as Abi, functionName: "addLiquidity",
        args: [keyA, lo, hi, L],
      });
    }
    await setInfinityProtocolFee(c.walletClient, c.publicClient, c.testClient, keyA, PROTOCOL_FEE, c.account0);

    // ── Pool B: Infinity fee 3000 / ts 60 at 1:1, one wide position.
    poolIdB = await setupInfinityPool(
      c.walletClient, c.publicClient, helper, tokenIn, tokenOut,
      3000, 60, SQRT_PRICE_1_1, -12000, 12000, parseEther("100000"), parseEther("50000000"),
    );
    const keyB = {
      currency0: tokenIn, currency1: tokenOut, hooks: "0x0000000000000000000000000000000000000000" as Hex,
      poolManager: inf.clPoolManager, fee: 3000, parameters: encodeInfinityParams(60),
    };
    await setInfinityProtocolFee(c.walletClient, c.publicClient, c.testClient, keyB, PROTOCOL_FEE, c.account0);

    // ── V3 pool (fee 500) for the cross-family mixed split.
    v3Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, 500, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, v3Pool, minter, -12000, 12000, parseEther("300000"),
    );

    infOnlyConfig = {
      factories: [infinityEntry()],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
    mixedConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
        infinityEntry(),
      ],
      feeTiers: [500],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
  }

  /** Post-swap fee-adjusted out/in marginal for an Infinity pool at its LIVE combined fee. */
  async function infFeeAdjMarginal(poolId: Hex): Promise<bigint> {
    const s = await getInfinitySlot0(c.publicClient, inf.clPoolManager, poolId);
    const combined = combineInfinityFee(s.protocolFee, s.lpFee, true);
    return feeAdjust(toOutIn(s.sqrtPriceX96, true), combined);
  }

  // ── Cell 1: Infinity-only 2-pool split, wei-exact vs the reference ──
  async function runInfinitySplit(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("5000");
    const caller = c.account0;

    const vaultInBefore = await balanceOf(c.publicClient, tokenIn, inf.vault);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const beforeA = await getInfinitySlot0(c.publicClient, inf.clPoolManager, poolIdA);
    const beforeB = await getInfinitySlot0(c.publicClient, inf.clPoolManager, poolIdB);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12),
      caller, infOnlyConfig, undefined, engine,
    );
    const infPools = prepared.pools.filter((p) => p.poolType === SwapPoolType.PancakeInfinityCL);
    assert.equal(infPools.length, 2, "discovers both Infinity CL pools via the preset menu");
    assert.equal(prepared.infinityVault?.toLowerCase(), inf.vault.toLowerCase(), "prepared carries the chain-wide Vault");
    // The LIVE fee combine is load-bearing: feePpm must be prot⊕lp (99 / 3032 for 32|32 packed),
    // NOT the bare key fee — and `fee` must stay the KEY fee (the exec PoolKey identity).
    const pA = infPools.find((p) => p.poolId === poolIdA)!;
    const pB = infPools.find((p) => p.poolId === poolIdB)!;
    assert.equal(pA.fee, 67, "pool A keeps the KEY fee");
    assert.equal(pA.feePpm, combineInfinityFee(PROTOCOL_FEE, 67, true), "pool A feePpm = LIVE combined fee");
    assert.equal(pB.fee, 3000, "pool B keeps the KEY fee");
    assert.equal(pB.feePpm, combineInfinityFee(PROTOCOL_FEE, 3000, true), "pool B feePpm = LIVE combined fee");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "Infinity-only cook() must succeed");

    const vaultDelta = (await balanceOf(c.publicClient, tokenIn, inf.vault)) - vaultInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const afterA = await getInfinitySlot0(c.publicClient, inf.clPoolManager, poolIdA);
    const afterB = await getInfinitySlot0(c.publicClient, inf.clPoolManager, poolIdB);

    assert.ok(received > 0n, "caller received tokenOut");
    assert.equal(vaultDelta, spent, "ALL Infinity input lands in the Vault (funds custody)");

    // WEI-EXACT vs the reference (deterministic local state == prepared state).
    const ref = ecoSwapReference(prepared, amountIn);
    assert.equal(spent, ref.totalInput, "spent == reference totalInput EXACTLY");
    assert.equal(spent, amountIn, "deep pools: single-pass spends amountIn exactly");
    const refA = ref.perPoolInput[prepared.pools.indexOf(pA)];
    const refB = ref.perPoolInput[prepared.pools.indexOf(pB)];
    assert.ok(refA > 0n && refB > 0n, "reference splits across BOTH Infinity pools");
    assert.ok(afterA.sqrtPriceX96 < beforeA.sqrtPriceX96, "pool A price moved down (received input)");
    assert.ok(afterB.sqrtPriceX96 < beforeB.sqrtPriceX96, "pool B price moved down (received input)");
    assert.ok(afterA.tick < beforeA.tick, "pool A crossed ticks");

    // Post-swap fee-adjusted marginal equalization at the LIVE combined fees.
    const mA = await infFeeAdjMarginal(poolIdA);
    const mB = await infFeeAdjMarginal(poolIdB);
    const spread = Number((mA > mB ? mA - mB : mB - mA)) / Number(mA > mB ? mA : mB);
    assert.ok(spread < 0.02, `post-swap fee-adj marginals should cluster (spread ${spread})`);

    console.log(
      `  [inf-split:${engine}] spent=${spent} received=${received} vaultDelta=${vaultDelta}\n` +
        `       ref split A=${refA} B=${refB}; marginals A=${mA} B=${mB} spread=${spread}`,
    );
  }

  // ── Cell 2: Infinity + V3 mixed split (cross-family marginal equalization) ──
  async function runMixedSplit(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("4000");
    const caller = c.account0;

    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3Pool);
    const vaultInBefore = await balanceOf(c.publicClient, tokenIn, inf.vault);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12),
      caller, mixedConfig, undefined, engine,
    );
    assert.equal(prepared.pools.filter((p) => p.poolType === SwapPoolType.UniV3).length, 1, "1 V3 pool");
    assert.equal(
      prepared.pools.filter((p) => p.poolType === SwapPoolType.PancakeInfinityCL).length, 2,
      "2 Infinity pools",
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "mixed Infinity+V3 cook() must succeed");

    const v3Delta = (await balanceOf(c.publicClient, tokenIn, v3Pool)) - v3InBefore;
    const vaultDelta = (await balanceOf(c.publicClient, tokenIn, inf.vault)) - vaultInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;

    assert.ok(v3Delta > 0n, "V3 pool receives input");
    assert.ok(vaultDelta > 0n, "the Infinity Vault receives input");
    assert.ok(received > 0n, "caller received tokenOut");
    assert.equal(v3Delta + vaultDelta, spent, "per-venue tokenIn deltas sum to spent");

    // WEI-EXACT per venue vs the reference: the V3 pool's delta is its own; the Vault's is the
    // sum over both Infinity pools.
    const ref = ecoSwapReference(prepared, amountIn);
    let refV3 = 0n;
    let refInf = 0n;
    prepared.pools.forEach((p, i) => {
      if (p.poolType === SwapPoolType.PancakeInfinityCL) refInf += ref.perPoolInput[i];
      else refV3 += ref.perPoolInput[i];
    });
    assert.equal(v3Delta, refV3, "V3 delta == reference EXACTLY");
    assert.equal(vaultDelta, refInf, "Vault delta == Σ Infinity reference EXACTLY");
    assert.equal(spent, ref.totalInput, "spent == reference totalInput EXACTLY");

    // Cross-family fee-adjusted marginal equalization (V3 at its tier fee; Infinity at the
    // LIVE combined fee).
    const { sqrtPriceX96: v3Sqrt } = await getSlot0(c.publicClient, v3Pool);
    const mV3 = feeAdjust(toOutIn(v3Sqrt, true), 500);
    const mA = await infFeeAdjMarginal(poolIdA);
    const vals = [mV3, mA];
    const hi = vals.reduce((a, b) => (a > b ? a : b));
    const lo = vals.reduce((a, b) => (a < b ? a : b));
    const spread = Number(hi - lo) / Number(hi);
    assert.ok(spread < 0.02, `cross-family post-swap marginals should cluster (spread ${spread})`);

    console.log(
      `  [inf-mixed:${engine}] spent=${spent} received=${received} v3=${v3Delta} vault=${vaultDelta}\n` +
        `       ref v3=${refV3} inf=${refInf}; marginals v3=${mV3} infA=${mA} spread=${spread}`,
    );
  }

  // ── Cell 3: zero-cache quote == cook ──
  async function runQuoteEqualsCook(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("3000");
    const caller = c.account0;

    // Zero-cache quote (1-RPC path): the walk staticcalls EVERY boundary live via
    // getPoolTickInfo — no prepared net rows at all.
    const quote = await quoteEcoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, infOnlyConfig,
      { noBrackets: true, target: engine, erc20Slots: MINTABLE_ERC20_SLOTS },
    );
    assert.ok(quote.amountOut > 0n, "zero-cache quote returns a positive out");
    assert.equal(
      quote.prepared.pools.some((p) => (p.windowTopShifted ?? 0n) > 0n), false,
      "zero-cache quote carries NO net-cache window",
    );

    // The real cook against the SAME (unmoved) state.
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { bytecodes } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12),
      caller, infOnlyConfig, undefined, engine,
    );
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed");
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;

    assert.equal(quote.amountOut, received, "zero-cache quote == cook to the WEI");
    console.log(`  [inf-quote:${engine}] quote=${quote.amountOut} cook=${received} (wei-exact)`);
  }

  // ── Cell 4: drift re-anchor (live slot0 read at cook) ──
  async function runDrift(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("3000");
    const caller = c.account0;

    // PREPARE against the clean pools.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12),
      caller, infOnlyConfig, undefined, engine,
    );
    const pA = prepared.pools.find((p) => p.poolId === poolIdA)!;
    const before = await getInfinitySlot0(c.publicClient, inf.clPoolManager, poolIdA);

    // DRIFT pool A with a REAL engine-routed swapInfinityCL swap (the drift harness's
    // Infinity arm — proves the flat entrypoint + Vault lock also outside the solver).
    await driftPoolPrice(
      c, stack.sauceRouter, pA, tokenIn, tokenOut, true, parseEther("800"), caller,
      undefined, inf.vault,
    );
    const drifted = await getInfinitySlot0(c.publicClient, inf.clPoolManager, poolIdA);
    assert.ok(drifted.sqrtPriceX96 < before.sqrtPriceX96, "drift moved pool A's live price down");

    // EXECUTE the pre-drift bytecodes — SETUP must read the NEW live slot0 (re-anchor).
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the drifted price");
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const after = await getInfinitySlot0(c.publicClient, inf.clPoolManager, poolIdA);

    // Single-pass (input-anchored) semantics: the solver spends the trade against the LIVE
    // drifted price — the re-anchor is proven by drifted < prepared spot + a successful
    // (large-majority) fill from there.
    assert.ok(spent >= (amountIn * 80n) / 100n, `spends the large majority (${spent} of ${amountIn})`);
    assert.ok(spent <= amountIn, "never overspends");
    assert.ok(after.sqrtPriceX96 < drifted.sqrtPriceX96, "the cook pushed the live price further");

    console.log(
      `  [inf-drift:${engine}] drift tick ${before.tick}->${drifted.tick}, cook spent=${spent}, tick->${after.tick}`,
    );
  }

  // ── Cell 6: Tier-B HOOKED pool COOK — the allowlist-admitted exec arm end-to-end ──
  // The only Infinity exec path cell 5 does not reach: a hooked pool's PoolKey parameters are
  // NOT derivable from the 18-col tuple (the bitmap is part of the key), so the exec recovers
  // them LIVE via poolIdToPoolKey (the pd[4] != 0 arm). Prove it cooks: Tier-B pool joins the
  // split via typed discovery (zero net cache — every boundary staticcalled), the REAL
  // beforeSwap hook executes mid-lock, and the split stays wei-exact vs the reference.
  async function runTierBCook(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("4000");
    const caller = c.account0;

    // A GENUINE hooked static-fee pool (bitmap 0x0040, fee 500/ts 10 — off the preset menu) +
    // the real packed protocol fee, so the live combine is load-bearing on the hooked pool too.
    const hookedId = await setupInfinityPool(
      c.walletClient, c.publicClient, helper, tokenIn, tokenOut,
      500, 10, SQRT_PRICE_1_1, -12000, 12000, parseEther("150000"), parseEther("30000000"),
      mockHook, 0x0040,
    );
    const hookedKey = {
      currency0: tokenIn, currency1: tokenOut, hooks: mockHook,
      poolManager: inf.clPoolManager, fee: 500, parameters: encodeInfinityParams(10, 0x0040),
    };
    await setInfinityProtocolFee(c.walletClient, c.publicClient, c.testClient, hookedKey, PROTOCOL_FEE, c.account0);

    const tierBConfig: ChainPoolConfig = {
      factories: [infinityEntry({ infinityHookedPools: [hookedId], infinityHookAllowlist: [mockHook] })],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, tierBConfig, undefined, engine,
    );
    const hooked = prepared.pools.find((p) => p.poolId === hookedId);
    assert.ok(hooked, "Tier-B hooked pool joins the prepared universe");
    assert.equal(hooked!.fee, 500, "hooked pool keeps the recovered KEY fee");
    assert.equal(hooked!.hooks?.toLowerCase(), mockHook.toLowerCase(), "hooked pool carries the hook");
    assert.equal(hooked!.feePpm, combineInfinityFee(PROTOCOL_FEE, 500, true), "hooked feePpm = LIVE combined fee");
    assert.equal(hooked!.windowTopShifted ?? 0n, 0n, "Tier-B ships ZERO net cache (live-staticcall walk)");
    assert.equal(hooked!.netRows?.length ?? 0, 0, "Tier-B ships no net rows");

    const hookedBefore = await getInfinitySlot0(c.publicClient, inf.clPoolManager, hookedId);
    const vaultInBefore = await balanceOf(c.publicClient, tokenIn, inf.vault);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook with a HOOKED pool in the split must succeed");

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const vaultDelta = (await balanceOf(c.publicClient, tokenIn, inf.vault)) - vaultInBefore;
    const hookedAfter = await getInfinitySlot0(c.publicClient, inf.clPoolManager, hookedId);

    const ref = ecoSwapReference(prepared, amountIn);
    const hookedRef = ref.perPoolInput[prepared.pools.indexOf(hooked!)];
    assert.equal(spent, ref.totalInput, "spent == reference totalInput EXACTLY");
    assert.ok(hookedRef > 0n, "the reference routes input to the HOOKED pool");
    assert.ok(hookedAfter.sqrtPriceX96 < hookedBefore.sqrtPriceX96, "hooked pool price moved (hook executed mid-lock)");
    assert.equal(vaultDelta, spent, "ALL input lands in the Vault");
    assert.ok(received > 0n, "caller received tokenOut");

    console.log(
      `  [inf-tierB:${engine}] spent=${spent} received=${received} hookedSlice=${hookedRef} (wei-exact)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`[${engine}] Infinity-only 2-pool split — wei-exact vs the reference + live fee combine`, { skip }, async () => {
      await runInfinitySplit(engine);
    });
    it(`[${engine}] Infinity + V3 mixed split — cross-family marginal equalization`, { skip }, async () => {
      await runMixedSplit(engine);
    });
    it(`[${engine}] zero-cache quote == cook (live getPoolTickInfo boundary walk)`, { skip }, async () => {
      await runQuoteEqualsCook(engine);
    });
    it(`[${engine}] drift re-anchor — pre-drift bytecodes read the live slot0`, { skip }, async () => {
      await runDrift(engine);
    });
    it(`[${engine}] Tier-B hooked pool COOK — allowlist-admitted exec (poolIdToPoolKey params recovery)`, { skip }, async () => {
      await runTierBCook(engine);
    });
  }

  // ── Cell 5: hook-tier policy at discovery (engine-independent) ──
  it("hooked static-fee pool: EXCLUDED by default, EXCLUDED with an empty allowlist, admitted only via the allowlist", async () => {
    await resetPools();
    // A GENUINE hooked pool: bitmap 0x0040 (beforeSwap-only — the launchpad static-fee class),
    // validated by the real CLPoolManager (Hooks.validateHookConfig requires the hook's own
    // registration bitmap to match the key's low-16 bits).
    const hookedId = await setupInfinityPool(
      c.walletClient, c.publicClient, helper, tokenIn, tokenOut,
      67, 10, SQRT_PRICE_1_1, -12000, 12000, parseEther("50000"), parseEther("10000000"),
      mockHook, 0x0040,
    );
    assert.ok((await getInfinityLiquidity(c.publicClient, inf.clPoolManager, hookedId)) > 0n, "hooked pool is live");

    const disc = (factories: FactoryConfig[]) =>
      discoverInfinityCLPoolsTyped(tokenIn, tokenOut, c.publicClient as never, factories);

    // (a) Default (Tier A): only the hookless preset pools surface.
    const tierA = await disc([infinityEntry()]);
    assert.equal(tierA.length, 2, "Tier A: both hookless pools");
    assert.ok(!tierA.some((p) => p.poolId === hookedId), "hooked pool EXCLUDED by default");

    // (b) Listed poolId but EMPTY allowlist (the SHIPPING default) ⇒ still excluded.
    const tierBOff = await disc([infinityEntry({ infinityHookedPools: [hookedId] })]);
    assert.ok(!tierBOff.some((p) => p.poolId === hookedId), "empty allowlist keeps Tier B OFF");

    // (c) Allowlisted hook ⇒ admitted with the poolIdToPoolKey-RECOVERED key (never
    // config-trusted): fee/tickSpacing/hooks all come back from the chain.
    const tierBOn = await disc([
      infinityEntry({ infinityHookedPools: [hookedId], infinityHookAllowlist: [mockHook] }),
    ]);
    const admitted = tierBOn.find((p) => p.poolId === hookedId);
    assert.ok(admitted, "allowlisted hooked pool is admitted");
    assert.equal(admitted!.fee, 67, "recovered KEY fee");
    assert.equal(admitted!.tickSpacing, 10, "recovered tickSpacing (decoded from parameters)");
    assert.equal(admitted!.hooks?.toLowerCase(), mockHook.toLowerCase(), "recovered hook address");
    // The hooked pool initialized with the controller UNSET (the fee-poke helper restores the
    // slot), so its slot0 protocolFee is 0 ⇒ the live combine equals the bare lpFee.
    assert.equal(admitted!.liveFeePpm, combineInfinityFee(0, 67, true), "live combined fee stamped");

    // (d) A wrong-hook allowlist (the re-verification is on the RECOVERED key) ⇒ excluded.
    const tierBWrong = await disc([
      infinityEntry({
        infinityHookedPools: [hookedId],
        infinityHookAllowlist: ["0x00000000000000000000000000000000000000aa" as Hex],
      }),
    ]);
    assert.ok(!tierBWrong.some((p) => p.poolId === hookedId), "non-allowlisted hook stays excluded");

    // (e) The production PREPARE path excludes it by default too (lens presets are hookless by
    // construction; typed Tier-B appending is allowlist-gated).
    const { prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn: parseEther("100") }, anvil.rpcUrl, stack.sauceRouter,
      c.account0, infOnlyConfig, undefined, "v1",
    );
    assert.ok(
      !prepared.pools.some((p) => p.poolId === hookedId),
      "prepare excludes the hooked pool at launch policy",
    );
  });
});
