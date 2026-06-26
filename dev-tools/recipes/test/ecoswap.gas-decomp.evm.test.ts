/**
 * EcoSwap GAS DECOMPOSITION harness (analysis only — gate ECO_GAS=1).
 *
 * Goal: isolate SOLVER-ARITHMETIC gas from SWAP gas to explain why two-pass edges
 * single-pass on the v12 Huff runtime while single-pass wins on v1.
 *
 * Method — on the deterministic 3-V3-pool Phase-3 stack (copied from
 * ecoswap.gas.evm.test.ts), measure cook `gasUsed` for:
 *   - FULL solvers (with swaps): two-pass & single-pass(array) × {v1, v12}
 *   - COMPUTE-ONLY variants (no transferFrom/swap/transfer; full water-fill
 *     arithmetic kept, returns a cheap summary): two-pass-compute &
 *     single-pass-compute × {v1, v12}
 * then DERIVE: solver-arithmetic gas ≈ compute-only; swap gas ≈ full − compute-only.
 *
 * Fairness mirrors the gas test: per-cell anvil snapshot/revert + pinned cook block
 * timestamp (the V3 oracle accumulator depends on block.timestamp). Full solvers
 * transferFrom the caller, so the cook target is approved per cell; compute-only
 * variants need no approval (they never move funds) but are run through the same
 * submitted-tx cook() path so `receipt.gasUsed` is apples-to-apples with the full
 * solvers.
 *
 * Does NOT write any report file and does NOT modify the real solvers, the existing
 * gas test/harness, or the compiler. Prints the decomposition table + verdict to
 * the console. Run:
 *   cd dev-tools && ECO_GAS=1 npx tsx --test recipes/test/ecoswap.gas-decomp.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
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
  deployV12Stack,
  V12_AVAILABLE,
  deploySortedTokens,
  createAndInitPool,
  mint,
  approve,
  mintPosition,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import type { EcoSwapPrepared, EcoPool, EcoRoute, EcoBracket } from "../shared/types";

const HUGE = parseEther("1000000000");
const AMOUNT_IN = parseEther("5000");
const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

type Target = "v1" | "v12";

// ── The four variants: FULL (with swaps) + COMPUTE-ONLY (arithmetic only) ──
// "kind" pairs a compute-only variant with its full counterpart for the derivation.
interface Variant {
  key: string;
  file: string;
  kind: "full" | "compute";
  family: "two-pass" | "single-pass";
}
const VARIANTS: Variant[] = [
  { key: "two-pass.full", file: "ecoswap.sauce.ts", kind: "full", family: "two-pass" },
  { key: "single-pass.full", file: "ecoswap.singlepass.sauce.ts", kind: "full", family: "single-pass" },
  { key: "two-pass.compute", file: "ecoswap.computeonly.sauce.ts", kind: "compute", family: "two-pass" },
  { key: "single-pass.compute", file: "ecoswap.singlepass.computeonly.sauce.ts", kind: "compute", family: "single-pass" },
];

// ── Compile-arg tuple builders — copied verbatim from recipes/ecoswap/index.ts ──
// (kept byte-for-byte equivalent so the compiler args match what index.ts feeds.)

/** [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0, stateView, poolId] */
function buildPoolTuple(p: EcoPool): bigint[] {
  return [
    BigInt(p.poolType),
    BigInt(p.address),
    BigInt(p.fee),
    BigInt(p.tickSpacing),
    BigInt(p.hooks),
    BigInt(p.feePpm),
    p.isV2 ? 1n : 0n,
    p.inIsToken0 ? 1n : 0n,
    BigInt(p.stateView),
    BigInt(p.poolId),
  ];
}

function buildRouteTuple(r: EcoRoute): bigint[] {
  const { hop1Pool, hop2Pool, intermediateToken } = r.route;
  return [
    BigInt(intermediateToken),
    BigInt(hop1Pool.poolType),
    BigInt(hop1Pool.address),
    BigInt(hop1Pool.fee),
    0n,
    0n,
    BigInt(hop2Pool.poolType),
    BigInt(hop2Pool.address),
    BigInt(hop2Pool.fee),
    0n,
    0n,
  ];
}

function buildBracketTuple(b: EcoBracket): bigint[] {
  return [
    BigInt(b.kind),
    BigInt(b.refIdx),
    b.sqrtNear,
    b.sqrtFar,
    b.liquidity,
    b.capacity,
    b.sqrtAdjNear,
    b.sqrtAdjFar,
  ];
}

function buildCompilerArgs(
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  prepared: EcoSwapPrepared,
): unknown[] {
  return [
    BigInt(tokenIn),
    BigInt(tokenOut),
    amountIn,
    BigInt(caller),
    prepared.zeroForOne ? 1n : 0n,
    prepared.priceLimit,
    prepared.pools.map(buildPoolTuple),
    prepared.routes.map(buildRouteTuple),
    prepared.brackets.map(buildBracketTuple),
  ];
}

function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const detail = msg.match(/custom error (0x[0-9a-fA-F]+(?::\s*[0-9a-fA-F]+)?)/);
  if (detail) return `cook() reverted, ${detail[1].replace(/\s+/g, "")}`;
  const sel = msg.match(/0x[0-9a-fA-F]{8}/);
  if (sel && /revert/i.test(msg)) return `cook() reverted, selector ${sel[0]}`;
  return msg.split("\n")[0].slice(0, 160);
}

function n(x: bigint | number | null): string {
  return x === null ? "—" : Number(x).toLocaleString("en-US");
}

describe("EcoSwap gas decomposition (solver arithmetic vs swaps)", () => {
  if (!process.env.ECO_GAS) {
    it("skipped (set ECO_GAS=1 to run)", () => {});
    return;
  }

  let anvil: AnvilHandle | undefined;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let prepared: EcoSwapPrepared;
  let caller: Hex;
  let chainSetupFailed = false;
  let setupErr = "";
  let cleanSnapshot: Hex;
  let v12ExecAvailable = false;

  // gas[variant.key][target] = gasUsed | null
  const gas = new Map<string, { v1: bigint | null; v12: bigint | null }>();
  const notes = new Map<string, string>();

  before(async () => {
    try {
      anvil = await startAnvil();
      c = await makeClients(anvil.rpcUrl);
      await ensureMulticall3(c.publicClient, c.testClient);
      stack = await deployStack(c.walletClient, c.publicClient);
      const tk = await deploySortedTokens(c.walletClient, c.publicClient);
      tokenIn = tk.token0;
      tokenOut = tk.token1;
      caller = c.account0;

      const minter = c.account0;
      await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("50000000"));
      await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("50000000"));
      await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
      await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

      // Three V3 pools — same 1:1 price, different fee tier + depth → forces a split.
      const specs: [number, bigint][] = [
        [500, parseEther("400000")],
        [3000, parseEther("250000")],
        [10000, parseEther("150000")],
      ];
      for (const [fee, L] of specs) {
        const pool = await createAndInitPool(
          c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, fee, SQRT_PRICE_1_1,
        );
        await mintPosition(
          c.walletClient, c.publicClient, stack.helper, pool, minter, -12000, 12000, L,
        );
      }

      const poolConfig: ChainPoolConfig = {
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

      if (V12_AVAILABLE) {
        const owner = c.walletClient.account as Account;
        v12 = await deployV12Stack(c.walletClient, c.publicClient, owner);
        await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);
        v12ExecAvailable = true;
      }

      const out = await ecoSwap(
        { tokenIn, tokenOut, amountIn: AMOUNT_IN },
        anvil.rpcUrl,
        stack.sauceRouter,
        caller,
        poolConfig,
      );
      prepared = out.prepared;

      cleanSnapshot = await c.testClient.snapshot();
    } catch (e) {
      chainSetupFailed = true;
      setupErr = String(e);
      anvil?.stop();
      anvil = undefined;
    }
  });

  after(() => {
    anvil?.stop();
  });

  it("measures full + compute-only cook gas across {two-pass, single-pass} × {v1, v12}", async () => {
    if (chainSetupFailed || !prepared) {
      assert.fail(`stack setup failed: ${setupErr}`);
    }
    const args = buildCompilerArgs(tokenIn, tokenOut, AMOUNT_IN, caller, prepared);
    const targets: Target[] = v12ExecAvailable ? ["v1", "v12"] : ["v1"];

    console.log(
      `\n[gas-decomp] amountIn=${AMOUNT_IN} pools=${prepared.pools.length} ` +
        `brackets=${prepared.brackets.length} routes=${prepared.routes.length} ` +
        `v12=${v12ExecAvailable}\n`,
    );

    for (const v of VARIANTS) {
      const source = readFileSync(join(ECOSWAP_DIR, v.file), "utf-8");
      const cell = { v1: null as bigint | null, v12: null as bigint | null };

      for (const target of targets) {
        // Fairness: revert into the clean snapshot, re-snapshot (anvil invalidates a
        // reverted-into id), pin the next block timestamp, re-approve the cook target.
        await c.testClient.revert({ id: cleanSnapshot });
        cleanSnapshot = await c.testClient.snapshot();
        await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });

        const cookTarget = target === "v12" ? v12!.pot : stack.sauceRouter;
        // Only the FULL solvers transferFrom the caller, so they need approval.
        // Compute-only variants never move funds — approving anyway is harmless and
        // keeps the per-cell setup identical.
        await approve(c.walletClient, c.publicClient, tokenIn, cookTarget, AMOUNT_IN);

        try {
          const { bytecodes } = compileSauce(source, args, ECOSWAP_DIR, target);
          const { receipt } = await cook(c.walletClient, c.publicClient, cookTarget, bytecodes);
          if (receipt.status !== "success") {
            notes.set(`${v.key}/${target}`, `status=${receipt.status}`);
            console.log(`  ${v.key}/${target}: REVERTED (status=${receipt.status})`);
          } else {
            cell[target] = receipt.gasUsed;
            console.log(`  ${v.key}/${target}: gasUsed=${n(receipt.gasUsed)}`);
          }
        } catch (e) {
          const why = reason(e);
          notes.set(`${v.key}/${target}`, why);
          console.log(`  ${v.key}/${target}: THREW — ${why}`);
        }
      }
      gas.set(v.key, cell);
    }

    // ── Decomposition table ────────────────────────────────────
    const tpFull = gas.get("two-pass.full")!;
    const spFull = gas.get("single-pass.full")!;
    const tpComp = gas.get("two-pass.compute")!;
    const spComp = gas.get("single-pass.compute")!;

    const derive = (full: bigint | null, comp: bigint | null): bigint | null =>
      full !== null && comp !== null ? full - comp : null;

    const tpSwapV1 = derive(tpFull.v1, tpComp.v1);
    const tpSwapV12 = derive(tpFull.v12, tpComp.v12);
    const spSwapV1 = derive(spFull.v1, spComp.v1);
    const spSwapV12 = derive(spFull.v12, spComp.v12);

    const rows: [string, bigint | null, bigint | null, bigint | null, bigint | null][] = [
      ["full (with swaps)", tpFull.v1, tpFull.v12, spFull.v1, spFull.v12],
      ["compute-only (arith)", tpComp.v1, tpComp.v12, spComp.v1, spComp.v12],
      ["derived swap (full−compute)", tpSwapV1, tpSwapV12, spSwapV1, spSwapV12],
    ];

    console.log("\n=== GAS DECOMPOSITION (gasUsed) ===");
    console.log(
      "component".padEnd(30) +
        "| 2pass v1".padEnd(16) + "| 2pass v12".padEnd(16) +
        "| 1pass v1".padEnd(16) + "| 1pass v12".padEnd(16),
    );
    console.log("-".repeat(30 + 16 * 4));
    for (const [label, a, b, cc, d] of rows) {
      console.log(
        label.padEnd(30) +
          ("| " + n(a)).padEnd(16) + ("| " + n(b)).padEnd(16) +
          ("| " + n(cc)).padEnd(16) + ("| " + n(d)).padEnd(16),
      );
    }

    // ── Key comparisons ────────────────────────────────────────
    const diff = (a: bigint | null, b: bigint | null): bigint | null =>
      a !== null && b !== null ? a - b : null;
    const pct = (a: bigint | null, b: bigint | null): string =>
      a !== null && b !== null && b !== 0n
        ? `${(((Number(a) - Number(b)) / Number(b)) * 100).toFixed(1)}%`
        : "—";

    console.log("\n=== KEY COMPARISONS (single-pass − two-pass) ===");
    console.log(
      `FULL:         v1 ${n(diff(spFull.v1, tpFull.v1))} (${pct(spFull.v1, tpFull.v1)})   ` +
        `v12 ${n(diff(spFull.v12, tpFull.v12))} (${pct(spFull.v12, tpFull.v12)})`,
    );
    console.log(
      `COMPUTE-ONLY: v1 ${n(diff(spComp.v1, tpComp.v1))} (${pct(spComp.v1, tpComp.v1)})   ` +
        `v12 ${n(diff(spComp.v12, tpComp.v12))} (${pct(spComp.v12, tpComp.v12)})`,
    );
    console.log(
      `DERIVED SWAP: v1 ${n(diff(spSwapV1, tpSwapV1))}   v12 ${n(diff(spSwapV12, tpSwapV12))}`,
    );

    // Verdict heuristic: is the crossover in ARITHMETIC (compute-only) or SWAPS?
    const fullCross = diff(spFull.v1, tpFull.v1) !== null && diff(spFull.v12, tpFull.v12) !== null
      ? Number(diff(spFull.v12, tpFull.v12)) - Number(diff(spFull.v1, tpFull.v1))
      : null;
    const compCross = diff(spComp.v1, tpComp.v1) !== null && diff(spComp.v12, tpComp.v12) !== null
      ? Number(diff(spComp.v12, tpComp.v12)) - Number(diff(spComp.v1, tpComp.v1))
      : null;
    const swapCross = diff(spSwapV1, tpSwapV1) !== null && diff(spSwapV12, tpSwapV12) !== null
      ? Number(diff(spSwapV12, tpSwapV12)) - Number(diff(spSwapV1, tpSwapV1))
      : null;
    console.log(
      `\n[crossover Δ(sp−tp) from v1→v12]  full=${fullCross ?? "—"}  ` +
        `compute=${compCross ?? "—"}  swap=${swapCross ?? "—"}`,
    );
    if (compCross !== null && swapCross !== null) {
      const share = Math.abs(compCross) / (Math.abs(compCross) + Math.abs(swapCross));
      console.log(
        `[crossover attribution] arithmetic accounts for ${(share * 100).toFixed(0)}% of the v1→v12 swing`,
      );
    }
    if (notes.size > 0) {
      console.log(`\n[notes] ${[...notes].map(([k, val]) => `${k}: ${val}`).join("; ")}`);
    }

    // The whole point is the four-cell compute-only block + the two full pairs.
    assert.ok(tpFull.v1 !== null, "two-pass full v1 must execute");
    assert.ok(spFull.v1 !== null, "single-pass full v1 must execute");
    assert.ok(tpComp.v1 !== null, "two-pass compute-only v1 must execute");
    assert.ok(spComp.v1 !== null, "single-pass compute-only v1 must execute");
  });
});
