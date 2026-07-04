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
// swap-drift-invariant per-pool net cache prepare ships (nets survive price
// moves, NOT an in-window LP mint/burn — see EcoPool.windowTopShifted) — and
// finds the split that equalises the post-fee marginal execution price across
// every pool, doing exactly ONE swap per pool (one per hop for routes).
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
 * `EcoSwapPrepared.brackets` carries the STATIC SAMPLED-VENUE segments (every kind >= Curve,
 * referencing the per-venue lists by refIdx); it is `[]` only when no sampled venue was
 * discovered. Routes contribute NO brackets (they are first-class live-walk venues, not static
 * off-chain-composed segments), so `Route` is UNUSED by EcoSwap. `V3`/`V2` still tag
 * direct-pool brackets in the test fixtures' bracket builders.
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
  EulerSwap = 9, // EulerSwap (Euler vault-backed AMM, v1+v2) segment (static, off-chain-sampled via the f/fInverse curve replay)
  MaverickV2 = 10, // Maverick V2 (bin-based directional AMM) segment (static, off-chain-sampled via the bin swap-math replay; executed through the engine)
  CryptoSwap = 11, // Curve Twocrypto (fxswap/boom v2.1.0d) segment (static, off-chain-sampled via the deployed-family invariant replay — see cryptoswap-math.ts; executed CALLBACK-FREE via approve + exchange(uint256,...))
  WOOFi = 12, // WOOFi (WooPPV2 synthetic proactive market maker) segment (static, off-chain-sampled via the sPMM oracle-price replay at a snapshot; executed CALLBACK-FREE via transfer + swap(fromToken,toToken,amt,minTo,to,rebateTo))
  Fermi = 13, // Fermi / propAMM (gattaca-com/propamm FermiSwap — Obric-style proactive AMM, K=v0²·multX/multY) segment (static, off-chain-sampled via the closed-form replay at a state snapshot; executed CALLBACK-FREE via getAmountOut + approve + swap(tokenIn,tokenOut,amt,minOut,to) — propAMM PULLS via transferFrom)
  Fluid = 14, // VESTIGIAL (kept for enum-number stability): Fluid DEX is now a QUOTE-LADDER family (qlv segKind 12, built on-chain from the LIVE resolver estimateSwapIn quote) — prepare emits NO Fluid brackets; executed CALLBACK-FREE via estimateSwapIn + approve + swapIn(swap0to1,amt,minOut,to) — Fluid PULLS via transferFrom
  Mento = 15, // Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager stablecoin exchange) segment (static, off-chain-sampled via a LIVE Broker getAmountOut ladder at a bucket snapshot; executed CALLBACK-FREE via getAmountOut + approve BROKER + swapIn(exchangeProvider,exchangeId,tokenIn,tokenOut,amt,minOut) — Mento PULLS via transferFrom into the reserve)
  BalancerV3 = 16, // Balancer V3 (balancer-v3-monorepo Vault singleton + per-chain Router) segment (static, off-chain-sampled via a LIVE Router querySwapSingleTokenExactIn ladder — rate-provider + dynamic-surge-fee inclusive — at a snapshot; the query is eth_call-ONLY, NOT re-read on-chain; executed CALLBACK-FREE via ERC20.approve(PERMIT2) + Permit2.approve(ROUTER) + Router.swapSingleTokenExactIn with minAmountOut=0 — the V3 reentrancy is contained inside Balancer's Router+Vault, never the cooking contract; input PULLED via Permit2)
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
  /**
   * OFF-CHAIN-ONLY (never shipped in the on-chain segment tuple; the solver does not read it): for a
   * SAMPLED-SOURCE bracket built from an isotonic-MERGED segment, the WORST original sub-slice
   * marginal the merge folded in (== the segment's `marginalOI` when it was never folded). The
   * minOut estimator prorates a PARTIAL fill of the crossing bracket at THIS rate — a merged
   * segment's blended marginal averages the worse-priced EARLY sub-region with the better-priced
   * deep one, so linear proration at the blended rate over-credits a partial take and could
   * false-revert the solver's internal cfg[9] floor. Threaded from
   * `MergeSegment.worstMarginalOI` (shared/segment-merge.ts) by the sampled-source bracket
   * builders; absent ⇒ the estimator falls back to the (blended-rate) linear proration.
   */
  worstMarginalOI?: bigint;
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
  /**
   * true => Algebra dynamic-fee CL fork (Camelot/QuickSwap V3, Ramses V2, THENA Fusion, SwapX).
   * V3-shaped (isV2 false) and priced/walked/executed IDENTICALLY to Uniswap V3 (shared
   * ticks()/liquidity()/swap() selectors, serviced via algebraSwapCallback) — the ONLY difference
   * is the on-chain SETUP spot read: an Algebra pool has NO slot0(), it exposes globalState()
   * (price/tick). So the solver reads globalState() in place of slot0() for an isAlgebra pool
   * (pd[17]===1). undefined/false ⇒ a plain Uniswap-V3 (or V4) pool read via slot0()/StateView.
   * Set by prepare from the poolByPair Algebra-factory address set (the lens surfaces Algebra as a
   * UniV3 row, indistinguishable downstream, so isAlgebra is stamped off-chain).
   */
  isAlgebra?: boolean;
  /** For V2 live reserve orientation: is tokenIn the pool's token0? */
  inIsToken0: boolean;
  /** V4 only: StateView lens address (0x0 for V2/V3). */
  stateView: Hex;
  /** V4 only: poolId = keccak256(abi.encode(PoolKey)) (0x0 for V2/V3). */
  poolId: Hex;
  // ── Unified-walk per-pool cache (the live walk reuses the swap-drift-invariant NET) ──
  /** floor(sqrt(1.0001^ts)*2^96) = getSqrtRatioAtTick(ts) — the multiplicative step ratio. V3/V4. */
  stepRatio?: bigint;
  /**
   * SHALLOWEST scanned tick (shifted; OFFSET = 888000) — the top of the cache window.
   * 0 ⇒ NO cache (the quote / 1-RPC path) ⇒ the walk staticcalls every boundary. A boundary
   * within [windowBotShifted, windowTopShifted] reads net from the per-pool netCache (or net
   * 0 if uninitialized); a boundary outside reads net via a ticks()/getTickLiquidity
   * staticcall. The net VALUE is invariant under SWAP drift (price moves), so for price
   * movement the cache is a pure gas optimization and the solver stays wei-exact with the
   * oracle regardless of the window. LIMITATION: an in-window boundary is NEVER re-read
   * on-chain, so an LP mint/burn that changes an in-window tick's net between prepare and
   * cook leaves the cached net STALE (only out-of-window boundaries staticcall live). V3/V4.
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
   * FROM this modeled live spot (the cached NET is invariant under SWAP drift, so the walk
   * stays wei-exact with the oracle for any modeled price movement; the windowTopShifted
   * LP mint/burn staleness caveat applies unchanged):
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
 * One QUOTE-LADDER (QL) venue serving a route LEG's edge (hopIn → hopOut) — the leg-member
 * analogue of a direct QL venue. `desc` is the EXISTING per-family descriptor type (the same
 * shape the direct per-family lists carry), DIRECTION-STAMPED for the LEG's (hopIn, hopOut)
 * pair: i/j coin indices, swapForY, sellBase, inIsToken0, fromToken/toToken, inIdx/outIdx …
 * are all per-direction, computed by the discovery functions against the EDGE pair instead of
 * (tokenIn, tokenOut). index.ts appends one 12-column qlv row per leg venue (columns [10]/[11]
 * = routeIdx/legIdx backrefs) AFTER all direct rows, contiguous per (routeIdx asc, legIdx asc).
 * Fluid (segKind 12) is a member like every other QL family: its ladder is built on-chain from
 * the chain-wide resolver's estimateSwapIn quote, and the direction bit is derived ON-CHAIN
 * (getDexTokens vs the leg's edge in-token), so the descriptor needs no extra leg stamping.
 */
export type EcoLegQlVenue =
  | { family: "curve"; desc: EcoCurve }
  | { family: "cryptoSwap"; desc: EcoCryptoSwap }
  | { family: "solidlyStable"; desc: EcoSolidlyStable }
  | { family: "wooFi"; desc: EcoWooFi }
  | { family: "lb"; desc: EcoLb }
  | { family: "mento"; desc: EcoMento }
  | { family: "dodo"; desc: EcoDodo }
  | { family: "wombat"; desc: EcoWombat }
  | { family: "fermi"; desc: EcoFermi }
  | { family: "euler"; desc: EcoEulerSwap }
  | { family: "balancerV2"; desc: EcoBalancerStable }
  | { family: "balancerV3"; desc: EcoBalancerV3 }
  | { family: "maverick"; desc: EcoMaverick }
  | { family: "fluid"; desc: EcoFluid }
  | { family: "tessera"; desc: EcoTessera }
  | { family: "elfomo"; desc: EcoElfomo }
  | { family: "metric"; desc: EcoMetric }
  | { family: "liquidcore"; desc: EcoLiquidCore }
  | { family: "size"; desc: EcoSize };

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
  /**
   * QUOTE-LADDER venues competing as members of THIS leg (direction-stamped for the edge —
   * see EcoLegQlVenue). Optional ⇒ every existing test literal stays valid; absent/empty ⇒ a
   * pool-only leg (index.ts emits qlvBase=qlvCount=0 in the stride-5 routing tuple).
   */
  qlVenues?: EcoLegQlVenue[];
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
  /**
   * Swap direction bit — true when tokenIn == the pair's tokenX (getTokenX()). The QL descriptor carries it
   * (qd[1]) so the on-chain ladder's getSwapOut(xIn, swapForY) reads the pair in the right direction (the
   * engine _swapTraderJoeLB exec resolves it independently on-chain from getTokenX()).
   */
  swapForY: boolean;
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
  /** int index of tokenIn into the pool's NON-BPT token set (the QL solver's non-BPT invariant-order index). */
  i: number;
  /** int index of tokenOut into the pool's NON-BPT token set (the QL solver's non-BPT invariant-order index). */
  j: number;
  /** Rounded ppm swap fee (the price-ordering coordinate; the on-chain out is computed by the QL replay). */
  feePpm: number;
  source: string;

  // ── QUOTE-LADDER (QL) descriptor (segKind 6) ────────────────────────────────────────────────────────────
  // Balancer V2 is now a LIVE-WALK QL venue: the on-chain solver reads the LIVE Vault StableMath state at cook
  // (balances via getPoolTokenInfo scalars, scaling via getScalingFactors, amp/fee live) and replays the
  // amplified StableSwap invariant to build its price ladder, so the split RE-ANCHORS to cook-time state. These
  // fields are what buildQLVenues packs into the 12-column qlv descriptor. (The oracle mirrors the ladder off
  // the same live state via buildBalancerStableQLLadder.)
  /** The pool's Vault poolId (bytes32) — the getPoolTokenInfo(poolId, token) argument for live balances. */
  poolId: Hex;
  /** The NON-BPT token addresses in registered (non-BPT) order (`i`/`j` index into this). */
  nonBptTokens: Hex[];
  /** The FULL registered position of each NON-BPT token (aligned with nonBptTokens) — the getScalingFactors
   *  index the solver inline-reads per non-BPT token for its live scaling factor. */
  nonBptRegPos: number[];
  /** The canonical Balancer V2 Vault singleton (the getPoolTokenInfo target; chain-wide, threaded as cfg[11]). */
  vault: Hex;
}

/**
 * One EulerSwap (Euler vault-backed AMM, v1+v2) venue to execute, indexed by an EcoBracket.refIdx (kind ===
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
 * One Maverick V2 venue to execute — a QUOTE-LADDER (QL) DESCRIPTOR consumed by the on-chain solver's
 * segKind-8 branch. Maverick V2 is a BIN-based directional AMM whose bins do NOT map to the swap-drift-
 * invariant liquidityNet tick walk (bin L is re-derived per tick from (reserveA,reserveB) and the pool
 * has dynamic-distribution kinds), so instead of shipping static sampled segments the solver WALKS the
 * pool's bin book ON-CHAIN from its LIVE active tick/price — reading getState()[5] (activeTick) +
 * getTick(int32)[reserveA,reserveB] + fee(tokenAIn) — emitting one merged-stream slice per crossed tick
 * (== shared/maverick-math.ts buildMaverickWalkLadder ⇒ solver == oracle by construction). So this
 * descriptor carries ONLY the walk seeds (address + tokenAIn direction + tickSpacing); fee, activeTick
 * and every per-tick reserve are read LIVE, so the walk re-anchors to any price drift between prepare and
 * cook. It EXECUTES the awarded Σ share via the EXISTING engine MaverickV2 dispatch
 * swap(SwapParams{poolType:7, pool}) → _swapMaverickV2 (Maverick is a CALLBACK pool — the pool re-enters
 * maverickV2SwapCallback mid-swap to pull input — so it MUST go through the engine Router, NOT the
 * callback-free path). The engine reads the pool's tokenA() and sets tokenAIn on-chain, so the SwapParams
 * carry NO curve/orientation data. feePpm (the directional swap fee, rounded) is the price-ordering
 * coordinate / diagnostic.
 */
export interface EcoMaverick {
  /** Pool address — the swap(SwapParams{poolType:7, pool}) target. */
  address: Hex;
  /** true => tokenIn is the pool's tokenA (price rises through ticks). Seeds the on-chain bin-walk direction (qd[1]). */
  tokenAIn: boolean;
  /** Bin-width exponent (pool.tickSpacing()): 1.0001^tickSpacing is the bin width. Seeds the walk's sqrt-price ladder (qd[2]). */
  tickSpacing: number;
  /** Rounded ppm directional fee (the price-ordering coordinate; the on-chain out is computed by the live bin-walk / _swapMaverickV2). */
  feePpm: number;
  source: string;
}

/**
 * One Curve CryptoSwap venue to execute, indexed by an EcoBracket.refIdx (kind === CryptoSwap).
 * Curve CryptoSwap pools (the fxswap/boom Twocrypto family — see cryptoswap-math.ts) trade on a
 * price_scale-scaled invariant with a dynamic fee — NOT xy=k — AND use uint256 coin indices (exchange(uint256 i,
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
 * One Fermi / propAMM venue to execute, indexed by an EcoBracket.refIdx (kind === Fermi). Fermi
 * (gattaca-com/propamm FermiSwapper) is an OBRIC-style proactive market maker (NOT xy=k), so it must NOT be
 * routed through the V2 (_swapV2) path. The FermiSwapper exposes no curve-state getters, so prepare samples
 * a LIVE `quoteAmounts` ladder OFF-CHAIN into static segments (kind Fermi); the on-chain solver consumes
 * those through the static-segment cursor and EXECUTES the awarded Σ share CALLBACK-FREE: an on-chain
 * `pool.quoteAmounts(fromToken, toToken, +Σ)[1]` staticcall (reading the LIVE state) yields the out, the
 * pool is APPROVED for the awarded input (propAMM PULLS via transferFrom, like Wombat/Curve — NOT
 * transfer-first like WOOFi), and `pool.fermiSwapWithAllowances(fromToken, toToken, +Σ, amountCheck, to)`
 * lands it (amountCheck == the just-quoted out ⇒ it never trips when the state is unchanged). NO engine
 * SwapPoolType. SNAPSHOTTED-QUOTE class: the split is exact-on-grid on the sampled quote ladder (the maker
 * can update state between prepare and cook — an exogenous, amountCheck/amountOutMin-guarded residual; see
 * fermi-math.ts). `address` is the router; `fromToken`/`toToken` are the swap call's token args; feePpm is
 * the price-ordering coordinate / diagnostic (derived from the ladder — there is no feePpm getter).
 */
export interface EcoFermi {
  /** Router address — the quoteAmounts/fermiSwapWithAllowances/approve target. */
  address: Hex;
  /** The pool's tokenIn (from-token the swap call needs). */
  fromToken: Hex;
  /** The pool's tokenOut (to-token the swap call needs). */
  toToken: Hex;
  /** Derived ppm fee (the price-ordering coordinate; the on-chain out is the pool quoteAmounts view). */
  feePpm: number;
  source: string;
}

/**
 * One Fluid DEX QUOTE-LADDER (QL) venue, referenced by a qlv-row refIdx (segKind 12). Fluid DEX (Instadapp
 * fluid-contracts-public FluidDexT1) is a Liquidity-Layer-backed re-centering AMM (NOT xy=k): it prices off
 * the layer's supply/borrow exchange prices + a center price + utilization/borrow caps, so it must NOT be
 * routed through the V2 (_swapV2) path. The DexT1 pool exposes no getAmountOut view (its own estimate is a
 * REVERT — FluidDexSwapResult — which SauceScript can't try/catch), so the on-chain solver builds the
 * venue's price ladder in setup from the LIVE periphery-resolver quote
 * `resolver.estimateSwapIn(dex, swap0to1, xNext, 0)` — a GRACEFUL single-return CALL (the resolver's
 * catch returns 0 for any non-result revert, incl. the utilization/borrow cap ⇒ the ladder self-truncates
 * at the LIVE cap, the EulerSwap-inLimit class). NB a CALL, not a staticcall: the real pool writes state on
 * the ADDRESS_DEAD estimate path before its result-revert (which rolls the writes back), so a staticcall
 * would return 0. It EXECUTES the awarded Σ share CALLBACK-FREE: the same live estimateSwapIn CALL yields
 * the out (used as amountOutMin), the pool is APPROVED for the awarded input (Fluid PULLS via
 * safeTransferFrom inside swapIn — approve-first, like Fermi/Wombat/Curve, NOT transfer-first like WOOFi),
 * and `pool.swapIn(swap0to1, +Σ, amountOutMin, to)` lands it (amountOutMin == the just-quoted out ⇒ it
 * never trips when the state is unchanged). NO engine SwapPoolType (DexT1 re-enters its OWN Liquidity
 * layer via operate(), never the cooking contract). LIVE-WALK class: the ladder is built at cook from live
 * quotes, so the split re-anchors to any layer accrual / cap shrink between prepare and cook (see
 * fluid-math.ts). `address` is the DexT1 pool; `resolver` is the estimate quote target (chain-wide,
 * carried as cfg[6]); `swap0to1` orients the swapIn direction (informational — the solver re-derives it
 * on-chain via getDexTokens, so leg venues need no extra stamping); feePpm is the price-ordering
 * coordinate / diagnostic (derived from the liveness probe — there is no fee getter on the path).
 */
export interface EcoFluid {
  /** DexT1 pool address — the swapIn/approve target AND the resolver `dex_` arg. */
  address: Hex;
  /** DexReservesResolver address — the estimateSwapIn CALL target (NOT a staticcall: the real FluidDexT1
   *  pool writes state on the ADDRESS_DEAD estimate path before reverting, so a STATICCALL returns 0 — see
   *  ecoswap.fluid.prodmirror.evm.test.ts + IFluidDexResolver.json's `nonpayable` mutability). */
  resolver: Hex;
  /** true ⇒ tokenIn is the pool's token0 (swap0to1 = true); false ⇒ tokenIn is token1. */
  swap0to1: boolean;
  /** The pool's tokenIn (from-token the swap call needs). */
  fromToken: Hex;
  /** The pool's tokenOut (to-token the swap call needs). */
  toToken: Hex;
  /** Derived ppm fee (the price-ordering coordinate; the on-chain out is the resolver estimateSwapIn view). */
  feePpm: number;
  source: string;
}

/**
 * One Tessera V QUOTE-LADDER (QL) venue, referenced by a qlv-row refIdx (segKind 15). Tessera V
 * (Wintermute's TesseraSwap wrapper + private engine) is a TREASURY-funded proactive market maker (NOT
 * xy=k): it prices off its engine's posted state + feed, so it must NOT be routed through the V2
 * (_swapV2) path. The wrapper's `tesseraSwapViewAmounts(tokenIn, tokenOut, +xIn)` view is REVERT-class
 * (unsupported pair "T33" / zero amount "T10" / engine pause revert; an OVERSIZED ask returns (in, 0)
 * gracefully), so the on-chain solver builds the venue's price ladder in setup via PROBE-THEN-DECODE
 * (the Fermi class), decoding [1] (the exact-in out). It EXECUTES the awarded Σ share CALLBACK-FREE:
 * the same live view (probe-then-decode) yields the out (used as amountCheck), the wrapper is APPROVED
 * for the awarded input (Tessera PULLS via transferFrom inside tesseraSwapWithAllowances — approve-first,
 * like Fermi/Wombat/Curve, NOT transfer-first like WOOFi), and `tesseraSwapWithAllowances(tokenIn,
 * tokenOut, +Σ, amountCheck, to, "")` lands it (empty swapData; amountCheck == the just-quoted out ⇒ it
 * never trips when the state is unchanged — same-tx quote+swap fork-proven wei-exact at ANY gas price:
 * the engine's ~2-gwei globalPrioFeeThresholddd1337 shifts the QUOTE by fractions of a bp above the
 * threshold but NEVER reverts the swap, and quote+exec read the same tx.gasprice, so the pair is
 * coherent by construction). NO engine SwapPoolType. LIVE-WALK class: the ladder is built at cook from
 * live quotes, so the split re-anchors to any maker re-post between prepare and cook (see
 * tessera-math.ts — including the ~18.5M gas-AVAILABILITY gate the engine enforces: starve it and the
 * probes fail soft, the venue drops). `address` is the wrapper (SAME address Base+BSC — a single
 * multi-pair treasury, so the claim key is this address); `fromToken`/`toToken` are the swap call's
 * token args; feePpm is the price-ordering coordinate / diagnostic (derived from the liveness probe —
 * there is no fee getter).
 */
export interface EcoTessera {
  /** Wrapper (TesseraSwap) address — the viewAmounts/swapWithAllowances/approve target. */
  address: Hex;
  /** The venue's tokenIn (from-token the swap call needs). */
  fromToken: Hex;
  /** The venue's tokenOut (to-token the swap call needs). */
  toToken: Hex;
  /** Derived ppm fee (the price-ordering coordinate; the on-chain out is the wrapper's view). */
  feePpm: number;
  source: string;
}

/**
 * One ElfomoFi QUOTE-LADDER (QL) venue, referenced by a qlv-row refIdx (segKind 16). ElfomoFi is a
 * VAULT-funded PMM priced by an on-chain pricing module + oracle feed (NOT xy=k), so it must NOT be
 * routed through the V2 (_swapV2) path. The wrapper's `getAmountOut(tokenIn, tokenOut, xIn)` view is
 * GRACEFUL single-return (the WOOFi-tryQuery / Fluid-resolver class — 0 on an unsupported pair / zero
 * amount / STALE oracle feed; an oversized ask quotes a real collapsing-marginal value), so the on-chain
 * solver builds the venue's price ladder in setup with ONE plain staticcall per slice (q == 0 ⇒ stop —
 * a stale venue self-drops, never a cook DoS). It EXECUTES the awarded Σ share CALLBACK-FREE: the same
 * live view yields the out (used as limitAmount), the wrapper is APPROVED for the awarded input (Elfomo
 * PULLS via transferFrom inside swap — approve-first, like Fermi/Tessera/Wombat, NOT transfer-first like
 * WOOFi), and `swap(tokenIn, tokenOut, +Σ, limitAmount, to, 0)` lands it (partnerId 0; limitAmount ==
 * the just-quoted out ⇒ it never trips when the state is unchanged — same-tx quote+swap fork-proven
 * wei-exact, gas-price-insensitive). NO engine SwapPoolType. LIVE-WALK class: the ladder is built at
 * cook from live quotes, so the split re-anchors to any oracle move / vault-inventory change between
 * prepare and cook (see elfomo-math.ts). Discovery enumerates `getSupportedPairs()` and filters to the
 * swap pair. `address` is the wrapper (SAME address Base+BSC — a single multi-pair vault, so the claim
 * key is this address); `fromToken`/`toToken` are the swap call's token args; feePpm is the
 * price-ordering coordinate / diagnostic (derived from the liveness probe — there is no fee getter).
 */
export interface EcoElfomo {
  /** Wrapper (ElfomoFi) address — the getAmountOut/swap/approve target. */
  address: Hex;
  /** The venue's tokenIn (from-token the swap call needs). */
  fromToken: Hex;
  /** The venue's tokenOut (to-token the swap call needs). */
  toToken: Hex;
  /** Derived ppm fee (the price-ordering coordinate; the on-chain out is the wrapper's view). */
  feePpm: number;
  source: string;
}

/**
 * One METRIC (metric.xyz oracle-anchored bin-curve OMM) QUOTE-LADDER (QL) venue, referenced by a
 * qlv-row refIdx (segKind 17). A Metric pool is a PER-PAIR inventory contract priced off a
 * maker-posted PriceProvider anchor (NOT xy=k), so it must NOT be routed through the V2 (_swapV2)
 * path. The quote is TWO-STEP (unique among the QL families): the venue prelude hoists
 * `provider.getBidAndAskPrice()` ONCE per venue (PROBE-THEN-DECODE — the provider REVERTS 0x9a0423af
 * when the maker's post is older than MAX_TIME_DELTA (~10 s) or under its Chainlink
 * deviation/sequencer guards; a stale provider zeroes the anchor ⇒ a zero ladder, the venue
 * self-drops), then each slice quotes `router.quoteSwap(pool, xToY, +xNext, limit, bid, ask)` with
 * the FROZEN (bid, ask) threaded through (the quote prices DIRECTLY off the caller-supplied anchor —
 * probed; the swap re-reads the SAME provider in-tx, so quote/exec cohere). The price limit is
 * DIRECTIONAL (0 for xToY — price falls; type(uint128).max for yToX — price rises; the wrong side
 * quotes (0,0) gracefully — the resolved reverse-direction convention). The quote returns SIGNED
 * deltas: the IN delta is the POSITIVE amount actually consumed (an oversized ask PARTIAL-FILLS),
 * the OUT delta is NEGATIVE — decode |outDelta|, q == 0 ⇒ stop (probe-then-decode; the router
 * reverts a typed error on garbage anchors). It EXECUTES the awarded Σ share CALLBACK-FREE from the
 * cooking contract's perspective: derive provider/token0 on-chain via pool.getImmutables() ([1]/[2]
 * — the Fluid derive-don't-trust rule, so a leg venue is edge-correct), probe the anchor + the live
 * quote for minAmountOut, APPROVE the ROUTER for the awarded input, then
 * `router.swapExactInput(pool, self, xToY, +Σ, limit, minAmountOut, deadline)` — the pool pays the
 * out FIRST and re-enters `metricOmmSwapCallback` on the ROUTER (which the router implements
 * ITSELF), pulling the input via transferFrom — the engine services NOTHING. NO engine SwapPoolType.
 * LIVE-WALK class: the ladder is built at cook from live quotes at the live anchor, so the split
 * re-anchors to any maker re-post / bin-state drift (see metric-math.ts — the full probed surface +
 * the int128 clamp + the fork-proven wei-exact quote↔swap agreement). `address` is the POOL (a
 * per-pair inventory ⇒ the claim key is the pool address — the qlVenueClaimKey default, UNLIKE the
 * single-contract multi-pair Tessera/Elfomo wrappers); `provider`/`router` ride qlv qd[6]/qd[7]
 * (free non-BalV2/V3 descriptor columns); `xToY` is qd[1].
 */
export interface EcoMetric {
  /** Pool address — the per-pair inventory contract (quoteSwap/swapExactInput `pool` arg; the claim key). */
  address: Hex;
  /** The pool's PriceProvider — the venue-prelude getBidAndAskPrice() hoist target (qd[6]). */
  provider: Hex;
  /** The pool's Router — the quoteSwap/swapExactInput/approve target (qd[7]; per-pool — Base runs two routers). */
  router: Hex;
  /** Swap direction: true ⇔ tokenIn == the pool's token0 (the quote/swap `xToY` bit; qd[1]). */
  xToY: boolean;
  /** The venue's tokenIn (the edge from-token; diagnostics — the quote keys on pool + xToY). */
  fromToken: Hex;
  /** The venue's tokenOut (the edge to-token; diagnostics). */
  toToken: Hex;
  /** Half the provider's relative bid/ask spread in ppm (price-ordering / diagnostics; the quote is post-fee). */
  feePpm: number;
  source: string;
}

/**
 * One LIQUIDCORE (Liquid Labs liquidcore.xyz, HyperEVM) QUOTE-LADDER (QL) venue, referenced by a
 * qlv-row refIdx (segKind 18). A LiquidCore pool is a PER-PAIR proxy holding its own two-token
 * inventory, priced off the Hyperliquid L1 spot book via the HyperEVM BBO READ PRECOMPILE (NOT
 * xy=k), so it must NOT be routed through the V2 (_swapV2) path. The quote is the SIMPLEST QL class
 * — a single STATICCALL-safe view keyed on (tokenIn, tokenOut): `pool.estimateSwap(tokenIn,
 * tokenOut, xNext)`, PROBE-THEN-DECODE (zero amount / unsupported pair REVERT; a DRAINED pool
 * returns 0 gracefully; an OVERSIZED amount returns a CAPPED quote gracefully — the asymptotic
 * imbalance-fee curve, so the ladder's non-descending-head guard truncates where the marginal
 * collapses). It EXECUTES the awarded Σ share CALLBACK-FREE: probe the live estimateSwap for
 * minAmountOut (a dead/drained venue skips soft — the share strands and the terminal refund returns
 * it), APPROVE the POOL for the awarded input, then `pool.swap(tokenIn, tokenOut, +Σ, minOut)` —
 * the pool pulls EXACTLY the full input via transferFrom (pull == approve ALWAYS, fork-proven even
 * on capped-output oversize — no allowance-residue path) and pays the out to msg.sender. NO engine
 * SwapPoolType. LIVE-WALK class: the ladder is built at cook from live quotes, so the split
 * re-anchors to any Hyperliquid book move / inventory drift (the adaptive imbalance fee makes
 * quote == execution same-block only — exactly the in-tx pairing the solver runs). See
 * liquidcore-math.ts for the full probed surface. `address` is the POOL (per-pair inventory ⇒ the
 * claim key is the pool address — the qlVenueClaimKey default).
 */
export interface EcoLiquidCore {
  /** Pool address — the per-pair inventory proxy (the estimateSwap/swap/approve target; the claim key). */
  address: Hex;
  /** The router that enumerated this pool (getPoolForPair) — diagnostics only. */
  router: Hex;
  /** The venue's tokenIn (the edge from-token; the estimateSwap/swap `tokenIn` arg). */
  fromToken: Hex;
  /** The venue's tokenOut (the edge to-token). */
  toToken: Hex;
  /** Diagnostic spread/fee in ppm derived at discovery (the quote is post-fee; no flat fee getter). */
  feePpm: number;
  source: string;
}

/**
 * One INTEGRAL SIZE (integral.link TwapRelayer) QUOTE-LADDER (QL) venue, referenced by a qlv-row
 * refIdx (segKind 19). The relayer executes swaps INSTANTLY from ITS OWN inventory at the pair's
 * Uniswap-V3-TWAP price (VERIFIED source), inside an OUT-amount WINDOW: quotes revert TR03 below
 * `getTokenLimitMin(tokenOut)` and TR3A above `inventory × maxMultiplier` — the probe-then-decode
 * class with a LOW-end revert too. The solver's venue prelude hoists the LIVE window
 * (getTokenLimitMin → quoteBuy ⇒ minIn) and RAISES THE LADDER SEED to minIn (the buildQLLadder
 * seedFloor — see size-math.ts) so the grid never starts in the reverting region; the ladder then
 * builds LIVE from `quoteSell(tokenIn, tokenOut, xNext)` (STATICCALL, probe-then-decode — a TR3A
 * cap revert truncates the top). It EXECUTES the awarded Σ share CALLBACK-FREE: probe the live
 * quoteSell(share) (a SUB-MIN AWARD — the merge can award a partial first slice — reverts TR03 and
 * SKIPS SOFT, stranding the share for the terminal refund), APPROVE the RELAYER, then
 * `sell({tokenIn, tokenOut, amountIn: Σ, amountOutMin: quote, wrapUnwrap: false, to: self,
 * submitDeadline: 2^32−1})` — the relayer pulls EXACTLY amountIn (pull == approve ALWAYS,
 * fork-proven; no residue path) and pays the quoted out same-tx wei-exact. NO engine SwapPoolType.
 * LIVE-WALK class. `address` is the RELAYER — ONE contract holds EVERY pair's inventory, so the
 * claim key is the relayer address (the Tessera/Elfomo single-wrapper class: one SIZE venue per
 * cook, shared inventory never double-counted). `minOut`/`minIn` are DISCOVERY-time diagnostics
 * (the solver re-hoists the window LIVE at cook).
 */
export interface EcoSize {
  /** The TwapRelayer proxy — the quoteSell/quoteBuy/sell/approve target (the claim key). */
  address: Hex;
  /** The venue's tokenIn (the edge from-token; the quoteSell/sell `tokenIn` arg). */
  fromToken: Hex;
  /** The venue's tokenOut (the edge to-token). */
  toToken: Hex;
  /** Discovery-time getTokenLimitMin(tokenOut) — diagnostics (the solver re-reads live at cook). */
  minOut: bigint;
  /** Discovery-time quoteBuy(tokenIn, tokenOut, minOut) — the lowest quotable input (diagnostics). */
  minIn: bigint;
  /** swapFee[pair] in ppm at discovery (price-ordering diagnostics; the quote is post-fee). */
  feePpm: number;
  source: string;
}

/**
 * One Mento V2 venue to execute, indexed by an EcoBracket.refIdx (kind === Mento). Mento V2 (Celo
 * mento-protocol/mento-core Broker + BiPoolManager) is a BiPool oracle-priced stablecoin exchange (NOT
 * xy=k): the Broker routes to a registered exchange provider (BiPoolManager) that prices off oracle rates +
 * a spread over interval-updated pricing buckets, so it must NOT be routed through the V2 (_swapV2) path.
 * The exchange has a PLAIN `getAmountOut` VIEW on the Broker (no revert-decode resolver needed — simpler
 * than Fluid), so prepare samples a LIVE `broker.getAmountOut(exchangeProvider, exchangeId, tokenIn,
 * tokenOut, +cumIn)` ladder OFF-CHAIN into static segments (kind Mento); the on-chain solver consumes those
 * through the static-segment cursor and EXECUTES the awarded Σ share CALLBACK-FREE: an on-chain
 * `broker.getAmountOut(exchangeProvider, exchangeId, tokenIn, tokenOut, +Σ)` staticcall (the LIVE bucket
 * quote) yields the out, the BROKER is APPROVED for the awarded input (Mento PULLS via transferFrom into
 * the reserve inside swapIn — approve-first, like Fermi/Wombat/Curve/Fluid, NOT transfer-first like WOOFi),
 * and `broker.swapIn(exchangeProvider, exchangeId, tokenIn, tokenOut, +Σ, amountOutMin)` lands it
 * (amountOutMin == the just-quoted out ⇒ it never trips when the bucket state is unchanged). NO engine
 * SwapPoolType (swapIn re-enters only the Reserve / stable-asset mint-burn, never the cooking contract).
 * SNAPSHOTTED-QUOTE class (interval-updated buckets, same family as Fluid/WOOFi): the split is exact-on-grid
 * on the sampled quote ladder; the buckets refresh only on config.referenceRateResetFrequency (gated by
 * oracle reports) — an exogenous, amountOutMin/terminal-refund-guarded residual; also subject to
 * TradingLimits + BreakerBox reverts (see mento-math.ts). `broker` is the getAmountOut/swapIn/approve
 * target; `exchangeProvider`+`exchangeId` identify the BiPool exchange (resolved OFF-CHAIN in discovery via
 * getExchangeProviders → getExchanges); feePpm is the price-ordering coordinate / diagnostic (derived from
 * the ladder — the exchange folds the spread into the quote).
 */
export interface EcoMento {
  /** Broker (BrokerProxy) address — the getAmountOut/swapIn/approve target. */
  broker: Hex;
  /** The resolved exchange provider (e.g. BiPoolManager) for this exchange — a getAmountOut/swapIn arg. */
  exchangeProvider: Hex;
  /** The resolved exchange id (bytes32) for this (tokenIn,tokenOut) pair — a getAmountOut/swapIn arg. */
  exchangeId: Hex;
  /** The venue's tokenIn (from-token the swap call needs). */
  fromToken: Hex;
  /** The venue's tokenOut (to-token the swap call needs). */
  toToken: Hex;
  /** Derived ppm fee/spread (the price-ordering coordinate; the on-chain out is the Broker getAmountOut view). */
  feePpm: number;
  source: string;
}

/**
 * One Balancer V3 (balancer/balancer-v3-monorepo — Vault singleton + per-chain Router) venue to execute,
 * indexed by an EcoBracket.refIdx (kind === BalancerV3). Balancer V3 pools price off the Vault balances +
 * rate providers + a possibly-dynamic StableSurge hook fee (NOT xy=k), so they must NOT be routed through
 * the V2 (_swapV2) path. The deep production pools are surge-hooked + rate-scaled (ERC4626 wrappers), so the
 * curve cannot be replayed from a static fee — prepare SAMPLES a LIVE `Router.querySwapSingleTokenExactIn`
 * ladder OFF-CHAIN via eth_call (which bakes in the rate providers + dynamic hook fee) into static segments
 * (kind BalancerV3). That query is eth_call-ONLY (it demands a static-call context via the Vault's quote()
 * yet does a state write, so it reverts both under a plain CALL and under a STATICCALL — it is NOT callable
 * on-chain in a cook). The on-chain solver consumes the static segments through the static-segment cursor and
 * EXECUTES the awarded Σ share CALLBACK-FREE: the Permit2 two-step approval —
 * `ERC20(tokenIn).approve(PERMIT2, +Σ)` + `Permit2.approve(tokenIn, ROUTER, uint160(+Σ), expiration)` (the V3
 * input is pulled via Permit2, the ONE operational difference from V2) — then
 * `Router.swapSingleTokenExactIn(pool, tokenIn, tokenOut, +Σ, minAmountOut, deadline, false, "")` with
 * minAmountOut HARDCODED 0 (no per-leg on-chain floor — the query is uncallable; the whole-trade cfg[9]
 * amountOutMin floor is the only on-chain bound, and it is a LOOSE gross-shortfall guard, so per-leg drift
 * relies on the off-chain split + the integrator's transaction-level slippage). NO engine SwapPoolType: the V3 reentrancy is fully contained inside Balancer's
 * own Router + Vault (Vault.unlock re-enters the ROUTER, never the cooking contract; input PULLED via
 * Permit2.transferFrom, output via Vault.sendTo), so our side sees a single external call that returns —
 * callback-free, unlike the V4 unlockCallback path. `address` is the POOL (the query/swap `pool` arg);
 * `router` is the per-chain Router (the swap/Permit2-approve target — threaded chain-wide via the solver cfg,
 * since one Router serves every V3 pool on a chain); `fromToken`/`toToken` are the swap's token args; feePpm
 * is the price-ordering coordinate / diagnostic (derived from the ladder — a surge-hooked pool has no single
 * fee getter). See balancer-v3-math.ts for the SNAPSHOTTED-QUOTE class (rate providers accrue + surge fee
 * moves; the exec runs exactIn with minAmountOut=0, reproducing the live query for the awarded share).
 */
export interface EcoBalancerV3 {
  /** Vault pool address — the query/swap `pool` arg. */
  address: Hex;
  /** The per-chain V3 Router — the query/swap/Permit2-approve target (chain-wide via cfg). */
  router: Hex;
  /** The venue's tokenIn (from-token the swap call needs). */
  fromToken: Hex;
  /** The venue's tokenOut (to-token the swap call needs). */
  toToken: Hex;
  /** Derived ppm fee (the price-ordering coordinate; the on-chain out is the Router querySwap view). */
  feePpm: number;
  source: string;

  // ── QUOTE-LADDER (QL) descriptor fields ──────────────────────────────────────────────────────────────
  // Balancer V3 is a LIVE-WALK QL venue: the on-chain solver reads the LIVE Vault state (balances / amp /
  // static fee / each token's rate) at cook and replays the amplified StableSwap invariant to build its price
  // ladder — so prepare ships ONLY this descriptor (no sampled segments). amp + the static fee are read LIVE
  // (getAmplificationParameter()[0] / getStaticSwapFeePercentage), so they need NO descriptor slot. `vault` is
  // threaded chain-wide via the solver cfg. buildQLVenues emits [pool, inIdx, outIdx, feePpm, 14, refIdx, rpIn,
  // rpOut, decScaleIn, decScaleOut].
  /** CREATE2 Vault singleton (getCurrentLiveBalances / getStaticSwapFeePercentage target; chain-wide cfg[10]). */
  vault: Hex;
  /** tokenIn's Vault token index (the getCurrentLiveBalances slot). */
  inIdx: number;
  /** tokenOut's Vault token index. */
  outIdx: number;
  /** tokenIn rate provider address (the solver's on-chain getRate() target — a scalar, v12-safe). */
  rpIn: Hex;
  /** tokenOut rate provider address. */
  rpOut: Hex;
  /** CONST tokenIn decimal scaling factor = 10^(18 − tokenIn.decimals). */
  decScaleIn: bigint;
  /** CONST tokenOut decimal scaling factor = 10^(18 − tokenOut.decimals). */
  decScaleOut: bigint;
}

/**
 * Off-chain preparation result.
 *
 * Direct pools carry per-pool net caches (the swap-drift-invariant tick depth the on-chain
 * unified walk reuses; see EcoPool.windowTopShifted for the in-window LP mint/burn staleness
 * caveat); they ship NO prepare-time sqrt edges. Routes are first-class live-walk
 * venues (each leg = a set of leg pools, themselves `EcoPool`s with their own net caches); the
 * solver walks them live, so routes ship NO static segments. `brackets` carries ONLY the
 * sampled-venue segments (Curve/LB/DODO/… — every kind >= Curve); it is `[]` when none were
 * discovered.
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
   * Maverick V2 venues — QUOTE-LADDER (QL) DESCRIPTORS (built by index.ts buildQLVenues as segKind-8
   * rows, referenced by the qlv row's refIdx). The on-chain solver WALKS each pool's bin book LIVE from
   * getState()/getTick() (the reference-math live bin-walk) to build its price ladder — Maverick ships NO
   * static sampled brackets — and executes the awarded Σ share via the EXISTING engine MaverickV2
   * dispatch swap(SwapParams{poolType:7, pool:maverickPools[refIdx].address}) → _swapMaverickV2 (Maverick
   * is a CALLBACK pool → the engine services maverickV2SwapCallback). Optional/empty when no Maverick
   * pools were discovered (omitted ⇒ no Maverick venue, so existing test-side `EcoSwapPrepared` literals
   * stay additive-compatible).
   */
  maverickPools?: EcoMaverick[];
  /**
   * Curve CryptoSwap venues (kind === CryptoSwap brackets reference these by refIdx). The on-chain
   * solver executes the awarded Σ share CALLBACK-FREE (get_dy staticcall for min_dy + approve +
   * pool.exchange(uint256 i, uint256 j, Σ, min_dy) — NO engine SwapPoolType, since crypto pools use
   * uint256 coin indices that the engine's int128 _swapCurve does not match); the CryptoSwap
   * marginal is supplied entirely as the static sampled segments in `brackets` (the deployed-family
   * invariant replay in cryptoswap-math.ts). Optional/empty when no CryptoSwap pools were discovered (omitted ⇒ no
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
  /**
   * Fermi / propAMM venues (kind === Fermi brackets reference these by refIdx). The on-chain solver
   * executes the awarded Σ share CALLBACK-FREE (getAmountOut staticcall for minOut + approve + pool.swap
   * — NO engine SwapPoolType); the Fermi marginal is supplied entirely as the static sampled segments in
   * `brackets` (the Obric-style closed-form replay at a snapshot). Optional/empty when no Fermi pools were
   * discovered (omitted ⇒ no Fermi venue, so existing test-side `EcoSwapPrepared` literals stay
   * additive-compatible).
   */
  fermiPools?: EcoFermi[];
  /**
   * Fluid DEX (FluidDexT1 Liquidity-Layer-backed re-centering AMM) QUOTE-LADDER venues (qlv segKind 12
   * rows reference these by refIdx). DESCRIPTOR-ONLY — the on-chain solver builds each venue's price
   * ladder in setup from the LIVE chain-wide resolver's estimateSwapIn quote (a graceful CALL; cfg[6]
   * carries the resolver) and executes the awarded Σ share CALLBACK-FREE (the same live estimateSwapIn
   * CALL for minOut + approve + pool.swapIn — NO engine SwapPoolType). Optional/empty when no Fluid pools
   * were discovered (omitted ⇒ no Fluid venue, so existing test-side `EcoSwapPrepared` literals stay
   * additive-compatible).
   */
  fluidPools?: EcoFluid[];
  /**
   * Tessera V (Wintermute TesseraSwap wrapper + private engine) QUOTE-LADDER venues (qlv segKind 15
   * rows reference these by refIdx). DESCRIPTOR-ONLY — the on-chain solver builds each venue's price
   * ladder in setup from the LIVE tesseraSwapViewAmounts quote (PROBE-THEN-DECODE — the view is
   * revert-class) and executes the awarded Σ share CALLBACK-FREE (the same live view for amountCheck +
   * approve + tesseraSwapWithAllowances(..., "") — NO engine SwapPoolType). Optional/empty when no
   * Tessera venue was discovered (omitted ⇒ no Tessera venue, so existing test-side `EcoSwapPrepared`
   * literals stay additive-compatible).
   */
  tesseraPools?: EcoTessera[];
  /**
   * ElfomoFi (vault-funded PMM + on-chain pricing module) QUOTE-LADDER venues (qlv segKind 16 rows
   * reference these by refIdx). DESCRIPTOR-ONLY — the on-chain solver builds each venue's price ladder
   * in setup from the LIVE getAmountOut quote (a GRACEFUL plain single-return staticcall, 0 ⇒ stop) and
   * executes the awarded Σ share CALLBACK-FREE (the same live view for limitAmount + approve +
   * swap(..., partnerId 0) — NO engine SwapPoolType). Optional/empty when no Elfomo venue was
   * discovered (omitted ⇒ no Elfomo venue, so existing test-side `EcoSwapPrepared` literals stay
   * additive-compatible).
   */
  elfomoPools?: EcoElfomo[];
  /**
   * METRIC (metric.xyz oracle-anchored bin-curve OMM) QUOTE-LADDER venues (qlv segKind 17 rows
   * reference these by refIdx). DESCRIPTOR-ONLY — the on-chain solver hoists the venue's provider
   * anchor (getBidAndAskPrice, probe-then-decode — a stale provider self-drops the venue) ONCE in
   * setup, builds the price ladder LIVE from router.quoteSwap at the frozen anchor (probe-then-decode,
   * |negative out-delta|), and executes the awarded Σ share CALLBACK-FREE from the cooking contract's
   * perspective (derive via getImmutables + live quote as minAmountOut + approve ROUTER +
   * swapExactInput — the router itself services the pool's metricOmmSwapCallback; NO engine
   * SwapPoolType). Optional/empty when no Metric venue was discovered (omitted ⇒ no Metric venue, so
   * existing test-side `EcoSwapPrepared` literals stay additive-compatible).
   */
  metricPools?: EcoMetric[];
  /**
   * LIQUIDCORE (Liquid Labs, HyperEVM) QUOTE-LADDER venues (qlv segKind 18 rows reference these by
   * refIdx). DESCRIPTOR-ONLY — the on-chain solver builds the ladder LIVE from pool.estimateSwap
   * (probe-then-decode) and executes CALLBACK-FREE (live estimateSwap as minAmountOut + approve POOL
   * + pool.swap; pull == approve always — NO engine SwapPoolType). Optional/empty when no LiquidCore
   * venue was discovered (omitted ⇒ additive-compatible).
   */
  liquidCorePools?: EcoLiquidCore[];
  /**
   * INTEGRAL SIZE (TwapRelayer) QUOTE-LADDER venues (qlv segKind 19 rows reference these by refIdx).
   * DESCRIPTOR-ONLY — the on-chain solver hoists the LIVE out-window per venue (getTokenLimitMin +
   * quoteBuy ⇒ the ladder's seed floor), builds the ladder LIVE from quoteSell (probe-then-decode —
   * TR03/TR3A window reverts self-truncate), and executes CALLBACK-FREE (live quoteSell as
   * amountOutMin + approve RELAYER + sell(SellParams); a sub-min award soft-skips into the terminal
   * refund; NO engine SwapPoolType). Optional/empty when no SIZE venue was discovered (omitted ⇒
   * additive-compatible).
   */
  sizePools?: EcoSize[];
  /**
   * Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager) venues (kind === Mento brackets
   * reference these by refIdx). The on-chain solver executes the awarded Σ share CALLBACK-FREE
   * (broker.getAmountOut staticcall for minOut + approve BROKER + broker.swapIn — NO engine SwapPoolType);
   * the Mento marginal is supplied entirely as the static sampled segments in `brackets` (the LIVE Broker
   * getAmountOut ladder at a bucket snapshot). Optional/empty when no Mento venues were discovered (omitted
   * ⇒ no Mento venue, so existing test-side `EcoSwapPrepared` literals stay additive-compatible).
   */
  mentoPools?: EcoMento[];
  /**
   * Balancer V3 (balancer-v3-monorepo Vault singleton + per-chain Router) venues (kind === BalancerV3
   * brackets reference these by refIdx). The on-chain solver executes the awarded Σ share CALLBACK-FREE
   * (ERC20.approve(PERMIT2) + Permit2.approve(ROUTER) + Router.swapSingleTokenExactIn with minAmountOut=0 —
   * the querySwapSingleTokenExactIn quote is eth_call-ONLY, NOT re-read on-chain; NO engine SwapPoolType, the
   * V3 reentrancy is contained inside Balancer's Router+Vault); the V3 marginal is supplied entirely as the
   * static sampled segments in `brackets` (the LIVE querySwapSingleTokenExactIn ladder at a snapshot). Optional/empty when
   * no Balancer V3 pools were discovered (omitted ⇒ no Balancer V3 venue, so existing test-side
   * `EcoSwapPrepared` literals stay additive-compatible).
   */
  balancerV3Pools?: EcoBalancerV3[];
  /**
   * The static SAMPLED-VENUE segments (every kind >= Curve; refIdx points into the venue lists
   * above). Direct pools and routes contribute NONE (live-walk) — `[]` only when no sampled
   * venue was discovered.
   */
  brackets: EcoBracket[];
  zeroForOne: boolean;
  /** Real-sqrt-space extreme price limit for the swap calls (direction-dependent). */
  priceLimit: bigint;
  /** Sum of route-segment capacities (diagnostic; direct-pool depth is read live). */
  expectedInputCovered: bigint;
  /**
   * Whole-trade slippage tolerance (bps) applied to derive `minOut` (the internal
   * amountOutMin floor). Default 50 (0.5%); 0 disables the floor. Diagnostic — the
   * solver receives only the resulting `minOut` (cfg[9]).
   */
  slippageBps?: number;
  /**
   * The internal whole-trade amountOutMin FLOOR the on-chain solver self-enforces
   * (cfg[9]): `expectedTotalOut * (10000 - slippageBps) / 10000`, where expectedTotalOut
   * is a CONSERVATIVE (lower-bound) off-chain estimate of the split's output. Defense-in-
   * depth — a legitimate wei-exact fill always clears it. 0 ⇒ no floor (the pre-floor,
   * byte-identical solver behavior). Optional so existing test-side `EcoSwapPrepared`
   * literals stay additive-compatible (absent ⇒ index.ts emits minOut 0). NOTE: this is
   * NOT a tight `slippageBps` band around the realized fill — the estimate is a loose lower
   * bound (much looser in the common no-net-window live-walk path), so the floor guards a
   * GROSS shortfall; callers wanting a tight whole-trade minimum should enforce their own.
   */
  minOut?: bigint;
}
