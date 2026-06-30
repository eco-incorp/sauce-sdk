/**
 * EcoSwap Algebra-fork local-EVM round-trip — the engine `algebraSwapCallback` execution gate.
 *
 * Algebra pools (Camelot V3, QuickSwap V3, Ramses V2) are V3-shaped: their `swap()` is
 * selector-identical to Uniswap V3, so the engine's `_swapV3` drives them unchanged. The ONLY
 * difference is the mid-swap re-entry — an Algebra pool calls `algebraSwapCallback` (NOT
 * `uniswapV3SwapCallback`) to pull input. The engine now SERVICES that selector (sauce#186), so
 * an Algebra pool is EXECUTABLE. This test PROVES the round-trip end to end with NO fork.
 *
 * The Algebra pool is an ADAPTER over a GENUINE Uniswap V3 pool (AlgebraPool.sol): it forwards
 * every read the lens uses (globalState/liquidity/tickSpacing/ticks) to the inner pool and on
 * `swap()` drives the inner pool, re-entering the engine via `algebraSwapCallback` to collect the
 * input. Because the executed swap math IS real v3-core math (the inner pool), the output is
 * WEI-EXACT against the EcoSwap V3 oracle at the dynamic fee — the same wei-exactness the standard
 * V3 EVM test asserts.
 *
 * Phases (each engine cell, v1 + v12):
 *   (1) DISCOVER + PRICE — the lens surfaces the Algebra pool as a UniV3 row carrying the
 *       globalState price + the DYNAMIC fee (a non-tier value), via the local AlgebraFactory.
 *   (2) SOLO EXECUTE — one EcoSwap routes the WHOLE trade through the Algebra pool: it receives
 *       tokenIn + produces tokenOut, the cook SUCCEEDS (proving the engine algebraSwapCallback
 *       path), and spent == oracle totalInput to the wei.
 *   (3) SPLIT — one EcoSwap splits across the Algebra pool + a standard V3 pool: BOTH receive
 *       input, per-pool input == oracle to the wei, and post-fee marginals equalize.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  mint,
  approve,
  balanceOf,
  createAndInitPool,
  mintPosition,
  getLiquidity,
  getSlot0,
  deployAlgebraFactory,
  enableV3FeeAmount,
  setupAlgebraPool,
  getAlgebraGlobalState,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { feeAdjust, toOutIn } from "./ecoswap.math";

const HUGE = parseEther("1000000000");
const ENGINE_CELLS = engineCells();

// A genuinely DYNAMIC (non-tier) Algebra fee: 450 ppm = 0.045%, not a standard Uniswap tier
// (500/3000/10000). We enable it on the V3 factory so the inner pool charges EXACTLY this, and
// the adapter reports it as the globalState dynamic fee — so the oracle prices at the same fee
// the inner pool executes at (wei-exact). tickSpacing 10 (a valid spacing for the enabled tier);
// the lens reads the Algebra tickSpacing from the factory config, so it MUST match (set below).
const ALG_DYN_FEE = 450;
const ALG_TICK_SPACING = 10;

describe("EcoSwap Algebra-fork (local adapter over real V3) — engine algebraSwapCallback round-trip", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == token0 (zeroForOne = true)
  let tokenOut: Hex; // == token1
  let algebraFactory: Hex;
  let cleanSnapshot: Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    // Fund + approve the minter (account0) for both tokens (the liquidity helper pulls via
    // transferFrom on mint; the caller approves the cook target for its input separately).
    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("50000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // Enable the non-standard Algebra dynamic fee tier on the V3 factory so the inner pool can be
    // created at it. (500 is enabled by default; 450 is not — this is what makes the fee "dynamic".)
    await enableV3FeeAmount(c.walletClient, c.publicClient, stack.factory, ALG_DYN_FEE, ALG_TICK_SPACING);

    algebraFactory = await deployAlgebraFactory(c.walletClient, c.publicClient);

    // v12 engine stack (same anvil, same pools). The Pot is owned by account0 (the cook caller);
    // account0 approves the POT for tokenIn (the v12 program does transferFrom(caller, self=Pot, …)).
    const owner = c.walletClient.account as Account;
    v12 = await maybeDeployV12Stack(c, owner);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function reset(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    // Pin the cook block timestamp: the inner V3 pool's oracle accumulator depends on
    // block.timestamp, which drifts across evm_revert (see ecoswap.evm.test.ts).
    await c.testClient.setNextBlockTimestamp({ timestamp: 2_000_000_000n });
  }

  /** poolConfig pointing discovery + the lens at the local AlgebraFactory (and optionally the
   *  standard V3 factory too). baseTokens = the swap pair so the multi-hop route loop yields
   *  ZERO routes (keeps the focus on direct-pool Algebra execution). */
  function poolConfig(withStandardV3: boolean): ChainPoolConfig {
    const factories = [
      {
        address: algebraFactory,
        poolType: SwapPoolType.UniV3,
        factoryType: FactoryType.AlgebraV3,
        label: "Local Algebra",
        algebraTickSpacing: ALG_TICK_SPACING,
      },
    ];
    if (withStandardV3) {
      factories.push({
        address: stack.factory,
        poolType: SwapPoolType.UniV3,
        factoryType: FactoryType.V3Standard,
        label: "Local UniV3",
      } as (typeof factories)[number]);
    }
    return { factories, feeTiers: [500, 3000, 10000], baseTokens: [tokenIn, tokenOut] };
  }

  /** Post-swap fee-adjusted out/in marginal price for a pool's live globalState (Algebra). */
  async function feeAdjMarginalAlgebra(pool: Hex, feePpm: number): Promise<bigint> {
    const { sqrtPriceX96 } = await getAlgebraGlobalState(c.publicClient, pool);
    return feeAdjust(toOutIn(sqrtPriceX96, true), feePpm);
  }

  // ── Phase 1+2: discover + price + SOLO execute through the Algebra pool ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // One Algebra pool (adapter over a genuine V3 pool) with deep wide liquidity at 1:1.
    const { pool: alg, inner } = await setupAlgebraPool(
      c.walletClient, c.publicClient, stack.factory, algebraFactory, stack.helper,
      tokenIn, tokenOut, ALG_DYN_FEE, ALG_DYN_FEE, SQRT_PRICE_1_1,
      [[-12000, 12000, parseEther("400000")]],
    );

    // Phase 1: the lens surfaces the Algebra pool as a UniV3 row with the globalState price +
    // dynamic fee. (Read its live globalState for the cross-check.)
    const gs = await getAlgebraGlobalState(c.publicClient, alg);
    assert.equal(gs.feeZto, ALG_DYN_FEE, "adapter reports the dynamic fee (450 ppm) for zeroToOne");
    assert.ok((await getLiquidity(c.publicClient, alg)) > 0n, "adapter proxies inner pool liquidity > 0");

    const amountIn = parseEther("5000");
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const innerInBefore = await balanceOf(c.publicClient, tokenIn, inner);

    // REAL discovery → lens → bracket build → solver → compile, then cook.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig(false),
      undefined,
      engine,
    );

    // The lens surfaced exactly the one Algebra pool, as a UniV3 row carrying the dynamic fee.
    assert.equal(prepared.pools.length, 1, "exactly one direct pool (the Algebra pool)");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    const algPool = prepared.pools[0];
    assert.equal(algPool.poolType, SwapPoolType.UniV3, "Algebra pool surfaces as a UniV3-shaped row (poolType=1)");
    assert.equal(algPool.feePpm, ALG_DYN_FEE, "the DYNAMIC fee (450 ppm) threads into feePpm");
    assert.equal(algPool.address.toLowerCase(), alg.toLowerCase(), "the discovered pool is the local adapter");
    // The prepared direct pool carries the live spot sqrt in spotNearReal (== globalState price).
    assert.equal(algPool.spotNearReal, gs.sqrtPriceX96, "globalState price surfaced as the spot sqrt price");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Algebra cook() must succeed (algebraSwapCallback serviced)");

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const innerIn = (await balanceOf(c.publicClient, tokenIn, inner)) - innerInBefore;

    assert.ok(received > 0n, "caller received tokenOut");
    assert.ok(innerIn > 0n, "the Algebra pool's inner V3 pool received tokenIn (input pulled via algebraSwapCallback)");

    // WEI-EXACT: the single-pass solver pulls exactly cum == oracle totalInput; with only this
    // deep pool and no binding price limit the crossing pool takes the remainder ⇒ spent == amountIn.
    const ref = ecoSwapReference(prepared, amountIn);
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY");
    assert.equal(spent, amountIn, "solo deep pool absorbs the whole trade ⇒ spent == amountIn");
    // The whole input flowed into the Algebra pool's inner V3 pool.
    assert.equal(innerIn, amountIn, "all of amountIn routed into the Algebra pool");

    console.log(
      `  [Algebra solo:${engine}] dynFee=${ALG_DYN_FEE} spent=${spent} received=${received} ` +
        `innerIn=${innerIn} (poolType=${algPool.poolType} V3; oracle totalInput=${ref.totalInput})`,
    );
  }

  // ── Phase 3: SPLIT across the Algebra pool + a standard V3 pool ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // The Algebra pool (dynamic 450 ppm) + a standard V3 pool (fee 3000) at the SAME 1:1 spot but
    // different fees/depths → the water-fill must split: the cheaper Algebra fee draws first, the
    // V3 pool joins once marginals converge.
    const { pool: alg, inner } = await setupAlgebraPool(
      c.walletClient, c.publicClient, stack.factory, algebraFactory, stack.helper,
      tokenIn, tokenOut, ALG_DYN_FEE, ALG_DYN_FEE, SQRT_PRICE_1_1,
      [[-12000, 12000, parseEther("400000")]],
    );
    const v3Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, 3000, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3Pool, caller, -12000, 12000, parseEther("250000"));

    const amountIn = parseEther("8000");
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const innerInBefore = await balanceOf(c.publicClient, tokenIn, inner);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3Pool);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig(true),
      undefined,
      engine,
    );

    // Both pools surface (Algebra + standard V3); the Algebra one carries the dynamic fee.
    assert.equal(prepared.pools.length, 2, "two direct pools (Algebra + standard V3)");
    const algIdx = prepared.pools.findIndex((p) => p.address.toLowerCase() === alg.toLowerCase());
    const v3Idx = prepared.pools.findIndex((p) => p.address.toLowerCase() === v3Pool.toLowerCase());
    assert.ok(algIdx >= 0 && v3Idx >= 0, "both the Algebra and the V3 pool discovered");
    assert.equal(prepared.pools[algIdx].poolType, SwapPoolType.UniV3, "Algebra pool is a UniV3-shaped row");
    assert.equal(prepared.pools[algIdx].feePpm, ALG_DYN_FEE, "Algebra dynamic fee threads (450 ppm)");
    assert.equal(prepared.pools[v3Idx].feePpm, 3000, "standard V3 pool fee is its tier (3000)");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "split Algebra+V3 cook() must succeed");

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const innerIn = (await balanceOf(c.publicClient, tokenIn, inner)) - innerInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3Pool)) - v3InBefore;

    // BOTH pools funded → the trade genuinely SPLIT across the Algebra + V3 venues.
    assert.ok(innerIn > 0n, "the Algebra pool received input");
    assert.ok(v3In > 0n, "the standard V3 pool received input");
    assert.ok(received > 0n, "caller received tokenOut");

    // WEI-EXACT: spent == oracle totalInput; per-pool input == oracle to the wei.
    const ref = ecoSwapReference(prepared, amountIn);
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY");
    const algRefIn = ref.perPoolInput[algIdx];
    const v3RefIn = ref.perPoolInput[v3Idx];
    assert.equal(innerIn, algRefIn, "Algebra pool input == oracle to the wei");
    assert.equal(v3In, v3RefIn, "standard V3 pool input == oracle to the wei");

    // The cheaper-fee Algebra pool draws strictly more than the 0.30% V3 pool (same depth tier,
    // same spot) — proving the dynamic fee genuinely steered the split.
    assert.ok(innerIn > v3In, `cheaper-fee Algebra pool draws more (alg ${innerIn} > v3 ${v3In})`);

    // Post-fee marginals equalize across the two filled pools (the single-cut target). The Algebra
    // marginal reads its live globalState (== inner pool's slot0); the V3 marginal reads slot0.
    const margAlg = await feeAdjMarginalAlgebra(alg, ALG_DYN_FEE);
    const v3Slot = await getSlot0(c.publicClient, v3Pool);
    const margV3 = feeAdjust(toOutIn(v3Slot.sqrtPriceX96, true), 3000);
    const maxAdj = margAlg > margV3 ? margAlg : margV3;
    const minAdj = margAlg < margV3 ? margAlg : margV3;
    const spread = Number(maxAdj - minAdj) / Number(maxAdj);
    assert.ok(spread < 0.02, `post-swap fee-adj marginals cluster (spread ${spread}; alg ${margAlg} v3 ${margV3})`);

    console.log(
      `  [Algebra split:${engine}] alg(dynFee=${ALG_DYN_FEE})In=${innerIn} v3(3000)In=${v3In} ` +
        `received=${received} spent=${spent} (oracle alg=${algRefIn} v3=${v3RefIn}); ` +
        `marginals alg=${margAlg} v3=${margV3} spread=${spread}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Algebra solo [${engine}] — discover+price+execute: received tokenOut, spent == oracle to the wei`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Algebra split [${engine}] — splits with a standard V3 pool, per-pool input == oracle to the wei`, { skip }, async () => {
      await runSplit(engine);
    });
  }
});
