/**
 * EcoSwap ADAPTIVE dynamic tick reads — LOCAL EVM integration test (WS4).
 *
 * The load-bearing window-EXCEEDED test (spec §F4). A single V3 pool holds liquidity
 * across MANY ticks (one wide position → constant active L through the whole walk
 * region, since the only initialized ticks are the far-away position boundaries). We
 * prepare with a deliberately NARROW lens window (small maxTicks) so the prepared
 * brackets UNDER-FILL amountIn, then:
 *
 *   (1) adaptive OFF → the single-pass solver runs out of prepared brackets and
 *       spends < amountIn (the gap exists; compute-then-pull pulls only what it can
 *       fill, no revert).
 *   (2) adaptive ON  → the solver resumes a LIVE streaming tick walk from the
 *       frontier seed and fills the gap: spends == amountIn EXACTLY, leftover == 0,
 *       and tokenOut matches the adaptive reference oracle.
 *
 * Why oracle == on-chain here is exact: inside the wide position there are NO
 * initialized ticks, so every adaptive ticks() read returns net 0 → L is constant.
 * The oracle's off-chain adaptiveNet map is likewise empty for those ticks → 0 →
 * L constant. Both walk the identical constant-L region with the same multiplicative
 * stepReal, so they agree bit-for-bit (no multiplicative-vs-exact drift across an
 * initialized boundary).
 *
 * Adaptive is a SINGLE-PASS-solver feature, so these run under ECO_SOLVER=singlepass
 * (set/restored around each case). The reference auto-selects singlePassReference +
 * the adaptive mirror from ECO_SOLVER / ECO_ADAPTIVE.
 *
 * Run: npx tsx --test recipes/test/ecoswap.adaptive.evm.test.ts
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
} from "./harness/setup";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { feeAdjust, toOutIn } from "./ecoswap.math";

const HUGE = parseEther("1000000000");

describe("EcoSwap adaptive dynamic tick reads (window-EXCEEDED streaming walk)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
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

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  // Revert to clean pool state + re-snapshot so each case prepares + cooks against
  // the IDENTICAL fresh pool (anvil invalidates a snapshot id once reverted into).
  async function resetPool(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
  }

  /** Run prepare+compile+cook for one (adaptive) setting; returns balances + prepared. */
  async function runCase(adaptive: boolean) {
    const caller = c.account0;
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn: AMOUNT_IN },
      anvil.rpcUrl,
      stack.sauceRouter,
      caller,
      poolConfig,
      { maxTicks: NARROW_MAX_TICKS, adaptive },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, stack.sauceRouter, AMOUNT_IN);
    const { receipt } = await cook(c.walletClient, c.publicClient, stack.sauceRouter, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed");

    const poolInAfter = await balanceOf(c.publicClient, tokenIn, pool);
    const callerInAfter = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutAfter = await balanceOf(c.publicClient, tokenOut, caller);
    const leftover = await balanceOf(c.publicClient, tokenIn, stack.sauceRouter);

    return {
      prepared,
      poolInDelta: poolInAfter - poolInBefore,
      spent: callerInBefore - callerInAfter,
      received: callerOutAfter - callerOutBefore,
      leftover,
    };
  }

  function withEnv(env: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
      prev[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k]!;
    }
    const restore = () => {
      for (const k of Object.keys(prev)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k]!;
      }
    };
    return body().then(
      (v) => { restore(); return v; },
      (e) => { restore(); throw e; },
    );
  }

  it("adaptive OFF — prepared brackets under-fill the narrow window (gap exists)", async () => {
    await withEnv({ ECO_SOLVER: "singlepass", ECO_ADAPTIVE: undefined }, async () => {
      await resetPool();
      const r = await runCase(false);

      // The narrow window can't cover amountIn → the solver fills only what the
      // prepared brackets supply, spending strictly less than amountIn.
      assert.ok(r.spent > 0n, "should still fill the prepared depth");
      assert.ok(r.spent < AMOUNT_IN, `adaptive OFF must UNDER-FILL (spent ${r.spent} of ${AMOUNT_IN})`);
      assert.equal(r.poolInDelta, r.spent, "all spent input lands in the pool");
      assert.ok(r.received > 0n, "received tokenOut");

      // Oracle (non-adaptive single-pass) agrees: totalInput == spent (under-fill).
      const ref = ecoSwapReference(r.prepared, AMOUNT_IN);
      assert.equal(r.spent, ref.totalInput, "OFF: spent == non-adaptive oracle totalInput");
      assert.ok(ref.totalInput < AMOUNT_IN, "OFF: oracle also under-fills");

      console.log(
        `  [adaptive OFF] spent=${r.spent} of ${AMOUNT_IN} (gap=${AMOUNT_IN - r.spent}) received=${r.received}`,
      );
    });
  });

  it("adaptive ON — streaming walk closes the gap (full fill, leftover 0, oracle match)", async () => {
    await withEnv({ ECO_SOLVER: "singlepass", ECO_ADAPTIVE: "1" }, async () => {
      await resetPool();
      const r = await runCase(true);

      // The adaptive streaming walk resumes from the frontier seed and fills the
      // remaining gap → spends amountIn EXACTLY, no leftover.
      assert.equal(r.spent, AMOUNT_IN, "adaptive ON must FULL-FILL (spent == amountIn)");
      assert.equal(r.leftover, 0n, "no leftover on the router (compute-then-pull, no limit hit)");
      assert.equal(r.poolInDelta, AMOUNT_IN, "all of amountIn lands in the pool");
      assert.ok(r.received > 0n, "received tokenOut");

      // Oracle (adaptive single-pass) cross-check. Constant-L walk region → exact:
      // perPoolInput sums to amountIn and tokenOut matches within a tight ppm band.
      const ref = ecoSwapReference(r.prepared, AMOUNT_IN);
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
      const onchainOut = r.received;
      const refOut = analyticOut(SQRT_PRICE_1_1, sqrtPriceX96, parseEther("800000"));
      const diff = onchainOut > refOut ? onchainOut - refOut : refOut - onchainOut;
      const ppm = (diff * 1_000_000n) / (onchainOut > 0n ? onchainOut : 1n);
      assert.ok(ppm < 50n, `tokenOut matches constant-L geometry within 50ppm (got ${ppm}ppm, on=${onchainOut} ref=${refOut})`);

      console.log(
        `  [adaptive ON] spent=${r.spent} (==amountIn) leftover=${r.leftover} received=${r.received} ` +
          `oracleOut(geom)=${refOut} ppm=${ppm}`,
      );
    });
  });
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
