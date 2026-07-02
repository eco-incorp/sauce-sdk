/**
 * EcoSwap on-chain PREPARE LENS — LOCAL EVM integration, NO fork.
 *
 * Validates the LAZY v2 lens: boots anvil + engine + local pools (V2 + two V3),
 * invokes the lens via ONE read-only cook() eth_call (runLens), and asserts the
 * lazy tick-reading behaviour + faithful decode + oracle-matching split.
 *
 * Lazy assertions:
 *   1. A SMALL swap reads FEW forward ticks per pool (scannedForward << 96) yet
 *      the lens's decoded reads match DIRECT viem reads for every tick it DID read.
 *   2. A LARGE swap reads MORE forward ticks (still bounded) and crosses real
 *      initialized boundaries whose liquidityNet matches direct reads.
 *   3. Drift ticks appear on BOTH sides of spot (reverse-drift rows present).
 *   4. prepareEcoSwap (lens-driven) builds brackets whose water-filled split
 *      matches the ecoswap.reference.ts oracle on the SAME prepared state.
 *
 * Run: pnpm --filter './sdk' exec tsx --test src/recipes/test/ecoswap.lens.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  createAndInitPool,
  mint,
  approve,
  mintPosition,
  getSlot0,
  getLiquidity,
  getTickLiquidityNet,
  deployV2Factory,
  setupEtchedV2Pool,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Account } from "viem";
import { engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { runLens, type LensPool, type LensResult } from "../ecoswap/lens";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";

const HUGE = parseEther("1000000000");
const V2_PAIR_ADDR = "0x00000000000000000000000000000000ec05a2a2" as Hex;
// Pin the lens's HARD per-pool tick ceiling to the legacy 96 for these lazy-walk/decode
// gates so their "scannedForward << 96" assertions stay meaningful. With bandTicks at its
// LENS_BAND_TICKS=256 default, effTicks = clamp(256/ts, 96, maxTicks=96) = 96 for every pool
// (HI caps it), i.e. explicitly forcing legacy behavior. (Production uses maxTicks=256 so a
// tight ts=1 pool can walk the full price band.)
const MAX_TICKS = 96;

// ENGINE NOTE: the lens is v12-native (runLens compiles to `target` and cooks through
// that engine — v1 SauceRouter or the V12Pot's Huff runtime, with a target-gated cook
// return decode). The lazy-walk/decode GATES below pin to v1 (lensCfg().target) — they
// compare the lens's decoded reads to DIRECT viem reads, which is engine-independent, so
// v1 alone suffices and needs no V12Pot/owner wiring. The dedicated v1↔v12 PARITY test at
// the end cooks the SAME lens on BOTH engines and asserts identical survivors/header.

describe("EcoSwap LAZY lens — local EVM, ONE eth_call discovery+state+ticks", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let v2Factory: Hex;
  let v3PoolByFee: Map<number, Hex>;
  let v2Pair: Hex;
  let poolConfig: ChainPoolConfig;
  let zeroForOne: boolean;
  let v12: DeployedV12Stack | null = null;

  // Lens cook target + bytecode target for the v1 decode GATES — always v1 (see ENGINE
  // NOTE). The PARITY test deploys/uses the v12 stack separately.
  function lensCfg(): { target: "v1"; cookAddress: Hex; sauceRouter: Hex } {
    return { target: "v1", cookAddress: stack.sauceRouter, sauceRouter: stack.sauceRouter };
  }

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v2Factory = await deployV2Factory(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;
    zeroForOne = BigInt(tokenIn) < BigInt(tokenOut);

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("50000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // Two V3 pools (fee 500 deep, fee 3000 medium) at 1:1. Tight-ish concentrated
    // ranges so a LARGE swap crosses several initialized boundaries (the inner
    // [-600,600] range is only 60 ticks away for tickSpacing 10), while a SMALL
    // swap should not reach any boundary at all → near-zero ticks read.
    v3PoolByFee = new Map();
    for (const [fee, L] of [[500, parseEther("400000")], [3000, parseEther("250000")]] as [number, bigint][]) {
      const pool = await createAndInitPool(
        c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, fee, SQRT_PRICE_1_1,
      );
      for (const [lo, hi, l] of [
        [-12000, 12000, L],
        [-600, 600, L / 2n],
      ] as [number, number, bigint][]) {
        await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, lo, hi, l);
      }
      v3PoolByFee.set(fee, pool);
    }

    v2Pair = await setupEtchedV2Pool(
      c.walletClient, c.publicClient, c.testClient, v2Factory, V2_PAIR_ADDR,
      tokenIn, tokenOut, parseEther("300000"), parseEther("300000"), minter,
    );

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
        { address: v2Factory, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Local UniV2" },
      ],
      feeTiers: [500, 3000],
      baseTokens: [tokenIn, tokenOut],
    };

    // v12 stack for the v1↔v12 parity test (skipped if v12 artifacts absent).
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
  });

  after(() => anvil?.stop());

  /** Forward-walk tick indices for a pool (in swap direction) from its aligned base. */
  function forwardTicks(p: LensPool): number[] {
    const base = Math.floor(p.tick / p.tickSpacing) * p.tickSpacing;
    const start = zeroForOne ? base : base + p.tickSpacing;
    const step = zeroForOne ? -p.tickSpacing : p.tickSpacing;
    const out: number[] = [];
    for (let k = 0; k < p.scannedForward; k++) out.push(start + step * k);
    return out;
  }

  it("SMALL swap reads FEW ticks per pool, decoded reads match direct viem reads", async () => {
    // Tiny relative to depth → price barely moves → the lazy walk stops almost
    // immediately (stop boundary + driftTicks), never reaching the ±600 ranges.
    const amountIn = parseEther("5");
    const cfg = lensCfg();
    const { pools } = await runLens(c.publicClient, cfg.cookAddress, poolConfig, {
      tokenIn, tokenOut, zeroForOne, amountIn, driftTicks: 2, maxTicks: MAX_TICKS, target: cfg.target,
    });

    const v3 = pools.filter((p) => p.poolType === SwapPoolType.UniV3);
    const v2 = pools.filter((p) => p.poolType === SwapPoolType.UniV2);
    assert.equal(v3.length, 2, "lens discovers both V3 pools");
    assert.equal(v2.length, 1, "lens discovers the etched V2 pair");

    for (const p of v3) {
      const pool = v3PoolByFee.get(p.fee)!;
      const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, pool);
      const liq = await getLiquidity(c.publicClient, pool);
      assert.equal(p.sqrtPriceX96, sqrtPriceX96, `fee ${p.fee} sqrtPrice`);
      assert.equal(p.tick, tick, `fee ${p.fee} tick`);
      assert.equal(p.liquidity, liq, `fee ${p.fee} liquidity`);
      // LAZY: a tiny swap reads only a handful of forward ticks, NOT the full window.
      assert.ok(p.scannedForward > 0, `fee ${p.fee} scanned at least one forward tick`);
      assert.ok(
        p.scannedForward <= 8,
        `fee ${p.fee} SMALL swap reads few forward ticks (got ${p.scannedForward}, cap ${MAX_TICKS})`,
      );
      // Every tick the lens DID read must match a direct viem read.
      for (const [tickIdx, net] of p.net) {
        const direct = await getTickLiquidityNet(c.publicClient, pool, tickIdx);
        assert.equal(net, direct.liquidityNet, `fee ${p.fee} net@${tickIdx}`);
      }
      console.log(`  [SMALL] fee ${p.fee}: scannedForward=${p.scannedForward} (cap ${MAX_TICKS})`);
    }

    // V2 carries no ticks.
    assert.equal(v2[0].scannedForward, 0, "V2 has no forward ticks");
    assert.ok(v2[0].liquidity > 0n, "V2 synthetic L > 0");
  });

  it("LARGE swap reads MORE ticks, crosses initialized boundaries; drift on BOTH sides", async () => {
    // Large enough to push price past the inner [-600,600] boundary on the
    // shallower pool → the walk must read more forward ticks and cross a real
    // initialized boundary whose net matches the direct read.
    const amountIn = parseEther("200000");
    const cfg = lensCfg();
    const small = await runLens(c.publicClient, cfg.cookAddress, poolConfig, {
      tokenIn, tokenOut, zeroForOne, amountIn: parseEther("5"), driftTicks: 2, maxTicks: MAX_TICKS, target: cfg.target,
    });
    const large = await runLens(c.publicClient, cfg.cookAddress, poolConfig, {
      tokenIn, tokenOut, zeroForOne, amountIn, driftTicks: 2, maxTicks: MAX_TICKS, target: cfg.target,
    });

    const smallV3 = small.pools.filter((p) => p.poolType === SwapPoolType.UniV3);
    const largeV3 = large.pools.filter((p) => p.poolType === SwapPoolType.UniV3);

    // A larger trade reads at least as many forward ticks, and strictly more on
    // the medium pool (which the deeper trade pushes further).
    let sawMore = false;
    for (let i = 0; i < largeV3.length; i++) {
      assert.ok(
        largeV3[i].scannedForward >= smallV3[i].scannedForward,
        `fee ${largeV3[i].fee}: large scans >= small (${largeV3[i].scannedForward} vs ${smallV3[i].scannedForward})`,
      );
      if (largeV3[i].scannedForward > smallV3[i].scannedForward) sawMore = true;
    }
    assert.ok(sawMore, "a LARGE swap reads strictly more forward ticks on some pool");

    // Crossed a real initialized boundary on at least one pool, net matches direct.
    let crossedInit = false;
    for (const p of largeV3) {
      const pool = v3PoolByFee.get(p.fee)!;
      for (const [tickIdx, net] of p.net) {
        const direct = await getTickLiquidityNet(c.publicClient, pool, tickIdx);
        assert.equal(net, direct.liquidityNet, `fee ${p.fee} net@${tickIdx}`);
        if (direct.initialized && net !== 0n) crossedInit = true;
      }
    }
    assert.ok(crossedInit, "LARGE swap crossed at least one initialized boundary with matching net");

    // Drift on BOTH sides: forward ticks go in the swap direction; the lens also
    // emits reverse-drift rows on the OPPOSITE side of spot (uninitialized → not in
    // the net map, but present in scannedTickIndices). Confirm the full scanned set
    // straddles spot for every survivor: at least one tick on each side of base.
    void forwardTicks;
    let bothSides = false;
    for (const p of largeV3) {
      const base = Math.floor(p.tick / p.tickSpacing) * p.tickSpacing;
      const above = p.scannedTickIndices.some((t) => t > base);
      const below = p.scannedTickIndices.some((t) => t <= base);
      // forward (zeroForOne) is downward (<= base); reverse drift is upward (> base).
      if (above && below) bothSides = true;
    }
    assert.ok(bothSides, "lens reads ticks on BOTH sides of spot (forward + reverse drift)");

    console.log(
      `  [LARGE] scannedForward: ${largeV3.map((p) => `${p.fee}=${p.scannedForward}`).join(" ")} ` +
        `(small ${smallV3.map((p) => `${p.fee}=${p.scannedForward}`).join(" ")})`,
    );
  });

  it("dust pool (below the relative-depth filter) is DROPPED by the lens", async () => {
    // A third, tiny V3 pool well below 1% of total liquidity. With minRelBps=100
    // the lens is the single source of truth and must NOT emit it at all — it is
    // discovered (counted in the header) but not a survivor (no pool row).
    const minter = c.account0;
    const dustFee = 10000;
    const dustPool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, dustFee, SQRT_PRICE_1_1,
    );
    // L tiny vs the 400k/250k/300k pools → below 1% of Σliquidity → dropped.
    await mintPosition(c.walletClient, c.publicClient, stack.helper, dustPool, minter, -12000, 12000, parseEther("0.05"));

    const dustConfig: ChainPoolConfig = {
      ...poolConfig,
      feeTiers: [500, 3000, 10000],
    };
    const cfg = lensCfg();
    const res = await runLens(c.publicClient, cfg.cookAddress, dustConfig, {
      tokenIn, tokenOut, zeroForOne, amountIn: parseEther("3000"),
      driftTicks: 2, minRelBps: 100, maxTicks: MAX_TICKS, target: cfg.target,
    });
    const { pools } = res;

    // SURVIVORS ONLY: the dust pool is NOT emitted as a pool row.
    const dust = pools.find((p) => p.poolType === SwapPoolType.UniV3 && p.fee === dustFee);
    assert.equal(dust, undefined, "dust pool dropped by the lens (no pool row)");

    // Header reflects the drop: discovered counts the dust pool, survivors don't.
    assert.ok(res.discoveredCount > res.survivorCount, "header: discovered > survivors");
    assert.equal(res.survivorCount, pools.length, "header survivorCount == returned rows");
    assert.equal(
      res.discoveredCount - res.survivorCount, 1,
      "exactly one pool (the dust pool) dropped",
    );
    assert.ok(res.capacityFloor > 0n, "in-range-capacity floor applied (> 0)");

    // Deep pools survive and are still scanned.
    const deep = pools.filter((p) => p.poolType === SwapPoolType.UniV3);
    assert.equal(deep.length, 2, "both deep V3 pools survive");
    assert.ok(deep.every((p) => p.scannedForward > 0), "deep V3 pools still scanned");
    console.log(
      `  [DUST] dropped fee ${dustFee}; discovered=${res.discoveredCount} survivors=${res.survivorCount} ` +
        `floor=${res.capacityFloor}; deep ${deep.map((p) => `${p.fee}=${p.scannedForward}`).join(" ")}`,
    );
  });

  it("prepare (lazy-lens-driven) brackets reproduce the reference oracle split", async () => {
    const amountIn = parseEther("3000");
    const cfg = lensCfg();
    // prepare()'s lens always cooks on v1 internally; this checks `prepared` only
    // (engine-agnostic). Thread the engine for solver-compile consistency.
    const { prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cfg.sauceRouter, c.account0, poolConfig,
      undefined, cfg.target,
    );

    assert.equal(prepared.pools.filter((p) => !p.isV2).length, 2, "2 V3 pools prepared");
    assert.equal(prepared.pools.filter((p) => p.isV2).length, 1, "1 V2 pool prepared");
    // Unified-walk shape: direct pools ship NO prepare-time sqrt brackets (brackets holds
    // ROUTE segments only, empty here). The lazy lens reads instead populate each V3 pool's
    // per-pool net cache — a scanned window (windowTopShifted > 0) is the "cache populated"
    // signal independent of whether any initialized tick fell inside it (wide single positions
    // scan a window with 0 interior rows, served net 0 from the cache, no staticcall).
    const cacheWindowed = prepared.pools.filter(
      (p) => !p.isV2 && (p.windowTopShifted ?? 0n) > 0n,
    ).length;
    assert.ok(cacheWindowed > 0, "per-pool net cache built from lazy lens reads");
    assert.equal(prepared.routes.length, 0, "no routes");

    const ref = ecoSwapReference(prepared, amountIn);
    assert.ok(ref.totalInput > 0n, "oracle allocates input");
    const filled = ref.perPoolInput.filter((x) => x > 0n).length;
    assert.ok(filled >= 2, `oracle splits across >=2 pools (filled ${filled})`);
    assert.ok(ref.totalInput <= amountIn, "oracle total <= amountIn");
    assert.ok(ref.totalInput * 2n >= amountIn, "oracle places a meaningful share of amountIn");

    console.log(
      `  [LAZY-PREP] ${cacheWindowed} cache-windowed pools, oracle split ` +
        `${ref.perPoolInput.map((v, i) => `${prepared.pools[i].feePpm}=${v}`).join(" ")} cut=${ref.cutSqrtAdj}`,
    );
  });

  it("IN-RANGE capacity filter drops a narrow high-spot-L pool a spot-L filter would keep", async () => {
    // The filter now keys on IN-RANGE (windowed) capacity, not spot active-L. Build
    // two pools on FRESH tokens (clean fee namespace, independent of the shared pools):
    //   - DEEP pool (fee 3000): moderate L over a WIDE [-12000,12000] range. Its L
    //     persists across the whole crossed window → large in-range capacity. As the
    //     deepest IN-RANGE pool (shallowest solo-excursion to amountIn) it also bounds
    //     floorAdj — MEASURE A derives that by measuring, NOT from spot-L.
    //   - NARROW pool (fee 500): a LARGE L packed into a single tickSpacing band
    //     [-10,10] right at spot and NOTHING else. Spot liquidity() is large (a spot-L
    //     filter keeps it), but the trade walks straight out of the band → past it L=0
    //     → tiny in-range capacity → the in-range filter DROPS it.
    const minter = c.account0;
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    const tIn = tk.token0;
    const tOut = tk.token1;
    const z = BigInt(tIn) < BigInt(tOut);
    await mint(c.walletClient, c.publicClient, tIn, minter, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tOut, minter, parseEther("50000000"));
    await approve(c.walletClient, c.publicClient, tIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tOut, stack.helper, HUGE);

    const DEEP_L = parseEther("800000");
    const NARROW_L = parseEther("400000");
    const deepPool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tIn, tOut, 3000, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, deepPool, minter, -12000, 12000, DEEP_L);
    const narrowPool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tIn, tOut, 500, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, narrowPool, minter, -10, 10, NARROW_L);

    const cfg: ChainPoolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [500, 3000],
      baseTokens: [tIn, tOut],
    };

    // A trade big enough to walk WELL past the narrow ±10 band (so its capacity is
    // exhausted) yet inside the deep pool's reach so floorAdj is bounded (> 0).
    const amountIn = parseEther("100000");

    // Spot-L sanity: the NARROW pool's spot active-L exceeds what a 1%-of-Σspot-L
    // floor would be — i.e. a pure spot-L filter WOULD KEEP it.
    const deepSpotL = await getLiquidity(c.publicClient, deepPool);
    const narrowSpotL = await getLiquidity(c.publicClient, narrowPool);
    const spotLFloorWouldBe = ((deepSpotL + narrowSpotL) * 100n) / 10000n; // 1% of Σ spot-L
    assert.ok(
      narrowSpotL > spotLFloorWouldBe,
      `narrow spot-L ${narrowSpotL} exceeds the would-be spot-L floor ${spotLFloorWouldBe} (a spot-L filter keeps it)`,
    );

    const eng = lensCfg();
    const res = await runLens(c.publicClient, eng.cookAddress, cfg, {
      tokenIn: tIn, tokenOut: tOut, zeroForOne: z, amountIn, driftTicks: 2, minRelBps: 100, maxTicks: MAX_TICKS, target: eng.target,
    });

    // Both pools are discovered; only the DEEP pool survives the in-range filter.
    assert.equal(res.discoveredCount, 2, "both pools discovered");
    assert.equal(res.discoveredCount - res.survivorCount, 1, "exactly one pool dropped");
    const survFees = res.pools.map((p) => p.fee).sort((a, b) => a - b);
    assert.deepEqual(survFees, [3000], "only the DEEP (fee 3000) pool survives");
    const narrow = res.pools.find((p) => p.fee === 500);
    assert.equal(narrow, undefined, "narrow high-spot-L pool dropped by the in-range filter");
    assert.ok(res.capacityFloor > 0n, "in-range-capacity floor applied (floorAdj bounded)");

    console.log(
      `  [IN-RANGE] spot-L deep=${deepSpotL} narrow=${narrowSpotL} (spot-L floor would be ${spotLFloorWouldBe}); ` +
        `in-range Σcap=${res.totalInRangeCapacity} capFloor=${res.capacityFloor}; survivors fees ${survFees.join(",")}`,
    );
  });

  // ── v1 ↔ v12 PARITY: the lens is v12-native; the cook returns the SAME survivors +
  // header on BOTH engines. Cooks the IDENTICAL lens program on the v1 SauceRouter and
  // the V12Pot (target-gated compile + return decode) against the shared pools, and
  // asserts the decoded LensResult is bit-for-bit identical. This is the load-bearing
  // "v12-native lens == v1" gate (and exercises the v12 cook path end-to-end). ──
  it("decodes IDENTICAL survivors + header on v1 and v12 (lens is engine-agnostic)", async () => {
    if (!v12) {
      console.log("  [PARITY] v12 stack unavailable (artifacts absent) — skipping");
      return;
    }
    const amountIn = parseEther("200000");
    const common = { tokenIn, tokenOut, zeroForOne, amountIn, driftTicks: 2, minRelBps: 100, maxTicks: MAX_TICKS };
    // v1: cook on the SauceRouter (open cook, sentinel account). v12: cook on the owner's
    // V12Pot (owner-gated → simulate from the Pot owner = c.account0).
    const v1res = await runLens(c.publicClient, stack.sauceRouter, poolConfig, { ...common, target: "v1" });
    const v12res = await runLens(c.publicClient, cookTarget("v12", stack, v12), poolConfig, {
      ...common, target: "v12", account: c.account0,
    });

    // Canonical, field-by-field serialization of the decoded result (incl. per-pool net maps).
    const sig = (r: LensResult): string =>
      JSON.stringify({
        discoveredCount: r.discoveredCount,
        survivorCount: r.survivorCount,
        totalInRangeCapacity: r.totalInRangeCapacity.toString(),
        capacityFloor: r.capacityFloor.toString(),
        pools: r.pools.map((p) => ({
          poolType: p.poolType,
          address: p.address.toLowerCase(),
          fee: p.fee,
          tickSpacing: p.tickSpacing,
          sqrtPriceX96: p.sqrtPriceX96.toString(),
          liquidity: p.liquidity.toString(),
          tick: p.tick,
          scannedForward: p.scannedForward,
          scannedReverse: p.scannedReverse,
          net: [...p.net.entries()].map(([k, v]) => `${k}:${v}`).sort().join("|"),
        })),
      });

    assert.equal(sig(v12res), sig(v1res), "v12 lens decode IDENTICAL to v1 (survivors + header + tick nets)");
    assert.ok(v1res.survivorCount > 0, "the lens found at least one survivor (parity is non-trivial)");
    console.log(
      `  [PARITY] v1==v12: discovered=${v1res.discoveredCount} survivors=${v1res.survivorCount} ` +
        `Σcap=${v1res.totalInRangeCapacity} (cooked the lens on the SauceRouter AND the V12Pot)`,
    );
  });
});
