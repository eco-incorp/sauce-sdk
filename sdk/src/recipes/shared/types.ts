/**
 * Shared TypeScript types for swap recipes.
 */

import type { Hex } from "viem";
import type { SwapPoolType, ChainPoolConfig } from "./constants.js";

// ── Pool discovery ───────────────────────────────────────────

export interface PoolInfo {
  /** Pool address — or, for Uniswap V4, the PoolManager singleton address. */
  address: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  fee: number;
  poolType: SwapPoolType;
  /** Whether this pool supports sqrtPriceLimitX96 (V3/V4 = true, V2 = false) */
  priceLimited: boolean;
  /** sqrtPriceX96 for V3/Algebra pools, synthetic sqrt(k) for V2 pools */
  sqrtPriceX96: bigint;
  /** Concentrated liquidity for V3, reserve-derived for V2 */
  liquidity: bigint;
  /** Human-readable source label (e.g. "Uniswap V3", "Aerodrome V2") */
  source: string;
  // ── Uniswap V4 only (singleton, keyed by poolId) ──
  /** V4 poolId = keccak256(abi.encode(PoolKey)). */
  poolId?: Hex;
  /** V4 StateView lens for reading pool state by poolId. */
  stateView?: Hex;
  /** V4 PoolKey currency0 (sorted token, lower address). */
  currency0?: Hex;
  /** V4 PoolKey currency1 (sorted token, higher address). */
  currency1?: Hex;
  /** V4 tickSpacing (also derived for V3 downstream). */
  tickSpacing?: number;
  /** V4 hooks address (address(0) for hookless pools). */
  hooks?: Hex;
}

// ── Quoting ──────────────────────────────────────────────────

export interface QuoteResult {
  amountIn: bigint;
  amountOut: bigint;
  sqrtPriceAfter: bigint;
  gasEstimate: bigint;
}

// ── MegaSwap ─────────────────────────────────────────────────

export interface MegaSwapConfig {
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
}

export interface PreparedPool {
  pool: PoolInfo;
  quote: QuoteResult;
  delta: bigint;
  feeAdjustedLimit: bigint;
}

export interface MegaSwapResult {
  pools: PreparedPool[];
  stepSize: bigint;
  initialPriceLimit: bigint;
  zeroForOne: boolean;
  expectedOutput: bigint;
}

// ── AlphaSwap ────────────────────────────────────────────────

export interface AlphaSwapConfig {
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
}

/** A multi-hop route discovered off-chain (best pool per leg). */
export interface DiscoveredMultiHopRoute {
  intermediateToken: Hex;
  hop1Pool: PoolInfo;
  hop2Pool: PoolInfo;
}

/**
 * Off-chain preparation result — just discovered pools, no quotes.
 * All runtime decisions (liquidity reading, splitting) happen on-chain.
 */
export interface AlphaSwapPrepared {
  directPools: PoolInfo[];
  multiHopRoutes: DiscoveredMultiHopRoute[];
}

// ── GigaSwap ────────────────────────────────────────────────

export interface GigaSwapConfig {
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
}

export interface GigaSwapDirectPool {
  pool: PoolInfo;
  splitAmount: bigint;
}

export interface GigaSwapMultiHopRoute {
  route: DiscoveredMultiHopRoute;
  splitAmount: bigint;
}

/**
 * Off-chain preparation result — two pool categories:
 *
 * Price-limited pools (V3/V4): get full remaining balance + globalPriceLimit.
 *   The price limit naturally caps fill — deeper pools absorb more.
 *   No pre-computed split needed.
 *
 * No-limit pools (V2/Solidly): get pre-computed depth-proportional splits.
 *   Depth measured via full-amount quote simulation.
 *
 * Series 1: V3 pools sequential (full balance + limit), then V2 pools (splits)
 * Series 2: Sweep leftovers with inverse-delta depth weighting
 */
export interface GigaSwapPrepared {
  /** V3/V4 pools — no splitAmount needed, price limit does the work */
  priceLimitedPools: GigaSwapDirectPool[];
  /** V2 pools — depth-proportional pre-computed splits */
  noLimitPools: GigaSwapDirectPool[];
  /** Multi-hop routes (always use splits, mixed pool types) */
  multiHopRoutes: GigaSwapMultiHopRoute[];
  globalPriceLimit: bigint;
  zeroForOne: boolean;
}

// ── TerraSwap (cross-chain) ─────────────────────────────────

export interface TerraSwapChainConfig {
  name: string;
  rpcUrl: string;
  sauceRouterAddress: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
  /** Chain-specific pool discovery config. Falls back to Base chain if omitted. */
  poolConfig?: ChainPoolConfig;
}

export interface TerraSwapConfig {
  chains: TerraSwapChainConfig[];
}

export interface TerraSwapChainPrepared {
  config: TerraSwapChainConfig;
  /** V3/V4 pools — full balance + price limit */
  priceLimitedPools: GigaSwapDirectPool[];
  /** V2 pools — depth-proportional splits */
  noLimitPools: GigaSwapDirectPool[];
  multiHopRoutes: GigaSwapMultiHopRoute[];
  zeroForOne: boolean;
}

/**
 * Cross-chain preparation result — per-chain splits and a single
 * global price limit that applies across all chains.
 *
 * Series 1: execute splits with globalPriceLimit on all chains in parallel
 * Series 2: depth-weighted re-split from series 1 + new price limit
 * Series 3: final sweep with no limit (if leftovers remain)
 */
export interface TerraSwapPrepared {
  chains: TerraSwapChainPrepared[];
  globalPriceLimit: bigint;
}

// ── EcoSwap ──────────────────────────────────────────────────
//
// EcoSwap generalises GigaSwap's price-limit idea to AMMs that do NOT support
// sqrtPriceLimitX96. Instead of relying on the pool to cap its own fill, it
// reconstructs each pool's liquidity curve off-chain as a set of per-tick
// "brackets", then on-chain solves the optimal split that equalises the
// post-fee marginal execution price across every pool (water-filling), doing
// exactly ONE swap per pool (one per hop for routes).
//
// Unification insight: a constant-product (V2) pool is mathematically identical
// to a single Uniswap-V3 liquidity bracket with L = sqrt(reserveIn * reserveOut).
// So every direct pool — V3 ticks and V2 alike — is represented as brackets in a
// common "out/in" sqrt-price space, and the on-chain solver runs ONE formula:
//   inputForBracket = L * 2^96 * (1/sqrtFar - 1/sqrtNear)   (then grossed-up by fee)

export interface EcoSwapConfig {
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
}

/** Bracket kinds (must match the on-chain `kind` tag). */
export enum EcoBracketKind {
  V3 = 0, // direct concentrated-liquidity bracket (live re-anchor via slot0)
  V2 = 1, // direct constant-product bracket (live re-anchor via getReserves)
  Route = 2, // multi-hop route segment (static, off-chain-precomputed capacity)
}

/**
 * One liquidity bracket in unified out/in sqrt-price space.
 *
 * All sqrt values are Q96 fixed-point in OUT-per-IN orientation (price decreases
 * as the swap proceeds, so sqrtNear > sqrtFar). The `*Adj` values are fee-adjusted
 * (multiplied by sqrt(1-fee)) and are the universal sort/threshold coordinate that
 * makes marginal *execution* prices comparable across pools of different fee tiers.
 */
export interface EcoBracket {
  kind: EcoBracketKind;
  /** Index into EcoSwapPrepared.pools (V3/V2) or .routes (Route). */
  refIdx: number;
  /** Spot out/in sqrtP at the near (entry) edge — higher price. */
  sqrtNear: bigint;
  /** Spot out/in sqrtP at the far (exit) edge — lower price. */
  sqrtFar: bigint;
  /** Bracket liquidity L (V3). For V2 it is recomputed live on-chain; for routes unused. */
  liquidity: bigint;
  /** Pre-computed gross input capacity to traverse the full bracket (tokenIn units). */
  capacity: bigint;
  /** Fee-adjusted sqrt at the near edge (sort key, descending). */
  sqrtAdjNear: bigint;
  /** Fee-adjusted sqrt at the far edge (threshold coordinate). */
  sqrtAdjFar: bigint;
}

/** Direct-pool descriptor (live-readable on-chain). */
export interface EcoPool {
  poolType: SwapPoolType;
  /** Pool address (V2/V3) — or the PoolManager singleton address (V4). */
  address: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Hex;
  /** parts-per-million fee (e.g. 3000 = 0.30%). */
  feePpm: number;
  /** true => constant-product (read getReserves); false => V3/V4 (read slot0). */
  isV2: boolean;
  /** For V2 live reserve orientation: is tokenIn the pool's token0? */
  inIsToken0: boolean;
  /** V4 only: StateView lens address (0x0 for V2/V3). */
  stateView: Hex;
  /** V4 only: poolId = keccak256(abi.encode(PoolKey)) (0x0 for V2/V3). */
  poolId: Hex;
  /**
   * Adaptive (WS4) frontier seeds for the on-chain streaming tick walk — the
   * point where buildV3Brackets STOPPED reading the prepared window. The solver
   * resumes a live ticks()/getTickLiquidity walk from here when a pool's brackets
   * are exhausted while cum < amountIn. Default 0 (off) → loop never fires →
   * behavior byte-identical to non-adaptive. V3/V4 only (V2 has one wide bracket).
   */
  /** (tick + OFFSET) of the first un-walked boundary; OFFSET = 888000. 0 = off. */
  adaptiveStartShifted: bigint;
  /** REAL sqrt (token1/token0, Q96) at the near edge = getSqrtRatioAtTick(last crossed boundary). */
  adaptiveNearReal: bigint;
  /** Active L entering the first un-walked step. */
  adaptiveStartL: bigint;
  /** floor(sqrt(1.0001^ts)*2^96) = getSqrtRatioAtTick(ts) — the multiplicative step ratio. */
  adaptiveStepRatio: bigint;
  /**
   * WINDOW-TOP seed — pool tuple [14] = the prepare-time spot, used by the solver as the
   * DRIFT GATE (the re-anchor trigger). DUAL MEANING by pool type:
   *   - V3/V4: REAL sqrt (token1/token0, Q96) at the top prepared bracket's near edge =
   *     the prepare-time spot real sqrt (spotReal). Stamped == spotReal so the seam is
   *     exact (the top forward bracket's sqrtNear == toOutIn(spotReal)).
   *   - V2: OUT/IN sqrt = the shallowest kept V2 bracket's sqrtNear = the prepare-time V2
   *     spot out/in.
   * The solver compares the LIVE out/in spot to toOutIn(this): on ANY drift (live != top,
   * UP or DOWN) the pool RE-ANCHORS its single dn walk to the live spot and the merge
   * STALE-SKIPS the spot-anchored prepared cache; with no drift (live == top) the prepared
   * cache + the prepare-time dn seed run unchanged. (There is no separate up-frontier — an
   * earlier drift-UP clamp-and-splice was replaced by this symmetric re-anchor.)
   * 0 ⇒ no top edge known (no brackets) ⇒ no drift gate ⇒ the dn walk runs from the spot
   * seed (the no-bracket / quote / no-cache path).
   */
  topNearReal: bigint;
  /**
   * Forward-bracket count — pool tuple [15]. Number of prepared forward brackets the
   * cache carries for this pool AFTER the trim (re-stamped from frontierByCount). 0 ⇒ NO
   * cached window ⇒ the dn walk runs from the spot seed (the no-cache / 1-RPC quote path).
   * >0 ⇒ the merge consumes that many cached brackets before the dn frontier (at no drift;
   * on any drift the whole cache is stale-skipped and the live dn walk covers it). V3/V4.
   */
  bracketCount: number;
  /**
   * OFF-CHAIN-ONLY liquidityNet map (tick → net) for the oracle's mirrored walk.
   * Populated from the lens `net` map in buildV3Brackets. NOT in the compiler tuple
   * (the on-chain solver reads net live via ticks()/getTickLiquidity). Undefined when
   * not prepared adaptively.
   */
  adaptiveNet?: Map<number, bigint>;
  /**
   * OFF-CHAIN-ONLY per-forward-bracket frontier snapshots (V3/V4). `frontierByCount[k]`
   * is the dn-frontier ENTRY state AFTER `k` forward brackets were emitted — exactly the
   * `(adaptiveStartShifted, adaptiveNearReal, adaptiveStartL)` the dn walk should resume
   * from if the prepared cache is TRIMMED to `k` brackets for this pool. `[0]` is the spot
   * seed (no brackets crossed); the last entry equals the full-window seed.
   *
   * Why it exists: buildV3Brackets stamps the dn seed at the END of the FULL lens window,
   * but `prepareEcoSwap` then TRIMS the ladder to only the crossed brackets. After the
   * trim a pool may keep K < window brackets, so the full-window seed sits K..window ticks
   * PAST the last kept bracket — a gap the dn frontier would skip (the live walk resumes
   * too deep, mis-allocating across pools under with-swap drift). prepareEcoSwap re-stamps
   * the seed from `frontierByCount[K]` after the trim so the dn frontier is CONTIGUOUS with
   * the kept cache. NOT in the compiler tuple (only the re-stamped scalar seeds ship).
   */
  frontierByCount?: { shifted: bigint; nearReal: bigint; L: bigint }[];
  /**
   * OFF-CHAIN-ONLY re-anchor drift model (oracle mirror, ecoswap.reference.ts). The
   * deterministic local tests run live==prepared, so the re-anchor is a no-op unless a
   * test deliberately models drift. When set, the oracle treats these as the modeled
   * LIVE drifted spot and RE-ANCHORS the pool's dn walk to it, exactly as the on-chain
   * solver does:
   *   liveCurRealOverride — REAL sqrt of the modeled live (drifted) price.
   *   liveTickOverride    — modeled live tick (drives the start boundary, mirroring
   *                         the on-chain ((liveTick+OFFSET)/ts)*ts derivation).
   *   liveLOverride       — modeled live active L (the re-anchored walk's entry liquidity).
   * Unset ⇒ modeled live == spot (topNearReal) ⇒ no drift ⇒ the oracle re-anchor is a
   * no-op, so every existing vector is unchanged. NOT in the compiler tuple.
   */
  liveCurRealOverride?: bigint;
  liveTickOverride?: number;
  liveLOverride?: bigint;
  source: string;
}

/** Multi-hop route descriptor (two hops through an intermediate base token). */
export interface EcoRoute {
  route: DiscoveredMultiHopRoute;
}

/**
 * Off-chain preparation result.
 *
 * `brackets` is the global ladder, pre-sorted DESCENDING by sqrtAdjNear — the
 * on-chain solver walks it once to find the common marginal-price cut, then
 * executes one swap per pool re-anchored to live prices.
 */
export interface EcoSwapPrepared {
  pools: EcoPool[];
  routes: EcoRoute[];
  brackets: EcoBracket[];
  zeroForOne: boolean;
  /** Real-sqrt-space extreme price limit for the swap calls (direction-dependent). */
  priceLimit: bigint;
  /** Sum of off-chain bracket capacities consumed up to amountIn (diagnostic). */
  expectedInputCovered: bigint;
}
