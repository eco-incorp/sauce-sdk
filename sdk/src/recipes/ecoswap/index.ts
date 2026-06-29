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
import { MULTICALL3, BASE_CHAIN_POOL_CONFIG, type ChainPoolConfig } from "../shared/constants.js";
import type { EcoSwapConfig, EcoSwapPrepared, EcoPool, EcoRoute } from "../shared/types.js";
import { EcoBracketKind } from "../shared/types.js";

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
 *  stepRatio, windowTopShifted, windowBotShifted, extremeShifted, netStart, netCount]
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
 * [inter, h1Type,h1Pool,h1Fee,h1TS,h1Hooks, h2Type,h2Pool,h2Fee,h2TS,h2Hooks]
 * (tickSpacing/hooks default to 0 — routes use V3/V2 pools discovered with V3 keys).
 */
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

/**
 * Build the flat route-segment array — [routeIdx, capacity, sqrtAdjNear, sqrtAdjFar] for every
 * Route bracket, sorted DESC by sqrtAdjNear (then adjFar DESC, then routeIdx ASC — the same
 * stable order the merge tie-breaks on). Routes are STATIC (no live re-price), competing in the
 * merge via ONE cursor. Direct-pool brackets are GONE (the solver walks each pool live).
 */
function buildRouteSegs(prepared: EcoSwapPrepared): bigint[][] {
  return prepared.brackets
    .filter((b) => b.kind === EcoBracketKind.Route)
    .slice()
    .sort((a, b) => {
      if (a.sqrtAdjNear !== b.sqrtAdjNear) return a.sqrtAdjNear < b.sqrtAdjNear ? 1 : -1;
      if (a.sqrtAdjFar !== b.sqrtAdjFar) return a.sqrtAdjFar < b.sqrtAdjFar ? 1 : -1;
      return a.refIdx - b.refIdx;
    })
    .map((b) => [BigInt(b.refIdx), b.capacity, b.sqrtAdjNear, b.sqrtAdjFar]);
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

  const { poolTuples, netCache } = buildPoolsAndNetCache(prepared.pools);
  const result = compile(jsSource, {
    // REPO_ROOT resolves "./artifacts/*.json"; __dirname resolves "./IUniswapV2Pair.json".
    baseDirs: [REPO_ROOT, __dirname],
    target,
    args: [
      BigInt(config.tokenIn),
      BigInt(config.tokenOut),
      config.amountIn,
      BigInt(caller),
      prepared.priceLimit,
      poolTuples,
      prepared.routes.map(buildRouteTuple),
      netCache,
      buildRouteSegs(prepared),
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
  // (the all-live walk). Routes stay (they are static segments).
  const usePrepared: EcoSwapPrepared = opts?.noBrackets
    ? {
        ...prepared,
        pools: prepared.pools.map((p) =>
          p.isV2 ? p : { ...p, netRows: [], windowTopShifted: 0n, windowBotShifted: 0n },
        ),
        brackets: prepared.brackets.filter((b) => b.kind === EcoBracketKind.Route),
      }
    : prepared;

  const source = readFileSync(join(__dirname, "ecoswap.sauce.ts"), "utf-8");
  const jsSource = stripTypes(source);
  const { poolTuples, netCache } = buildPoolsAndNetCache(usePrepared.pools);
  const result = compile(jsSource, {
    baseDirs: [REPO_ROOT, __dirname],
    target,
    args: [
      BigInt(config.tokenIn),
      BigInt(config.tokenOut),
      config.amountIn,
      BigInt(caller),
      usePrepared.priceLimit,
      poolTuples,
      usePrepared.routes.map(buildRouteTuple),
      netCache,
      buildRouteSegs(usePrepared),
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
