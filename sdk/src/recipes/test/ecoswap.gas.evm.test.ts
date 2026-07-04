/**
 * EcoSwap solver GAS + BYTECODE-SIZE measurement harness.
 *
 * Measures the production UNIFIED-WALK solver (`ecoswap.sauce.ts` — one per-pool
 * live frontier merged k-way with the quote-ladder venue streams, reusing the
 * drift-invariant per-pool net cache) and, for a historical reference point, the
 * FROZEN unrolled-register variant (`ecoswap.unrolled.sauce.ts`). The two solvers
 * no longer share an arg shape: the unified walk takes the production 6-arg
 *   main(cfg, pools, netCache, routing, segs, qlv)
 * shape (13-scalar cfg incl. cfg[12]=directQlvCount; stride-5 scalar routing;
 * 12-column qlv rows partitioned direct-then-leg — see index.ts buildSolverArgs,
 * IMPORTED here), while the frozen unrolled reference keeps the older
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
  deployToken,
  createAndInitPool,
  mint,
  approve,
  mintPosition,
  getSlot0,
  getLiquidity,
  deployCurveStableSwap,
  deployMaverickV2Pool,
  deployWooFiPool,
  deployEulerSwapPool,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
  type MaverickDeployParams,
  type EulerSwapParams,
} from "./harness/setup";
import {
  MIN_SQRT_RATIO,
  SwapPoolType,
  FactoryType,
  type ChainPoolConfig,
} from "../shared/constants";
import { ecoSwap, buildSolverArgs, protocolDefines } from "../ecoswap/index";
import { EcoBracketKind } from "../shared/types";
import type {
  EcoSwapPrepared,
  EcoPool,
  EcoRoute,
  EcoBracket,
  EcoLegQlVenue,
} from "../shared/types";
import { getSqrtRatioAtTick, OFFSET } from "./ecoswap.math";
import {
  getTickL,
  getSqrtPrice,
  tickSqrtPrices,
  type MaverickTick,
} from "../shared/maverick-math";

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

// Quote-ladder geometric slice count — MUST equal ecoswap.sauce.ts QL_S. The per-venue ladder-build
// cost is bounded to ≤ 2·QL_S view staticcalls (QL_2S): the revert-class views are probe-then-decode
// (an unconditional `.catch` PROBE call + a guarded DECODE call = 2 staticcalls/slice), only the
// graceful single-return views (WOOFi tryQuery, Fluid estimateSwapIn) cost 1/slice = QL_S. Kept here
// only to render Table 3 of GAS.md.
const QL_S = 8;
const QL_2S = 2 * QL_S;

// The 14 QUOTE-LADDER venue families (mirrors buildQLVenues in index.ts). segKind + the per-slice
// view quote getter + the ladder-build staticcall bound + the on-chain execution path. The revert-class
// probe-then-decode venues (Curve/…/Euler) cost up to 2·QL_S staticcalls; the graceful single-return
// views (WOOFi tryQuery; Fluid resolver estimateSwapIn — a CALL, not a staticcall, that returns 0 past
// the live utilization cap) cost QL_S; the three REPLAY families (Balancer V2/V3, Maverick) have no
// cumulative-out view, so they read a bounded set of LIVE state and replay the curve on-chain.
const QL_VENUE_ROWS: { venue: string; segKind: number; quote: string; calls: string; exec: string }[] = [
  { venue: "Curve StableSwap", segKind: 1, quote: "get_dy(i, j, xNext) (probe-decode, revert-class)", calls: `≤ ${QL_2S}`, exec: "swap(poolType 3) → _swapCurve" },
  { venue: "Curve CryptoSwap", segKind: 9, quote: "get_dy(uint256 i, j, xNext) (probe-decode, revert-class)", calls: `≤ ${QL_2S}`, exec: "approve + exchange (callback-free)" },
  { venue: "Solidly STABLE", segKind: 4, quote: "getAmountOut(xNext, tokenIn) (probe-decode)", calls: `≤ ${QL_2S}`, exec: "transfer + pool.swap (callback-free)" },
  { venue: "WOOFi (WooPPV2)", segKind: 10, quote: "tryQuery(tokenIn, tokenOut, xNext) (graceful, 1 call)", calls: `${QL_S}`, exec: "query + transfer + swap (callback-free)" },
  { venue: "Trader Joe LB", segKind: 2, quote: "getSwapOut(xNext, swapForY) → [0] amountInLeft + [1] out (2 calls)", calls: `≤ ${QL_2S}`, exec: "swap(poolType 6) → _swapTraderJoeLB" },
  { venue: "Mento V2", segKind: 13, quote: "broker.getAmountOut(provider, id, in, out, xNext) (probe-decode)", calls: `≤ ${QL_2S}`, exec: "approve broker + broker.swapIn" },
  { venue: "DODO V2", segKind: 3, quote: "querySellBase/Quote(caller, xNext) (probe-decode)", calls: `≤ ${QL_2S}`, exec: "swap(poolType 5) → _swapDODOV2" },
  { venue: "Wombat", segKind: 5, quote: "quotePotentialSwap(in, out, xNext) (probe-decode)", calls: `≤ ${QL_2S}`, exec: "approve + pool.swap (callback-free)" },
  { venue: "Fermi / propAMM", segKind: 11, quote: "quoteAmounts(in, out, xNext)[1] (probe-decode)", calls: `≤ ${QL_2S}`, exec: "approve + fermiSwapWithAllowances" },
  { venue: "EulerSwap", segKind: 7, quote: "computeQuote(in, out, xNext, true) (probe-decode, self-truncating)", calls: `≤ ${QL_2S}`, exec: "computeQuote + transfer + pool.swap" },
  { venue: "Balancer V3", segKind: 14, quote: "on-chain StableMath replay (no live quote view)", calls: "getCurrentLiveBalances + getAmplificationParameter + getStaticSwapFeePercentage + getRate×2", exec: "Permit2 two-step + swapSingleTokenExactIn" },
  { venue: "Balancer V2", segKind: 6, quote: "on-chain StableMath replay (no live quote view)", calls: "getPoolTokenInfo×n + getAmplificationParameter + getStaticSwapFeePercentage + getScalingFactors", exec: "swap(poolType 4) → _swapBalancerV2" },
  { venue: "Maverick V2", segKind: 8, quote: "on-chain live bin-walk (no cumulative-out view)", calls: "per-tick reserve reads across the walked bins", exec: "swap(poolType 7) → maverickV2SwapCallback" },
  { venue: "Fluid DEX", segKind: 12, quote: "resolver.estimateSwapIn(dex, swap0to1, xNext, 0) (graceful CALL, 0 past the live cap)", calls: `${QL_S}`, exec: "estimateSwapIn min + approve + pool.swapIn (callback-free)" },
];

// ── Compile-arg builders ──
// The production unified-walk shape is IMPORTED from index.ts (buildSolverArgs + protocolDefines) so
// it can never drift from what a real cook feeds the solver — the old local copy went stale through
// the quote-ladder migration (it fed a 4-arg [cfg,pools,netCache,routing] shape while production
// main() grew to the 6-arg [cfg(13),pools,netCache,routing,segs,qlv] shape, so the unified cook
// reverted). The frozen unrolled reference keeps its own DIVERGENT legacy builder below.

/**
 * Production unified-walk arg array — delegates to index.ts `buildSolverArgs`, the SINGLE source of
 * truth for the current 6-arg shape (`[cfg(13), pools, netCache, routing, segs, qlv]`). Imported (not
 * re-copied) so it can never drift from what a real cook feeds the solver.
 */
function buildUnifiedArgs(
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  prepared: EcoSwapPrepared,
): unknown[] {
  return buildSolverArgs(tokenIn, tokenOut, amountIn, caller, prepared);
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

/**
 * [inter, h1Type,h1Pool,h1Fee,h1TS,h1Hooks, h2Type,h2Pool,h2Fee,h2TS,h2Hooks] — the FROZEN
 * unrolled reference's legacy route tuple. The new EcoRoute is `{legs, intermediateTokens}`; map
 * the two hops to each leg's FIRST pool (the frozen reference predates multi-pool legs and the
 * gas fixtures prepare zero routes, so this is only for shape/typecheck — never invoked at runtime).
 */
function buildLegacyRouteTuple(r: EcoRoute): bigint[] {
  const h1 = r.legs[0].pools[0];
  const h2 = r.legs[r.legs.length - 1].pools[0];
  const inter = r.intermediateTokens[0] ?? ("0x0" as Hex);
  return [
    BigInt(inter),
    BigInt(h1.poolType), BigInt(h1.address), BigInt(h1.fee), 0n, 0n,
    BigInt(h2.poolType), BigInt(h2.address), BigInt(h2.fee), 0n, 0n,
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
    prepared.routes.map(buildLegacyRouteTuple),
    prepared.brackets.map(buildBracketTuple),
  ];
}

/**
 * Pick the arg array + compile options the given solver's signature expects. The production unified
 * walk is compiled with the SAME treeshake + protocol defines a real cook carries (so its bytecode
 * size / gas reflect the treeshaken production blob, not the un-treeshaken all-protocols one); the
 * frozen unrolled reference has no HAS_* guards, so it compiles without defines.
 */
function argsForShape(
  shape: "unified" | "legacy",
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  prepared: EcoSwapPrepared,
): { args: unknown[]; opts: { treeshake?: boolean; defines?: Record<string, boolean> } } {
  if (shape === "unified") {
    return {
      args: buildUnifiedArgs(tokenIn, tokenOut, amountIn, caller, prepared),
      opts: { treeshake: true, defines: protocolDefines(prepared) },
    };
  }
  return { args: buildLegacyArgs(tokenIn, tokenOut, amountIn, caller, prepared), opts: {} };
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

// ── Route-leg QL fixed point (Table 4) — the PINNED-EXAMPLE-shaped universe ──
// Mirrors the ecoswap.legql.evm.test.ts case-5 fixtures (sizes probe-verified there so EVERY
// leg member funds at 20000e18): direct A→B UniV3 + ONE 2-hop route A→X→B whose leg A→X =
// {UniV3 pool + Maverick venue} and leg X→B = {Curve + WOOFi + Euler venues}. Hand-built
// `prepared` (bypasses prepare/discovery), local fixtures — a COARSE ARCHITECTURAL data point
// for what the leg-QL machinery costs end-to-end (stride-5 routing, 12-col qlv leg rows,
// per-leg-edge ladder builds sized by the chain-order fold, merge election over pools+venues,
// unified leg exec dispatch + intermediate sweep), alongside the V3-only fixed point above.
const LEG_AMOUNT_IN = parseEther("20000");
const LEG_FEE_DIRECT = 3000;
const LEG_TS_DIRECT = 60;
const LEG_FEE_LEG0 = 500;
const LEG_TS_LEG0 = 10;
const E18 = 10n ** 18n;
const E8 = 10n ** 8n;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
const MAV_TS = 10;
const MAV_FEE = E18 / 1000n; // 0.1% directional (1e18-scaled)
const MAV_FEE_PPM = Number((MAV_FEE * 1_000_000n) / E18); // 1000
const MAV_ACTIVE = -3;
const MAV_LO = -4;
const MAV_HI = 6;
const MAV_PER_TICK = 2_000n * E18;
const CURVE_PIN_BAL = [40_000n * E18, 40_000n * E18];
const CURVE_PIN_A = 20n;
const CURVE_PIN_FEE = 3_000_000n; // 0.03% (1e10-scaled)
const WOO_PRICE = E8; // 1:1 (WooracleV2 canonical 1e8 price decimals)
const WOO_SPREAD = 10n ** 14n; // 1 bp
const WOO_COEFF = 10n ** 13n;
const WOO_FEE_RATE = 25n; // 0.025% (1e5-scaled)
const WOO_FEE_PPM = 250;
const WOO_BASE_RES = 500_000n * E18;
const WOO_QUOTE_RES = 500_000n * E18;
const EUL_RES = 60_000n * E18;
const EUL_CONC = (9n * E18) / 10n;
const EUL_FEE = E18 / 1000n; // 0.1%
const EUL_FEE_PPM = 1000;

// Table-4 result cells (filled by the route-leg gas test; null until measured).
const legGas: Cell = { v1: null, v12: null };
const legSize: Cell = { v1: null, v12: null };
const legNotes = new Map<string, string>(); // "gas/v1" | "size/v12" … -> failure reason
let legSetupBlocker = "";

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
    "The production solver signature is `main(cfg, pools, netCache, routing, segs, qlv)` — a " +
      "13-scalar `cfg` bundle (tokenIn, tokenOut, amountIn, caller, priceLimit, directCount, plus the " +
      "chain-wide Fluid resolver / Mento broker / Balancer V3 router+vault / Balancer V2 vault addresses, " +
      "the internal amountOutMin floor, and cfg[12] = `directQlvCount` — the direct-prefix boundary in " +
      "`qlv`) followed by five nested tuple arrays: the FLAT POOL UNIVERSE `pools` (direct pools then " +
      "route-leg pools), the drift-invariant per-pool `netCache` (tick nets reused by a live walk), the " +
      "scalar `routing` layout (one flat tuple per route, uniform 5-field stride per leg — " +
      "`[legCount, {poolBase, poolCount, qlvBase, qlvCount, inter} × legCount]`), the VESTIGIAL static " +
      "sampled-segment stream `segs` (always [] — every family is quote-ladder now; kept for the stable " +
      "6-arg shape), and the QUOTE-LADDER venue descriptors `qlv` " +
      "(the 16 quote-ladder families — Curve/CryptoSwap/Solidly/WOOFi/Mento/LB/DODO/Wombat/Fermi/Euler/" +
      "BalV2/BalV3/Maverick/Fluid/Tessera/Elfomo — each a UNIFORM 12-column row the solver expands into an on-chain price " +
      "ladder; rows [0, directQlvCount) are DIRECT venues, rows [directQlvCount, …) are ROUTE-LEG venues " +
      "carrying qd[10]/qd[11] routeIdx/legIdx backrefs, grouped per (route, leg) so routing's " +
      "qlvBase/qlvCount point at them). `zeroForOne` is DERIVED on-chain from the token sort order. The " +
      "arg array is assembled by `index.ts` `buildSolverArgs` — IMPORTED by this harness (not re-copied), " +
      "so the measured shape can never drift from a real cook. The frozen unrolled reference keeps the " +
      "older `…, zeroForOne, priceLimit, pools, routes, brackets` shape; it is no longer the production " +
      "solver and is kept only as a historical bytecode-size / gas data point.",
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
      "prepare ONCE; the resulting `prepared` is turned into the compiler-arg array EACH " +
      "solver's signature expects — the production unified walk via the IMPORTED `buildSolverArgs` " +
      "(so it is byte-identical to a real cook, compiled with the SAME `treeshake` + protocol " +
      "`defines`), the frozen unrolled reference via its own local legacy builder. Both derive from " +
      "the same `prepared`, so the only variables are the solver source, its arg shape, and the " +
      "bytecode target. (This V3-only fixture carries no QL venues, so `segs`/`qlv` are empty here; " +
      "Table 3 documents the per-venue ladder cost the QL path adds.)",
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

  // Table 3 — quote-ladder per-venue ladder-build cost (ARCHITECTURAL, not measured on this V3-only
  // fixture). Every QL family builds its price ladder ON-CHAIN in setup: QL_S geometric slices. The
  // per-venue bound is ≤ 2·QL_S staticcalls — the revert-class views are PROBE-THEN-DECODE (a probe
  // `.catch` call + a guarded decode call = 2/slice); only graceful single-return views (WOOFi) cost
  // 1/slice = QL_S. This is a fixed, per-venue overhead the pre-QL sampled-segment path did NOT carry
  // on-chain (it shipped the samples statically). The three replay families (Balancer V2/V3, Maverick)
  // have NO cumulative-out view to quote, so instead they read a BOUNDED set of live Vault/bin state
  // and replay the curve math on-chain.
  lines.push(`## Table 3 — quote-ladder per-venue ladder-build cost (QL_S = ${QL_S} slices, ≤ 2·QL_S = ${QL_2S} staticcalls/venue)`);
  lines.push("");
  lines.push(
    "Architectural (derived from the QL framework + `buildQLVenues`), not measured on the V3-only " +
      "fixture above. Each QL venue expands its 12-column descriptor into an on-chain price ladder of " +
      `QL_S = ${QL_S} geometric slices. The per-venue upper bound is **≤ 2·QL_S = ${QL_2S}** view staticcalls ` +
      "(`ecoswap.sauce.ts:135`): the revert-class views are **probe-then-decode** — an unconditional " +
      "`.catch(() => ok = 0)` PROBE staticcall (the sentinel-catch can only flag a revert, not capture " +
      "the value) followed by a guarded DECODE staticcall — so a successful slice costs **2** staticcalls, " +
      `i.e. up to 2·QL_S = ${QL_2S}/venue (a revert stops the ladder early). Only the graceful single-return ` +
      "views (WOOFi `tryQuery`, and Fluid's resolver `estimateSwapIn` — a CALL, not a staticcall, that " +
      "returns 0 past the live utilization cap so the ladder self-truncates) cost **1** call/slice = QL_S = " +
      `${QL_S}. Trader Joe LB reads \`getSwapOut()[0]\` and \`[1]\` as two separate staticcalls, so it too is ` +
      "≤ 2·QL_S. The read-only `quoteEcoSwap` (eth_call + stateOverride) runs the SAME ladder but is " +
      "FREE of the block gas cap — the ladder staticcalls only count against gas on a landed cook(). " +
      "ROUTE-LEG venues build the SAME per-family ladders: a leg venue's ladder is built at setup on its " +
      "leg's EDGE pair (legIn, legOut), sized by the chain-order fold of amountIn through the upstream " +
      "legs' LIVE setup heads — so the per-venue cost below applies PER VENUE INSTANCE, direct or leg " +
      "(each leg-QL row is its own ladder; a dead upstream folds a leg venue's cap to 0 ⇒ a zero-row " +
      "ladder with zero quote staticcalls).",
  );
  lines.push("");
  lines.push("| QL venue | segKind | ladder quote (per slice, view) | ladder staticcalls | on-chain exec |");
  lines.push("| --- | ---: | --- | ---: | --- |");
  for (const r of QL_VENUE_ROWS) {
    lines.push(`| ${r.venue} | ${r.segKind} | ${r.quote} | ${r.calls} | ${r.exec} |`);
  }
  lines.push("");

  // Table 4 — route-leg QL fixed point (the pinned-example universe), measured when the leg
  // fixtures deployed. Rendered with dashes + the blocker when they did not.
  lines.push("## Table 4 — route-leg QL fixed point (pinned-example universe)");
  lines.push("");
  lines.push(
    "ONE measured cook of the epic's canonical route-leg shape (mirrors the " +
      "`ecoswap.legql.evm.test.ts` pinned example, whose correctness suite asserts this exact universe " +
      "wei-exact on both engines): a direct A→B UniV3 pool + ONE 2-hop route A→X→B whose leg A→X = " +
      "{UniV3 pool + Maverick venue} and leg X→B = {Curve + WOOFi + Euler venues}, " +
      `amountIn = \`${LEG_AMOUNT_IN.toString()}\` wei (\`parseEther("20000")\`, probe-verified so EVERY ` +
      "member funds). **Methodology note:** the `prepared` universe is HAND-BUILT (bypasses " +
      "prepare/discovery) over LOCAL fixtures — this is a COARSE ARCHITECTURAL data point for what the " +
      "leg-QL machinery costs end-to-end (stride-5 routing, 12-col qlv leg rows, per-leg-edge ladder " +
      "builds sized by the chain-order fold, merge election over pools+venues, the unified 13-family " +
      "leg exec dispatch + per-route intermediate sweep), alongside the V3-only fixed point of Tables " +
      "1–2. It is NOT comparable like-for-like with Table 1 (different tokens/pools/venues/amount). " +
      "Compiled via the production `buildSolverArgs` + `protocolDefines` (treeshaken: HAS_LEG_QLV + " +
      "the four venue families light up); same fairness discipline (snapshot/revert, pinned timestamp, " +
      "re-approve) as Table 1.",
  );
  lines.push("");
  if (legSetupBlocker) {
    lines.push(`_Route-leg QL cell unavailable: ${legSetupBlocker}_`);
    lines.push("");
  }
  {
    const gasNoteV1 = legNotes.get("gas/v1");
    const gasNoteV12 = legNotes.get("gas/v12") ?? (!v12ExecAvailable ? v12ExecBlocker : undefined);
    const sizeNoteV1 = legNotes.get("size/v1");
    const sizeNoteV12 = legNotes.get("size/v12");
    let gasDelta = "—";
    if (legGas.v1 !== null && legGas.v12 !== null) {
      const d = BigInt(legGas.v12) - BigInt(legGas.v1);
      gasDelta = `${d >= 0n ? "+" : ""}${d.toLocaleString("en-US")}`;
    }
    let sizeDelta = "—";
    if (legSize.v1 !== null && legSize.v12 !== null) {
      const d = Number(legSize.v12) - Number(legSize.v1);
      sizeDelta = `${d >= 0 ? "+" : ""}${d.toLocaleString("en-US")} B`;
    }
    lines.push("| Axis | v1 | v12 | v12 − v1 | Notes |");
    lines.push("| --- | ---: | ---: | ---: | --- |");
    const gasNotes: string[] = [];
    if (gasNoteV1) gasNotes.push(`v1: ${gasNoteV1}`);
    if (gasNoteV12) gasNotes.push(`v12: ${gasNoteV12}`);
    lines.push(
      `| cook \`gasUsed\` | ${fmtGas(legGas.v1, gasNoteV1)} | ${fmtGas(legGas.v12, gasNoteV12)} | ${gasDelta} | ${gasNotes.join("; ")} |`,
    );
    const sizeNotesRow: string[] = [];
    if (sizeNoteV1) sizeNotesRow.push(`v1: ${sizeNoteV1}`);
    if (sizeNoteV12) sizeNotesRow.push(`v12: ${sizeNoteV12}`);
    lines.push(
      `| compiled blob size | ${fmtBytes(legSize.v1, sizeNoteV1)} | ${fmtBytes(legSize.v12, sizeNoteV12)} | ${sizeDelta} | ${sizeNotesRow.join("; ")} |`,
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
  // Route-leg QL fixed point (when measured).
  if (legGas.v1 !== null || legGas.v12 !== null) {
    const parts: string[] = [];
    if (legGas.v1 !== null) parts.push(`v1 ${Number(legGas.v1).toLocaleString("en-US")}`);
    if (legGas.v12 !== null) parts.push(`v12 ${Number(legGas.v12).toLocaleString("en-US")}`);
    const sizes: string[] = [];
    if (legSize.v1 !== null) sizes.push(`v1 ${Number(legSize.v1).toLocaleString("en-US")} B`);
    if (legSize.v12 !== null) sizes.push(`v12 ${Number(legSize.v12).toLocaleString("en-US")} B`);
    bullets.push(
      `**Route-leg QL fixed point.** The pinned-example leg-QL universe (Table 4) cooks at ${parts.join(" / ")} gas` +
        (sizes.length > 0 ? ` with a ${sizes.join(" / ")} treeshaken blob` : "") +
        " — a coarse architectural data point (hand-built prepared, local fixtures; six venues across " +
        "two legs + a direct pool), not comparable like-for-like with the V3-only Table 1 fixed point.",
    );
  }
  // Leg-QL compile gating (always emitted — architectural, not run-dependent).
  bullets.push(
    "**Leg-QL machinery is compile-gated.** Every route-leg QL solver branch (the cfg[12] " +
      "directQlvCount read, the leg-row ladder builds + sizing fold, the merge's slice election arms, " +
      "the leg exec venue dispatch + intermediate sweep) sits behind `HAS_LEG_QLV` (plus each family's " +
      "own HAS_* flag), which `protocolDefines` lights ONLY when the prepared universe carries a leg " +
      "venue — so a pool-only universe treeshakes ALL of it away and ships ZERO leg-QL bytecode. " +
      "Pinned at the compile tier by `ecoswap.compile.test.ts` (\"pool-only routes: qlvBase/qlvCount " +
      "= 0 slots, cfg[12] = qlv.length, HAS_LEG_QLV false\" and the conditional-compilation cell that " +
      "asserts the all-flags-false build is strictly smaller on both engines).",
  );
  // Live-walk / quote-ladder architecture (always emitted — architectural, not run-dependent).
  bullets.push(
    "**Live-walk architecture.** Every venue now LIVE-WALKS: V2/V3/V4 walk a live frontier from the " +
      "on-chain spot (reusing a drift-invariant per-pool net cache), and the 16 quote-ladder families " +
      `build a price ladder of QL_S = ${QL_S} slices ON-CHAIN in setup (Table 3). This trades the old static ` +
      `sampled-segment shipping for on-chain freshness: a QL venue costs up to 2·QL_S = ${QL_2S} view staticcalls at ` +
      "ladder-build (probe-then-decode revert-class views cost 2/slice — a probe + a guarded decode; the " +
      "graceful single-return views like WOOFi cost 1/slice = QL_S; the three replay families — Balancer " +
      "V2/V3, Maverick — instead read a bounded set of live state and replay the curve). The read-only " +
      "`quoteEcoSwap` runs the identical ladder via " +
      "eth_call + stateOverride and is FREE of the block gas cap; the ladder staticcalls only count " +
      "against gas on a landed cook().",
  );
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
  // Route-leg QL (Table 4) fixture state — tokens RELABELED ascending (A < X < B) so every
  // edge (A→X, X→B, A→B) is zeroForOne, mirroring the legql pinned example.
  let tokA: Hex;
  let tokX: Hex;
  let tokB: Hex;
  let legPrepared: EcoSwapPrepared | null = null;

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

      // ── Route-leg QL fixtures (Table 4) — the legql pinned-example universe on the SAME
      // anvil (its own token triple, so discovery/prepare above never sees these pools; the
      // fixed-point cells are untouched). Deployed BEFORE the clean snapshot so every cell's
      // revert restores this state too. A failure here blocks only Table 4, not Tables 1–2.
      try {
        // The funding account for the venue-deploy helpers (== minter/account0, typed Account).
        const minterAcct = c.walletClient.account as Account;
        const t1 = await deployToken(c.walletClient, c.publicClient, "LegTokOne", "L1");
        const t2 = await deployToken(c.walletClient, c.publicClient, "LegTokTwo", "L2");
        const t3 = await deployToken(c.walletClient, c.publicClient, "LegTokThree", "L3");
        [tokA, tokX, tokB] = [t1, t2, t3].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
        for (const t of [tokA, tokX, tokB]) {
          await mint(c.walletClient, c.publicClient, t, minter, parseEther("1000000000"));
          await approve(c.walletClient, c.publicClient, t, stack.helper, HUGE);
        }
        // Direct A→B: shallow-ish, engages at the global cut against the route.
        const legDirectPool = await createAndInitPool(
          c.walletClient, c.publicClient, stack.factory, tokA, tokB, LEG_FEE_DIRECT, SQRT_PRICE_1_1,
        );
        await mintPosition(
          c.walletClient, c.publicClient, stack.helper, legDirectPool, minter, -12000, 12000, parseEther("8000"),
        );
        // Route leg0 A→X: deep, one wide position ⇒ constant L over the walked region.
        const leg0Pool = await createAndInitPool(
          c.walletClient, c.publicClient, stack.factory, tokA, tokX, LEG_FEE_LEG0, SQRT_PRICE_1_1,
        );
        await mintPosition(
          c.walletClient, c.publicClient, stack.helper, leg0Pool, minter, -12000, 12000, parseEther("5000000"),
        );
        // A→X Maverick venue: shallow uniform book (bends within the trade so the leg splits).
        const mavTicks: MaverickTick[] = [];
        for (let t = MAV_LO; t <= MAV_HI; t++) {
          mavTicks.push({ tick: t, reserveA: MAV_PER_TICK, reserveB: MAV_PER_TICK });
        }
        const { sqrtLowerPrice, sqrtUpperPrice } = tickSqrtPrices(MAV_TS, MAV_ACTIVE);
        const mavActive = mavTicks.find((t) => t.tick === MAV_ACTIVE)!;
        const mavActiveL = getTickL(mavActive.reserveA, mavActive.reserveB, sqrtLowerPrice, sqrtUpperPrice);
        const mavSqrtPrice = getSqrtPrice(
          mavActive.reserveA, mavActive.reserveB, sqrtLowerPrice, sqrtUpperPrice, mavActiveL,
        );
        const mavParams: MaverickDeployParams = {
          tokenA: tokA, tokenB: tokX, tickSpacing: MAV_TS, feeAIn: MAV_FEE, feeBIn: MAV_FEE,
          protocolFeeRatioD3: 0, ticks: mavTicks, activeTick: MAV_ACTIVE, poolSqrtPrice: mavSqrtPrice,
        };
        const mavPool = await deployMaverickV2Pool(c.walletClient, c.publicClient, mavParams, minterAcct);
        // X→B venues: small Curve (bends fast), WOOFi (1:1 oracle, big gamma), Euler (0.9 conc).
        const curvePin = await deployCurveStableSwap(
          c.walletClient, c.publicClient, [tokX, tokB], CURVE_PIN_BAL, [E18, E18], CURVE_PIN_A, CURVE_PIN_FEE, minterAcct,
        );
        const wooPool = await deployWooFiPool(
          c.walletClient, c.publicClient, tokX, tokB,
          E8, E18, E18, WOO_PRICE, WOO_SPREAD, WOO_COEFF, WOO_FEE_RATE, WOO_BASE_RES, WOO_QUOTE_RES, minterAcct,
        );
        const eulParams: EulerSwapParams = {
          reserve0: EUL_RES, reserve1: EUL_RES, equil0: EUL_RES, equil1: EUL_RES,
          priceX: E18, priceY: E18, concX: EUL_CONC, concY: EUL_CONC, fee: EUL_FEE,
          outCap0: 0n, outCap1: 0n,
        };
        const eulPool = await deployEulerSwapPool(c.walletClient, c.publicClient, tokX, tokB, eulParams, minterAcct);

        // Hand-stamp the EcoPools from live reads (windowTop=0 ⇒ fully live walk, empty net)
        // and the leg-QL venue descriptors (state-free) — the legql-test builders, copied.
        const v3EcoPool = async (address: Hex, feePpm: number, ts: number): Promise<EcoPool> => {
          const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, address);
          const liquidity = await getLiquidity(c.publicClient, address);
          const base = Math.floor(tick / ts) * ts;
          return {
            poolType: SwapPoolType.UniV3,
            address,
            fee: feePpm,
            tickSpacing: ts,
            hooks: ZERO,
            feePpm,
            isV2: false,
            inIsToken0: true,
            stateView: ZERO,
            poolId: ZERO32,
            stepRatio: getSqrtRatioAtTick(ts),
            windowTopShifted: 0n,
            windowBotShifted: 0n,
            extremeShifted: 0n,
            spotTickShifted: BigInt(base) + OFFSET,
            spotNearReal: sqrtPriceX96,
            spotActiveL: liquidity,
            adaptiveNet: new Map<number, bigint>(),
            source: "gas-legql-fixture",
          };
        };
        const mavVenue: EcoLegQlVenue = {
          family: "maverick",
          desc: { address: mavPool, tokenAIn: true, tickSpacing: MAV_TS, feePpm: MAV_FEE_PPM, source: "gas-legql-fixture" },
        };
        const curveVenue: EcoLegQlVenue = {
          family: "curve",
          desc: { address: curvePin, i: 0, j: 1, feePpm: Number(CURVE_PIN_FEE), source: "gas-legql-fixture" },
        };
        const wooVenue: EcoLegQlVenue = {
          family: "wooFi",
          desc: { address: wooPool, fromToken: tokX, toToken: tokB, feePpm: WOO_FEE_PPM, source: "gas-legql-fixture" },
        };
        const eulVenue: EcoLegQlVenue = {
          family: "euler",
          desc: { address: eulPool, inIsToken0: true, feePpm: EUL_FEE_PPM, source: "gas-legql-fixture" },
        };
        legPrepared = {
          pools: [await v3EcoPool(legDirectPool, LEG_FEE_DIRECT, LEG_TS_DIRECT)],
          routes: [
            {
              legs: [
                {
                  hopIn: tokA, hopOut: tokX, zeroForOne: true,
                  pools: [await v3EcoPool(leg0Pool, LEG_FEE_LEG0, LEG_TS_LEG0)],
                  qlVenues: [mavVenue],
                },
                {
                  hopIn: tokX, hopOut: tokB, zeroForOne: true,
                  pools: [],
                  qlVenues: [curveVenue, wooVenue, eulVenue],
                },
              ],
              intermediateTokens: [tokX],
            },
          ],
          brackets: [],
          zeroForOne: true,
          priceLimit: MIN_SQRT_RATIO + 1n,
          expectedInputCovered: 0n,
        };
      } catch (e) {
        legSetupBlocker = `leg-QL fixture setup failed: ${String(e)}`;
        legPrepared = null;
      }

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
      const { args, opts } = argsForShape(s.shape, tokenIn, tokenOut, AMOUNT_IN, caller, prepared);
      const source = readFileSync(join(ECOSWAP_DIR, s.file), "utf-8");
      const cell: Cell = { v1: null, v12: null };
      for (const target of TARGETS) {
        // Per-cell try/catch: a variant that cannot compile to one target (a real
        // finding) must not abort the rest of the table.
        try {
          const { bytecodes } = compileSauce(source, args, ECOSWAP_DIR, target, opts);
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
      const { args, opts } = argsForShape(s.shape, tokenIn, tokenOut, AMOUNT_IN, caller, prepared);
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
          const { bytecodes } = compileSauce(source, args, ECOSWAP_DIR, engine, opts);
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

  // ── Route-leg QL fixed point (Table 4) — the pinned-example universe on both engines ──
  // Same fairness discipline as the cells above: revert into the clean snapshot, re-snapshot,
  // pin the cook block timestamp, re-approve the cook target. Compiled via the PRODUCTION
  // buildSolverArgs + protocolDefines path (treeshaken; HAS_LEG_QLV + the four venue families
  // light up), so the measured blob is exactly what a real leg-QL cook ships.
  it("cooks the pinned-example route-leg QL universe on both engines (Table 4)", async () => {
    if (chainSetupFailed || !legPrepared) {
      assert.ok(true, `route-leg QL cell skipped: ${legSetupBlocker || executionBlocker}`);
      return;
    }

    const source = readFileSync(join(ECOSWAP_DIR, "ecoswap.sauce.ts"), "utf-8");
    const args = buildSolverArgs(tokA, tokB, LEG_AMOUNT_IN, caller, legPrepared);
    const opts = { treeshake: true, defines: protocolDefines(legPrepared) };

    // Bytecode size — both targets, chain-free.
    for (const target of TARGETS) {
      try {
        const { bytecodes } = compileSauce(source, args, ECOSWAP_DIR, target, opts);
        legSize[target] = blobBytes(bytecodes);
      } catch (e) {
        const why = reason(e);
        legNotes.set(`size/${target}`, why);
        console.log(`  [legQL size] ${target}: FAILED — ${why}`);
      }
    }
    console.log(`  [legQL size] v1=${legSize.v1 ?? "FAIL"}B v12=${legSize.v12 ?? "FAIL"}B`);
    assert.ok(legSize.v1 !== null, "leg-QL universe must compile to v1");
    assert.ok(legSize.v12 !== null, "leg-QL universe must compile to v12");

    // Execution gas — v1 + v12 (when the v12 artifacts are present).
    const engines: Target[] = v12ExecAvailable ? ["v1", "v12"] : ["v1"];
    for (const engine of engines) {
      await c.testClient.revert({ id: cleanSnapshot });
      cleanSnapshot = await c.testClient.snapshot();
      await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
      const target = engine === "v12" ? v12!.pot : stack.sauceRouter;
      await approve(c.walletClient, c.publicClient, tokA, target, LEG_AMOUNT_IN);
      try {
        const { bytecodes } = compileSauce(source, args, ECOSWAP_DIR, engine, opts);
        const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
        if (receipt.status !== "success") {
          legNotes.set(`gas/${engine}`, `cook() status=${receipt.status}`);
          console.log(`  [legQL gas] ${engine}: cook() reverted (status=${receipt.status})`);
        } else {
          legGas[engine] = receipt.gasUsed;
          console.log(`  [legQL gas] ${engine}: gasUsed=${receipt.gasUsed}`);
        }
      } catch (e) {
        const why = reason(e);
        legNotes.set(`gas/${engine}`, why);
        console.log(`  [legQL gas] ${engine}: cook() THREW — ${why}`);
      }
    }

    // The cell must land on every engine we could run — a leg-QL revert here is a real
    // regression (the legql correctness suite cooks this exact shape green on both engines).
    for (const engine of engines) {
      assert.ok(legGas[engine] !== null, `leg-QL cook must land on ${engine}: ${legNotes.get(`gas/${engine}`) ?? ""}`);
    }
  });
});
