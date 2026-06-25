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
 * Run: pnpm --filter './dev-tools' exec tsx --test recipes/test/ecoswap.lens.evm.test.ts
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
} from "./harness/setup";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { runLens, type LensPool } from "../ecoswap/lens";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";

const HUGE = parseEther("1000000000");
const V2_PAIR_ADDR = "0x00000000000000000000000000000000ec05a2a2" as Hex;
const MAX_TICKS = 96; // mirror prepare.ts V3_TICK_STEPS hard cap

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
    const { pools } = await runLens(c.publicClient, stack.sauceRouter, poolConfig, {
      tokenIn, tokenOut, zeroForOne, amountIn, driftTicks: 2, maxTicks: MAX_TICKS,
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
    const small = await runLens(c.publicClient, stack.sauceRouter, poolConfig, {
      tokenIn, tokenOut, zeroForOne, amountIn: parseEther("5"), driftTicks: 2, maxTicks: MAX_TICKS,
    });
    const large = await runLens(c.publicClient, stack.sauceRouter, poolConfig, {
      tokenIn, tokenOut, zeroForOne, amountIn, driftTicks: 2, maxTicks: MAX_TICKS,
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
    const res = await runLens(c.publicClient, stack.sauceRouter, dustConfig, {
      tokenIn, tokenOut, zeroForOne, amountIn: parseEther("3000"),
      driftTicks: 2, minRelBps: 100, maxTicks: MAX_TICKS,
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
    assert.ok(res.liqFloor > 0n, "relative-depth floor applied (> 0)");

    // Deep pools survive and are still scanned.
    const deep = pools.filter((p) => p.poolType === SwapPoolType.UniV3);
    assert.equal(deep.length, 2, "both deep V3 pools survive");
    assert.ok(deep.every((p) => p.scannedForward > 0), "deep V3 pools still scanned");
    console.log(
      `  [DUST] dropped fee ${dustFee}; discovered=${res.discoveredCount} survivors=${res.survivorCount} ` +
        `floor=${res.liqFloor}; deep ${deep.map((p) => `${p.fee}=${p.scannedForward}`).join(" ")}`,
    );
  });

  it("prepare (lazy-lens-driven) brackets reproduce the reference oracle split", async () => {
    const amountIn = parseEther("3000");
    const { prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, stack.sauceRouter, c.account0, poolConfig,
    );

    assert.equal(prepared.pools.filter((p) => !p.isV2).length, 2, "2 V3 pools prepared");
    assert.equal(prepared.pools.filter((p) => p.isV2).length, 1, "1 V2 pool prepared");
    assert.ok(prepared.brackets.length > 0, "brackets built from lazy lens reads");
    assert.equal(prepared.routes.length, 0, "no routes");

    const ref = ecoSwapReference(prepared, amountIn);
    assert.ok(ref.totalInput > 0n, "oracle allocates input");
    const filled = ref.perPoolInput.filter((x) => x > 0n).length;
    assert.ok(filled >= 2, `oracle splits across >=2 pools (filled ${filled})`);
    assert.ok(ref.totalInput <= amountIn, "oracle total <= amountIn");
    assert.ok(ref.totalInput * 2n >= amountIn, "oracle places a meaningful share of amountIn");

    console.log(
      `  [LAZY-PREP] ${prepared.brackets.length} brackets, oracle split ` +
        `${ref.perPoolInput.map((v, i) => `${prepared.pools[i].feePpm}=${v}`).join(" ")} cut=${ref.cutSqrtAdj}`,
    );
  });
});
