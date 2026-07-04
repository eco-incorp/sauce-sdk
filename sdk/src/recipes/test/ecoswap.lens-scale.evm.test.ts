/**
 * EcoSwap lens EMIT-scale regression — LOCAL EVM, NO fork.
 *
 * Pins the fix for the celo prepare MemoryOOG (found via the celo cUSD/USDC fork smoke,
 * ecoswap.chains.fork.test.ts): the lens EMIT pass used to append ONE 3-word tick row per
 * `tickBlob.concat(...)`. The engine's CONCAT allocates a fresh full-size buffer on a bump
 * allocator that never frees within a cook(), so R rows left ~48·R² bytes of dead memory,
 * and EVM memory-expansion pricing turned that into gas ∝ R⁴: ~830 total emitted rows
 * exhausted a 2e9-gas eth_call as a deterministic MemoryOOG. Real trigger: an edge pair
 * carrying several ts=1 (fee<=100) pools, each walking its full 256-boundary price band
 * because NO pool solo-covers amountIn (floorAdj=0 disables early-stop) — celo's
 * CELO/stable edges emit ~1088 rows ⇒ prepare's route-edge lens read (readEdge → runLens)
 * dies before the solver is ever compiled.
 *
 * The fix chunks the emit (rows → per-pool blob → tickBlob; identical bytes, O(rows)
 * allocation). This test reconstructs the minimal-repro shape LOCALLY: 4 ts=1 V3 pools
 * (2 factories × fee tiers {50,100}, both mapping to tickSpacing 1) with dust liquidity
 * and an amountIn no pool can solo-cover, so at the production-default maxTicks/bandTicks
 * (256/256) every pool walks its FULL 256-boundary band and the lens emits
 * 4×(256 fwd + 2 rev) = 1032 rows — ABOVE the ~830-row pre-fix OOG threshold. Pre-fix
 * this cook needs ≈5e9 gas and reverts MemoryOOG at the 2e9 eth_call cap; post-fix it
 * runs in well under 1e9.
 *
 * Engine cells follow ECO_ENGINE (default v12; "both" = v1 + v12). The failure was
 * characterized on v1 (the Solidity Data.sol _concatBytes allocator), but the chunked
 * emit is engine-agnostic — both cells assert completion + decode fidelity + gas headroom.
 *
 * Run: pnpm --filter './sdk' exec tsx --test src/recipes/test/ecoswap.lens-scale.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Abi, type Account, type Hex } from "viem";

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
  v3FactoryArtifact,
  v3FactoryAbi,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { deployContract, writeAndWait } from "./harness/deploy";
import { engineCells, maybeDeployV12Stack, cookTarget, type Engine } from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { runLens, measureLensGas, LENS_MAX_TICKS } from "../ecoswap/lens";

const HUGE = parseEther("1000000000");
/** Pre-fix, ~830 emitted rows OOG'd a 2e9-gas cook; this fixture emits 1032. */
const PREFIX_OOG_ROW_THRESHOLD = 832;
/** ts=1 fee tiers (TICK_SPACING_BY_FEE: 50→1, 100→1) — the tight-band tiers that scale rows. */
const TS1_FEES = [50, 100] as const;
const DRIFT_TICKS = 2;

describe("EcoSwap lens EMIT at the OOG threshold scale (chunked-concat regression)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let poolConfig: ChainPoolConfig;
  /** pool address (lowercase) → the position liquidity minted at [-200, 200]. */
  const poolL = new Map<string, bigint>();

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    // Second REAL Uniswap V3 factory: 2 factories × 2 ts=1 tiers = 4 ts=1 pools — the
    // multiple-tight-band-pools-per-pair shape of celo's CELO/stable edges.
    const factoryB = (await deployContract(c.walletClient, c.publicClient, {
      abi: v3FactoryArtifact.abi,
      bytecode: v3FactoryArtifact.bytecode,
    })) as Hex;

    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("50000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // The canonical factory only enables 500/3000/10000 — enable the ts=1 tiers
    // (owner = deployer) on BOTH factories, then create + init 4 pools at 1:1 with a
    // small [-200, 200] position each (distinct L per pool for the decode check).
    // L is dust vs amountIn, so NO pool solo-covers within its band ⇒ floorAdj=0 ⇒
    // early-stopping disabled ⇒ every pool walks its full 256-boundary band — the
    // exact shape that emitted ~1088 rows on the celo edges.
    let lSeed = 4n;
    for (const factory of [stack.factory, factoryB]) {
      for (const fee of TS1_FEES) {
        await writeAndWait(c.walletClient, c.publicClient, {
          address: factory,
          abi: v3FactoryAbi as Abi,
          functionName: "enableFeeAmount",
          args: [fee, 1],
        });
        const pool = await createAndInitPool(
          c.walletClient, c.publicClient, factory, tokenIn, tokenOut, fee, SQRT_PRICE_1_1,
        );
        const L = lSeed * 10n ** 18n;
        lSeed -= 1n;
        await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, -200, 200, L);
        poolL.set(pool.toLowerCase(), L);
      }
    }

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3 A", feeTiers: [...TS1_FEES] },
        { address: factoryB, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3 B", feeTiers: [...TS1_FEES] },
      ],
      feeTiers: [...TS1_FEES],
      baseTokens: [tokenIn, tokenOut],
    };

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
  });

  after(() => anvil?.stop());

  for (const { engine, skip } of engineCells()) {
    it(
      `lens completes a ${PREFIX_OOG_ROW_THRESHOLD}+-row emit in ONE eth_call [${engine}]`,
      { skip: skip ? "v12 artifacts unavailable" : false, timeout: 600_000 },
      async () => {
        const cookAddress = cookTarget(engine as Engine, stack, v12);
        const params = {
          tokenIn,
          tokenOut,
          zeroForOne: true, // tokenIn = token0 (sorted) — walk DOWN from tick 0
          // Dust pools (L ≤ 4e18 absorb ~5e16 over the band) can never solo-cover this,
          // so MEASURE A leaves floorAdj=0 → filter + early-stop disabled → full bands.
          amountIn: parseEther("1000000"),
          driftTicks: DRIFT_TICKS,
          minRelBps: 100, // production default — inert here (floorAdj=0 ⇒ capFloor=0)
          target: engine as Engine,
          account: engine === "v12" ? c.account0 : undefined,
        };

        // Pre-fix: this call burned the full 2e9 eth_call gas cap and reverted
        // "EVM error MemoryOOG" (quartic concat memory). Post-fix it completes.
        const res = await runLens(c.publicClient, cookAddress, poolConfig, params);

        assert.equal(res.discoveredCount, 4, "all 4 ts=1 pools alive");
        assert.equal(res.survivorCount, 4, "floorAdj=0 keeps every pool");
        assert.equal(res.capacityFloor, 0n, "no pool solo-covers ⇒ filter disabled (full-band walks)");

        let totalRows = 0;
        for (const p of res.pools) {
          assert.equal(p.tickSpacing, 1, `${p.address} is a ts=1 pool`);
          // Full production-default band: effTicks = clamp(256/1, 96, 256) = 256.
          assert.equal(p.scannedForward, LENS_MAX_TICKS, `${p.address} walked the full band`);
          assert.equal(p.scannedReverse, DRIFT_TICKS, `${p.address} reverse drift rows`);
          totalRows += p.scannedForward + p.scannedReverse;

          // Decode fidelity through the chunked emit: the walk (0 → -255) crosses the
          // position's lower tick at -200 (liquidityNet = +L), and the reverse drift
          // covers {+1, +2}. Spans + values must decode exactly as before the fix
          // (the chunking is an allocation-shape change — identical bytes).
          const L = poolL.get(p.address.toLowerCase());
          assert.ok(L !== undefined, `${p.address} is one of the 4 fixture pools`);
          assert.equal(p.net.get(-200), L, `${p.address} liquidityNet(+L) at the -200 boundary`);
          assert.equal(p.scannedTickIndices.length, LENS_MAX_TICKS + DRIFT_TICKS);
          assert.equal(Math.min(...p.scannedTickIndices), -255, "forward walk reached -255");
          assert.equal(Math.max(...p.scannedTickIndices), 2, "reverse drift reached +2");
        }
        assert.ok(
          totalRows >= PREFIX_OOG_ROW_THRESHOLD,
          `fixture emits ${totalRows} rows — at/above the pre-fix OOG threshold (${PREFIX_OOG_ROW_THRESHOLD})`,
        );

        // Gas headroom guard: the whole threshold-scale read must stay strictly under
        // the 2e9 eth_call cap (pre-fix the emit alone needed ≈5e9 → MemoryOOG). What
        // remains post-fix is LINEAR in rows: the ~3.1k per-boundary ticks() staticcalls
        // + interpreted walk math (measured ≈1.17e9 on the heavier v1 interpreter,
        // ≈0.3e9 on the v12 Huff runtime). A re-quadraticized emit (any per-row concat
        // against a whole-blob accumulator) blows these bounds immediately.
        const gasBound = engine === "v1" ? 1_600_000_000n : 1_000_000_000n;
        const gas = await measureLensGas(c.publicClient, cookAddress, poolConfig, params);
        assert.ok(
          gas < gasBound,
          `lens cook gas ${gas} < ${gasBound} (pre-fix: MemoryOOG above the 2e9 cap)`,
        );
        console.log(`  [${engine}] rows=${totalRows} survivors=${res.survivorCount} lensGas=${gas}`);
      },
    );
  }
});
