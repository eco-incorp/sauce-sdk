/**
 * EcoSwap 1-RPC QUOTE — LOCAL EVM integration test (WS2 step 4/6).
 *
 * Validates `quoteEcoSwap` (the eth_call state-override quote): it runs the SAME
 * compiled, verified solver READ-ONLY through cook(), injecting the caller's tokenIn
 * balance + the cook-entry allowance into the call's stateOverride — so the solver's
 * transferFrom + swaps execute call-locally (rolled back) and the returned tokenOut is
 * decoded as the quote. No funding/approval is performed on-chain.
 *
 * This is the agreed alternative to a `quoteOnly` solver param (infeasible on v12: a
 * 10th scalar param overflows SDUP16, and a cfg-bundle multiplies live slots → v12
 * frame-base MemoryOOG). The realized output is strictly better than the spec's `cum`.
 *
 * Asserts:
 *   1. NO-BRACKET quote (brackets=[], the 1-RPC path): the solver's forward walk fills
 *      from each pool's spot seed → a positive quote, with NO funding/approval.
 *   2. AGREEMENT: the no-bracket quote ≈ a prepared-bracket quote (same pool/amount) —
 *      the load-bearing reuse assertion (the sweep+bracket path and the no-bracket walk
 *      agree to a tight band over the constant-L region).
 *   3. REALIZED: the quote ≈ the tokenOut a REAL cook() (funded+approved) produces.
 *   4. No funding needed: the caller has ZERO tokenIn balance/allowance on-chain; the
 *      quote still returns a positive output (proving the stateOverride did the work).
 *
 * Runs on BOTH engines (engineCells; v12 default).
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.quote.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Hex, type Account } from "viem";

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
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap, quoteEcoSwap } from "../ecoswap/index";

const HUGE = parseEther("1000000000");
const ENGINE_CELLS = engineCells();

// MintableERC20 storage layout (fixtures/src/MintableERC20.sol):
// name(0) symbol(1) decimals(2) totalSupply(3) balanceOf(4) allowance(5).
const MINTABLE_ERC20_SLOTS = { balanceSlot: 4n, allowanceSlot: 5n };

describe("EcoSwap 1-RPC quote — local EVM, eth_call state override", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // token0 (zeroForOne)
  let tokenOut: Hex; // token1
  let pool: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  // Sized (with the pool L below) so prepare yields a real bracket ladder AND the trade
  // takes a meaningful excursion — so the no-bracket forward-walk and the prepared sweep
  // both have work to do and can be compared.
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

    // ONE deep V3 pool (fee 3000, ts 60) at 1:1, single wide position → constant active
    // L through the whole walk region (only the far position boundaries are initialized).
    pool = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, 3000, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, -60000, 60000, parseEther("800000"));
    assert.ok((await getLiquidity(c.publicClient, pool)) > 0n, "pool has active liquidity");

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [3000],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => anvil?.stop());

  async function resetPool(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
  }

  async function runQuote(engine: Engine): Promise<void> {
    await resetPool();
    const quoteEntry = cookTarget(engine, stack, v12); // v1 SauceRouter / v12 Pot (quote cook target)
    // The quote's eth_call msg.sender = the cook caller. On v12 the V12Pot.cook is
    // owner-gated, so this MUST be the Pot owner (c.account0); on v1 cook is open. The
    // stateOverride supplies the caller's tokenIn balance + allowance regardless of its
    // real balance — so the quote needs no REAL funds (exercised below). The PREPARE lens
    // read now runs on the SAME engine as the quote (v12-native) — through quoteEntry
    // (lensRouter defaults to it); no v1 pin needed.
    const quoteCaller = c.account0;
    const common = {
      target: engine,
      erc20Slots: MINTABLE_ERC20_SLOTS,
    } as const;

    // (1) NO-BRACKET quote — the 1-RPC path: brackets=[], forward walk from the spot seed.
    const noBkt = await quoteEcoSwap(
      { tokenIn, tokenOut, amountIn: AMOUNT_IN }, anvil.rpcUrl, quoteEntry, quoteCaller, poolConfig,
      { ...common, noBrackets: true },
    );
    assert.equal(noBkt.prepared.brackets.length, 0, "no-bracket quote ran with an empty bracket ladder");
    assert.ok(noBkt.amountOut > 0n, "no-bracket quote returns a positive output");

    // (2) PREPARED-BRACKET quote — same pool/amount, full prepared ladder.
    const withBkt = await quoteEcoSwap(
      { tokenIn, tokenOut, amountIn: AMOUNT_IN }, anvil.rpcUrl, quoteEntry, quoteCaller, poolConfig,
      { ...common },
    );
    assert.ok(withBkt.prepared.brackets.length > 0, "prepared-bracket quote built a ladder");
    assert.ok(withBkt.amountOut > 0n, "prepared-bracket quote returns a positive output");

    // AGREEMENT — the no-bracket walk and the prepared-bracket sweep agree to a tight band
    // (constant-L region; truncation only). This is the load-bearing reuse assertion.
    const hi = noBkt.amountOut > withBkt.amountOut ? noBkt.amountOut : withBkt.amountOut;
    const lo = noBkt.amountOut > withBkt.amountOut ? withBkt.amountOut : noBkt.amountOut;
    const relPpm = ((hi - lo) * 1_000_000n) / hi;
    assert.ok(relPpm < 200n, `no-bracket vs prepared quote agree (rel ${relPpm}ppm, nb=${noBkt.amountOut} wb=${withBkt.amountOut})`);

    // (3) REALIZED — the quote ≈ the tokenOut a REAL funded+approved cook() produces.
    const realCaller = c.account0;
    const realEntry = cookTarget(engine, stack, v12);
    await mint(c.walletClient, c.publicClient, tokenIn, realCaller, AMOUNT_IN);
    await approve(c.walletClient, c.publicClient, tokenIn, realEntry, AMOUNT_IN);
    const { bytecodes } = await ecoSwap(
      { tokenIn, tokenOut, amountIn: AMOUNT_IN }, anvil.rpcUrl, cookTarget(engine, stack, v12), realCaller, poolConfig,
      undefined, engine,
    );
    const outBefore = await balanceOf(c.publicClient, tokenOut, realCaller);
    const { receipt } = await cook(c.walletClient, c.publicClient, realEntry, bytecodes);
    assert.equal(receipt.status, "success", "real cook succeeds");
    const realOut = (await balanceOf(c.publicClient, tokenOut, realCaller)) - outBefore;
    assert.ok(realOut > 0n, "real swap produced tokenOut");

    const rHi = withBkt.amountOut > realOut ? withBkt.amountOut : realOut;
    const rLo = withBkt.amountOut > realOut ? realOut : withBkt.amountOut;
    const realPpm = ((rHi - rLo) * 1_000_000n) / rHi;
    assert.ok(realPpm < 200n, `quote tracks the real swap output (rel ${realPpm}ppm, quote=${withBkt.amountOut} real=${realOut})`);

    // (4) NO FUNDING — quote for a GENUINELY-unfunded address (zero balance, zero
    // allowance on-chain): the stateOverride alone must enable it. v1 only (the open
    // SauceRouter cook accepts any msg.sender; the v12 Pot cook is owner-gated, so a v12
    // quote runs from the Pot owner — proven funding-free by the same override path).
    let unfundedOut = 0n;
    if (engine === "v1") {
      const unfunded = "0x00000000000000000000000000000000deadca11" as Hex;
      assert.equal(await balanceOf(c.publicClient, tokenIn, unfunded), 0n, "unfunded caller has zero tokenIn on-chain");
      const q = await quoteEcoSwap(
        { tokenIn, tokenOut, amountIn: AMOUNT_IN }, anvil.rpcUrl, quoteEntry, unfunded, poolConfig, { ...common },
      );
      unfundedOut = q.amountOut;
      assert.ok(unfundedOut > 0n, "quote for an unfunded caller returns a positive output (no funding needed)");
    }

    console.log(
      `  [QUOTE ${engine}] no-bracket=${noBkt.amountOut} prepared=${withBkt.amountOut} real=${realOut} ` +
        `(agree ${relPpm}ppm, vs-real ${realPpm}ppm${engine === "v1" ? `; unfunded-caller quote=${unfundedOut}` : ""})`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`1-RPC quote (no-bracket + prepared) tracks the real swap, no funding [${engine}]`, { skip }, async () => {
      await runQuote(engine);
    });
  }
});
