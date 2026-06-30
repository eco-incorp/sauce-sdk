/**
 * EcoSwap Balancer V2 ComposableStable local-EVM integration — the engine `_swapBalancerV2` exact-in-dy
 * gate.
 *
 * Stands up a local Balancer ComposableStable pool + the canonical Vault (etched at 0xBA12…, the engine
 * constant), whose StableMath mirrors the off-chain `balancer-stable-math.ts` replay bit-for-bit, deploys
 * the Sauce engine, and cooks an EcoSwap whose static-segment cursor consumes Balancer segments (segKind
 * 6) and executes them via the EXISTING engine BalancerV2 dispatch swap(SwapParams{poolType:4}) → live
 * `_swapBalancerV2` (one atomic Vault.swap(GIVEN_IN) per venue; the engine derives the poolId via
 * pool.getPoolId()). Then asserts:
 *
 *   (1) SOLO Balancer venue — the on-chain dy the caller receives == off-chain getDy(awarded share) to
 *       the WEI (the exact-in-dy gate: one atomic Vault.swap lands exactly the segment-summed output the
 *       merge accounted for). NO tolerance.
 *   (2) TWO Balancer venues — ONE EcoSwap splits across both; each leg's received output ==
 *       getDy(its awarded share) to the wei, and the post-fee marginals equalize within the sampled-grid
 *       bound (the documented exact-on-grid standard).
 *
 * The ComposableStable token list INCLUDES a BPT at bptIndex; the StableMath EXCLUDES it. The Balancer
 * math is OFF-CHAIN only: the on-chain solver supplies Balancer as STATIC (capacity, marginalOI) segments
 * and never recomputes the A-invariant — the Vault does, inside the swap. We build the prepared args
 * DIRECTLY (Balancer discovery is known-pool-address based), then compile the production solver template
 * exactly as index.ts does and cook it.
 *
 * No fork / no RPC env needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when the v12
 * artifacts are present). Driven by ECO_ENGINE (default v12).
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { compileSauce, ECOSWAP_DIR } from "./harness/compile";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deployToken,
  mint,
  approve,
  balanceOf,
  deployBalancerComposableStable,
  balancerStablePoolAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getDy, buildBalancerStableSegments, type BalancerStablePool } from "../shared/balancer-stable-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const ENGINE_CELLS = engineCells();

// The PRODUCTION treeshake define set for a Balancer-only universe (V2/V3/V4 pools + Balancer, NO
// other segment-bearing protocol): index.ts protocolDefines folds every other HAS_* to false. The
// fast/no-define test path leaves all HAS_* at their source default `true`, which masks any merge-head
// guard that omits HAS_BALANCER — so this regression cell compiles with the real treeshaken set and a
// REAL cook asserts a non-zero Balancer fill (pre-fix the segment head was dead ⇒ zero allocation).
const BALANCER_ONLY_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: true,
};

// Balancer-only run: zero direct pools/routes/netCache; the Balancer venues ride entirely inside the
// segs stream (segKind 6). The solver's 5 compiler args, in index.ts order.
function balancerArgs(
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  segs: bigint[][],
): unknown[] {
  return [
    [
      BigInt(tokenIn),
      BigInt(tokenOut),
      amountIn,
      BigInt(caller),
      MIN_SQRT_RATIO + 1n, // priceLimit (unused by Balancer; the merge ignores it for static segs)
      0n, // directCount — no direct pools
    ],
    [], // pools
    [], // netCache
    [], // routing
    segs,
  ];
}

// One Balancer venue → its sampled segments as segs rows. refIdx tags the on-chain per-venue accumulator
// (binp[refIdx]); venue is the POOL address (the engine derives the poolId). Built from the SAME
// buildBalancerStableSegments the oracle uses, so the awarded Σ == the off-chain share by construction.
function balancerSegRows(pool: BalancerStablePool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildBalancerStableSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-fee; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (a Balancer segment is a flat slice)
    6n, // segKind = Balancer ComposableStable
    BigInt(pool.address),
  ]);
}

// Interleave + sort segs rows the way index.ts buildSegs does: DESC by sqrtAdjNear, then DESC by
// sqrtAdjFar, then by refIdx. The on-chain static-segment cursor consumes them in array order, so the
// global price order MUST be materialized here (multiple venues interleaved).
function sortSegs(rows: bigint[][]): bigint[][] {
  return rows.slice().sort((a, b) => {
    if (a[2] !== b[2]) return a[2] < b[2] ? 1 : -1;
    if (a[3] !== b[3]) return a[3] < b[3] ? 1 : -1;
    return Number(a[0] - b[0]);
  });
}

describe("EcoSwap Balancer V2 ComposableStable (local fixture) — engine _swapBalancerV2 exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let bpt: Hex; // the BPT (a third registered token, EXCLUDED from StableMath at bptIndex)
  let solverSrc: string;
  let cleanSnapshot: Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);

    // Three tokens. The swap pair is (tokenIn, tokenOut); the BPT is a third registered token excluded
    // from the StableMath at bptIndex. Sort so tokenIn < tokenOut (deterministic) — bpt placement is
    // independent (we register it at index 0 and put the pair after, so bptIndex = 0).
    const a = await deployToken(c.walletClient, c.publicClient, "TokenA", "TKA");
    const b = await deployToken(c.walletClient, c.publicClient, "TokenB", "TKB");
    bpt = await deployToken(c.walletClient, c.publicClient, "BPT", "BPT");
    [tokenIn, tokenOut] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    solverSrc = readFileSync(SOLVER, "utf-8");

    // Plenty of both swap tokens for funding the Vault + the caller's input.
    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, parseEther("50000000"));

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function reset(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
  }

  // Deploy a ComposableStable pool with token list [BPT, tokenIn, tokenOut] (bptIndex 0) and the given
  // non-BPT balances. Returns both the pool address and the off-chain descriptor (the StableMath set
  // EXCLUDES the BPT, so i=0/j=1 index into [tokenIn, tokenOut]). 18-dec tokens ⇒ scaling 1e18.
  async function deployPool(balIn: bigint, balOut: bigint, amp: bigint, feeWad: bigint, vaultFund: bigint) {
    // tokens: [BPT, tokenIn, tokenOut]; scaling aligned; the BPT balance slot is a sentinel (ignored).
    const tokens = [bpt, tokenIn, tokenOut];
    const scaling = [E18, E18, E18];
    const bals = [E18, balIn, balOut]; // BPT slot sentinel
    const pool = await deployBalancerComposableStable(
      c.walletClient, c.publicClient, c.testClient,
      tokens, scaling, 0, amp, feeWad, bals, vaultFund,
    );
    const op: BalancerStablePool = {
      poolType: 4,
      address: pool,
      i: 0, // tokenIn is the first NON-BPT token
      j: 1, // tokenOut is the second NON-BPT token
      amp,
      balances: [balIn, balOut],
      scalingFactors: [E18, E18],
      swapFeeWad: feeWad,
      source: "local-fixture",
    };
    return { pool, op };
  }

  // ── (1) SOLO Balancer venue — received == getDy(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Imbalanced pool (out side deeper). A=1000, fee 0.04%. Vault funded generously to pay the swap.
    const balIn = 1_000_000n * E18;
    const balOut = 1_200_000n * E18;
    const amp = 1_000_000n; // A=1000
    const feeWad = 4n * 10n ** 14n; // 0.04%
    const { pool, op } = await deployPool(balIn, balOut, amp, feeWad, 2_000_000n * E18);

    // amountIn == the full sampled ladder cap ⇒ the merge awards the WHOLE Σ to this one venue.
    const amountIn = 150_000n * E18;
    const segRows = balancerSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Balancer segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    assert.equal(segSum, amountIn, "Balancer segments cover the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, balancerArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    // The pool's own on-chain onSwapGivenIn view, read on the PRE-swap state (the swap mutates balances).
    // The engine-independent ground truth for the executed dy of `amountIn`.
    const onViewPre = (await c.publicClient.readContract({
      address: pool, abi: balancerStablePoolAbi, functionName: "onSwapGivenIn", args: [amountIn, tokenIn, tokenOut],
    })) as bigint;

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Balancer cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.equal(spent, amountIn, "spent == amountIn (the whole trade routed to Balancer)");

    // WEI-EXACT-IN-DY: the on-chain executed dy (the caller's received tokenOut) equals the off-chain
    // getDy(awarded share) to the WEI. One atomic Vault.swap(GIVEN_IN). NO tolerance.
    assert.equal(received, getDy(op, spent), "received == getDy(share) to the wei (exact-in-dy)");
    // Cross-check against the pool's own on-chain PRE-swap StableMath view (independent of the off-chain
    // replay) — the Vault executed exactly this view's output, to the wei.
    assert.equal(received, onViewPre, "received == on-chain onSwapGivenIn view (exact-in-dy)");

    console.log(`  [Balancer solo:${engine}] spent=${spent} received=${received} (== getDy to the wei)`);
  }

  // ── (1b) SOLO Balancer under the PRODUCTION treeshake define set ──
  // Same trade as runSolo, but compiled with treeshake:true + Balancer-only defines (the exact compile
  // a production Balancer-without-other-segs cook carries). Guards the merge-head guard at the call
  // boundary: pre-fix HAS_BALANCER was absent from the segment-head price-merge guard, so under
  // treeshake the Balancer head was never compared, bestKind never hit 1, and the swap landed ZERO.
  async function runSoloTreeshake(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const balIn = 1_000_000n * E18;
    const balOut = 1_200_000n * E18;
    const amp = 1_000_000n;
    const feeWad = 4n * 10n ** 14n;
    const { pool, op } = await deployPool(balIn, balOut, amp, feeWad, 2_000_000n * E18);

    const amountIn = 150_000n * E18;
    const segRows = balancerSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Balancer segment ladder");

    const { bytecodes } = compileSauce(
      solverSrc, balancerArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
      { treeshake: true, defines: BALANCER_ONLY_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "treeshaken Balancer-only cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // The merge MUST have routed the trade to Balancer — non-zero spend/receive is the regression gate.
    assert.ok(spent > 0n, "treeshaken Balancer-only: non-zero Balancer fill (merge-head guard alive)");
    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to Balancer)");
    assert.equal(received, getDy(op, spent), "received == getDy(share) to the wei (treeshaken path)");

    console.log(`  [Balancer treeshake:${engine}] spent=${spent} received=${received} (production define set)`);
  }

  // ── (2) TWO Balancer venues — split + per-leg exact-in-dy + marginals equalize ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues at the SAME 1:1 spot but different A/fee → different marginal curves, so the water-fill
    // engages BOTH and equalizes their post-fee marginals. The Vault (etched once) holds both pools'
    // payout funds. Low A (steeper) + low fee draws first + more.
    const amountIn = 600_000n * E18;
    const { pool: poolA, op: opA } = await deployPool(
      1_000_000n * E18, 1_000_000n * E18, 100_000n /*A=100*/, 1n * 10n ** 14n /*0.01%*/, 2_000_000n * E18,
    );
    const { pool: poolB, op: opB } = await deployPool(
      1_000_000n * E18, 1_000_000n * E18, 50_000n /*A=50*/, 4n * 10n ** 14n /*0.04%*/, 2_000_000n * E18,
    );

    const segRows = sortSegs([...balancerSegRows(opA, 0, amountIn), ...balancerSegRows(opB, 1, amountIn)]);

    const { bytecodes } = compileSauce(
      solverSrc, balancerArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    // Pre-swap StableMath views give the per-venue awarded shares' expected out — but we don't know the
    // shares until the cook. Instead assert per-leg exact-in-dy against the awarded shares read from the
    // pools' registered-balance deltas (the Vault updates them).
    const aBalInBefore = (await poolBalances(poolA))[1];
    const bBalInBefore = (await poolBalances(poolB))[1];

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue Balancer cook() must succeed");

    const aIn = (await poolBalances(poolA))[1] - aBalInBefore;
    const bIn = (await poolBalances(poolB))[1] - bBalInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // BOTH venues funded; the low-fee A draws strictly more.
    assert.ok(aIn > 0n && bIn > 0n, "both Balancer venues are funded");
    assert.ok(aIn > bIn, `low-fee venue A draws more than B (A ${aIn} > B ${bIn})`);

    // PER-LEG WEI-EXACT-IN-DY: the caller's received tokenOut == getDy_A(aIn) + getDy_B(bIn) (each venue
    // executes one atomic Vault.swap on its awarded share). NO tolerance.
    const expected = getDy(opA, aIn) + getDy(opB, bIn);
    assert.equal(received, expected, "received == Σ getDy(per-venue share) to the wei");

    // MARGINALS EQUALIZE within the grid bound: the post-fee marginal price each venue reaches at its
    // awarded share agrees to a few ppm (the exact-on-grid bound at M=24).
    const margA = marginalAt(opA, aIn);
    const margB = marginalAt(opB, bIn);
    const diff = margA > margB ? margA - margB : margB - margA;
    const relPpm = (diff * 1_000_000n) / margA;
    assert.ok(relPpm <= 200n, `Balancer split marginals equalize (rel ${relPpm} ppm; A ${margA} B ${margB})`);

    console.log(
      `  [Balancer split:${engine}] A in=${aIn} B in=${bIn} received=${received} ` +
        `(== Σ getDy to the wei); marginals A=${margA} B=${margB} (${relPpm} ppm)`,
    );
  }

  // Read the pool's registered balances [bpt, in, out].
  async function poolBalances(pool: Hex): Promise<bigint[]> {
    return (await c.publicClient.readContract({
      address: pool, abi: balancerStablePoolAbi, functionName: "balances",
    })) as bigint[];
  }

  // Post-fee out/in marginal price at a cumulative input `share`, a small finite-difference slice of
  // getDy around `share` (the same coordinate the segments carry). Used only to check the split
  // equalized marginals.
  function marginalAt(pool: BalancerStablePool, share: bigint): bigint {
    if (share <= 0n) return 0n;
    const eps = share / 1000n > 0n ? share / 1000n : 1n;
    const lo = share - eps > 0n ? share - eps : 0n;
    const dIn = share - lo;
    const dOut = getDy(pool, share) - getDy(pool, lo);
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
    return z;
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Balancer solo [${engine}] — received == getDy(share) to the wei (exact-in-dy)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Balancer solo treeshake [${engine}] — production define set lands a non-zero Balancer fill`, { skip }, async () => {
      await runSoloTreeshake(engine);
    });
    it(`Balancer split [${engine}] — two venues, per-leg exact-in-dy + marginals equalize`, { skip }, async () => {
      await runSplit(engine);
    });
  }
});
