/**
 * EcoSwap internal amountOutMin FLOOR (cfg[9]) — ORGANIC floor-fire on a genuine drift shortfall.
 *
 * The whole-trade amountOutMin floor (commit a1cbc18) reverts the cook when the realized tokenOut
 * falls below `minOut = expectedTotalOut * (10000 - slippageBps) / 10000` (default slippageBps 50 =
 * 0.5%). Until now it was only exercised via a FORCED 2× override (opts.minOut set above anything
 * the split can produce — ecoswap.evm.test.ts Phase 3c). This test fires it ORGANICALLY: prepare +
 * compile with the DEFAULT slippage floor, then move a pool ADVERSELY with a REAL swap so the
 * live-re-anchored realized output falls below the (pre-drift) floor, and cook the PRE-drift
 * bytecodes — proving the terminal require fires on a genuine shortfall, not just a synthetic 2×.
 *
 * A deep SOLO Uniswap-V2 pool is used deliberately: for a constant-product pool the off-chain
 * estimator (expected-output.ts v2Slices) walks the EXACT constant-L geometry, so `expectedTotalOut`
 * is TIGHT (≈ the realized fill) and `minOut` sits just 0.5% below it — a moderate adverse drift
 * pushes the realized output under the floor. The SAME compiled bytecodes are the differential: they
 * cook to SUCCESS with no drift (the floor never false-reverts a legitimate fill) and REVERT with the
 * floor message after the drift. BOTH engines (v1 + v12).
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi, parseEther, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import { driftPoolPrice } from "./harness/drift";
import {
  ensureMulticall3,
  deployStack,
  deployV2Factory,
  deploySortedTokens,
  setupEtchedV2Pool,
  mint,
  approve,
  balanceOf,
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

const HUGE = parseEther("1000000000");
const ENGINE_CELLS = engineCells();
const FLOOR_MESSAGE = "ecoswap: amountOut below minOut";

// A deterministic, unused address to etch the V2 pair at (all-lowercase ⇒ viem checksum-agnostic).
const V2_PAIR_ADDR = "0x00000000000000000000000000000000f100f100" as Hex;

const cookAbi = parseAbi(["function cook(bytes[] ingredients) payable returns (bytes)"]);

describe("EcoSwap amountOutMin floor — organic floor-fire on a genuine drift shortfall", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == token0 (zeroForOne = true)
  let tokenOut: Hex; // == token1
  let v2Factory: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v2Factory = await deployV2Factory(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("50000000"));

    // A deep 1:1 canonical (0.30%) V2 pair — executed through the engine's _swapV2. Its
    // constant-L estimate is TIGHT, so the default 0.5% floor sits just below the realized fill.
    await setupEtchedV2Pool(
      c.walletClient, c.publicClient, c.testClient, v2Factory, V2_PAIR_ADDR,
      tokenIn, tokenOut, parseEther("300000"), parseEther("300000"), minter,
    );

    poolConfig = {
      factories: [
        { address: v2Factory, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Local UniV2" },
      ],
      feeTiers: [3000],
      baseTokens: [tokenIn, tokenOut],
    };

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
    await c.testClient.setNextBlockTimestamp({ timestamp: 2_000_000_000n });
  }

  /** Replay cook() as an eth_call to surface the revert reason; returns the error message. */
  async function callRevertReason(caller: Hex, target: Hex, bytecodes: Hex[]): Promise<string> {
    const data = encodeFunctionData({ abi: cookAbi, functionName: "cook", args: [bytecodes] });
    try {
      await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
      return "";
    } catch (e) {
      const err = e as { details?: string; shortMessage?: string; message?: string };
      return `${err.shortMessage ?? ""} ${err.details ?? ""} ${err.message ?? ""}`;
    }
  }

  async function runFloorFire(engine: Engine): Promise<void> {
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("5000");

    // ── (A) No-drift companion — the DEFAULT-floor cook must NOT false-revert a legitimate fill ──
    await reset();
    const prep = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined, // default slippageBps (0.5%) ⇒ a real, > 0 floor
      engine,
    );
    const { bytecodes, prepared } = prep;
    assert.ok((prepared.minOut ?? 0n) > 0n, "production emits a > 0 amountOutMin floor");

    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt: okReceipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(okReceipt.status, "success", "no-drift cook (default floor) must NOT false-revert");
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    assert.ok(
      received >= (prepared.minOut ?? 0n),
      `wei-exact fill clears the floor: received ${received} >= minOut ${prepared.minOut}`,
    );

    // ── (B) Organic floor-fire — the SAME bytecodes revert after an adverse drift shortfall ──
    await reset();
    // Move the pool ADVERSELY (tokenIn→tokenOut, price DOWN) with a real swap AFTER prepare() but
    // BEFORE the cook, so the solver's live re-anchor (getReserves) sees a worse spot and the
    // realized output falls below the (pre-drift) floor. Drift ≫ amountIn ⇒ a > 0.5% shortfall.
    await driftPoolPrice(c, stack.sauceRouter, prepared.pools[0], tokenIn, tokenOut, true, parseEther("40000"), caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt: badReceipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(badReceipt.status, "reverted", "adverse-drift cook MUST revert (realized < floor)");

    // The revert carries the floor message (surfaced via an eth_call replay of the reverting cook).
    const reason = await callRevertReason(caller, target, bytecodes);
    assert.ok(
      reason.includes(FLOOR_MESSAGE),
      `revert reason must be the floor guard, got: ${reason.slice(0, 200)}`,
    );

    console.log(
      `  [floor-fire:${engine}] no-drift received=${received} >= minOut=${prepared.minOut}; ` +
        `adverse-drift reverted with "${FLOOR_MESSAGE}"`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`amountOutMin floor fires organically on an adverse drift [${engine}]`, { skip }, async () => {
      await runFloorFire(engine);
    });
  }
});
