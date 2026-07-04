/**
 * EcoSwap Topaz-CL PROD-MIRROR local EVM test — NO fork, NO live RPC.
 *
 * Sibling of ecoswap.slipstream.prodmirror.evm.test.ts (the Aerodrome Base
 * prod-mirror). It reproduces a REAL production Topaz CL pool (BSC — Slipstream
 * family, tickSpacing-keyed CLFactory) on a fresh local anvil, discovers it
 * through the PRODUCTION Slipstream path (getPool(a, b, int24) via the
 * SlipstreamCLFactory shim) and runs the compiled EcoSwap recipe against it.
 *
 * WHAT TOPAZ ADDS OVER THE AERODROME SIBLING — a genuinely DYNAMIC fee
 * ─────────────────────────────────────────────────────────────────────
 * Aerodrome Base decouples fee from the tickSpacing key but keeps it static per
 * spacing (the captured ts=1 pool carries the canonical 100). Topaz's fee() is
 * DYNAMIC: the wired WBNB/USDT ts=50 pool has been observed at 53..67 ppm (64 at
 * capture) — a value that appears in NO fee-tier menu and in NO spacing→fee
 * mapping (TICK_SPACING_BY_FEE's inverse for ts=50 is Pancake's 2500). So this
 * test can assert something the Aerodrome sibling cannot: the fee threading into
 * prepare and the solver walk MUST have come from the pool's own live fee() read
 * — there is no static source it could have leaked from. Concretely:
 *   (a) the injected poolConfig's feeTiers are the CANONICAL menu (64 absent) and
 *       the snapshot fee is asserted to be in NO static table, yet
 *       prepared.pools[0].feePpm == 64 — prepare's fee is the live fee() read;
 *   (b) the landed OUTPUT matches a pure-math walk of the captured staircase at
 *       fee=64 (tight tolerance) and does NOT match the same walk at any static
 *       candidate (500 / 2500 / 3000) — the solver walk + execution really
 *       charged the dynamic fee, wei-for-wei.
 *
 * RECONSTRUCTION FIDELITY (same tier as the Aerodrome sibling): REAL captured
 * pool STATE (sqrtPriceX96 + full tick profile + active L + the decoupled
 * DYNAMIC fee) minted into a genuine @uniswap/v3-core pool — Topaz CLPool.swap
 * is v3-core swap math over that exact state and re-enters via the standard
 * uniswapV3SwapCallback (engine-authenticated by transient expectedPool, not a
 * factory check), so the executed swap is provably identical to the real
 * pool's. The v3-core factory has fee 64 enabled at tickSpacing 50
 * (enableFeeAmount) so the reconstructed pool's own fee() returns the REAL
 * captured dynamic value.
 *
 * THE DRIFT CASE is grid-aware: Topaz's ts=50 spacing makes one tickSpacing
 * ≈0.50%, so the boundary-crossing drift the re-anchor proof needs (the nearest
 * initialized boundary is 45 ticks below spot) inherently exceeds the DEFAULT
 * 50 bps internal minOut floor. The case asserts BOTH designed outcomes: the
 * default-floor bytecodes revert ("ecoswap: amountOut below minOut" — the
 * defense-in-depth guard evaluating the LIVE drifted output), then bytecodes
 * prepared with a 200 bps budget re-anchor to the drifted slot0 and fill.
 *
 * Offline by design: it loads the CHECKED-IN captured snapshot
 * (fixtures/snapshots/bsc-topaz-USDTWBNB-50.json). Recapture with:
 *   set -a; . sdk/.env; set +a
 *   SNAPSHOT_RPC_URL=$BSC_RPC_URL npx tsx src/recipes/test/harness/slipstream-snapshot.ts \
 *     0x767F1F4bF9E5E40F3D865c172c9bD0AE216e65B4 topaz
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.topaz.prodmirror.evm.test.ts
 * (ECO_ENGINE=v1 for the v1 lane; RECAPTURE_ANVIL_STATE=1 after engine/harness
 * changes — the anvil-state blob bakes in the engine bytecode.)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, type Hex, type Account, type Abi } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  mint,
  approve,
  balanceOf,
  getSlot0,
  deploySlipstreamFactory,
  slipstreamFactoryAbi,
  v3PoolAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { writeAndWait } from "./harness/deploy";
import {
  type Engine,
  selectedEngines,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import {
  reproducePool,
  parseBoundaries,
  verifyReproduction,
  type ReproducedPool,
  type ReproductionDiff,
} from "./harness/reproduce-pool";
import { withCachedState, CACHED_BLOCK_TIMESTAMP } from "./harness/state-cache";
import type { ProdPoolSnapshot } from "./harness/prod-snapshot";
import {
  SwapPoolType,
  FactoryType,
  TICK_SPACING_BY_FEE,
  type ChainPoolConfig,
} from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { driftPoolPrice } from "./harness/drift";
import { Q96, FEE_DENOM, getSqrtRatioAtTick } from "./ecoswap.math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "fixtures", "snapshots");
// The captured REAL Topaz CL pool (BSC WBNB/USDT, tickSpacing 50, DYNAMIC fee —
// 64 ppm at capture; token0 = USDT, token1 = WBNB, both 18-dec on BSC). Captured
// by harness/slipstream-snapshot.ts (see the recapture command in the header).
const SNAPSHOT_FILE = "bsc-topaz-USDTWBNB-50.json";

const HUGE = parseEther("1000000000"); // both tokens are 18-decimal on BSC

// Uniswap-V3 / Slipstream canonical MIN_TICK (the zeroForOne price-limit floor).
// Every trade below is sized so its cut is a GENUINE interior liquidity cut of
// the captured staircase, never this window-drain artifact.
const MIN_TICK = -887272;

// The CANONICAL fee-tier menu, injected as the poolConfig's feeTiers. It
// deliberately EXCLUDES the captured dynamic fee — if prepare's feePpm still
// equals the snapshot fee, it can only have come from the pool's own fee() read.
const CANONICAL_FEE_TIERS = [100, 500, 3000, 10000];

// RECONSTRUCTED-BAND BUDGET (ts=50 WBNB/USDT, zeroForOne = USDT in). Probed from
// the snapshot with the same staircase math as predictDownWalk below: the live
// [−63550, −63505] band alone absorbs ≈5,186 USDT gross; the window's total
// gross-in capacity from spot down to the deepest captured boundary (−65200) is
// ≈28,003 USDT. All trades below stay well inside it.

// Per-pool net-cache measure (mirrors the V3/Slipstream prod-mirrors): a scanned
// WINDOW (windowTopShifted > 0) is a populated per-pool cache. Defined locally
// (not shared) to avoid races.
function cacheWindowedPools(
  pools: { isV2?: boolean; windowTopShifted?: bigint }[],
): number {
  return pools.filter((p) => !p.isV2 && (p.windowTopShifted ?? 0n) > 0n).length;
}

// Single engine per (heavy) file: the one selected engine (default v12;
// ECO_ENGINE=v1 forces v1). See harness/engine.ts.
const PROD_ENGINE: Engine = selectedEngines()[0];

function loadSnapshot(): ProdPoolSnapshot {
  return JSON.parse(readFileSync(join(SNAPSHOT_DIR, SNAPSHOT_FILE), "utf-8")) as ProdPoolSnapshot;
}

/**
 * Pure-bigint downward (zeroForOne) walk of the captured staircase at an
 * arbitrary feePpm: gross tokenIn → (predicted token1 out, predicted final
 * sqrtPriceX96). Standard V3 band math (amount0 = L·(√a−√b)·Q96/(√a·√b),
 * amount1 = L·(√a−√b)/Q96), fee taken up front on the gross input — matches
 * V3's per-step fee to well under 1 ppm of output for an interior-cut trade,
 * which is orders of magnitude tighter than the fee-candidate spacing this test
 * discriminates (64 vs 500/2500/3000). Used ONLY with tolerance assertions.
 */
function predictDownWalk(
  snap: ProdPoolSnapshot,
  grossIn: bigint,
  feePpm: number,
): { out: bigint; sqrtAfter: bigint } {
  const below = parseBoundaries(snap)
    .filter((b) => b.tick <= snap.tick)
    .sort((a, b) => b.tick - a.tick);
  let L = BigInt(snap.liquidity);
  let sqrt = BigInt(snap.sqrtPriceX96);
  let eff = (grossIn * (FEE_DENOM - BigInt(feePpm))) / FEE_DENOM;
  let out = 0n;
  for (const b of below) {
    const target = getSqrtRatioAtTick(b.tick);
    if (L > 0n) {
      const need = (L * (sqrt - target) * Q96) / (sqrt * target);
      if (eff <= need) {
        const sqrtAfter = (L * Q96 * sqrt) / (L * Q96 + eff * sqrt);
        out += (L * (sqrt - sqrtAfter)) / Q96;
        return { out, sqrtAfter };
      }
      eff -= need;
      out += (L * (sqrt - target)) / Q96;
    }
    sqrt = target;
    L -= b.net; // crossing down subtracts the boundary's net
  }
  return { out, sqrtAfter: sqrt };
}

/** Manifest the cache stores/rehydrates: everything the test needs post-loadState. */
interface TopazManifest {
  stack: DeployedStack;
  v12: DeployedV12Stack | null;
  repro: ReproducedPool;
  /** The SlipstreamCLFactory shim (getPool keyed by int24 tickSpacing). */
  slipFactory: Hex;
}

describe("EcoSwap Topaz-CL prod-mirror (reproduced real BSC tick state, DYNAMIC fee)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let slipFactory: Hex;
  let snap: ProdPoolSnapshot;
  let repro: ReproducedPool;
  let diff: ReproductionDiff;
  let cleanSnapshot: Hex; // pristine reconstructed state (for the drift case)

  before(async () => {
    snap = loadSnapshot();
    console.log(
      `  [topaz-prod-mirror] using REAL snapshot ${SNAPSHOT_FILE}` +
        ` (${snap.symbol0}/${snap.symbol1} fee=${snap.fee} tickSpacing=${snap.tickSpacing}` +
        ` tick=${snap.tick}, ${snap.ticks.length} boundaries)`,
    );

    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);

    // Full deploy + reconstruction, cached once per engine
    // (fixtures/anvil-state/topaz-prodmirror-<engine>) so later runs loadState in
    // seconds. Recapture: RECAPTURE_ANVIL_STATE=1. See state-cache.ts.
    const { manifest, fromCache } = await withCachedState<TopazManifest>({
      name: "topaz-prodmirror",
      engine: PROD_ENGINE,
      c,
      build: async () => {
        await ensureMulticall3(c.publicClient, c.testClient);
        const s = await deployStack(c.walletClient, c.publicClient);
        // Reconstruct the captured Topaz pool as a REAL v3-core pool. The
        // snapshot's fee/tickSpacing (64 / 50) are NOT a stock v3-core tier, so
        // reproducePool enableFeeAmount(64, 50)s the local factory first — the
        // reconstructed pool's own fee() then returns the REAL dynamic value.
        const r = await reproducePool(c.walletClient, c.publicClient, s.factory, s.helper, snap, HUGE);
        // Register it in the Slipstream shim under its int24 tickSpacing so the
        // production tickSpacing-keyed getPool(a, b, int24) discovery finds it.
        const sf = await deploySlipstreamFactory(c.walletClient, c.publicClient);
        await writeAndWait(c.walletClient, c.publicClient, {
          address: sf,
          abi: slipstreamFactoryAbi as Abi,
          functionName: "setPool",
          args: [r.token0, r.token1, snap.tickSpacing, r.pool],
        });
        const v = await maybeDeployV12Stack(c, c.walletClient.account as Account);
        if (v) await approve(c.walletClient, c.publicClient, r.token0, v.pot, HUGE);
        return { stack: s, v12: v, repro: r, slipFactory: sf };
      },
    });
    console.log(
      `  [topaz-prod-mirror] state ${fromCache ? "LOADED from cache" : "RECONSTRUCTED + cached"} (engine ${PROD_ENGINE})`,
    );
    stack = manifest.stack;
    v12 = manifest.v12;
    repro = manifest.repro;
    slipFactory = manifest.slipFactory;

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  /**
   * poolConfig pointing discovery + the lens at the local Slipstream CLFactory
   * shim (tickSpacing-keyed), carrying the snapshot's tickSpacing as the discovery
   * key. feeTiers is the CANONICAL menu — the captured dynamic fee (64) is
   * deliberately ABSENT, so a feePpm of 64 downstream can only be the live fee()
   * read (Slipstream rows never consume feeTiers; this pins that). baseTokens =
   * the swap pair so the multi-hop route loop yields zero routes (single
   * reproduced pool → direct-only), exactly as the Slipstream sibling.
   */
  function topazPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: slipFactory,
          poolType: SwapPoolType.UniV3,
          factoryType: FactoryType.SlipstreamCL,
          label: "Local Topaz CL (prod-mirror)",
          slipstreamTickSpacings: [snap.tickSpacing],
        },
      ],
      feeTiers: CANONICAL_FEE_TIERS,
      baseTokens: [tokenIn, tokenOut],
    };
  }

  it("reproduces the snapshot's on-chain tick state (sqrt EXACT + boundary nets EXACT + dynamic fee)", async () => {
    diff = await verifyReproduction(c.publicClient, repro.pool, snap, {
      baselineClamped: repro.baselineClamped,
    });

    console.log(
      `  [topaz-prod-mirror] reproduction diff:\n` +
        `    sqrtPriceX96 snapshot=${diff.sqrtSnapshot} onchain=${diff.sqrtOnchain} match=${diff.sqrtPriceMatch}\n` +
        `    active liquidity snapshot=${diff.activeSnapshot} onchain=${diff.activeOnchain} match=${diff.activeLiquidityMatch}\n` +
        `    boundaries checked (interior + b0)=${diff.boundariesChecked} net mismatches=${diff.netMismatches.length}\n` +
        `    right-edge truncation artifact=${
          diff.rightEdgeArtifact
            ? `tick ${diff.rightEdgeArtifact.tick}: snapshot ${diff.rightEdgeArtifact.snapshot} vs onchain ${diff.rightEdgeArtifact.onchain}`
            : "none"
        }\n` +
        `    baseline=${repro.baseline} clamped=${repro.baselineClamped} positions=${repro.positions.length}`,
    );

    // sqrtPriceX96 must be EXACT (initialize sets it directly).
    assert.equal(diff.sqrtPriceMatch, true, "reproduced sqrtPriceX96 must equal snapshot");
    // Active liquidity exact within the window (unless baseline was clamped).
    if (!repro.baselineClamped) {
      assert.equal(diff.activeLiquidityMatch, true, "reproduced active liquidity must equal snapshot");
    }
    // Every interior + b0 boundary's liquidityNet must match EXACTLY.
    assert.equal(
      diff.netMismatches.length,
      0,
      `interior boundary liquidityNet must match snapshot exactly (${diff.netMismatches
        .map((m) => `tick ${m.tick}: ${m.snapshot} vs ${m.onchain}`)
        .join("; ")})`,
    );
    assert.equal(diff.ok, true, "reproduction must be faithful");

    // THE DYNAMIC-FEE PRECONDITIONS. The captured fee is a value NO static table
    // can produce: not a canonical tier, not in TICK_SPACING_BY_FEE (whose ts=50
    // inverse is Pancake's 2500), and not the injected feeTiers menu. So every
    // downstream appearance of this number is the live fee() read.
    assert.ok(
      !(snap.fee in TICK_SPACING_BY_FEE),
      `captured fee ${snap.fee} must not be a known static tier (dynamic-fee precondition)`,
    );
    assert.ok(
      !CANONICAL_FEE_TIERS.includes(snap.fee),
      `captured fee ${snap.fee} must be absent from the injected feeTiers menu`,
    );
    assert.notEqual(snap.fee, 2500, "captured fee differs from the spacing-derived static guess for ts=50");

    // The reconstructed pool's decoupled DYNAMIC fee + grid are the REAL Topaz
    // values, read from the pool's own getters — the production discovery path
    // reads them.
    const poolFee = Number(
      await c.publicClient.readContract({ address: repro.pool, abi: v3PoolAbi as Abi, functionName: "fee" }),
    );
    assert.equal(poolFee, snap.fee, "reconstructed pool fee() equals the captured DYNAMIC fee");

    // The Slipstream shim resolves the pool by its int24 tickSpacing key.
    const resolved = (await c.publicClient.readContract({
      address: slipFactory,
      abi: slipstreamFactoryAbi as Abi,
      functionName: "getPool",
      args: [repro.token0, repro.token1, snap.tickSpacing],
    })) as Hex;
    assert.equal(resolved.toLowerCase(), repro.pool.toLowerCase(), "shim resolves the pool by its tickSpacing key");
  });

  it("runs EcoSwap through the reproduced Topaz pool (wei-exact vs the oracle; DYNAMIC fee threads prepare + the walk)", async () => {
    // zeroForOne: tokenIn = token0 (USDT) < token1 (WBNB) = tokenOut — matches
    // prepare's downward tick scan and the snapshot's lower-boundary staircase.
    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = repro.token0;
    const tokenOut = repro.token1;
    const caller = c.account0;

    // Size the trade so it crosses several reconstructed initialized ticks but
    // stays well inside the ≈28,003-USDT reconstructed-band budget: 12,000 USDT
    // crosses −63550 (≈5,186 gross) → −63650 (≈9,856) → −63700 (≈11,044) and
    // lands inside [−63750, −63700) — a GENUINE interior liquidity cut.
    const amountIn = parseEther("12000");

    const poolConfig = topazPoolConfig(tokenIn, tokenOut);

    // Fund + approve the caller for tokenIn.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

    const poolInBefore = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const poolOutBefore = await balanceOf(c.publicClient, tokenOut, repro.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { tick: tickBefore } = await getSlot0(c.publicClient, repro.pool);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      undefined,
      PROD_ENGINE,
    );

    const v3Count = prepared.pools.filter((p) => !p.isV2).length;
    assert.equal(v3Count, 1, "should discover exactly the 1 reproduced Topaz pool");
    assert.equal(prepared.pools.length, 1, "exactly one direct pool");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    // THE PREPARE-SIDE DYNAMIC-FEE ASSERTION: feePpm equals the captured dynamic
    // fee even though the injected feeTiers menu does NOT contain it and no static
    // spacing→fee table maps to it (asserted above) — prepare's fee is the live
    // per-pool fee() read, exactly as production Topaz requires.
    assert.equal(
      prepared.pools[0].feePpm,
      snap.fee,
      "prepared feePpm == the pool's own DYNAMIC fee() (not derivable from any injected/static tier)",
    );
    assert.ok(
      cacheWindowedPools(prepared.pools) > 0,
      "should build a per-pool net-cache window from reconstructed ticks",
    );
    assert.ok(prepared.zeroForOne, "tokenIn < tokenOut → zeroForOne");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against reproduced Topaz geometry");

    const poolInAfter = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const poolOutAfter = await balanceOf(c.publicClient, tokenOut, repro.pool);
    const callerInAfter = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutAfter = await balanceOf(c.publicClient, tokenOut, caller);
    const { tick: tickAfter } = await getSlot0(c.publicClient, repro.pool);

    const spent = callerInBefore - callerInAfter;
    const received = callerOutAfter - callerOutBefore;

    assert.ok(spent > 0n, "caller should spend tokenIn");
    assert.ok(received > 0n, "caller should receive tokenOut > 0");
    assert.equal(poolInAfter - poolInBefore, spent, "pool tokenIn reserve increases by spent");
    assert.equal(poolOutBefore - poolOutAfter, received, "pool tokenOut reserve decreases by received");

    // zeroForOne moves the price DOWN — the live tick must have decreased through
    // reconstructed initialized ticks, and landed at a GENUINE interior cut.
    assert.ok(
      tickAfter < tickBefore,
      `swap must cross reconstructed ticks (tick ${tickBefore} -> ${tickAfter})`,
    );
    assert.ok(
      tickAfter > MIN_TICK,
      `swap lands at an interior cut, not the price-limit floor (tick ${tickAfter})`,
    );

    // WEI-EXACT oracle cross-check: deterministic local state == prepared state, so
    // the neutral oracle (ecoswap.optimal.ts, via the bit-for-bit ecoSwapReference
    // adapter — whose math consumes prepared.feePpm, i.e. the live-read 64) allocates
    // EXACTLY the on-chain spend for the single reproduced pool.
    const ref = ecoSwapReference(prepared, amountIn);
    const refIn = ref.perPoolInput[0] ?? 0n;
    assert.ok(refIn > 0n, "oracle allocates to the reproduced pool");
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY (to the wei)");
    assert.equal(spent, refIn, "per-pool awarded input == oracle to the wei");
    assert.equal(poolInAfter - poolInBefore, refIn, "pool tokenIn delta == oracle per-pool input to the wei");

    // THE WALK/EXECUTION-SIDE DYNAMIC-FEE ASSERTION. Predict the landed output by
    // walking the captured staircase at candidate fees: the on-chain output must
    // match the DYNAMIC fee's walk tightly (the predictor's only slack is fee
    // rounding order — well under 1 ppm here) and must be FAR from every static
    // candidate a mis-wired path could have used (canonical 500/3000, or 2500 —
    // the TICK_SPACING_BY_FEE inverse of the ts=50 key). Fee separation ≥ 436 ppm
    // of input dwarfs the sub-ppm predictor slack, so this cleanly proves the
    // swap charged fee()=64, not a static tier.
    const p64 = predictDownWalk(snap, spent, snap.fee);
    const tolerance = received / 100_000n; // 10 ppm — >40x the predictor slack, <1/40th the fee gap
    const d64 = received > p64.out ? received - p64.out : p64.out - received;
    assert.ok(
      d64 <= tolerance,
      `output matches the DYNAMIC-fee walk (fee ${snap.fee}): onchain ${received} vs predicted ${p64.out} (|d|=${d64} > tol ${tolerance})`,
    );
    for (const wrongFee of [500, 2500, 3000]) {
      const pw = predictDownWalk(snap, spent, wrongFee);
      const dw = received > pw.out ? received - pw.out : pw.out - received;
      assert.ok(
        dw > received / 10_000n,
        `output must NOT match a static fee ${wrongFee} walk (onchain ${received} vs predicted ${pw.out})`,
      );
    }

    console.log(
      `  [topaz-prod-mirror] swap landed: spent=${spent} received=${received}` +
        ` tick ${tickBefore}->${tickAfter} (crossed ticks)` +
        ` oracle totalInput=${ref.totalInput} perPool[0]=${refIn} (wei-exact)` +
        ` dynamic-fee walk |d|=${d64} (tol ${tolerance})`,
    );
  });

  it("re-anchors to the live slot0 price when the Topaz pool drifts after prepare", async () => {
    await c.testClient.revert({ id: cleanSnapshot });
    // Re-pin the block timestamp after the revert — the V3 oracle accumulator
    // depends on block.timestamp, which otherwise drifts across evm_revert.
    await c.testClient.setNextBlockTimestamp({ timestamp: CACHED_BLOCK_TIMESTAMP });

    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = repro.token0;
    const tokenOut = repro.token1;
    const caller = c.account0;
    // The recipe's trade. Sized SMALL relative to the reconstructed-band budget so
    // that, AFTER a boundary-crossing drift, the re-anchored full-amountIn fill
    // still lands at a GENUINE interior liquidity cut. drift (6,000) + amountIn
    // (2,000) = 8,000 gross-in ≪ the ≈28,003 budget.
    const amountIn = parseEther("2000");
    const poolConfig = topazPoolConfig(tokenIn, tokenOut);
    const { tick: preparedTick } = await getSlot0(c.publicClient, repro.pool);

    // PREPARE against the clean (pre-drift) tick state — twice:
    //   (1) with the DEFAULT internal minOut floor (50 bps). On Topaz's ts=50
    //       grid ONE tickSpacing is ≈0.50%, and the nearest initialized boundary
    //       sits 45 ticks (≈0.45%) below spot — so a boundary-crossing drift
    //       necessarily pushes the re-anchored fill's output ~0.5% below the
    //       prepared estimate, i.e. PAST the default floor. These bytecodes are
    //       cooked first and MUST revert: the defense-in-depth minOut guard
    //       firing on genuinely excessive adverse drift.
    //   (2) with the floor widened to 200 bps — the caller's deliberate budget
    //       for absorbing a boundary-crossing drift on this coarse grid. These
    //       bytecodes must re-anchor and fill.
    const { bytecodes: bytecodesDefaultFloor } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      undefined,
      PROD_ENGINE,
    );
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      { slippageBps: 200 },
      PROD_ENGINE,
    );
    assert.equal(
      prepared.pools[0].feePpm,
      snap.fee,
      "drift-case prepare also carries the live DYNAMIC fee()",
    );
    const ref = ecoSwapReference(prepared, amountIn);
    const refV3 = ref.perPoolInput[0] ?? 0n;
    assert.ok(refV3 > 0n, "baseline allocates to the Topaz pool");

    // DRIFT: push the pool's price DOWN with a real swap routed through the
    // engine's swapV3 / uniswapV3SwapCallback path. The live [−63550, spot] band
    // absorbs ≈5,186 USDT gross, so the 6,000-USDT drift CROSSES the −63550
    // initialized boundary and lands the live tick strictly below the prepared
    // tick — a discriminating, boundary-crossing drift (a sub-band drift could
    // not distinguish genuine Phase-B live-price re-anchoring from stale-price
    // behavior).
    const driftAmount = parseEther("6000");
    await driftPoolPrice(c, stack.sauceRouter, prepared.pools[0], tokenIn, tokenOut, true, driftAmount, caller);
    const { sqrtPriceX96: driftedSqrt, tick: driftedTick } = await getSlot0(c.publicClient, repro.pool);

    assert.ok(
      driftedTick < preparedTick,
      `drift crossed a real initialized boundary: live tick ${preparedTick} -> ${driftedTick}`,
    );
    assert.ok(driftedSqrt < BigInt(snap.sqrtPriceX96), "drift moved the live price below the prepared price");

    // EXECUTE the pre-drift bytecodes — Phase B must read the NEW slot0 price.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    // First, the DEFAULT-floor bytecodes: the ≈0.5% boundary-crossing drift
    // exceeds the 50 bps internal minOut budget, so the solver's own
    // defense-in-depth guard must fire ("ecoswap: amountOut below minOut") —
    // the coarse ts=50 grid makes this the DESIGNED outcome, and asserting it
    // pins that the guard evaluates the LIVE (drifted) output, not the
    // prepare-time estimate.
    const { receipt: guardReceipt } = await cook(
      c.walletClient, c.publicClient, target, bytecodesDefaultFloor,
    );
    assert.equal(
      guardReceipt.status,
      "reverted",
      "default 50 bps minOut floor must fire on a boundary-crossing (≈0.5%) adverse drift",
    );
    const spentByGuarded =
      callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    assert.equal(spentByGuarded, 0n, "the guarded revert must not spend any tokenIn");

    // Then the widened-floor bytecodes re-anchor and fill.
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against drifted slot0");

    const v3InDelta = (await balanceOf(c.publicClient, tokenIn, repro.pool)) - poolInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const { tick: afterTick } = await getSlot0(c.publicClient, repro.pool);

    // SINGLE-PASS RE-ANCHORING (input-anchored) — the SAME semantics the
    // Slipstream sibling asserts. The solver re-reads the LIVE (drifted) slot0
    // price in Phase B and walks the pool's frontier from THERE, spending the
    // user's full `amountIn` against the drifted price.
    assert.ok(v3InDelta > 0n, "pool still participates");
    assert.equal(v3InDelta, spent, "single pool → spent == its fill");
    assert.ok(spent <= amountIn, "never overspends amountIn");
    // Input-anchored: it deploys the LARGE majority of the trade against the
    // drifted price (with this small amountIn well inside post-drift depth the
    // fill is a full 100%).
    assert.ok(
      spent >= (amountIn * 80n) / 100n,
      `spends the large majority of the trade against the drifted price (spent ${spent} of ${amountIn})`,
    );
    // ...and the re-anchored fill lands at a GENUINE interior liquidity cut, NOT
    // the price-limit floor.
    assert.ok(
      afterTick > MIN_TICK,
      `re-anchored fill lands at an interior cut, not the price-limit floor (tick ${afterTick})`,
    );
    // The fill walked DOWN from the drifted price (it moved the live tick
    // further), confirming it executed against the post-drift price.
    assert.ok(
      afterTick <= driftedTick,
      `re-anchored fill walks down from the drifted price (drifted ${driftedTick} -> after ${afterTick})`,
    );

    console.log(
      `  [topaz-prod-mirror] RUNTIME re-anchor (single-pass, input-anchored): ` +
        `drift ${driftAmount} moved live tick ${preparedTick}->${driftedTick}; ` +
        `then recipe spent ${spent} of amountIn ${amountIn} (baseline fill ${refV3}); ` +
        `tick ${driftedTick}->${afterTick}`,
    );
  });
});
