/**
 * Chain addresses, swap constants, and per-chain pool discovery configs.
 *
 * Covers all major liquidity sources across supported chains:
 * V3-style (Uniswap V3, PancakeSwap V3, SushiSwap V3, Aerodrome CL, Velodrome CL, KyberSwap Elastic, Ramses V3)
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
  UniV3 = 1,       // Concentrated liquidity — Uniswap V3, PancakeSwap V3, Algebra, KyberSwap
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
  /** DODO V2: getDODO(base, quote) → sellBase/sellQuote */
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
   * EulerSwap (Euler v2 vault-backed AMM). Discovery is KNOWN-POOL-ADDRESS based (the EulerSwap factory
   * has no pool enumeration — only a `deployedPools` mapping + PoolDeployed events), so the candidate
   * pool addresses are carried per-config in `FactoryConfig.eulerSwapPools` (like Balancer's
   * balancerStablePools). State: live reserve0/reserve1 + the static curve params (equilibriumReserve0/1,
   * priceX/priceY, concentrationX/concentrationY, fee) + the vault input cap from getLimits. The curve is
   * the asymmetric concentrated-liquidity f/fInverse (whitepaper); priced OFF-CHAIN into sampled segments
   * (BOUNDED by the vault inLimit). Callback-free: executed in SauceScript (computeQuote + transfer +
   * pool.swap(amount0Out, amount1Out, to, ""); EulerSwap's swap is V2-shaped, empty data ⇒ no flash
   * callback — the only re-entry is internal to Euler, never the cooking contract), so no engine change.
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
}

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
}

/** Canonical UniswapV2 constant-product fee (ppm): 0.30%. */
export const V2_DEFAULT_FEE_PPM = 3000;

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
    { address: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Aerodrome CL" },
    { address: "0x71524B4f93c58fcbF659783284E38825f0622859" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
    { address: "0xC7a590291e07B9fe9e64b86c58fD8Fc764308C4A" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "KyberSwap Elastic" },
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
      { address: "0xC7a590291e07B9fe9e64b86c58fD8Fc764308C4A" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "KyberSwap Elastic" },
      // V2 constant-product (no price limit)
      { address: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Uniswap V2" },
      { address: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "SushiSwap V2" },
      { address: "0x1097053Fd2ea711dad45caCcc45EfF7548fCB362" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "PancakeSwap V2" },
      // Curve
      { address: "0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5" as Hex, poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
      // Balancer V2 (Vault address — pool discovery via known pools)
      { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Hex, poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Balancer V2" },
      // DODO V2
      { address: "0x72d220cE168C4f361dD4deE5D826a01AD8598f6C" as Hex, poolType: SwapPoolType.DODOV2, factoryType: FactoryType.DODOZoo, label: "DODO V2" },
      // Maverick V2
      { address: "0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e" as Hex, poolType: SwapPoolType.MaverickV2, factoryType: FactoryType.MaverickV2Factory, label: "Maverick V2" },
      // KyberSwap Classic / DMM (amplified constant-product on virtual reserves; V2-shaped,
      // callback-free). Ethereum DMMFactory — getPools(a,b) → per-pool getTradeInfo().
      { address: "0x833e4083B7ae46CeA85695c4f7ed25CDAd8886dE" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.KyberClassic, label: "KyberSwap Classic" },
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
      { address: "0xC7a590291e07B9fe9e64b86c58fD8Fc764308C4A" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "KyberSwap Elastic" },
      { address: "0x07E60782535752be279929e2DFfDd136Db2e6b45" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Ramses V3 CL" },
      { address: "0x4Db9D624F67E00dbF8ef7AE0e0e8eE54aF1dee49" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Chronos CL" },
      // Algebra (V3-compatible swap with dynamic fees, different factory query)
      { address: "0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "Camelot V3" },
      { address: "0xAA2cd7477c451E703f3B9231d37de3ECDf0bc45A" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "Ramses V2" },
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
      // Balancer V2
      { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Hex, poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Balancer V2" },
      // DODO V2
      { address: "0x2A3CE1DebAf2F0F5A0A6dEB64DF95B11a2407d3C" as Hex, poolType: SwapPoolType.DODOV2, factoryType: FactoryType.DODOZoo, label: "DODO V2" },
      // Trader Joe LB
      { address: "0x8e42f2F4101563bF679975178e880FD87d3eFd4e" as Hex, poolType: SwapPoolType.TraderJoeLB, factoryType: FactoryType.TraderJoeLB, label: "Trader Joe LB" },
      // WOOFi
      { address: "0xeFF23B4bE1091b53205E35f3AfCD9C7182bf3062" as Hex, poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "WOOFi" },
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
      { address: "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Velodrome CL" },
      { address: "0x9c6522117e2ed1fE5bdb72bb0eD5E3f2bdE7DBe0" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
      { address: "0xC7a590291e07B9fe9e64b86c58fD8Fc764308C4A" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "KyberSwap Elastic" },
      // V2 constant-product (no price limit)
      { address: "0xFbc12984689e5f15626Bad03Ad60160Fe98B303C" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "SushiSwap V2" },
      // Solidly V2 (volatile + stable pools)
      { address: "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Velodrome V2" },
      // Balancer V2
      { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Hex, poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Balancer V2" },
      // WOOFi
      { address: "0xd1778F9DF3eee5473A9640f13682e3846f61fEbC" as Hex, poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "WOOFi" },
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
      { address: "0xC7a590291e07B9fe9e64b86c58fD8Fc764308C4A" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "KyberSwap Elastic" },
      { address: "0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
      // Algebra (V3-compatible with dynamic fees)
      { address: "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "QuickSwap V3" },
      // V2 constant-product (no price limit)
      { address: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "QuickSwap V2" },
      { address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "SushiSwap V2" },
      // Curve
      { address: "0x47bB542B9dE58b970bA50c9dae444DDB4c16751a" as Hex, poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
      // Balancer V2
      { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Hex, poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Balancer V2" },
      // DODO V2
      { address: "0x79887f65f83bdf15Bcc8736b5e1Eed0C37B8571d" as Hex, poolType: SwapPoolType.DODOV2, factoryType: FactoryType.DODOZoo, label: "DODO V2" },
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
      // V2 constant-product. Pancake V2 charges 0.20% (2000 ppm), not the 0.30% default.
      { address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "PancakeSwap V2", v2FeePpm: 2000 },
      // Solidly V2 (volatile + stable pools)
      { address: "0x27DfD2D7b85e0010542da35C6EBcD59E45fc949D" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Thena (Solidly fork)" },
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
      // Shadow Exchange CL (Ramses V3 / UniV3-style) — slot0 state. NOTE: this Ramses/Shadow-family
      // factory keys getPool by TICK SPACING, not fee, so V3Standard fee-tier discovery will not find
      // its pools (same latent gap as the arbitrum Ramses V3 / Chronos entries). Kept for the pattern;
      // a future tickSpacing-keyed discovery fix lights it up.
      { address: "0xcD2d0637c94fe77C2896BbCBB174cefFb08DE6d7" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Shadow Exchange CL (Ramses V3)" },
      // SwapX Classic (Solidly ve(3,3), stable + volatile)
      { address: "0x05c1be79d3aC21Cc4B727eeD58C9B2fF757F5663" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "SwapX Classic (Solidly)" },
      // Shadow Exchange Legacy (Solidly PairFactory, stable + volatile)
      { address: "0x2dA25E7446A70D7be65fd4c053948BEcAA6374c8" as Hex, poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Shadow Exchange Legacy (Solidly)" },
      // Beets (Beethoven X) — canonical cross-chain Balancer V2 Vault.
      { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Hex, poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Beets (Balancer V2 Vault)" },
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
      // NOTE: Velodrome CL (concentrated-liquidity) factory 0x04625B046C69577EfC40e6c0Bb83CDBAfab5a55F
      // is NOT added — it keys getPool by TICK SPACING, not fee, so the V3Standard fee-tier discovery
      // would not enumerate its pools (same latent gap as the arbitrum Ramses / Sonic Shadow CL entries).
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
      // Velodrome Slipstream CL (Ramses V3 / UniV3-style) — slot0 state. NOTE: this Slipstream CL
      // factory keys getPool by TICK SPACING, not fee, so V3Standard fee-tier discovery will not find
      // its pools (same latent gap as the arbitrum Ramses / Sonic Shadow CL entries). Kept for the
      // pattern; a future tickSpacing-keyed discovery fix lights it up.
      { address: "0x718E46d0962A66942E233760a8bd6038Ce54EdCD" as Hex, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Velodrome Slipstream CL", feeTiers: [100, 500, 3000, 10000] },
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
