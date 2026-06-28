/**
 * EcoSwap MULTI-HOP ROUTE path — local EVM, NO fork.
 *
 * The route path (tokenIn -> base -> tokenOut, two V3 hops composed off-chain via
 * localQuote, executed as two flat swapV3 hops on-chain) was wired but never
 * EVM-tested. This boots anvil + the engine + a 3-token universe with NO direct
 * tokenIn/tokenOut pool but deep V3 hop pools (tokenIn/base and base/tokenOut),
 * then:
 *   1. asserts prepare() discovers exactly ONE route and ZERO direct pools, and
 *      cook() routes the trade through BOTH hops (each hop pool's tokenIn-side
 *      reserve moves), spending ~all of amountIn for tokenOut > 0;
 *   2. ROUTE FIDELITY — compares the off-chain route-segment-implied output (built
 *      from the prepared Route brackets, which now use each hop's REAL fee after
 *      dropping the feePpmOf=3000 heuristic) against a REAL two-hop swap of the
 *      same input routed through the engine. They must track closely — validating
 *      the whole route bracket pipeline (hop reconstruction + fee-correct
 *      composition) against ground truth.
 *
 * Hops use fee 500 (NOT the old 3000 fallback) so the explicit-hop-fee path is
 * exercised end-to-end.
 *
 * Run: pnpm --filter './sdk' exec tsx --test src/recipes/test/ecoswap.routes.evm.test.ts
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
  deployToken,
  createAndInitPool,
  mint,
  approve,
  balanceOf,
  mintPosition,
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
import { EcoBracketKind, type EcoPool, type PoolInfo } from "../shared/types";
import { ecoSwap } from "../ecoswap/index";
import type { Account } from "viem";

const HUGE = parseEther("1000000000");

// Engine cells driven by ECO_ENGINE (default v12). See harness/engine.ts.
const ENGINE_CELLS = engineCells();
const Q192 = 1n << 192n;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
const HOP_FEE = 500;

describe("EcoSwap multi-hop route (tokenIn -> base -> tokenOut, V3 hops)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let base: Hex;
  let tokenOut: Hex;
  let poolAB: Hex;
  let poolBC: Hex;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);

    // Three distinct tokens. Roles are fixed (in -> base -> out); the swap's
    // zeroForOne and the per-hop orientation are derived from address ordering by
    // prepare(), and swapV3 self-orients on execution — so addresses can be any.
    tokenIn = await deployToken(c.walletClient, c.publicClient, "In", "IN");
    base = await deployToken(c.walletClient, c.publicClient, "Base", "BASE");
    tokenOut = await deployToken(c.walletClient, c.publicClient, "Out", "OUT");

    const minter = c.account0;
    for (const t of [tokenIn, base, tokenOut]) {
      await mint(c.walletClient, c.publicClient, t, minter, parseEther("50000000"));
      await approve(c.walletClient, c.publicClient, t, stack.helper, HUGE);
    }

    // Deep hop pools at 1:1, fee 500. NO direct tokenIn/tokenOut pool.
    poolAB = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, base, HOP_FEE, SQRT_PRICE_1_1,
    );
    poolBC = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, base, tokenOut, HOP_FEE, SQRT_PRICE_1_1,
    );
    for (const pool of [poolAB, poolBC]) {
      await mintPosition(
        c.walletClient, c.publicClient, stack.helper, pool, minter, -12000, 12000, parseEther("400000"),
      );
    }

    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [HOP_FEE],
      baseTokens: [base], // the intermediate hop token
    };

    // v12 stack (same anvil/pools) when a v12 cell runs; caller is funded per-test
    // below, then approves the cook target there. Fund + approve the Pot up front so
    // the route cook can transferFrom(caller, self=Pot, …).
    const minterAcct = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minterAcct, parseEther("100000"));
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => anvil?.stop());

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
  }

  /** Minimal EcoPool around a discovered V3 hop pool, for the drift harness's real swap. */
  function hopEco(p: PoolInfo): EcoPool {
    return {
      poolType: SwapPoolType.UniV3,
      address: p.address,
      fee: p.fee,
      tickSpacing: p.tickSpacing ?? 10,
      hooks: ZERO,
      feePpm: p.fee,
      isV2: false,
      inIsToken0: false,
      stateView: ZERO,
      poolId: ZERO32,
      source: "route-test",
    };
  }

  /** Off-chain output the prepared Route segments imply for `input` (walk best-rate first). */
  function routeImpliedOut(prepared: Awaited<ReturnType<typeof ecoSwap>>["prepared"], input: bigint): bigint {
    let budget = input;
    let out = 0n;
    for (const b of prepared.brackets) {
      if (b.kind !== EcoBracketKind.Route || b.refIdx !== 0) continue;
      if (budget <= 0n) break;
      const take = budget >= b.capacity ? b.capacity : budget;
      // segment models a constant rate: dOut = sqrtAdj^2 * dIn / 2^192.
      out += (b.sqrtAdjNear * b.sqrtAdjNear * take) / Q192;
      budget -= take;
    }
    return out;
  }

  async function runRoute(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const amountIn = parseEther("2000");
    const caller = c.account0;

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(engine, stack, v12),
      caller, poolConfig, undefined, engine,
    );

    assert.equal(prepared.pools.length, 0, "no direct tokenIn/tokenOut pool exists");
    assert.equal(prepared.routes.length, 1, "exactly one route discovered (through base)");
    assert.equal(
      prepared.routes[0].route.intermediateToken.toLowerCase(), base.toLowerCase(),
      "route intermediate is the base token",
    );
    assert.equal(prepared.routes[0].route.hop1Pool.fee, HOP_FEE, "hop1 carries the real fee (not 3000)");
    assert.equal(prepared.routes[0].route.hop2Pool.fee, HOP_FEE, "hop2 carries the real fee (not 3000)");
    assert.ok(
      prepared.brackets.some((b) => b.kind === EcoBracketKind.Route),
      "ladder carries Route segments",
    );

    const abInBefore = await balanceOf(c.publicClient, tokenIn, poolAB);
    const bcInBefore = await balanceOf(c.publicClient, base, poolBC);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "route cook() must succeed");

    const abInDelta = (await balanceOf(c.publicClient, tokenIn, poolAB)) - abInBefore;
    const bcInDelta = (await balanceOf(c.publicClient, base, poolBC)) - bcInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;

    assert.ok(abInDelta > 0n, "hop1 pool (tokenIn/base) received tokenIn");
    assert.ok(bcInDelta > 0n, "hop2 pool (base/tokenOut) received base (mid token)");
    assert.ok(received > 0n, "caller received tokenOut through the route");
    const leftover = amountIn - spent;
    assert.ok(leftover * 100n <= amountIn, `route spends ~all amountIn (leftover ${leftover})`);

    console.log(
      `  [ROUTE ${engine}] spent=${spent} received=${received} leftover=${leftover}\n` +
        `       hop1 tokenIn in=${abInDelta}  hop2 base in=${bcInDelta}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`discovers ONE route, ZERO direct pools, and routes through BOTH hops [${engine}]`, { skip }, async () => {
      await runRoute(engine);
    });
  }

  it("route-segment-implied output tracks a real two-hop swap (fee-correct composition)", async () => {
    const amountIn = parseEther("1500");
    const caller = c.account0;

    const { prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, stack.sauceRouter, caller, poolConfig,
    );
    const impliedOut = routeImpliedOut(prepared, amountIn);
    assert.ok(impliedOut > 0n, "route segments imply a positive output");

    const hop1 = hopEco(prepared.routes[0].route.hop1Pool);
    const hop2 = hopEco(prepared.routes[0].route.hop2Pool);
    const z1 = BigInt(tokenIn) < BigInt(base);
    const z2 = BigInt(base) < BigInt(tokenOut);

    // Real two-hop on a snapshot we revert (it moves both hop prices).
    const snap = await c.testClient.snapshot();

    const midBefore = await balanceOf(c.publicClient, base, caller);
    await driftPoolPrice(c, stack.sauceRouter, hop1, tokenIn, base, z1, amountIn, caller);
    const midOut = (await balanceOf(c.publicClient, base, caller)) - midBefore;
    assert.ok(midOut > 0n, "real hop1 produced the mid token");

    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    await driftPoolPrice(c, stack.sauceRouter, hop2, base, tokenOut, z2, midOut, caller);
    const realOut = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    assert.ok(realOut > 0n, "real hop2 produced tokenOut");

    await c.testClient.revert({ id: snap });

    // With the correct per-hop fee, the off-chain route model reproduces the real
    // two-hop swap to TRUNCATION (~1e-20 rel here: deep single-range hops, no tick
    // crossings → localQuote walks the exact V3 hyperbola). The bound is set well
    // below any fee-skew but far above that truncation floor: the old feePpmOf=3000
    // fallback on a 500 pool biases localQuote's partial-fill term enough to push
    // rel to ~3e-4 — orders of magnitude above this 1e-6 bound — so this assertion
    // fails on the pre-fix fee while passing on the real one. (The per-hop fee is
    // ALSO pinned directly by the hop1Pool.fee/hop2Pool.fee === HOP_FEE asserts in
    // the first test; this one validates the full bracket→composition pipeline.)
    const hi = impliedOut > realOut ? impliedOut : realOut;
    const lo = impliedOut > realOut ? realOut : impliedOut;
    const rel = Number(hi - lo) / Number(hi);
    assert.ok(rel < 1e-6, `route-implied output tracks real two-hop (implied ${impliedOut} vs real ${realOut}, rel ${rel})`);

    console.log(
      `  [ROUTE-FIDELITY] implied=${impliedOut} real2hop=${realOut} rel=${rel} (mid=${midOut})`,
    );
  });
});
