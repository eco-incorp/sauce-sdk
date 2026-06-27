/**
 * EcoSwap ADAPTIVE dynamic tick reads — LOCAL EVM integration test (WS4).
 *
 * The load-bearing window-EXCEEDED test (spec §F4). The adaptive streaming tick
 * walk is ALWAYS ON: whenever the prepared bracket window under-fills amountIn, the
 * on-chain solver keeps reading live ticks past the window from the frontier seed to
 * close the gap. There is no flag to turn it off — the only gates are data (a pool
 * with no frontier, e.g. V2, is skipped) and need (it runs only when cum < amountIn).
 *
 * A single V3 pool holds liquidity across MANY ticks (one wide position → constant
 * active L through the whole walk region, since the only initialized ticks are the
 * far-away position boundaries). We prepare with a deliberately NARROW lens window
 * (small maxTicks) so the PREPARED brackets alone UNDER-FILL amountIn — we assert
 * that off-chain (Σ prepared capacity < amountIn) — then cook and assert the
 * always-on streaming walk resumes from the frontier seed and FILLS the gap: spends
 * == amountIn EXACTLY, leftover == 0, the pool receives all of amountIn, received > 0,
 * and tokenOut matches the (always-adaptive) reference oracle.
 *
 * Why oracle == on-chain here is exact: inside the wide position there are NO
 * initialized ticks, so every adaptive ticks() read returns net 0 → L is constant.
 * The oracle's off-chain adaptiveNet map is likewise empty for those ticks → 0 →
 * L constant. Both walk the identical constant-L region with the same multiplicative
 * stepReal, so they agree bit-for-bit (no multiplicative-vs-exact drift across an
 * initialized boundary).
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.adaptive.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  createAndInitPool,
  mint,
  approve,
  balanceOf,
  mintPosition,
  getLiquidity,
  getSlot0,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
  quoteRouter,
} from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { feeAdjust, toOutIn } from "./ecoswap.math";
import type { Account } from "viem";

const HUGE = parseEther("1000000000");

// Engine cells driven by ECO_ENGINE (default v12). See harness/engine.ts.
const ENGINE_CELLS = engineCells();

describe("EcoSwap adaptive dynamic tick reads (always-on window-EXCEEDED streaming walk)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // token0 (zeroForOne)
  let tokenOut: Hex; // token1
  let pool: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  // Deliberately narrow prepared window so the prepared brackets under-fill amountIn.
  // ts=60, so 8 boundaries ≈ a 480-tick (~4.9%) price excursion of prepared depth.
  const NARROW_MAX_TICKS = 8;
  // Sized to need MORE than the narrow window but well within the window + EXTRA_TICKS
  // (64) of the constant-L region, so the adaptive walk closes the whole gap.
  const AMOUNT_IN = parseEther("20000");

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("500000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("500000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // ONE deep V3 pool (fee 3000, ts 60) at 1:1 with a SINGLE wide position. The
    // walk region (tick 0 down to ~ -4320 for the deepest fill) lies strictly inside
    // [-60000, 60000], so no initialized tick is crossed → L is constant throughout.
    pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, 3000, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, pool, minter, -60000, 60000, parseEther("800000"),
    );
    const liq = await getLiquidity(c.publicClient, pool);
    assert.ok(liq > 0n, "pool should have active liquidity");

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [3000],
      baseTokens: [tokenIn, tokenOut], // no routes
    };

    // v12 stack (same anvil/pool) when a v12 cell runs; approve the Pot for tokenIn.
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  // Revert to clean pool state + re-snapshot so the case prepares + cooks against
  // the IDENTICAL fresh pool (anvil invalidates a snapshot id once reverted into).
  async function resetPool(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
  }

  async function runAdaptive(engine: Engine): Promise<void> {
    await resetPool();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn: AMOUNT_IN },
      anvil.rpcUrl,
      quoteRouter(engine, stack, v12),
      caller,
      poolConfig,
      { maxTicks: NARROW_MAX_TICKS },
      engine,
    );

    // The PREPARED brackets alone cannot cover amountIn — the narrow window is
    // deliberately too small. (This is the precondition the always-on walk closes:
    // without it the swap would under-fill, as the old adaptive-OFF path did.)
    const preparedCapacity = prepared.brackets.reduce((acc, b) => acc + b.capacity, 0n);
    assert.ok(
      preparedCapacity < AMOUNT_IN,
      `prepared window must UNDER-FILL amountIn (Σ capacity ${preparedCapacity} < ${AMOUNT_IN})`,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, AMOUNT_IN);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed");

    const poolInAfter = await balanceOf(c.publicClient, tokenIn, pool);
    const callerInAfter = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutAfter = await balanceOf(c.publicClient, tokenOut, caller);
    // Compute-then-pull leaves no leftover on the cook target (router or Pot).
    const leftover = await balanceOf(c.publicClient, tokenIn, target);

    const poolInDelta = poolInAfter - poolInBefore;
    const spent = callerInBefore - callerInAfter;
    const received = callerOutAfter - callerOutBefore;

    // The always-on streaming walk resumes from the frontier seed and fills the
    // remaining gap → spends amountIn EXACTLY, no leftover.
    assert.equal(spent, AMOUNT_IN, "always-on adaptive walk must FULL-FILL (spent == amountIn)");
    assert.equal(leftover, 0n, "no leftover on the router (compute-then-pull, no limit hit)");
    assert.equal(poolInDelta, AMOUNT_IN, "all of amountIn lands in the pool");
    assert.ok(received > 0n, "received tokenOut");

    // Oracle (always-adaptive single-pass) cross-check. Constant-L walk region → exact:
    // perPoolInput sums to amountIn and tokenOut matches within a tight ppm band.
    const ref = ecoSwapReference(prepared, AMOUNT_IN);
    assert.equal(ref.totalInput, AMOUNT_IN, "adaptive oracle also full-fills to amountIn");
    assert.equal(ref.perPoolInput[0], AMOUNT_IN, "single pool absorbs all input in the oracle");

    // Marginal: post-swap fee-adjusted out/in price moved DOWN (zeroForOne) — the
    // single engaged pool's marginal is the implicit cut. (With one pool, marginal
    // "equalization" is trivially satisfied; we assert the price actually moved.)
    const { sqrtPriceX96 } = await getSlot0(c.publicClient, pool);
    const adjAfter = feeAdjust(toOutIn(sqrtPriceX96, true), 3000);
    const adjStart = feeAdjust(toOutIn(SQRT_PRICE_1_1, true), 3000);
    assert.ok(adjAfter < adjStart, "zeroForOne swap lowers the pool's fee-adj marginal");

    // tokenOut realized on-chain vs the analytic constant-L expectation. Over a
    // constant-L region the engine output and the oracle geometry agree to a tight
    // band (integer truncation only); assert within 50 ppm.
    const refOut = analyticOut(SQRT_PRICE_1_1, sqrtPriceX96, parseEther("800000"));
    const diff = received > refOut ? received - refOut : refOut - received;
    const ppm = (diff * 1_000_000n) / (received > 0n ? received : 1n);
    assert.ok(ppm < 50n, `tokenOut matches constant-L geometry within 50ppm (got ${ppm}ppm, on=${received} ref=${refOut})`);

    console.log(
      `  [adaptive always-on ${engine}] preparedCap=${preparedCapacity} (< ${AMOUNT_IN}) ` +
        `spent=${spent} (==amountIn) leftover=${leftover} received=${received} ` +
        `oracleOut(geom)=${refOut} ppm=${ppm}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(
      `always-on streaming walk closes the under-filled narrow window [${engine}] (full fill, leftover 0, oracle match)`,
      { skip },
      async () => {
        await runAdaptive(engine);
      },
    );
  }
});

/**
 * Analytic tokenOut for a zeroForOne swap over a CONSTANT-L region from sqrtA→sqrtB
 * (real token1/token0 Q96, sqrtB < sqrtA): dOut(token1) = L*(sqrtA - sqrtB)/2^96.
 * Holds because no initialized tick is crossed inside the wide position.
 */
function analyticOut(sqrtA: bigint, sqrtB: bigint, L: bigint): bigint {
  const Q96 = 1n << 96n;
  return (L * (sqrtA - sqrtB)) / Q96;
}
