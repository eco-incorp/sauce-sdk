/**
 * Chain addresses, swap constants, and per-chain pool discovery configs.
 *
 * Covers all major liquidity sources across supported chains:
 * V3-style (Uniswap V3, PancakeSwap V3, SushiSwap V3, Aerodrome CL, Velodrome CL, Ramses V3/CL)
 * Algebra-style (Camelot V3, QuickSwap V3, Ramses V2)
 * V2-style (Uniswap V2, SushiSwap V2, PancakeSwap V2, BaseSwap, Camelot V2, Zyberswap)
 * Solidly V2-style (Aerodrome V2, Velodrome V2, Ramses V2 Legacy, Chronos V1)
 * Curve, Balancer V2, DODO V2, Trader Joe LB, Maverick V2, WOOFi
 */

import type { Hex } from "viem";

// ── Tokens (Base chain) ──────────────────────────────────────

export const WETH = "0x4200000000000000000000000000000000000006" as Hex;
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex;
export const DAI = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" as Hex;
export const USDbC = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" as Hex;

/** Base tokens used for multi-hop routing (Base chain default) */
export const BASE_TOKENS = [WETH, USDC, DAI, USDbC] as const;

// ── Pool types ───────────────────────────────────────────────
// Must match Solidity: enum SwapPoolType in IRouter.sol

export enum SwapPoolType {
  UniV2 = 0,       // Constant product AMM (xy=k) — Uniswap V2, SushiSwap, Solidly forks
  UniV3 = 1,       // Concentrated liquidity — Uniswap V3, PancakeSwap V3, Algebra
  UniV4 = 2,       // V4 with hooks
  Curve = 3,       // Curve stable/crypto pools — exchange(i, j, dx, min_dy)
  BalancerV2 = 4,  // Balancer V2 — via Vault singleton
  DODOV2 = 5,      // DODO V2 PMM — sellBase/sellQuote
  TraderJoeLB = 6, // Trader Joe Liquidity Book — bin-based AMM
  MaverickV2 = 7,  // Maverick V2 — directional AMM
  WOOFi = 8,       // WOOFi sPMM — synthetic proactive market making
}

// ── Factory discovery types ─────────────────────────────────
// Determines HOW to query pools from each factory

export enum FactoryType {
  /** Uniswap V3 style: getPool(tokenA, tokenB, fee) across fee tiers, slot0() for state */
  V3Standard = "v3",
  /** Uniswap V4 singleton: poolId = keccak256(PoolKey), StateView.getSlot0(poolId) for state */
  UniswapV4 = "v4",
  /**
   * Algebra dynamic-fee style (Camelot V3, QuickSwap V3, Ramses V2): ONE pool per pair
   * (no fee tiers) discovered via `poolByPair(tokenA, tokenB)`. State is read from
   * `globalState()` (NOT slot0()): `price` (= sqrtPriceX96), `tick`, and the DYNAMIC fee
   * (`feeZto` for a zeroForOne swap, `feeOtz` for oneForZero). Algebra pools are V3-shaped
   * concentrated liquidity, so for DISCOVERY + PRICING they map to `poolType = UniV3`: the
   * tick walk (`ticks()[1]` = liquidityDelta = liquidityNet), the v3Segments oracle and the
   * on-chain per-pool frontier all read identically to Uniswap V3. The only Algebra-specific
   * work on that side is the state read (globalState in place of slot0) and threading the
   * per-pool dynamic fee through to `feePpm`; the fee is read once at quote time and treated
   * as fixed over the trade (the SAME snapshot assumption the recipe makes for fixed V3 tiers),
   * so a PRICE/split computed against an Algebra pool is wei-exact vs the V3 oracle at that fee.
   * The on-chain LENS reads this family directly (see ecoswap.lens.sauce.ts `algebraFactories`).
   *
   * EXECUTION IS SUPPORTED. An Algebra pool's `swap()` has the Uniswap-V3 selector (same 5
   * params: recipient, zeroToOne, amountRequired, limitSqrtPrice, data), so the Router's
   * `v3Pool.swap(...)` call in `_swapV3` dispatches; mid-swap the pool re-enters the caller via
   * `algebraSwapCallback(int256,int256,bytes)`, and the engine NOW implements that selector — a
   * mirror of `uniswapV3SwapCallback`/`pancakeV3SwapCallback` that routes to `_handleV3Callback`
   * (sauce#186; the SDK engine pin was bumped to `feat/engine-algebra-swap-callback`). So an
   * Algebra pool routes as UniV3 / `swapV3` and the mid-swap input pull is serviced exactly like
   * a Uniswap-V3 swap. The discovery/lens layers INCLUDE Algebra pools in the executable set (see
   * `discoverAlgebraPools` and `runLens`'s `includeAlgebra`, default on).
   * See LIQUIDITY_SOURCES_FEASIBILITY.md §3.
   *
   * NOTE: `Algebra` is a backward-compatible alias of this value (`= AlgebraV3`); both refer
   * to the same dynamic-fee globalState reader.
   */
  AlgebraV3 = "algebra",
  /** Uniswap V2 style: getPair(tokenA, tokenB), getReserves() for state */
  V2Standard = "v2",
  /** Solidly V2 style: getPool(tokenA, tokenB, stable) — queries both volatile and stable pools */
  SolidlyV2 = "solidly-v2",
  /** Curve registry: find_pool_for_coins(from, to) */
  CurveRegistry = "curve-registry",
  /**
   * Curve CryptoSwap registry (crypto/tricrypto Metaregistry): find_pool_for_coins(from, to) →
   * get_coin_indices (UINT256 i,j). CryptoSwap pools (twocrypto-ng / tricrypto-ng volatile-asset)
   * trade on the A-gamma invariant with a DYNAMIC fee (NOT the StableSwap A-invariant, NOT xy=k) AND
   * use uint256 coin indices, so the engine `_swapCurve` (exchange(int128,int128,...)) does NOT match
   * them. State: A()=ANN, gamma(), price_scale(), D(), balances(uint256), mid_fee/out_fee/fee_gamma.
   * The curve is priced OFF-CHAIN (bounded-Newton A-gamma replay) into sampled segments; CALLBACK-FREE:
   * executed in SauceScript (get_dy staticcall for min_dy + approve + exchange(uint256 i, uint256 j, Σ,
   * min_dy); Curve exchange PULLS via transferFrom), so no engine change. LOW priority (volatile-asset).
   */
  CurveCryptoRegistry = "curve-crypto-registry",
  /** Balancer V2: pool address → getPoolId() → Vault.swap() */
  BalancerV2 = "balancer-v2",
  /**
   * Balancer V3 (balancer/balancer-v3-monorepo — the successor to V2; deep stable/surge depth on
   * Ethereum/Base/Arbitrum and Beets on Sonic). Discovery is KNOWN-POOL-ADDRESS based (like V2 / EulerSwap /
   * Fluid): the FactoryConfig `address` is the CREATE2 Vault singleton
   * (0xbA1333333333a1BA1108E8412f11850A5C319bA9, SAME on all chains) and the candidate pool addresses are
   * carried per-config in `balancerV3Pools`, with the per-chain single-swap Router in `balancerV3Router`.
   * `discoverBalancerV3PoolsTyped` reads `Vault.getPoolTokens(pool)` to keep pools trading BOTH tokenIn and
   * tokenOut (V3 has NO BPT in the swappable token list, unlike V2 ComposableStable) and SAMPLES a LIVE
   * ladder via the Router's `querySwapSingleTokenExactIn(pool, tokenIn, tokenOut, +amountIn, sender, "")`
   * (which bakes in the rate providers AND any dynamic StableSurge hook fee — the robust surface for both
   * plain and surge pools). The curve is priced OFF-CHAIN into sampled segments from that ladder.
   * CALLBACK-FREE: executed in SauceScript (a live query staticcall for minAmountOut + ERC20.approve(PERMIT2)
   * + Permit2.approve(ROUTER) + Router.swapSingleTokenExactIn). The V3 reentrancy is fully contained inside
   * Balancer's own Router + Vault (Vault.unlock re-enters the ROUTER, never the cooking contract — the input
   * is PULLED via Permit2.transferFrom, the output arrives via Vault.sendTo), so it is callback-free and
   * needs NO engine change (contrast V4's unlockCallback, which the engine MUST service). SNAPSHOTTED-QUOTE
   * class (rate providers accrue + surge fee moves as the pool re-balances — treat the query as a snapshot;
   * the exec re-reads the live query as minAmountOut). Verified: Vault 0xbA13…bA9 on all chains; Routers
   * Base 0x3f17…DC10, Ethereum 0xAE56…8Ea2, Arbitrum 0xEAed…CF2E, Sonic 0x93db…Dae5; Permit2
   * 0x0000…78BA3 (canonical, all chains). See balancer-v3-math.ts + LIQUIDITY_SOURCES_FEASIBILITY.md.
   */
  BalancerV3 = "balancer-v3",
  /** DODO V2 (DVMFactory): getDODOPool(base, quote) → address[] → sellBase/sellQuote */
  DODOZoo = "dodo-zoo",
  /** Trader Joe LB: getLBPairInformation(tokenX, tokenY, binStep) */
  TraderJoeLB = "trader-joe-lb",
  /** Maverick V2: lookup(tokenA, tokenB, idx) */
  MaverickV2Factory = "maverick-v2",
  /** WOOFi: single pool per chain, query() for verification */
  WOOFi = "woofi",
  /**
   * Fermi / propAMM (gattaca-com/propamm FermiSwapper — an OBRIC-style proactive AMM). Discovery is
   * ROUTER-ADDRESS based: the FactoryConfig `address` is a FermiSwapper router (verified surface at
   * 0xb1076fe3ab5e28005c7c323bac5ac06a680d452e). propAMM prices off its OWN on-chain state, NOT xy=k. The
   * router exposes NO raw curve-state getters and NO getAmountOut view — only a SIGNED-amount quote
   * `quoteAmounts(tokenIn, tokenOut, int256 amountSpecified) -> (amountIn, amountOut)` (positive = exact-in),
   * a signed-amount swap `fermiSwapWithAllowances(tokenIn, tokenOut, int256, amountCheck, recipient)`, and
   * `isActive`/`getPairs`. Discovery checks `isActive` and SAMPLES a LIVE `quoteAmounts` ladder; the curve is
   * priced OFF-CHAIN into sampled segments from that ladder. CALLBACK-FREE: executed in SauceScript (a live
   * quoteAmounts staticcall for amountCheck + approve + fermiSwapWithAllowances; propAMM PULLS via
   * transferFrom, like Wombat/Curve — NOT transfer-first like WOOFi), so no engine change. SNAPSHOTTED-QUOTE
   * class (the split is priced off the sampled quote snapshot; the exec re-reads the live quote as
   * amountCheck). See LIQUIDITY_SOURCES_FEASIBILITY.md.
   */
  Fermi = "fermi",
  /**
   * KyberSwap Classic / DMM: amplified constant-product on VIRTUAL reserves.
   * Discovery: getPools(tokenA, tokenB) → per-pool getTradeInfo()
   * (reserve0, reserve1, vReserve0, vReserve1, feeInPrecision). The curve geometry
   * (sqrt/L) is keyed off the VIRTUAL reserves — a Kyber pool is mathematically a V2
   * range with L = isqrt(vReserveIn·vReserveOut) — and the per-pool fee is read live
   * (feeInPrecision is 1e18-scaled; rounded to ppm). Callback-free: executed in
   * SauceScript (transfer + pool.swap(a0, a1, to, "")) with the output computed on the
   * virtual reserves, so no engine change. Distinct from V2Standard only in the live
   * read (getTradeInfo vs getReserves) and the per-virtual-reserve output formula.
   */
  KyberClassic = "kyber-classic",
  /**
   * Wombat Exchange (single-sided stableswap). Discovery: the FactoryConfig `address` is a Wombat
   * Pool (multi-asset singleton); both tokens must be assets of the pool (addressOfAsset(token) !=
   * 0). State: per-asset cash()/liability() (WAD) + pool-wide ampFactor()/haircutRate() (WAD). The
   * curve is the coverage-ratio closed-form quote (CoreV2._swapQuoteFunc); priced OFF-CHAIN into
   * sampled segments. Callback-free: executed in SauceScript (approve + pool.swap(fromToken,
   * toToken, amount, minToAmount, to, deadline); Wombat PULLS via transferFrom), so no engine
   * change. Distinct from a stable pool only in the per-asset state read + the quote formula.
   */
  Wombat = "wombat",
  /**
   * EulerSwap (Euler vault-backed AMM). Discovery is KNOWN-POOL-ADDRESS based (the EulerSwap factory
   * has no pool enumeration — only a `deployedPools` mapping + PoolDeployed events), so the candidate
   * pool addresses are carried per-config in `FactoryConfig.eulerSwapPools` (like Balancer's
   * balancerStablePools). BOTH VERSIONS coexist: `discoverEulerSwapPoolsTyped` reads each pool's curve()
   * bytes32 to pick the curve-param getter — v1 ("EulerSwap v1") uses getParams() (a static immutable
   * 12-field struct with a SINGLE non-directional fee; the surface every currently-deployed pool exposes),
   * v2 ("EulerSwap v2") uses getDynamicParams() (directional fee0/fee1). State: live reserve0/reserve1 +
   * the static curve params (equilibriumReserve0/1, priceX/priceY, concentrationX/concentrationY, fee) +
   * the vault input cap from getLimits. The curve is the asymmetric concentrated-liquidity f/fInverse
   * (whitepaper), IDENTICAL across v1/v2; priced OFF-CHAIN into sampled segments (BOUNDED by the vault
   * inLimit). Callback-free: executed in SauceScript (computeQuote + transfer + pool.swap(amount0Out,
   * amount1Out, to, ""); EulerSwap's swap is V2-shaped, empty data ⇒ no flash callback — the only re-entry
   * is internal to Euler, never the cooking contract), so no engine change. The exec surface
   * (computeQuote/getAssets/swap) is version-agnostic.
   */
  EulerSwap = "eulerswap",
  /**
   * Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — a Liquidity-Layer-backed re-centering AMM;
   * high-volume ETH/Arbitrum stable venue). Discovery is KNOWN-POOL-ADDRESS based (the DexT1 pools are
   * deployed by a factory with no simple pair→pool getter on the swap surface), so the candidate DexT1
   * pool addresses are carried per-config in `FactoryConfig.fluidPools` (like EulerSwap's eulerSwapPools /
   * Balancer's balancerStablePools) and the periphery DexReservesResolver address in
   * `FactoryConfig.fluidResolver`. The DexT1 pool prices off the Liquidity-Layer supply/borrow exchange
   * prices + a center price + utilization/borrow caps — ALL canonical on-chain state, NOT xy=k — and
   * exposes NO getAmountOut view (its own estimate is a REVERT, FluidDexSwapResult, which SauceScript
   * can't try/catch). So discovery SAMPLES a LIVE ladder via the RESOLVER's
   * `estimateSwapIn(dex, swap0to1, +amountIn, 0)` (which does the pool's revert-decode in Solidity and
   * returns a plain uint256); the curve is priced OFF-CHAIN into sampled segments from that ladder.
   * CALLBACK-FREE: executed in SauceScript (a live resolver estimateSwapIn staticcall for amountOutMin +
   * approve + pool.swapIn(swap0to1, amt, amountOutMin, to); Fluid PULLS via safeTransferFrom inside swapIn,
   * approve-first, like Fermi/Wombat/Curve — NOT transfer-first like WOOFi), so no engine change (DexT1
   * re-enters its OWN Liquidity layer via operate(), never the cooking contract). SNAPSHOTTED-QUOTE class:
   * the split is exact-on-grid vs the oracle on the shared sampled ladder; the exec re-reads the live
   * estimate as amountOutMin. Verified surface: FluidDexT1 0x6d83f60eEac0e50A1250760151E81Db2a278e03a;
   * fluid-contracts-public poolT1/coreModule/core/main.sol + periphery/resolvers/dex/main.sol.
   */
  Fluid = "fluid",
  /**
   * Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager stablecoin exchange). Discovery is
   * ENUMERABLE via the Broker: the FactoryConfig `address` is the Broker (BrokerProxy). Mento is a BiPool
   * oracle-priced exchange — the Broker routes to a registered exchange provider (BiPoolManager) that prices
   * off oracle rates + a spread over interval-updated pricing buckets, NOT xy=k. Discovery is a two-step
   * enumeration: `Broker.getExchangeProviders()` → for each provider `provider.getExchanges()` → an
   * Exchange { bytes32 exchangeId; address[] assets; } matches (tokenIn,tokenOut) when {tokenIn,tokenOut}
   * == {assets[0],assets[1]} (unordered), yielding (exchangeProvider, exchangeId). The Broker has a PLAIN
   * `getAmountOut(exchangeProvider, exchangeId, tokenIn, tokenOut, amountIn)` VIEW (no revert-decode
   * resolver), so discovery SAMPLES that view over [0, amountIn] and the curve is priced OFF-CHAIN into
   * sampled segments from that ladder. CALLBACK-FREE: executed in SauceScript (a live Broker getAmountOut
   * staticcall for amountOutMin + approve the BROKER + broker.swapIn(exchangeProvider, exchangeId, tokenIn,
   * tokenOut, amt, amountOutMin); Mento PULLS via transferFrom into the reserve inside swapIn, approve-first
   * like Fermi/Wombat/Curve/Fluid — NOT transfer-first like WOOFi), so no engine change (swapIn re-enters
   * only the Reserve / stable-asset mint-burn, never the cooking contract). SNAPSHOTTED-QUOTE class (buckets
   * refresh only on config.referenceRateResetFrequency, gated by oracle reports — treat getAmountOut as a
   * snapshot; also subject to TradingLimits + BreakerBox reverts). The provider set is governance-mutable —
   * discovery goes through getExchangeProviders(), not a hardcoded BiPoolManager. Verified: Broker
   * 0x777A8255cA72412f0d706dc03C9D1987306B4CaD, BiPoolManager 0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901
   * (both source-verified EIP-1967 proxies on Celoscan). See mento-math.ts.
   */
  Mento = "mento",
  /**
   * Slipstream-family concentrated liquidity (Velodrome/Aerodrome Slipstream CLFactory, and the
   * Ramses-lineage forks Shadow Exchange CL). These are UniswapV3-compatible for PRICING and
   * EXECUTION — the pool exposes the standard V3 view surface (slot0, ticks, liquidity,
   * tickSpacing) and its swap() re-enters the caller via the exact `uniswapV3SwapCallback` selector
   * the engine Router already implements (the engine authenticates V3 callbacks via the transient
   * `expectedPool`, NOT a factory/CREATE2 check, so a Slipstream pool is accepted with NO engine
   * change and executes through the existing flat `swapV3` path unchanged). The ONLY thing that
   * differs from Uniswap V3 is DISCOVERY: the CLFactory keys pools by TICK SPACING, not fee —
   * `getPool(address tokenA, address tokenB, int24 tickSpacing)` — so a fee-tier-enumerating
   * V3Standard discovery finds nothing (which is why these CL entries were previously INERT under
   * V3Standard). This type enumerates a per-factory-overridable set of enabled tickSpacings
   * (`FactoryConfig.slipstreamTickSpacings`, defaulting to the Slipstream-common
   * [1, 50, 100, 200, 2000]) via `getPool(a, b, int24 tickSpacing)`, and — because Slipstream
   * DECOUPLES fee from tickSpacing — reads each surviving pool's OWN `fee()` getter to populate the
   * same `fee` field the V3 path uses (NOT a tickSpacing→fee assumption). The resulting `PoolInfo`
   * is byte-identical in shape to a V3Standard-discovered pool, so the downstream bracket / lens /
   * swapV3 path consumes it unchanged. See discoverSlipstreamCLPools in pool-discovery.ts.
   */
  SlipstreamCL = "slipstream-cl",
}

/**
 * Slipstream-family CLFactory common enabled tickSpacings. Velodrome/Aerodrome Slipstream and the
 * Ramses-lineage Shadow CL forks enable this canonical set; a factory that enables a different set
 * overrides it per-config via `FactoryConfig.slipstreamTickSpacings`. Over-querying a spacing the
 * factory does not enable is harmless — `getPool(a,b,int24)` returns address(0) for it.
 */
export const SLIPSTREAM_TICK_SPACINGS = [1, 50, 100, 200, 2000] as const;

/**
 * Backward-compatible alias for the Algebra dynamic-fee factory type. `FactoryType.Algebra`
 * and `FactoryType.AlgebraV3` are the SAME value (the globalState/poolByPair reader) — use
 * either. Exposed so callers can write the shorter `FactoryType.Algebra`.
 */
export const ALGEBRA_FACTORY_TYPE = FactoryType.AlgebraV3;

// ── Per-chain pool discovery config ──────────────────────────

export interface FactoryConfig {
  /** Factory address — or, for Uniswap V4, the PoolManager singleton address. */
  address: Hex;
  /** How the SauceRouter dispatches the swap (V2/V3/V4) */
  poolType: SwapPoolType;
  /** How to query pools from this factory */
  factoryType: FactoryType;
  /** Human-readable label for logging */
  label: string;
  /** Uniswap V4 only: the StateView lens used to read pool state by poolId. */
  stateView?: Hex;
  /**
   * Per-factory fee tiers (ppm). Overrides the chain's global `feeTiers` for THIS
   * factory only — needed because forks don't share tiers: PancakeSwap V3 uses
   * 2500 (0.25%) where Uniswap V3 uses 3000 (0.30%). When omitted, discovery falls
   * back to the chain-level `feeTiers`.
   */
  feeTiers?: number[];
  /**
   * V2-class only: the pool's constant-product swap fee in ppm (e.g. 3000 = 0.30%,
   * 500 = 0.05%). UniswapV2-clones at the canonical 0.30% omit this (defaults to
   * V2_DEFAULT_FEE_PPM = 3000). Set it for a fork whose V2-class pools charge a
   * different fee (Solidly volatile, some Sushi tiers) so the lens, the off-chain
   * oracle and the on-chain execution all use the SAME per-pool fee (wei-exact).
   *
   * The engine `_swapV2` hardcodes 0.30% (997/1000), so a pool with v2FeePpm != 3000
   * is executed via the callback-free SauceScript path (transfer + pool.swap) instead
   * of the unified router swap — no engine change. 3000-fee pools keep the router path.
   */
  v2FeePpm?: number;
  /**
   * Algebra (AlgebraV3) only: the factory's fixed per-pool `tickSpacing`. Algebra v1 forks
   * (Camelot/QuickSwap V3, Ramses V2) carry the same spacing across all their pools (commonly
   * 60). The on-chain LENS has no TickMath, so it steps √price by a PRECOMPUTED step ratio
   * (getSqrtRatioAtTick(tickSpacing)) derived off-chain from this value — the same way V4 specs
   * precompute their step ratio. Defaults to 60 when omitted. Ignored for non-Algebra factories.
   */
  algebraTickSpacing?: number;
  /**
   * Algebra (AlgebraV3) only: how this fork lays out the DYNAMIC fee in `globalState()`. Algebra forks
   * DIFFER in word 3, so the lens must decode the fee per-fork or a non-fee word (a timepointIndex up to
   * 65535 = 6.55%, or a pluginConfig) would poison the survivor filter + merge pricing:
   *   - `"camelot"` (DEFAULT): Camelot V3 / Ramses V2 (Algebra 1.9) — DIRECTIONAL fees. globalState() =
   *     (price, tick, feeZto, feeOtz, timepointIndex, …); the fee is word 2 for zeroForOne, word 3 for
   *     oneForZero. This is the pre-existing behavior (unchanged for existing Camelot/Ramses configs).
   *   - `"algebra-v1"`: Algebra V1 base (QuickSwap V3, THENA Fusion) — a SINGLE fee. globalState() =
   *     (price, tick, fee, timepointIndex, communityFee0, communityFee1, unlocked); the fee is ALWAYS
   *     word 2 (word 3 is the timepointIndex — NOT a fee).
   *   - `"integral"`: Algebra Integral / V2 (SwapX) — a SINGLE fee. globalState() = (price, tick, lastFee,
   *     pluginConfig, communityFee, unlocked); the fee is ALWAYS word 2 (word 3 is pluginConfig — NOT a fee).
   * `"algebra-v1"` and `"integral"` are equivalent to the lens (both single-fee at word 2); the distinct
   * names document the source layout. Ignored for non-Algebra factories.
   */
  algebraFeeLayout?: "camelot" | "algebra-v1" | "integral";
  /**
   * Slipstream CL (SlipstreamCL factory type) only: the tickSpacings this CLFactory enables. The
   * Slipstream CLFactory keys pools by tickSpacing — `getPool(tokenA, tokenB, int24 tickSpacing)` —
   * so discovery enumerates this list (defaulting to the Slipstream-common `SLIPSTREAM_TICK_SPACINGS`
   * = [1, 50, 100, 200, 2000] when omitted). Over-querying a spacing the factory does not enable is
   * harmless (getPool returns address(0)); set it to trim the enumerated set for a fork with a
   * narrower spacing menu. Ignored for non-Slipstream factories.
   */
  slipstreamTickSpacings?: number[];
  /**
   * Balancer V2 (BalancerV2 factory type) only: a KNOWN list of ComposableStable pool addresses to
   * probe for the pair. Balancer has NO pair→pool getter (the `address` here is the Vault, shared on
   * all chains), so discovery is known-pool-address based — `discoverBalancerStablePoolsTyped` reads
   * each pool's getPoolId / Vault.getPoolTokens / getAmplificationParameter / getScalingFactors /
   * getSwapFeePercentage / bptIndex and keeps the pools containing BOTH tokenIn and tokenOut (non-BPT).
   * PRODUCTION needs this populated from a known-poolId list / the Balancer subgraph (the standard
   * Balancer integration); the EVM test injects the locally-deployed fixture pool address here. Omitted
   * / empty ⇒ no Balancer pools surfaced (the prior behavior — the discovery gap is filled by config,
   * no engine change).
   */
  balancerStablePools?: Hex[];
  /**
   * Balancer V3 (BalancerV3 factory type) only: a KNOWN list of Balancer V3 pool addresses to probe for the
   * pair. Balancer V3 has NO pair→pool getter (the `address` on a BalancerV3 entry is the CREATE2 Vault
   * singleton 0xbA13…bA9, shared on all chains), so discovery is known-pool-address based —
   * `discoverBalancerV3PoolsTyped` reads `Vault.getPoolTokens(pool)`, keeps the pools trading BOTH tokenIn
   * and tokenOut (V3 has NO BPT in the swappable set, unlike V2), and SAMPLES a LIVE ladder via the Router's
   * `querySwapSingleTokenExactIn` (which bakes in rate providers + any dynamic surge-hook fee). PRODUCTION
   * populates this from the Balancer V3 pool index / subgraph; the EVM test injects the locally-deployed
   * fixture pool address directly. Omitted/empty ⇒ no Balancer V3 pools surfaced (the discovery gap is
   * filled by config, no engine change). Requires `balancerV3Router` to be set.
   */
  balancerV3Pools?: Hex[];
  /**
   * Balancer V3 (BalancerV3 factory type) only: the per-chain single-swap Router (RouterCommon-based, with
   * swapSingleTokenExactIn / querySwapSingleTokenExactIn). UNLIKE the Vault (a CREATE2 singleton, the same
   * on every chain), the Router address DIFFERS per chain — Base 0x3f17…DC10, Ethereum 0xAE56…8Ea2, Arbitrum
   * 0xEAed…CF2E, Sonic 0x93db…Dae5 — so it MUST be per-chain config. Both the off-chain discovery sampling
   * quote and the on-chain per-slice exec quote/swap go through this Router; one Router serves every V3 pool
   * on the chain (threaded chain-wide via the solver cfg). Required when `balancerV3Pools` is non-empty.
   */
  balancerV3Router?: Hex;
  /**
   * EulerSwap (EulerSwap factory type) only: a KNOWN list of EulerSwap pool addresses to probe for the
   * pair. The EulerSwap factory has NO pair→pool getter and no enumeration (only `deployedPools` +
   * PoolDeployed events), so discovery is known-pool-address based — `discoverEulerSwapPoolsTyped` reads
   * each pool's getAssets / getReserves / getDynamicParams (the static curve params + directional fee0/fee1)
   * / getLimits and keeps the pools trading BOTH tokenIn and tokenOut. PRODUCTION needs this populated from
   * the PoolDeployed-event index
   * (the standard EulerSwap integration); the EVM test injects the locally-deployed fixture pool address
   * directly (the test builds the prepared args without discovery). Omitted/empty ⇒ no EulerSwap pools
   * surfaced (the discovery gap is filled by config, no engine change).
   */
  eulerSwapPools?: Hex[];
  /**
   * Fluid DEX (Fluid factory type) only: a KNOWN list of FluidDexT1 pool addresses to probe for the pair.
   * The DexT1 pools have no simple pair→pool getter on the swap surface, so discovery is known-pool-address
   * based — `discoverFluidPoolsTyped` reads the resolver's getDexTokens(dex) to orient the pair (swap0to1;
   * the pool has NO token0()/token1() getters — they live only inside constantsView()'s struct) and
   * SAMPLES the resolver `estimateSwapIn` ladder, keeping the pools trading BOTH tokenIn and tokenOut with a
   * strictly-positive quote. PRODUCTION populates this from the Fluid pool index / subgraph; the EVM test
   * injects the locally-deployed fixture pool address directly. Omitted/empty ⇒ no Fluid pools surfaced (the
   * discovery gap is filled by config, no engine change).
   */
  fluidPools?: Hex[];
  /**
   * Fluid DEX (Fluid factory type) only: the periphery DexReservesResolver address. The DexT1 pool's own
   * estimate is a REVERT (FluidDexSwapResult) that SauceScript can't try/catch, so BOTH discovery sampling
   * and the on-chain per-slice exec quote go through the RESOLVER's
   * `estimateSwapIn(dex, swap0to1, amountIn, 0)` (it does the try/catch in Solidity and returns a plain
   * uint256). Required when `fluidPools` is non-empty. Verified: fluid-contracts-public
   * periphery/resolvers/dex/main.sol.
   */
  fluidResolver?: Hex;
  /**
   * Mento V2 (Mento factory type) only: an OPTIONAL hint of the exchange-provider addresses (BiPoolManager
   * etc.) to enumerate. Discovery is ENUMERABLE and self-describing — `discoverMentoPoolsTyped` calls
   * `Broker.getExchangeProviders()` (the FactoryConfig `address` is the Broker) to obtain the providers,
   * then `provider.getExchanges()` on each — so this field is NOT required (the provider set is
   * governance-mutable and discovered live). When present it RESTRICTS enumeration to these providers
   * (skipping getExchangeProviders); the canonical BiPoolManager is verified here for documentation /
   * a deterministic local-fixture path. Verified: BiPoolManager 0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901.
   */
  mentoExchangeProviders?: Hex[];
}

/** Canonical UniswapV2 constant-product fee (ppm): 0.30%. */
export const V2_DEFAULT_FEE_PPM = 3000;

/**
 * Canonical Uniswap Permit2 singleton — SAME address on every EVM chain (cast-verified via
 * Balancer V3 Router.getPermit2() on Base/ETH/Arbitrum/Sonic). The Balancer V3 exec path pulls its
 * input through Permit2: the cooking contract ERC20.approve(PERMIT2, share) then
 * Permit2.approve(tokenIn, ROUTER, uint160(share), expiration) before Router.swapSingleTokenExactIn.
 */
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Hex;

/**
 * The CREATE2 Balancer V3 Vault singleton — the SAME address on every chain (cast-verified: code present
 * on Base/Ethereum/Arbitrum/Sonic). On a `FactoryType.BalancerV3` entry the FactoryConfig `address` is this
 * Vault (used only for `isPoolRegistered` / `getPoolTokens`); the per-chain Router (which drives the swap)
 * is `FactoryConfig.balancerV3Router`.
 */
export const BALANCER_V3_VAULT = "0xbA1333333333a1BA1108E8412f11850A5C319bA9" as Hex;

/**
 * KyberSwap Classic / DMM fee precision: feeInPrecision (from getTradeInfo) is scaled by
 * 1e18 (PRECISION). The recipe rounds it to ppm — feePpm = round(feeInPrecision·1e6/1e18) —
 * and uses the SAME rounded ppm in the off-chain oracle/reference AND the on-chain merge, so
 * the split stays wei-exact-by-construction. (The realized swap output is computed on-chain
 * from the live feeInPrecision at full 1e18 precision; the ppm rounding only affects the
 * price-ordering coordinate, which both sides share.)
 */
export const KYBER_FEE_PRECISION = 10n ** 18n;
/** Round a Kyber feeInPrecision (1e18-scaled) to a ppm fee. */
export function kyberFeeToPpm(feeInPrecision: bigint): number {
  return Number((feeInPrecision * 1_000_000n + KYBER_FEE_PRECISION / 2n) / KYBER_FEE_PRECISION);
}

export interface ChainPoolConfig {
  factories: FactoryConfig[];
  baseTokens: Hex[];
  feeTiers: number[];
}

/** Whether a pool type supports sqrtPriceLimitX96 */
export function hasPriceLimit(poolType: SwapPoolType): boolean {
  return poolType === SwapPoolType.UniV3 || poolType === SwapPoolType.UniV4;
}

/**
 * PancakeSwap V3 fee tiers (ppm). Pancake's medium tier is 2500 (0.25%), NOT the
 * 3000 (0.30%) Uniswap uses — so a single global `feeTiers` list misses Pancake's
 * canonical pool. Attached per-factory via `FactoryConfig.feeTiers`.
 */
export const PANCAKE_V3_FEE_TIERS = [100, 500, 2500, 10000] as const;

/**
 * Fee (ppm) → tickSpacing for the discovered fee-keyed V3 forks: the Uniswap standard tiers
 * (100/500/3000/10000 → 1/10/60/200), Pancake's 2500 → 50, and Ramses CL's non-standard low
 * tiers 50 → 1 and 250 → 5 (on-chain verified on Arbitrum: getPool(USDC,USDT,50) → a pool with
 * tickSpacing() == 1). Unknown tiers fall back to 60 — beware: on a fork whose real spacing is
 * finer, the 60-stride walk overstates per-step capacity ~(60/ts)× and poisons the lens's
 * relative-depth floor, so REAL tiers must be listed here. THE SINGLE SOURCE for the recipe:
 * lens.ts is the sole recipe consumer (prepare.ts keeps no copy — tickSpacing flows to it
 * from the lens rows); keep any duplicate map elsewhere in sync.
 */
export const TICK_SPACING_BY_FEE: Record<number, number> = { 50: 1, 100: 1, 250: 5, 500: 10, 2500: 50, 3000: 60, 10000: 200 };
/** TICK_SPACING_BY_FEE lookup with the standard-V3 default of 60 for unknown tiers. */
export function feeToTickSpacing(fee: number): number {
  return TICK_SPACING_BY_FEE[fee] ?? 60;
}

// ── Uniswap V4 (Base) ────────────────────────────────────────
// Declared above the chain configs so BASE_CHAIN_POOL_CONFIG can reference them.

export const UNISWAP_V4_POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b" as Hex;
export const UNISWAP_V4_STATE_VIEW = "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71" as Hex;

// ── Chain configs ────────────────────────────────────────────

/** Base chain pool config (default for single-chain recipes) */
export const BASE_CHAIN_POOL_CONFIG: ChainPoolConfig = {
  factories: [
    // V3 concentrated liquidity (has price limit)
    { address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3" },
    { address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "PancakeSwap V3", feeTiers: [...PANCAKE_V3_FEE_TIERS] },
    // Aerodrome CL (Velodrome Slipstream on Base) — tickSpacing-keyed getPool(a,b,int24). Verified
    // on-chain: getPool(WETH,USDC,int24) returns non-zero pools across tickSpacings {1,50,100,200,2000},
    // and fee() is DECOUPLED from tickSpacing (ts=100 pool → fee 50 ppm; ts=1 pool → fee 80 ppm), so the
    // per-pool fee is READ from fee(). V3-compatible for execution (swapV3 / uniswapV3SwapCallback).
    { address: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Aerodrome CL" },
    { address: "0x71524B4f93c58fcbF659783284E38825f0622859" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
    // KyberSwap Elastic REMOVED: Elastic is NOT V3-compatible (getPoolState()/its own swap, no slot0) — a queried-tier collision reverts the whole lens eth_call; needs its own FactoryType before re-adding.
    // Algebra dynamic-fee (V3-shaped; poolByPair + globalState). EXECUTABLE — the engine now
    // implements algebraSwapCallback (sauce#186), so an Algebra pool routes as UniV3 / swapV3 and
    // the mid-swap input pull is serviced (see FactoryType.AlgebraV3). PLACEHOLDER address — Base
    // had no canonical Algebra deployment at authoring; the TYPE + globalState reader are wired so
    // a real Base Algebra fork drops in by address alone (it will then be discovered, priced AND
    // executed). The arbitrum (Camelot V3, Ramses V2) and polygon (QuickSwap V3) configs below
    // carry REAL Algebra factories on this same type.
    { address: "0x0000000000000000000000000000000000000000" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "Algebra (placeholder)" },
    // V4 singleton (PoolManager + StateView lens)
    { address: UNISWAP_V4_POOL_MANAGER, stateView: UNISWAP_V4_STATE_VIEW, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4" },
    // V2 constant-product (no price limit)
    { address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Uniswap V2" },
    { address: "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "PancakeSwap V2" },
    { address: "0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "BaseSwap V2" },
    // Solidly V2 (volatile + stable pools)
    { address: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Aerodrome V2" },
    // Maverick V2
    { address: "0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e" as Hex, poolType: SwapPoolType.MaverickV2, factoryType: FactoryType.MaverickV2Factory, label: "Maverick V2" },
    // Curve (MetaRegistry — the resolved AddressProvider.get_address(7) address, hardcoded here; find_pool_for_coins).
    { address: "0x87DD13Dd25a1DBde0E1EdcF5B8Fa6cfff7eABCaD" as Hex, poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
    // WOOFi (WooPPV2 sPMM — deterministic single-address deployment).
    { address: "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4" as Hex, poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "WOOFi" },
    // Balancer V3 (Vault singleton 0xbA13…bA9 + per-chain Router; callback-free typed path via Permit2).
    // This is the Base V3 depth the config-audit flagged as MISSING under the V2-only Balancer wiring (the
    // Base V2 stable pools are dust). Known-pool-address discovery: `balancerV3Pools` = V3 pool addresses
    // (probed via Vault.getPoolTokens), `balancerV3Router` = the Base single-swap Router. On-chain verified
    // at block 48120153: isPoolRegistered=true, getPoolTokens = [waGHO 0x88b1…, waUSDC 0xC768…], staticFee
    // 5e13, StableSurge-hooked (0xb200…f007), and querySwapSingleTokenExactIn(pool, waUSDC, waGHO, 100e6) →
    // 107.79 waGHO (surge-fee-inclusive; reverse 100e18 waGHO → 92.65 waUSDC). The querySwap surface bakes in
    // the rate providers + dynamic surge fee, so the sampled ladder is robust for this SURGE pool (a static
    // StableMath replay could NOT price it). The swappable tokens are the ERC4626 WRAPPERS (waGHO/waUSDC),
    // NOT raw GHO/USDC — reachable only when the wrappers are among the discovery baseTokens/route hops.
    // poolType UniV2 is INERT for Balancer V3 (discovery keys off factoryType; V3 executes callback-free via
    // its own EcoBalancerV3 path, never a UniV2 router swap) — a placeholder, not a UniV2 claim.
    { address: "0xbA1333333333a1BA1108E8412f11850A5C319bA9" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.BalancerV3, label: "Balancer V3",
      balancerV3Router: "0x3f170631ed9821Ca51A59D996aB095162438DC10" as Hex,
      balancerV3Pools: [
        "0x7ab124ec4029316c2a42f713828ddf2a192b36db" as Hex, // Aave USDC-Aave GHO (waUSDC/waGHO, StableSurge)
      ] },
    // Balancer V2 / Fluid / EulerSwap / Fermi on Base: LEFT EMPTY + FLAGGED (verified, none is a deep
    // both-baseToken stable venue):
    //  · Balancer V2 — the deepest V2 stable pools holding baseTokens are dust: USDC/USDbC/axlUSDC
    //    0x0C65…86Db (~$1.4k) and DAI-USDbC 0x6FbF…83e9 (~$1.5k); not worth wiring.
    //  · Fluid DEX — the FluidDexT1 pools on Base pair USDC against non-baseToken stables (EURC, yoUSD,
    //    wstUSR, sUSDe, sUSDai, GHO, USDe); NONE pairs two Base baseTokens (USDC/DAI/USDbC), so nothing
    //    is routable via the stablecoin baseTokens.
    //  · EulerSwap — the Base factory 0xf0CFe22d…1262 pools trade WETH/USDC, cbBTC/USDC, EURC/USDC, etc.
    //    (no both-baseToken stable pair) AND expose a non-v2 surface (getDynamicParams reverts).
    //  · Fermi — no FermiSwapper deployment on Base (router 0xb1076fe3… is Ethereum-only).
  ],
  baseTokens: [
    WETH, USDC, DAI, USDbC,
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Hex, // cbBTC
  ],
  feeTiers: [100, 500, 3000, 10000],
};

/** Per-chain pool configs for cross-chain recipes */
export const CHAIN_POOL_CONFIGS: Record<string, ChainPoolConfig> = {
  base: BASE_CHAIN_POOL_CONFIG,

  ethereum: {
    factories: [
      // V3 concentrated liquidity (has price limit)
      { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3" },
      { address: "0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
      { address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "PancakeSwap V3", feeTiers: [...PANCAKE_V3_FEE_TIERS] },
      // KyberSwap Elastic REMOVED: Elastic is NOT V3-compatible (getPoolState()/its own swap, no slot0) — a queried-tier collision reverts the whole lens eth_call; needs its own FactoryType before re-adding.
      // V4 singleton (PoolManager + StateView lens). Official Uniswap V4 mainnet deployment.
      { address: "0x000000000004444c5dc75cB358380D2e3dE08A90" as Hex, stateView: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227" as Hex, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
      // V2 constant-product (no price limit)
      { address: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Uniswap V2" },
      { address: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "SushiSwap V2" },
      { address: "0x1097053Fd2ea711dad45caCcc45EfF7548fCB362" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "PancakeSwap V2" },
      // Curve
      { address: "0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5" as Hex, poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
      // Balancer V2 (Vault address — pool discovery via known ComposableStable pool addresses).
      // On-chain verified via Vault.getPoolTokens(getPoolId(pool)) — the two deepest V2 stable pools
      // holding baseTokens (the plain-stablecoin V2 pools have largely migrated to V3/boosted, so these
      // are the surviving raw-USDC/USDT/DAI venues):
      //   0x8353…Cb2aF  GHO/USDT/USDC ComposableStable  (USDC ≈32,521 · USDT ≈40,357 · GHO ≈47,353; ~$120k)
      //   0x06Df…1b42  USD Stable Pool DAI/USDC/USDT     (DAI ≈8,550 · USDC ≈8,526 · USDT ≈18,576; ~$35k)
      { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Hex, poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Balancer V2",
        balancerStablePools: [
          "0x8353157092ED8Be69a9DF8F95af097bbF33Cb2aF" as Hex, // GHO/USDT/USDC ComposableStable
          "0x06Df3b2bbB68adc8B0e302443692037ED9f91b42" as Hex, // Balancer USD Stable Pool (DAI/USDC/USDT)
        ] },
      // Balancer V3 (Vault singleton 0xbA13…bA9 + per-chain Router; callback-free typed path via Permit2).
      // Known-pool-address discovery: `balancerV3Pools` = V3 pool addresses (probed via Vault.getPoolTokens),
      // `balancerV3Router` = the Ethereum single-swap Router (querySwapSingleTokenExactIn quotes — INCLUDES
      // the rate providers + any StableSurge dynamic fee, the robust surface for the boosted/wrapped legs).
      // On-chain verified at block 25447676: isPoolRegistered=true, getPoolTokens = [waUSDT 0x7Bc3…, waGHO
      // 0xC71E…, waUSDC 0xD4fa…] (all WITH_RATE ERC4626 wrappers), and querySwapSingleTokenExactIn(pool,
      // waUSDC, waUSDT, 100e6) → 100.85 waUSDT. NOTE the pool's swappable tokens are the ERC4626 WRAPPERS
      // (waUSDC/waUSDT/waGHO), NOT the raw stablecoins — reachable only when the wrappers are among the
      // discovery baseTokens/route hops; the raw-USDC/USDT legs go through the wrapper's ERC4626
      // deposit/redeem, out of the direct-swap scope. poolType UniV2 is INERT for Balancer V3 (discovery keys
      // off factoryType; V3 executes callback-free via its own EcoBalancerV3 path, never a UniV2 router swap)
      // — a placeholder, not a UniV2 claim.
      { address: "0xbA1333333333a1BA1108E8412f11850A5C319bA9" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.BalancerV3, label: "Balancer V3",
        balancerV3Router: "0xAE563E3f8219521950555F5962419C8919758Ea2" as Hex,
        balancerV3Pools: [
          "0x85b2b559bc2d21104c4defdd6efca8a20343361d" as Hex, // Aave GHO/USDT/USDC (waGHO/waUSDT/waUSDC)
        ] },
      // Fluid DEX (Instadapp FluidDexT1 — Liquidity-Layer re-centering AMM; callback-free typed path).
      // Known-pool-address discovery: `fluidPools` = FluidDexT1 pool addresses, `fluidResolver` = the
      // periphery DexResolver (getDexTokens orients the pair; estimateSwapIn quotes — the pool has no
      // getAmountOut view). On-chain verified: DexFactory.getDexAddress(id) → getDexTokens (correct
      // resolver 0x11D80… returns token0/token1; the DexReservesResolver 0x05Bd… reverts getDexTokens, so
      // the DexResolver is the one wired) → both pools are USDC/USDT (both baseTokens). estimateSwapIn
      // depth: dexId2 0x6677…9F9B deep (1M USDC → 1.0006M USDT), dexId34 0xea73…15C0 thin (quotes small
      // sizes — 10k USDC → 10,003 USDT; truncates to 0 past ~few-tens-of-thousands-$).
      // poolType UniV2 is INERT for Fluid: discovery keys off factoryType (Fluid), and Fluid venues flow
      // into their own EcoFluid bucket executed via the callback-free typed path — never dispatched as a
      // UniV2 router swap. It is a placeholder, not a claim that Fluid is a UniV2 pool.
      { address: "0x91716C4EDA1Fb55e84Bf8b4c7085f84285c19085" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.Fluid, label: "Fluid DEX",
        fluidResolver: "0x11D80CfF056Cef4F9E6d23da8672fE9873e5cC07" as Hex,
        fluidPools: [
          "0x667701e51B4D1Ca244F17C78F7aB8744B4C99F9B" as Hex, // USDC/USDT (deep)
          "0xea734B615888c669667038D11950f44b177F15C0" as Hex, // USDC/USDT (thin)
        ] },
      // EulerSwap (Euler vault-backed AMM; callback-free typed path). Discovery is known-pool-address
      // based (the EulerSwap factory 0xb013be1D0D380C13B58e889f412895970A2Cf228 has NO pair→pool getter,
      // only `deployedPools` + PoolDeployed events), so `eulerSwapPools` carries the candidate pool
      // addresses. `discoverEulerSwapPoolsTyped` now handles BOTH versions side by side (like Uni V2/V3/V4):
      // each pool's curve() bytes32 discriminates v1 ("EulerSwap v1", getParams() — a static immutable
      // 12-field struct with a SINGLE non-directional fee) from v2 ("EulerSwap v2", getDynamicParams() —
      // directional fee0/fee1). The deployed mainnet pools are all v1. Wired: the deepest LIVE (EVC-operator-
      // authorized) stable-stable v1 pool — USDC/USDT 0x3bBCC029…F28A8 (getReserves ≈179 USDC / ≈1165 USDT
      // virtual; getLimits maxOut ≈1165 USDT, vault cash-backed; computeQuote 100 USDC→100.03 USDT verified
      // live at block 25445491). poolType UniV2 is INERT for EulerSwap (discovery keys off factoryType; the
      // asymmetric Euler curve is NOT xy=k, so it flows into the EcoEuler bucket executed callback-free —
      // never dispatched as a UniV2 router swap; it is a placeholder, not a claim it is a V2 pool). Several
      // other listed v1 pools (USDe/USDT 0x794138…, USDC/USDT 0x701f…) are operator-UNAUTHORIZED / dead
      // (getLimits 0/0, computeQuote reverts OperatorNotInstalled) — intentionally NOT wired.
      { address: "0xb013be1D0D380C13B58e889f412895970A2Cf228" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.EulerSwap, label: "EulerSwap",
        eulerSwapPools: [
          "0x3bBCC029f312ECe579a7dEb77B13CB8aE15F28A8" as Hex, // USDC/USDT v1 (deepest live stable pool)
        ] },
      // DODO V2
      { address: "0x72d220cE168C4f361dD4deE5D826a01AD8598f6C" as Hex, poolType: SwapPoolType.DODOV2, factoryType: FactoryType.DODOZoo, label: "DODO V2" },
      // Maverick V2
      { address: "0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e" as Hex, poolType: SwapPoolType.MaverickV2, factoryType: FactoryType.MaverickV2Factory, label: "Maverick V2" },
      // KyberSwap Classic / DMM (amplified constant-product on virtual reserves; V2-shaped,
      // callback-free). Ethereum DMMFactory — getPools(a,b) → per-pool getTradeInfo().
      { address: "0x833e4083B7ae46CeA85695c4f7ed25CDAd8886dE" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.KyberClassic, label: "KyberSwap Classic" },
      // Fermi / propAMM: LEFT EMPTY + FLAGGED. The FermiSwapper router
      // 0xb1076fe3ab5e28005c7c323bac5ac06a680d452e has code ONLY on Ethereum (no code on
      // arbitrum/optimism/base/polygon/bsc). isActive(USDC,USDT)==true and getPairs() lists a USDC/USDT
      // pair, BUT quoteAmounts(USDC,USDT,+amt) REVERTS StaleUpdate() at every size — the oracle feed is
      // stale, so the pair cannot produce a quote at read time. `discoverFermiPoolsTyped` keeps only
      // strictly-positive sampled quotes, so every sample maps to 0 → the pool is dropped. No verifiable
      // quotable stable pair, so no Fermi FactoryConfig entry is wired (re-light when the feed is live).
    ],
    baseTokens: [
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Hex, // WETH
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex, // USDC
      "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Hex, // DAI
      "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Hex, // USDT
      "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Hex, // WBTC
    ],
    feeTiers: [100, 500, 3000, 10000],
  },

  arbitrum: {
    factories: [
      // V3 concentrated liquidity (has price limit)
      { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3" },
      { address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "PancakeSwap V3", feeTiers: [...PANCAKE_V3_FEE_TIERS] },
      { address: "0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
      // KyberSwap Elastic REMOVED: Elastic is NOT V3-compatible (getPoolState()/its own swap, no slot0) — a queried-tier collision reverts the whole lens eth_call; needs its own FactoryType before re-adding.
      // Ramses CL — LIVE fee-keyed V3Standard factory. On-chain verified on Arbitrum mainnet:
      //   - The live Ramses CL NonfungiblePositionManager 0xAA277CB7914b7e5514946Da92cb9De332Ce610EF
      //     returns factory() = 0xAA2cd7477c451E703f3B9Ba5663334914763edF8 (4900-byte proxy → 15KB impl).
      //   - It is fee-keyed getPool(address,address,uint24): tickSpacing-keyed getPool(a,b,int24) REVERTS
      //     (bare 0x) → V3Standard, NOT SlipstreamCL. getPool(USDC,USDT,100) → 0x113DFF7d… (real live pool:
      //     token0=USDC, token1=USDT, fee=100, tickSpacing=1, liquidity≈4.77e10; factory() back-references).
      //   - Ramses uses NON-standard low fee tiers: getPool(WETH,USDC,·) returns live pools at 50/250/500/
      //     3000/10000, and getPool(USDC,USDT,·) at 50/100 — so feeTiers override [50,100,250,500,3000,10000]
      //     (the default [100,500,3000,10000] would miss the deep stable pools at fee=50 and fee=100).
      // (The prior wired 0x07E6…6b45 was Ramses's HyperEVM factory, dead on Arbitrum — 0 code — now replaced.)
      { address: "0xAA2cd7477c451E703f3B9Ba5663334914763edF8" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Ramses CL", feeTiers: [50, 100, 250, 500, 3000, 10000] },
      // Chronos CL — LEFT as V3Standard and FLAGGED: NOT re-tagged to SlipstreamCL because
      // getPool(a,b,int24) reverts (bare 0x) against this factory on Arbitrum mainnet, so it does NOT
      // respond as a tickSpacing-keyed CLFactory (nor did the fee-keyed getPool return a pool). Needs
      // address / interface re-verification before it can be discovered.
      { address: "0x4Db9D624F67E00dbF8ef7AE0e0e8eE54aF1dee49" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Chronos CL" },
      // Algebra (V3-compatible swap with dynamic fees, different factory query)
      { address: "0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "Camelot V3" },
      { address: "0xAA2cd7477c451E703f3B9231d37de3ECDf0bc45A" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "Ramses V2" },
      // V4 singleton (PoolManager + StateView lens). Official Uniswap V4 Arbitrum deployment.
      { address: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32" as Hex, stateView: "0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990" as Hex, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
      // V2 constant-product (no price limit)
      { address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "SushiSwap V2" },
      { address: "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "PancakeSwap V2" },
      { address: "0x6EcCab422D763aC031210895C81787E87B43A652" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Camelot V2" },
      { address: "0xaC2ee06A14c52570Ef3B9812Ed240BCe359772e7" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Zyberswap V2" },
      // Solidly V2 (volatile + stable pools)
      { address: "0xd0a07E160511c40ccD5340e94660E9C9c01b0D27" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Ramses V2 Legacy" },
      { address: "0xCe9240869391928253Ed9cc9Bcb8cb98CB5B0722" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Chronos V1" },
      // Curve
      { address: "0x445FE580eF8d70FF569aB36e80c647af338db351" as Hex, poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
      // Balancer V2 (Vault — known ComposableStable pool addresses). On-chain verified via
      // Vault.getPoolTokens(getPoolId(pool)):
      //   0x1533…2382  USDT-USDC.e-DAI StablePool  (DAI ≈32,208 · USDT ≈66,842 · USDC.e ≈31,071; ~$130k;
      //                                             DAI+USDT are baseTokens — USDC.e is bridged, not native)
      //   0x423A…4A5   Stable 4pool                 (nativeUSDC ≈770 · DAI ≈801 · USDT ≈3,084 · USDC.e ≈742;
      //                                             ~$5.4k; holds native USDC 0xaf88…)
      { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Hex, poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Balancer V2",
        balancerStablePools: [
          "0x1533A3278f3F9141d5F820A184EA4B017fce2382" as Hex, // USDT-USDC.e-DAI StablePool
          "0x423A1323c871aBC9d89EB06855bF5347048Fc4A5" as Hex, // Balancer Stable 4pool (native USDC/DAI/USDT/USDC.e)
        ] },
      // Balancer V3 (Vault singleton 0xbA13…bA9 + Arbitrum Router 0xEAed…CF2E; callback-free typed path via
      // Permit2). On-chain verified: the Vault singleton is present on Arbitrum and the Router's
      // getPermit2() = the canonical Permit2. The TYPE + Router are wired so a known deep Arbitrum V3 stable
      // pool drops in by address alone (populate `balancerV3Pools` from the Balancer V3 subgraph — LEFT
      // EMPTY here pending a verified deep both-baseToken-wrapper pool, same convention as the empty V2
      // Balancer entries). poolType UniV2 is INERT for Balancer V3 — a placeholder.
      { address: "0xbA1333333333a1BA1108E8412f11850A5C319bA9" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.BalancerV3, label: "Balancer V3",
        balancerV3Router: "0xEAedc32a51c510d35ebC11088fD5fF2b47aACF2E" as Hex },
      // Fluid DEX (FluidDexT1 typed path). On-chain verified: DexFactory.getDexAddress → getDexTokens (via
      // DexResolver 0x11D80…) → dexId3 0x3C04…CDa7 is USDC(0xaf88…, native)/USDT(0xFd08…) — both baseTokens;
      // estimateSwapIn deep (1M USDC → 1.0003M USDT).
      // poolType UniV2 is INERT for Fluid (discovery keys off factoryType; Fluid executes callback-free via
      // its own EcoFluid path, never dispatched as a UniV2 router swap) — a placeholder, not a UniV2 claim.
      { address: "0x91716C4EDA1Fb55e84Bf8b4c7085f84285c19085" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.Fluid, label: "Fluid DEX",
        fluidResolver: "0x11D80CfF056Cef4F9E6d23da8672fE9873e5cC07" as Hex,
        fluidPools: [
          "0x3C0441B42195F4aD6aa9a0978E06096ea616CDa7" as Hex, // USDC/USDT (deep)
        ] },
      // EulerSwap: LEFT EMPTY + FLAGGED (same reason as ethereum — the deployed pools expose the v1
      // getParams() surface and REVERT getDynamicParams() the recipe requires). Fermi: no FermiSwapper
      // deployment on Arbitrum (router 0xb1076fe3… is Ethereum-only). Both intentionally omitted.
      // DODO V2 — corrected to the LIVE Arbitrum DVMFactory (getDODOPool(base,quote)→address[]), matching the
      // eth 0x72d220cE entry. On-chain verified on Arbitrum: 0xDa4c4411… has code (4517 bytes),
      // getDODOPool(WETH,USDC) → 10 pools, getDODOPool(USDC,USDT) → 53 pools. The prior wired
      // 0x2A3CE1DebAf2F0F5A0A6dEB64DF95B11a2407d3C is dead on Arbitrum (0 code) — it is DODO's OPTIMISM
      // factory address mis-placed in the Arbitrum block. Canonical per-chain DVMFactory from the DODO
      // contract API (chainId 42161).
      { address: "0xDa4c4411c55B0785e501332354A036c04833B72b" as Hex, poolType: SwapPoolType.DODOV2, factoryType: FactoryType.DODOZoo, label: "DODO V2" },
      // Trader Joe LB
      { address: "0x8e42f2F4101563bF679975178e880FD87d3eFd4e" as Hex, poolType: SwapPoolType.TraderJoeLB, factoryType: FactoryType.TraderJoeLB, label: "Trader Joe LB" },
      // WOOFi (WooPPV2 sPMM — deterministic single-address deployment).
      { address: "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4" as Hex, poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "WOOFi" },
    ],
    baseTokens: [
      "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Hex, // WETH
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Hex, // USDC
      "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" as Hex, // DAI
      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Hex, // USDT
      "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" as Hex, // WBTC
    ],
    feeTiers: [100, 500, 3000, 10000],
  },

  optimism: {
    factories: [
      // V3 concentrated liquidity (has price limit)
      { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3" },
      // Velodrome CL (Slipstream on Optimism) — tickSpacing-keyed getPool(a,b,int24). Verified
      // on-chain: getPool(WETH,USDC,int24) returns non-zero pools at tickSpacings {1,100}. Per-pool
      // fee READ from fee() (decoupled from tickSpacing). V3-compatible for execution (swapV3).
      { address: "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Velodrome CL" },
      { address: "0x9c6522117e2ed1fE5bdb72bb0eD5E3f2bdE7DBe0" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
      // KyberSwap Elastic REMOVED: Elastic is NOT V3-compatible (getPoolState()/its own swap, no slot0) — a queried-tier collision reverts the whole lens eth_call; needs its own FactoryType before re-adding.
      // V4 singleton (PoolManager + StateView lens). Official Uniswap V4 Optimism deployment.
      { address: "0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3" as Hex, stateView: "0xc18a3169788F4F75A170290584ECA6395C75Ecdb" as Hex, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
      // V2 constant-product (no price limit)
      { address: "0xFbc12984689e5f15626Bad03Ad60160Fe98B303C" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "SushiSwap V2" },
      // Solidly V2 (volatile + stable pools)
      { address: "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Velodrome V2" },
      // Curve (MetaRegistry — find_pool_for_coins across all Curve pools).
      { address: "0xc65CB3156225380BEda366610BaB18D5835A1647" as Hex, poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
      // Balancer V2 — balancerStablePools LEFT EMPTY + FLAGGED. Balancer V2 on Optimism has drained: the
      // deepest all-stablecoin ComposableStable verified via Vault.getPoolTokens(getPoolId(pool)) is
      // 0x9da1…040d9 "Native Stable Beets" (USDC/USDC.e/USDT/DAI) at only ~$530 total, and 0x3736…4de
      // "Optimistic Steady Beets" at ~$45 — both genuinely all-stablecoin but far too shallow to wire (the
      // eth/base pools already wired are $35k–$120k). No V2-Vault stable pool worth wiring → left empty.
      { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Hex, poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Balancer V2" },
      // WOOFi (WooPPV2 sPMM — deterministic single-address deployment).
      { address: "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4" as Hex, poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "WOOFi" },
    ],
    baseTokens: [
      "0x4200000000000000000000000000000000000006" as Hex, // WETH
      "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Hex, // USDC
      "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" as Hex, // DAI
      "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" as Hex, // USDT
      "0x68f180fcCe6836688e9084f035309E29Bf0A2095" as Hex, // WBTC
    ],
    feeTiers: [100, 500, 3000, 10000],
  },

  polygon: {
    factories: [
      // V3 concentrated liquidity (has price limit)
      { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3" },
      // KyberSwap Elastic REMOVED: Elastic is NOT V3-compatible (getPoolState()/its own swap, no slot0) — a queried-tier collision reverts the whole lens eth_call; needs its own FactoryType before re-adding.
      { address: "0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
      // Algebra (V3-compatible with dynamic fees)
      { address: "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "QuickSwap V3" },
      // V4 singleton (PoolManager + StateView lens). Official Uniswap V4 Polygon deployment.
      { address: "0x67366782805870060151383F4BbFF9daB53e5cD6" as Hex, stateView: "0x5eA1bD7974c8A611cBAB0bDCAFcB1D9CC9b3BA5a" as Hex, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
      // V2 constant-product (no price limit)
      { address: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "QuickSwap V2" },
      { address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "SushiSwap V2" },
      // Curve
      { address: "0x47bB542B9dE58b970bA50c9dae444DDB4c16751a" as Hex, poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
      // Balancer V2 (Vault — known ComposableStable pool addresses). On-chain verified via
      // Vault.getPoolTokens(getPoolId(pool)):
      //   0x06Df…1b42  Polygon Stable Pool (USDC.e/DAI/miMATIC/USDT)  (USDC.e ≈20,497 · DAI ≈20,452 ·
      //                                     miMATIC ≈33,034 · USDT ≈21,485; ~$74k; DAI+USDT are baseTokens —
      //                                     USDC here is bridged USDC.e 0x2791…, not the native 0x3c49… baseToken)
      //   0x0d34…FD4f  TUSD Stablepool (USDC.e/TUSD/DAI/USDT)          (USDC.e ≈2,826 · TUSD ≈4,620 ·
      //                                     DAI ≈2,784 · USDT ≈3,965; ~$13k; DAI+USDT tradeable)
      // (Polygon has NO deep native-USDC 0x3c49… V2 stable pool — the deepest is ~$997, dust — so these
      // legacy USDC.e-anchored pools carry the DAI↔USDT stable depth.)
      { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Hex, poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Balancer V2",
        balancerStablePools: [
          "0x06Df3b2bbB68adc8B0e302443692037ED9f91b42" as Hex, // Polygon Stable Pool (USDC.e/DAI/miMATIC/USDT)
          "0x0d34e5dD4D8f043557145598E4e2dC286B35FD4f" as Hex, // TUSD Stablepool (USDC.e/TUSD/DAI/USDT)
        ] },
      // Fluid DEX (FluidDexT1 typed path). On-chain verified: DexFactory.getDexAddress → getDexTokens (via
      // DexResolver 0x11D80…) → dexId1 0x0B1a…C9e7 is native USDC(0x3c49…)/USDT(0xc213…) — both baseTokens;
      // estimateSwapIn shows a thin-but-real stable pool (quotes small sizes; truncates past ~few-thousand-$).
      // poolType UniV2 is INERT for Fluid (discovery keys off factoryType; Fluid executes callback-free via
      // its own EcoFluid path, never dispatched as a UniV2 router swap) — a placeholder, not a UniV2 claim.
      { address: "0x91716C4EDA1Fb55e84Bf8b4c7085f84285c19085" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.Fluid, label: "Fluid DEX",
        fluidResolver: "0x11D80CfF056Cef4F9E6d23da8672fE9873e5cC07" as Hex,
        fluidPools: [
          "0x0B1a513ee24972DAEf112bC777a5610d4325C9e7" as Hex, // native USDC/USDT
        ] },
      // EulerSwap + Fermi: LEFT EMPTY + FLAGGED (no EulerSwap v2 stable pool; no FermiSwapper on Polygon).
      // DODO V2 — corrected to the LIVE Polygon DVMFactory (getDODOPool(base,quote)→address[]), matching the
      // eth 0x72d220cE entry. On-chain verified on Polygon: 0x7988…fE13 has code (4460 bytes),
      // getDODOPool(WMATIC,USDC.e) → 30 pools. The prior wired 0x79887f65f83bdf15Bcc8736b5e1Eed0C37B8571d is a
      // CORRUPTED address (right 0x79887f65… prefix, wrong tail) — dead on Polygon (0 code). Canonical
      // per-chain DVMFactory from the DODO contract API (chainId 137). NOTE: sampled Polygon DODO pools are
      // near-zero depth, so discovery finds them but the relative-depth filter drops them — correct-but-inert.
      { address: "0x79887f65f83bdf15Bcc8736b5e5BcDB48fb8fE13" as Hex, poolType: SwapPoolType.DODOV2, factoryType: FactoryType.DODOZoo, label: "DODO V2" },
      // WOOFi (WooPPV2 sPMM — deterministic single-address deployment).
      { address: "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4" as Hex, poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "WOOFi" },
    ],
    baseTokens: [
      "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" as Hex, // WMATIC
      "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" as Hex, // WETH
      "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Hex, // USDC
      "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" as Hex, // DAI
      "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" as Hex, // USDT
      "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" as Hex, // WBTC
    ],
    feeTiers: [100, 500, 3000, 10000],
  },

  // BSC (chainId 56). Note: BSC USDC/USDT are 18 decimals (Binance-Peg), not 6.
  bsc: {
    factories: [
      // V3 concentrated liquidity. Pancake's medium tier is 2500 (0.25%) on BSC, not 3000.
      { address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "PancakeSwap V3", feeTiers: [...PANCAKE_V3_FEE_TIERS] },
      // Uniswap V3 (standard 0.30% tier — NOT Pancake's 2500).
      { address: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3" },
      // THENA Fusion (Algebra dynamic-fee CL; poolByPair + globalState). Executable — the engine
      // services algebraSwapCallback (sauce#186). Algebra v1 pools share a fixed tickSpacing of 60.
      { address: "0x306F06C147f064A010530292A1EB6737c3e378e4" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, algebraTickSpacing: 60, label: "THENA Fusion" },
      // Maverick V2
      { address: "0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e" as Hex, poolType: SwapPoolType.MaverickV2, factoryType: FactoryType.MaverickV2Factory, label: "Maverick V2" },
      // V2 constant-product. Pancake V2 pairs ENFORCE 0.25% (2500 ppm — the pair's K check is
      // balanceAdjusted = balance*10000 - amountIn*25), not the 0.30% default. A lower modeled fee
      // (the pre-fix 2000) over-asks output and the pair K-reverts the whole cook.
      { address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "PancakeSwap V2", v2FeePpm: 2500 },
      // Solidly V2 (volatile + stable pools)
      { address: "0x27DfD2D7b85e0010542da35C6EBcD59E45fc949D" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Thena (Solidly fork)" },
      // WOOFi (WooPPV2 sPMM — deterministic single-address deployment).
      { address: "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4" as Hex, poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "WOOFi" },
      // PancakeSwap StableSwap (Curve-like A-invariant). NOTE: discovery interface is
      // getPairInfo/getThreePoolPairInfo, NOT Curve's find_pool_for_coins — the CurveRegistry
      // reader in pool-discovery.ts needs a Pancake-StableSwap branch before it enumerates pools,
      // and execution is not in the engine's _swapCurve dispatch. Authoritatively verified address;
      // included but NOT drop-in (needs-integration-work).
      { address: "0x25a55f9f2279A54951133D503490342b50E5cd15" as Hex, poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "PancakeSwap StableSwap" },
      // Wombat Exchange (single-sided stableswap, callback-free). Discovered via the TYPED
      // FactoryType.Wombat path (addressOfAsset + per-asset cash/liability + ampFactor/haircutRate),
      // so poolType is unused here — UniV2 is a benign placeholder. Address is the Wombat Main Pool.
      { address: "0x312Bc7eAAF93f1C60Dc5AfC115FcCDE161055fb0" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.Wombat, label: "Wombat" },
    ],
    baseTokens: [
      "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as Hex, // WBNB
      "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Hex, // USDC (Binance-Peg, 18 dec)
      "0x55d398326f99059fF775485246999027B3197955" as Hex, // USDT (BSC-USD, 18 dec)
    ],
    feeTiers: [100, 500, 3000, 10000],
  },

  // Sonic (chainId 146). wS (wrapped native) included as a routing hub, not a stablecoin.
  sonic: {
    factories: [
      // SwapX (Algebra Integral CL) — dynamic fee, poolByPair + globalState.
      { address: "0x8121a3F8c4176E9765deEa0B95FA2BDfD3016794" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "SwapX (Algebra Integral CL)" },
      // Shadow Exchange CL (Ramses V3 / Slipstream-style) — tickSpacing-keyed getPool(a,b,int24), now
      // discoverable via FactoryType.SlipstreamCL. Verified on-chain: getPool(wS,USDC,int24) returns
      // non-zero pools at tickSpacings {1,50,100,200}. Per-pool fee READ from fee() (decoupled from
      // tickSpacing). V3-compatible for execution (swapV3 / uniswapV3SwapCallback).
      { address: "0xcD2d0637c94fe77C2896BbCBB174cefFb08DE6d7" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Shadow Exchange CL (Ramses V3)" },
      // SwapX Classic (Solidly ve(3,3), stable + volatile)
      { address: "0x05c1be79d3aC21Cc4B727eeD58C9B2fF757F5663" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "SwapX Classic (Solidly)" },
      // Shadow Exchange Legacy (Solidly PairFactory, stable + volatile)
      { address: "0x2dA25E7446A70D7be65fd4c053948BEcAA6374c8" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Shadow Exchange Legacy (Solidly)" },
      // Beets (Beethoven X) — canonical cross-chain Balancer V2 Vault. balancerStablePools LEFT EMPTY +
      // FLAGGED. Sonic Beets has huge stablecoin TVL, but it is NOT reachable through the V2 Vault this entry
      // wires: (1) the deep "STABLE" pools (0x3d71ad28… smsUSD/vgUSDC ~$247M, 0x0ae7fbbe… ~$1.53M, 0x790fd3e9…
      // ~$766k) are Balancer V3 pools — they REVERT on getPoolId() on-chain, so discoverBalancerStablePoolsTyped
      // (getPoolId → V2 Vault.getPoolTokens) cannot add them at all; (2) filtering the Balancer API to
      // protocolVersion=2, the deepest all-stablecoin V2 ComposableStable is 0xcd4d…1c0c (USDC.e/scUSD) at only
      // ~$3,217 total, and its scUSD is not a wired baseToken — every deeper V2 "stable" pool holds
      // yield-bearing wrapper tokens (smsUSD/vgUSDC/msUSD/ghUSDC…) that are not base tokens, so discovery's
      // tokenIn/tokenOut ∈ pool tokens filter never matches. No V2-Vault base-token stable pool with real
      // depth → left empty. (V3-Vault support would be needed to reach the deep pools — out of scope.)
      { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Hex, poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Beets (Balancer V2 Vault)" },
      // Beets Balancer V3 (Vault singleton 0xbA13…bA9 + Sonic Router 0x93db…Dae5; callback-free typed path
      // via Permit2). This wires the V3-Vault path the prior V2-only Beets entry documented it could NOT
      // reach — the deep Sonic Beets "STABLE" pools (0x3d71ad28…, 0x43026d48… "Boosted Stable Rings", …) are
      // Balancer V3 pools (they REVERT getPoolId(), so the V2 Vault.getPoolTokens path can't add them). On-
      // chain verified: isPoolRegistered(0x43026d…)=true, getPoolTokens = [0x7870…, 0xd3DC…] (boosted/wrapped
      // legs), Sonic Router.getPermit2() = the canonical Permit2. NOTE: like the Base/ETH V3 pools, the
      // swappable tokens are BOOSTED/WRAPPED wrappers (smsUSD/vgUSDC-class), NOT the wired baseTokens
      // (wS/USDC/USDT), so a base-token EcoSwap won't route through them until the wrappers are among the
      // discovery baseTokens/route hops — AND this specific "Boosted Stable Rings" pool needs its ERC4626
      // buffers initialized for the single-swap Router query (a plain querySwapSingleTokenExactIn against it
      // reverted with a buffer error at read time). The TYPE + Router are wired so a directly-queryable deep
      // Sonic V3 stable pool drops in by address alone. poolType UniV2 is INERT (discovery keys off
      // factoryType; V3 executes callback-free via its own EcoBalancerV3 path) — a placeholder.
      { address: "0xbA1333333333a1BA1108E8412f11850A5C319bA9" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.BalancerV3, label: "Beets (Balancer V3)",
        balancerV3Router: "0x93db4682A40721e7c698ea0a842389D10FA8Dae5" as Hex,
        balancerV3Pools: [
          "0x43026d483f42fb35efe03c20b251142d022783f2" as Hex, // Boosted Stable Rings (boosted/wrapped legs)
        ] },
    ],
    baseTokens: [
      "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38" as Hex, // wS (wrapped Sonic, native)
      "0x29219dd400f2Bf60E5a23d13Be72B486D4038894" as Hex, // USDC.e / USDC (bridged, 6 dec; one address)
      "0x6047828dc181963ba44974801FF68e538dA5eaF9" as Hex, // USDT (bridged, 6 dec)
    ],
    feeTiers: [100, 500, 3000, 10000],
  },

  // Celo (chainId 42220). CELO (native ERC20, 18 dec) is the routing hub, not a tradeable stable.
  celo: {
    factories: [
      // V3 concentrated liquidity (has price limit). Standard Uniswap V3 fee tiers.
      { address: "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3", feeTiers: [100, 500, 3000, 10000] },
      // V4 singleton (PoolManager + StateView lens). V4 is dynamic-fee/tickSpacing-keyed.
      { address: "0x288dc841A52FCA2707c6947B3A777c5E56cd87BC" as Hex, stateView: "0xbc21f8720BABf4b20d195eE5C6e99c52b76F2bfb" as Hex, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
      // Velodrome V2 (Solidly volatile + stable pools). Canonical Superchain Leaf PoolFactory.
      { address: "0x31832f2a97Fd20664D76Cc421207669b55CE4BC0" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Velodrome V2" },
      // Velodrome CL (Slipstream on Celo) — tickSpacing-keyed getPool(a,b,int24), discovered via
      // FactoryType.SlipstreamCL. Verified on-chain: getPool(CELO,USDC,int24) returns a non-zero pool at
      // tickSpacing 100. Per-pool fee READ from fee() (decoupled from tickSpacing). V3-compatible for
      // execution (swapV3 / uniswapV3SwapCallback). (Previously omitted as a documented latent gap; the
      // tickSpacing-keyed discovery branch now lights it up.)
      { address: "0x04625B046C69577EfC40e6c0Bb83CDBAfab5a55F" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Velodrome CL" },
      // Mento V2 (Celo stablecoin exchange). `address` is the Broker (BrokerProxy) — discovery enumerates
      // its exchange providers (BiPoolManager) + exchanges. poolType is a benign valid value (Mento is
      // CALLBACK-FREE with no engine SwapPoolType — the swap goes through the Broker in SauceScript). The
      // canonical BiPoolManager is pinned as a documented provider hint. Verified proxies on Celoscan.
      { address: "0x777A8255cA72412f0d706dc03C9D1987306B4CaD" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.Mento, label: "Mento V2", mentoExchangeProviders: ["0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901" as Hex] },
    ],
    baseTokens: [
      "0x471EcE3750Da237f93B8E339c536989b8978a438" as Hex, // CELO (native ERC20, routing hub, 18 dec)
      "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Hex, // USDC (Circle native, 6 dec)
      "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Hex, // USDT (Tether native)
      "0x765DE816845861e75A25fCA122bb6898B8B1282a" as Hex, // cUSD (Mento Dollar)
      "0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189" as Hex, // oUSDT (OpenUSDT)
    ],
    feeTiers: [100, 500, 3000, 10000],
  },

  // Ink (OP-stack L2, chainId 57073). WETH (wrapped native) is the routing hub.
  ink: {
    factories: [
      // V3 concentrated liquidity (has price limit). Ink uses a distinct V3 factory deployer.
      { address: "0x640887A9ba3A9C53Ed27D0F7e8246A4F933f3424" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3", feeTiers: [100, 500, 3000, 10000] },
      // Velodrome V2 (Solidly volatile + stable pools).
      { address: "0x31832f2a97Fd20664D76Cc421207669b55CE4BC0" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Velodrome V2 (Solidly)" },
      // Velodrome Slipstream CL (Ink) — tickSpacing-keyed getPool(a,b,int24), discovered via
      // FactoryType.SlipstreamCL. Verified on-chain: the factory has code + 6 pools, getPool(a,b,int24)
      // round-trips exactly against an enumerated pool (e.g. USDT0/WETH ts=100 → 0x0eA741…), and the
      // pools carry fee DECOUPLED from tickSpacing (ts=100/fee=500, ts=1/fee=100), so the per-pool fee is
      // READ from fee(). Ink's liquid Slipstream pairs are USDT0-denominated (no WETH/USDC pool today),
      // and USDT0 IS in baseTokens below, so the WETH/USDT0 pool set is ACTIVELY discovered — not inert.
      // (Any future WETH/USDC pool drops in on the same tickSpacing-keyed type by address alone.)
      { address: "0x718E46d0962A66942E233760a8bd6038Ce54EdCD" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Velodrome Slipstream CL" },
    ],
    baseTokens: [
      "0x4200000000000000000000000000000000000006" as Hex, // WETH (OP-stack predeploy, routing hub)
      "0x2D270e6886d130D724215A266106e6832161EAEd" as Hex, // USDC (canonical native, 6 dec)
      "0xF1815bd50389c46847f0Bda824eC8da914045D14" as Hex, // USDC.e (Stargate bridged, 6 dec)
      "0x0200C29006150606B650577BBE7B6248F58470c1" as Hex, // USDT0 (LayerZero OFT USDT, 6 dec)
      "0xe343167631d89B6Ffc58B88d6b7fB0228795491D" as Hex, // USDG (Global Dollar, 6 dec)
      "0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189" as Hex, // oUSDT (OpenUSDT, 6 dec)
    ],
    feeTiers: [100, 500, 3000, 10000],
  },

  // Plasma (chainId 9745). WXPL (wrapped native) is the routing hub. No Uniswap V4 deployment.
  plasma: {
    factories: [
      // V3 concentrated liquidity (has price limit). Standard Uniswap V3 fee tiers.
      { address: "0xcb2436774C3e191c85056d248EF4260ce5f27A9D" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3", feeTiers: [100, 500, 3000, 10000] },
      // Curve — discovery via the Metaregistry (find_pool_for_coins / get_coin_indices / get_n_coins),
      // NOT the StableSwap Factory 0x8271e06E... (which implements a different interface the
      // CurveRegistry reader does not call). Stable-stable pools (USDT0/USDe verified).
      { address: "0xe6dA14500f0b5783E2325F9C5a7eE5d99DA0fB42" as Hex, poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
    ],
    baseTokens: [
      "0x6100E367285b01F48D07953803A2d8dCA5D19873" as Hex, // WXPL (wrapped native, routing hub, 18 dec)
      "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb" as Hex, // USDT0 (primary stablecoin, 6 dec)
      "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34" as Hex, // USDe (Ethena synthetic dollar, 18 dec)
    ],
    feeTiers: [100, 500, 3000, 10000],
  },

  // HyperEVM (chainId 999). WHYPE (wrapped native) is the routing hub. No V4 / no verified Curve registry.
  hyperevm: {
    factories: [
      // HyperSwap V3 concentrated liquidity (has price limit). Standard Uniswap V3 fee tiers
      // (NOT Pancake's 2500 — feeAmountTickSpacing(2500)=0).
      { address: "0xB1c0fa0B789320044A6F623cFe5eBda9562602E3" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "HyperSwap V3", feeTiers: [100, 500, 3000, 10000] },
      // HyperSwap V2 constant-product (canonical 0.30% fee, UniswapV2 fork — no v2FeePpm override).
      { address: "0x724412C00059bf7d6ee7d4a1d0D5cd4de3ea1C48" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "HyperSwap V2" },
    ],
    baseTokens: [
      "0x5555555555555555555555555555555555555555" as Hex, // WHYPE (wrapped native, routing hub, 18 dec)
      "0xb88339CB7199b77E23DB6E890353E22632Ba630f" as Hex, // USDC (Circle native, 6 dec)
      "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb" as Hex, // USDT0 (Tether OFT, 6 dec)
      "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34" as Hex, // USDe (Ethena, 18 dec)
    ],
    feeTiers: [100, 500, 3000, 10000],
  },

  // Unichain (chainId 130). Uniswap-native OP-stack L2. WETH is the OP-stack predeploy
  // 0x4200...0006 (routing hub; Eco routes only stablecoins). Unichain uses the non-canonical
  // 0x1f9840000...0002/0003/0004 deterministic factory scheme (NOT the usual 0x1F98431c... V3
  // factory). Standard Uniswap fee tiers (100/500/3000/10000) — V3 feeAmountTickSpacing is the
  // canonical set, NOT Pancake's 2500. All addresses verified from the Uniswap official developer
  // docs (developers.uniswap.org/docs/unichain/technical-information/contract-addresses) + the V4
  // deployments page. Stablecoins verified: USDC native (Circle), USDT0 (Tether OFT, 6 dec),
  // oUSDT (OpenUSDT Superchain ERC20, 6 dec). DROPPED (could not verify on Unichain mainnet,
  // under-adding): USDT (no separate bridged USDT — USDT0 IS canonical Tether), USDG (Paxos docs
  // list only Ethereum/Solana/Ink/X Layer), USDC.e (Unichain USDC is native, no bridged variant),
  // USDbC (Base-specific).
  unichain: {
    factories: [
      // V3 concentrated liquidity (has price limit). Standard Uniswap V3 fee tiers.
      { address: "0x1F98400000000000000000000000000000000003" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3", feeTiers: [100, 500, 3000, 10000] },
      // V4 singleton (PoolManager + StateView lens).
      { address: "0x1F98400000000000000000000000000000000004" as Hex, stateView: "0x86e8631A016F9068C3f085fAF484Ee3F5fDee8f2" as Hex, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
      // V2 constant-product (no price limit). Canonical 0.30% fee.
      { address: "0x1F98400000000000000000000000000000000002" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Uniswap V2" },
    ],
    baseTokens: [
      "0x4200000000000000000000000000000000000006" as Hex, // WETH (OP-stack predeploy, routing hub)
      "0x078D782b760474a361dDA0AF3839290b0EF57AD6" as Hex, // USDC (Circle native, 6 dec)
      "0x9151434b16b9763660705744891fA906F660EcC5" as Hex, // USDT0 (Tether OFT, 6 dec)
      "0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189" as Hex, // oUSDT (OpenUSDT, 6 dec)
    ],
    feeTiers: [100, 500, 3000, 10000],
  },

  // Ronin (chainId 2020). Gaming chain — stablecoin depth is THIN. WRON (wrapped native) is the
  // routing hub, not a stablecoin. Katana is a Uniswap V2 + V3 fork (Katana V3 uses the standard
  // uniswapV3SwapCallback shape). Factories verified via the official ronin-chain/katana-operation-
  // contracts mainnet deploy script + live RPC. CRITICAL: Katana V3 enabled fee tiers are
  // NON-STANDARD = [100, 3000, 10000] (feeAmountTickSpacing: 100->1, 3000->60, 10000->200; the
  // 0.05%/500 tier is DISABLED) — per-factory feeTiers set on the V3 row, chain-level feeTiers
  // also omit 500. Only USDC is a verifiable stablecoin with DEX liquidity (a scan of all 665
  // Katana V2 pairs found ZERO USDT/USDT0/USDC.e/USDG/oUSDT/DAI/USDe pairs). DROPPED (under-add):
  // USDT (no canonical Ronin address confirmable), oUSDT (OpenUSDT docs list Ronin but OKLink shows
  // zero balance / no contract — likely not active), USDG/USDC.e/USDT0/USDbC (no authoritative
  // Ronin deployment found). baseTokens deliberately holds only WRON + USDC; add others later only
  // after confirming canonical Ronin addresses on the explorer.
  ronin: {
    factories: [
      // V2 constant-product (no price limit). Katana V2 — UniswapV2 fork, canonical 0.30% fee.
      { address: "0xB255D6A720BB7c39fee173cE22113397119cB930" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Katana V2" },
      // V3 concentrated liquidity (has price limit). Katana V3 — NON-STANDARD enabled fee tiers
      // (0.05%/500 disabled); per-factory feeTiers required.
      { address: "0x1f0B70d9A137e3cAEF0ceAcD312BC5f81Da0cC0c" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Katana V3", feeTiers: [100, 3000, 10000] },
    ],
    baseTokens: [
      "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4" as Hex, // WRON (wrapped native, routing hub, 18 dec)
      "0x0B7007c13325C48911F73A2daD5FA5dCBf808aDc" as Hex, // USDC (6 dec)
    ],
    feeTiers: [100, 3000, 10000],
  },
};

// ── Infrastructure ───────────────────────────────────────────

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Hex;

// ── Uniswap V3 price boundaries ─────────────────────────────

/** Minimum sqrt price ratio (from UniswapV3 TickMath) */
export const MIN_SQRT_RATIO = 4295128739n;
/** Maximum sqrt price ratio (from UniswapV3 TickMath) */
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

// ── Protocol-specific constants ─────────────────────────────

/** Balancer V2 Vault — same address on all EVM chains */
export const BALANCER_V2_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Hex;

/** Trader Joe LB bin steps to query per factory */
export const TRADER_JOE_BIN_STEPS = [1, 5, 10, 15, 20, 25] as const;

/**
 * Trader Joe LB default static base-fee factor (`getStaticFeeParameters().baseFactor`). LB v2.1
 * pools commonly use 5000 (→ baseFee = 0.5·binStep%); read live per-pair where available, falls
 * back to this. The base fee is the FIXED snapshot fee the segment math grosses by (the variable
 * volatility fee is transient and omitted — the same per-block snapshot assumption used for V3).
 */
export const TRADER_JOE_DEFAULT_BASE_FACTOR = 5000;

/**
 * Trader Joe LB bin-scan window (bins on EACH side of the active bin) the typed discovery reads
 * into the off-chain segment enumerator. LB walks bins outward from the active id one per step;
 * a window of N bins covers a price excursion of (1+binStep/1e4)^N — at binStep 10 (0.1%), 256
 * bins ≈ a 13× excursion, far past any realistic split. Bounds the per-pair getBin multicall.
 */
export const TRADER_JOE_BIN_WINDOW = Number(process.env.ECO_LB_BIN_WINDOW ?? 256);
