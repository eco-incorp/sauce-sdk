/**
 * EcoSwap recipe entry point.
 *
 * Off-chain:  build each pool's per-pool NET CACHE (drift-invariant tick depth) +
 *             the static route segments.
 * On-chain:   ONE price-ordered merge where every pool walks a single frontier from
 *             its LIVE spot (reusing the cache for net), then one swap per pool (one
 *             per hop for routes) — equal post-fee marginal price = synchronized
 *             minimal slippage, no per-pool price-limit needed.
 */

import {
  createPublicClient,
  http,
  defineChain,
  parseAbi,
  keccak256,
  encodeAbiParameters,
  encodeFunctionData,
  decodeFunctionResult,
  type Abi,
  type Hex,
} from "viem";
import { createRequire } from "module";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import ts from "typescript";

import { prepareEcoSwap, type EcoSwapPrepareOpts } from "./prepare.js";
import {
  MULTICALL3,
  BASE_CHAIN_POOL_CONFIG,
  SwapPoolType,
  type ChainPoolConfig,
} from "../shared/constants.js";
import { EcoBracketKind, type EcoSwapConfig, type EcoSwapPrepared, type EcoPool } from "../shared/types.js";

const require = createRequire(import.meta.url);
const { compile } = require("@eco-incorp/sauce-compiler");

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

function toHex(bytes: Uint8Array): Hex {
  return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

function stripTypes(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}

export interface EcoSwapOutput {
  bytecodes: Hex[];
  prepared: EcoSwapPrepared;
  source: string;
}

// ── Compile-arg tuple builders (all values are bigint scalars) ──

/**
 * [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0, stateView, poolId,
 *  stepRatio, windowTopShifted, windowBotShifted, extremeShifted, netStart, netCount, isKyber]
 * [10..15] are the unified-walk per-pool cache descriptors (V3/V4): the multiplicative step
 * ratio, the cache window bounds (shallowest/deepest scanned tick, shifted; windowTop=0 ⇒ no
 * cache ⇒ staticcall every boundary, the 1-RPC quote path), the deepest INITIALIZED tick (the
 * terminate gate — the solver walks THROUGH interior dL==0 gaps, deactivating only past this
 * tick), and the [netStart, netStart+netCount) slice into the flat netCache. 0 for V2 (V2 reads
 * live reserves and streams constant-L, no tick cache).
 *
 * `netStart` is supplied by the caller (the running offset into the assembled netCache).
 */
function buildPoolTuple(p: EcoPool, netStart: number, netCount: number): bigint[] {
  return [
    BigInt(p.poolType),
    BigInt(p.address),
    BigInt(p.fee),
    BigInt(p.tickSpacing),
    BigInt(p.hooks),
    BigInt(p.feePpm),
    p.isV2 ? 1n : 0n,
    p.inIsToken0 ? 1n : 0n,
    BigInt(p.stateView), // V4 StateView lens (0 for V2/V3)
    BigInt(p.poolId), // V4 poolId (0 for V2/V3)
    p.stepRatio ?? 0n, // [10] multiplicative step ratio (getSqrtRatioAtTick(ts)); 0 for V2
    p.windowTopShifted ?? 0n, // [11] shallowest scanned tick (shifted); 0 ⇒ no cache (quote path)
    p.windowBotShifted ?? 0n, // [12] deepest scanned tick (shifted)
    p.extremeShifted ?? 0n, // [13] deepest INITIALIZED tick (shifted) — the terminate gate
    BigInt(netStart), // [14] start row index into the flat netCache for this pool
    BigInt(netCount), // [15] number of initialized-tick rows for this pool (0 ⇒ none)
    p.isKyber ? 1n : 0n, // [16] KyberSwap Classic / DMM (V2-shaped on VIRTUAL reserves); 0 ⇒ plain V2
  ];
}

/**
 * Assemble the per-pool tuples + the flat netCache ([shiftedTick, rawNet] rows, per-pool
 * grouped + swap-direction-sorted) together, so each pool's [netStart, netCount) points at its
 * own contiguous slice. V2 pools contribute no rows.
 */
function buildPoolsAndNetCache(pools: EcoPool[]): { poolTuples: bigint[][]; netCache: bigint[][] } {
  const netCache: bigint[][] = [];
  const poolTuples: bigint[][] = [];
  for (const p of pools) {
    const rows = p.isV2 ? [] : p.netRows ?? [];
    const netStart = netCache.length;
    poolTuples.push(buildPoolTuple(p, netStart, rows.length));
    for (const r of rows) netCache.push([r.shiftedTick, r.rawNet]);
  }
  return { poolTuples, netCache };
}

/**
 * Build the FLAT POOL UNIVERSE + the SCALAR ROUTING layout.
 *
 * The universe is `[...prepared.pools, ...legPools]`: every route-leg pool is APPENDED after
 * the direct pools, with each leg's pools laid CONTIGUOUSLY so a leg is a `[base, base+count)`
 * slice of universe indices. A pool that is ALSO a direct pool (same address) is DEDUPED to its
 * single direct-pool universe index (one shared frontier, seeded/stepped once) rather than
 * appended again — so a leg pool's universe index can point back into the direct-pool prefix.
 *
 * `buildPoolsAndNetCache` is reused VERBATIM over the assembled universe (a leg pool is
 * byte-identical to a direct pool on-chain), producing the `poolTuples`/`netCache` args.
 *
 * `routing` is one flat SCALAR tuple per route, depth-2 read on-chain:
 *   routing[r] = [legCount, base0,count0,inter0, base1,count1,inter1, …]
 * where for leg L: pools are universe indices `[baseL, baseL+countL)` and `interL` is the
 * INTERMEDIATE token AFTER leg L (== legL.hopOut). The FINAL leg's `interL` is 0 (unused — its
 * out is tokenOut). Stride is a uniform 3 scalars per leg, so N-hop needs no shape change.
 *
 * `directCount` = `prepared.pools.length` — how many leading universe entries are DIRECT venues
 * (the on-chain merge scans `[0, directCount)` as direct pools; entries `[directCount, …)` are
 * leg-only pools reached solely via `routing`). It is carried in the `cfg` bundle.
 *
 * Per-pool swap direction is derived on-chain from each pool tuple's `inIsToken0` field [7]
 * (== that pool's `zeroForOne`). A leg pool whose leg direction `zHop` differs from the route's
 * overall direction therefore needs [7] stamped with the LEG's `zHop` — done in prepare when the
 * leg pool's `EcoPool.inIsToken0` is set; the universe build does not re-derive it.
 */
function buildPoolUniverseAndRouting(prepared: EcoSwapPrepared): {
  poolTuples: bigint[][];
  netCache: bigint[][];
  routing: bigint[][];
  directCount: number;
} {
  const directCount = prepared.pools.length;
  const universe: EcoPool[] = [...prepared.pools];
  // Map a pool's address (lowercased) → its universe index, for dedupe against direct pools and
  // against earlier leg pools. Seeded with the direct prefix so a leg pool that is also direct
  // points back at the direct index.
  const indexByAddr = new Map<string, number>();
  prepared.pools.forEach((p, i) => indexByAddr.set(p.address.toLowerCase(), i));

  const routing: bigint[][] = [];
  for (const route of prepared.routes) {
    const rt: bigint[] = [BigInt(route.legs.length)];
    route.legs.forEach((leg, legIdx) => {
      // Append this leg's pools contiguously, deduping any already in the universe.
      const idxs: number[] = [];
      for (const lp of leg.pools) {
        const key = lp.address.toLowerCase();
        let idx = indexByAddr.get(key);
        if (idx === undefined) {
          idx = universe.length;
          universe.push(lp);
          indexByAddr.set(key, idx);
        }
        idxs.push(idx);
      }
      // Leg pools occupy a contiguous slice ONLY when freshly appended in order; if any were
      // deduped the slice is not contiguous, so emit the explicit [min, count) span and rely on
      // the contiguous append for the common (no-dedupe) case. For the 2-hop V3-leg landing the
      // intermediate's pools never collide with the direct set, so the slice is contiguous.
      const base = idxs.length > 0 ? Math.min(...idxs) : 0;
      const count = idxs.length;
      // interL: the intermediate token AFTER this leg (legL.hopOut). Final leg → 0 (its out is
      // tokenOut). intermediateTokens[legIdx] is the token between leg legIdx and legIdx+1.
      const inter =
        legIdx < route.intermediateTokens.length
          ? BigInt(route.intermediateTokens[legIdx])
          : 0n;
      rt.push(BigInt(base), BigInt(count), inter);
    });
    routing.push(rt);
  }

  const { poolTuples, netCache } = buildPoolsAndNetCache(universe);
  return { poolTuples, netCache, routing, directCount };
}

/**
 * Build the SAMPLED-SEGMENT array — `[refIdx, capacity, sqrtAdjNear, sqrtAdjFar, segKind, venue]`
 * for every Curve / LB / DODO bracket, sorted DESC by sqrtAdjNear (then adjFar DESC, then refIdx
 * ASC — the same stable order the on-chain merge tie-breaks on). These are the STATIC
 * sampled-segment venues (Curve/LB/DODO — their curve math is off-chain only) that compete in the
 * merge via ONE cursor (the on-chain `bestKind===1` static-segment path) ALONGSIDE the live direct
 * pools (bestKind===3) and the live multi-hop routes (bestKind===2). The solver does NOT recompute
 * either curve; it consumes the rows by sqrtAdjNear, accumulates the awarded Σ per venue (keyed by
 * the row's `venue` address), and dispatches on `segKind` at execution.
 *
 * segKind: 1 = Curve (refIdx → prepared.curves[]; venue = exchange() pool → swap(poolType:3) →
 * _swapCurve), 2 = Trader Joe LB (refIdx → prepared.lbs[]; venue = the pair → swap(poolType:6) →
 * _swapTraderJoeLB), 3 = DODO V2 (refIdx → prepared.dodos[]; venue = the pool → swap(poolType:5) →
 * _swapDODOV2). Each row carries its venue address inline, so the solver shares ONE per-segment
 * accumulator keyed by the static-segment index and resolves the venue from the row.
 *
 * Carried as a SEPARATE top-level compiler param (the 5th, after routing) so the row reads stay at
 * nesting depth ≤ 2 (segs[i] then segs[i][col]); the scalars stay bundled in `cfg`, so main() adds
 * only ONE nested tuple param — the v12 arg-prologue SDUP window stays small.
 */
function buildSegs(prepared: EcoSwapPrepared): bigint[][] {
  const curves = prepared.curves ?? [];
  const lbs = prepared.lbs ?? [];
  const dodos = prepared.dodos ?? [];
  const solidlyStables = prepared.solidlyStables ?? [];
  return prepared.brackets
    .filter(
      (b) =>
        b.kind === EcoBracketKind.Curve ||
        b.kind === EcoBracketKind.LB ||
        b.kind === EcoBracketKind.DODO ||
        b.kind === EcoBracketKind.SolidlyStable,
    )
    .slice()
    .sort((a, b) => {
      if (a.sqrtAdjNear !== b.sqrtAdjNear) return a.sqrtAdjNear < b.sqrtAdjNear ? 1 : -1;
      if (a.sqrtAdjFar !== b.sqrtAdjFar) return a.sqrtAdjFar < b.sqrtAdjFar ? 1 : -1;
      return a.refIdx - b.refIdx;
    })
    .map((b) => {
      const isCurve = b.kind === EcoBracketKind.Curve;
      const isLb = b.kind === EcoBracketKind.LB;
      const isDodo = b.kind === EcoBracketKind.DODO;
      const isSolidly = b.kind === EcoBracketKind.SolidlyStable;
      // segKind: 1 Curve, 2 LB, 3 DODO, 4 Solidly stable (callback-free getAmountOut + pool.swap).
      const segKind = isCurve ? 1n : isLb ? 2n : isDodo ? 3n : isSolidly ? 4n : 0n;
      const venue = isCurve
        ? BigInt(curves[b.refIdx].address)
        : isLb
          ? BigInt(lbs[b.refIdx].address)
          : isDodo
            ? BigInt(dodos[b.refIdx].address)
            : isSolidly
              ? BigInt(solidlyStables[b.refIdx].address)
              : 0n;
      return [BigInt(b.refIdx), b.capacity, b.sqrtAdjNear, b.sqrtAdjFar, segKind, venue];
    });
}

/**
 * Compile-time protocol-presence defines for ecoswap.sauce.ts conditional compilation.
 *
 * Each HAS_* flag gates the per-protocol-SEPARABLE on-chain code (Curve/LB/DODO/Solidly/Kyber/
 * V2/V4/routes). Passed as `defines` with `treeshake:true` so a cook carries ONLY the protocols
 * its prepared universe actually contains — an all-UniV3 swap drops the Curve/Solidly/DODO/LB/
 * Kyber/route bytecode (and any helper reachable only from a dropped branch). The type-agnostic
 * k-way merge core + the live V3/V4 frontier walk are unguarded (always on), so there is no
 * HAS_V3 guard — V3 is the merge-core default path (HAS_V3 is still emitted for symmetry/clarity).
 *
 * SAFETY: a flag is `true` whenever the prepared data carries that protocol's pools/segments, so
 * live code is NEVER dropped. The `||`-over-legs/universe reductions default a flag to `true` if
 * the corresponding prepared field is present.
 */
function protocolDefines(prepared: EcoSwapPrepared): Record<string, boolean> {
  // Every pool in the executable universe: direct pools PLUS every route-leg pool (a leg pool is
  // itself an EcoPool the solver walks/executes, so its type must light the matching HAS_* flag).
  const allPools: EcoPool[] = [
    ...prepared.pools,
    ...prepared.routes.flatMap((route) => route.legs.flatMap((leg) => leg.pools)),
  ];
  // isKyber pools are isV2-shaped; HAS_V2 covers a plain (non-Kyber) V2 pool, HAS_KYBER the Kyber
  // setup/exec path. A Kyber pool needs HAS_KYBER (its read + callback-free exec) — and the V2
  // SETUP/merge branches are shared, gated by (HAS_V2 || HAS_KYBER) on-chain, so a Kyber-only
  // universe still lights its shared V2-shaped frontier code.
  const HAS_KYBER = allPools.some((p) => p.isKyber === true);
  const HAS_V2 = allPools.some((p) => p.isV2 && p.isKyber !== true);
  const HAS_V4 = allPools.some((p) => p.poolType === SwapPoolType.UniV4);
  const HAS_V3 = allPools.some((p) => !p.isV2 && p.poolType !== SwapPoolType.UniV4);
  const HAS_ROUTES = prepared.routes.length > 0;
  const HAS_CURVE = (prepared.curves?.length ?? 0) > 0;
  const HAS_LB = (prepared.lbs?.length ?? 0) > 0;
  const HAS_DODO = (prepared.dodos?.length ?? 0) > 0;
  const HAS_SOLIDLY_STABLE = (prepared.solidlyStables?.length ?? 0) > 0;
  return {
    HAS_V2,
    HAS_V3,
    HAS_V4,
    HAS_KYBER,
    HAS_ROUTES,
    HAS_CURVE,
    HAS_LB,
    HAS_DODO,
    HAS_SOLIDLY_STABLE,
  };
}

/**
 * Prepare and compile an EcoSwap.
 *
 * @param config - Swap configuration (tokenIn, tokenOut, amountIn)
 * @param rpcUrl - RPC URL for the chain
 * @param cookEntry - The engine cook() entrypoint the on-chain LENS read runs against —
 *   the SAME engine as the swap: the SauceRouter on v1, the owner's V12Pot on v12. The
 *   lens is engine-agnostic in VALUE; running it on the matched engine keeps prepare and
 *   the swap consistent. (`ecoSwap` only COMPILES the solver; the test/caller cooks it
 *   separately through this same cookEntry.)
 * @param caller - Address that will call cook() (for transferFrom). Also the lens-read
 *   account — required on v12 (the V12Pot.cook is owner-gated → must be the Pot owner).
 * @param poolConfig - Optional chain pool-discovery config (factories/fee tiers/
 *   base tokens). Omitted → prepareEcoSwap defaults to BASE_CHAIN_POOL_CONFIG,
 *   preserving prior behavior. Lets tests point discovery at local pools.
 * @param target - Bytecode target: "v1" (prefix, Solidity Router) or "v12" (postfix,
 *   Huff runtime). Default "v1". Selects BOTH the on-chain solver compilation AND the
 *   LENS read engine (the lens is now v12-native; it cooks on `cookEntry` as `target`).
 */
export async function ecoSwap(
  config: EcoSwapConfig,
  rpcUrl: string,
  cookEntry: Hex,
  caller: Hex,
  poolConfig?: ChainPoolConfig,
  opts?: EcoSwapPrepareOpts & { solverFile?: string },
  target: "v1" | "v12" = "v1",
): Promise<EcoSwapOutput> {
  const tempClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await tempClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: "Fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 120_000 }) });

  // The LENS read runs on the SAME engine as the swap: compile it to `target` and cook it
  // through `cookEntry` (the V12Pot on v12), simulated from `caller` (the Pot owner — its
  // cook is owner-gated). The lens value is engine-agnostic, so this only keeps prepare
  // and the swap on one engine. lensTarget/caller layer onto the caller's opts.
  const prepared = await prepareEcoSwap(
    config,
    client,
    cookEntry,
    poolConfig ?? BASE_CHAIN_POOL_CONFIG,
    { ...(opts ?? {}), lensTarget: opts?.lensTarget ?? target, caller },
  );

  // EcoSwap's on-chain solver is the unified per-pool live walk in ecoswap.sauce.ts: one
  // price-ordered merge over {each route segment, each pool's live frontier} where every
  // direct pool walks from its LIVE spot reusing the drift-invariant per-pool net cache,
  // computes the exact tokenIn the swaps will consume, then pulls and executes (compute-
  // then-pull, no over-pull/refund). `opts.solverFile` lets a test point at an alternate
  // solver source without changing the production default.
  const solverFile = opts?.solverFile ?? "ecoswap.sauce.ts";
  const source = readFileSync(join(__dirname, solverFile), "utf-8");
  const jsSource = stripTypes(source);

  const { poolTuples, netCache, routing, directCount } = buildPoolUniverseAndRouting(prepared);
  const segs = buildSegs(prepared);
  const result = compile(jsSource, {
    // REPO_ROOT resolves "./artifacts/*.json"; __dirname resolves "./IUniswapV2Pair.json".
    baseDirs: [REPO_ROOT, __dirname],
    target,
    // Conditional compilation: emit ONLY the per-protocol code the prepared universe contains
    // (treeshake drops branches + helpers reachable only from a folded-away protocol). Every
    // present protocol gets HAS_X=true, so the awarded split + executed swaps are byte-identical
    // to the all-protocols cook (the guards are transparent when true).
    treeshake: true,
    defines: protocolDefines(prepared),
    // cfg-bundle the SCALARS into ONE tuple (the lens's proven trick — keeps the scalar
    // count out of the arg-prologue SDUP window); the big nested tuples (pools/netCache/
    // routing/segs) stay SEPARATE top-level params so pool/route/segment field reads stay
    // at nesting depth ≤ 2 (folding them in => depth-3 read => v1 INDEX revert). `segs` is the
    // sampled-segment venue stream (Curve/LB/DODO) the merge competes via bestKind===1.
    args: [
      [
        BigInt(config.tokenIn),
        BigInt(config.tokenOut),
        config.amountIn,
        BigInt(caller),
        prepared.priceLimit,
        BigInt(directCount),
      ],
      poolTuples,
      netCache,
      routing,
      segs,
    ],
  });

  // This compiler returns { bytecode }; older recipe drafts referenced `bytecodes`.
  const segments: Uint8Array[] = result.bytecode ?? result.bytecodes;
  const bytecodes = segments.map(toHex);

  return { bytecodes, prepared, source };
}

const cookAbi = parseAbi([
  "function cook(bytes[] ingredients) payable returns (bytes returnData)",
]);

/** ERC-20 storage layout: the slot of the `balanceOf` mapping and the `allowance` mapping. */
export interface Erc20Slots {
  /** Slot index of `mapping(address => uint256) balanceOf`. */
  balanceSlot: bigint;
  /** Slot index of `mapping(address => mapping(address => uint256)) allowance`. */
  allowanceSlot: bigint;
}

/** OZ-standard ERC20 layout (`_balances` slot 0, `_allowances` slot 1). */
export const OZ_ERC20_SLOTS: Erc20Slots = { balanceSlot: 0n, allowanceSlot: 1n };

/** Storage key of mapping[key] at the given slot: keccak256(abi.encode(key, slot)). */
function mappingSlot(key: Hex, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
}

/** Storage key of nested mapping[a][b] at `slot`: keccak256(b . keccak256(a . slot)). */
function nestedMappingSlot(a: Hex, b: Hex, slot: bigint): Hex {
  const inner = mappingSlot(a, slot);
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [b, inner]),
  );
}

// A large but SAFE override balance/allowance (2^128-1): plenty for any realistic
// amountIn while avoiding the arithmetic-overflow edges a full 2^256-1 can trip in
// pool/token math during the read-only swap.
const OVERRIDE_AMOUNT = ("0x" + "0".repeat(32) + "f".repeat(32)) as Hex;

export interface QuoteEcoSwapResult {
  /** Realized tokenOut the swap WOULD produce for `amountIn` (the quote). */
  amountOut: bigint;
  /** The prepared state used (pools + per-pool net caches, routes, route segments). */
  prepared: EcoSwapPrepared;
}

/**
 * 1-RPC EcoSwap QUOTE via eth_call state override (no on-chain solver change, no funding).
 *
 * Runs the SAME compiled, verified solver read-only through `cook()`, but injects the
 * caller's tokenIn balance + the cook-entry's allowance into the eth_call's `stateOverride`
 * — so `transferFrom` + the swaps execute call-locally (rolled back) and the solver's
 * returned tokenOut (`outBal`) is decoded as the quote. This is the agreed alternative to
 * a `quoteOnly` solver param, which is infeasible on v12 (a 10th scalar param overflows
 * the SDUP16 reference window, and bundling scalars into a cfg tuple multiplies live slots
 * across the solver's many tick staticcalls → frame-base MemoryOOG). The realized output is
 * STRICTLY BETTER than the `cum` the spec's quoteOnly would have returned.
 *
 * Works with NO prepared net cache: pass `opts.noBrackets = true` and each pool's window
 * bounds clear (windowTop=0), so the unified walk staticcalls every boundary from the live
 * spot (the no-cache full-live walk, 1-RPC quote).
 *
 * @param cookEntry  the engine cook entrypoint the QUOTE eth_call runs against (v1
 *                   SauceRouter / v12 Pot) — the swap target AND the allowance spender.
 * @param caller     the account the quote is FOR (its balance/allowance are overridden).
 *                   On v12 this MUST be the Pot owner (the Pot's cook is owner-gated).
 * @param opts.lensRouter the address the PREPARE lens read cooks against — ALWAYS a v1
 *                   SauceRouter (the lens is engine-agnostic and v1-only at runtime; on v12
 *                   pass the v12 stack's own SauceRouter, NOT the Pot). Defaults to
 *                   `cookEntry` (correct on v1 where they coincide).
 * @param opts.target solver bytecode target ("v1"|"v12"); the cook return decode is
 *                   per-engine (v1 wraps the bytes envelope, the v12 Pot returns raw).
 * @param opts.erc20Slots tokenIn's storage layout (defaults to OZ-standard 0/1); the local
 *                   test token (MintableERC20) uses 4/5.
 */
export async function quoteEcoSwap(
  config: EcoSwapConfig,
  rpcUrl: string,
  cookEntry: Hex,
  caller: Hex,
  poolConfig?: ChainPoolConfig,
  opts?: EcoSwapPrepareOpts & {
    noBrackets?: boolean;
    erc20Slots?: Erc20Slots;
    target?: "v1" | "v12";
    lensRouter?: Hex;
  },
): Promise<QuoteEcoSwapResult> {
  const target = opts?.target ?? "v1";
  const erc20Slots = opts?.erc20Slots ?? OZ_ERC20_SLOTS;
  // The lens read runs on the SAME engine as the quote (the lens is v12-native): cook it
  // through `cookEntry` as `target`. `lensRouter` lets a caller point the lens at a
  // different cook entry, but by default it IS the cook entry.
  const lensRouter = opts?.lensRouter ?? cookEntry;

  const tempClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await tempClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: "Fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 120_000 }) });

  const prepared = await prepareEcoSwap(
    config,
    client,
    lensRouter,
    poolConfig ?? BASE_CHAIN_POOL_CONFIG,
    { ...(opts ?? {}), lensTarget: opts?.lensTarget ?? target, caller },
  );
  // No-cache quote (1-RPC): drop the per-pool net cache so the walk staticcalls every boundary
  // from each pool's LIVE spot. Clearing the netRows + window bounds forces windowTop=0 on-chain
  // (the all-live walk). This must clear EVERY pool in the universe — the direct pools AND every
  // route LEG pool (each leg pool is itself an EcoPool walked live), or a stale leg cache would
  // survive the no-cache quote.
  const clearCache = (p: EcoPool): EcoPool =>
    p.isV2 ? p : { ...p, netRows: [], windowTopShifted: 0n, windowBotShifted: 0n };
  const usePrepared: EcoSwapPrepared = opts?.noBrackets
    ? {
        ...prepared,
        pools: prepared.pools.map(clearCache),
        routes: prepared.routes.map((route) => ({
          ...route,
          legs: route.legs.map((leg) => ({ ...leg, pools: leg.pools.map(clearCache) })),
        })),
      }
    : prepared;

  const source = readFileSync(join(__dirname, "ecoswap.sauce.ts"), "utf-8");
  const jsSource = stripTypes(source);
  const { poolTuples, netCache, routing, directCount } =
    buildPoolUniverseAndRouting(usePrepared);
  const segs = buildSegs(usePrepared);
  const result = compile(jsSource, {
    baseDirs: [REPO_ROOT, __dirname],
    target,
    // Same conditional compilation as ecoSwap — quote == cook (the quote runs the SAME compiled
    // solver), so derive the defines from the SAME prepared universe the quote executes.
    treeshake: true,
    defines: protocolDefines(usePrepared),
    args: [
      [
        BigInt(config.tokenIn),
        BigInt(config.tokenOut),
        config.amountIn,
        BigInt(caller),
        usePrepared.priceLimit,
        BigInt(directCount),
      ],
      poolTuples,
      netCache,
      routing,
      segs,
    ],
  });
  const segments: Uint8Array[] = result.bytecode ?? result.bytecodes;
  const bytecodes = segments.map(toHex);

  // State override: give `caller` plenty of tokenIn + an unbounded allowance to the cook
  // entry, so the solver's transferFrom + swaps succeed in the (rolled-back) eth_call.
  const stateOverride = [
    {
      address: config.tokenIn,
      stateDiff: [
        { slot: mappingSlot(caller, erc20Slots.balanceSlot), value: OVERRIDE_AMOUNT },
        { slot: nestedMappingSlot(caller, cookEntry, erc20Slots.allowanceSlot), value: OVERRIDE_AMOUNT },
      ],
    },
  ];

  const data = encodeFunctionData({ abi: cookAbi as Abi, functionName: "cook", args: [bytecodes] });
  const { data: ret } = await client.call({
    account: caller,
    to: cookEntry,
    data,
    gas: 2_000_000_000n,
    stateOverride,
  });

  const amountOut = decodeCookUint(ret as Hex, target);
  return { amountOut, prepared: usePrepared };
}

/**
 * Decode the solver's Uint256 return (tokenOut) from a raw cook() eth_call result.
 * The v1 SauceRouter wraps the program return in the ABI `bytes` envelope
 * (offset+len+payload); the v12 V12Pot returns the program output verbatim. Both carry
 * the solver's single 32-byte word — read it as the LAST 32 bytes either way.
 */
function decodeCookUint(ret: Hex, target: "v1" | "v12"): bigint {
  if (!ret || ret === "0x") return 0n;
  if (target === "v1") {
    // ABI `bytes` envelope → unwrap to the inner blob (single output ⇒ value returned
    // directly, NOT in an array), then read its 32-byte word.
    const blob = decodeFunctionResult({
      abi: cookAbi as Abi,
      functionName: "cook",
      data: ret,
    }) as unknown as Hex;
    const hex = blob.slice(2);
    return hex.length >= 64 ? BigInt("0x" + hex.slice(-64)) : 0n;
  }
  // v12: raw 32-byte word (or wider) — the solver's uint256 return is the last word.
  const hex = ret.slice(2);
  return hex.length >= 64 ? BigInt("0x" + hex.slice(-64)) : 0n;
}
