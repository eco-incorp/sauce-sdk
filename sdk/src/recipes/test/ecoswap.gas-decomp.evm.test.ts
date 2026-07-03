/**
 * EcoSwap GAS DECOMPOSITION harness (analysis only — gate ECO_GAS=1).
 *
 * Goal: measure the production UNIFIED-WALK solver's full cook gas on both bytecode
 * targets (v1 Solidity Router and v12 Huff runtime), and contrast it against a
 * FROZEN compute-only floor for a coarse arithmetic-vs-swap split.
 *
 * Method — on the deterministic 3-V3-pool Phase-3 stack (copied from
 * ecoswap.gas.evm.test.ts), measure cook `gasUsed` for:
 *   - FULL production solver (with swaps): ecoswap.sauce.ts (unified walk) × {v1, v12}
 *   - COMPUTE-ONLY FROZEN reference (no transferFrom/swap/transfer; returns a cheap
 *     summary): ecoswap.computeonly.sauce.ts × {v1, v12}
 *
 * IMPORTANT: the two solvers no longer share an arg shape OR an algorithm. The unified
 * walk takes the per-pool net-cache shape (no zeroForOne, no bracket ladder); the
 * frozen compute-only variant keeps the OLD register-bank shape (zeroForOne + bracket
 * ladder). Each is fed the arg array its own signature expects, both from the SAME
 * `prepared`. Because they are DIFFERENT programs, the `full − compute` line is a
 * COARSE swap-cost reference, NOT the unified walk's own arithmetic-vs-swap split — it
 * is reported as such and never asserted on.
 *
 * Fairness mirrors the gas test: per-cell anvil snapshot/revert + pinned cook block
 * timestamp (the V3 oracle accumulator depends on block.timestamp). Full solvers
 * transferFrom the caller, so the cook target is approved per cell; compute-only
 * variants need no approval (they never move funds) but are run through the same
 * submitted-tx cook() path so `receipt.gasUsed` is apples-to-apples.
 *
 * Does NOT write any report file and does NOT modify the real solvers, the existing
 * gas test/harness, or the compiler. Prints the decomposition table + verdict to
 * the console. Run:
 *   cd sdk && ECO_GAS=1 npx tsx --test src/recipes/test/ecoswap.gas-decomp.evm.test.ts
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
import { ecoSwap, buildSolverArgs, protocolDefines } from "../ecoswap/index";
import { EcoBracketKind } from "../shared/types";
import type { EcoSwapPrepared, EcoPool, EcoRoute, EcoBracket } from "../shared/types";

const HUGE = parseEther("1000000000");
const AMOUNT_IN = parseEther("5000");
const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

type Target = "v1" | "v12";

// ── The two variants: FULL unified walk (with swaps) + frozen COMPUTE-ONLY floor ──
// They have DIFFERENT arg shapes ("unified" vs "legacy"); see the builders below.
interface Variant {
  key: string;
  file: string;
  kind: "full" | "compute";
  shape: "unified" | "legacy";
}
const VARIANTS: Variant[] = [
  { key: "unified-walk.full", file: "ecoswap.sauce.ts", kind: "full", shape: "unified" },
  { key: "frozen.compute", file: "ecoswap.computeonly.sauce.ts", kind: "compute", shape: "legacy" },
];

// ── Compile-arg builders ──
// The production unified-walk shape is IMPORTED from index.ts (buildSolverArgs + protocolDefines) so
// it can never drift from what a real cook feeds the solver (the old local 4-arg copy went stale
// through the quote-ladder migration). The frozen compute-only reference keeps its own legacy builder.

// ── LEGACY shape (frozen ecoswap.computeonly.sauce.ts reference) ──
/** [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0, stateView, poolId, 0×6] */
function buildLegacyPoolTuple(p: EcoPool): bigint[] {
  return [
    BigInt(p.poolType), BigInt(p.address), BigInt(p.fee), BigInt(p.tickSpacing),
    BigInt(p.hooks), BigInt(p.feePpm), p.isV2 ? 1n : 0n, p.inIsToken0 ? 1n : 0n,
    BigInt(p.stateView), BigInt(p.poolId), 0n, 0n, 0n, 0n, 0n, 0n,
  ];
}

function buildBracketTuple(b: EcoBracket): bigint[] {
  return [
    BigInt(b.kind), BigInt(b.refIdx), b.sqrtNear, b.sqrtFar,
    b.liquidity, b.capacity, b.sqrtAdjNear, b.sqrtAdjFar,
  ];
}

/**
 * FROZEN legacy route tuple (maps each hop to its leg's FIRST pool — the frozen reference predates
 * multi-pool legs; the gas-decomp fixture prepares zero routes, so this is only for shape/typecheck).
 */
function buildLegacyRouteTuple(r: EcoRoute): bigint[] {
  const h1 = r.legs[0].pools[0];
  const h2 = r.legs[r.legs.length - 1].pools[0];
  const inter = r.intermediateTokens[0] ?? ("0x0" as Hex);
  return [
    BigInt(inter), BigInt(h1.poolType), BigInt(h1.address), BigInt(h1.fee), 0n, 0n,
    BigInt(h2.poolType), BigInt(h2.address), BigInt(h2.fee), 0n, 0n,
  ];
}

function buildLegacyArgs(
  tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, prepared: EcoSwapPrepared,
): unknown[] {
  return [
    BigInt(tokenIn), BigInt(tokenOut), amountIn, BigInt(caller),
    prepared.zeroForOne ? 1n : 0n, prepared.priceLimit,
    prepared.pools.map(buildLegacyPoolTuple), prepared.routes.map(buildLegacyRouteTuple),
    prepared.brackets.map(buildBracketTuple),
  ];
}

/**
 * Arg array + compile options for a variant. The production unified walk uses the IMPORTED
 * `buildSolverArgs` compiled with the SAME treeshake + protocol defines a real cook carries; the
 * frozen compute-only reference has no HAS_* guards, so it compiles without defines.
 */
function argsForShape(
  shape: "unified" | "legacy",
  tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, prepared: EcoSwapPrepared,
): { args: unknown[]; opts: { treeshake?: boolean; defines?: Record<string, boolean> } } {
  if (shape === "unified") {
    return {
      args: buildSolverArgs(tokenIn, tokenOut, amountIn, caller, prepared),
      opts: { treeshake: true, defines: protocolDefines(prepared) },
    };
  }
  return { args: buildLegacyArgs(tokenIn, tokenOut, amountIn, caller, prepared), opts: {} };
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

  it("measures unified-walk full + frozen compute-only cook gas × {v1, v12}", async () => {
    if (chainSetupFailed || !prepared) {
      assert.fail(`stack setup failed: ${setupErr}`);
    }
    const targets: Target[] = v12ExecAvailable ? ["v1", "v12"] : ["v1"];
    const netRows = prepared.pools.reduce((s, p) => s + (p.netRows?.length ?? 0), 0);

    console.log(
      `\n[gas-decomp] amountIn=${AMOUNT_IN} pools=${prepared.pools.length} ` +
        `netRows=${netRows} routeSegs=${prepared.brackets.filter((b) => b.kind === EcoBracketKind.Route).length} ` +
        `routes=${prepared.routes.length} v12=${v12ExecAvailable}\n`,
    );

    for (const v of VARIANTS) {
      const { args, opts } = argsForShape(v.shape, tokenIn, tokenOut, AMOUNT_IN, caller, prepared);
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
          const { bytecodes } = compileSauce(source, args, ECOSWAP_DIR, target, opts);
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

    // ── Decomposition table (unified-walk full vs frozen compute-only floor) ──
    const spFull = gas.get("unified-walk.full")!;
    const spComp = gas.get("frozen.compute")!;

    const derive = (full: bigint | null, comp: bigint | null): bigint | null =>
      full !== null && comp !== null ? full - comp : null;

    const spSwapV1 = derive(spFull.v1, spComp.v1);
    const spSwapV12 = derive(spFull.v12, spComp.v12);

    const rows: [string, bigint | null, bigint | null][] = [
      ["unified walk (with swaps)", spFull.v1, spFull.v12],
      ["frozen compute-only floor", spComp.v1, spComp.v12],
      ["full − frozen floor (coarse)", spSwapV1, spSwapV12],
    ];

    console.log("\n=== UNIFIED-WALK GAS vs FROZEN COMPUTE-ONLY FLOOR (gasUsed) ===");
    console.log("NOTE: the two are DIFFERENT programs (different arg shapes + algorithm) —");
    console.log("the last row is a COARSE swap-cost reference, NOT the unified walk's own split.");
    console.log("component".padEnd(32) + "| v1".padEnd(16) + "| v12".padEnd(16));
    console.log("-".repeat(32 + 16 * 2));
    for (const [label, a, b] of rows) {
      console.log(label.padEnd(32) + ("| " + n(a)).padEnd(16) + ("| " + n(b)).padEnd(16));
    }

    // ── Coarse arithmetic vs swap share, per target (cross-program reference) ──
    const pctOf = (part: bigint | null, whole: bigint | null): string =>
      part !== null && whole !== null && whole !== 0n
        ? `${((Number(part) / Number(whole)) * 100).toFixed(0)}%`
        : "—";
    console.log("\n=== COARSE SHARE (frozen floor / unified-walk full) ===");
    console.log(`v1:  floor ${pctOf(spComp.v1, spFull.v1)}  above-floor ${pctOf(spSwapV1, spFull.v1)}`);
    console.log(`v12: floor ${pctOf(spComp.v12, spFull.v12)}  above-floor ${pctOf(spSwapV12, spFull.v12)}`);

    if (notes.size > 0) {
      console.log(`\n[notes] ${[...notes].map(([k, val]) => `${k}: ${val}`).join("; ")}`);
    }

    // The decomposition needs the unified-walk full + frozen compute-only cells.
    assert.ok(spFull.v1 !== null, "unified-walk full v1 must execute");
    assert.ok(spComp.v1 !== null, "frozen compute-only v1 must execute");
  });
});
