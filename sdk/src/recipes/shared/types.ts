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
  /**
   * Solidly STABLE (sAMM) only: true ⇒ this is a Solidly stable pool (x3y+y3x invariant), NOT a
   * constant-product xy=k pool — so it must NOT be priced/executed as V2. The legacy
   * `discoverPools` aggregator tags it here (and pins `poolType` to UniV2 only for shape
   * compatibility); the EcoSwap recipe uses the typed `SolidlyStablePool` path instead.
   */
  solidlyStable?: boolean;
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

/**
 * Bracket kinds (must match the on-chain `kind` tag).
 *
 * `EcoSwapPrepared.brackets` is now always `[]` (routes are first-class live-walk venues,
 * not static off-chain-composed segments), so `Route` is UNUSED by EcoSwap. `V3`/`V2` still
 * tag direct-pool brackets in the test fixtures' bracket builders.
 */
export enum EcoBracketKind {
  V3 = 0, // direct concentrated-liquidity bracket (test fixtures)
  V2 = 1, // direct constant-product bracket (test fixtures)
  Route = 2, // UNUSED by EcoSwap (routes are live-walk venues, no static segments)
  Curve = 3, // Curve StableSwap segment (static, off-chain-sampled via the bigint replay)
  LB = 4, // Trader Joe Liquidity Book segment (static, off-chain EXACT one-flat-per-bin)
  DODO = 5, // DODO V2 PMM segment (static, off-chain-sampled via the closed-form querySell* replay)
  SolidlyStable = 6, // Solidly STABLE (sAMM) segment (static, off-chain-sampled via the x3y+y3x replay)
  Wombat = 7, // Wombat single-sided stableswap segment (static, off-chain-sampled via the coverage-ratio replay)
  BalancerStable = 8, // Balancer V2 ComposableStable segment (static, off-chain-sampled via the StableMath A-invariant replay)
  EulerSwap = 9, // EulerSwap (Euler v2 vault-backed AMM) segment (static, off-chain-sampled via the f/fInverse curve replay)
  MaverickV2 = 10, // Maverick V2 (bin-based directional AMM) segment (static, off-chain-sampled via the bin swap-math replay; executed through the engine)
  CryptoSwap = 11, // Curve CryptoSwap (twocrypto/tricrypto-ng volatile-asset) segment (static, off-chain-sampled via the A-gamma invariant replay; executed CALLBACK-FREE via approve + exchange(uint256,...))
  WOOFi = 12, // WOOFi (WooPPV2 synthetic proactive market maker) segment (static, off-chain-sampled via the sPMM oracle-price replay at a snapshot; executed CALLBACK-FREE via transfer + swap(fromToken,toToken,amt,minTo,to,rebateTo))
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
  /**
   * true => KyberSwap Classic / DMM: a V2-shaped pool (isV2 also true) whose curve geometry
   * is on VIRTUAL reserves and whose live read is getTradeInfo() (NOT getReserves()). The
   * merge/oracle/reference treat it identically to a V2 pool seeded from the virtual reserves
   * (L = isqrt(vIn·vOut)); only the on-chain SETUP read and the execution output formula
   * differ (getAmountOut on virtual reserves). false ⇒ a plain UniswapV2-style pool.
   */
  isKyber?: boolean;
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

/**
 * One LEG of a multi-hop route — a single hop (hopIn → hopOut) served by a SET of pools the
 * leg splits across. Each pool is a full `EcoPool` (the same live-walk descriptor a direct
 * pool carries), so a leg pool is byte-identical on-chain to a direct pool and reuses the
 * per-pool frontier walk verbatim. `zeroForOne` is the LEG's swap direction (hopIn is token0
 * iff hopIn's address is lower than hopOut's) — it can differ from the route's overall
 * direction, so each leg pool's on-chain `inIsToken0` field is stamped with THIS leg's
 * `zeroForOne` (see prepare).
 */
export interface EcoLeg {
  hopIn: Hex;
  hopOut: Hex;
  zeroForOne: boolean;
  pools: EcoPool[];
}

/**
 * A multi-hop route is a composite live-walk venue: an ordered list of legs (A→T1→…→B) plus
 * the intermediate tokens between consecutive legs (the final leg's `hopOut` == tokenOut, so
 * `intermediateTokens.length === legs.length - 1`). Each leg splits across all its pools; the
 * route advances by stepping the binding leg's next bracket with conservation at every
 * intermediate. 2-hop V3-leg first; the shape extends to N-hop.
 */
export interface EcoRoute {
  legs: EcoLeg[];
  intermediateTokens: Hex[];
}

/**
 * One Curve StableSwap venue to execute, indexed by an EcoBracket.refIdx (kind === Curve).
 * The curve math is OFF-CHAIN: prepare samples it into static segments (kind Curve) via the
 * bigint replay; the on-chain solver consumes those through the static-segment cursor and
 * EXECUTES the awarded share via swap(SwapParams{poolType:3, …}) → live _swapCurve. The
 * int128 coin indices i/j are the engine ABI; address is the exchange(i,j,dx,min_dy) target.
 */
export interface EcoCurve {
  /** Pool address — the swap(SwapParams{poolType:3, pool}) target / exchange() contract. */
  address: Hex;
  /** int128 coin index of tokenIn. */
  i: number;
  /** int128 coin index of tokenOut. */
  j: number;
  /** Rounded ppm fee (the price-ordering coordinate; the on-chain dy is computed by _swapCurve). */
  feePpm: number;
  source: string;
}

/**
 * One Trader Joe LB venue to execute, indexed by an EcoBracket.refIdx (kind === LB). LB is a
 * DISCRETE-BIN constant-sum AMM: prepare enumerates it into EXACT static segments (one flat
 * segment per bin, kind LB) via the off-chain `buildLbSegments`; the on-chain solver consumes
 * those through the static-segment cursor and EXECUTES the awarded share via
 * swap(SwapParams{poolType:6, pool}) → live _swapTraderJoeLB (one atomic pool.swap(swapForY,
 * to); the engine resolves swapForY on-chain from getTokenX(), so NO bin/price data is passed
 * to the engine). `address` is the pair (the swap target). binStep/feePpm are diagnostics.
 */
export interface EcoLb {
  /** Pair address — the swap(SwapParams{poolType:6, pool}) target. */
  address: Hex;
  /** Bin step in bps (the per-bin price ratio; diagnostic). */
  binStep: number;
  /** Rounded ppm base fee (the price-ordering coordinate; the on-chain out is computed by the pair). */
  feePpm: number;
  source: string;
}

/**
 * One DODO V2 PMM venue to execute, indexed by an EcoBracket.refIdx (kind === DODO). DODO V2 is a
 * Proactive Market Maker: prepare samples its closed-form curve into static segments (kind DODO)
 * via the off-chain `buildDodoSegments` (querySell* replay; the guide price `i` is POOL STATE, not
 * an exogenous feed — so the curve is wei-exact-on-grid). The on-chain solver consumes those through
 * the static-segment cursor and EXECUTES the awarded Σ share via swap(SwapParams{poolType:5, pool})
 * → live _swapDODOV2 (it resolves base/quote orientation on-chain from `_BASE_TOKEN_()`, so NO
 * curve/orientation data is passed to the engine). `address` is the pool (the swap target). feePpm
 * (combined LP+MT) is the price-ordering coordinate / diagnostic.
 */
export interface EcoDodo {
  /** Pool address — the swap(SwapParams{poolType:5, pool}) target. */
  address: Hex;
  /** true => tokenIn is the pool's base token (sell base → quote); diagnostic (engine resolves on-chain). */
  sellBase: boolean;
  /** Rounded ppm combined fee (LP+MT; the price-ordering coordinate; the on-chain out is computed by _swapDODOV2). */
  feePpm: number;
  source: string;
}

/**
 * One Solidly STABLE (sAMM) venue to execute, indexed by an EcoBracket.refIdx (kind === SolidlyStable).
 * Solidly stable pools (Aerodrome/Velodrome/Thena/Ramses sAMM) are NOT xy=k — they trade on the
 * x3y+y3x invariant — so they must NOT be routed through the V2 (_swapV2) path. prepare samples the
 * curve OFF-CHAIN into static segments (kind SolidlyStable) via the bigint replay; the on-chain solver
 * consumes those through the static-segment cursor and EXECUTES the awarded Σ share CALLBACK-FREE: an
 * on-chain `pool.getAmountOut(Σ, tokenIn)` staticcall yields the EXACT out, the awarded input is
 * transferred to the pool, and `pool.swap(amount0Out, amount1Out, to, "")` lands it (output slot
 * oriented by `inIsToken0`). NO engine SwapPoolType — the pool view IS the swap math, so it is
 * wei-exact-in-dy. `address` is the pool; `inIsToken0` orients the output slot; feePpm is the
 * price-ordering coordinate / diagnostic.
 */
export interface EcoSolidlyStable {
  /** Pool address — the getAmountOut/swap target. */
  address: Hex;
  /** true => tokenIn is the pool's token0 (output is amount1Out); false => output is amount0Out. */
  inIsToken0: boolean;
  /** Rounded ppm stable swap fee (the price-ordering coordinate; the on-chain out is the pool view). */
  feePpm: number;
  source: string;
}

/**
 * One Wombat venue to execute, indexed by an EcoBracket.refIdx (kind === Wombat). Wombat is a
 * single-sided MULTI-ASSET stableswap singleton (coverage-ratio quote, NOT xy=k), so it must NOT be
 * routed through the V2 (_swapV2) path. prepare samples the curve OFF-CHAIN into static segments
 * (kind Wombat) via the closed-form coverage-ratio replay; the on-chain solver consumes those
 * through the static-segment cursor and EXECUTES the awarded Σ share CALLBACK-FREE: an on-chain
 * `pool.quotePotentialSwap(fromToken, toToken, Σ)` staticcall yields the EXACT out, the pool is
 * approved for the awarded input (Wombat PULLS via transferFrom), and
 * `pool.swap(fromToken, toToken, Σ, minToAmount, to, deadline)` lands it. NO engine SwapPoolType —
 * the pool view IS the swap math, so it is wei-exact-in-dy. `address` is the pool;
 * `fromToken`/`toToken` are the swap call's token args; feePpm (haircut) is the price-ordering
 * coordinate / diagnostic.
 */
export interface EcoWombat {
  /** Pool address — the quotePotentialSwap/swap/approve target. */
  address: Hex;
  /** The pool's tokenIn (from-token the swap call needs). */
  fromToken: Hex;
  /** The pool's tokenOut (to-token the swap call needs). */
  toToken: Hex;
  /** Rounded ppm haircut fee (the price-ordering coordinate; the on-chain out is the pool view). */
  feePpm: number;
  source: string;
}

/**
 * One Balancer V2 ComposableStable venue to execute, indexed by an EcoBracket.refIdx (kind ===
 * BalancerStable). Balancer stable pools (bb-a-USD class — USDC/USDT/DAI depth on
 * Ethereum/Arbitrum/Polygon) trade on the StableMath A-invariant (NOT xy=k), so prepare samples the
 * curve OFF-CHAIN into static segments (kind BalancerStable) via the bigint replay; the on-chain solver
 * consumes those through the static-segment cursor and EXECUTES the awarded Σ share via the EXISTING
 * engine BalancerV2 dispatch: swap(SwapParams{poolType:4=BalancerV2, pool, tokenIn, tokenOut,
 * amountSpecified: -Σ}) → _swapBalancerV2, which derives poolId via pool.getPoolId() and calls
 * Vault.swap(SingleSwap{GIVEN_IN, assetIn:tokenIn, assetOut:tokenOut}). The Vault handles the BPT
 * exclusion / scaling-factor up-downscale / fee internally, so the SwapParams carry NO curve data —
 * the segment merge already used it. `address` is the POOL (the getPoolId/swap target — NOT the
 * poolId, NOT the Vault). feePpm (the swap fee, rounded) is the price-ordering coordinate / diagnostic.
 */
export interface EcoBalancerStable {
  /** Pool address — the swap(SwapParams{poolType:4, pool}) target (engine derives poolId). */
  address: Hex;
  /** int index of tokenIn into the pool's NON-BPT token set (diagnostic; engine resolves on-chain). */
  i: number;
  /** int index of tokenOut into the pool's NON-BPT token set (diagnostic; engine resolves on-chain). */
  j: number;
  /** Rounded ppm swap fee (the price-ordering coordinate; the on-chain out is computed by the Vault). */
  feePpm: number;
  source: string;
}

/**
 * One EulerSwap (Euler v2 vault-backed AMM) venue to execute, indexed by an EcoBracket.refIdx (kind ===
 * EulerSwap). EulerSwap pools have an ASYMMETRIC concentrated-liquidity curve (f/fInverse, NOT xy=k), so
 * they must NOT be routed through the V2 (_swapV2) path. prepare samples the curve OFF-CHAIN into static
 * segments (kind EulerSwap) via the closed-form f/fInverse replay (BOUNDED by the vault `inLimit` from
 * getLimits); the on-chain solver consumes those through the static-segment cursor and EXECUTES the
 * awarded Σ share CALLBACK-FREE: an on-chain `pool.computeQuote(tokenIn, tokenOut, Σ, true)` staticcall
 * yields the EXACT out (the periphery quoteExactInput delegates to this view, and the view IS the swap
 * math), the awarded input is transferred to the pool, and `pool.swap(amount0Out, amount1Out, to, "")`
 * lands it (EulerSwap's swap is V2-shaped; EMPTY data skips the flash callback, so it is callback-free).
 * NO engine SwapPoolType. `address` is the pool; `inIsToken0` orients the output slot; feePpm is the
 * price-ordering coordinate / diagnostic. The vault-cap edge (the cap binding between prepare and cook)
 * is handled by computeQuote reverting SwapLimitExceeded + the solver's guarded terminal refund.
 */
export interface EcoEulerSwap {
  /** Pool address — the computeQuote/getLimits/swap target. */
  address: Hex;
  /** true => tokenIn is the pool's token0 (output is amount1Out); false => output is amount0Out. */
  inIsToken0: boolean;
  /** Rounded ppm swap fee (the price-ordering coordinate; the on-chain out is the pool computeQuote view). */
  feePpm: number;
  source: string;
}

/**
 * One Maverick V2 venue to execute, indexed by an EcoBracket.refIdx (kind === MaverickV2). Maverick V2
 * is a BIN-based directional AMM whose bins do NOT map to the drift-invariant liquidityNet tick walk
 * (bin L is re-derived per tick from (reserveA,reserveB) and the pool has dynamic-distribution kinds),
 * so it is a SAMPLED-SEGMENT source (like DODO): prepare samples its closed-form bin swap-math into
 * static segments (kind MaverickV2) via the off-chain `buildMaverickSegments` replay; the on-chain
 * solver consumes those through the static-segment cursor and EXECUTES the awarded Σ share via the
 * EXISTING engine MaverickV2 dispatch swap(SwapParams{poolType:7, pool}) → _swapMaverickV2 (Maverick is
 * a CALLBACK pool — the pool re-enters maverickV2SwapCallback mid-swap to pull input — so it MUST go
 * through the engine Router, NOT the callback-free path). The engine reads the pool's tokenA() and sets
 * tokenAIn on-chain, so the SwapParams carry NO curve/orientation data. `address` is the pool (the swap
 * target). feePpm (the directional swap fee, rounded) is the price-ordering coordinate / diagnostic.
 * `tokenAIn` is a diagnostic (the engine resolves direction on-chain).
 */
export interface EcoMaverick {
  /** Pool address — the swap(SwapParams{poolType:7, pool}) target. */
  address: Hex;
  /** true => tokenIn is the pool's tokenA (price rises through ticks); diagnostic (engine resolves on-chain). */
  tokenAIn: boolean;
  /** Rounded ppm directional fee (the price-ordering coordinate; the on-chain out is computed by _swapMaverickV2). */
  feePpm: number;
  source: string;
}

/**
 * One Curve CryptoSwap venue to execute, indexed by an EcoBracket.refIdx (kind === CryptoSwap).
 * Curve CryptoSwap pools (twocrypto-ng / tricrypto-ng volatile-asset pools) trade on the A-gamma
 * invariant with a dynamic fee — NOT xy=k — AND use uint256 coin indices (exchange(uint256 i,
 * uint256 j, dx, min_dy)), so the engine `_swapCurve` (which calls exchange(int128,int128,...))
 * does NOT match them. prepare samples the curve OFF-CHAIN into static segments (kind CryptoSwap)
 * via the bounded-Newton bigint replay; the on-chain solver consumes those through the static-
 * segment cursor and EXECUTES the awarded Σ share CALLBACK-FREE (NO engine SwapPoolType): read the
 * EXACT out from the pool's own `get_dy(i, j, Σ)` view (the view IS the swap math ⇒ wei-exact-in-dy
 * for the awarded share) as min_dy, APPROVE the pool for the awarded input (Curve exchange PULLS via
 * transferFrom), then call `exchange(i, j, Σ, min_dy)`. `address` is the pool; `i`/`j` are the
 * uint256 coin indices; feePpm (the rounded mid_fee) is the price-ordering coordinate / diagnostic.
 */
export interface EcoCryptoSwap {
  /** Pool address — the get_dy/exchange/approve target. */
  address: Hex;
  /** uint256 coin index of tokenIn. */
  i: number;
  /** uint256 coin index of tokenOut. */
  j: number;
  /** Rounded ppm fee (the price-ordering coordinate; the on-chain out is the pool get_dy view). */
  feePpm: number;
  source: string;
}

/**
 * One WOOFi venue to execute, indexed by an EcoBracket.refIdx (kind === WOOFi). WOOFi (WooPPV2) is an
 * ORACLE-PRICED synthetic proactive market maker (sPMM, NOT xy=k): it prices off its on-chain WooracleV2
 * feed (price/spread/coeff), so it must NOT be routed through the V2 (_swapV2) path. prepare samples the
 * curve OFF-CHAIN into static segments (kind WOOFi) via the closed-form sPMM replay at a SNAPSHOT oracle
 * price; the on-chain solver consumes those through the static-segment cursor and EXECUTES the awarded Σ
 * share CALLBACK-FREE: an on-chain `pool.query(fromToken, toToken, Σ)` staticcall (reading the LIVE
 * oracle) yields the EXACT out (used as minToAmount), the awarded input is TRANSFERRED to the pool
 * (WooPPV2 is transfer-first — it computes the sold amount from balanceOf − reserve), and
 * `pool.swap(fromToken, toToken, Σ, minToAmount, to, rebateTo)` lands it. NO engine SwapPoolType — the
 * pool view IS the swap math, so it is wei-exact-in-dy at the live oracle. The split is exact-on-grid at
 * the SNAPSHOT price (the oracle can move between prepare and cook — an exogenous, bps-tiny, guarded
 * residual; see woofi-math.ts). `address` is the pool; `fromToken`/`toToken` are the swap call's token
 * args; feePpm (the WooPPV2 feeRate) is the price-ordering coordinate / diagnostic.
 */
export interface EcoWooFi {
  /** Pool address — the query/swap/transfer target. */
  address: Hex;
  /** The pool's tokenIn (from-token the swap call needs). */
  fromToken: Hex;
  /** The pool's tokenOut (to-token the swap call needs). */
  toToken: Hex;
  /** Rounded ppm fee (the price-ordering coordinate; the on-chain out is the pool query view). */
  feePpm: number;
  source: string;
}

/**
 * Off-chain preparation result.
 *
 * Direct pools carry per-pool net caches (the drift-invariant tick depth the on-chain
 * unified walk reuses); they ship NO prepare-time sqrt edges. Routes are first-class live-walk
 * venues (each leg = a set of leg pools, themselves `EcoPool`s with their own net caches); the
 * solver walks them live, so there are NO static route segments — `brackets` is always `[]`.
 */
export interface EcoSwapPrepared {
  pools: EcoPool[];
  routes: EcoRoute[];
  /**
   * Curve venues (kind === Curve brackets reference these by refIdx). The on-chain solver
   * executes the awarded Σ share via swap(SwapParams{poolType:3, pool:curves[refIdx].address,
   * i, j}); the curve marginal is supplied entirely as the static sampled segments in
   * `brackets`. Optional/empty when no Curve pools were discovered (omitted ⇒ no Curve venue,
   * so the many test-side `EcoSwapPrepared` literals stay additive-compatible).
   */
  curves?: EcoCurve[];
  /**
   * Trader Joe LB venues (kind === LB brackets reference these by refIdx). The on-chain solver
   * executes the awarded Σ share via swap(SwapParams{poolType:6, pool:lbs[refIdx].address}) →
   * live _swapTraderJoeLB; the LB marginal is supplied entirely as the EXACT per-bin static
   * segments in `brackets`. Optional/empty when no LB pairs were discovered (omitted ⇒ no LB
   * venue, so existing test-side `EcoSwapPrepared` literals stay additive-compatible).
   */
  lbs?: EcoLb[];
  /**
   * DODO V2 PMM venues (kind === DODO brackets reference these by refIdx). The on-chain solver
   * executes the awarded Σ share via swap(SwapParams{poolType:5, pool:dodos[refIdx].address}) →
   * live _swapDODOV2; the PMM marginal is supplied entirely as the static sampled segments in
   * `brackets` (the closed-form querySell* replay). Optional/empty when no DODO pools were
   * discovered (omitted ⇒ no DODO venue, so existing test-side `EcoSwapPrepared` literals stay
   * additive-compatible).
   */
  dodos?: EcoDodo[];
  /**
   * Solidly STABLE (sAMM) venues (kind === SolidlyStable brackets reference these by refIdx). The
   * on-chain solver executes the awarded Σ share CALLBACK-FREE (getAmountOut staticcall + transfer +
   * pool.swap — NO engine SwapPoolType); the stable marginal is supplied entirely as the static
   * sampled segments in `brackets` (the x3y+y3x replay). Optional/empty when no Solidly stable pools
   * were discovered (omitted ⇒ no stable venue, so existing test-side `EcoSwapPrepared` literals stay
   * additive-compatible).
   */
  solidlyStables?: EcoSolidlyStable[];
  /**
   * Wombat venues (kind === Wombat brackets reference these by refIdx). The on-chain solver
   * executes the awarded Σ share CALLBACK-FREE (quotePotentialSwap staticcall + approve + pool.swap
   * — NO engine SwapPoolType); the Wombat marginal is supplied entirely as the static sampled
   * segments in `brackets` (the coverage-ratio replay). Optional/empty when no Wombat pools were
   * discovered (omitted ⇒ no Wombat venue, so existing test-side `EcoSwapPrepared` literals stay
   * additive-compatible).
   */
  wombats?: EcoWombat[];
  /**
   * Balancer V2 ComposableStable venues (kind === BalancerStable brackets reference these by refIdx).
   * The on-chain solver executes the awarded Σ share via the EXISTING engine BalancerV2 dispatch
   * swap(SwapParams{poolType:4, pool:balancerStables[refIdx].address}) → _swapBalancerV2; the
   * stable-math marginal is supplied entirely as the static sampled segments in `brackets` (the
   * StableMath A-invariant replay). Optional/empty when no Balancer stable pools were discovered
   * (omitted ⇒ no Balancer venue, so existing test-side `EcoSwapPrepared` literals stay
   * additive-compatible).
   */
  balancerStables?: EcoBalancerStable[];
  /**
   * EulerSwap venues (kind === EulerSwap brackets reference these by refIdx). The on-chain solver
   * executes the awarded Σ share CALLBACK-FREE (computeQuote staticcall + transfer + pool.swap(...,"")
   * — NO engine SwapPoolType); the EulerSwap marginal is supplied entirely as the static sampled segments
   * in `brackets` (the f/fInverse curve replay, bounded by the vault inLimit). Optional/empty when no
   * EulerSwap pools were discovered (omitted ⇒ no EulerSwap venue, so existing test-side `EcoSwapPrepared`
   * literals stay additive-compatible).
   */
  eulerSwaps?: EcoEulerSwap[];
  /**
   * Maverick V2 venues (kind === MaverickV2 brackets reference these by refIdx). The on-chain solver
   * executes the awarded Σ share via the EXISTING engine MaverickV2 dispatch
   * swap(SwapParams{poolType:7, pool:maverickPools[refIdx].address}) → _swapMaverickV2 (Maverick is a
   * CALLBACK pool → the engine services maverickV2SwapCallback); the bin-math marginal is supplied
   * entirely as the static sampled segments in `brackets` (the off-chain bin swap-math replay).
   * Optional/empty when no Maverick pools were discovered (omitted ⇒ no Maverick venue, so existing
   * test-side `EcoSwapPrepared` literals stay additive-compatible).
   */
  maverickPools?: EcoMaverick[];
  /**
   * Curve CryptoSwap venues (kind === CryptoSwap brackets reference these by refIdx). The on-chain
   * solver executes the awarded Σ share CALLBACK-FREE (get_dy staticcall for min_dy + approve +
   * pool.exchange(uint256 i, uint256 j, Σ, min_dy) — NO engine SwapPoolType, since crypto pools use
   * uint256 coin indices that the engine's int128 _swapCurve does not match); the CryptoSwap
   * marginal is supplied entirely as the static sampled segments in `brackets` (the A-gamma
   * invariant replay). Optional/empty when no CryptoSwap pools were discovered (omitted ⇒ no
   * CryptoSwap venue, so existing test-side `EcoSwapPrepared` literals stay additive-compatible).
   */
  cryptoSwaps?: EcoCryptoSwap[];
  /**
   * WOOFi (WooPPV2 sPMM) venues (kind === WOOFi brackets reference these by refIdx). The on-chain
   * solver executes the awarded Σ share CALLBACK-FREE (query staticcall for minToAmount + transfer +
   * pool.swap — NO engine SwapPoolType); the WOOFi marginal is supplied entirely as the static sampled
   * segments in `brackets` (the sPMM oracle-price replay at a snapshot). Optional/empty when no WOOFi
   * pools were discovered (omitted ⇒ no WOOFi venue, so existing test-side `EcoSwapPrepared` literals
   * stay additive-compatible).
   */
  wooFiPools?: EcoWooFi[];
  /** Always `[]` — routes are live-walk venues, not static segments. Kept for shape stability. */
  brackets: EcoBracket[];
  zeroForOne: boolean;
  /** Real-sqrt-space extreme price limit for the swap calls (direction-dependent). */
  priceLimit: bigint;
  /** Sum of route-segment capacities (diagnostic; direct-pool depth is read live). */
  expectedInputCovered: bigint;
}
