/**
 * EcoSwap REVERSE-DRIFT consumption — local EVM, NO fork.
 *
 * Proves the lens's reverse-side ticks are CONSUMED by buildV3Brackets: if a
 * pool's live price drifts AGAINST the swap between prepare() and execution, the
 * recipe must still re-anchor that pool to the common cut — which requires
 * brackets covering the region ABOVE the prepare-time spot (the reverse region).
 *
 * Method (snapshot/revert differential against the SAME compiled bytecode):
 *   1. prepare()+compile() at spot (bytecode embeds the spot brackets, incl. the
 *      capacity-0 reverse brackets above spot).
 *   2. Run A (no drift): cook() → the deep pool's tokenIn intake B, medium pool medA.
 *   3. evm_revert to the clean snapshot.
 *   4. Run B (reverse drift): push the deep pool's price AGAINST the swap by a few
 *      ticks (a real swap through the engine — within the reverse coverage), then
 *      cook() the SAME bytecode → deep intake D, medium medB. Record the tokenIn the
 *      pool paid OUT during the drift (driftOut).
 *   5. Assertions:
 *      - PRIMARY  D > B: the recipe filled the EXTRA reverse gap. Without reverse-
 *        bracket consumption Phase B clamps at the stale spot → D == B.
 *      - CONSERVATION  D - B == driftOut: the pool ends both runs at the SAME cut
 *        price, so its net tokenIn intake is identical (run A: +B; run B: -driftOut
 *        +D) ⇒ the recipe re-added EXACTLY the drifted-out reverse region. (This is
 *        the rigorous re-anchoring check; a loose marginal-spread bound is dominated
 *        by the inter-pool fee difference and proves nothing.)
 *      - ADAPTATION  medB < medA: the deep pool's extra fill comes out of the
 *        medium pool's share (fixed budget, deep processed first).
 *
 * Both swap directions are exercised (zeroForOne and oneForZero — the latter walks
 * the mirror reverse boundary sequence base.. / L -= net).
 *
 * Run: pnpm --filter './sdk' exec tsx --test src/recipes/test/ecoswap.reverse-drift.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import { driftPoolPrice } from "./harness/drift";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  createAndInitPool,
  mint,
  approve,
  balanceOf,
  mintPosition,
  getSlot0,
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
import { ecoSwap } from "../ecoswap/index";
import type { Account } from "viem";

const HUGE = parseEther("1000000000");

// Engine cells driven by ECO_ENGINE (default v12). See harness/engine.ts.
const ENGINE_CELLS = engineCells();

// tickSpacing 10 ⇒ reverse coverage = SAFETY_TICKS(2)*10 = 20 ticks past spot.
const DEEP_FEE = 500;
const MEDIUM_FEE = 3000;
const TS = 10;

// Exercise BOTH swap directions. inIsToken0=true → zeroForOne (swap pushes price
// DOWN, reverse = UP); false → oneForZero (swap UP, reverse = DOWN, mirror walk).
for (const dir of [
  { name: "zeroForOne", inIsToken0: true },
  { name: "oneForZero", inIsToken0: false },
] as const) {
  describe(`EcoSwap reverse-drift re-anchoring (${dir.name})`, () => {
    let anvil: AnvilHandle;
    let c: HarnessClients;
    let stack: DeployedStack;
    let v12: DeployedV12Stack | null = null;
    let tokenIn: Hex;
    let tokenOut: Hex;
    let poolConfig: ChainPoolConfig;
    let cleanSnapshot: Hex;
    const poolByFee = new Map<number, Hex>();

    before(async () => {
      anvil = await startAnvil();
      c = await makeClients(anvil.rpcUrl);
      await ensureMulticall3(c.publicClient, c.testClient);
      stack = await deployStack(c.walletClient, c.publicClient);
      const tk = await deploySortedTokens(c.walletClient, c.publicClient);
      // inIsToken0 picks the swap direction: token0-in ⇒ zeroForOne.
      tokenIn = dir.inIsToken0 ? tk.token0 : tk.token1;
      tokenOut = dir.inIsToken0 ? tk.token1 : tk.token0;

      const minter = c.account0;
      await mint(c.walletClient, c.publicClient, tk.token0, minter, parseEther("50000000"));
      await mint(c.walletClient, c.publicClient, tk.token1, minter, parseEther("50000000"));
      await approve(c.walletClient, c.publicClient, tk.token0, stack.helper, HUGE);
      await approve(c.walletClient, c.publicClient, tk.token1, stack.helper, HUGE);

      // Two wide V3 pools at 1:1; the deep (fee 500) pool is pools[0] in the prepared
      // order (liquidity-desc) → processed FIRST in Phase B, so its full reverse-
      // extended ask lands before the fixed budget can starve it.
      for (const [fee, L] of [
        [DEEP_FEE, parseEther("400000")],
        [MEDIUM_FEE, parseEther("250000")],
      ] as [number, bigint][]) {
        const pool = await createAndInitPool(
          c.walletClient, c.publicClient, stack.factory, tk.token0, tk.token1, fee, SQRT_PRICE_1_1,
        );
        await mintPosition(c.walletClient, c.publicClient, stack.helper, pool, minter, -12000, 12000, L);
        poolByFee.set(fee, pool);
      }

      poolConfig = {
        factories: [
          { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
        ],
        feeTiers: [DEEP_FEE, MEDIUM_FEE],
        baseTokens: [tk.token0, tk.token1],
      };

      // Fund the caller up front so balances survive evm_revert across cells.
      await mint(c.walletClient, c.publicClient, tokenIn, c.account0, parseEther("100000"));
      await mint(c.walletClient, c.publicClient, tokenOut, c.account0, parseEther("100000"));

      // v12 stack (same anvil/pools) when a v12 cell runs; approve the Pot for tokenIn.
      v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
      if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

      cleanSnapshot = await c.testClient.snapshot();
    });

    after(() => anvil?.stop());

    // Revert to the clean post-setup state so each engine cell prepares + cooks
    // against IDENTICAL fresh pools (cells share one anvil).
    async function resetPools(): Promise<void> {
      await c.testClient.revert({ id: cleanSnapshot });
      cleanSnapshot = await c.testClient.snapshot();
    }

    async function runReverseDrift(engine: Engine): Promise<void> {
      await resetPools();
      const target = cookTarget(engine, stack, v12);
      const amountIn = parseEther("3000");
      const caller = c.account0;
      const deepPool = poolByFee.get(DEEP_FEE)!;
      const medPool = poolByFee.get(MEDIUM_FEE)!;

      // Prepare+compile ONCE at spot for this engine. Both runs execute this bytecode.
      const { bytecodes, prepared } = await ecoSwap(
        { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12),
        caller, poolConfig, undefined, engine,
      );
      assert.equal(prepared.pools.length, 2, "two V3 pools prepared");
      assert.equal(prepared.pools[0].feePpm, DEEP_FEE, "deepest (fee 500) pool is processed first");
      // WS2: against-swap drift is now handled by the on-chain LIVE PRE-FILL (it reads
      // the live tick and water-fills the gap above the prepared window), NOT by prepared
      // capacity-0 reverse brackets — prepare no longer emits any. Assert they're GONE,
      // and that the deep pool carries the pre-fill seeds (topNearReal + a window) the
      // pre-fill needs to fire.
      assert.equal(
        prepared.brackets.filter((b) => b.capacity === 0n).length, 0,
        "no capacity-0 reverse brackets (WS2 reads against-swap drift live)",
      );
      assert.ok(prepared.pools[0].topNearReal > 0n, "deep pool carries the pre-fill stop target (topNearReal)");
      assert.ok(prepared.pools[0].bracketCount > 0, "deep pool has a prepared window → pre-fill can fire");

      const snap = await c.testClient.snapshot();

      // ── Run A: no drift ──
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const deepInBeforeA = await balanceOf(c.publicClient, tokenIn, deepPool);
      const medInBeforeA = await balanceOf(c.publicClient, tokenIn, medPool);
      const resA = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(resA.receipt.status, "success", "no-drift cook() succeeds");
      const B = (await balanceOf(c.publicClient, tokenIn, deepPool)) - deepInBeforeA;
      const medA = (await balanceOf(c.publicClient, tokenIn, medPool)) - medInBeforeA;
      assert.ok(B > 0n && medA > 0n, "both pools fill in the no-drift run");

      // ── Reset, then drift the deep pool's price AGAINST the swap ──
      await c.testClient.revert({ id: snap });
      assert.equal((await getSlot0(c.publicClient, deepPool)).tick, 0, "deep pool back at spot after revert");

      // Reverse of the swap: swap tokenOut->tokenIn (driftZeroForOne = tokenOut<tokenIn
      // holds for BOTH recipe directions). Small enough to stay within reverse coverage.
      const deepInPreDrift = await balanceOf(c.publicClient, tokenIn, deepPool);
      await driftPoolPrice(
        c, stack.sauceRouter, prepared.pools[0], tokenOut, tokenIn,
        BigInt(tokenOut) < BigInt(tokenIn), parseEther("200"), caller,
      );
      const driftedTick = (await getSlot0(c.publicClient, deepPool)).tick;
      // zeroForOne reverse pushes tick UP; oneForZero reverse pushes it DOWN.
      assert.ok(
        dir.inIsToken0 ? driftedTick > 0 : driftedTick < 0,
        `reverse drift moved the price against the swap (tick ${driftedTick})`,
      );
      assert.ok(Math.abs(driftedTick) <= 2 * TS, `drift within reverse coverage (|tick| ${Math.abs(driftedTick)} <= 20)`);
      // tokenIn the pool paid OUT during the drift — the recipe must re-add it to
      // restore the pool to the same cut price.
      const driftOut = deepInPreDrift - (await balanceOf(c.publicClient, tokenIn, deepPool));
      assert.ok(driftOut > 0n, "drift swap pulled tokenIn out of the deep pool");

      // ── Run B: same bytecode, against the reverse-drifted pool ──
      await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
      const deepInBeforeB = await balanceOf(c.publicClient, tokenIn, deepPool); // AFTER the drift swap
      const medInBeforeB = await balanceOf(c.publicClient, tokenIn, medPool);
      const resB = await cook(c.walletClient, c.publicClient, target, bytecodes);
      assert.equal(resB.receipt.status, "success", "reverse-drift cook() succeeds");
      const D = (await balanceOf(c.publicClient, tokenIn, deepPool)) - deepInBeforeB;
      const medB = (await balanceOf(c.publicClient, tokenIn, medPool)) - medInBeforeB;
      assert.ok(D > 0n, "deep pool receives input in the reverse-drift run");

      // PRIMARY — the LIVE pre-fill filled the against-swap-drift gap. Without it the
      // sweep would cap at the prepared spot near (hi=min(liveCur,near)=near=spot) and
      // never integrate the (topNearOI, liveCur] gap → D == B. D > B proves the pre-fill
      // read the live drifted-up tick and water-filled the gap before the sweep.
      assert.ok(D > B, `reverse-drifted deep pool fills MORE (D=${D} > B=${B})`);

      // CONSERVATION — the pool ends both runs at the SAME cut price, so its net
      // tokenIn intake matches: +B == -driftOut + D ⇒ D - B == driftOut. This pins
      // that the recipe re-added EXACTLY the drifted-out reverse region (to bracket
      // granularity). Without reverse brackets gap would be 0, failing this hard.
      const gap = D - B;
      const consErr = Number(gap > driftOut ? gap - driftOut : driftOut - gap) / Number(driftOut);
      assert.ok(
        consErr < 0.02,
        `D-B (${gap}) must equal the drift outflow (${driftOut}) — pre-fill re-anchoring (err ${consErr})`,
      );

      // ADAPTATION — the deep pool's extra fill comes out of the medium pool's share.
      assert.ok(medB < medA, `medium pool's share shrinks under reverse drift (medB=${medB} < medA=${medA})`);

      console.log(
        `  [REV-DRIFT ${dir.name} ${engine}] B=${B} D=${D} gap=${gap} driftOut=${driftOut} consErr=${consErr}\n` +
          `       drift moved deep tick 0 -> ${driftedTick}; medium ${medA} -> ${medB}`,
      );
    }

    for (const { engine, skip } of ENGINE_CELLS) {
      it(
        `a reverse-drifted deep pool fills MORE, conserving input, and the split adapts [${engine}]`,
        { skip },
        async () => {
          await runReverseDrift(engine);
        },
      );
    }
  });
}
