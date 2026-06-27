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
  /** Algebra style (Camelot, QuickSwap): poolByPair(tokenA, tokenB), globalState() for state */
  AlgebraV3 = "algebra",
  /** Uniswap V2 style: getPair(tokenA, tokenB), getReserves() for state */
  V2Standard = "v2",
  /** Solidly V2 style: getPool(tokenA, tokenB, stable) — queries both volatile and stable pools */
  SolidlyV2 = "solidly-v2",
  /** Curve registry: find_pool_for_coins(from, to) */
  CurveRegistry = "curve-registry",
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
}

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
