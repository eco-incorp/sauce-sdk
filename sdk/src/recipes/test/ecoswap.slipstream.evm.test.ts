/**
 * EcoSwap Slipstream-CL local-EVM round-trip — the tickSpacing-keyed discovery gate.
 *
 * Velodrome/Aerodrome Slipstream (and the Ramses-lineage Shadow) CL pools are UniswapV3-compatible
 * for pricing AND execution: the pool exposes the standard V3 view surface (slot0/ticks/liquidity/
 * tickSpacing/fee) and its swap() re-enters the caller via the EXACT `uniswapV3SwapCallback` selector
 * the engine Router already implements (V3 callbacks are authenticated by the transient expectedPool,
 * NOT a factory/CREATE2 check), so a Slipstream pool executes through the existing flat `swapV3` path
 * with NO engine change. The ONLY thing that differs from Uniswap V3 is DISCOVERY: the CLFactory keys
 * pools by TICK SPACING — getPool(tokenA, tokenB, int24 tickSpacing) — NOT getPool(a, b, uint24 fee),
 * and Slipstream DECOUPLES fee from tickSpacing so the per-pool fee must be READ from fee().
 *
 * The faithful minimal fixture is a SlipstreamCLFactory shim exposing getPool(a,b,int24)->pool,
 * pointing at a pool built with the EXISTING V3 fixture (a REAL @uniswap/v3-core pool + the
 * V3LiquidityHelper the other tests use — it already has fee()/tickSpacing()/slot0()/ticks() and calls
 * uniswapV3SwapCallback). The pool is registered in the shim under its tickSpacing. Because the executed
 * swap math IS real v3-core math, the output is WEI-EXACT against the EcoSwap V3 oracle — the same
 * wei-exactness the standard V3 EVM test asserts.
 *
 * Cells (dual-engine, v1 + v12, ECO_ENGINE / SAUCE_ENGINE_V12 gated; fresh anvil per cell):
 *   (a) DISCOVERY — the tickSpacing-keyed branch surfaces the pool via getPool(a,b,int24) and reads
 *       its fee() correctly (a fee that is NOT its tickSpacing key).
 *   (b) SOLO      — one EcoSwap routes the whole trade through the discovered Slipstream pool via the
 *       existing swapV3 path; the cook succeeds and spent == oracle totalInput to the wei.
 *   (c) SPLIT     — one EcoSwap splits across the Slipstream pool + a plain V3 pool; both receive
 *       input, per-pool input == oracle to the wei, and post-fee marginals equalize at the cut.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Abi, type Account, type Hex } from "viem";

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
  getSlot0,
  deploySlipstreamFactory,
  createAndRegisterSlipstreamPool,
  slipstreamFactoryAbi,
  v3PoolAbi,
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
import { discoverPools } from "../shared/pool-discovery";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { feeAdjust, toOutIn } from "./ecoswap.math";

const HUGE = parseEther("1000000000");
const ENGINE_CELLS = engineCells();

// The Slipstream pool's DISCOVERY key: an int24 tickSpacing. 10 is the pool's REAL grid (fee 500 →
// feeAmountTickSpacing 10), so this fixture is production-FAITHFUL: real Slipstream `getPool(a,b,ts)`
// returns a pool whose `tickSpacing() == ts` (only the FEE is decoupled from the key), and here the
// key (10) equals the pool's live `tickSpacing()` (10). Keeping key == grid means the lens's
// multiplicative sqrt step (derived off-chain from the key) and its tick-boundary stride (the live
// `tickSpacing()`) can never diverge — the divergence a key != grid fixture would silently create.
const SLIP_TICK_SPACING = 10;
// The pool's REAL V3 fee tier (what fee() returns). 500 (0.05%) is DECOUPLED from the discovery key:
// fee() = 500 while the tickSpacing key = 10. This proves the discovery/lens path READS the per-pool
// fee from fee() (500) rather than assuming it from the tickSpacing key (10) — exactly Slipstream's
// fee/tickSpacing decoupling. The mints use bounds divisible by 10 so they align to the real V3 grid.
const SLIP_FEE = 500;
// A plain V3 pool for the split cell (fee 3000, standard tier).
const V3_FEE = 3000;

describe("EcoSwap Slipstream-CL (local shim over real V3) — tickSpacing-keyed discovery + swapV3 round-trip", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == token0 (zeroForOne = true)
  let tokenOut: Hex; // == token1
  let slipFactory: Hex;

  async function setup(): Promise<void> {
    // Tear the prior anvil down and WAIT for it to fully exit (port released) before booting the next
    // — a fire-and-forget stop() races the new startAnvil() under machine load and flakes a cook.
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

    // Fund + approve the minter (account0) for both tokens (the liquidity helper pulls via
    // transferFrom on mint; the caller approves the cook target for its input separately).
    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("50000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // The Slipstream CLFactory shim — discovery/lens resolve tickSpacing-keyed getPool(a,b,int24).
    slipFactory = await deploySlipstreamFactory(c.walletClient, c.publicClient);

    // v12 engine stack (same anvil, same pools). The Pot is owned by account0 (the cook caller);
    // account0 approves the POT for tokenIn (the v12 program does transferFrom(caller, self=Pot, …)).
    const owner = c.walletClient.account as Account;
    v12 = await maybeDeployV12Stack(c, owner);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);
  }

  before(setup);

  after(() => {
    anvil?.stop();
  });

  async function reset(): Promise<void> {
    await setup();
  }

  /**
   * poolConfig pointing discovery + the lens at the local Slipstream CLFactory (and optionally the
   * standard V3 factory too). `slipstreamTickSpacings` carries the fixture's discovery key. baseTokens
   * = the swap pair so the multi-hop route loop yields ZERO routes (keeps the focus on direct pools).
   */
  function poolConfig(withStandardV3: boolean): ChainPoolConfig {
    const factories = [
      {
        address: slipFactory,
        poolType: SwapPoolType.UniV3,
        factoryType: FactoryType.SlipstreamCL,
        label: "Local Slipstream CL",
        slipstreamTickSpacings: [SLIP_TICK_SPACING],
      },
    ];
    if (withStandardV3) {
      // The fixture builds the Slipstream pool THROUGH the real V3 factory (a Slipstream pool IS a
      // real v3-core pool), so that factory's own fee-tier map also holds it at fee 500. Restrict the
      // standard-V3 discovery to the 3000 tier so it surfaces ONLY the plain V3 pool — the Slipstream
      // pool is surfaced solely by the tickSpacing-keyed Slipstream factory (no double-count).
      factories.push({
        address: stack.factory,
        poolType: SwapPoolType.UniV3,
        factoryType: FactoryType.V3Standard,
        label: "Local UniV3",
        feeTiers: [V3_FEE],
      } as (typeof factories)[number]);
    }
    return { factories, feeTiers: [500, 3000, 10000], baseTokens: [tokenIn, tokenOut] };
  }

  /** Post-swap fee-adjusted out/in marginal price for a V3-shaped pool's live slot0. */
  async function feeAdjMarginal(pool: Hex, feePpm: number): Promise<bigint> {
    const { sqrtPriceX96 } = await getSlot0(c.publicClient, pool);
    return feeAdjust(toOutIn(sqrtPriceX96, true), feePpm);
  }

  // ── (a) DISCOVERY — tickSpacing-keyed getPool + fee() read ──
  async function runDiscovery(engine: Engine): Promise<void> {
    await reset();
    const caller = c.account0;

    // A single Slipstream pool (real V3 pool registered under its tickSpacing) with deep wide
    // liquidity at 1:1. Bounds divisible by 10 (the fee-500 tier's real grid spacing).
    const pool = await createAndRegisterSlipstreamPool(
      c.walletClient, c.publicClient, stack.factory, slipFactory,
      tokenIn, tokenOut, SLIP_FEE, SLIP_TICK_SPACING, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, caller, -12000, 12000, parseEther("400000"));

    // The shim resolves the pool by its int24 tickSpacing key (both token orderings).
    const resolved = (await c.publicClient.readContract({
      address: slipFactory, abi: slipstreamFactoryAbi as Abi, functionName: "getPool",
      args: [tokenIn, tokenOut, SLIP_TICK_SPACING],
    })) as Hex;
    assert.equal(resolved.toLowerCase(), pool.toLowerCase(), "shim resolves the pool by its tickSpacing key");
    // The pool's OWN fee() is the decoupled value the discovery path must READ (not the ts key).
    const poolFee = Number(await c.publicClient.readContract({
      address: pool, abi: v3PoolAbi as Abi, functionName: "fee",
    }));
    assert.equal(poolFee, SLIP_FEE, "pool fee() is decoupled from its tickSpacing key");
    assert.notEqual(poolFee, SLIP_TICK_SPACING, "the read fee is NOT the tickSpacing discovery key");

    // REAL discovery → lens → bracket build. The tickSpacing-keyed branch must surface the pool as a
    // UniV3-shaped row carrying the fee READ from fee(), not the tickSpacing key.
    const amountIn = parseEther("5000");
    const { prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12),
      caller, poolConfig(false), undefined, engine,
    );

    assert.equal(prepared.pools.length, 1, "exactly one direct pool (the Slipstream pool)");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    const p = prepared.pools[0];
    assert.equal(p.poolType, SwapPoolType.UniV3, "Slipstream pool surfaces as a UniV3-shaped row (poolType=1)");
    assert.equal(p.address.toLowerCase(), pool.toLowerCase(), "the discovered pool is the local Slipstream pool");
    assert.equal(p.feePpm, SLIP_FEE, "the fee READ from fee() (500) threads into feePpm — NOT the tickSpacing key (10)");

    console.log(
      `  [Slipstream discovery:${engine}] tickSpacingKey=${SLIP_TICK_SPACING} fee()=${poolFee} ` +
        `feePpm=${p.feePpm} poolType=${p.poolType} addr=${p.address}`,
    );
  }

  // ── (a2) AGGREGATOR DISCOVERY — the off-chain discoverPools() Slipstream branch ──
  //
  // The EcoSwap direct path drives discovery through the ON-CHAIN lens (runLens), so the off-chain
  // aggregator `discoverSlipstreamCLPools` (its tickSpacing-keyed getPool fan-out + per-pool fee()
  // read + PoolInfo assembly) is never exercised by the solo/split cells. This cell calls the public
  // `discoverPools` over a SlipstreamCL-only config and asserts the returned PoolInfo carries the SAME
  // field set a V3 record carries: poolType UniV3, fee == the pool's fee() (500 — NOT the tickSpacing
  // key 10), a live sqrtPriceX96/liquidity, and priceLimited (V3 supports sqrtPriceLimitX96). This is
  // engine-independent (pure read-only RPC), so it runs once.
  async function runAggregatorDiscovery(): Promise<void> {
    await reset();
    const caller = c.account0;

    const pool = await createAndRegisterSlipstreamPool(
      c.walletClient, c.publicClient, stack.factory, slipFactory,
      tokenIn, tokenOut, SLIP_FEE, SLIP_TICK_SPACING, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, caller, -12000, 12000, parseEther("400000"));

    const found = await discoverPools(tokenIn, tokenOut, c.publicClient, poolConfig(false));
    assert.equal(found.length, 1, "discoverPools surfaces exactly the one Slipstream pool");
    const p = found[0];
    assert.equal(p.address.toLowerCase(), pool.toLowerCase(), "the discovered pool is the local Slipstream pool");
    assert.equal(p.poolType, SwapPoolType.UniV3, "Slipstream PoolInfo is a UniV3-shaped row (poolType=1)");
    assert.equal(p.fee, SLIP_FEE, "PoolInfo.fee is READ from the pool's fee() (500) — NOT the tickSpacing key (10)");
    assert.notEqual(p.fee, SLIP_TICK_SPACING, "the aggregator did NOT assume fee from the tickSpacing key");
    assert.equal(p.tokenIn.toLowerCase(), tokenIn.toLowerCase(), "PoolInfo.tokenIn threaded through");
    assert.equal(p.tokenOut.toLowerCase(), tokenOut.toLowerCase(), "PoolInfo.tokenOut threaded through");
    assert.equal(p.priceLimited, true, "V3-priced Slipstream pool is priceLimited (sqrtPriceLimitX96)");
    assert.ok(p.sqrtPriceX96 > 0n, "PoolInfo carries a live sqrtPriceX96");
    assert.ok(p.liquidity > 0n, "PoolInfo carries a live liquidity");
    // Faithful fixture: key == real grid, so the discovery key IS the pool's live tickSpacing.
    assert.equal(p.tickSpacing, SLIP_TICK_SPACING, "PoolInfo.tickSpacing carries the discovery key (== the real grid here)");

    console.log(
      `  [Slipstream aggregator] discoverPools → poolType=${p.poolType} fee=${p.fee} ` +
        `tickSpacing=${p.tickSpacing} sqrtP=${p.sqrtPriceX96} liq=${p.liquidity} addr=${p.address}`,
    );
  }

  // ── (b) SOLO — execute the whole trade through the Slipstream pool via swapV3 ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const pool = await createAndRegisterSlipstreamPool(
      c.walletClient, c.publicClient, stack.factory, slipFactory,
      tokenIn, tokenOut, SLIP_FEE, SLIP_TICK_SPACING, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, caller, -12000, 12000, parseEther("400000"));

    const amountIn = parseEther("5000");
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12),
      caller, poolConfig(false), undefined, engine,
    );
    assert.equal(prepared.pools.length, 1, "exactly one direct pool (the Slipstream pool)");
    assert.equal(prepared.pools[0].feePpm, SLIP_FEE, "fee read from fee() threads into feePpm");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Slipstream cook() must succeed (swapV3 / uniswapV3SwapCallback)");

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.ok(received > 0n, "caller received tokenOut");
    assert.ok(poolIn > 0n, "the Slipstream pool received tokenIn (input pulled via uniswapV3SwapCallback)");

    // WEI-EXACT: the single-pass solver pulls exactly cum == oracle totalInput; the solo deep pool
    // takes the remainder with no binding price limit ⇒ spent == amountIn.
    const ref = ecoSwapReference(prepared, amountIn);
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY");
    assert.equal(spent, amountIn, "solo deep pool absorbs the whole trade ⇒ spent == amountIn");
    assert.equal(poolIn, amountIn, "all of amountIn routed into the Slipstream pool");

    console.log(
      `  [Slipstream solo:${engine}] fee=${SLIP_FEE} spent=${spent} received=${received} ` +
        `poolIn=${poolIn} (oracle totalInput=${ref.totalInput})`,
    );
  }

  // ── (c) SPLIT — Slipstream pool + a plain V3 pool, marginals equalize ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // The Slipstream pool (fee 500) + a plain V3 pool (fee 3000) at the SAME 1:1 spot → the cheaper
    // fee-500 Slipstream pool draws first; the V3 pool joins once fee-adjusted marginals converge.
    const slipPool = await createAndRegisterSlipstreamPool(
      c.walletClient, c.publicClient, stack.factory, slipFactory,
      tokenIn, tokenOut, SLIP_FEE, SLIP_TICK_SPACING, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, slipPool, caller, -12000, 12000, parseEther("300000"));
    const v3Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3Pool, caller, -12000, 12000, parseEther("300000"));

    const amountIn = parseEther("8000");
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const slipInBefore = await balanceOf(c.publicClient, tokenIn, slipPool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3Pool);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12),
      caller, poolConfig(true), undefined, engine,
    );

    assert.equal(prepared.pools.length, 2, "two direct pools (Slipstream + plain V3)");
    const slipIdx = prepared.pools.findIndex((p) => p.address.toLowerCase() === slipPool.toLowerCase());
    const v3Idx = prepared.pools.findIndex((p) => p.address.toLowerCase() === v3Pool.toLowerCase());
    assert.ok(slipIdx >= 0 && v3Idx >= 0, "both the Slipstream and the plain V3 pool discovered");
    assert.equal(prepared.pools[slipIdx].feePpm, SLIP_FEE, "Slipstream fee (read from fee()) is 500");
    assert.equal(prepared.pools[v3Idx].feePpm, V3_FEE, "plain V3 pool fee is its tier (3000)");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "split Slipstream+V3 cook() must succeed");

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const slipIn = (await balanceOf(c.publicClient, tokenIn, slipPool)) - slipInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3Pool)) - v3InBefore;

    // BOTH pools funded → the trade genuinely SPLIT across the Slipstream + V3 venues.
    assert.ok(slipIn > 0n, "the Slipstream pool received input");
    assert.ok(v3In > 0n, "the plain V3 pool received input");
    assert.ok(received > 0n, "caller received tokenOut");

    // WEI-EXACT: spent == oracle totalInput; per-pool input == oracle to the wei.
    const ref = ecoSwapReference(prepared, amountIn);
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY");
    assert.equal(slipIn, ref.perPoolInput[slipIdx], "Slipstream pool input == oracle to the wei");
    assert.equal(v3In, ref.perPoolInput[v3Idx], "plain V3 pool input == oracle to the wei");

    // The cheaper-fee Slipstream pool draws strictly more than the 0.30% V3 pool (same depth tier,
    // same spot) — proving the READ fee genuinely steered the split.
    assert.ok(slipIn > v3In, `cheaper-fee Slipstream pool draws more (slip ${slipIn} > v3 ${v3In})`);

    // Post-fee marginals equalize across the two filled pools (the single-cut target). Spot prices
    // differ by fee; the fee-adjusted marginals agree.
    const margSlip = await feeAdjMarginal(slipPool, SLIP_FEE);
    const margV3 = await feeAdjMarginal(v3Pool, V3_FEE);
    const maxAdj = margSlip > margV3 ? margSlip : margV3;
    const minAdj = margSlip < margV3 ? margSlip : margV3;
    const spread = Number(maxAdj - minAdj) / Number(maxAdj);
    assert.ok(spread < 0.02, `post-swap fee-adj marginals cluster (spread ${spread}; slip ${margSlip} v3 ${margV3})`);

    console.log(
      `  [Slipstream split:${engine}] slip(fee=${SLIP_FEE})In=${slipIn} v3(${V3_FEE})In=${v3In} ` +
        `received=${received} spent=${spent} (oracle slip=${ref.perPoolInput[slipIdx]} v3=${ref.perPoolInput[v3Idx]}); ` +
        `marginals slip=${margSlip} v3=${margV3} spread=${spread}`,
    );
  }

  // Engine-independent (pure off-chain RPC) — exercises the discoverPools() Slipstream aggregator once.
  it("Slipstream aggregator discovery — discoverPools() surfaces a UniV3-shaped PoolInfo with fee READ from fee()", async () => {
    await runAggregatorDiscovery();
  });

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Slipstream discovery [${engine}] — tickSpacing-keyed getPool surfaces the pool + reads fee() (decoupled)`, { skip }, async () => {
      await runDiscovery(engine);
    });
    it(`Slipstream solo [${engine}] — swapV3 round-trip: received tokenOut, spent == oracle to the wei`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Slipstream split [${engine}] — splits with a plain V3 pool, per-pool input == oracle + marginals equalize`, { skip }, async () => {
      await runSplit(engine);
    });
  }
});
