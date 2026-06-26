/**
 * De-risk SPIKE for the EcoSwap on-chain prepare lens — LOCAL EVM, NO fork.
 *
 * Validates the single load-bearing assumption of the v1 lens plan: that a
 * NEGATIVE int24 tick argument, formed in SauceScript via Math.neg, reaches a
 * V3 pool's ticks(int24) staticcall correctly, AND that the signed int128
 * liquidityNet it returns (zero-extended by the engine's contract-return decode)
 * round-trips off-chain via BigInt.asIntN(128, ·).
 *
 * Setup: boot anvil, deploy the engine (Router -> SauceRouter) + a real Uniswap
 * V3 factory/pool, mint concentrated liquidity straddling a POSITIVE and a
 * NEGATIVE initialized tick (both engineered to carry a NEGATIVE liquidityNet),
 * then call cook(lensBytecode) READ-ONLY via simulateContract (eth_call) — the
 * exact pattern the off-chain lens will use — abi.decode the 4 returned words,
 * and assert sqrtPriceX96 / tick / liquidityNet(pos) / liquidityNet(neg) all
 * match direct viem reads.
 *
 * Run: pnpm --filter './dev-tools' exec tsx --test recipes/test/ecoswap.lens-spike.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseEther,
  parseAbi,
  decodeAbiParameters,
  type Abi,
  type Hex,
} from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { compileSauce } from "./harness/compile";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  createAndInitPool,
  mint,
  approve,
  mintPosition,
  getSlot0,
  getTickLiquidityNet,
  SQRT_PRICE_1_1,
  type DeployedStack,
} from "./harness/setup";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(__dirname, "harness");

const HUGE = parseEther("1000000000");

// ENGINE NOTE: the spike validates the PREPARE-side lens read path (Math.neg int24
// arg + signed int128 return), which always runs on the v1 SauceRouter. So it is
// v1-pinned regardless of ECO_ENGINE; the V12Pot read-only-cook path is tracked
// for P3 (it currently reverts).
const SPIKE_ENGINE: "v1" = "v1";

const cookAbi = parseAbi([
  "function cook(bytes[] ingredients) payable returns (bytes returnData)",
]);

describe("EcoSwap lens spike — negative-int24 tick read via cook() eth_call", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let token0: Hex;
  let token1: Hex;
  let pool: Hex;

  // fee 3000 -> tickSpacing 60; both target ticks are multiples of 60.
  const POS_TICK = 600;
  const NEG_TICK = -600;

  // Lens cook entrypoint — always the v1 SauceRouter (see ENGINE NOTE above).
  function spikeCookAddress(): Hex {
    return stack.sauceRouter;
  }

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    token0 = tk.token0;
    token1 = tk.token1;

    pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, token0, token1, 3000, SQRT_PRICE_1_1,
    );

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, token0, minter, parseEther("10000000"));
    await mint(c.walletClient, c.publicClient, token1, minter, parseEther("10000000"));
    await approve(c.walletClient, c.publicClient, token0, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, token1, stack.helper, HUGE);

    // Engineer liquidityNet at BOTH target ticks to be NEGATIVE, so the spike
    // exercises (a) the negative int24 ARG (reading at NEG_TICK) and (b) the
    // signed int128 RETURN recovery (both ticks carry net < 0).
    //   A [-600, 600] L=200k  -> net(-600) += 200k, net(600) -= 200k
    //   B [-1200,-600] L=300k -> net(-600) -= 300k  (=> net(-600) = -100k)
    //   C [600, 1200]  L=50k  -> net(600)  += 50k   (=> net(600)  = -150k)
    const positions: [number, number, bigint][] = [
      [-600, 600, parseEther("200000")],
      [-1200, -600, parseEther("300000")],
      [600, 1200, parseEther("50000")],
    ];
    for (const [lo, hi, L] of positions) {
      await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, lo, hi, L);
    }
  });

  after(() => {
    anvil?.stop();
  });

  it("reads slot0 + ticks(pos) + ticks(neg via Math.neg) and round-trips signed words", async () => {
    // Ground truth via direct viem reads.
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, pool);
    const posRead = await getTickLiquidityNet(c.publicClient, pool, POS_TICK);
    const negRead = await getTickLiquidityNet(c.publicClient, pool, NEG_TICK);

    // Sanity on our engineered profile: both nets are negative & initialized.
    assert.equal(posRead.initialized, true, "POS_TICK must be initialized");
    assert.equal(negRead.initialized, true, "NEG_TICK must be initialized");
    assert.equal(posRead.liquidityNet, parseEther("-150000"), "engineered net(600) = -150k");
    assert.equal(negRead.liquidityNet, parseEther("-100000"), "engineered net(-600) = -100k");

    // Compile the spike lens. The NEGATIVE tick is passed as its ABSOLUTE value;
    // the lens forms the negative int24 in-script via Math.neg(negTickAbs).
    const src = readFileSync(join(HARNESS, "lens-spike.sauce.ts"), "utf-8");
    const { bytecodes, warnings } = compileSauce(
      src,
      [BigInt(pool), BigInt(POS_TICK), BigInt(-NEG_TICK)],
      HARNESS,
      SPIKE_ENGINE,
    );
    assert.deepEqual(warnings, [], "spike lens should compile without warnings");
    assert.ok(bytecodes.length >= 1, "should produce bytecode");

    // READ-ONLY cook() via simulateContract (eth_call). No tx, no state change —
    // exactly how the off-chain prepare lens will invoke it. cook entrypoint =
    // SauceRouter (v1) or V12Pot (v12).
    const { result } = await c.publicClient.simulateContract({
      address: spikeCookAddress(),
      abi: cookAbi as Abi,
      functionName: "cook",
      args: [bytecodes],
      account: c.account0,
    });
    const returnData = result as Hex;
    assert.ok(returnData && returnData !== "0x", "cook() eth_call must return data");

    // Decode the 4 raw uint256 words the lens abi.encode'd.
    const [encSqrt, encTick, encNetPos, encNetNeg] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      returnData,
    ) as [bigint, bigint, bigint, bigint];

    // sqrtPriceX96 is a plain uint160 — matches directly.
    assert.equal(encSqrt, sqrtPriceX96, "lens sqrtPriceX96 matches slot0");

    // tick (int24) comes back zero-extended -> reinterpret via asIntN(24).
    const lensTick = Number(BigInt.asIntN(24, encTick));
    assert.equal(lensTick, tick, "lens tick (asIntN24) matches slot0 tick");
    assert.equal(lensTick, 0, "pool initialized at tick 0");

    // liquidityNet (int128) comes back zero-extended -> reinterpret via asIntN(128).
    const lensNetPos = BigInt.asIntN(128, encNetPos);
    const lensNetNeg = BigInt.asIntN(128, encNetNeg);

    assert.equal(
      lensNetPos, posRead.liquidityNet,
      "POSITIVE-tick liquidityNet (asIntN128) matches direct ticks() read",
    );
    assert.equal(
      lensNetNeg, negRead.liquidityNet,
      "NEGATIVE-tick liquidityNet (asIntN128) matches direct ticks() read — proves Math.neg int24 arg reaches the pool",
    );

    // Belt-and-suspenders: the negative tick's raw word must NOT already equal
    // the signed value (i.e. it really is zero-extended and needs asIntN).
    assert.notEqual(encNetNeg, lensNetNeg, "raw int128 word should be zero-extended (needs asIntN)");
    assert.ok(lensNetNeg < 0n, "recovered net(-600) is negative");
    assert.ok(lensNetPos < 0n, "recovered net(600) is negative");

    console.log(
      `  [SPIKE] sqrtP=${encSqrt} tick=${lensTick}\n` +
        `          net(${POS_TICK})=${lensNetPos}  net(${NEG_TICK})=${lensNetNeg}  (both via cook eth_call, asIntN128)\n` +
        `          raw neg word=0x${encNetNeg.toString(16).slice(0, 16)}… -> asIntN128 ${lensNetNeg}`,
    );
  });
});
