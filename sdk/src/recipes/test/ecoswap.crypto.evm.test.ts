/**
 * EcoSwap Curve CryptoSwap (twocrypto/tricrypto-ng volatile-asset) local-EVM integration — the
 * callback-free exact-in-dy gate.
 *
 * Stands up a local Curve CryptoSwap 2-coin pool (the CryptoSwapPool.sol fixture, whose tricrypto-ng
 * newton_D/newton_y A-gamma invariant + twocrypto-ng get_dy/_fee mirror the off-chain
 * `cryptoswap-math.ts` replay bit-for-bit), deploys the Sauce engine, and cooks an EcoSwap whose
 * static-segment cursor consumes CryptoSwap segments (segKind 9) and executes them CALLBACK-FREE: an
 * on-chain `pool.get_dy(i, j, awarded)` staticcall (for min_dy) + approve + `pool.exchange(i, j,
 * awarded, min_dy)`. Curve exchange PULLS the input via transferFrom (like Wombat), and CryptoSwap
 * pools use UINT256 coin indices (exchange(uint256,...)) — which the engine's int128 `_swapCurve`
 * does NOT match, so it MUST run callback-free, NOT through the engine. Then asserts:
 *
 *   (1) SOLO CryptoSwap venue — the on-chain dy the caller receives == off-chain getDyCrypto(awarded
 *       share) AND == the pool's own get_dy view to the WEI (the exact-in-dy gate: the pool view IS
 *       the swap math). NO tolerance.
 *   (2) TWO CryptoSwap venues — ONE EcoSwap splits across both; each leg's received output ==
 *       getDyCrypto(its awarded share) to the wei, and the post-fee marginals equalize within the
 *       sampled-grid bound (the documented exact-on-grid standard).
 *   (3) TREESHAKE regression cell — compiles the PRODUCTION treeshake define set (HAS_CRYPTO only, all
 *       other segment flags false) and cooks a REAL CryptoSwap fill: guards that HAS_CRYPTO was added
 *       to the segment-head price-merge guard + the accumulator branch + the exec block across the
 *       guard triple (else the segment head is dead under treeshake and the swap lands ZERO — the bug
 *       that bit Balancer). Mirrors ecoswap.maverick.evm.test.ts.
 *
 * The CryptoSwap math is OFF-CHAIN only for the SPLIT: the on-chain solver supplies the curve as
 * STATIC (capacity, marginalOI) segments and never recomputes the A-gamma invariant. We build the
 * prepared args DIRECTLY (CryptoSwap discovery uses a registry whose address is a placeholder here),
 * then compile the production solver template exactly as index.ts does and cook it.
 *
 * ISOLATED per-cell chain: every cell runs on its OWN fresh anvil + freshly-deployed engine (setup()),
 * then deploys its CryptoSwap pool + sets approvals and asserts the pre-cook invariants — so the compiled
 * args always match live on-chain state. There is no shared mutable node state between cells, so no
 * snapshot/loadState reset race (a revert+re-snapshot dance rarely raced to a 0-fill; a bare loadState
 * MERGES and drifts each cell's pool CREATE address — both the treeshake-cell flake). reset() tears the
 * anvil down and rebuilds.
 *
 * No fork / no RPC env needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when the v12
 * artifacts are present). Driven by ECO_ENGINE (default v12). Mirrors ecoswap.wombat.evm.test.ts.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, type Abi, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { compileSauce, ECOSWAP_DIR } from "./harness/compile";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  mint,
  approve,
  balanceOf,
  erc20Abi,
  deployCryptoSwapPool,
  cryptoSwapAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import {
  getDyCrypto,
  newtonD as cryptoNewtonD,
  buildCryptoSwapSegments,
  type CryptoSwapPool,
} from "../shared/cryptoswap-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
// Canonical volatile-asset A-gamma params. A = ANN (A_MULTIPLIER·N^N·A_raw, A_raw=400000 → 1.6e13);
// gamma 1.45e14; fee mid 0.05% / out 0.4% / fee_gamma 0.23 (1e10 fee units). price_scale 1:1 (the two
// local tokens trade near par so the fill engages both venues on the flat part of the crypto curve).
const ANN = 10000n * 4n * 400000n;
const GAMMA = 145_000_000_000_000n;
const MID = 5_000_000n;
const OUT = 40_000_000n;
const FEE_GAMMA = 230_000_000_000_000_000n;
const PRICE_SCALE = E18;
const ENGINE_CELLS = engineCells();

// The PRODUCTION treeshake define set for a CryptoSwap-only universe (no other segment-bearing
// protocol): index.ts protocolDefines folds every other HAS_* to false. The fast/no-define test path
// leaves all HAS_* at their source default `true`, masking any merge-head guard that omits HAS_CRYPTO —
// so this cell compiles with the real treeshaken set and a REAL cook asserts a non-zero CryptoSwap fill.
const CRYPTO_ONLY_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: true,
};

// CryptoSwap-only run: zero direct pools/routes/netCache; the CryptoSwap venues ride entirely inside
// segs (segKind 9). The solver's 5 compiler args, in index.ts order (cfg, pools, netCache, routing, segs).
function cryptoArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, segs: bigint[][]): unknown[] {
  return [
    [
      BigInt(tokenIn),
      BigInt(tokenOut),
      amountIn,
      BigInt(caller),
      MIN_SQRT_RATIO + 1n, // priceLimit (unused by static segments)
      0n, // directCount — no direct pools
    ],
    [], // pools
    [], // netCache
    [], // routing
    segs,
  ];
}

// One CryptoSwap venue → its sampled segments as segs rows. refIdx tags the on-chain per-venue
// accumulator (cryinp[refIdx]); venue is the pool address. Built from the SAME buildCryptoSwapSegments
// the oracle uses, so the awarded Σ == the off-chain share by construction. segKind = 9; a CryptoSwap
// segment is a flat post-fee slice ⇒ sqrtAdjNear == sqrtAdjFar.
function cryptoSegRows(pool: CryptoSwapPool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildCryptoSwapSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-fee; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (a CryptoSwap segment is a flat slice)
    9n, // segKind = Curve CryptoSwap (callback-free)
    BigInt(pool.address),
  ]);
}

// Interleave + sort segs rows the way index.ts buildSegs does: DESC by sqrtAdjNear, then DESC by
// sqrtAdjFar, then by refIdx. The on-chain static-segment cursor consumes them in array order.
function sortSegs(rows: bigint[][]): bigint[][] {
  return rows.slice().sort((a, b) => {
    if (a[2] !== b[2]) return a[2] < b[2] ? 1 : -1;
    if (a[3] !== b[3]) return a[3] < b[3] ? 1 : -1;
    return Number(a[0] - b[0]);
  });
}

describe("EcoSwap Curve CryptoSwap (volatile-asset A-gamma, local fixture) — callback-free exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == coin0 (lower address)
  let tokenOut: Hex; // == coin1
  let solverSrc: string;
  // Each cell runs on its OWN fresh anvil + freshly-deployed stack (setup() below): no shared
  // mutable node state between cells, so there is no snapshot/loadState reset race. The old reset was a
  // bare anvil_loadState of a dumped base blob — but loadState MERGES (it never CLEARS a live account),
  // so it could not remove a prior cell's pool code: with the deployer nonce left to climb, each cell's
  // pool drifted to a new CREATE address (the residual treeshake-cell 0-fill flake). A fresh chain per
  // cell removes all shared state — reset() just tears the anvil down and rebuilds. See setup().

  // Boot a fresh anvil + deploy the whole stack. Called by before() once and by reset() before every
  // subsequent cell, tearing the prior anvil down first — so each cell is fully isolated.
  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;
    solverSrc = readFileSync(SOLVER, "utf-8");

    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, parseEther("50000000"));

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
  }

  before(setup);

  after(() => {
    anvil?.stop();
  });

  async function reset(): Promise<void> {
    await setup();
  }

  // Assert the pre-cook invariants the compiled args assume: the caller can pay `amountIn` of tokenIn,
  // the cook target is approved to pull it, and every pool holds enough tokenOut to satisfy the output.
  async function assertPreCook(
    caller: Hex, target: Hex, amountIn: bigint, pools: { pool: Hex; expectedOut: bigint }[],
  ): Promise<void> {
    const callerIn = await balanceOf(c.publicClient, tokenIn, caller);
    assert.ok(callerIn >= amountIn, `caller tokenIn balance ${callerIn} >= amountIn ${amountIn}`);
    const allowance = (await c.publicClient.readContract({
      address: tokenIn, abi: erc20Abi as Abi, functionName: "allowance", args: [caller, target],
    })) as bigint;
    assert.ok(allowance >= amountIn, `cook target allowance ${allowance} >= amountIn ${amountIn}`);
    for (const { pool, expectedOut } of pools) {
      const poolOut = await balanceOf(c.publicClient, tokenOut, pool);
      assert.ok(poolOut >= expectedOut, `pool ${pool} tokenOut reserve ${poolOut} >= expected out ${expectedOut}`);
    }
  }

  // Off-chain CryptoSwapPool descriptor for a deployed fixture (tokenIn = coin0, tokenOut = coin1). The
  // pool ships a live D() but the off-chain descriptor recomputes D from the balances (bit-for-bit with
  // the fixture ctor), so the two agree.
  function offPool(
    address: Hex, bal0: bigint, bal1: bigint,
  ): CryptoSwapPool {
    // D is recomputed identically by the shared replay inside buildCryptoSwapSegments/getDyCrypto — set
    // it via newtonD to match the fixture ctor. Import indirectly through a tiny inline compute.
    const xp = [bal0 * 1n, (bal1 * 1n * PRICE_SCALE) / E18];
    return {
      address, i: 0, j: 1, A: ANN, gamma: GAMMA, priceScale: PRICE_SCALE, D: newtonD(xp),
      balances: [bal0, bal1], precisions: [1n, 1n], midFee: MID, outFee: OUT, feeGamma: FEE_GAMMA,
      feePpm: 5, source: "local-fixture",
    };
  }
  // newton_D via the shared replay (re-exported through the sampler path) — inline to keep the
  // descriptor self-contained (the fixture ctor computes D the same way).
  function newtonD(xp: bigint[]): bigint {
    // Reuse getDyCrypto's dependency by round-tripping a trivial pool would be circular; instead
    // recompute here with the same bounded-Newton the module exports. Imported lazily from the module.
    return cryptoNewtonD(ANN, GAMMA, xp);
  }

  // ── (1) SOLO CryptoSwap venue — received == getDyCrypto(share) == get_dy to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const bal0 = 1_000_000n * E18;
    const bal1 = 1_000_000n * E18;
    const pool = await deployCryptoSwapPool(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], [1n, 1n],
      ANN, GAMMA, PRICE_SCALE, [bal0, bal1], MID, OUT, FEE_GAMMA, caller,
    );
    const op = offPool(pool, bal0, bal1);

    // amountIn == the full sampled ladder cap ⇒ the merge awards the WHOLE Σ to this one venue.
    const amountIn = 100_000n * E18;
    const segRows = cryptoSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty CryptoSwap segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    assert.equal(segSum, amountIn, "CryptoSwap segments cover the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, cryptoArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: getDyCrypto(op, segSum) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    // The fixture's own on-chain get_dy view on the PRE-swap state — the engine-independent ground
    // truth for the executed dy of `amountIn` (coin0 → coin1 ⇒ i=0, j=1).
    const onViewPre = (await c.publicClient.readContract({
      address: pool, abi: cryptoSwapAbi, functionName: "get_dy", args: [0n, 1n, amountIn],
    })) as bigint;

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo CryptoSwap cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (the whole trade routed to the CryptoSwap pool)");
    assert.equal(poolIn, amountIn, "the CryptoSwap pool pulled the full input share (exchange PULLS)");

    // WEI-EXACT-IN-DY: the on-chain received tokenOut == off-chain getDyCrypto(awarded share) == the
    // pool's own PRE-swap get_dy view, all to the WEI. NO tolerance.
    assert.equal(received, getDyCrypto(op, spent), "received == getDyCrypto(share) to the wei");
    assert.equal(received, onViewPre, "received == on-chain get_dy view (exact-in-dy)");
    assert.ok(received > 0n, "non-zero CryptoSwap fill through the callback-free exchange path");

    console.log(`  [CryptoSwap solo:${engine}] spent=${spent} received=${received} (== getDyCrypto == get_dy to the wei)`);
  }

  // ── (2) TWO CryptoSwap venues — split + per-leg exact-in-dy + marginals equalize ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues at the SAME 1:1 balance but different depth → different marginal curves, so the
    // water-fill engages BOTH and equalizes their post-fee marginals. A drives first + more (deeper).
    const aBal = 3_000_000n * E18; // deep
    const bBal = 1_000_000n * E18; // shallower
    const poolA = await deployCryptoSwapPool(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], [1n, 1n],
      ANN, GAMMA, PRICE_SCALE, [aBal, aBal], MID, OUT, FEE_GAMMA, caller,
    );
    const poolB = await deployCryptoSwapPool(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], [1n, 1n],
      ANN, GAMMA, PRICE_SCALE, [bBal, bBal], MID, OUT, FEE_GAMMA, caller,
    );
    const opA = offPool(poolA, aBal, aBal);
    const opB = offPool(poolB, bBal, bBal);

    const amountIn = 800_000n * E18;
    const segRows = sortSegs([...cryptoSegRows(opA, 0, amountIn), ...cryptoSegRows(opB, 1, amountIn)]);

    const { bytecodes } = compileSauce(
      solverSrc, cryptoArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [
      { pool: poolA, expectedOut: getDyCrypto(opA, amountIn) },
      { pool: poolB, expectedOut: getDyCrypto(opB, amountIn) },
    ]);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const aInBefore = await balanceOf(c.publicClient, tokenIn, poolA);
    const bInBefore = await balanceOf(c.publicClient, tokenIn, poolB);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue CryptoSwap cook() must succeed");

    const aIn = (await balanceOf(c.publicClient, tokenIn, poolA)) - aInBefore;
    const bIn = (await balanceOf(c.publicClient, tokenIn, poolB)) - bInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(aIn > 0n && bIn > 0n, "both CryptoSwap venues are funded");
    assert.ok(aIn > bIn, `deep venue A draws more than B (A ${aIn} > B ${bIn})`);

    // PER-LEG WEI-EXACT-IN-DY: received == getDyCrypto_A(aIn) + getDyCrypto_B(bIn).
    const expected = getDyCrypto(opA, aIn) + getDyCrypto(opB, bIn);
    assert.equal(received, expected, "received == Σ getDyCrypto(per-venue share) to the wei");

    // MARGINALS EQUALIZE within the GRID bound (exact-on-grid: the awarded inputs equal the oracle
    // bit-for-bit — checked by the wei-exact gate above; the realized post-fee marginal equalizes only
    // to within ONE sampled segment's price width). The crypto curve is very flat near balance, so a
    // single M=24 segment spans a wide band: the cut gap is a documented grid bound (converges as M grows).
    const margA = marginalAt(opA, aIn);
    const margB = marginalAt(opB, bIn);
    const diff = margA > margB ? margA - margB : margB - margA;
    const relPpm = margA > 0n ? (diff * 1_000_000n) / margA : 0n;
    assert.ok(relPpm <= 2500n, `CryptoSwap split marginals equalize on the M=24 grid (rel ${relPpm} ppm; A ${margA} B ${margB})`);

    console.log(
      `  [CryptoSwap split:${engine}] A in=${aIn} B in=${bIn} received=${received} ` +
        `(== Σ getDyCrypto to the wei); marginals A=${margA} B=${margB} (${relPpm} ppm)`,
    );
  }

  // ── (3) SOLO CryptoSwap under the PRODUCTION treeshake define set ──
  // Same trade as runSolo, but compiled with treeshake:true + CryptoSwap-only defines (the exact
  // compile a production CryptoSwap-without-other-segs cook carries). Guards the guard triple: if
  // HAS_CRYPTO is missing from the segment-head price-merge guard, the accumulator branch, OR the exec
  // block, under treeshake the CryptoSwap head is never compared / never accumulated / never swapped and
  // the swap lands ZERO (the bug that bit Balancer).
  async function runSoloTreeshake(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const bal0 = 1_000_000n * E18;
    const bal1 = 1_000_000n * E18;
    const pool = await deployCryptoSwapPool(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], [1n, 1n],
      ANN, GAMMA, PRICE_SCALE, [bal0, bal1], MID, OUT, FEE_GAMMA, caller,
    );
    const op = offPool(pool, bal0, bal1);

    const amountIn = 100_000n * E18;
    const segRows = cryptoSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty CryptoSwap segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);

    const { bytecodes } = compileSauce(
      solverSrc, cryptoArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
      { treeshake: true, defines: CRYPTO_ONLY_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: getDyCrypto(op, segSum) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "treeshaken CryptoSwap-only cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // The merge MUST have routed the trade to CryptoSwap — non-zero spend/receive is the regression gate.
    assert.ok(spent > 0n, "treeshaken CryptoSwap-only: non-zero CryptoSwap fill (guard triple alive)");
    assert.equal(received, getDyCrypto(op, spent), "received == getDyCrypto(share) to the wei (treeshaken path)");

    console.log(`  [CryptoSwap treeshake:${engine}] spent=${spent} received=${received} (production define set)`);
  }

  // Post-fee out/in marginal price at a cumulative input `share` — a small finite-difference slice of
  // getDyCrypto around `share` (the same coordinate the segments carry). Used only to check the split
  // equalized marginals.
  function marginalAt(pool: CryptoSwapPool, share: bigint): bigint {
    if (share <= 0n) return 0n;
    const eps = share / 1000n > 0n ? share / 1000n : 1n;
    const lo = share - eps > 0n ? share - eps : 0n;
    const dIn = share - lo;
    const dOut = getDyCrypto(pool, share) - getDyCrypto(pool, lo);
    if (dIn <= 0n || dOut <= 0n) return 0n;
    return isqrt((dOut * (1n << 192n)) / dIn);
  }
  function isqrt(x: bigint): bigint {
    if (x <= 0n) return 0n;
    let z = x;
    let y = (z + 1n) / 2n;
    while (y < z) {
      z = y;
      y = (x / y + y) / 2n;
    }
    return y > z ? z : y;
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`CryptoSwap solo [${engine}] — received == getDyCrypto(share) == get_dy to the wei (exact-in-dy)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`CryptoSwap split [${engine}] — two venues, per-leg exact-in-dy + marginals equalize`, { skip }, async () => {
      await runSplit(engine);
    });
    it(`CryptoSwap solo treeshake [${engine}] — production define set lands a non-zero CryptoSwap fill`, { skip }, async () => {
      await runSoloTreeshake(engine);
    });
  }
});
