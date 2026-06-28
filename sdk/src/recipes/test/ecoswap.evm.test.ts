/**
 * EcoSwap LOCAL EVM integration test — NO fork, NO mocks.
 *
 * Boots a fresh anvil, deploys the REAL Uniswap V3 stack (factory + pools +
 * minted concentrated-liquidity positions) and the REAL engine (Router +
 * SauceRouter), then runs the compiled EcoSwap recipe against it.
 *
 * Phases:
 *   1. Sanity gate — one direct swapV3 through a local pool MUST land. This
 *      proves the Router's V3 callback (transient-storage `expectedPool` check,
 *      Router.sol _handleV3Callback) accepts locally-deployed pools.
 *   2. Multi-tick liquidity — several positions create a real piecewise-constant
 *      liquidity profile; verified through the same slot0/ticks read path prepare
 *      uses.
 *   3. End-to-end — ecoSwap() runs real discovery → tick reads → bracket build →
 *      water-fill → compile, then cook()s and asserts the trade SPLIT across
 *      pools with marginal-price equalization, cross-checked vs the oracle.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { compileSauce } from "./harness/compile";
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
  getTickLiquidityNet,
  deployV2Factory,
  setupEtchedV2Pool,
  etchV4Singletons,
  deployV4Helper,
  setupV4Pool,
  getV4Slot0,
  getV4Liquidity,
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
import {
  MIN_SQRT_RATIO,
  SwapPoolType,
  FactoryType,
  type ChainPoolConfig,
} from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { feeAdjust, toOutIn } from "./ecoswap.math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(__dirname, "harness");

// A huge approval/mint cap so funding never bottlenecks the test.
const HUGE = parseEther("1000000000");

// Engine cells to run, driven by ECO_ENGINE (default v12). v1 stays runnable via
// ECO_ENGINE=v1; ECO_ENGINE=both runs the matrix. See harness/engine.ts. The v12
// stack is deployed lazily by maybeDeployV12Stack() when a cell needs it.
const ENGINE_CELLS = engineCells();

describe("EcoSwap local EVM integration", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let token0: Hex;
  let token1: Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    token0 = tk.token0;
    token1 = tk.token1;
  });

  after(() => {
    anvil?.stop();
  });

  // ── Phase 1: sanity gate ───────────────────────────────────
  it("Phase 1 — sanity: one direct swapV3 through a local pool lands", async () => {
    const fee = 3000;
    const pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, token0, token1, fee, SQRT_PRICE_1_1,
    );

    // Mint a wide in-range position so liquidity() > 0 around the live tick.
    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, token0, minter, parseEther("1000000"));
    await mint(c.walletClient, c.publicClient, token1, minter, parseEther("1000000"));
    await approve(c.walletClient, c.publicClient, token0, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, token1, stack.helper, HUGE);
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, pool, minter, -6000, 6000, parseEther("100000"),
    );

    const liq = await getLiquidity(c.publicClient, pool);
    assert.ok(liq > 0n, "pool should have active liquidity after mint");

    // Caller (account0) swaps token0 -> token1; approve the SauceRouter for input.
    const caller = c.account0;
    const amountIn = parseEther("10");
    await approve(c.walletClient, c.publicClient, token0, stack.sauceRouter, amountIn);

    const inBefore = await balanceOf(c.publicClient, token0, caller);
    const outBefore = await balanceOf(c.publicClient, token1, caller);
    const poolInBefore = await balanceOf(c.publicClient, token0, pool);
    const poolOutBefore = await balanceOf(c.publicClient, token1, pool);

    // zeroForOne (token0 in) → price limit at the low extreme.
    const priceLimit = MIN_SQRT_RATIO + 1n;
    const src = readFileSync(join(HARNESS, "sanity.sauce.ts"), "utf-8");
    const { bytecodes, warnings } = compileSauce(
      src,
      [BigInt(token0), BigInt(token1), BigInt(pool), amountIn, BigInt(caller), priceLimit],
      HARNESS,
    );
    assert.deepEqual(warnings, [], "sanity script should compile without warnings");
    assert.ok(bytecodes.length >= 1, "should produce bytecode");

    const { receipt, transfers } = await cook(c.walletClient, c.publicClient, stack.sauceRouter, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed (GATE)");

    const inAfter = await balanceOf(c.publicClient, token0, caller);
    const outAfter = await balanceOf(c.publicClient, token1, caller);
    const poolInAfter = await balanceOf(c.publicClient, token0, pool);
    const poolOutAfter = await balanceOf(c.publicClient, token1, pool);

    assert.equal(inBefore - inAfter, amountIn, "caller should spend exactly amountIn of tokenIn");
    assert.ok(outAfter - outBefore > 0n, "caller should receive tokenOut > 0");
    assert.equal(poolInAfter - poolInBefore, amountIn, "pool tokenIn reserve should increase by amountIn");
    assert.ok(poolOutBefore - poolOutAfter > 0n, "pool tokenOut reserve should decrease");
    assert.ok(transfers.length >= 2, "should emit Transfer events");

    console.log(
      `  [P1] swap landed: spent ${amountIn} tokenIn, received ${outAfter - outBefore} tokenOut`,
    );
  });

  // ── Phase 2: multi-tick concentrated liquidity ─────────────
  it("Phase 2 — multi-tick: minted positions match the slot0/ticks read path", async () => {
    // Fresh pool (fee 500, tickSpacing 10) initialized at 1:1 (tick 0).
    const fee = 500;
    const pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, token0, token1, fee, SQRT_PRICE_1_1,
    );

    // Minter must hold + approve both tokens (helper pulls via transferFrom).
    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, token0, minter, parseEther("5000000"));
    await mint(c.walletClient, c.publicClient, token1, minter, parseEther("5000000"));
    // approvals from Phase 1 already cover the helper, but re-approve idempotently.
    await approve(c.walletClient, c.publicClient, token0, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, token1, stack.helper, HUGE);

    // A realistic piecewise-constant profile: three nested/adjacent ranges that
    // cross several initialized ticks the trade will walk through. Spacing 10.
    //   [-1000, 1000] L=200k  (wide base)
    //   [-200,   200] L=300k  (concentrated near spot)
    //   [   0,   500] L=150k  (asymmetric, above spot for zeroForOne-down side)
    const positions: [number, number, bigint][] = [
      [-1000, 1000, parseEther("200000")],
      [-200, 200, parseEther("300000")],
      [0, 500, parseEther("150000")],
    ];
    for (const [lo, hi, L] of positions) {
      await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, lo, hi, L);
    }

    // Active liquidity at tick 0 = sum of all ranges spanning 0.
    // [-1000,1000] spans 0, [-200,200] spans 0, [0,500] starts AT 0 (active when
    // tick >= 0). slot0 tick is exactly 0 → all three are active.
    const active = await getLiquidity(c.publicClient, pool);
    const { tick } = await getSlot0(c.publicClient, pool);
    assert.equal(tick, 0, "pool should be at tick 0");
    const expectedActive = positions.reduce(
      (s, [lo, hi, L]) => (lo <= 0 && 0 < hi ? s + L : s),
      0n,
    );
    assert.equal(active, expectedActive, "active liquidity must equal sum of ranges spanning tick 0");

    // Verify liquidityNet at the minted boundaries via the SAME ticks() read
    // path prepare.ts uses. At a lower boundary, net += L; at an upper, net -= L.
    const net = new Map<number, bigint>();
    for (const [lo, hi, L] of positions) {
      net.set(lo, (net.get(lo) ?? 0n) + L);
      net.set(hi, (net.get(hi) ?? 0n) - L);
    }
    for (const [boundary, expectedNet] of net) {
      const t = await getTickLiquidityNet(c.publicClient, pool, boundary);
      assert.equal(t.initialized, true, `tick ${boundary} should be initialized`);
      assert.equal(t.liquidityNet, expectedNet, `liquidityNet at tick ${boundary}`);
    }

    // Walking liquidity from tick 0 downward (zeroForOne) should drop as we exit
    // ranges — confirm the reconstruction the bracket builder would do: at the
    // -200 boundary going down, active loses the [-200,200] range's 300k.
    const at200 = await getTickLiquidityNet(c.publicClient, pool, -200);
    assert.equal(at200.liquidityNet, parseEther("300000"), "net at -200 = +300k (lower boundary)");

    console.log(
      `  [P2] pool ${pool} active=${active} at tick 0; ${net.size} initialized boundaries verified`,
    );
  });
});

// ── Phase 3: EcoSwap end-to-end across multiple pools ─────────
describe("EcoSwap end-to-end (multi-pool split)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  // v12 engine stack (Router→SauceRouter→V12Kitchen→Pot), deployed on the SAME
  // anvil sharing the SAME pools. null when v12 artifacts are absent — the v12
  // engine cells then skip. The pools don't care which router swaps them (the
  // Router authenticates V3 callbacks via transient storage, not a fixed address).
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == token0 (zeroForOne = true)
  let tokenOut: Hex; // == token1
  let poolConfig: ChainPoolConfig;
  const poolsByFee = new Map<number, Hex>();
  // Clean post-setup snapshot. Every Phase 3 / 3b run reverts to it first so each
  // prepares + cooks against the IDENTICAL fresh pool state (the runs share one
  // anvil; without this the prior run's swaps would drift the pools and the
  // single-pass exact-equality checks would no longer hold).
  let cleanSnapshot: Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    // Fund + approve the minter (account0) for both tokens.
    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("50000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // Three V3 pools, all initialized at ~1:1 with deep wide positions but
    // DIFFERENT liquidity depths and fee tiers. Same price + a fee spread means
    // the water-fill must split: the cheaper-fee pool fills first, the others
    // join once marginal prices converge.
    //   fee 500  → deepest (gets the most)
    //   fee 3000 → medium
    //   fee 3000 (B) → shallow
    // (Two 3000 pools is fine — getPool is keyed by fee, so we make the second a
    //  500-vs-3000 split; to get THREE distinct pools we use 500, 3000, 10000.)
    const specs: [number, bigint][] = [
      [500, parseEther("400000")],
      [3000, parseEther("250000")],
      [10000, parseEther("150000")],
    ];
    for (const [fee, L] of specs) {
      const pool = await createAndInitPool(
        c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, fee, SQRT_PRICE_1_1,
      );
      // Wide range; bounds (±12000) are divisible by every tier's tickSpacing
      // (10 for fee 500, 60 for 3000, 200 for 10000) so the mint is valid on all.
      await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, -12000, 12000, L);
      poolsByFee.set(fee, pool);
    }

    // Local discovery config. baseTokens = ONLY the swap pair so the multi-hop
    // route loop (which skips base tokens equal to in/out) yields ZERO routes —
    // this keeps the test focused on direct-pool splitting.
    poolConfig = {
      factories: [
        {
          address: stack.factory,
          poolType: SwapPoolType.UniV3,
          factoryType: FactoryType.V3Standard,
          label: "Local UniV3",
        },
      ],
      feeTiers: [500, 3000, 10000],
      baseTokens: [tokenIn, tokenOut],
    };

    // v12 engine stack (same anvil, same pools). The Pot is owned by account0 (the
    // cook caller); account0 approves the POT for tokenIn since the v12 program does
    // transferFrom(caller, self=Pot, …). Deployed only when a v12 cell will run.
    const owner = c.walletClient.account as Account;
    v12 = await maybeDeployV12Stack(c, owner);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  // A fixed, far-future timestamp every cell's cook block is pinned to. The cook's
  // V3 swaps touch the pool oracle, whose accumulator arithmetic depends on the
  // delta since the last observation — so a wall-clock-derived block timestamp made
  // the SAME bytecode against the SAME (snapshot-restored) pool state execute
  // nondeterministically (gas varied; the oversized cook occasionally
  // reverted). Pinning it makes the block context identical for every cell. Year
  // ~2033, safely after the snapshot block's timestamp (setNextBlockTimestamp
  // requires strictly-increasing).
  const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

  // Revert to the clean post-setup state and re-snapshot for the next run. anvil
  // invalidates a snapshot id once reverted into (and any taken after it), so we
  // must re-snapshot each time. Mirrors the prod-mirror drift / gas harnesses.
  // After the revert, pin the next block's timestamp so every cell cooks against an
  // IDENTICAL state + block context — without this the V3 oracle's timestamp
  // dependence made the oversized cook flaky (see COOK_BLOCK_TIMESTAMP).
  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  /** Post-swap fee-adjusted out/in marginal price for a pool (mirrors prepare). */
  async function feeAdjMarginal(pool: Hex, feePpm: number): Promise<bigint> {
    const { sqrtPriceX96 } = await getSlot0(c.publicClient, pool);
    const outIn = toOutIn(sqrtPriceX96, /* zeroForOne */ true);
    return feeAdjust(outIn, feePpm);
  }

  // ── Solver runs ──────────────────────────────────────────────
  // Phase 3 / 3b run EcoSwap's single-pass solver on both engines (v1 + v12). The
  // oracle (ecoswap.reference.ts) mirrors the same single-pass allocation, so the
  // compiled bytecode and the cross-check agree by construction.
  async function runPhase3(engine: Engine): Promise<void> {
    await resetPools();
    // cook() target: v1 → the SauceRouter, v12 → the owner's V12Pot (delegatecalls
    // the Huff runtime for cook + the SauceRouter for swap callbacks, same context).
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("5000");
    const caller = c.account0;

    // Snapshot pool reserves (tokenIn side) before.
    const feesUsed = [500, 3000, 10000];
    const inBefore = new Map<number, bigint>();
    for (const fee of feesUsed) {
      inBefore.set(fee, await balanceOf(c.publicClient, tokenIn, poolsByFee.get(fee)!));
    }
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    // Run REAL discovery → tick reads → bracket build → water-fill → compile.
    // Quote against a SauceRouter either way (the v12 Pot's fallback reaches the
    // same swap surface, but quoting is off-chain and target-agnostic — prepare
    // only does RPC reads); `engine` selects the v1 vs v12 solver compilation.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // prepared diagnostics
    const v3Count = prepared.pools.filter((p) => !p.isV2).length;
    assert.equal(v3Count, 3, "should discover 3 V3 pools");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    assert.ok(prepared.brackets.length > 0, "should build brackets");
    assert.ok(prepared.zeroForOne, "tokenIn < tokenOut → zeroForOne");

    // Approve + cook. The program does transferFrom(caller, self=target, …), so
    // approve the cook target (SauceRouter for v1, the Pot for v12).
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed");

    // ── Per-pool executed input (tokenIn reserve delta) ──
    const perPoolOnchain = new Map<number, bigint>();
    let poolsThatMoved = 0;
    for (const fee of feesUsed) {
      const after = await balanceOf(c.publicClient, tokenIn, poolsByFee.get(fee)!);
      const delta = after - inBefore.get(fee)!;
      perPoolOnchain.set(fee, delta);
      if (delta > 0n) poolsThatMoved++;
    }
    assert.ok(poolsThatMoved >= 2, `swap must SPLIT across >=2 pools (moved ${poolsThatMoved})`);

    // ── Caller spent ~all of amountIn, received tokenOut > 0 ──
    const callerInAfter = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutAfter = await balanceOf(c.publicClient, tokenOut, caller);
    const spent = callerInBefore - callerInAfter;
    const received = callerOutAfter - callerOutBefore;
    assert.ok(received > 0n, "caller received tokenOut");
    const leftover = amountIn - spent;

    // ── Oracle cross-check (deterministic local state == prepared state) ──
    // The reference mirrors the single-pass on-chain solver, so ref.totalInput is
    // the exact gross the on-chain sweep assigns.
    const ref = ecoSwapReference(prepared, amountIn);

    // Compute-then-pull: the sweep pulls EXACTLY cum == ref.totalInput, and with
    // no binding priceLimit (these pools never hit one here) the guarded terminal
    // refund never fires — so spent is exact and leftover is zero.
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY");
    assert.equal(leftover, 0n, "single-pass: no leftover (compute-then-pull, no limit hit)");

    // ── Marginal-price equalization across the pools that received input ──
    const marginals: { fee: number; adj: bigint }[] = [];
    for (const fee of feesUsed) {
      if (perPoolOnchain.get(fee)! > 0n) {
        marginals.push({ fee, adj: await feeAdjMarginal(poolsByFee.get(fee)!, fee) });
      }
    }
    assert.ok(marginals.length >= 2, "need >=2 filled pools to check equalization");
    const adjVals = marginals.map((m) => m.adj);
    const maxAdj = adjVals.reduce((a, b) => (a > b ? a : b));
    const minAdj = adjVals.reduce((a, b) => (a < b ? a : b));
    // Tolerance: the on-chain solver targets a single cut, but integer
    // truncation + the SAFETY_TICKS trim + discrete bracket edges leave a small
    // gap. 2% on the fee-adjusted sqrt price is comfortably tight for equalized
    // pools (a non-split would differ by far more across these depths).
    const spread = Number(maxAdj - minAdj) / Number(maxAdj);
    assert.ok(spread < 0.02, `post-swap fee-adj marginal prices should cluster (spread ${spread})`);

    // ── Per-pool oracle cross-check (deterministic local state == prepared state) ──
    for (let i = 0; i < prepared.pools.length; i++) {
      const fee = prepared.pools[i].feePpm;
      const refIn = ref.perPoolInput[i];
      const onchainIn = perPoolOnchain.get(fee) ?? 0n;
      if (refIn === 0n && onchainIn === 0n) continue;
      // Allow drift: live re-anchoring (slot0 read mid-cook reflects prior swaps
      // in the SAME tx as pools execute sequentially) + integer truncation. Use a
      // generous relative tolerance and an absolute floor.
      const denom = refIn > onchainIn ? refIn : onchainIn;
      const diff = refIn > onchainIn ? refIn - onchainIn : onchainIn - refIn;
      const rel = Number(diff) / Number(denom);
      assert.ok(
        rel < 0.15 || diff < parseEther("1"),
        `pool fee=${fee}: on-chain input ${onchainIn} vs oracle ${refIn} (rel ${rel})`,
      );
    }

    console.log(
      `  [P3:${engine}] split spent=${spent} received=${received} leftover=${leftover}\n` +
        `       per-pool tokenIn: ${feesUsed.map((f) => `${f}=${perPoolOnchain.get(f)}`).join(" ")}\n` +
        `       fee-adj marginals: ${marginals.map((m) => `${m.fee}=${m.adj}`).join(" ")} spread=${spread}\n` +
        `       oracle totalInput=${ref.totalInput} perPoolInput: ${ref.perPoolInput.map((v, i) => `${prepared.pools[i].feePpm}=${v}`).join(" ")} cut=${ref.cutSqrtAdj}`,
    );
  }

  async function runPhase3b(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    // A large trade. These pools are deep (±12000-tick positions), so the lens
    // window absorbs it: the single-pass solver spends amountIn EXACTLY (the
    // crossing pool takes the remainder). The genuine window-EXCEEDED path (live
    // price drifts past the prepared ticks) is covered by the adaptive solver test
    // (ecoswap.adaptive.evm.test.ts), not here — here the window comfortably
    // contains the whole trade.
    const amountIn = parseEther("50000");
    const caller = c.account0;

    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { bytecodes } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "oversized cook() must still succeed");

    const callerInAfter = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutAfter = await balanceOf(c.publicClient, tokenOut, caller);
    const spent = callerInBefore - callerInAfter;
    const received = callerOutAfter - callerOutBefore;
    assert.ok(received > 0n, "should still receive output");

    // Deep pools + window absorbs the trade → the crossing pool takes the
    // remaining need, so cum == amountIn and compute-then-pull spends it exactly.
    assert.equal(spent, amountIn, "single-pass: spends amountIn EXACTLY (crossing pool takes remainder)");

    console.log(
      `  [P3b:${engine}] large trade: spent ${spent} of ${amountIn}, received ${received}, refunded ${amountIn - spent}`,
    );
  }

  // ── Engine matrix ────────────────────────────────────────────
  // The SAME compiled solver runs on the selected engine(s): v1 cooks the prefix
  // bytecode through the Solidity SauceRouter; v12 (the DEFAULT) cooks the postfix
  // (Huff) bytecode through a V12Pot (which delegatecalls the Huff runtime for cook
  // + the SauceRouter for swap callbacks, all in the Pot's context).
  //
  // ECO_ENGINE drives which cells run (default v12; ECO_ENGINE=v1 / =both). See
  // harness/engine.ts — an explicit v12 selection without the artifacts throws.

  // Generate one it() per engine inside this describe so all share the one before()
  // anvil/stack. Each run resetPools() first (revert to the clean snapshot), so
  // every trade prepares + cooks against the IDENTICAL fresh pools — order-independent.
  for (const { engine, skip } of ENGINE_CELLS) {
    it(
      `Phase 3 [${engine}] — splits amountIn across pools with marginal-price equalization`,
      { skip },
      async () => {
        await runPhase3(engine);
      },
    );
    it(
      `Phase 3b [${engine}] — large amountIn: succeeds, splits, spends amountIn exactly`,
      { skip },
      async () => {
        await runPhase3b(engine);
      },
    );
  }
});

// ── Phase 4: mixed V2 + V3 split (etched constant-product pair) ───────
describe("EcoSwap V2 + V3 mixed split (etched V2 pair)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // token0 (zeroForOne)
  let tokenOut: Hex; // token1
  let v3Pool: Hex;
  let v2Pair: Hex;
  let poolConfig: ChainPoolConfig;
  // Clean post-setup snapshot — each engine cell reverts to it so both engines
  // cook against the IDENTICAL fresh pools (the cells share one anvil).
  let cleanSnapshot: Hex;

  // Deterministic, unused address to etch the V2 pair at (all-lowercase, well
  // above the precompile range, never where anvil CREATE-deploys).
  const V2_PAIR_ADDR = "0x00000000000000000000000000000000ec05a2a2" as Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const v2Factory = await deployV2Factory(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("50000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // One V3 pool (fee 3000) at 1:1 with a wide deep position.
    v3Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, 3000, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, v3Pool, minter, -12000, 12000, parseEther("300000"),
    );

    // One ETCHED V2 pair at 1:1 (equal reserves) with comparable depth — both
    // venues start at the same fee-adjusted marginal price, so the water-fill
    // must split across the V3 pool AND the V2 pair.
    v2Pair = await setupEtchedV2Pool(
      c.walletClient, c.publicClient, c.testClient, v2Factory, V2_PAIR_ADDR,
      tokenIn, tokenOut, parseEther("300000"), parseEther("300000"), minter,
    );

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
        { address: v2Factory, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Local UniV2" },
      ],
      feeTiers: [3000],
      baseTokens: [tokenIn, tokenOut],
    };

    // v12 stack (same anvil/pools) when a v12 cell runs; approve the Pot for tokenIn.
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

  async function runPhase4(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("2000");
    const caller = c.account0;

    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3Pool);
    const v2InBefore = await balanceOf(c.publicClient, tokenIn, v2Pair);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12),
      caller, poolConfig, undefined, engine,
    );

    // Discovery should surface BOTH a V3 and the etched V2 pool.
    const v2Count = prepared.pools.filter((p) => p.isV2).length;
    const v3Count = prepared.pools.filter((p) => !p.isV2).length;
    assert.equal(v2Count, 1, "should discover the etched V2 pair");
    assert.equal(v3Count, 1, "should discover the V3 pool");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "mixed V2+V3 cook() must succeed");

    const v3InAfter = await balanceOf(c.publicClient, tokenIn, v3Pool);
    const v2InAfter = await balanceOf(c.publicClient, tokenIn, v2Pair);
    const v3Delta = v3InAfter - v3InBefore;
    const v2Delta = v2InAfter - v2InBefore;

    assert.ok(v3Delta > 0n, "V3 pool should receive input");
    assert.ok(v2Delta > 0n, "etched V2 pair should receive input (V2 execution path)");

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    assert.ok(received > 0n, "caller received tokenOut");
    const leftover = amountIn - spent;
    assert.ok(leftover * 100n <= amountIn, `should spend ~all amountIn (leftover ${leftover})`);
    // V2 + V3 reserve deltas account for ~all input spent (one swap per venue).
    assert.equal(v2Delta + v3Delta, spent, "per-venue tokenIn deltas must sum to spent input");

    console.log(
      `  [P4:${engine}] mixed split: spent=${spent} received=${received} leftover=${leftover}\n` +
        `       V3 in=${v3Delta}  V2(etched) in=${v2Delta}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Phase 4 [${engine}] — splits across an etched V2 pair and a V3 pool`, { skip }, async () => {
      await runPhase4(engine);
    });
  }
});

// ── Phase 5: Uniswap V4 via etched PoolManager singleton ──────
describe("EcoSwap V4 (etched PoolManager + StateView)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // token0 (zeroForOne)
  let tokenOut: Hex; // token1
  let poolManager: Hex;
  let stateView: Hex;
  let poolId: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);

    // Etch the REAL V4 singletons (PoolManager + StateView) at canonical addresses.
    const v4 = await etchV4Singletons(c.publicClient, c.testClient);
    poolManager = v4.poolManager;
    stateView = v4.stateView;
    const helper = await deployV4Helper(c.walletClient, c.publicClient, poolManager);

    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    // Caller funds.
    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, parseEther("50000000"));

    // Initialise a V4 pool at 1:1 (fee 3000, tickSpacing 60) + a wide position.
    poolId = await setupV4Pool(
      c.walletClient, c.publicClient, helper, tokenIn, tokenOut,
      3000, 60, SQRT_PRICE_1_1, -12000, 12000, parseEther("100000"), parseEther("50000000"),
    );

    poolConfig = {
      factories: [
        { address: poolManager, stateView, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Local UniV4" },
      ],
      feeTiers: [3000],
      baseTokens: [tokenIn, tokenOut],
    };

    // v12 stack (same anvil/pools) when a v12 cell runs; approve the Pot for tokenIn.
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

  async function runPhase5(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);

    // Sanity: the pool is live with liquidity at 1:1.
    const liq = await getV4Liquidity(c.publicClient, stateView, poolId);
    assert.ok(liq > 0n, "V4 pool should have liquidity");
    const before = await getV4Slot0(c.publicClient, stateView, poolId);
    assert.equal(before.sqrtPriceX96, SQRT_PRICE_1_1, "V4 pool initialised at 1:1");

    const amountIn = parseEther("1000");
    const caller = c.account0;
    const pmInBefore = await balanceOf(c.publicClient, tokenIn, poolManager);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12),
      caller, poolConfig, undefined, engine,
    );
    const v4Count = prepared.pools.filter((p) => p.poolType === SwapPoolType.UniV4).length;
    assert.equal(v4Count, 1, "should discover the V4 pool");
    assert.ok(prepared.pools[0].poolId === poolId, "prepared poolId matches");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "V4 cook() must succeed");

    const pmInAfter = await balanceOf(c.publicClient, tokenIn, poolManager);
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const after = await getV4Slot0(c.publicClient, stateView, poolId);

    assert.ok(pmInAfter - pmInBefore > 0n, "PoolManager tokenIn balance should grow by the V4 input");
    assert.ok(received > 0n, "caller received tokenOut");
    const leftover = amountIn - spent;
    assert.ok(leftover * 100n <= amountIn, `should spend ~all amountIn (leftover ${leftover})`);
    assert.ok(after.sqrtPriceX96 < before.sqrtPriceX96, "zeroForOne swap should lower the V4 price");

    console.log(
      `  [P5:${engine}] V4 solo: spent=${spent} received=${received} leftover=${leftover}\n` +
        `       PoolManager tokenIn delta=${pmInAfter - pmInBefore} sqrtP ${before.sqrtPriceX96} -> ${after.sqrtPriceX96}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Phase 5 [${engine}] — V4 swap lands through the singleton and moves the pool price`, { skip }, async () => {
      await runPhase5(engine);
    });
  }
});

// ── Phase 6: mixed V3 + V4 split across protocol versions ─────
describe("EcoSwap V3 + V4 mixed split", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let v3Pool: Hex;
  let poolManager: Hex;
  let stateView: Hex;
  let v4PoolId: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const v4 = await etchV4Singletons(c.publicClient, c.testClient);
    poolManager = v4.poolManager;
    stateView = v4.stateView;
    const v4Helper = await deployV4Helper(c.walletClient, c.publicClient, poolManager);

    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("50000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // V3 pool (fee 500) + V4 pool (fee 3000), both at 1:1 with deep liquidity.
    v3Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, 500, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, v3Pool, minter, -12000, 12000, parseEther("300000"),
    );
    v4PoolId = await setupV4Pool(
      c.walletClient, c.publicClient, v4Helper, tokenIn, tokenOut,
      3000, 60, SQRT_PRICE_1_1, -12000, 12000, parseEther("300000"), parseEther("50000000"),
    );

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
        { address: poolManager, stateView, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Local UniV4" },
      ],
      feeTiers: [500, 3000],
      baseTokens: [tokenIn, tokenOut],
    };

    // v12 stack (same anvil/pools) when a v12 cell runs; approve the Pot for tokenIn.
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

  async function runPhase6(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("2000");
    const caller = c.account0;

    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3Pool);
    const pmInBefore = await balanceOf(c.publicClient, tokenIn, poolManager);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12),
      caller, poolConfig, undefined, engine,
    );
    assert.equal(prepared.pools.filter((p) => p.poolType === SwapPoolType.UniV3).length, 1, "1 V3 pool");
    assert.equal(prepared.pools.filter((p) => p.poolType === SwapPoolType.UniV4).length, 1, "1 V4 pool");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "mixed V3+V4 cook() must succeed");

    const v3Delta = (await balanceOf(c.publicClient, tokenIn, v3Pool)) - v3InBefore;
    const v4Delta = (await balanceOf(c.publicClient, tokenIn, poolManager)) - pmInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;

    assert.ok(v3Delta > 0n, "V3 pool should receive input");
    assert.ok(v4Delta > 0n, "V4 pool should receive input");
    assert.ok(received > 0n, "caller received tokenOut");
    assert.equal(v3Delta + v4Delta, spent, "per-venue tokenIn deltas must sum to spent input");

    console.log(
      `  [P6:${engine}] V3+V4 split: spent=${spent} received=${received}\n` +
        `       V3 in=${v3Delta}  V4 in=${v4Delta}  (poolId ${v4PoolId.slice(0, 10)}…)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Phase 6 [${engine}] — splits across a V3 pool and a V4 pool`, { skip }, async () => {
      await runPhase6(engine);
    });
  }
});
