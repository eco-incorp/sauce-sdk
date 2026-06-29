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
// sqrtPriceLimitX96. Instead of relying on the pool to cap its own fill, the
// on-chain solver runs ONE price-ordered merge where every direct pool walks a
// single frontier from its LIVE spot, one tickSpacing per step, reusing the
// drift-invariant per-pool net cache prepare ships — and finds the split that
// equalises the post-fee marginal execution price across every pool, doing
// exactly ONE swap per pool (one per hop for routes).
//
// Unification insight: a constant-product (V2) pool is mathematically identical
// to a single Uniswap-V3 liquidity range with L = sqrt(reserveIn * reserveOut).
// So every direct pool — V3 ticks and V2 alike — is integrated in a common
// "out/in" sqrt-price space, and the on-chain solver runs ONE formula:
//   inputForStep = L * 2^96 * (1/sqrtFar - 1/sqrtNear)   (then grossed-up by fee)

export interface EcoSwapConfig {
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
}

/** Bracket kinds (must match the on-chain `kind` tag). */
export enum EcoBracketKind {
  V3 = 0, // direct concentrated-liquidity bracket (route legs only)
  V2 = 1, // direct constant-product bracket (route legs only)
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
  // ── Unified-walk per-pool cache (the live walk reuses the drift-invariant NET) ──
  /** floor(sqrt(1.0001^ts)*2^96) = getSqrtRatioAtTick(ts) — the multiplicative step ratio. V3/V4. */
  stepRatio?: bigint;
  /**
   * SHALLOWEST scanned tick (shifted; OFFSET = 888000) — the top of the cache window.
   * 0 ⇒ NO cache (the quote / 1-RPC path) ⇒ the walk staticcalls every boundary. A boundary
   * within [windowBotShifted, windowTopShifted] reads net from the per-pool netCache (or net
   * 0 if uninitialized); a boundary outside reads net via a ticks()/getTickLiquidity
   * staticcall. The net VALUE is drift-invariant either way, so the cache is a pure gas
   * optimization — the solver is wei-exact with the oracle regardless of the window. V3/V4.
   */
  windowTopShifted?: bigint;
  /** DEEPEST scanned tick (shifted) — the bottom of the cache window. V3/V4. */
  windowBotShifted?: bigint;
  /**
   * DEEPEST INITIALIZED tick (shifted) — the terminate gate. The frontier deactivates on a
   * step only when dL==0 AND the boundary is PAST this tick (in the swap direction), so an
   * interior dL==0 gap keeps walking and resumes when net brings L back (the oracle mirror,
   * the Issue-2 walk-through-gaps fix). 0 ⇒ no initialized ticks (a constant-L curve;
   * terminates via fill / price-limit / the per-pool cap). V3/V4.
   */
  extremeShifted?: bigint;
  /**
   * OFF-CHAIN-ONLY: the prepare-time SPOT boundary (shifted) — the start of the no-drift
   * walk (zeroForOne: tickShiftedBase(spotTick); oneForZero: + ts). The reference seeds its
   * live frontier here when no drift override is set. V3/V4.
   */
  spotTickShifted?: bigint;
  /** OFF-CHAIN-ONLY: REAL sqrt at the prepare-time spot — the no-drift walk's near edge. V3/V4. */
  spotNearReal?: bigint;
  /** OFF-CHAIN-ONLY: active L at the prepare-time spot — the no-drift walk's entry L. V3/V4. */
  spotActiveL?: bigint;
  /**
   * The per-pool net cache rows: [shiftedTick, rawNet] for every INITIALIZED tick in the
   * scanned window, sorted in SWAP DIRECTION. rawNet is the raw uint128 ticks() returns
   * (signed >= 0 ? signed : signed + 2^128). index.ts flattens these into the top-level
   * netCache compiler arg (per-pool grouped via netStart/netCount). V3/V4.
   */
  netRows?: { shiftedTick: bigint; rawNet: bigint }[];
  /**
   * OFF-CHAIN-ONLY liquidityNet map (tick → SIGNED net) for the reference's mirrored walk.
   * Populated from the lens `net` map. NOT in the compiler tuple (the on-chain solver reads
   * net from the netCache or live via ticks()/getTickLiquidity). Undefined when not prepared.
   */
  adaptiveNet?: Map<number, bigint>;
  /**
   * OFF-CHAIN-ONLY drift model (reference mirror, ecoswap.solver-reference.ts). The
   * deterministic local tests run live==prepared spot, so these are unset unless a test
   * deliberately models drift. When set, the reference walks the pool's single frontier
   * FROM this modeled live spot (the cached NET is drift-invariant, so the walk stays
   * wei-exact with the oracle regardless of the drift):
   *   liveCurRealOverride — REAL sqrt of the modeled live (drifted) price (V2: out/in spot).
   *   liveTickOverride    — modeled live tick (drives the start boundary, mirroring the
   *                         on-chain tickShiftedBase derivation).
   *   liveLOverride       — modeled live active L (the walk's entry liquidity; V2: √k).
   * Unset ⇒ modeled live == the prepare-time spot (the spot* fields) ⇒ no drift. NOT in the
   * compiler tuple.
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
 * Direct pools carry per-pool net caches (the drift-invariant tick depth the on-chain
 * unified walk reuses); they ship NO prepare-time sqrt edges. `brackets` now holds ROUTE
 * segments only (kind === Route), pre-sorted DESCENDING by sqrtAdjNear, consumed by one
 * cursor in the merge (routes are static — composed off-chain, no live re-price).
 */
export interface EcoSwapPrepared {
  pools: EcoPool[];
  routes: EcoRoute[];
  brackets: EcoBracket[];
  zeroForOne: boolean;
  /** Real-sqrt-space extreme price limit for the swap calls (direction-dependent). */
  priceLimit: bigint;
  /** Sum of route-segment capacities (diagnostic; direct-pool depth is read live). */
  expectedInputCovered: bigint;
}
