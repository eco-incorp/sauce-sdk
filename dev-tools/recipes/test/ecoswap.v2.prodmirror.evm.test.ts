/**
 * EcoSwap PROD-MIRROR (Uniswap V2) local EVM test — NO fork, NO live RPC.
 *
 * Replays a REAL Base Uniswap-V2 pair's constant-product curve on a fresh anvil:
 * the canonical V2Pair runtime is ETCHED at a local address and funded to match
 * the captured reserves (so price + depth mirror production exactly), then the
 * compiled EcoSwap recipe runs through it via the unified swap(SwapParams) path.
 *
 * Offline by design: loads a checked-in `ProdV2Snapshot`
 * (fixtures/snapshots/base-v2-*.json). Recapture with:
 *   BASE_RPC_URL=<url> npx tsx recipes/test/harness/v2-snapshot.ts
 *
 * Run: npx tsx --test recipes/test/ecoswap.v2.prodmirror.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Hex } from "viem";
import { Q96, FEE_DENOM, isqrt } from "./ecoswap.math";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  deployV2Factory,
  setupEtchedV2Pool,
  mint,
  approve,
  balanceOf,
  type DeployedStack,
} from "./harness/setup";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { driftPoolPrice } from "./harness/drift";
import type { ProdV2Snapshot } from "./harness/v2-snapshot";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "fixtures", "snapshots");
const V2_PAIR_ADDR = "0x00000000000000000000000000000000ec05a2a2" as Hex;

/** Pick a checked-in real V2 snapshot (base-v2-*.json). */
function loadSnapshot(): ProdV2Snapshot | null {
  let files: string[] = [];
  try {
    files = readdirSync(SNAPSHOT_DIR).filter((f) => /-v2-.*\.json$/.test(f));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(SNAPSHOT_DIR, files[0]), "utf-8")) as ProdV2Snapshot;
}

/** Exact constant-product output (0.3% fee) the engine computes for `amountIn`. */
function cpAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

const snap = loadSnapshot();

describe("EcoSwap prod-mirror V2 (reproduced Base constant-product pair)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let tokenIn: Hex; // local token0 == snapshot token0 orientation (zeroForOne)
  let tokenOut: Hex; // local token1
  let pair: Hex;
  let reserveIn: bigint;
  let reserveOut: bigint;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex; // pristine reconstructed state (for the drift case)

  before(async () => {
    if (!snap) return;
    reserveIn = BigInt(snap.reserve0); // tokenIn == token0
    reserveOut = BigInt(snap.reserve1);
    console.log(
      `  [v2 prod-mirror] ${snap.symbol0}/${snap.symbol1} (${snap.source}) reserves ${snap.reserve0}/${snap.reserve1}`,
    );

    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const v2Factory = await deployV2Factory(c.walletClient, c.publicClient);

    // Local tokens sorted token0 < token1, mapped to the snapshot's reserve0/1.
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    // Mint the reserves (+headroom for the caller's input) to the minter, then
    // etch the pair and fund it to mirror the production reserves exactly.
    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, reserveIn * 2n);
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, reserveOut * 2n);
    pair = await setupEtchedV2Pool(
      c.walletClient, c.publicClient, c.testClient, v2Factory, V2_PAIR_ADDR,
      tokenIn, tokenOut, reserveIn, reserveOut,
    );

    poolConfig = {
      factories: [
        { address: v2Factory, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Local UniV2 (prod-mirror)" },
      ],
      feeTiers: [3000],
      baseTokens: [tokenIn, tokenOut],
    };

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  it("runs EcoSwap through the reproduced prod V2 pair", async () => {
    if (!snap) {
      console.log("  [v2 prod-mirror] no snapshot present — skipping");
      return;
    }
    // ~3% of the WETH-side reserve: meaningful price impact, well within depth.
    const amountIn = reserveIn / 32n;
    const caller = c.account0;

    await approve(c.walletClient, c.publicClient, tokenIn, stack.sauceRouter, amountIn);
    const pairInBefore = await balanceOf(c.publicClient, tokenIn, pair);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, stack.sauceRouter, caller, poolConfig,
    );
    assert.equal(prepared.pools.filter((p) => p.isV2).length, 1, "should discover the reproduced V2 pair");
    assert.ok(prepared.zeroForOne, "tokenIn < tokenOut → zeroForOne");

    const { receipt } = await cook(c.walletClient, c.publicClient, stack.sauceRouter, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against reproduced V2 reserves");

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const pairInDelta = (await balanceOf(c.publicClient, tokenIn, pair)) - pairInBefore;

    assert.ok(spent > 0n, "caller should spend tokenIn");
    assert.ok(received > 0n, "caller should receive tokenOut");
    assert.equal(pairInDelta, spent, "pair tokenIn reserve increases by spent");
    assert.ok(spent <= amountIn, "never overspends amountIn");
    assert.ok(spent >= (amountIn * 90n) / 100n, `deploys most of input (spent ${spent} of ${amountIn})`);

    // PROD-ACCURATE check: the output equals the EXACT constant-product result the
    // real pair would give for `spent` against the captured reserves (engine math).
    const expectedOut = cpAmountOut(spent, reserveIn, reserveOut);
    assert.equal(received, expectedOut, `received must equal exact CP output (got ${received}, expected ${expectedOut})`);

    // Oracle cross-check.
    const ref = ecoSwapReference(prepared, amountIn);
    const refIn = ref.perPoolInput[0] ?? 0n;
    if (refIn > 0n) {
      const diff = refIn > spent ? refIn - spent : spent - refIn;
      const rel = Number(diff) / Number(refIn > spent ? refIn : spent);
      assert.ok(rel < 0.15, `on-chain spend ${spent} vs oracle ${refIn} (rel ${rel})`);
    }

    console.log(
      `  [v2 prod-mirror] spent=${spent} received=${received} (exact CP out=${expectedOut})\n` +
        `       pair tokenIn delta=${pairInDelta} oracle perPool[0]=${refIn}`,
    );
  });

  it("re-anchors to live reserves when the pool drifts after prepare", async () => {
    if (!snap) return;
    await c.testClient.revert({ id: cleanSnapshot });

    const caller = c.account0;
    const amountIn = reserveIn / 32n;

    // PREPARE against the clean (pre-drift) reserves.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, stack.sauceRouter, caller, poolConfig,
    );
    const ref = ecoSwapReference(prepared, amountIn);
    const refV2 = ref.perPoolInput[0] ?? 0n;
    assert.ok(refV2 > 0n, "baseline allocates to the V2 pool");

    // DRIFT: push the pair's price down with a real swap of ~1/3 the baseline fill.
    const driftAmount = refV2 / 3n;
    await driftPoolPrice(c, stack.sauceRouter, prepared.pools[0], tokenIn, tokenOut, true, driftAmount, caller);

    // EXECUTE the pre-drift bytecodes — Phase B must read the NEW live reserves.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, stack.sauceRouter, amountIn);
    const pairInBefore = await balanceOf(c.publicClient, tokenIn, pair);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, stack.sauceRouter, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against drifted reserves");

    const v2InDelta = (await balanceOf(c.publicClient, tokenIn, pair)) - pairInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));

    const within = (a: bigint, b: bigint, tol: number) => {
      const hi = a > b ? a : b;
      const lo = a > b ? b : a;
      return hi === 0n ? true : Number(hi - lo) / Number(hi) < tol;
    };

    // Re-anchoring: the recipe filled only the REMAINING gap to the cut (had it
    // used the stale prepared price it would have re-spent the full baseline and
    // overshot the cut). drift + recipe ≈ baseline (path-additive gross input).
    assert.ok(v2InDelta > 0n, "pool still participates");
    assert.ok(v2InDelta < refV2, `V2 fill adapts DOWN vs baseline (got ${v2InDelta}, baseline ${refV2})`);
    assert.ok(within(driftAmount + v2InDelta, refV2, 0.02), `drift(${driftAmount}) + recipe(${v2InDelta}) ≈ baseline (${refV2})`);
    assert.equal(v2InDelta, spent, "single pool → spent == its fill");
    assert.ok(spent <= amountIn, "never overspends");

    // Despite the drift, the pool ends at the same fee-adjusted cut.
    const Q192 = Q96 * Q96;
    const v2InAfter = await balanceOf(c.publicClient, tokenIn, pair);
    const v2OutAfter = await balanceOf(c.publicClient, tokenOut, pair);
    const outInSqrt = isqrt((v2OutAfter * Q192) / v2InAfter);
    const feeAdj = (outInSqrt * isqrt((FEE_DENOM - 3000n) * FEE_DENOM)) / FEE_DENOM;
    const rel = ref.cutSqrtAdj === 0n ? 0 : Number(feeAdj > ref.cutSqrtAdj ? feeAdj - ref.cutSqrtAdj : ref.cutSqrtAdj - feeAdj) / Number(ref.cutSqrtAdj);
    assert.ok(rel < 0.01, `V2 re-anchored to the cut (feeAdj ${feeAdj} vs cut ${ref.cutSqrtAdj}, rel ${rel})`);

    console.log(
      `  [v2 prod-mirror] RUNTIME re-anchoring: drift ${driftAmount} + recipe ${v2InDelta} ≈ baseline ${refV2}; ` +
        `spent=${spent} feeAdj=${feeAdj} cut=${ref.cutSqrtAdj} (rel ${rel})`,
    );
  });
});
