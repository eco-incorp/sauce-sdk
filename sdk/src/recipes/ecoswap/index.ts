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
 *  stepRatio, windowTopShifted, windowBotShifted, extremeShifted, netStart, netCount, isKyber,
 *  isAlgebra]
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
    p.isAlgebra ? 1n : 0n, // [17] Algebra dynamic-fee CL: read globalState() (NO slot0) for the spot; 0 ⇒ V3/V4 slot0/StateView
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
      // Append this leg's pools contiguously, deduping any already in the universe. NOTE: prepare's
      // disjoint-route filter now guarantees every admitted leg pool address is claimed by at most
      // ONE execution context (no direct/route/reverse-direction collision), so `indexByAddr` never
      // finds an existing entry here — the dedup is DEAD (kept as a defensive guard so a future
      // collision would still resolve to one slot rather than double-execute).
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
      // the contiguous append for the common (no-dedupe) case. With the disjoint filter every leg
      // pool is freshly appended, so the slice is always contiguous (base = first index).
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
/**
 * The chain-wide Fluid DEX DexReservesResolver address (the estimateSwapIn quote target the on-chain solver
 * staticcalls for every Fluid slice) — carried as `cfg[6]`. All Fluid pools on a chain share one resolver,
 * so take the first prepared Fluid venue's resolver; 0 when no Fluid venue (the guard folds the branch away
 * under treeshake, so the 0 is never dereferenced).
 */
function fluidResolverAddr(prepared: EcoSwapPrepared): bigint {
  const first = prepared.fluidPools?.[0];
  return first ? BigInt(first.resolver) : 0n;
}

/**
 * The chain-wide Mento V2 Broker address (the getAmountOut quote + swapIn target the on-chain solver calls
 * for every Mento slice) — carried as `cfg[7]`. All Mento venues on a chain share one Broker, so take the
 * first prepared Mento venue's broker; 0 when no Mento venue (the guard folds the branch away under
 * treeshake, so the 0 is never dereferenced). The per-venue exchangeProvider/exchangeId travel in the segs
 * row (venue = segs[5], exchangeId = segs[6]).
 */
function mentoBrokerAddr(prepared: EcoSwapPrepared): bigint {
  const first = prepared.mentoPools?.[0];
  return first ? BigInt(first.broker) : 0n;
}

/**
 * The chain-wide Balancer V3 Router address (the querySwapSingleTokenExactIn quote + swapSingleTokenExactIn +
 * Permit2-approve-spender target the on-chain solver uses for every Balancer V3 slice) — carried as `cfg[8]`.
 * Balancer V3's Vault is a CREATE2 singleton (same on all chains) but the Router DIFFERS per chain, so the
 * per-chain Router is threaded here; all V3 pools on a chain share one Router, so take the first prepared V3
 * venue's router; 0 when no V3 venue (the guard folds the branch away under treeshake, so the 0 is never
 * dereferenced). The per-venue POOL travels in the segs row (venue = segs[5]).
 */
function balancerV3RouterAddr(prepared: EcoSwapPrepared): bigint {
  const first = prepared.balancerV3Pools?.[0];
  return first ? BigInt(first.router) : 0n;
}

/**
 * The chain-wide Balancer V3 Vault (CREATE2 singleton, SAME address on all chains) — carried as `cfg[10]`. The
 * on-chain solver reads its LIVE state per QL slice: getCurrentLiveBalances(pool) (inline-indexed), plus
 * getStaticSwapFeePercentage(pool), to replay the amplified StableSwap invariant. All V3 pools on a chain
 * share ONE Vault, so take the first prepared V3 venue's vault; 0 when no V3 venue (the guard folds the branch
 * away under treeshake, so the 0 is never dereferenced).
 */
function balancerV3VaultAddr(prepared: EcoSwapPrepared): bigint {
  const first = prepared.balancerV3Pools?.[0];
  return first ? BigInt(first.vault) : 0n;
}

/**
 * The chain-wide Balancer V2 Vault (the canonical singleton 0xBA12…, SAME address on every EVM chain) —
 * carried as `cfg[11]`. The on-chain solver reads its LIVE per-token balances per QL slice via
 * getPoolTokenInfo(poolId, token) SCALARS (cash+managed — the v12-safe read). All V2 ComposableStable pools on
 * a chain share ONE Vault, so take the first prepared Balancer venue's vault; 0 when no V2 venue (the guard
 * folds the branch away under treeshake, so the 0 is never dereferenced). Distinct from cfg[10] (the V3 Vault).
 */
function balancerV2VaultAddr(prepared: EcoSwapPrepared): bigint {
  const first = prepared.balancerStables?.[0];
  return first ? BigInt(first.vault) : 0n;
}

/**
 * Build the QUOTE-LADDER (QL) venue DESCRIPTOR array — one row per QL venue, UNIFORM 10 columns:
 *   qlv[v] = [poolAddr, i, j, feePpm, segKind, refIdx, rpIn, rpOut, decScaleIn, decScaleOut]
 * Columns 6..9 (rpIn/rpOut/decScaleIn/decScaleOut) are used ONLY by Balancer V3 (segKind 14) and are
 * padded 0 for every other family (see the balancerV3Rows emit + pad10 below).
 * NO sampled values — the solver builds each venue's price ladder ON-CHAIN in setup from LIVE
 * cook-time quotes (prepare-optional: prepare ships only the descriptor). `i`/`j` are the descriptor
 * scalars, re-purposed per family: Curve int128 / CryptoSwap uint256 coin indices; LB packs `swapForY`
 * into `i`; Mento packs the exchangeId (bytes32 as uint256) into `i`; Balancer V3 packs inIdx/outIdx
 * into `i`/`j`; UNUSED (0) for Solidly/WOOFi, which quote by tokenIn/tokenOut. `feePpm` is informational
 * (every QL quote is post-fee, so the on-chain head needs no fee-adjust). Eleven QL families ship today,
 * each with a distinct `segKind` + a SEPARATE on-chain per-venue accumulator, so their `refIdx` counters
 * are INDEPENDENT (0-based into each family's list):
 *   segKind 1  = Curve StableSwap → bestKind===1 cursor → engine swap(poolType:3) → _swapCurve
 *                                   (refIdx → the on-chain `cinp[refIdx]`/`cven[refIdx]` slot).
 *   segKind 2  = Trader Joe LB   → engine swap(poolType:6) → _swapTraderJoeLB (transfer-first; refIdx →
 *                                   the on-chain `linp[refIdx]`/`lven[refIdx]` slot). qd[1]=swapForY. The
 *                                   QL quote uses the GRACEFUL pair.getSwapOut(xIn, swapForY)→(amountInLeft,
 *                                   amountOut) and caps each slice at the LIVE fillable bin capacity
 *                                   (effAbsorbed = xIn − amountInLeft) so the transfer-first exec never
 *                                   over-asks (the OutOfLiquidity-DoS is gone).
 *   segKind 9  = Curve CryptoSwap → callback-free get_dy(uint256,...) + approve + exchange(uint256,...)
 *                                   (refIdx → the on-chain `cryinp[refIdx]`/`cryven[refIdx]` slot).
 *   segKind 4  = Solidly STABLE   → callback-free getAmountOut(xIn,tokenIn) + transfer + pool.swap
 *                                   (refIdx → the on-chain `sinp[refIdx]`/`sven[refIdx]` slot). The QL
 *                                   quote PROBES-THEN-DECODES getAmountOut (it can revert on _get_y
 *                                   non-convergence at a large input).
 *   segKind 10 = WOOFi (WooPPV2)  → callback-free query + transfer + swap (refIdx → the on-chain
 *                                   `wooinp[refIdx]`/`wooven[refIdx]` slot). The QL quote uses the
 *                                   GRACEFUL tryQuery(tokenIn,tokenOut,xIn) (never reverts → returns 0
 *                                   on a cap / feasibility failure), a plain staticcall; the EXEC still
 *                                   uses the reverting query for the minToAmount.
 *   segKind 13 = Mento V2         → callback-free broker.getAmountOut + approve BROKER + broker.swapIn
 *                                   (refIdx → the on-chain `mtinp[refIdx]`/`mtven[refIdx]`/`mtxid[refIdx]`
 *                                   slot). qd[0]=exchangeProvider, qd[1]=exchangeId (bytes32 as uint256,
 *                                   intact); the chain-wide Broker is cfg[7]. The solver emits
 *                                   msVen=provider, msAux=exchangeId. The QL quote PROBES-THEN-DECODES
 *                                   getAmountOut (it can revert on a misconfigured exchange).
 * Carried as a SEPARATE top-level compiler param so its reads stay at nesting depth ≤ 2.
 */
function buildQLVenues(prepared: EcoSwapPrepared): bigint[][] {
  const curves = prepared.curves ?? [];
  const cryptoSwaps = prepared.cryptoSwaps ?? [];
  const solidlyStables = prepared.solidlyStables ?? [];
  const wooFiPools = prepared.wooFiPools ?? [];
  const lbs = prepared.lbs ?? [];
  const mentoPools = prepared.mentoPools ?? [];
  const dodos = prepared.dodos ?? [];
  const wombats = prepared.wombats ?? [];
  const fermiPools = prepared.fermiPools ?? [];
  const eulerSwaps = prepared.eulerSwaps ?? [];
  const balancerV3Pools = prepared.balancerV3Pools ?? [];
  const balancerStables = prepared.balancerStables ?? [];
  const maverickPools = prepared.maverickPools ?? [];
  const curveRows = curves.map((c, refIdx) => [
    BigInt(c.address),
    BigInt(c.i),
    BigInt(c.j),
    BigInt(c.feePpm),
    1n, // segKind = Curve StableSwap
    BigInt(refIdx),
  ]);
  const cryptoRows = cryptoSwaps.map((c, refIdx) => [
    BigInt(c.address),
    BigInt(c.i),
    BigInt(c.j),
    BigInt(c.feePpm),
    9n, // segKind = Curve CryptoSwap (uint256 coin indices; callback-free exchange)
    BigInt(refIdx),
  ]);
  const solidlyRows = solidlyStables.map((s, refIdx) => [
    BigInt(s.address),
    0n, // i unused (Solidly quotes by tokenIn, not a coin index)
    0n, // j unused
    BigInt(s.feePpm),
    4n, // segKind = Solidly STABLE (getAmountOut; callback-free transfer + swap)
    BigInt(refIdx),
  ]);
  const wooFiRows = wooFiPools.map((w, refIdx) => [
    BigInt(w.address),
    0n, // i unused (WOOFi quotes by tokenIn/tokenOut, not a coin index)
    0n, // j unused
    BigInt(w.feePpm),
    10n, // segKind = WOOFi (WooPPV2 sPMM; tryQuery on the ladder, query on the exec)
    BigInt(refIdx),
  ]);
  // Trader Joe LB: qd[0]=pair, qd[1]=swapForY (0/1, tokenIn == pair.getTokenX()), qd[2] unused. The QL
  // ladder quotes the GRACEFUL pair.getSwapOut(xIn, swapForY)→(amountInLeft, amountOut) and caps each slice
  // at the LIVE fillable bin capacity (effAbsorbed = xIn − amountInLeft); EXEC stays engine poolType 6.
  const lbRows = lbs.map((l, refIdx) => [
    BigInt(l.address),
    l.swapForY ? 1n : 0n, // swapForY (the on-chain getSwapOut direction bit)
    0n, // j unused
    BigInt(l.feePpm),
    2n, // segKind = Trader Joe LB (getSwapOut on the ladder; engine _swapTraderJoeLB on the exec)
    BigInt(refIdx),
  ]);
  // Mento V2: qd[0]=exchangeProvider, qd[1]=exchangeId (bytes32 as uint256, intact), qd[2] unused. The QL
  // ladder quotes broker.getAmountOut(provider, exchangeId, tokenIn, tokenOut, xIn) via probe-then-decode;
  // the chain-wide Broker is cfg[7]. The solver emits msVen=provider, msAux=exchangeId so the segKind-13
  // accumulator/exec (approve BROKER + broker.swapIn) key by (provider, exchangeId). EXEC unchanged.
  const mentoRows = mentoPools.map((m, refIdx) => [
    BigInt(m.exchangeProvider),
    BigInt(m.exchangeId), // bytes32 exchangeId as uint256 — kept intact (not truncated)
    0n, // j unused
    BigInt(m.feePpm),
    13n, // segKind = Mento V2 (Broker getAmountOut on the ladder; approve BROKER + swapIn on the exec)
    BigInt(refIdx),
  ]);
  // DODO V2 PMM: qd[0]=pool, qd[1]=isSellBase (0/1, tokenIn == pool._BASE_TOKEN_() — computed in prepare
  // via discoverDodoV2PoolsTyped's orientation), qd[2] unused. The QL ladder quotes the DIRECTIONAL
  // querySellBase(caller,xNext)[0] / querySellQuote(caller,xNext)[0] view (probe-then-decode, post-fee);
  // EXEC stays engine poolType 5 (_swapDODOV2 resolves orientation on-chain from _BASE_TOKEN_()).
  const dodoRows = dodos.map((d, refIdx) => [
    BigInt(d.address),
    d.sellBase ? 1n : 0n, // isSellBase — the on-chain querySell* direction bit
    0n, // j unused
    BigInt(d.feePpm),
    3n, // segKind = DODO V2 (querySell* on the ladder; engine _swapDODOV2 on the exec)
    BigInt(refIdx),
  ]);
  // Wombat (single-sided stableswap): qd[0]=pool, qd[1..2] unused (quotes by fromToken/toToken). The QL
  // ladder quotes quotePotentialSwap(tokenIn,tokenOut,xNext)[0] (probe-then-decode, post-haircut); EXEC
  // stays callback-free (approve + pool.swap).
  const wombatRows = wombats.map((w, refIdx) => [
    BigInt(w.address),
    0n, // i unused (Wombat quotes by fromToken/toToken)
    0n, // j unused
    BigInt(w.feePpm),
    5n, // segKind = Wombat (quotePotentialSwap on the ladder; approve + pool.swap on the exec)
    BigInt(refIdx),
  ]);
  // Fermi / propAMM (Obric-style proactive AMM): qd[0]=pool, qd[1..2] unused (quotes by tokenIn/tokenOut).
  // The QL ladder quotes quoteAmounts(tokenIn,tokenOut,xNext)[1] (probe-then-decode, post-fee — the SECOND
  // return is the exact-in out); EXEC stays callback-free (approve + fermiSwapWithAllowances).
  const fermiRows = fermiPools.map((f, refIdx) => [
    BigInt(f.address),
    0n, // i unused (Fermi quotes by tokenIn/tokenOut)
    0n, // j unused
    BigInt(f.feePpm),
    11n, // segKind = Fermi (quoteAmounts on the ladder; approve + fermiSwapWithAllowances on the exec)
    BigInt(refIdx),
  ]);
  // EulerSwap (Euler vault-backed AMM, v1+v2): qd[0]=pool, qd[1..2] unused (Euler quotes by tokenIn/tokenOut).
  // The QL ladder quotes computeQuote(tokenIn,tokenOut,xNext,true) (probe-then-decode, post-fee — the exact-in
  // dy). computeQuote REVERTS past the LIVE vault inLimit/outLimit, so the probe self-truncates the ladder at
  // the live cap (NO getLimits call) — the award is bounded by live capacity, so the exec never cap-reverts.
  // EXEC stays callback-free (computeQuote minOut + transfer + getAssets-oriented pool.swap(...,"")).
  const eulerRows = eulerSwaps.map((e, refIdx) => [
    BigInt(e.address),
    0n, // i unused (Euler quotes by tokenIn/tokenOut)
    0n, // j unused
    BigInt(e.feePpm),
    7n, // segKind = EulerSwap (computeQuote on the ladder; computeQuote + transfer + pool.swap on the exec)
    BigInt(refIdx),
  ]);
  // Balancer V3 (balancer-v3-monorepo Vault + per-chain Router) — segKind 14. UNIQUE among QL venues: its
  // querySwapSingleTokenExactIn is eth_call-ONLY (uncallable on-chain), so it does NOT quote a live view;
  // instead the solver replays the amplified StableSwap invariant on-chain from LIVE Vault state. That needs
  // FOUR extra descriptor fields beyond the base six — the tokenIn/tokenOut rate providers (rpIn/rpOut, the
  // solver's on-chain getRate() targets) and the CONST decimal scaling factors (decScaleIn/decScaleOut =
  // 10^(18−decimals)). amp + the static fee are read LIVE on-chain (getAmplificationParameter()[0] /
  // getStaticSwapFeePercentage), so they need NO descriptor slot; the Vault is chain-wide (cfg[10]). qd[1]/qd[2]
  // carry inIdx/outIdx (the getCurrentLiveBalances slots). These 4 fields (qd[6..9]) are the reason EVERY qlv
  // row is padded to 10 columns below — the non-BalV3 venues carry 0 for all four.
  const balancerV3Rows = balancerV3Pools.map((b, refIdx) => [
    BigInt(b.address),
    BigInt(b.inIdx), // i = tokenIn Vault index (getCurrentLiveBalances slot)
    BigInt(b.outIdx), // j = tokenOut Vault index
    BigInt(b.feePpm),
    14n, // segKind = Balancer V3 (on-chain StableMath QL; Permit2 two-step + swapSingleTokenExactIn on the exec)
    BigInt(refIdx),
    BigInt(b.rpIn), // qd[6] = tokenIn rate provider (getRate scalar)
    BigInt(b.rpOut), // qd[7] = tokenOut rate provider
    b.decScaleIn, // qd[8] = 10^(18−decIn)
    b.decScaleOut, // qd[9] = 10^(18−decOut)
  ]);
  // Balancer V2 ComposableStable — segKind 6. Like V3 its quote (Vault.queryBatchSwap) is eth_call-ONLY, so the
  // solver replays the amplified StableSwap invariant on-chain from LIVE Vault state (V2 rounding). qd[1]/qd[2]
  // carry the NON-BPT invariant-order indices of tokenIn/tokenOut. The 4 extra columns carry: qd[6] = the
  // Vault poolId (the getPoolTokenInfo(poolId, token) argument); qd[7] = the THIRD non-BPT token address (0 for
  // a 2-token pool) — the two others ARE tokenIn/tokenOut (read from cfg on-chain); qd[8] = the packed FULL
  // registered scaling positions (regPos0 | regPos1<<8 | regPos2<<16 in non-BPT order, for the live
  // getScalingFactors inline-index); qd[9] = the non-BPT token count (2 or 3). amp + fee are read LIVE on-chain
  // (no descriptor slot); the Vault is chain-wide (cfg[11]). EXEC stays engine poolType 4 (_swapBalancerV2 →
  // Vault.swap(GIVEN_IN)); refIdx → the on-chain binp[refIdx]/bven[refIdx] accumulator (segKind 6, unchanged).
  const balancerRows = balancerStables.map((b, refIdx) => {
    const n = b.nonBptTokens.length;
    // The third non-BPT index (the one that is neither tokenIn (i) nor tokenOut (j)); 0/none for a 2-token pool.
    const thirdIdx = n === 3 ? [0, 1, 2].find((p) => p !== b.i && p !== b.j)! : -1;
    const thirdAddr = thirdIdx >= 0 ? BigInt(b.nonBptTokens[thirdIdx]) : 0n;
    // Packed FULL registered scaling positions in non-BPT order (each ≤ 255 for any real ComposableStable).
    const rp = b.nonBptRegPos;
    const packedReg =
      BigInt(rp[0] ?? 0) | (BigInt(rp[1] ?? 0) << 8n) | (BigInt(rp[2] ?? 0) << 16n);
    return [
      BigInt(b.address),
      BigInt(b.i),
      BigInt(b.j),
      BigInt(b.feePpm),
      6n, // segKind = Balancer V2 ComposableStable (on-chain StableMath QL; engine _swapBalancerV2 on the exec)
      BigInt(refIdx),
      BigInt(b.poolId), // qd[6] = Vault poolId (getPoolTokenInfo argument)
      thirdAddr, // qd[7] = third non-BPT token address (0 for a 2-token pool)
      packedReg, // qd[8] = packed registered scaling positions (regPos0 | regPos1<<8 | regPos2<<16)
      BigInt(n), // qd[9] = non-BPT token count (2 or 3)
    ];
  });
  // Maverick V2 (bin-based directional AMM) — segKind 8. The solver's segKind-8 branch WALKS the pool's bin
  // book on-chain from the LIVE active tick/price (Maverick has no cumulative-out view to quote), so the
  // descriptor ships ONLY the walk seeds: qd[1] = tokenAIn (1 iff tokenIn == the pool's tokenA ⇒ price rises)
  // and qd[2] = tickSpacing (the bin width exponent). fee(tokenAIn), the active tick, and every per-tick
  // reserve are read LIVE on-chain (no descriptor slot, so the walk re-anchors to any drift). EXEC is
  // UNCHANGED — engine poolType 7 (_swapMaverickV2 → the pool's maverickV2SwapCallback pulls the input); the
  // segKind-8 accumulator (minp/mven, refIdx-keyed) and the poolType-7 dispatch already handle it.
  const maverickRows = maverickPools.map((m, refIdx) => [
    BigInt(m.address),
    m.tokenAIn ? 1n : 0n, // i = tokenAIn (the walk direction bit)
    BigInt(m.tickSpacing), // j = tickSpacing (the bin-width exponent for the sqrt-price ladder)
    BigInt(m.feePpm),
    8n, // segKind = Maverick V2 (on-chain live bin-walk QL; engine _swapMaverickV2 callback on the exec)
    BigInt(refIdx),
  ]);
  // PAD every SHORT row from 6 → 10 columns (0-fill) so the qlv tuple is uniform-width and the solver's qd[6..9]
  // read is always in range (only BalV3 (segKind 14) + BalV2 (segKind 6) read qd[6..9]; a uniform width keeps
  // the compiler's INDEX safe on every engine). BalV3 + BalV2 rows are already 10 wide.
  const pad10 = (rows: bigint[][]): bigint[][] =>
    rows.map((r) => (r.length >= 10 ? r : [...r, ...new Array(10 - r.length).fill(0n)]));
  return pad10([
    ...curveRows, ...cryptoRows, ...solidlyRows, ...wooFiRows, ...lbRows, ...mentoRows,
    ...dodoRows, ...wombatRows, ...fermiRows, ...eulerRows, ...balancerV3Rows, ...balancerRows,
    ...maverickRows,
  ]);
}

function buildSegs(prepared: EcoSwapPrepared): bigint[][] {
  // NOTE: Curve StableSwap (segKind 1), Trader Joe LB (segKind 2), DODO V2 (segKind 3), Solidly STABLE
  // (segKind 4), Wombat (segKind 5), EulerSwap (segKind 7), Maverick V2 (segKind 8), Curve CryptoSwap
  // (segKind 9), WOOFi (segKind 10), Fermi (segKind 11) and Mento V2 (segKind 13) are NOT read here — all are
  // QUOTE-LADDER (QL) venues (see buildQLVenues), built on-chain from live state, so they ship no static
  // sampled segments. Maverick's on-chain segKind-8 branch WALKS the bin book live (no off-chain sampling).
  const fluidPools = prepared.fluidPools ?? [];
  return prepared.brackets
    .filter(
      (b) =>
        // Only Fluid DEX remains a STATIC sampled-segment venue here. Every other family — Curve StableSwap
        // (1) / Trader Joe LB (2) / DODO V2 (3) / Solidly STABLE (4) / Wombat (5) / Balancer V2 (6) / EulerSwap
        // (7) / Maverick V2 (8) / Curve CryptoSwap (9) / WOOFi (10) / Fermi (11) / Mento V2 (13) / Balancer V3
        // (14) — is a QUOTE-LADDER venue built ON-CHAIN from live state (buildQLVenues), NOT a static segment.
        b.kind === EcoBracketKind.Fluid,
    )
    .slice()
    .sort((a, b) => {
      if (a.sqrtAdjNear !== b.sqrtAdjNear) return a.sqrtAdjNear < b.sqrtAdjNear ? 1 : -1;
      if (a.sqrtAdjFar !== b.sqrtAdjFar) return a.sqrtAdjFar < b.sqrtAdjFar ? 1 : -1;
      return a.refIdx - b.refIdx;
    })
    .map((b) => {
      const isFluid = b.kind === EcoBracketKind.Fluid;
      // Only Fluid DEX (segKind 12, callback-free via the resolver estimate + pool.swapIn) remains a STATIC
      // sampled-segment venue here. Maverick V2 moved to the QL live bin-walk (segKind 8, buildQLVenues).
      const segKind = isFluid ? 12n : 0n;
      const venue = isFluid ? BigInt(fluidPools[b.refIdx].address) : 0n;
      // venueAux (segs[6]) — the per-segment auxiliary 256-bit value. Now that Mento is a QL venue (its
      // exchangeId travels in the qlv descriptor), no STATIC sampled venue uses it, so it is always 0 here;
      // the column is kept to mirror the 7-field seg row the on-chain merge stream expects.
      const venueAux = 0n;
      return [BigInt(b.refIdx), b.capacity, b.sqrtAdjNear, b.sqrtAdjFar, segKind, venue, venueAux];
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
  // Algebra dynamic-fee CL (Camelot/QuickSwap V3, Ramses V2, THENA Fusion, SwapX): V3-shaped, so
  // HAS_V3 covers its tick walk + swapV3 exec; HAS_ALGEBRA lights ONLY the SETUP globalState()
  // spot-read branch (a real Algebra pool has no slot0(), so slot0() would revert the cook — this
  // is the un-masked audit finding). An Algebra pool is always isV2 false, so it also lights HAS_V3.
  const HAS_ALGEBRA = allPools.some((p) => p.isAlgebra === true);
  const HAS_ROUTES = prepared.routes.length > 0;
  const HAS_CURVE = (prepared.curves?.length ?? 0) > 0;
  const HAS_LB = (prepared.lbs?.length ?? 0) > 0;
  const HAS_DODO = (prepared.dodos?.length ?? 0) > 0;
  const HAS_SOLIDLY_STABLE = (prepared.solidlyStables?.length ?? 0) > 0;
  const HAS_WOMBAT = (prepared.wombats?.length ?? 0) > 0;
  const HAS_BALANCER = (prepared.balancerStables?.length ?? 0) > 0;
  const HAS_EULER = (prepared.eulerSwaps?.length ?? 0) > 0;
  const HAS_MAVERICK = (prepared.maverickPools?.length ?? 0) > 0;
  const HAS_CRYPTO = (prepared.cryptoSwaps?.length ?? 0) > 0;
  const HAS_WOOFI = (prepared.wooFiPools?.length ?? 0) > 0;
  const HAS_FERMI = (prepared.fermiPools?.length ?? 0) > 0;
  const HAS_FLUID = (prepared.fluidPools?.length ?? 0) > 0;
  const HAS_MENTO = (prepared.mentoPools?.length ?? 0) > 0;
  const HAS_BALANCER_V3 = (prepared.balancerV3Pools?.length ?? 0) > 0;
  return {
    HAS_V2,
    HAS_V3,
    HAS_V4,
    HAS_ALGEBRA,
    HAS_KYBER,
    HAS_ROUTES,
    HAS_CURVE,
    HAS_LB,
    HAS_DODO,
    HAS_SOLIDLY_STABLE,
    HAS_WOMBAT,
    HAS_BALANCER,
    HAS_EULER,
    HAS_MAVERICK,
    HAS_CRYPTO,
    HAS_WOOFI,
    HAS_FERMI,
    HAS_FLUID,
    HAS_MENTO,
    HAS_BALANCER_V3,
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
  const qlv = buildQLVenues(prepared);
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
    // routing/segs/qlv) stay SEPARATE top-level params so pool/route/segment field reads stay
    // at nesting depth ≤ 2 (folding them in => depth-3 read => v1 INDEX revert). `segs` is the
    // STATIC sampled-segment stream (the 13 not-yet-QL venues); `qlv` is the QUOTE-LADDER venue
    // descriptors (Curve — built on-chain from live get_dy). Both feed the bestKind===1 cursor.
    args: [
      [
        BigInt(config.tokenIn),
        BigInt(config.tokenOut),
        config.amountIn,
        BigInt(caller),
        prepared.priceLimit,
        BigInt(directCount),
        fluidResolverAddr(prepared), // cfg[6] — chain-wide Fluid DEX resolver (0 when no Fluid venue)
        mentoBrokerAddr(prepared), // cfg[7] — chain-wide Mento V2 Broker (0 when no Mento venue)
        balancerV3RouterAddr(prepared), // cfg[8] — chain-wide Balancer V3 Router (0 when no Balancer V3 venue)
        prepared.minOut ?? 0n, // cfg[9] — internal whole-trade amountOutMin FLOOR (0 ⇒ no floor)
        balancerV3VaultAddr(prepared), // cfg[10] — chain-wide Balancer V3 Vault (0 when no Balancer V3 venue)
        balancerV2VaultAddr(prepared), // cfg[11] — chain-wide Balancer V2 Vault (0 when no Balancer V2 venue)
      ],
      poolTuples,
      netCache,
      routing,
      segs,
      qlv,
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
  const qlv = buildQLVenues(usePrepared);
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
        fluidResolverAddr(usePrepared), // cfg[6] — chain-wide Fluid DEX resolver (0 when no Fluid venue)
        mentoBrokerAddr(usePrepared), // cfg[7] — chain-wide Mento V2 Broker (0 when no Mento venue)
        balancerV3RouterAddr(usePrepared), // cfg[8] — chain-wide Balancer V3 Router (0 when no Balancer V3 venue)
        0n, // cfg[9] — amountOutMin floor: 0 on a QUOTE (a read-only quote must never floor-revert)
        balancerV3VaultAddr(usePrepared), // cfg[10] — chain-wide Balancer V3 Vault (0 when no Balancer V3 venue)
        balancerV2VaultAddr(usePrepared), // cfg[11] — chain-wide Balancer V2 Vault (0 when no Balancer V2 venue)
      ],
      poolTuples,
      netCache,
      routing,
      segs,
      qlv,
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
