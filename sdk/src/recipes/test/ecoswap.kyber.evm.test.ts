/**
 * EcoSwap KyberSwap Classic / DMM local-EVM round-trip — the isKyber SETUP walk + kyberOut +
 * the ppm-rounding-vs-1e18-precision seam.
 *
 * Kyber Classic is a V2-shaped LIVE-WALK venue on VIRTUAL reserves (an AMPLIFIED constant product:
 * vReserve = reserve + boost, the curve geometry set by the virtual reserves). The on-chain LENS
 * only understands V2/V3/V4 (getReserves/slot0/StateView), so Kyber is discovered OFF-CHAIN via
 * getPools → getTradeInfo and appended to the DIRECT survivor set — each seeds the SAME constant-L
 * V2 stream the solver/oracle walk (L = √(vIn·vOut), spot out/in = √(vOut/vIn)) but from the VIRTUAL
 * reserves, carries the ROUNDED per-pool ppm (the coordinate the merge/oracle share), and executes
 * CALLBACK-FREE (transfer + pool.swap with EMPTY callbackData) computing the realized output on the
 * VIRTUAL reserves at FULL 1e18 feeInPrecision (the genuine Kyber getAmountOut, ecoswap.sauce.ts
 * kyberOut). This is the ONLY test that exercises the isKyber SETUP read + kyberOut + the
 * ppm-rounded-price / 1e18-precision-output seam, on BOTH engines:
 *
 *   (1) DISCOVER + SOLO — a deep Kyber DMM pool (real 300k/side, +300k/side virtual boost ⇒ amp 2×)
 *       is discovered via getPools, surfaces as a V2 DIRECT pool carrying the rounded ppm, one EcoSwap
 *       routes the whole trade through it, spent == oracle to the wei AND received == the GENUINE
 *       Kyber getAmountOut on the VIRTUAL reserves at 1e18 precision (the exec math, wei-exact).
 *   (2) SPLIT — one EcoSwap splits across the Kyber pool + a standard V3 pool, per-pool input ==
 *       oracle to the wei, post-fee marginals equalize, and the cheaper-fee venue draws more.
 *   (3) ZERO-CACHE QUOTE — the 1-RPC (noBrackets) eth_call quote returns the genuine getAmountOut
 *       for a solo Kyber pool and equals a real cook() to the wei (Kyber ships no tick cache anyway).
 *   (4) ADVERSE-DRIFT re-anchor — prepare()+compile() against S0, move the Kyber pool's VIRTUAL
 *       reserves with a REAL DMM swap (adverse: same direction), then cook the PRE-drift bytecodes:
 *       the SETUP re-reads getTradeInfo LIVE, so received == the genuine getAmountOut on the DRIFTED
 *       reserves (NOT the stale S0 reserves) — proving the live re-anchor.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEther, parseAbi, type Abi, type Account, type Hex } from "viem";

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
  deployKyberFactory,
  setupEtchedKyberPool,
  kyberPoolAbi,
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
import { ecoSwap, quoteEcoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { feeAdjust, toOutIn, isqrt, Q192 } from "./ecoswap.math";

const HUGE = parseEther("1000000000");
const ENGINE_CELLS = engineCells();

// KyberSwap Classic fee precision (feeInPrecision is 1e18-scaled). 0.30% = 3e15.
const KYBER_PRECISION = 10n ** 18n;
const KYBER_FEE_IN_PRECISION = 3_000_000_000_000_000n; // 0.30%
// A fixed address to etch the Kyber DMM pool runtime at (all-lowercase ⇒ viem checksum-agnostic).
const KYBER_ADDR = "0x00000000000000000000000000000000d33d0001" as Hex;

// MintableERC20 storage layout (fixtures/src/MintableERC20.sol): name(0) symbol(1) decimals(2)
// totalSupply(3) balanceOf(4) allowance(5) — the slots the 1-RPC quote's stateOverride writes.
const MINTABLE_ERC20_SLOTS = { balanceSlot: 4n, allowanceSlot: 5n };

// The DMM swap surface (the harness kyberPoolAbi omits it; used to move the pool for the drift cell).
const kyberSwapAbi = parseAbi([
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes callbackData)",
]);

/**
 * The GENUINE Kyber Classic getAmountOut on the VIRTUAL reserves at FULL 1e18 precision — a
 * bit-for-bit mirror of ecoswap.sauce.ts `kyberOut` (mulDiv = floor division). This is what the
 * callback-free exec computes, so the realized tokenOut equals it to the wei.
 */
function kyberGetAmountOut(amt: bigint, feeInPrecision: bigint, vIn: bigint, vOut: bigint): bigint {
  const inWithFee = (amt * (KYBER_PRECISION - feeInPrecision)) / KYBER_PRECISION;
  const denom = vIn + inWithFee;
  if (denom <= 0n) return 0n;
  return (inWithFee * vOut) / denom;
}

describe("EcoSwap KyberSwap Classic / DMM — isKyber SETUP walk, genuine kyberOut, ppm/1e18 seam", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == token0 (zeroForOne = true)
  let tokenOut: Hex; // == token1
  let kyberFactory: Hex;
  let cleanSnapshot: Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("50000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    kyberFactory = await deployKyberFactory(c.walletClient, c.publicClient);

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

  /** poolConfig pointing discovery at the local Kyber DMM factory, optionally + a standard V3 factory.
   *  baseTokens = the swap pair ⇒ zero routes (focus on the direct Kyber live-walk). */
  function poolConfig(withStandardV3: boolean): ChainPoolConfig {
    const factories = [
      {
        address: kyberFactory,
        poolType: SwapPoolType.UniV2,
        factoryType: FactoryType.KyberClassic,
        label: "Local Kyber DMM",
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

  /** Read the pool's LIVE (reserve0, reserve1, vReserve0, vReserve1, feeInPrecision). */
  async function getTradeInfo(pool: Hex): Promise<{ vIn: bigint; vOut: bigint; fee: bigint }> {
    const ti = (await c.publicClient.readContract({
      address: pool,
      abi: kyberPoolAbi as Abi,
      functionName: "getTradeInfo",
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    // tokenIn == token0 ⇒ vReserveIn = vReserve0 [index 2], vReserveOut = vReserve1 [index 3].
    return { vIn: ti[2], vOut: ti[3], fee: ti[4] };
  }

  /** Stand up a deep amplified Kyber DMM pool: real reserves + a virtual boost per token. */
  async function deployKyberPool(realPerSide: bigint, boostPerSide: bigint): Promise<Hex> {
    return setupEtchedKyberPool(
      c.walletClient, c.publicClient, c.testClient, kyberFactory, KYBER_ADDR,
      tokenIn, tokenOut, realPerSide, realPerSide, KYBER_FEE_IN_PRECISION, boostPerSide, boostPerSide,
      c.account0,
    );
  }

  // ── (1) DISCOVER + SOLO — a Kyber DMM pool live-walks + executes the genuine getAmountOut ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Amplified: real 300k/side + 300k/side boost ⇒ virtual 600k/side (amp 2×). The curve trades on
    // the VIRTUAL reserves; the real 300k covers the payout.
    const pool = await deployKyberPool(parseEther("300000"), parseEther("300000"));
    const { vIn, vOut, fee } = await getTradeInfo(pool);
    assert.equal(fee, KYBER_FEE_IN_PRECISION, "live feeInPrecision is 0.30% (1e18-scaled)");

    const amountIn = parseEther("5000");
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig(false),
      undefined,
      engine,
    );

    // The Kyber pool surfaced as exactly one DIRECT V2 pool carrying its rounded ppm (0.30% ⇒ 3000).
    assert.equal(prepared.pools.length, 1, "exactly one direct pool (the Kyber DMM pool)");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    const kp = prepared.pools[0];
    assert.equal(kp.isV2, true, "Kyber DMM surfaces as a constant-product (V2-shaped) pool");
    assert.equal(kp.isKyber, true, "the isKyber flag is set (pd[16]=1)");
    assert.equal(kp.feePpm, 3000, "the rounded per-pool ppm (0.30% ⇒ 3000) threads into feePpm");
    assert.equal(kp.address.toLowerCase(), pool.toLowerCase(), "the discovered pool is the DMM pool");
    assert.ok(kp.source.includes("Kyber"), "labeled a Kyber Classic venue");
    // Seeded from the VIRTUAL reserves, NOT the real ones.
    assert.ok((kp.spotActiveL ?? 0n) > parseEther("300000"), "√k seeded from the deeper VIRTUAL reserves");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Kyber cook() must succeed (callback-free DMM path)");

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.ok(received > 0n, "caller received tokenOut");
    assert.ok(poolIn > 0n, "the DMM pool received tokenIn (transfer-first callback-free exec)");

    // Input side: wei-exact with the oracle (the merge grosses by the SAME rounded ppm).
    const ref = ecoSwapReference(prepared, amountIn);
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY");
    assert.equal(spent, amountIn, "solo deep Kyber pool absorbs the whole trade ⇒ spent == amountIn");
    assert.equal(poolIn, amountIn, "all of amountIn routed into the DMM pool");

    // Output side: the GENUINE Kyber getAmountOut on the VIRTUAL reserves at 1e18 precision — the
    // exec math, wei-exact. (This is the ppm-price / 1e18-precision seam: the merge priced on the
    // rounded ppm, the exec pays the exact on-curve dy.)
    const genuine = kyberGetAmountOut(poolIn, fee, vIn, vOut);
    assert.equal(received, genuine, "received == genuine Kyber getAmountOut on the virtual reserves");

    console.log(
      `  [Kyber solo:${engine}] spent=${spent} received=${received} (genuine=${genuine}) ` +
        `poolIn=${poolIn} vIn=${vIn} vOut=${vOut} feePpm=${kp.feePpm}`,
    );
  }

  // ── (2) SPLIT — Kyber (off-chain discovery) + a standard V3 pool (lens) in ONE merge ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // The Kyber pool (0.30%) + a standard V3 pool (1.00%) at the SAME 1:1 spot but different fees →
    // the water-fill must split: the cheaper Kyber fee draws first, the V3 pool joins as marginals
    // converge. (Kyber real 400k + 400k boost ⇒ virtual 800k; V3 deep enough to compete.)
    const pool = await deployKyberPool(parseEther("400000"), parseEther("400000"));
    const v3Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, 10000, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3Pool, caller, -12000, 12000, parseEther("250000"));

    const amountIn = parseEther("8000");
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const kyberInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3Pool);
    const { vIn, vOut, fee } = await getTradeInfo(pool);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig(true),
      undefined,
      engine,
    );

    assert.equal(prepared.pools.length, 2, "two direct pools (Kyber + standard V3)");
    const kIdx = prepared.pools.findIndex((p) => p.address.toLowerCase() === pool.toLowerCase());
    const v3Idx = prepared.pools.findIndex((p) => p.address.toLowerCase() === v3Pool.toLowerCase());
    assert.ok(kIdx >= 0 && v3Idx >= 0, "both the Kyber and the V3 pool discovered");
    assert.equal(prepared.pools[kIdx].isKyber, true, "the Kyber pool is flagged isKyber");
    assert.equal(prepared.pools[kIdx].feePpm, 3000, "Kyber rounded ppm threads (3000)");
    assert.equal(prepared.pools[v3Idx].feePpm, 10000, "standard V3 pool fee is its tier (10000)");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "split Kyber+V3 cook() must succeed");

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const kyberIn = (await balanceOf(c.publicClient, tokenIn, pool)) - kyberInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3Pool)) - v3InBefore;

    assert.ok(kyberIn > 0n, "the Kyber pool received input");
    assert.ok(v3In > 0n, "the standard V3 pool received input");
    assert.ok(received > 0n, "caller received tokenOut");

    const ref = ecoSwapReference(prepared, amountIn);
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY");
    assert.equal(kyberIn, ref.perPoolInput[kIdx], "Kyber input == oracle to the wei");
    assert.equal(v3In, ref.perPoolInput[v3Idx], "standard V3 pool input == oracle to the wei");

    // The cheaper-fee Kyber pool draws strictly more than the 1.00% V3 pool (same spot).
    assert.ok(kyberIn > v3In, `cheaper-fee Kyber draws more (Kyber ${kyberIn} > v3 ${v3In})`);

    // The Kyber portion of `received` is the genuine on-curve dy (the V3 portion is its own curve).
    const kyberOut = kyberGetAmountOut(kyberIn, fee, vIn, vOut);
    assert.ok(received > kyberOut, "total received exceeds the Kyber-only leg (the V3 leg adds output)");

    // Post-fee marginals equalize AT THE CUT — asserted EXPLICITLY, not just via per-pool input.
    // Read BOTH pools' POST-swap marginal out/in (V3: slot0 sqrt; Kyber: √(vOut/vIn) on the drifted
    // virtual reserves) and fee-adjust each by its OWN ppm (Kyber's rounded 3000, V3's exact 10000).
    // Water-fill drives the two fee-adjusted marginals together; they meet to within the coarser
    // venue's last segment step (V3's ~1% tickSpacing bracket / Kyber's 25-bps geometric slice), so
    // a small relative tolerance is a genuine convergence check (the raw SPOTS differ by ~0.35% at
    // 1:1 purely from the fee gap — a broken split would leave the fee-adjusted marginals apart).
    const v3Slot = await getSlot0(c.publicClient, v3Pool);
    const margV3 = feeAdjust(toOutIn(v3Slot.sqrtPriceX96, true), 10000);
    const kAfter = await getTradeInfo(pool); // POST-swap virtual reserves
    const margKyber = feeAdjust(isqrt((kAfter.vOut * Q192) / kAfter.vIn), 3000);
    assert.ok(margV3 > 0n && margKyber > 0n, "both post-swap fee-adjusted marginals are positive");
    const margDiff = margKyber > margV3 ? margKyber - margV3 : margV3 - margKyber;
    // ≤ 1.5% relative: the split equalized the fee-adjusted marginals at the cut.
    assert.ok(
      margDiff * 1000n <= margV3 * 15n,
      `fee-adjusted marginals equalize at the cut (Kyber ${margKyber} ~= v3 ${margV3}, ` +
        `diff ${(margDiff * 10000n) / margV3} bps)`,
    );
    assert.ok((prepared.pools[kIdx].spotNearReal ?? 0n) > 0n, "Kyber carries a live out/in spot seed");

    console.log(
      `  [Kyber split:${engine}] KyberIn=${kyberIn} v3(10000)In=${v3In} received=${received} ` +
        `spent=${spent} (oracle Kyber=${ref.perPoolInput[kIdx]} v3=${ref.perPoolInput[v3Idx]}); ` +
        `marg v3=${margV3} kyber=${margKyber} diff=${(margDiff * 10000n) / margV3}bps`,
    );
  }

  // ── (3) ZERO-CACHE QUOTE — the 1-RPC (noBrackets) eth_call quote == a real cook(), to the wei ──
  async function runQuote(engine: Engine): Promise<void> {
    await reset();
    const quoteEntry = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const pool = await deployKyberPool(parseEther("300000"), parseEther("300000"));
    const { vIn, vOut, fee } = await getTradeInfo(pool);
    const amountIn = parseEther("5000");

    // The 1-RPC path: brackets=[] + an empty cache window (Kyber ships no tick cache anyway, so this
    // is the natural Kyber quote). The stateOverride funds the caller call-locally (no on-chain funds).
    const q = await quoteEcoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      quoteEntry,
      caller,
      poolConfig(false),
      { target: engine, erc20Slots: MINTABLE_ERC20_SLOTS, noBrackets: true },
    );
    assert.equal(q.prepared.brackets.length, 0, "zero-cache quote has no route/bracket segments");
    assert.ok(q.amountOut > 0n, "zero-cache Kyber quote returns a positive output");

    // The genuine getAmountOut on the virtual reserves — the quote replays the exec exactly.
    const genuine = kyberGetAmountOut(amountIn, fee, vIn, vOut);
    assert.equal(q.amountOut, genuine, "zero-cache quote == genuine Kyber getAmountOut, to the wei");

    // A REAL funded+approved cook() against the SAME (quote is rolled back ⇒ untouched) reserves
    // must land the SAME output.
    const target = cookTarget(engine, stack, v12);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { bytecodes } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12), caller, poolConfig(false),
      undefined, engine,
    );
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "real Kyber cook() succeeds");
    const realOut = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.equal(q.amountOut, realOut, "zero-cache quote == the real cook() output, to the wei");

    console.log(`  [Kyber quote:${engine}] quote=${q.amountOut} real=${realOut} (genuine=${genuine})`);
  }

  // ── (4) ADVERSE-DRIFT re-anchor — the SETUP re-reads getTradeInfo LIVE ──
  async function runDrift(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const pool = await deployKyberPool(parseEther("300000"), parseEther("300000"));
    const s0 = await getTradeInfo(pool); // prepare-time (stale) virtual reserves
    const amountIn = parseEther("5000");

    // prepare()+compile() against S0 (snapshots the spot/√k off-chain). The internal amountOutMin
    // floor is DISABLED here (slippageBps 0) so the cook can't floor-revert — this cell isolates the
    // live re-anchor (the organic floor-fire on an adverse drift is proven in ecoswap.floor.evm.test.ts).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig(false),
      { slippageBps: 0 },
      engine,
    );
    assert.equal(prepared.pools.length, 1, "one direct Kyber pool");
    assert.equal(prepared.pools[0].isKyber, true, "isKyber flagged");

    // ADVERSE drift: a REAL DMM swap in the SAME direction (tokenIn→tokenOut) moves the virtual
    // reserves against the recipe. Transfer the drift input, compute the on-curve dy on the CURRENT
    // virtual reserves, and swap it out (amount1Out ⇒ token1 == tokenOut leaves the pool).
    const drifter = c.account0;
    const driftIn = parseEther("40000");
    const driftOut = kyberGetAmountOut(driftIn, s0.fee, s0.vIn, s0.vOut);
    // Transfer the drift input to the pool, then swap it out (amount1Out ⇒ token1 == tokenOut).
    const transferHash = await c.walletClient.writeContract({
      address: tokenIn,
      abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
      functionName: "transfer",
      args: [pool, driftIn],
      account: drifter,
      chain: c.walletClient.chain,
    });
    await c.publicClient.waitForTransactionReceipt({ hash: transferHash });
    const driftHash = await c.walletClient.writeContract({
      address: pool,
      abi: kyberSwapAbi,
      functionName: "swap",
      args: [0n, driftOut, drifter, "0x"],
      account: drifter,
      chain: c.walletClient.chain,
    });
    await c.publicClient.waitForTransactionReceipt({ hash: driftHash });

    const s1 = await getTradeInfo(pool); // LIVE (drifted) virtual reserves the SETUP will re-read
    assert.ok(s1.vIn > s0.vIn && s1.vOut < s0.vOut, "adverse drift moved the virtual reserves");

    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "pre-drift bytecodes cook() against the drifted pool");

    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;
    assert.equal(poolIn, amountIn, "solo pool absorbs the whole trade even after drift");

    // The SETUP re-read getTradeInfo LIVE: received == the genuine getAmountOut on the DRIFTED (S1)
    // reserves — NOT the stale S0 reserves. The two differ, so this discriminates a live re-read
    // from a baked-in stale seed.
    const genuineLive = kyberGetAmountOut(amountIn, s1.fee, s1.vIn, s1.vOut);
    const genuineStale = kyberGetAmountOut(amountIn, s0.fee, s0.vIn, s0.vOut);
    assert.equal(received, genuineLive, "received == genuine getAmountOut on the LIVE (drifted) reserves");
    assert.ok(received < genuineStale, "adverse drift lowered the output below the stale-reserve estimate");
    assert.notEqual(genuineLive, genuineStale, "the drift actually changed the on-curve output");

    console.log(
      `  [Kyber drift:${engine}] received=${received} live=${genuineLive} stale=${genuineStale} ` +
        `(S0 vIn=${s0.vIn} vOut=${s0.vOut} → S1 vIn=${s1.vIn} vOut=${s1.vOut})`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Kyber DMM solo [${engine}] — isKyber SETUP walk, genuine kyberOut, spent == oracle`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Kyber DMM + V3 split [${engine}] — off-chain Kyber competes with lens V3, split == oracle`, { skip }, async () => {
      await runSplit(engine);
    });
    it(`Kyber DMM zero-cache quote [${engine}] — 1-RPC quote == real cook == genuine getAmountOut`, { skip }, async () => {
      await runQuote(engine);
    });
    it(`Kyber DMM adverse-drift re-anchor [${engine}] — SETUP re-reads getTradeInfo LIVE`, { skip }, async () => {
      await runDrift(engine);
    });
  }
});
