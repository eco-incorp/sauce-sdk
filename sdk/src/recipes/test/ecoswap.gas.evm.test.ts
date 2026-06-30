/**
 * EcoSwap solver GAS + BYTECODE-SIZE measurement harness.
 *
 * Measures the production UNIFIED-WALK solver (`ecoswap.sauce.ts` — one per-pool
 * live frontier merged k-way with the static route segments, reusing the
 * drift-invariant per-pool net cache) and, for a historical reference point, the
 * FROZEN unrolled-register variant (`ecoswap.unrolled.sauce.ts`). The two solvers
 * no longer share an arg shape: the unified walk takes
 *   main(tokenIn, tokenOut, amountIn, caller, priceLimit, pools, routes, netCache, routeSegs)
 * (zeroForOne is DERIVED from the token sort order on-chain; the direct-pool bracket
 * ladder is gone — each pool is walked live from its net cache), while the frozen
 * unrolled reference keeps the older
 *   main(tokenIn, tokenOut, amountIn, caller, zeroForOne, priceLimit, pools, routes, brackets)
 * shape. Each solver is therefore fed the arg array its OWN signature expects, both
 * built from the SAME off-chain `prepared`, over the full {solver × target} matrix:
 *
 *   1. EXECUTION GAS (v1 AND v12): boot a fresh anvil, deploy the deterministic
 *      3-V3-pool Phase-3 stack (and, when the v12 engine artifacts are present,
 *      the v12 stack: Router → SauceRouter → V12Kitchen → owner's V12Pot), then
 *      run ONE cook() of each solver compiled to each target and record
 *      receipt.gasUsed. v1 cooks through the SauceRouter; v12 cooks through the
 *      owner's V12Pot (which delegatecalls the Huff runtime for cook + the
 *      SauceRouter for swap callbacks, all in the Pot's context).
 *
 *   2. COMPILED BYTECODE SIZE (v1 AND v12): compile each solver to both targets
 *      and record the total blob byte length (sum of segment lengths).
 *
 * Fairness (execution gas): every cook() runs against the IDENTICAL pre-swap pool
 * state via a viem testClient anvil snapshot/revert around each cell. The cook
 * block timestamp is PINNED after each revert (setNextBlockTimestamp) — the V3
 * pool oracle accumulator depends on block.timestamp, which drifts after
 * evm_revert and otherwise makes the same bytecode against the same restored
 * state execute nondeterministically (gas varies; oversized cooks flake).
 *
 * Gated on ECO_GAS=1 (SKIPs otherwise — no anvil boot). The v12 EXECUTION cells
 * additionally require the v12 engine artifacts (V12_AVAILABLE); when absent they
 * are recorded as a blocker rather than faked. The bytecode-size axis needs no
 * chain and always covers both targets.
 *
 * Run:  cd sdk && ECO_GAS=1 npx tsx --test src/recipes/test/ecoswap.gas.evm.test.ts
 *
 * Owns + writes ONLY: this file and recipes/ecoswap/GAS.md. Tuple builders below
 * are COPIED (not imported) from recipes/ecoswap/index.ts so this harness never
 * mutates shared code.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
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
import { EcoBracketKind } from "../shared/types";
import type { EcoSwapPrepared, EcoPool, EcoRoute, EcoBracket } from "../shared/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAS_MD = join(ECOSWAP_DIR, "GAS.md");
const HUGE = parseEther("1000000000");

// ── The two solver source variants under test (DIFFERENT arg shapes) ──────
// `shape` selects which compiler-arg array the solver is fed (see buildUnifiedArgs /
// buildLegacyArgs): the production unified walk takes the netCache/routeSegs shape;
// the frozen unrolled reference keeps the older zeroForOne/brackets shape.
const SOLVERS: { key: string; file: string; label: string; shape: "unified" | "legacy" }[] = [
  {
    key: "unified-walk",
    file: "ecoswap.sauce.ts",
    label: "unified per-pool live walk + per-pool net cache, k-way merge (production solver)",
    shape: "unified",
  },
  {
    key: "unrolled",
    file: "ecoswap.unrolled.sauce.ts",
    label: "unrolled registers, prepare-time bracket ladder (FROZEN historical reference, divergent arg shape)",
    shape: "legacy",
  },
];

type Target = "v1" | "v12";
const TARGETS: Target[] = ["v1", "v12"];

// A fixed, far-future timestamp every cook block is pinned to. The cook's V3
// swaps touch the pool oracle, whose accumulator arithmetic depends on the delta
// since the last observation — so a wall-clock block timestamp makes the SAME
// bytecode against the SAME (snapshot-restored) pool state execute
// nondeterministically. Pinning makes the block context identical for every cell.
// Year ~2033, safely after the snapshot block's timestamp (setNextBlockTimestamp
// requires strictly-increasing).
const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

// ── Compile-arg builders — COPIED from recipes/ecoswap/index.ts ──
// (kept equivalent so the compiler args match what index.ts feeds the solver; do
//  NOT import — this harness must not mutate shared code.) The production solver and
//  the frozen reference have DIFFERENT signatures, so there are two builders.

// ── UNIFIED-WALK shape (production `ecoswap.sauce.ts`) ──
// Pool tuple [10..15] = the per-pool net-cache descriptors; the direct-pool bracket
// ladder is replaced by a flat per-pool netCache + a static routeSegs array.

/**
 * [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0, stateView, poolId,
 *  stepRatio, windowTopShifted, windowBotShifted, extremeShifted, netStart, netCount, isKyber]
 */
function buildUnifiedPoolTuple(p: EcoPool, netStart: number, netCount: number): bigint[] {
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
    p.stepRatio ?? 0n,
    p.windowTopShifted ?? 0n,
    p.windowBotShifted ?? 0n,
    p.extremeShifted ?? 0n,
    BigInt(netStart),
    BigInt(netCount),
    p.isKyber ? 1n : 0n,
  ];
}

/** Per-pool tuples + the flat [shiftedTick, rawNet] netCache (per-pool grouped). */
function buildPoolsAndNetCache(pools: EcoPool[]): { poolTuples: bigint[][]; netCache: bigint[][] } {
  const netCache: bigint[][] = [];
  const poolTuples: bigint[][] = [];
  for (const p of pools) {
    const rows = p.isV2 ? [] : p.netRows ?? [];
    const netStart = netCache.length;
    poolTuples.push(buildUnifiedPoolTuple(p, netStart, rows.length));
    for (const r of rows) netCache.push([r.shiftedTick, r.rawNet]);
  }
  return { poolTuples, netCache };
}

/**
 * Unified static-segment stream (route + Curve): [refIdx, capacity, sqrtAdjNear, sqrtAdjFar,
 * segKind, venue] for every Route AND Curve bracket, sorted DESC sqrtAdjNear — mirrors index.ts
 * buildRouteSegs (the production solver reads rg[4]=segKind / rg[5]=curve venue).
 */
function buildRouteSegs(prepared: EcoSwapPrepared): bigint[][] {
  const curves = prepared.curves ?? [];
  return prepared.brackets
    .filter((b) => b.kind === EcoBracketKind.Route || b.kind === EcoBracketKind.Curve)
    .slice()
    .sort((a, b) => {
      if (a.sqrtAdjNear !== b.sqrtAdjNear) return a.sqrtAdjNear < b.sqrtAdjNear ? 1 : -1;
      if (a.sqrtAdjFar !== b.sqrtAdjFar) return a.sqrtAdjFar < b.sqrtAdjFar ? 1 : -1;
      return a.refIdx - b.refIdx;
    })
    .map((b) => {
      const isCurve = b.kind === EcoBracketKind.Curve;
      const venue = isCurve ? BigInt(curves[b.refIdx].address) : 0n;
      return [BigInt(b.refIdx), b.capacity, b.sqrtAdjNear, b.sqrtAdjFar, isCurve ? 1n : 0n, venue];
    });
}

/** [inter, h1Type,h1Pool,h1Fee,h1TS,h1Hooks, h2Type,h2Pool,h2Fee,h2TS,h2Hooks] (both shapes). */
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

/** Production unified-walk arg array (9 args; no zeroForOne — derived on-chain). */
function buildUnifiedArgs(
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  prepared: EcoSwapPrepared,
): unknown[] {
  const { poolTuples, netCache } = buildPoolsAndNetCache(prepared.pools);
  return [
    BigInt(tokenIn),
    BigInt(tokenOut),
    amountIn,
    BigInt(caller),
    prepared.priceLimit,
    poolTuples,
    prepared.routes.map(buildRouteTuple),
    netCache,
    buildRouteSegs(prepared),
  ];
}

// ── LEGACY shape (frozen `ecoswap.unrolled.sauce.ts` reference) ──
// The unrolled reference reads only pool tuple [0..9] and the prepare-time bracket
// ladder; it predates the unified walk's per-pool net cache. The 16-field tuple is
// kept so the positional reads line up, with the now-removed [10..15] fields zeroed
// (inert for the frozen reference — it never reads them).

/** [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0, stateView, poolId, 0×6] */
function buildLegacyPoolTuple(p: EcoPool): bigint[] {
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
    0n, 0n, 0n, 0n, 0n, 0n,
  ];
}

/** [kind, refIdx, sqrtNear, sqrtFar, liquidity, capacity, sqrtAdjNear, sqrtAdjFar] */
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

/** Frozen unrolled-reference arg array (9 args; zeroForOne + bracket ladder). */
function buildLegacyArgs(
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
    prepared.pools.map(buildLegacyPoolTuple),
    prepared.routes.map(buildRouteTuple),
    prepared.brackets.map(buildBracketTuple),
  ];
}

/** Pick the arg array the given solver's signature expects. */
function argsForShape(
  shape: "unified" | "legacy",
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  prepared: EcoSwapPrepared,
): unknown[] {
  return shape === "unified"
    ? buildUnifiedArgs(tokenIn, tokenOut, amountIn, caller, prepared)
    : buildLegacyArgs(tokenIn, tokenOut, amountIn, caller, prepared);
}

/** Total compiled blob size in bytes (sum of segment hex lengths). */
function blobBytes(bytecodes: Hex[]): number {
  return bytecodes.reduce((sum, seg) => sum + (seg.length - 2) / 2, 0);
}

// ── Results, filled during the run, rendered into GAS.md ───────
// Each cell is null until measured; a per-cell try/catch records failures as
// notes (a target a variant cannot compile to, or a cook() revert) instead of
// aborting the whole table — a comparison harness must surface a variant that
// fails on one axis, not collapse.
interface Cell {
  v1: number | bigint | null;
  v12: number | bigint | null;
}
const sizeBytes = new Map<string, Cell>(); // solver.key -> {v1,v12} byte sizes
const execGas = new Map<string, Cell>(); // solver.key -> {v1,v12} gasUsed
const sizeNotes = new Map<string, string>(); // "solver/target" -> failure reason
const execNotes = new Map<string, string>(); // "solver/target" -> cook() failure reason
const AMOUNT_IN = parseEther("5000");
let executionRan = false;
let executionBlocker = "";
let v12ExecAvailable = false;
let v12ExecBlocker = "";

function fmtGas(g: bigint | number | null, note?: string): string {
  if (g !== null) return g.toLocaleString("en-US");
  return note ? "reverted" : "—";
}
function fmtBytes(b: bigint | number | null, note?: string): string {
  if (b !== null) return `${b.toLocaleString("en-US")} B`;
  return note ? "did not compile" : "—";
}

/**
 * Short one-line reason from an arbitrary thrown value. For viem revert errors
 * the raw selector lives a few lines into the message ("custom error 0x...") —
 * pull it out so the report carries the actual engine error, not just the
 * generic "reverted with the following signature" preamble.
 */
function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const sel = msg.match(/0x[0-9a-fA-F]{8}/);
  const detail = msg.match(/custom error (0x[0-9a-fA-F]+(?::\s*[0-9a-fA-F]+)?)/);
  if (detail) return `cook() reverted, ${detail[1].replace(/\s+/g, "")}`;
  if (sel && /revert/i.test(msg)) return `cook() reverted, selector ${sel[0]}`;
  return msg.split("\n")[0].slice(0, 200);
}

/** Percent reduction of `to` vs `from` (e.g. v12 vs v1), or null if not both. */
function pctSmaller(from: number | bigint | null, to: number | bigint | null): string | null {
  if (from === null || to === null) return null;
  const f = Number(from);
  const t = Number(to);
  if (f === 0) return null;
  const pct = ((f - t) / f) * 100;
  return `${pct >= 0 ? "" : "+"}${Math.abs(pct).toFixed(0)}% ${pct >= 0 ? "smaller" : "larger"}`;
}

/** Render GAS.md. Called once at the end of the run. */
function writeGasMd(): void {
  const lines: string[] = [];
  lines.push("# EcoSwap solver gas + bytecode-size comparison");
  lines.push("");
  lines.push(
    "Generated by `src/recipes/test/ecoswap.gas.evm.test.ts` (gated on `ECO_GAS=1`).",
  );
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    "Two EcoSwap solver source variants are measured. They have DIFFERENT arg shapes — " +
      "each is fed the compiler-arg array its own `main()` signature expects, both built " +
      "from the SAME off-chain `prepared` (`index.ts` always compiles the production " +
      "`ecoswap.sauce.ts`):",
  );
  lines.push("");
  for (const s of SOLVERS) {
    lines.push(`- **${s.key}** — \`recipes/ecoswap/${s.file}\` — ${s.label}`);
  }
  lines.push("");
  lines.push(
    "The production solver signature is " +
      "`main(tokenIn, tokenOut, amountIn, caller, priceLimit, pools, routes, netCache, routeSegs)` " +
      "— `zeroForOne` is DERIVED on-chain from the token sort order, and the direct-pool " +
      "bracket ladder is replaced by a per-pool `netCache` (drift-invariant tick nets reused " +
      "by a live walk) plus a static `routeSegs` array. The frozen unrolled reference keeps " +
      "the older `…, zeroForOne, priceLimit, pools, routes, brackets` shape; it is no longer " +
      "the production solver and is kept only as a historical bytecode-size / gas data point.",
  );
  lines.push("");
  lines.push(
    "**Stack** (deterministic, no fork): a fresh `anvil` with Multicall3 etched, " +
      "the Sauce engine (`Router` → `SauceRouter`), two `MintableERC20` tokens " +
      "(sorted token0/token1), and **three Uniswap V3 pools** all initialized at " +
      "`SQRT_PRICE_1_1`, fees `[500, 3000, 10000]`, liquidity `[400000, 250000, " +
      "150000]` ether, each a single wide position over ticks ±12000. Discovery " +
      "config = one local UniV3 factory, `feeTiers [500, 3000, 10000]`, " +
      "`baseTokens = [tokenIn, tokenOut]` (zero routes — pure direct-pool split).",
  );
  lines.push("");
  lines.push(
    `**amountIn** = \`${AMOUNT_IN.toString()}\` wei (\`parseEther("5000")\`) — the ` +
      "Phase-3 size that splits across the pools.",
  );
  lines.push("");
  lines.push(
    "**Same prepared data for both variants.** `ecoSwap(...)` runs the off-chain " +
      "prepare ONCE; the resulting `prepared` (pools/routes/brackets/net cache/" +
      "priceLimit) is turned into the compiler-arg array EACH solver's signature " +
      "expects — the production unified walk gets the `pools`/`netCache`/`routeSegs` " +
      "shape (builders copied verbatim from `index.ts`), the frozen unrolled reference " +
      "gets the legacy `pools`/`brackets` shape. Both derive from the same `prepared`, " +
      "so the only variables are the solver source, its arg shape, and the bytecode target.",
  );
  lines.push("");
  lines.push(
    "**Targets.** The compiler emits two surfaces: **v1** (prefix bytecode for the " +
      "Solidity `Router`) and **v12** (postfix Huff runtime). Both are compiled for " +
      "the size table and both are EXECUTED for the gas table: v1 cooks through the " +
      "`SauceRouter`; v12 cooks through the owner's `V12Pot` (Router → SauceRouter → " +
      "V12Kitchen → Pot), whose `cook(bytes[])` delegatecalls the Huff runtime for " +
      "the program and the SauceRouter for swap self-calls / pool callbacks — all in " +
      "the Pot's context. The recipe `caller` approves the cook target (SauceRouter " +
      "for v1, the Pot for v12) since the program does `transferFrom(caller, self, …)`.",
  );
  lines.push("");
  lines.push(
    "**Execution-gas fairness.** Every cook() runs against the IDENTICAL pre-swap " +
      "pool state. A fresh viem `testClient` anvil snapshot is taken once after " +
      "setup; before each cell the chain is reverted into it and re-snapshotted " +
      "(anvil invalidates a snapshot id once reverted to), the cook block timestamp " +
      `is PINNED to \`${COOK_BLOCK_TIMESTAMP}\` (\`setNextBlockTimestamp\` — the V3 ` +
      "oracle accumulator depends on `block.timestamp`, which drifts after revert and " +
      "otherwise makes the same bytecode flake), and the cook target is re-approved. " +
      "`receipt.gasUsed` is recorded per cell; a cook() that reverts is recorded as " +
      "such rather than aborting the comparison.",
  );
  lines.push("");

  // Table 1 — execution gas (v1 + v12)
  lines.push("## Table 1 — execution gas (`receipt.gasUsed`)");
  lines.push("");
  if (!executionRan) {
    lines.push(
      `_Execution gas unavailable: ${executionBlocker || "anvil/forge not available"}._`,
    );
    lines.push("");
  }
  if (executionRan && !v12ExecAvailable) {
    lines.push(`> v12 execution unavailable: ${v12ExecBlocker}`);
    lines.push("");
  }
  lines.push("| Solver variant | v1 gasUsed | v12 gasUsed | v12 − v1 | Notes |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const s of SOLVERS) {
    const cell = execGas.get(s.key) ?? { v1: null, v12: null };
    const v1Note = execNotes.get(`${s.key}/v1`);
    const v12Note = execNotes.get(`${s.key}/v12`);
    let delta = "—";
    if (cell.v1 !== null && cell.v12 !== null) {
      const d = BigInt(cell.v12) - BigInt(cell.v1);
      delta = `${d >= 0n ? "+" : ""}${d.toLocaleString("en-US")}`;
    }
    const notes: string[] = [];
    if (v1Note) notes.push(`v1: ${v1Note}`);
    if (v12Note) notes.push(`v12: ${v12Note}`);
    lines.push(
      `| ${s.key} | ${fmtGas(cell.v1, v1Note)} | ${fmtGas(cell.v12, v12Note)} | ${delta} | ${notes.join("; ")} |`,
    );
  }
  lines.push("");

  // Table 2 — bytecode size
  lines.push("## Table 2 — compiled bytecode size (total blob bytes)");
  lines.push("");
  lines.push("| Solver variant | v1 size | v12 size | v12 − v1 | Notes |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const s of SOLVERS) {
    const cell = sizeBytes.get(s.key) ?? { v1: null, v12: null };
    const v1Note = sizeNotes.get(`${s.key}/v1`);
    const v12Note = sizeNotes.get(`${s.key}/v12`);
    let delta = "—";
    if (cell.v1 !== null && cell.v12 !== null) {
      const d = Number(cell.v12) - Number(cell.v1);
      delta = `${d >= 0 ? "+" : ""}${d.toLocaleString("en-US")} B`;
    }
    const notes: string[] = [];
    if (v1Note) notes.push(`v1: ${v1Note}`);
    if (v12Note) notes.push(`v12: ${v12Note}`);
    lines.push(
      `| ${s.key} | ${fmtBytes(cell.v1, v1Note)} | ${fmtBytes(cell.v12, v12Note)} | ${delta} | ${notes.join("; ")} |`,
    );
  }
  lines.push("");

  // Takeaways — assembled from whatever was actually measured this run.
  const arrSize = sizeBytes.get("unified-walk");
  const unrSize = sizeBytes.get("unrolled");
  const arrGas = execGas.get("unified-walk");
  const unrGas = execGas.get("unrolled");
  const bullets: string[] = [];

  // Unified walk vs frozen unrolled reference (size).
  if (arrSize && unrSize && arrSize.v1 !== null && unrSize.v1 !== null) {
    const cmp = Number(arrSize.v1) < Number(unrSize.v1) ? "smaller" : Number(arrSize.v1) === Number(unrSize.v1) ? "equal" : "larger";
    bullets.push(
      `**Unified walk vs frozen unrolled reference (size).** The production unified-walk solver ` +
        `(v1 ${Number(arrSize.v1).toLocaleString("en-US")} B) is ${cmp} than the ` +
        `frozen unrolled-register reference (v1 ${Number(unrSize.v1).toLocaleString("en-US")} B). ` +
        "The two are DIFFERENT programs (different arg shapes), so this is a coarse code-density " +
        "reference, not a like-for-like swap.",
    );
  }
  // Unified walk vs frozen reference (gas), if both executed.
  if (arrGas && unrGas && arrGas.v1 !== null && unrGas.v1 !== null) {
    const cmp = BigInt(arrGas.v1) < BigInt(unrGas.v1) ? "less" : BigInt(arrGas.v1) === BigInt(unrGas.v1) ? "equal" : "more";
    bullets.push(
      `**Unified walk vs frozen reference (v1 gas).** The unified walk uses ${cmp} gas ` +
        `(${Number(arrGas.v1).toLocaleString("en-US")}) than the frozen unrolled reference ` +
        `(${Number(unrGas.v1).toLocaleString("en-US")}) — different programs, so a coarse reference only.`,
    );
  }
  // v1 vs v12 size.
  if (arrSize && arrSize.v1 !== null && arrSize.v12 !== null) {
    const pct = pctSmaller(arrSize.v1, arrSize.v12);
    bullets.push(
      `**v12 vs v1 (size).** v12 (postfix Huff) is markedly smaller than v1 (prefix) — ` +
        `e.g. the unified walk ${Number(arrSize.v12).toLocaleString("en-US")} B vs ` +
        `${Number(arrSize.v1).toLocaleString("en-US")} B${pct ? ` (${pct})` : ""}.`,
    );
  }
  // v1 vs v12 gas — the headline the whole port is about.
  const gasV1V12: string[] = [];
  for (const s of SOLVERS) {
    const cell = execGas.get(s.key);
    if (cell && cell.v1 !== null && cell.v12 !== null) {
      const pct = pctSmaller(cell.v1, cell.v12);
      gasV1V12.push(
        `${s.key} ${Number(cell.v12).toLocaleString("en-US")} (v12) vs ` +
          `${Number(cell.v1).toLocaleString("en-US")} (v1)${pct ? `, ${pct}` : ""}`,
      );
    }
  }
  if (gasV1V12.length > 0) {
    bullets.push(`**v12 vs v1 (execution gas).** ${gasV1V12.join("; ")}.`);
  } else if (executionRan && !v12ExecAvailable) {
    bullets.push(
      `**v12 vs v1 (execution gas).** v12 execution could not run this session: ${v12ExecBlocker}.`,
    );
  }
  // Compile/exec coverage caveats.
  const execFails = [...execNotes.keys()];
  if (execFails.length > 0) {
    bullets.push(
      `**Coverage.** Some execution cells reverted: ${execFails
        .map((k) => `${k} (${execNotes.get(k)})`)
        .join("; ")}.`,
    );
  }
  if (bullets.length === 0) {
    bullets.push("**Takeaway.** Insufficient measurements this run (see the blockers above).");
  }
  lines.push("## Takeaways");
  lines.push("");
  for (const b of bullets) lines.push(`- ${b}`);
  lines.push("");

  writeFileSync(GAS_MD, lines.join("\n"), "utf-8");
}

describe("EcoSwap solver gas + bytecode-size comparison", () => {
  if (!process.env.ECO_GAS) {
    it("skipped (set ECO_GAS=1 to run)", () => {
      // No anvil boot, no compilation — opt-in only.
    });
    return;
  }

  let anvil: AnvilHandle | undefined;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let poolConfig: ChainPoolConfig;
  let prepared: EcoSwapPrepared;
  let caller: Hex;
  let chainSetupFailed = false;
  let cleanSnapshot: Hex;

  before(async () => {
    // Boot the deterministic 3-V3-pool Phase-3 stack (mirrors ecoswap.evm.test.ts).
    try {
      anvil = await startAnvil();
      c = await makeClients(anvil.rpcUrl);
      await ensureMulticall3(c.publicClient, c.testClient);
      stack = await deployStack(c.walletClient, c.publicClient);
      const tk = await deploySortedTokens(c.walletClient, c.publicClient);
      tokenIn = tk.token0;
      tokenOut = tk.token1;
      caller = c.account0;

      // Fund + approve the minter for both tokens.
      const minter = c.account0;
      await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("50000000"));
      await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("50000000"));
      await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
      await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

      // Three V3 pools — same 1:1 price, different fee tier + depth → forces split.
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

      poolConfig = {
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

      // v12 engine stack (same anvil, same pools). The Pot is owned by account0
      // (the cook caller); account0 approves the POT for tokenIn since the v12
      // program does transferFrom(caller, self=Pot, …). Deployed only when the v12
      // artifacts are present — else v12 EXECUTION cells record a blocker.
      if (V12_AVAILABLE) {
        const owner = c.walletClient.account as Account;
        v12 = await deployV12Stack(c.walletClient, c.publicClient, owner);
        await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);
        v12ExecAvailable = true;
      } else {
        v12ExecBlocker =
          "v12 engine artifacts missing (V12Kitchen/V12Pot/V12RuntimeBytecode) — " +
          "pin the engine to the v12 branch and run sync-artifacts";
      }

      // Run the off-chain prepare ONCE — shared across every variant + target.
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
      executionBlocker = `anvil/forge stack setup failed: ${String(e)}`;
      anvil?.stop();
      anvil = undefined;
    }
  });

  after(() => {
    anvil?.stop();
    // Emit the report regardless of which axes succeeded.
    writeGasMd();
  });

  // ── Bytecode size (both targets) — works WITHOUT a chain ───────
  it("compiles every solver variant to v1 and v12 (bytecode size)", () => {
    if (chainSetupFailed || !prepared) {
      // Without prepared data we cannot build representative args; record the
      // blocker and skip (Table 2 will show dashes). assert.ok keeps node:test
      // from flagging an empty test as a silent pass.
      assert.ok(true, "size axis skipped: prepared data unavailable");
      return;
    }
    for (const s of SOLVERS) {
      const args = argsForShape(s.shape, tokenIn, tokenOut, AMOUNT_IN, caller, prepared);
      const source = readFileSync(join(ECOSWAP_DIR, s.file), "utf-8");
      const cell: Cell = { v1: null, v12: null };
      for (const target of TARGETS) {
        // Per-cell try/catch: a variant that cannot compile to one target (a real
        // finding) must not abort the rest of the table.
        try {
          const { bytecodes } = compileSauce(source, args, ECOSWAP_DIR, target);
          assert.ok(bytecodes.length >= 1, `${s.key}/${target} produced no bytecode`);
          cell[target] = blobBytes(bytecodes);
        } catch (e) {
          const why = reason(e);
          sizeNotes.set(`${s.key}/${target}`, why);
          console.log(`  [size] ${s.key}/${target}: FAILED — ${why}`);
        }
      }
      sizeBytes.set(s.key, cell);
      console.log(`  [size] ${s.key}: v1=${cell.v1 ?? "FAIL"}B v12=${cell.v12 ?? "FAIL"}B`);
    }

    // The production unified-walk solver must compile to BOTH targets.
    const arr = sizeBytes.get("unified-walk")!;
    assert.ok(arr.v1 !== null, "unified-walk must compile to v1");
    assert.ok(arr.v12 !== null, "unified-walk must compile to v12");
  });

  // ── Execution gas (v1 + v12) — fairness via snapshot/revert + pinned ts ──
  it("runs cook() of each solver × target against identical state (execution gas)", async () => {
    if (chainSetupFailed || !prepared) {
      assert.ok(true, `execution gas skipped: ${executionBlocker}`);
      return;
    }

    // Engines we can actually execute this session.
    const engines: Target[] = v12ExecAvailable ? ["v1", "v12"] : ["v1"];

    for (const s of SOLVERS) {
      const args = argsForShape(s.shape, tokenIn, tokenOut, AMOUNT_IN, caller, prepared);
      const source = readFileSync(join(ECOSWAP_DIR, s.file), "utf-8");
      const cell: Cell = execGas.get(s.key) ?? { v1: null, v12: null };

      for (const engine of engines) {
        // FAIRNESS: every cell cooks against the IDENTICAL pre-swap pool state with
        // an IDENTICAL block context. Revert into the clean snapshot, re-snapshot
        // (anvil invalidates a reverted-into id), pin the next block timestamp, and
        // re-approve the cook target (approval is part of the reverted state).
        await c.testClient.revert({ id: cleanSnapshot });
        cleanSnapshot = await c.testClient.snapshot();
        await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });

        // cook() target: v1 → SauceRouter, v12 → owner's V12Pot.
        const cookTarget = engine === "v12" ? v12!.pot : stack.sauceRouter;
        await approve(c.walletClient, c.publicClient, tokenIn, cookTarget, AMOUNT_IN);

        try {
          const { bytecodes } = compileSauce(source, args, ECOSWAP_DIR, engine);
          const { receipt } = await cook(c.walletClient, c.publicClient, cookTarget, bytecodes);
          if (receipt.status !== "success") {
            execNotes.set(`${s.key}/${engine}`, `cook() status=${receipt.status}`);
            console.log(`  [gas] ${s.key}/${engine}: cook() reverted (status=${receipt.status})`);
          } else {
            cell[engine] = receipt.gasUsed;
            console.log(`  [gas] ${s.key}/${engine}: gasUsed=${receipt.gasUsed}`);
          }
        } catch (e) {
          const why = reason(e);
          execNotes.set(`${s.key}/${engine}`, why);
          console.log(`  [gas] ${s.key}/${engine}: cook() THREW — ${why}`);
        }
      }
      execGas.set(s.key, cell);
    }

    executionRan = true;

    // At least one cell must have executed — otherwise the stack/engine is broken,
    // not an individual solver. (Individual reverts are recorded as notes and
    // surfaced in the report; an in-progress variant reverting must not collapse
    // the whole comparison.)
    const measured: bigint[] = [];
    for (const s of SOLVERS) {
      const cell = execGas.get(s.key)!;
      if (cell.v1 !== null) measured.push(BigInt(cell.v1));
      if (cell.v12 !== null) measured.push(BigInt(cell.v12));
    }
    assert.ok(measured.length >= 1, "at least one solver/target cell must execute");
  });
});
