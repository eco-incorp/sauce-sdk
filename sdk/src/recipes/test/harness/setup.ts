/**
 * Local on-chain stack deployment for the EcoSwap EVM tests.
 *
 * Deploys, against a fresh anvil (NO fork):
 *   - the engine: Router (impl) then SauceRouter(routerImpl) proxy — cook() entrypoint
 *   - two MintableERC20 tokens (token0/token1 by address ordering)
 *   - a real UniswapV3Factory
 *   - V3 pools (createPool + initialize) and a V3LiquidityHelper to mint positions
 *
 * Pools are CREATE2-deployed by the real factory; we never deploy a pool
 * directly. The Router's V3 callback authenticates the pool purely via
 * transient-storage (expectedPool), so locally-deployed pools work without any
 * factory/CREATE2 verification (see Router.sol _handleV3Callback).
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  parseAbi,
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";

import { existsSync } from "node:fs";

import { loadArtifact, loadDeployedBytecode, normalizeBytecode } from "./artifacts";
import { deployContract, deployCreationCode, writeAndWait } from "./deploy";
import {
  MULTICALL3,
  UNISWAP_V4_POOL_MANAGER,
  UNISWAP_V4_STATE_VIEW,
  BALANCER_V2_VAULT,
} from "../../shared/constants";
import { keccak256, encodeAbiParameters } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
// harness/ → test/ → recipes/ → src/ : sdk/src holds artifacts + the recipe/test tree.
const SRC_ROOT = join(__dirname, "..", "..", "..");
// sdk/ holds node_modules (the @uniswap/@pancakeswap fixture-artifact deps).
const SDK_ROOT = join(SRC_ROOT, "..");
const ARTIFACTS = join(SRC_ROOT, "artifacts");
const FIXTURES = join(SRC_ROOT, "recipes", "test", "fixtures", "out");
const UNISWAP = join(
  SDK_ROOT,
  "node_modules",
  "@uniswap",
  "v3-core",
  "artifacts",
  "contracts",
);

// ── Loaded artifacts ─────────────────────────────────────────
export const routerArtifact = loadArtifact(join(ARTIFACTS, "Router.json"));
export const sauceRouterArtifact = loadArtifact(join(ARTIFACTS, "SauceRouter.json"));
export const erc20Artifact = loadArtifact(
  join(FIXTURES, "MintableERC20.sol", "MintableERC20.json"),
);
/** MintableERC20 + a `burn(uint256)`/`burn(address,uint256)` surface (returns bool). Used to repoint a Mento
 *  STABLE token (cUSD): the Broker's transferIn for a stable tokenIn does `transferFrom(sender, broker)` then
 *  `IBurnableERC20(token).burn(amount)` (expecting a `true` return) — a plain MintableERC20 has no burn, so
 *  swapIn reverts. This carries EXACTLY that surface; the token ERC20 semantics are not part of Mento pricing. */
export const mintableBurnableErc20Artifact = loadArtifact(
  join(FIXTURES, "MintableBurnableERC20.sol", "MintableBurnableERC20.json"),
);
export const helperArtifact = loadArtifact(
  join(FIXTURES, "V3LiquidityHelper.sol", "V3LiquidityHelper.json"),
);
export const v2FactoryArtifact = loadArtifact(
  join(FIXTURES, "V2Factory.sol", "V2Factory.json"),
);
/** Solidly-family factory shim (getPool(a,b,bool)/getFee(pool,bool) registry) — deployed normally.
 *  EcoSwap discovers Solidly VOLATILE (vAMM) pools off-chain via getPool(a,b,false). */
export const solidlyFactoryArtifact = loadArtifact(
  join(FIXTURES, "SolidlyFactory.sol", "SolidlyFactory.json"),
);
/** Slipstream CLFactory shim (getPool(a,b,int24) registry) — deployed normally; discovery/lens
 *  resolve tickSpacing-keyed. It points at a REAL @uniswap/v3-core pool (Slipstream is V3-shaped). */
export const slipstreamFactoryArtifact = loadArtifact(
  join(FIXTURES, "SlipstreamCLFactory.sol", "SlipstreamCLFactory.json"),
);
/** Runtime bytecode of the V2 pair — etched at a chosen address (no constructor). */
export const v2PairRuntime = loadDeployedBytecode(
  join(FIXTURES, "V2Pair.sol", "V2Pair.json"),
);
/** KyberSwap Classic factory (getPools registry) — deployed normally. */
export const kyberFactoryArtifact = loadArtifact(
  join(FIXTURES, "KyberClassicPool.sol", "KyberClassicFactory.json"),
);
/** Runtime bytecode of the Kyber Classic pool — etched at a chosen address (no constructor). */
export const kyberPoolRuntime = loadDeployedBytecode(
  join(FIXTURES, "KyberClassicPool.sol", "KyberClassicPool.json"),
);
/** Curve StableSwap plain-pool — deployed normally (constructor sets coins/balances/rates/A/fee). */
export const curveStableSwapArtifact = loadArtifact(
  join(FIXTURES, "CurveStableSwap.sol", "CurveStableSwap.json"),
);
/** DODO V2 PMM pool — deployed normally (constructor sets base/quote + i/K/B/Q/B0/Q0 + fees). */
export const dodoV2PoolArtifact = loadArtifact(
  join(FIXTURES, "DodoV2Pool.sol", "DodoV2Pool.json"),
);
/** Curve CryptoSwap (twocrypto/tricrypto-ng volatile-asset) 2-coin pool — deployed normally (constructor
 *  sets coins/precisions/A/gamma/price_scale/balances/fee params + computes D). */
export const cryptoSwapPoolArtifact = loadArtifact(
  join(FIXTURES, "CryptoSwapPool.sol", "CryptoSwapPool.json"),
);
/** Solidly STABLE (sAMM) pool — deployed normally (constructor sets tokens/decimals/fee). */
export const solidlyStablePoolArtifact = loadArtifact(
  join(FIXTURES, "SolidlyStablePool.sol", "SolidlyStablePool.json"),
);
/** Wombat (single-sided stableswap) pool — deployed normally (constructor sets tokens/decimals/
 *  cash/liability/amp/haircut). */
export const wombatPoolArtifact = loadArtifact(
  join(FIXTURES, "WombatPool.sol", "WombatPool.json"),
);
/** WOOFi (WooPPV2 sPMM) pool — deployed normally (constructor sets base/quote/decimals + a built-in
 *  settable WooracleV2 state price/spread/coeff + feeRate). */
export const wooFiPoolArtifact = loadArtifact(
  join(FIXTURES, "WooFiPool.sol", "WooFiPool.json"),
);
/** Fluid DEX (Instadapp FluidDexT1 — Liquidity-Layer-backed re-centering AMM) pool + resolver — deployed
 * normally (constructor sets token0/token1 + the layer exchange rates / center price / fee). */
export const fluidDexPoolArtifact = loadArtifact(
  join(FIXTURES, "FluidDexPool.sol", "FluidDexPool.json"),
);
export const fluidDexResolverArtifact = loadArtifact(
  join(FIXTURES, "FluidDexPool.sol", "FluidDexResolver.json"),
);
/** Balancer V3 (balancer-v3-monorepo — Vault singleton + per-chain Router) pool + Router + Permit2 — the
 *  Router holds the pool reserves (the fixture's "Vault") and pulls the input through Permit2, exactly the
 *  callback-free on-chain flow the recipe hits. */
export const balancerV3PoolArtifact = loadArtifact(
  join(FIXTURES, "BalancerV3.sol", "BalancerV3Pool.json"),
);
export const balancerV3RouterArtifact = loadArtifact(
  join(FIXTURES, "BalancerV3.sol", "BalancerV3Router.json"),
);
export const permit2Artifact = loadArtifact(
  join(FIXTURES, "BalancerV3.sol", "Permit2.json"),
);
/** Runtime bytecode of the Permit2 fixture — ETCHED at the canonical Permit2 address (the solver hardcodes
 *  0x0000…78BA3, so the fixture Permit2 must sit there). No constructor / immutables ⇒ etch is exact. */
export const permit2Runtime = loadDeployedBytecode(
  join(FIXTURES, "BalancerV3.sol", "Permit2.json"),
);
/** Fermi / propAMM (Obric-style proactive AMM) pool — deployed normally (constructor sets tokenX/tokenY +
 *  the settable derived curve state K/base + feePpm). */
export const fermiPoolArtifact = loadArtifact(
  join(FIXTURES, "FermiPool.sol", "FermiPool.json"),
);
/** Tessera V (Wintermute TesseraSwap wrapper — treasury-funded prop-AMM) — deployed normally (constructor
 *  sets tokenX/tokenY + the settable private curve state K/base + feePpm + the prio-fee knob). */
export const tesseraSwapArtifact = loadArtifact(
  join(FIXTURES, "TesseraSwap.sol", "TesseraSwap.json"),
);
/** ElfomoFi (vault-funded PMM + pricing module) — deployed normally (constructor sets tokenX/tokenY + the
 *  settable private pricing state K/base + feePpm; oracle staleness settable post-deploy). */
export const elfomoFiArtifact = loadArtifact(
  join(FIXTURES, "ElfomoFi.sol", "ElfomoFi.json"),
);
/** Mento V2 (Celo Broker + BiPoolManager) — the Broker is the swap entry; the BiPoolManager is the
 *  ENUMERABLE exchange provider (getExchanges). Both deployed normally; the Broker holds token reserves. */
export const mentoBrokerArtifact = loadArtifact(
  join(FIXTURES, "MentoBroker.sol", "MentoBroker.json"),
);
export const mentoBiPoolManagerArtifact = loadArtifact(
  join(FIXTURES, "MentoBroker.sol", "MentoBiPoolManager.json"),
);
/** Trader Joe LB pair — deployed normally (constructor sets tokens/binStep/baseFactor/activeId). */
export const traderJoeLBPairArtifact = loadArtifact(
  join(FIXTURES, "TraderJoeLBPair.sol", "TraderJoeLBPair.json"),
);
/** EulerSwap (Euler vault-backed AMM, v1+v2) pool — deployed normally (constructor sets tokens/reserves/
 *  curve params/fee/vault output caps). */
export const eulerSwapPoolArtifact = loadArtifact(
  join(FIXTURES, "EulerSwapPool.sol", "EulerSwapPool.json"),
);
/** Maverick V2 (bin-based directional AMM) pool — deployed normally (constructor sets tokens/tickSpacing/
 *  directional fees/protocolFee), then seeded per-tick + active tick / pool sqrt price. */
export const maverickV2PoolArtifact = loadArtifact(
  join(FIXTURES, "MaverickV2Pool.sol", "MaverickV2Pool.json"),
);
/** PAIR-AWARE Curve MetaRegistry mock (find_pool_for_coins / get_coin_indices / get_n_coins keyed by
 *  unordered pair; unregistered pair → address(0)) — the production FactoryType.CurveRegistry discovery
 *  surface for multi-edge route tests (the etch shim answers every pair with one pool — single-pair only). */
export const curveRegistryMockArtifact = loadArtifact(
  join(FIXTURES, "DiscoveryRegistryMocks.sol", "CurveRegistryMock.json"),
);
/** PAIR-AWARE Maverick V2 factory mock (lookup(a,b,start,end) keyed by unordered pair; unregistered
 *  pair → empty page) — the production FactoryType.MaverickV2Factory discovery surface for route tests. */
export const maverickFactoryMockArtifact = loadArtifact(
  join(FIXTURES, "DiscoveryRegistryMocks.sol", "MaverickFactoryMock.json"),
);
export const v4HelperArtifact = loadArtifact(
  join(FIXTURES, "V4LiquidityHelper.sol", "V4LiquidityHelper.json"),
);
/** Balancer V2 ComposableStable pool — deployed normally (constructor sets tokens/scaling/bpt/amp/fee). */
export const balancerStablePoolArtifact = loadArtifact(
  join(FIXTURES, "BalancerComposableStable.sol", "BalancerComposableStable.json"),
);
/** Balancer V2 Vault runtime — ETCHED at the canonical 0xBA12… (the engine hardcodes that address). */
export const balancerVaultRuntime = loadDeployedBytecode(
  join(FIXTURES, "BalancerComposableStable.sol", "BalancerVault.json"),
);
/** Algebra-fork (Camelot/QuickSwap V3) pool ADAPTER — wraps a genuine V3 pool, exposes the
 *  Algebra read surface + algebraSwapCallback re-entry. Deployed normally (init binds the inner). */
export const algebraPoolArtifact = loadArtifact(
  join(FIXTURES, "AlgebraPool.sol", "AlgebraPool.json"),
);
/** Algebra factory (poolByPair registry) — deployed normally; discovery/lens resolve via poolByPair. */
export const algebraFactoryArtifact = loadArtifact(
  join(FIXTURES, "AlgebraPool.sol", "AlgebraFactory.json"),
);
/** Captured Base mainnet runtime for the V4 PoolManager + StateView singletons. */
const V4_BYTECODE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "snapshots", "v4-bytecode.json"), "utf-8"),
) as {
  poolManager: { address: Hex; runtime: Hex };
  stateView: { address: Hex; runtime: Hex };
};
export const v3FactoryArtifact = loadArtifact(
  join(UNISWAP, "UniswapV3Factory.sol", "UniswapV3Factory.json"),
);
export const v3PoolArtifact = loadArtifact(
  join(UNISWAP, "UniswapV3Pool.sol", "UniswapV3Pool.json"),
);

// PancakeSwap V3: the npm package ships the pool's prebuilt CREATION bytecode (but
// not the concrete deployer source). Deploying THIS bytecode yields a genuine
// Pancake pool that calls pancakeV3SwapCallback / pancakeV3MintCallback — exercising
// the engine's Pancake callback path, not Uniswap's. Our PancakeV3Deployer fixture
// CREATEs it (stamping local tokens via parameters()) and doubles as a getPool registry.
const PANCAKE = join(
  SDK_ROOT, "node_modules", "@pancakeswap", "v3-core", "artifacts", "contracts",
);
export const pancakeDeployerArtifact = loadArtifact(
  join(FIXTURES, "PancakeV3Deployer.sol", "PancakeV3Deployer.json"),
);
/** Genuine PancakeV3Pool creation bytecode (ctor reads immutables from its deployer). */
export const pancakeV3PoolCreationCode = loadArtifact(
  join(PANCAKE, "PancakeV3Pool.sol", "PancakeV3Pool.json"),
).bytecode;

// ── v12 engine artifacts (synced by sync-artifacts.js from the feat/v12-kitchen
// engine). These are absent on an older engine, so they are loaded lazily and the
// v12 dual-engine path skips when any is missing — see V12_AVAILABLE / deployV12Stack.
const V12_KITCHEN_PATH = join(ARTIFACTS, "V12Kitchen.json");
const V12_POT_PATH = join(ARTIFACTS, "V12Pot.json");
const V12_RUNTIME_PATH = join(ARTIFACTS, "V12RuntimeBytecode.json");

/** True when all three v12 artifacts are present (engine pinned to feat/v12-kitchen + synced). */
export const V12_AVAILABLE =
  existsSync(V12_KITCHEN_PATH) && existsSync(V12_POT_PATH) && existsSync(V12_RUNTIME_PATH);

// ── Minimal ABIs for reads ───────────────────────────────────
export const erc20Abi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const v3FactoryAbi = parseAbi([
  "function createPool(address tokenA, address tokenB, uint24 fee) returns (address pool)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  "function enableFeeAmount(uint24 fee, int24 tickSpacing)",
  "function feeAmountTickSpacing(uint24 fee) view returns (int24)",
]);

export const v3PoolAbi = parseAbi([
  "function initialize(uint160 sqrtPriceX96)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function fee() view returns (uint24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
]);

export const helperAbi = parseAbi([
  "function mint(address pool, address recipient, int24 tickLower, int24 tickUpper, uint128 amount) returns (uint256 amount0, uint256 amount1)",
  "function batchMint(address pool, address recipient, int24[] tickLowers, int24[] tickUppers, uint128[] amounts)",
]);

export const v2FactoryAbi = parseAbi([
  "function setPair(address tokenA, address tokenB, address pair)",
  "function getPair(address tokenA, address tokenB) view returns (address)",
]);

export const pancakeDeployerAbi = parseAbi([
  "function createPool(bytes creationCode, address tokenA, address tokenB, uint24 fee, int24 tickSpacing) returns (address pool)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

// Slipstream CLFactory shim: getPool keyed by int24 tickSpacing (NOT uint24 fee) — the ONE way a
// Slipstream CLFactory differs from a Uniswap V3 factory. `setPool` records both token orderings.
export const slipstreamFactoryAbi = parseAbi([
  "function setPool(address tokenA, address tokenB, int24 tickSpacing, address pool)",
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)",
]);

export const v2PairAbi = parseAbi([
  "function initialize(address t0, address t1)",
  "function initializeWithFee(address t0, address t1, uint256 fee)",
  "function sync()",
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);

export const kyberFactoryAbi = parseAbi([
  "function addPool(address tokenA, address tokenB, address pool)",
  "function getPools(address tokenA, address tokenB) view returns (address[])",
]);

export const kyberPoolAbi = parseAbi([
  "function initialize(address t0, address t1, uint256 feeInPrec, uint256 vBoost0, uint256 vBoost1)",
  "function sync()",
  "function token0() view returns (address)",
  "function getTradeInfo() view returns (uint256 reserve0, uint256 reserve1, uint256 vReserve0, uint256 vReserve1, uint256 feeInPrecision)",
]);

export const algebraFactoryAbi = parseAbi([
  "function setPool(address tokenA, address tokenB, address pool)",
  "function poolByPair(address tokenA, address tokenB) view returns (address pool)",
]);

export const algebraPoolAbi = parseAbi([
  "function initialize(address innerPool, uint16 dynFeeZto, uint16 dynFeeOtz)",
  "function inner() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function globalState() view returns (uint160 price, int24 tick, uint16 feeZto, uint16 feeOtz, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function ticks(int24 tick) view returns (uint128 liquidityTotal, int128 liquidityDelta, uint256 outerFeeGrowth0Token, uint256 outerFeeGrowth1Token, int56 outerTickCumulative, uint160 outerSecondsPerLiquidity, uint32 outerSecondsSpent, bool initialized)",
]);

export const v4HelperAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function initialize(PoolKey key, uint160 sqrtPriceX96) returns (int24)",
  "function addLiquidity(PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity)",
  "function batchAddLiquidity(PoolKey key, int24[] tickLowers, int24[] tickUppers, uint128[] liquidities)",
]);

export const v4StateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);

export const v12KitchenAbi = parseAbi([
  "function deployPot(bytes32 salt) returns (address pot)",
  "function predictPot(address owner, bytes32 salt) view returns (address)",
]);

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Hex;

/** V4 poolId = keccak256(abi.encode(PoolKey)). Mirrors discovery's computeV4PoolId. */
export function computeV4PoolId(
  currency0: Hex,
  currency1: Hex,
  fee: number,
  tickSpacing: number,
  hooks: Hex = ZERO_ADDR,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, fee, tickSpacing, hooks],
    ),
  );
}

// 2^96 — sqrtPriceX96 for a 1:1 price (tick 0).
export const SQRT_PRICE_1_1 = 79228162514264337593543950336n;

export interface DeployedStack {
  routerImpl: Hex;
  sauceRouter: Hex;
  factory: Hex;
  helper: Hex;
}

/**
 * Ensure Multicall3 is present at the canonical address. discoverPools relies
 * on it heavily. This anvil 1.5.1 build does NOT pre-deploy it, so if the slot
 * is empty we etch our locally-compiled Multicall3 runtime (aggregate3 — the
 * method viem's client.multicall uses). A testClient is required for the etch.
 */
export async function ensureMulticall3(
  publicClient: PublicClient,
  testClient: { setCode: (a: { address: Hex; bytecode: Hex }) => Promise<void> },
): Promise<void> {
  const code = await publicClient.getCode({ address: MULTICALL3 });
  if (code && code !== "0x") return;

  const solc = JSON.parse(
    readFileSync(join(__dirname, "Multicall3.solc.json"), "utf-8"),
  ) as { contracts: Record<string, { "bin-runtime": string }> };
  const runtime = solc.contracts["Multicall3.sol:Multicall3"]["bin-runtime"];
  await testClient.setCode({ address: MULTICALL3, bytecode: ("0x" + runtime) as Hex });

  const after = await publicClient.getCode({ address: MULTICALL3 });
  if (!after || after === "0x") {
    throw new Error("failed to etch Multicall3 at canonical address");
  }
}


/** Deploy Router (impl) then SauceRouter(impl), the factory, and the helper. */
export async function deployStack(
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<DeployedStack> {
  const routerImpl = await deployContract(walletClient, publicClient, {
    abi: routerArtifact.abi,
    bytecode: routerArtifact.bytecode,
  });
  const sauceRouter = await deployContract(walletClient, publicClient, {
    abi: sauceRouterArtifact.abi,
    bytecode: sauceRouterArtifact.bytecode,
    args: [routerImpl],
  });
  const factory = await deployContract(walletClient, publicClient, {
    abi: v3FactoryArtifact.abi,
    bytecode: v3FactoryArtifact.bytecode,
  });
  const helper = await deployContract(walletClient, publicClient, {
    abi: helperArtifact.abi,
    bytecode: helperArtifact.bytecode,
  });
  return { routerImpl, sauceRouter, factory, helper };
}

export interface DeployedV12Stack {
  routerImpl: Hex;
  sauceRouter: Hex;
  v12Runtime: Hex;
  kitchen: Hex;
  /** Owner's V12Pot — the v12 cook() entrypoint (the v12 analogue of sauceRouter). */
  pot: Hex;
}

/**
 * Deploy the v12 engine stack and the owner's V12Pot, mirroring the engine's
 * V12KitchenSwap.t.sol wiring:
 *   Router (impl) → SauceRouter(impl) → V12Kitchen(v12Runtime, sauceRouter)
 *   → kitchen.deployPot(salt) as `owner`.
 *
 * The Pot is the cook() entrypoint: its `cook(bytes[])` delegatecalls the raw v12
 * program (ingredients[0]) into the Huff runtime, while its fallback delegatecalls
 * the SauceRouter for swap self-calls / pool callbacks — all in the Pot's context.
 *
 * `owner` MUST be the account that will call cook() (the Pot's cook is owner-gated)
 * and is also the recipe `caller`: the program does transferFrom(caller, self, …),
 * so the owner approves the POT (not the SauceRouter) for tokenIn. Requires
 * V12_AVAILABLE (throws otherwise — callers should gate on it / skip).
 */
export async function deployV12Stack(
  walletClient: WalletClient,
  publicClient: PublicClient,
  owner: Account,
  salt: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000",
): Promise<DeployedV12Stack> {
  if (!V12_AVAILABLE) {
    throw new Error(
      "v12 artifacts missing (V12Kitchen/V12Pot/V12RuntimeBytecode) — pin the engine to " +
        "feat/v12-kitchen and run `pnpm --filter ./dev-tools sync-artifacts`",
    );
  }
  const kitchenArtifact = loadArtifact(V12_KITCHEN_PATH);
  const runtimeCreationCode = normalizeBytecode(
    (JSON.parse(readFileSync(V12_RUNTIME_PATH, "utf-8")) as { runtimeCreationCode: string })
      .runtimeCreationCode,
  );

  // Router impl + SauceRouter proxy (the swap surface the Pot fallback reaches).
  const routerImpl = await deployContract(walletClient, publicClient, {
    abi: routerArtifact.abi,
    bytecode: routerArtifact.bytecode,
  });
  const sauceRouter = await deployContract(walletClient, publicClient, {
    abi: sauceRouterArtifact.abi,
    bytecode: sauceRouterArtifact.bytecode,
    args: [routerImpl],
  });

  // v12 Huff runtime (raw creation code, no ABI) then the Kitchen factory.
  const v12Runtime = await deployCreationCode(walletClient, publicClient, runtimeCreationCode);
  const kitchen = await deployContract(walletClient, publicClient, {
    abi: kitchenArtifact.abi,
    bytecode: kitchenArtifact.bytecode,
    args: [v12Runtime, sauceRouter],
  });

  // Deploy the owner's Pot AS the owner (deployPot bakes in msg.sender as owner),
  // then read it back via predictPot (deployPot's return value isn't available
  // off a tx receipt).
  await writeAndWait(walletClient, publicClient, {
    address: kitchen,
    abi: v12KitchenAbi as Abi,
    functionName: "deployPot",
    args: [salt],
    account: owner,
  });
  const pot = (await publicClient.readContract({
    address: kitchen,
    abi: v12KitchenAbi as Abi,
    functionName: "predictPot",
    args: [owner.address, salt],
  })) as Hex;
  const code = await publicClient.getCode({ address: pot });
  if (!code || code === "0x") throw new Error("V12Pot was not deployed at the predicted address");

  return { routerImpl, sauceRouter, v12Runtime, kitchen, pot };
}

/** Deploy a MintableERC20. */
export async function deployToken(
  walletClient: WalletClient,
  publicClient: PublicClient,
  name: string,
  symbol: string,
  decimals = 18,
): Promise<Hex> {
  return deployContract(walletClient, publicClient, {
    abi: erc20Artifact.abi,
    bytecode: erc20Artifact.bytecode,
    args: [name, symbol, decimals],
  });
}

/** Deploy a MintableBurnableERC20 (mint + burn(uint256)/burn(address,uint256) → bool). */
export async function deployBurnableToken(
  walletClient: WalletClient,
  publicClient: PublicClient,
  name: string,
  symbol: string,
  decimals = 18,
): Promise<Hex> {
  return deployContract(walletClient, publicClient, {
    abi: mintableBurnableErc20Artifact.abi,
    bytecode: mintableBurnableErc20Artifact.bytecode,
    args: [name, symbol, decimals],
  });
}

/** Deploy two tokens and return them sorted so token0 < token1 numerically. */
export async function deploySortedTokens(
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<{ token0: Hex; token1: Hex }> {
  const a = await deployToken(walletClient, publicClient, "TokenA", "TKA");
  const b = await deployToken(walletClient, publicClient, "TokenB", "TKB");
  const [token0, token1] =
    BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { token0, token1 };
}

export async function mint(
  walletClient: WalletClient,
  publicClient: PublicClient,
  token: Hex,
  to: Hex,
  amount: bigint,
): Promise<void> {
  await writeAndWait(walletClient, publicClient, {
    address: token,
    abi: erc20Abi as Abi,
    functionName: "mint",
    args: [to, amount],
  });
}

export async function approve(
  walletClient: WalletClient,
  publicClient: PublicClient,
  token: Hex,
  spender: Hex,
  amount: bigint,
  account?: Account,
): Promise<void> {
  await writeAndWait(walletClient, publicClient, {
    address: token,
    abi: erc20Abi as Abi,
    functionName: "approve",
    args: [spender, amount],
    account,
  });
}

export async function balanceOf(
  publicClient: PublicClient,
  token: Hex,
  who: Hex,
): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi as Abi,
    functionName: "balanceOf",
    args: [who],
  }) as Promise<bigint>;
}

/**
 * Create a V3 pool and initialize it. Returns the pool address read back from
 * the factory (createPool's return value is not directly available off a tx).
 */
export async function createAndInitPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  factory: Hex,
  token0: Hex,
  token1: Hex,
  fee: number,
  sqrtPriceX96: bigint,
): Promise<Hex> {
  await writeAndWait(walletClient, publicClient, {
    address: factory,
    abi: v3FactoryAbi as Abi,
    functionName: "createPool",
    args: [token0, token1, fee],
  });
  const pool = (await publicClient.readContract({
    address: factory,
    abi: v3FactoryAbi as Abi,
    functionName: "getPool",
    args: [token0, token1, fee],
  })) as Hex;
  if (!pool || BigInt(pool) === 0n) throw new Error("createPool returned zero address");
  await writeAndWait(walletClient, publicClient, {
    address: pool,
    abi: v3PoolAbi as Abi,
    functionName: "initialize",
    args: [sqrtPriceX96],
  });
  return pool;
}

/**
 * Mint a concentrated-liquidity position into `pool` via the V3LiquidityHelper.
 *
 * The helper encodes msg.sender as payer; the mint callback pulls owed token0
 * and token1 via transferFrom(payer, pool, owed). So `minter` MUST hold both
 * tokens AND have approved the helper for both. This routine assumes those
 * approvals/balances are in place (call fundAndApproveHelper first).
 */
export async function mintPosition(
  walletClient: WalletClient,
  publicClient: PublicClient,
  helper: Hex,
  pool: Hex,
  recipient: Hex,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  minter?: Account,
): Promise<void> {
  await writeAndWait(walletClient, publicClient, {
    address: helper,
    abi: helperAbi as Abi,
    functionName: "mint",
    args: [pool, recipient, tickLower, tickUpper, liquidity],
    account: minter,
  });
}

/**
 * Mint MANY positions in a handful of transactions via the helper's `batchMint`
 * (which pays from its OWN balance), instead of one tx per position. Funds the
 * helper with `fundAmount` of each token, then submits the positions in gas-sized
 * chunks. This collapses a prod-pool reconstruction (hundreds of boundaries) from
 * ~N sequential mint txs to ~N/chunkSize — turning a ~10-min reconstruction into
 * seconds. `positions` are [tickLower, tickUpper, liquidity]; zero-liquidity
 * entries are skipped on-chain.
 */
export async function batchMintPositions(
  walletClient: WalletClient,
  publicClient: PublicClient,
  helper: Hex,
  pool: Hex,
  recipient: Hex,
  token0: Hex,
  token1: Hex,
  fundAmount: bigint,
  positions: [number, number, bigint][],
  chunkSize = 100,
  minter?: Account,
): Promise<void> {
  // batchMint pays owed amounts from the helper's own balance — fund it directly.
  await mint(walletClient, publicClient, token0, helper, fundAmount);
  await mint(walletClient, publicClient, token1, helper, fundAmount);

  for (let i = 0; i < positions.length; i += chunkSize) {
    const chunk = positions.slice(i, i + chunkSize);
    await writeAndWait(walletClient, publicClient, {
      address: helper,
      abi: helperAbi as Abi,
      functionName: "batchMint",
      args: [
        pool,
        recipient,
        chunk.map((p) => p[0]),
        chunk.map((p) => p[1]),
        chunk.map((p) => p[2]),
      ],
      account: minter,
    });
  }
}

export async function getSlot0(
  publicClient: PublicClient,
  pool: Hex,
): Promise<{ sqrtPriceX96: bigint; tick: number }> {
  const r = (await publicClient.readContract({
    address: pool,
    abi: v3PoolAbi as Abi,
    functionName: "slot0",
  })) as readonly [bigint, number, ...unknown[]];
  return { sqrtPriceX96: r[0], tick: Number(r[1]) };
}

/** Deploy the local Pancake V3 deployer/factory shim (CREATEs genuine pancake pools). */
export async function deployPancakeDeployer(
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<Hex> {
  return deployContract(walletClient, publicClient, {
    abi: pancakeDeployerArtifact.abi,
    bytecode: pancakeDeployerArtifact.bytecode,
  });
}

/**
 * Create + initialise a GENUINE PancakeV3 pool via the deployer shim, then read it
 * back from the shim's getPool registry. Mirrors createAndInitPool but stamps out
 * real Pancake pool bytecode (→ pancakeV3SwapCallback). token0/token1 should be
 * sorted; the shim sorts internally and registers both orderings.
 */
export async function createAndInitPancakePool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  deployer: Hex,
  token0: Hex,
  token1: Hex,
  fee: number,
  tickSpacing: number,
  sqrtPriceX96: bigint,
): Promise<Hex> {
  await writeAndWait(walletClient, publicClient, {
    address: deployer,
    abi: pancakeDeployerAbi as Abi,
    functionName: "createPool",
    args: [pancakeV3PoolCreationCode, token0, token1, fee, tickSpacing],
  });
  const pool = (await publicClient.readContract({
    address: deployer,
    abi: pancakeDeployerAbi as Abi,
    functionName: "getPool",
    args: [token0, token1, fee],
  })) as Hex;
  if (!pool || BigInt(pool) === 0n) throw new Error("pancake createPool returned zero address");
  await writeAndWait(walletClient, publicClient, {
    address: pool,
    abi: v3PoolAbi as Abi,
    functionName: "initialize",
    args: [sqrtPriceX96],
  });
  return pool;
}

/** Deploy the Slipstream CLFactory shim (discovery resolves CL pools via getPool(a,b,int24 ts)). */
export async function deploySlipstreamFactory(
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<Hex> {
  return deployContract(walletClient, publicClient, {
    abi: slipstreamFactoryArtifact.abi,
    bytecode: slipstreamFactoryArtifact.bytecode,
  });
}

/**
 * Build a Slipstream CL pool for the local EVM tests. A Slipstream pool is V3-compatible for
 * pricing AND execution, so the faithful minimal fixture creates a REAL @uniswap/v3-core pool via
 * the standard V3 factory (`createAndInitPool`) — which already exposes fee()/tickSpacing()/slot0()/
 * ticks() and calls uniswapV3SwapCallback — and registers it in the Slipstream shim under its
 * TICK SPACING (the ONE thing that differs from Uniswap V3 is discovery). The pool's fee() is thus
 * the V3 fee tier passed here, which the discovery/lens path READS from fee() (Slipstream decouples
 * fee from tickSpacing, so the fee is not assumed from the key). Returns the pool address; callers
 * mint liquidity into it exactly as they do a plain V3 pool (via `mintPosition`/`batchMintPositions`).
 *
 * `tickSpacing` is the Slipstream CLFactory DISCOVERY KEY only — the int24 `getPool(a, b, ts)` is
 * keyed on it. It is INDEPENDENT of the underlying real V3 pool's grid: the standard V3 factory
 * derives that grid from `fee` alone (feeAmountTickSpacing(fee): 500→10, 3000→60, 10000→200), NOT
 * from this key. Callers must ensure the mint bounds are divisible by the REAL grid
 * (feeAmountTickSpacing(fee)), NOT by this key — this decoupling of the discovery key from the grid
 * is exactly Slipstream's fee/tickSpacing model (production `getPool(a, b, ts)` returns a pool whose
 * `tickSpacing() == ts`, so in production the key IS the grid; only the FEE is decoupled). The
 * discovery config's `slipstreamTickSpacings` must include this key. For maximum fidelity, pass a key
 * that equals the pool's real grid (e.g. fee 500 → key 10) so the fixture never masks a divergence.
 */
export async function createAndRegisterSlipstreamPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  v3Factory: Hex,
  slipstreamFactory: Hex,
  token0: Hex,
  token1: Hex,
  fee: number,
  tickSpacing: number,
  sqrtPriceX96: bigint,
): Promise<Hex> {
  // The pool itself is a genuine Uniswap V3 pool (created + initialized via the real V3 factory).
  const pool = await createAndInitPool(
    walletClient, publicClient, v3Factory, token0, token1, fee, sqrtPriceX96,
  );
  // Register it in the Slipstream shim under its tickSpacing (both orderings) so tickSpacing-keyed
  // discovery — getPool(a, b, int24 tickSpacing) — surfaces it exactly as production Slipstream does.
  await writeAndWait(walletClient, publicClient, {
    address: slipstreamFactory,
    abi: slipstreamFactoryAbi as Abi,
    functionName: "setPool",
    args: [token0, token1, tickSpacing, pool],
  });
  return pool;
}

/** Deploy the V2 registry factory (discovery resolves V2 pools via getPair). */
export async function deployV2Factory(
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<Hex> {
  return deployContract(walletClient, publicClient, {
    abi: v2FactoryArtifact.abi,
    bytecode: v2FactoryArtifact.bytecode,
  });
}

/** Solidly-family factory shim ABI (getPool(a,b,bool)/getFee(pool,bool) + setPool/setFee registry). */
export const solidlyFactoryShimAbi = parseAbi([
  "function setPool(address tokenA, address tokenB, bool stable, address pool)",
  "function setFee(address pool, uint256 fee)",
  "function getPool(address tokenA, address tokenB, bool stable) view returns (address)",
  "function getFee(address pool, bool stable) view returns (uint256)",
]);

/** Deploy the Solidly-family registry shim (discovery resolves vAMM pools via getPool(a,b,false)). */
export async function deploySolidlyFactory(
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<Hex> {
  return deployContract(walletClient, publicClient, {
    abi: solidlyFactoryArtifact.abi,
    bytecode: solidlyFactoryArtifact.bytecode,
  });
}

/**
 * Stand up a Solidly VOLATILE (vAMM) pool for the EVM tests: a plain xy=k V2Pair (stable()==false)
 * ETCHED at `pairAddr` at a per-pool fee, funded + synced, then registered on the Solidly shim under
 * getPool(token0,token1,false) with getFee(pool)=feeBps. The vAMM is discovered OFF-CHAIN by
 * discoverSolidlyVolatilePoolsTyped and appended to the DIRECT V2-family set (live getReserves seed +
 * the per-pool fee, executed via the callback-free V2 path). `feePpm` is the pool's real fee (the K
 * invariant + the callback-free exec use it); `feeBps` is what the factory getFee returns (ppm/100 for
 * Velodrome/Aerodrome — discovery normalises it back to ppm). Returns the etched pair address.
 */
export async function setupSolidlyVolatilePool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: { setCode: (a: { address: Hex; bytecode: Hex }) => Promise<void> },
  factory: Hex,
  pairAddr: Hex,
  token0: Hex,
  token1: Hex,
  reserve0: bigint,
  reserve1: bigint,
  feePpm: number,
  feeBps: number,
  minter?: Account,
): Promise<Hex> {
  await testClient.setCode({ address: pairAddr, bytecode: v2PairRuntime });
  const code = await publicClient.getCode({ address: pairAddr });
  if (!code || code === "0x") throw new Error("failed to etch V2Pair runtime (Solidly vAMM)");
  await writeAndWait(walletClient, publicClient, {
    address: pairAddr,
    abi: v2PairAbi as Abi,
    functionName: "initializeWithFee",
    args: [token0, token1, BigInt(feePpm)],
    account: minter,
  });
  // Fund both reserves then snapshot via sync().
  await writeAndWait(walletClient, publicClient, {
    address: token0, abi: erc20Abi as Abi, functionName: "transfer", args: [pairAddr, reserve0], account: minter,
  });
  await writeAndWait(walletClient, publicClient, {
    address: token1, abi: erc20Abi as Abi, functionName: "transfer", args: [pairAddr, reserve1], account: minter,
  });
  await writeAndWait(walletClient, publicClient, {
    address: pairAddr, abi: v2PairAbi as Abi, functionName: "sync", args: [], account: minter,
  });
  // Register on the Solidly shim: getPool(t0,t1,false) → pair, getFee(pair) → feeBps.
  await writeAndWait(walletClient, publicClient, {
    address: factory, abi: solidlyFactoryShimAbi as Abi, functionName: "setPool",
    args: [token0, token1, false, pairAddr], account: minter,
  });
  await writeAndWait(walletClient, publicClient, {
    address: factory, abi: solidlyFactoryShimAbi as Abi, functionName: "setFee",
    args: [pairAddr, BigInt(feeBps)], account: minter,
  });
  return pairAddr;
}

/** Minimal Curve StableSwap fixture ABI (coins/exchange/get_dy + state reads). */
export const curveAbi = parseAbi([
  "function coins(uint256 k) view returns (address)",
  "function nCoins() view returns (uint256)",
  "function balances(uint256 k) view returns (uint256)",
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
]);

/**
 * Deploy a local Curve StableSwap plain-pool and fund it with its coin balances.
 *
 * Mirrors the canonical StableSwap get_D/get_y/get_dy bit-for-bit (matching the off-chain
 * `curve-math.ts` replay), so `exchange(i,j,dx,0)` returns EXACTLY `getDy(pool, dx)` to the
 * wei. The engine `_swapCurve` resolves i/j via `coins(k)` and calls `exchange`. The pool
 * pulls coin i from the router and transfers coin j out (callback-free), so it must HOLD the
 * tokenOut-side balance — `minter` transfers each coin's full `balances[k]` into the pool.
 */
export async function deployCurveStableSwap(
  walletClient: WalletClient,
  publicClient: PublicClient,
  coins: Hex[],
  balances: bigint[],
  rates: bigint[],
  a: bigint,
  fee: bigint,
  minter?: Account,
): Promise<Hex> {
  const pool = await deployContract(walletClient, publicClient, {
    abi: curveStableSwapArtifact.abi,
    bytecode: curveStableSwapArtifact.bytecode,
    args: [coins, balances, rates, a, fee],
  });
  const acct = (minter ?? walletClient.account) as Account;
  // Fund the pool with its full coin balances (it transfers tokenOut out on exchange).
  for (let k = 0; k < coins.length; k++) {
    await writeAndWait(walletClient, publicClient, {
      address: coins[k],
      abi: erc20Abi as Abi,
      functionName: "transfer",
      args: [pool, balances[k]],
      account: acct,
    });
  }
  return pool;
}

/** Register/read surface of the pair-aware discovery mocks (DiscoveryRegistryMocks.sol). */
export const curveRegistryMockAbi = parseAbi([
  "function register(address a, address b, address pool)",
  "function find_pool_for_coins(address from, address to) view returns (address)",
  "function get_coin_indices(address pool, address from, address to) view returns (int128 i, int128 j, bool underlying)",
  "function get_n_coins(address pool) view returns (uint256)",
]);
export const maverickFactoryMockAbi = parseAbi([
  "function register(address tokenA, address tokenB, address pool)",
  "function lookup(address tokenA, address tokenB, uint256 startIndex, uint256 endIndex) view returns (address[] pools)",
]);

/**
 * Deploy a PAIR-AWARE Curve MetaRegistry mock and register each (a, b) → pool entry. The mock
 * answers the production FactoryType.CurveRegistry discovery surface with REAL pair semantics
 * (unregistered pair → address(0); get_coin_indices scans the pool's own coins(k) so one
 * multi-coin pool registered under several pairs orients per-edge) — required by multi-edge
 * route tests, where the single-pair etch shim would surface its one pool on EVERY edge.
 */
export async function deployCurveRegistryMock(
  walletClient: WalletClient,
  publicClient: PublicClient,
  entries: { a: Hex; b: Hex; pool: Hex }[],
): Promise<Hex> {
  const registry = await deployContract(walletClient, publicClient, {
    abi: curveRegistryMockArtifact.abi,
    bytecode: curveRegistryMockArtifact.bytecode,
    args: [],
  });
  for (const e of entries) {
    await writeAndWait(walletClient, publicClient, {
      address: registry,
      abi: curveRegistryMockAbi as Abi,
      functionName: "register",
      args: [e.a, e.b, e.pool],
    });
  }
  return registry;
}

/**
 * Deploy a PAIR-AWARE Maverick V2 factory mock and register each (tokenA, tokenB) → pool entry
 * (the lookup(a,b,start,end) discovery surface; unregistered pair → empty page).
 */
export async function deployMaverickFactoryMock(
  walletClient: WalletClient,
  publicClient: PublicClient,
  entries: { tokenA: Hex; tokenB: Hex; pool: Hex }[],
): Promise<Hex> {
  const factory = await deployContract(walletClient, publicClient, {
    abi: maverickFactoryMockArtifact.abi,
    bytecode: maverickFactoryMockArtifact.bytecode,
    args: [],
  });
  for (const e of entries) {
    await writeAndWait(walletClient, publicClient, {
      address: factory,
      abi: maverickFactoryMockAbi as Abi,
      functionName: "register",
      args: [e.tokenA, e.tokenB, e.pool],
    });
  }
  return factory;
}

/** Minimal Curve CryptoSwap fixture ABI (coins/get_dy/exchange(uint256,...) + state reads). */
export const cryptoSwapAbi = parseAbi([
  "function coins(uint256 i) view returns (address)",
  "function balances(uint256 i) view returns (uint256)",
  "function A() view returns (uint256)",
  "function gamma() view returns (uint256)",
  "function price_scale() view returns (uint256)",
  "function D() view returns (uint256)",
  "function mid_fee() view returns (uint256)",
  "function out_fee() view returns (uint256)",
  "function fee_gamma() view returns (uint256)",
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
  "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) returns (uint256)",
]);

/**
 * Deploy a local Curve CryptoSwap (twocrypto/tricrypto-ng volatile-asset) 2-coin pool and fund it with
 * its coin balances.
 *
 * Mirrors the deployed Twocrypto v2.1.0d family (stableswap-invariant get_y, post-swap-xp dynamic fee,
 * raw-product xp scaling) bit-for-bit — matching the off-chain `cryptoswap-math.ts` replay — so
 * `get_dy(i,j,dx)` returns EXACTLY `getDyCrypto(pool, dx)` to the wei and `exchange(i,j,dx,min_dy)`
 * sends that. CryptoSwap uses UINT256 coin indices, so EcoSwap
 * executes it CALLBACK-FREE (approve + exchange), NOT through the engine. Curve exchange PULLS coin i via
 * transferFrom and transfers coin j out, so the pool must HOLD both coin balances — `minter` transfers
 * each coin's full balance into the pool. `A` is ANN (already A_MULTIPLIER·N^N-scaled); `precisions[k]` =
 * 10**(18 - decimals[k]); `priceScale` scales coin1 into coin0.
 */
export async function deployCryptoSwapPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  coins: [Hex, Hex],
  precisions: [bigint, bigint],
  A: bigint,
  gamma: bigint,
  priceScale: bigint,
  balances: [bigint, bigint],
  midFee: bigint,
  outFee: bigint,
  feeGamma: bigint,
  minter?: Account,
): Promise<Hex> {
  const pool = await deployContract(walletClient, publicClient, {
    abi: cryptoSwapPoolArtifact.abi,
    bytecode: cryptoSwapPoolArtifact.bytecode,
    args: [coins, precisions, A, gamma, priceScale, balances, midFee, outFee, feeGamma],
  });
  const acct = (minter ?? walletClient.account) as Account;
  for (let k = 0; k < coins.length; k++) {
    await writeAndWait(walletClient, publicClient, {
      address: coins[k],
      abi: erc20Abi as Abi,
      functionName: "transfer",
      args: [pool, balances[k]],
      account: acct,
    });
  }
  return pool;
}

/** Minimal Balancer ComposableStable pool + Vault fixture ABI (reads + onSwap + register). */
export const balancerStablePoolAbi = parseAbi([
  "function getPoolId() view returns (bytes32)",
  "function getAmplificationParameter() view returns (uint256 value, bool isUpdating, uint256 precision)",
  "function getScalingFactors() view returns (uint256[] scalingFactors)",
  "function getSwapFeePercentage() view returns (uint256)",
  "function getBptIndex() view returns (uint256)",
  "function tokens() view returns (address[])",
  "function balances() view returns (uint256[])",
  "function setBalance(uint256 k, uint256 bal)",
  "function onSwapGivenIn(uint256 amountIn, address tokenIn, address tokenOut) view returns (uint256)",
]);

export const balancerVaultAbi = parseAbi([
  "function registerPool(bytes32 poolId, address pool)",
  "function poolAddress(bytes32 poolId) view returns (address)",
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)",
]);

/**
 * Stand up a local Balancer V2 ComposableStable pool + the canonical Vault for the engine
 * `_swapBalancerV2` path.
 *
 * Etches the BalancerVault runtime at the HARDCODED 0xBA12… address (the engine constant) on first call,
 * deploys a ComposableStable pool whose StableMath mirrors `balancer-stable-math.ts` bit-for-bit,
 * registers the pool on the Vault (poolId → pool), seeds the registered balances, and funds the VAULT
 * with both swap tokens (the Vault pays assetOut out of its own balance — like the real Vault holding
 * pooled assets). So `Vault.swap(SingleSwap{GIVEN_IN})` returns EXACTLY the off-chain `getDy(pool, dx)`
 * to the wei — the wei-exact-in-dy gate. The engine's `_swapBalancerV2` reads pool.getPoolId() then
 * calls the etched Vault.
 *
 * `tokens` includes the BPT at `bptIndex` (the pool's own address is the BPT); `scaling` is aligned
 * with `tokens` (BPT slot ignored). `bals` are the registered balances (BPT slot a sentinel). `vaultFund`
 * is the amount of each NON-BPT token transferred into the Vault so it can pay swaps. Returns the pool
 * address (the swap(SwapParams{poolType:4, pool}) target). Idempotent on the Vault etch.
 */
export async function deployBalancerComposableStable(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: { setCode: (a: { address: Hex; bytecode: Hex }) => Promise<void> },
  tokens: Hex[],
  scaling: bigint[],
  bptIndex: number,
  amp: bigint,
  swapFeeWad: bigint,
  bals: bigint[],
  vaultFund: bigint,
  minter?: Account,
): Promise<Hex> {
  // Etch the Vault at the canonical address (once — re-etching is harmless but skip if present).
  const existing = await publicClient.getCode({ address: BALANCER_V2_VAULT });
  if (!existing || existing === "0x") {
    await testClient.setCode({ address: BALANCER_V2_VAULT, bytecode: balancerVaultRuntime });
    const code = await publicClient.getCode({ address: BALANCER_V2_VAULT });
    if (!code || code === "0x") throw new Error("failed to etch BalancerVault at canonical address");
  }
  const acct = (minter ?? walletClient.account) as Account;

  const pool = await deployContract(walletClient, publicClient, {
    abi: balancerStablePoolArtifact.abi,
    bytecode: balancerStablePoolArtifact.bytecode,
    args: [tokens, scaling, BigInt(bptIndex), amp, swapFeeWad],
  });
  const poolId = (await publicClient.readContract({
    address: pool, abi: balancerStablePoolAbi as Abi, functionName: "getPoolId",
  })) as Hex;
  // Register the pool on the Vault.
  await writeAndWait(walletClient, publicClient, {
    address: BALANCER_V2_VAULT, abi: balancerVaultAbi as Abi, functionName: "registerPool",
    args: [poolId, pool], account: acct,
  });
  // Seed the registered balances.
  for (let k = 0; k < bals.length; k++) {
    await writeAndWait(walletClient, publicClient, {
      address: pool, abi: balancerStablePoolAbi as Abi, functionName: "setBalance",
      args: [BigInt(k), bals[k]], account: acct,
    });
  }
  // Fund the Vault with each NON-BPT token so it can pay swap outputs.
  for (let k = 0; k < tokens.length; k++) {
    if (k === bptIndex) continue;
    await writeAndWait(walletClient, publicClient, {
      address: tokens[k], abi: erc20Abi as Abi, functionName: "transfer",
      args: [BALANCER_V2_VAULT, vaultFund], account: acct,
    });
  }
  return pool;
}

export const dodoAbi = parseAbi([
  "function _BASE_TOKEN_() view returns (address)",
  "function _QUOTE_TOKEN_() view returns (address)",
  "function getPMMStateForCall() view returns (uint256 i, uint256 K, uint256 B, uint256 Q, uint256 B0, uint256 Q0, uint256 R)",
  "function querySellBase(address trader, uint256 payBase) view returns (uint256 receiveQuoteAmount, uint256 mtFee)",
  "function querySellQuote(address trader, uint256 payQuote) view returns (uint256 receiveBaseAmount, uint256 mtFee)",
  "function sellBase(address to) returns (uint256)",
  "function sellQuote(address to) returns (uint256)",
]);

/** Constructor args for a DODO V2 PMM pool fixture (mirrors the off-chain DodoPool state). */
export interface DodoDeployParams {
  base: Hex;
  quote: Hex;
  i: bigint;
  K: bigint;
  B: bigint;
  Q: bigint;
  B0: bigint;
  Q0: bigint;
  lpFeeRate: bigint;
  mtFeeRate: bigint;
}

/**
 * Deploy a local DODO V2 PMM pool and fund it with its base + quote reserves.
 *
 * Mirrors the canonical DODO PMMPricing/DODOMath/DecimalMath integer math bit-for-bit (matching
 * the off-chain `dodo-math.ts` replay), so `sellBase`/`sellQuote` send EXACTLY the off-chain
 * `getDy(pool, amountIn)` to the wei. The engine `_swapDODOV2` is transfer-first: it transfers
 * tokenIn to the pool then calls sellBase/sellQuote, so the pool must HOLD the reserve it pays out
 * — `minter` transfers B base + Q quote into the pool.
 */
export async function deployDodoV2Pool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  p: DodoDeployParams,
  minter?: Account,
): Promise<Hex> {
  const pool = await deployContract(walletClient, publicClient, {
    abi: dodoV2PoolArtifact.abi,
    bytecode: dodoV2PoolArtifact.bytecode,
    args: [p.base, p.quote, p.i, p.K, p.B, p.Q, p.B0, p.Q0, p.lpFeeRate, p.mtFeeRate],
  });
  const acct = (minter ?? walletClient.account) as Account;
  // Fund the pool with its base + quote reserves (it pays the opposite side out on a swap).
  await writeAndWait(walletClient, publicClient, {
    address: p.base,
    abi: erc20Abi as Abi,
    functionName: "transfer",
    args: [pool, p.B],
    account: acct,
  });
  await writeAndWait(walletClient, publicClient, {
    address: p.quote,
    abi: erc20Abi as Abi,
    functionName: "transfer",
    args: [pool, p.Q],
    account: acct,
  });
  return pool;
}

export const solidlyStableAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
  "function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)",
  "function decimals0() view returns (uint256)",
  "function decimals1() view returns (uint256)",
  "function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)",
  "function sync()",
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)",
]);

/**
 * Deploy a local Solidly STABLE (sAMM) pool and fund it with its token0/token1 reserves.
 *
 * Mirrors the canonical Velodrome/Aerodrome stable Pair math bit-for-bit (matching the off-chain
 * `solidly-stable-math.ts` replay), so `getAmountOut(amountIn, tokenIn)` returns EXACTLY
 * `getAmountOutStable(pool, dx)` to the wei. EcoSwap executes it callback-free (transfer + swap), so
 * the pool must HOLD both reserves — `minter` transfers reserve0/reserve1 in, then `sync()` snaps them.
 * `token0Addr`/`token1Addr` must be the address-sorted pair (token0 < token1).
 */
export async function deploySolidlyStablePool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  token0Addr: Hex,
  token1Addr: Hex,
  dec0: bigint,
  dec1: bigint,
  feePpm: bigint,
  reserve0: bigint,
  reserve1: bigint,
  minter?: Account,
): Promise<Hex> {
  const pool = await deployContract(walletClient, publicClient, {
    abi: solidlyStablePoolArtifact.abi,
    bytecode: solidlyStablePoolArtifact.bytecode,
    args: [token0Addr, token1Addr, dec0, dec1, feePpm],
  });
  const acct = (minter ?? walletClient.account) as Account;
  await writeAndWait(walletClient, publicClient, {
    address: token0Addr, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, reserve0], account: acct,
  });
  await writeAndWait(walletClient, publicClient, {
    address: token1Addr, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, reserve1], account: acct,
  });
  await writeAndWait(walletClient, publicClient, {
    address: pool, abi: solidlyStableAbi as Abi, functionName: "sync", args: [], account: acct,
  });
  return pool;
}

export const wombatPoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function cash0() view returns (uint256)",
  "function liability0() view returns (uint256)",
  "function cash1() view returns (uint256)",
  "function liability1() view returns (uint256)",
  "function ampFactor() view returns (uint256)",
  "function haircutRate() view returns (uint256)",
  "function quotePotentialSwap(address fromToken, address toToken, int256 fromAmount) view returns (uint256 potentialOutcome, uint256 haircut)",
  "function swap(address fromToken, address toToken, uint256 fromAmount, uint256 minimumToAmount, address to, uint256 deadline) returns (uint256 actualToAmount, uint256 haircut)",
]);

/**
 * Deploy a local Wombat (single-sided stableswap) pool and fund it with its token0/token1 out-side
 * reserves.
 *
 * Mirrors the canonical wombat-exchange/v1-core CoreV2 coverage-ratio quote + Pool haircut bit-for-bit
 * (matching the off-chain `wombat-math.ts` replay), so `quotePotentialSwap(fromToken, toToken, amount)`
 * returns EXACTLY `quotePotentialSwap(pool, dx)` to the wei. EcoSwap executes it callback-free (approve
 * + pool.swap; Wombat PULLS via transferFrom), so the pool must HOLD enough of each token to pay out —
 * `minter` transfers reserve0/reserve1 (native units) in. cash/liability are passed in WAD.
 * `token0Addr`/`token1Addr` must be the address-sorted pair (token0 < token1).
 */
export async function deployWombatPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  token0Addr: Hex,
  token1Addr: Hex,
  dec0: bigint,
  dec1: bigint,
  cash0: bigint,
  liability0: bigint,
  cash1: bigint,
  liability1: bigint,
  ampFactor: bigint,
  haircutRate: bigint,
  reserve0: bigint,
  reserve1: bigint,
  minter?: Account,
): Promise<Hex> {
  const pool = await deployContract(walletClient, publicClient, {
    abi: wombatPoolArtifact.abi,
    bytecode: wombatPoolArtifact.bytecode,
    args: [token0Addr, token1Addr, dec0, dec1, cash0, liability0, cash1, liability1, ampFactor, haircutRate],
  });
  const acct = (minter ?? walletClient.account) as Account;
  await writeAndWait(walletClient, publicClient, {
    address: token0Addr, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, reserve0], account: acct,
  });
  await writeAndWait(walletClient, publicClient, {
    address: token1Addr, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, reserve1], account: acct,
  });
  return pool;
}

export const wooFiPoolAbi = parseAbi([
  "function baseToken() view returns (address)",
  "function quoteToken() view returns (address)",
  "function price() view returns (uint256)",
  "function spread() view returns (uint256)",
  "function coeff() view returns (uint256)",
  "function feeRate() view returns (uint256)",
  "function setState(uint256 price, uint256 spread, uint256 coeff, bool feasible)",
  "function sync()",
  "function query(address fromToken, address toToken, uint256 fromAmount) view returns (uint256)",
  "function tryQuery(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount)",
  "function swap(address fromToken, address toToken, uint256 fromAmount, uint256 minToAmount, address to, address rebateTo) returns (uint256)",
]);

/**
 * Deploy a local WOOFi (WooPPV2 sPMM) pool and fund it with both base + quote reserves.
 *
 * Mirrors the canonical WooPPV2 `_calcQuoteAmountSellBase`/`_calcBaseAmountSellQuote` sPMM quote + fee
 * bit-for-bit (matching the off-chain `woofi-math.ts` replay), so `query(fromToken, toToken, amount)`
 * returns EXACTLY `query(pool, dx)` to the wei at the CURRENT (settable) oracle state. EcoSwap executes it
 * callback-free (transfer + swap; WooPPV2 is TRANSFER-FIRST), so the pool must HOLD both tokens — `minter`
 * transfers baseReserve/quoteReserve in, then `sync()` snaps the internal reserve accounting. `priceDec`
 * is the price scale (canonically 1e8); `price`/`spread`/`coeff` are the WooracleV2 sPMM inputs. Move the
 * oracle later with `setState`.
 */
export async function deployWooFiPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  base: Hex,
  quote: Hex,
  priceDec: bigint,
  quoteDec: bigint,
  baseDec: bigint,
  price: bigint,
  spread: bigint,
  coeff: bigint,
  feeRate: bigint,
  baseReserve: bigint,
  quoteReserve: bigint,
  minter?: Account,
): Promise<Hex> {
  const pool = await deployContract(walletClient, publicClient, {
    abi: wooFiPoolArtifact.abi,
    bytecode: wooFiPoolArtifact.bytecode,
    args: [base, quote, priceDec, quoteDec, baseDec, price, spread, coeff, feeRate],
  });
  const acct = (minter ?? walletClient.account) as Account;
  await writeAndWait(walletClient, publicClient, {
    address: base, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, baseReserve], account: acct,
  });
  await writeAndWait(walletClient, publicClient, {
    address: quote, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, quoteReserve], account: acct,
  });
  await writeAndWait(walletClient, publicClient, {
    address: pool, abi: wooFiPoolAbi as Abi, functionName: "sync", args: [], account: acct,
  });
  return pool;
}

// The REAL FermiSwapper surface the fixture mirrors: signed-amount quote/swap + isActive. `setState` is a
// fixture-only helper (drives the drift cell); the real router has no curve-state getters.
export const fermiPoolAbi = parseAbi([
  "function isActive(address a, address b) view returns (bool)",
  "function setState(uint256 K, uint256 base)",
  "function quoteAmounts(address tokenIn, address tokenOut, int256 amountSpecified) view returns (uint256 amountIn, uint256 amountOut)",
  "function fermiSwapWithAllowances(address tokenIn, address tokenOut, int256 amountSpecified, uint256 amountCheck, address recipient) returns (uint256 amountIn, uint256 amountOut)",
]);

/**
 * Deploy a local Fermi / propAMM (Obric-style proactive AMM) pool and fund it with both X + Y reserves.
 *
 * The pricing engine internally uses the Obric closed form (K = v0²·multX/multY, base = v0 + reserveX −
 * targetX) with the fee off the output, but exposes only the REAL FermiSwapper SURFACE (quoteAmounts tuple +
 * fermiSwapWithAllowances with a SIGNED amountSpecified) — the curve state is private (settable via
 * `setState`). EcoSwap executes it callback-free (approve + fermiSwapWithAllowances; propAMM PULLS via
 * transferFrom), so the pool must HOLD both tokens — `minter` transfers xReserve/yReserve in. `feePpm` is
 * 1e6-scaled (0.03% = 300).
 */
export async function deployFermiPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokenX: Hex,
  tokenY: Hex,
  K: bigint,
  base: bigint,
  feePpm: bigint,
  xReserve: bigint,
  yReserve: bigint,
  minter?: Account,
): Promise<Hex> {
  const pool = await deployContract(walletClient, publicClient, {
    abi: fermiPoolArtifact.abi,
    bytecode: fermiPoolArtifact.bytecode,
    args: [tokenX, tokenY, K, base, feePpm],
  });
  const acct = (minter ?? walletClient.account) as Account;
  await writeAndWait(walletClient, publicClient, {
    address: tokenX, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, xReserve], account: acct,
  });
  await writeAndWait(walletClient, publicClient, {
    address: tokenY, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, yReserve], account: acct,
  });
  return pool;
}

// The REAL TesseraSwap surface the fixture mirrors: signed-amount view/swap (tuple quote; empty-bytes
// swapData taker path) + the engine's prio-fee knob. `setState` is a fixture-only helper (drives the drift
// cell); the real wrapper has no curve-state getters.
export const tesseraSwapFixtureAbi = parseAbi([
  "function setState(uint256 K, uint256 base)",
  "function globalPrioFeeThresholddd1337() view returns (uint256)",
  "function tesseraSwapViewAmounts(address tokenIn, address tokenOut, int256 amountSpecified) view returns (uint256 amountIn, uint256 amountOut)",
  "function tesseraSwapWithAllowances(address tokenIn, address tokenOut, int256 amountSpecified, uint256 amountCheck, address recipient, bytes swapData)",
]);

/**
 * Deploy a local Tessera V (TesseraSwap) wrapper and fund it with both X + Y reserves (the fixture is its
 * own treasury). The pricing uses the Obric closed form (K, base) with the fee off the output, plus the
 * fork-observed priority-fee spread widening above `prioThreshold` (tx.gasprice-keyed; the swap never
 * reverts on gas price) — but exposes only the REAL wrapper SURFACE (tuple view + 6-arg swap with bytes
 * swapData). EcoSwap executes it callback-free (approve + tesseraSwapWithAllowances; Tessera PULLS via
 * transferFrom), so the wrapper must HOLD both tokens — `minter` transfers xReserve/yReserve in. `feePpm` /
 * `prioWidenPpm` are 1e6-scaled; `prioThreshold` is wei of gas price (the real knob is 2 gwei).
 */
export async function deployTesseraSwap(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokenX: Hex,
  tokenY: Hex,
  K: bigint,
  base: bigint,
  feePpm: bigint,
  prioThreshold: bigint,
  prioWidenPpm: bigint,
  xReserve: bigint,
  yReserve: bigint,
  minter?: Account,
): Promise<Hex> {
  const pool = await deployContract(walletClient, publicClient, {
    abi: tesseraSwapArtifact.abi,
    bytecode: tesseraSwapArtifact.bytecode,
    args: [tokenX, tokenY, K, base, feePpm, prioThreshold, prioWidenPpm],
  });
  const acct = (minter ?? walletClient.account) as Account;
  await writeAndWait(walletClient, publicClient, {
    address: tokenX, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, xReserve], account: acct,
  });
  await writeAndWait(walletClient, publicClient, {
    address: tokenY, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, yReserve], account: acct,
  });
  return pool;
}

// The REAL ElfomoFi surface the fixture mirrors: graceful getAmountOut + getSupportedPairs enumeration +
// the 6-arg swap (partnerId). `setState`/`setOracleTimestamp` are fixture-only helpers (drift + staleness
// cells); the real pricing impl exposes no state getters.
export const elfomoFiFixtureAbi = parseAbi([
  "function setState(uint256 K, uint256 base)",
  "function setOracleTimestamp(uint256 ts, uint256 staleAfter)",
  "function getSupportedPairs() view returns ((address tokenA, address tokenB)[])",
  "function getAmountOut(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount)",
  "function swap(address fromToken, address toToken, int256 specifiedAmount, uint256 limitAmount, address receiver, uint256 partnerId)",
]);

/**
 * Deploy a local ElfomoFi wrapper and fund it with both X + Y reserves (the fixture is its own vault).
 * The pricing uses the Obric closed form (K, base) with the fee off the output and a GRACEFUL quote (0 on
 * an unsupported pair / stale feed — never a revert), exposing only the REAL wrapper SURFACE
 * (getAmountOut + getSupportedPairs + swap(..., partnerId)). EcoSwap executes it callback-free (approve +
 * swap; Elfomo PULLS via transferFrom), so the wrapper must HOLD both tokens — `minter` transfers
 * xReserve/yReserve in. `feePpm` is 1e6-scaled.
 */
export async function deployElfomoFi(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokenX: Hex,
  tokenY: Hex,
  K: bigint,
  base: bigint,
  feePpm: bigint,
  xReserve: bigint,
  yReserve: bigint,
  minter?: Account,
): Promise<Hex> {
  const pool = await deployContract(walletClient, publicClient, {
    abi: elfomoFiArtifact.abi,
    bytecode: elfomoFiArtifact.bytecode,
    args: [tokenX, tokenY, K, base, feePpm],
  });
  const acct = (minter ?? walletClient.account) as Account;
  await writeAndWait(walletClient, publicClient, {
    address: tokenX, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, xReserve], account: acct,
  });
  await writeAndWait(walletClient, publicClient, {
    address: tokenY, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, yReserve], account: acct,
  });
  return pool;
}

// The REAL Fluid DEX surface the fixtures mirror: DexT1 token0/token1 + swapIn (approve-first pull, output
// to `to`, FluidDexSwapResult revert on ADDRESS_DEAD) + the periphery resolver estimateSwapIn (revert-
// decode). `setLayer`/`setCaps` are fixture-only helpers (drive the drift + cap cells).
// The real FluidDexT1 pool has NO token0()/token1() getters — token0/token1 live only inside
// constantsView()'s struct; the pair is oriented via the resolver's getDexTokens (mirrors the deployed pool).
export const fluidDexPoolAbi = parseAbi([
  "function constantsView() view returns ((uint256 dexId, address token0, address token1))",
  "function setLayer(uint256 exchangeRate0, uint256 exchangeRate1, uint256 centerPrice)",
  "function setCaps(uint256 outCap0, uint256 outCap1)",
  "function swapIn(bool swap0to1, uint256 amountIn, uint256 amountOutMin, address to) payable returns (uint256 amountOut)",
]);
export const fluidDexResolverAbi = parseAbi([
  "function getDexTokens(address dex) view returns (address token0, address token1)",
  "function estimateSwapIn(address dex, bool swap0to1, uint256 amountIn, uint256 amountOutMin) returns (uint256 amountOut)",
]);

/**
 * Deploy a local Fluid DEX (FluidDexT1) pool + its DexReservesResolver and fund the pool with both token0 +
 * token1 reserves. The pool prices off settable Liquidity-Layer state (exchange rates + center price + fee)
 * — canonical on-chain state, NOT xy=k — and exposes the REAL DexT1 surface (swapIn approve-first;
 * FluidDexSwapResult revert on ADDRESS_DEAD). EcoSwap executes it callback-free (resolver estimateSwapIn +
 * approve + pool.swapIn; Fluid PULLS via safeTransferFrom), so the pool must HOLD both tokens — `minter`
 * transfers reserve0/reserve1 in. `centerPrice`/`exchangeRate*` are 1e18-scaled; `feePpm` is 1e6-scaled.
 * Returns { pool, resolver }.
 */
export async function deployFluidDexPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  token0: Hex,
  token1: Hex,
  exchangeRate0: bigint,
  exchangeRate1: bigint,
  centerPrice: bigint,
  feePpm: bigint,
  reserve0: bigint,
  reserve1: bigint,
  depth: bigint,
  minter?: Account,
): Promise<{ pool: Hex; resolver: Hex }> {
  const pool = await deployContract(walletClient, publicClient, {
    abi: fluidDexPoolArtifact.abi,
    bytecode: fluidDexPoolArtifact.bytecode,
    args: [token0, token1, exchangeRate0, exchangeRate1, centerPrice, feePpm, depth],
  });
  const resolver = await deployContract(walletClient, publicClient, {
    abi: fluidDexResolverArtifact.abi,
    bytecode: fluidDexResolverArtifact.bytecode,
    args: [],
  });
  const acct = (minter ?? walletClient.account) as Account;
  await writeAndWait(walletClient, publicClient, {
    address: token0, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, reserve0], account: acct,
  });
  await writeAndWait(walletClient, publicClient, {
    address: token1, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, reserve1], account: acct,
  });
  return { pool, resolver };
}

// The canonical Permit2 address — the SAME on every chain; the solver hardcodes it, so the fixture Permit2
// runtime is etched here.
export const PERMIT2_ADDR = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Hex;

export const balancerV3PoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getTokens() view returns (address[])",
  "function quoteOut(address tokenIn, uint256 amountIn) view returns (uint256)",
  "function setState(uint256 centerPrice, uint256 feePpm)",
  "function setCaps(uint256 outCap0, uint256 outCap1)",
]);
export const balancerV3RouterAbi = parseAbi([
  "function vault() view returns (address)",
  "function getPermit2() view returns (address)",
  "function getPoolTokens(address pool) view returns (address[])",
  "function isPoolRegistered(address pool) view returns (bool)",
  "function querySwapSingleTokenExactIn(address pool, address tokenIn, address tokenOut, uint256 exactAmountIn, address sender, bytes userData) view returns (uint256 amountOut)",
  "function swapSingleTokenExactIn(address pool, address tokenIn, address tokenOut, uint256 exactAmountIn, uint256 minAmountOut, uint256 deadline, bool wethIsEth, bytes userData) payable returns (uint256 amountOut)",
]);

/**
 * Deploy a local Balancer V3 stack — a per-chain Router (which doubles as the reserve-holding "Vault") + a
 * stable pool — and ETCH the Permit2 fixture at the CANONICAL Permit2 address (the solver hardcodes it). The
 * Router pulls the swap input through Permit2 (the ONE operational difference from V2) and pays the output
 * from its own balance, exactly the callback-free on-chain flow the recipe hits. `centerPrice` is 1e18-scaled
 * (token1-per-token0), `feePpm` 1e6-scaled; the Router (Vault) is funded with `vaultOut` of tokenOut so it
 * can pay out. Returns { router, pool }. The Permit2 is etched once (idempotent) — call with any deployed
 * Router. Reuse ONE Router (its address is the chain-wide cfg[8]) across pools by passing an existing
 * `router`.
 */
export async function deployBalancerV3(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: { setCode: (a: { address: Hex; bytecode: Hex }) => Promise<void> },
  token0: Hex,
  token1: Hex,
  bal0: bigint,
  bal1: bigint,
  centerPrice: bigint,
  feePpm: bigint,
  tokenOut: Hex,
  vaultOut: bigint,
  existingRouter?: Hex,
  minter?: Account,
): Promise<{ router: Hex; pool: Hex }> {
  // Etch the Permit2 fixture runtime at the canonical address (no constructor/immutables ⇒ etch is exact).
  await testClient.setCode({ address: PERMIT2_ADDR, bytecode: permit2Runtime });
  const code = await publicClient.getCode({ address: PERMIT2_ADDR });
  if (!code || code === "0x") throw new Error("failed to etch Permit2 runtime");

  const router =
    existingRouter ??
    (await deployContract(walletClient, publicClient, {
      abi: balancerV3RouterArtifact.abi,
      bytecode: balancerV3RouterArtifact.bytecode,
      args: [PERMIT2_ADDR],
    }));
  const pool = await deployContract(walletClient, publicClient, {
    abi: balancerV3PoolArtifact.abi,
    bytecode: balancerV3PoolArtifact.bytecode,
    args: [token0, token1, bal0, bal1, centerPrice, feePpm],
  });
  // Fund the Router (the fixture's Vault) with the output reserve so the swap can pay out.
  const acct = (minter ?? walletClient.account) as Account;
  await writeAndWait(walletClient, publicClient, {
    address: tokenOut, abi: erc20Abi as Abi, functionName: "transfer", args: [router, vaultOut], account: acct,
  });
  return { router, pool };
}

// The REAL Mento V2 surface the fixtures mirror: the BiPoolManager exchange provider (getExchanges +
// registerExchange helper) and the Broker (getExchangeProviders + getAmountOut view + swapIn approve-first
// pull, output to msg.sender). `configureExchange`/`setBuckets`/`setCaps`/`setBreaker` are fixture-only
// helpers (drive the drift + limit + breaker cells). The Exchange struct is the verified
// IExchangeProvider.Exchange { bytes32 exchangeId; address[] assets; }.
export const mentoBiPoolManagerAbi = parseAbi([
  "function registerExchange(address asset0, address asset1) returns (bytes32 exchangeId)",
  "function getExchanges() view returns ((bytes32 exchangeId, address[] assets)[])",
]);
export const mentoBrokerAbi = parseAbi([
  "function addExchangeProvider(address provider)",
  "function getExchangeProviders() view returns (address[])",
  "function configureExchange(address provider, bytes32 exchangeId, address asset0, address asset1, uint256 rate0, uint256 rate1, uint256 centerPrice, uint256 spreadPpm, uint256 depth)",
  "function setBuckets(address provider, bytes32 exchangeId, uint256 rate0, uint256 rate1, uint256 centerPrice)",
  "function setCaps(address provider, bytes32 exchangeId, uint256 outCap0, uint256 outCap1)",
  "function setBreaker(bool tripped)",
  "function getAmountOut(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256 amountOut)",
  "function swapIn(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) returns (uint256 amountOut)",
]);

/**
 * Deploy a local Mento V2 stack — the BiPoolManager (exchange provider) + the Broker (swap entry) — register
 * ONE BiPool exchange for (asset0, asset1), configure its bucket state (oracle rates + center price + spread
 * + a utilization depth), fund the Broker with both reserves, and wire the provider into the Broker. The
 * Broker prices off the settable bucket state (canonical on-chain, NOT xy=k) and exposes the REAL Mento
 * surface (getExchangeProviders / getAmountOut view / swapIn approve-first pull). EcoSwap executes it
 * callback-free (Broker getAmountOut + approve the BROKER + broker.swapIn; Mento PULLS via transferFrom), so
 * the Broker must HOLD both tokens — `minter` transfers reserve0/reserve1 in. `centerPrice`/`rate*` are
 * 1e18-scaled; `spreadPpm` is 1e6-scaled. Returns { broker, provider, exchangeId }.
 */
export async function deployMento(
  walletClient: WalletClient,
  publicClient: PublicClient,
  asset0: Hex,
  asset1: Hex,
  rate0: bigint,
  rate1: bigint,
  centerPrice: bigint,
  spreadPpm: bigint,
  reserve0: bigint,
  reserve1: bigint,
  depth: bigint,
  minter?: Account,
): Promise<{ broker: Hex; provider: Hex; exchangeId: Hex }> {
  const acct = (minter ?? walletClient.account) as Account;
  const provider = await deployContract(walletClient, publicClient, {
    abi: mentoBiPoolManagerArtifact.abi,
    bytecode: mentoBiPoolManagerArtifact.bytecode,
    args: [],
  });
  const broker = await deployContract(walletClient, publicClient, {
    abi: mentoBrokerArtifact.abi,
    bytecode: mentoBrokerArtifact.bytecode,
    args: [],
  });
  // Register the exchange on the provider (it enumerates via getExchanges) — read back the deterministic id.
  const exchangeId = (await publicClient.readContract({
    address: provider, abi: mentoBiPoolManagerAbi as Abi, functionName: "registerExchange", args: [asset0, asset1],
  })) as Hex;
  await writeAndWait(walletClient, publicClient, {
    address: provider, abi: mentoBiPoolManagerAbi as Abi, functionName: "registerExchange", args: [asset0, asset1],
  });
  await writeAndWait(walletClient, publicClient, {
    address: broker, abi: mentoBrokerAbi as Abi, functionName: "addExchangeProvider", args: [provider],
  });
  await writeAndWait(walletClient, publicClient, {
    address: broker, abi: mentoBrokerAbi as Abi, functionName: "configureExchange",
    args: [provider, exchangeId, asset0, asset1, rate0, rate1, centerPrice, spreadPpm, depth],
  });
  // The Broker holds both reserves (it pays the out and, in the fixture, receives the pulled input).
  await writeAndWait(walletClient, publicClient, {
    address: asset0, abi: erc20Abi as Abi, functionName: "transfer", args: [broker, reserve0], account: acct,
  });
  await writeAndWait(walletClient, publicClient, {
    address: asset1, abi: erc20Abi as Abi, functionName: "transfer", args: [broker, reserve1], account: acct,
  });
  return { broker, provider, exchangeId };
}

// Mirrors the real euler-xyz/euler-swap IEulerSwap read surface — BOTH v1 (curve/getParams) and v2
// (getDynamicParams) — plus the shared getAssets/getReserves/computeQuote/getLimits/swap. NO individual
// asset0()/reserve0()/priceX()/fee() getters.
export const eulerSwapPoolAbi = parseAbi([
  "function curve() view returns (bytes32)",
  "function getAssets() view returns (address asset0, address asset1)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 status)",
  "function getParams() view returns ((address vault0, address vault1, address eulerAccount, uint112 equilibriumReserve0, uint112 equilibriumReserve1, uint256 priceX, uint256 priceY, uint256 concentrationX, uint256 concentrationY, uint256 fee, uint256 protocolFee, address protocolFeeRecipient) params)",
  "function computeQuote(address tokenIn, address tokenOut, uint256 amount, bool exactIn) view returns (uint256)",
  "function getLimits(address tokenIn, address tokenOut) view returns (uint256 inLimit, uint256 outLimit)",
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)",
]);

/** EulerSwap curve params for a deploy (1e18 fixed point; reserves/equilibria RAW token units). */
export interface EulerSwapParams {
  /** Live reserves (RAW units). */
  reserve0: bigint;
  reserve1: bigint;
  /** Equilibrium reserves x0/y0 (RAW units). */
  equil0: bigint;
  equil1: bigint;
  /** Prices px/py (1e18). */
  priceX: bigint;
  priceY: bigint;
  /** Concentrations cx/cy (1e18; 1e18 == full-range linear, lower == more concentrated). */
  concX: bigint;
  concY: bigint;
  /** Swap fee (1e18-scaled; e.g. 1e15 == 0.1%). */
  fee: bigint;
  /** Vault output caps (the available-cash limit per side; 0 ⇒ uncapped). */
  outCap0: bigint;
  outCap1: bigint;
}

/**
 * Deploy a local EulerSwap (Euler vault-backed AMM, v1+v2) pool and fund it with its asset0/asset1
 * reserves.
 *
 * Mirrors the canonical euler-xyz/euler-swap CurveLib.f + QuoteLib.computeQuote (exact-in) bit-for-bit
 * (matching the off-chain `eulerswap-math.ts` replay), so `computeQuote(tokenIn, tokenOut, amount, true)`
 * returns EXACTLY `computeQuote(pool, dx)` to the wei. EcoSwap executes it callback-free (transfer +
 * pool.swap(...,"")), so the pool must HOLD enough of each token to pay out — `minter` transfers
 * reserve0/reserve1 (RAW units) in to match the on-chain reserve fields. `asset0Addr`/`asset1Addr` are
 * the pool's canonical token0/token1 (the curve's x/y sides; NOT necessarily address-sorted).
 */
export async function deployEulerSwapPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  asset0Addr: Hex,
  asset1Addr: Hex,
  p: EulerSwapParams,
  minter?: Account,
  isV1 = true,
): Promise<Hex> {
  // `isV1` selects the exposed surface (default v1 — every currently-deployed real pool is v1):
  // true ⇒ curve()=="EulerSwap v1" + getParams() (getDynamicParams reverts); false ⇒ the v2 surface.
  const pool = await deployContract(walletClient, publicClient, {
    abi: eulerSwapPoolArtifact.abi,
    bytecode: eulerSwapPoolArtifact.bytecode,
    args: [
      asset0Addr,
      asset1Addr,
      [
        p.reserve0, p.reserve1, p.equil0, p.equil1, p.priceX, p.priceY,
        p.concX, p.concY, p.fee, p.outCap0, p.outCap1,
      ],
      isV1,
    ],
  });
  const acct = (minter ?? walletClient.account) as Account;
  await writeAndWait(walletClient, publicClient, {
    address: asset0Addr, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, p.reserve0], account: acct,
  });
  await writeAndWait(walletClient, publicClient, {
    address: asset1Addr, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, p.reserve1], account: acct,
  });
  return pool;
}

export const lbPairAbi = parseAbi([
  "function getTokenX() view returns (address)",
  "function getTokenY() view returns (address)",
  "function getActiveId() view returns (uint24)",
  "function getBinStep() view returns (uint16)",
  "function getBin(uint24 id) view returns (uint128 binReserveX, uint128 binReserveY)",
  "function getReserves() view returns (uint128 reserveX, uint128 reserveY)",
  "function getStaticFeeParameters() view returns (uint16 baseFactor, uint16 filterPeriod, uint16 decayPeriod, uint16 reductionFactor, uint24 variableFeeControl, uint16 protocolShare, uint24 maxVolatilityAccumulator)",
  "function getSwapOut(uint128 amountIn, bool swapForY) view returns (uint128 amountInLeft, uint128 amountOut, uint128 fee)",
  "function setBin(uint24 id, uint256 reserveX, uint256 reserveY)",
  "function swap(bool swapForY, address to) returns (bytes32 amountsOut)",
]);

/** One initialized bin: id + both token-side reserves (native units). */
export interface LbBinSeed {
  id: number;
  reserveX: bigint;
  reserveY: bigint;
}

/**
 * Deploy a local Trader Joe LB pair and seed its bins + reserves.
 *
 * Mirrors the canonical LB v2.1/v2.2 `getPriceFromId` 128.128 pow + constant-sum per-bin drain +
 * static base fee bit-for-bit (matching the off-chain `lb-math.ts` replay), so
 * `swap(swapForY, to)` sends EXACTLY the off-chain `getSwapOut(amountIn)` to the wei. The engine
 * `_swapTraderJoeLB` is transfer-first: it transfers tokenIn to the pair then calls
 * `swap(swapForY, recipient)`, so the pair must HOLD the out-token reserve it pays out — `minter`
 * transfers each bin's reserveX of tokenX + reserveY of tokenY into the pair. `tokenX`/`tokenY`
 * are the LB pair's canonical token sides (swapForY trades tokenX → tokenY).
 */
export async function deployLBPair(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokenX: Hex,
  tokenY: Hex,
  binStep: number,
  baseFactor: number,
  activeId: number,
  bins: LbBinSeed[],
  minter?: Account,
): Promise<Hex> {
  const pair = await deployContract(walletClient, publicClient, {
    abi: traderJoeLBPairArtifact.abi,
    bytecode: traderJoeLBPairArtifact.bytecode,
    args: [tokenX, tokenY, binStep, baseFactor, activeId],
  });
  const acct = (minter ?? walletClient.account) as Account;

  let totalX = 0n;
  let totalY = 0n;
  for (const b of bins) {
    await writeAndWait(walletClient, publicClient, {
      address: pair,
      abi: lbPairAbi as Abi,
      functionName: "setBin",
      args: [b.id, b.reserveX, b.reserveY],
      account: acct,
    });
    totalX += b.reserveX;
    totalY += b.reserveY;
  }
  // Fund the pair with the full book it pays out (both sides, per the seeded bin reserves).
  if (totalX > 0n) {
    await writeAndWait(walletClient, publicClient, {
      address: tokenX, abi: erc20Abi as Abi, functionName: "transfer", args: [pair, totalX], account: acct,
    });
  }
  if (totalY > 0n) {
    await writeAndWait(walletClient, publicClient, {
      address: tokenY, abi: erc20Abi as Abi, functionName: "transfer", args: [pair, totalY], account: acct,
    });
  }
  return pair;
}

/**
 * Stand up a constant-product V2 pool by ETCHING the V2Pair runtime bytecode at
 * `pairAddr`, then initialise it, register it on the factory, fund it with both
 * reserves, and `sync()`. No deploy — the real pair bytecode is etched, exactly
 * the mechanism the V4 PoolManager fixture reuses.
 *
 * `minter` (defaults to wallet account) must hold both tokens; reserves are
 * transferred straight to the pair and snapshotted via sync().
 */
export async function setupEtchedV2Pool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: { setCode: (a: { address: Hex; bytecode: Hex }) => Promise<void> },
  factory: Hex,
  pairAddr: Hex,
  token0: Hex,
  token1: Hex,
  reserve0: bigint,
  reserve1: bigint,
  minter?: Account,
  /**
   * Per-pool constant-product fee in ppm. Omitted / 3000 ⇒ the canonical 0.30% pair
   * (executed through the engine's _swapV2). Any other value stands up a V2-class pair
   * at that fee (executed via EcoSwap's callback-free transfer + pair.swap path).
   */
  feePpm?: number,
): Promise<Hex> {
  await testClient.setCode({ address: pairAddr, bytecode: v2PairRuntime });
  const code = await publicClient.getCode({ address: pairAddr });
  if (!code || code === "0x") throw new Error("failed to etch V2Pair runtime");

  if (feePpm !== undefined && feePpm !== 3000) {
    await writeAndWait(walletClient, publicClient, {
      address: pairAddr,
      abi: v2PairAbi as Abi,
      functionName: "initializeWithFee",
      args: [token0, token1, BigInt(feePpm)],
      account: minter,
    });
  } else {
    await writeAndWait(walletClient, publicClient, {
      address: pairAddr,
      abi: v2PairAbi as Abi,
      functionName: "initialize",
      args: [token0, token1],
      account: minter,
    });
  }
  await writeAndWait(walletClient, publicClient, {
    address: factory,
    abi: v2FactoryAbi as Abi,
    functionName: "setPair",
    args: [token0, token1, pairAddr],
    account: minter,
  });
  // Fund reserves directly from the minter, then snapshot them.
  await writeAndWait(walletClient, publicClient, {
    address: token0, abi: erc20Abi as Abi, functionName: "transfer", args: [pairAddr, reserve0], account: minter,
  });
  await writeAndWait(walletClient, publicClient, {
    address: token1, abi: erc20Abi as Abi, functionName: "transfer", args: [pairAddr, reserve1], account: minter,
  });
  await writeAndWait(walletClient, publicClient, {
    address: pairAddr, abi: v2PairAbi as Abi, functionName: "sync", args: [], account: minter,
  });
  return pairAddr;
}

// ── KyberSwap Classic / DMM (etched pool + factory registry) ──

/** Deploy the Kyber Classic factory (getPools registry; discovery resolves pools via it). */
export async function deployKyberFactory(
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<Hex> {
  return deployContract(walletClient, publicClient, {
    abi: kyberFactoryArtifact.abi,
    bytecode: kyberFactoryArtifact.bytecode,
  });
}

/**
 * Stand up a KyberSwap Classic / DMM pool by ETCHING the pool runtime at `poolAddr`, then
 * initialise it (token pair + feeInPrecision + the virtual-reserve BOOSTs = (amp-1)·reserve),
 * register it on the factory, fund it with the REAL reserves, and sync() (which sets virtual =
 * real + boost). The amplified curve then trades on the virtual reserves
 * (vReserve = reserve + boost). Mirrors setupEtchedV2Pool.
 *
 * `feeInPrecision` is 1e18-scaled (e.g. 0.30% = 3e15). `vBoost0/1` are the EXTRA virtual
 * reserve per token (set both > 0 to make the pool deeper than its real reserves, exercising
 * the virtual-reserve geometry).
 */
export async function setupEtchedKyberPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: { setCode: (a: { address: Hex; bytecode: Hex }) => Promise<void> },
  factory: Hex,
  poolAddr: Hex,
  token0: Hex,
  token1: Hex,
  reserve0: bigint,
  reserve1: bigint,
  feeInPrecision: bigint,
  vBoost0: bigint,
  vBoost1: bigint,
  minter?: Account,
): Promise<Hex> {
  await testClient.setCode({ address: poolAddr, bytecode: kyberPoolRuntime });
  const code = await publicClient.getCode({ address: poolAddr });
  if (!code || code === "0x") throw new Error("failed to etch KyberClassicPool runtime");

  await writeAndWait(walletClient, publicClient, {
    address: poolAddr,
    abi: kyberPoolAbi as Abi,
    functionName: "initialize",
    args: [token0, token1, feeInPrecision, vBoost0, vBoost1],
    account: minter,
  });
  await writeAndWait(walletClient, publicClient, {
    address: factory,
    abi: kyberFactoryAbi as Abi,
    functionName: "addPool",
    args: [token0, token1, poolAddr],
    account: minter,
  });
  await writeAndWait(walletClient, publicClient, {
    address: token0, abi: erc20Abi as Abi, functionName: "transfer", args: [poolAddr, reserve0], account: minter,
  });
  await writeAndWait(walletClient, publicClient, {
    address: token1, abi: erc20Abi as Abi, functionName: "transfer", args: [poolAddr, reserve1], account: minter,
  });
  await writeAndWait(walletClient, publicClient, {
    address: poolAddr, abi: kyberPoolAbi as Abi, functionName: "sync", args: [], account: minter,
  });
  return poolAddr;
}

// ── Algebra fork (Camelot/QuickSwap V3) — adapter over a genuine V3 pool ──

/** Deploy the Algebra factory (poolByPair registry; discovery + lens resolve pools via it). */
export async function deployAlgebraFactory(
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<Hex> {
  return deployContract(walletClient, publicClient, {
    abi: algebraFactoryArtifact.abi,
    bytecode: algebraFactoryArtifact.bytecode,
  });
}

/** Enable a (possibly non-standard) fee tier on the Uniswap V3 factory so an inner pool can be
 *  created at the Algebra pool's dynamic fee. Idempotent-ish: only call for a tier not already
 *  enabled (re-enabling a tier reverts in v3-core). */
export async function enableV3FeeAmount(
  walletClient: WalletClient,
  publicClient: PublicClient,
  factory: Hex,
  fee: number,
  tickSpacing: number,
): Promise<void> {
  await writeAndWait(walletClient, publicClient, {
    address: factory,
    abi: v3FactoryAbi as Abi,
    functionName: "enableFeeAmount",
    args: [fee, tickSpacing],
  });
}

/**
 * Stand up an Algebra-fork pool for the EVM tests as an ADAPTER over a GENUINE Uniswap V3 pool.
 *
 * The inner V3 pool (created via the real factory at `innerFee`, minted with `positions`) supplies
 * the EXACT V3 swap math; the deployed AlgebraPool adapter wraps it, exposing the Algebra read
 * surface (globalState/liquidity/tickSpacing/ticks) and the algebraSwapCallback re-entry the engine
 * services (sauce#186). The dynamic fee the lens reads (`dynFee`) equals `innerFee` so the off-chain
 * oracle prices at the SAME fee the inner pool charges — keeping the split wei-exact. The adapter is
 * registered on the Algebra factory's poolByPair so discovery + the lens find it.
 *
 * `innerFee` must already be an enabled tier on `factory` (call enableV3FeeAmount first for a
 * non-standard fee). The minter must hold + have approved `helper` for both tokens. Returns
 * `{ pool, inner }` — `pool` is the adapter address discovery surfaces.
 */
export async function setupAlgebraPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  factory: Hex,
  algebraFactory: Hex,
  helper: Hex,
  token0: Hex,
  token1: Hex,
  innerFee: number,
  dynFee: number,
  sqrtPriceX96: bigint,
  positions: [number, number, bigint][],
  minter?: Account,
  dynFeeOtz?: number,
): Promise<{ pool: Hex; inner: Hex }> {
  const inner = await createAndInitPool(walletClient, publicClient, factory, token0, token1, innerFee, sqrtPriceX96);
  for (const [lo, hi, L] of positions) {
    await mintPosition(walletClient, publicClient, helper, inner, (minter ?? walletClient.account!).address as Hex, lo, hi, L, minter);
  }
  // Deploy the adapter and bind it to the inner pool. dynFee is globalState word 2 (feeZto); dynFeeOtz
  // is word 3 (feeOtz), defaulting to dynFee. A test can set them DIFFERENT to exercise the lens's
  // per-fork fee decode (a V1/Integral fork must read word 2 for BOTH directions — word 3 is not a fee).
  const pool = await deployContract(walletClient, publicClient, {
    abi: algebraPoolArtifact.abi,
    bytecode: algebraPoolArtifact.bytecode,
  });
  await writeAndWait(walletClient, publicClient, {
    address: pool,
    abi: algebraPoolAbi as Abi,
    functionName: "initialize",
    args: [inner, dynFee, dynFeeOtz ?? dynFee],
    account: minter,
  });
  // Register on the Algebra factory (poolByPair).
  await writeAndWait(walletClient, publicClient, {
    address: algebraFactory,
    abi: algebraFactoryAbi as Abi,
    functionName: "setPool",
    args: [token0, token1, pool],
    account: minter,
  });
  return { pool, inner };
}

/**
 * Wrap an ALREADY-CREATED v3-core `inner` pool in the Algebra adapter and register it on the
 * Algebra factory's poolByPair, WITHOUT minting (the caller reconstructed the inner pool's tick
 * profile separately — e.g. via reproducePool for the prod-mirror lane). The adapter exposes the
 * Algebra read surface (globalState/liquidity/tickSpacing/ticks) proxied off the inner pool and
 * re-enters the engine via algebraSwapCallback at swap time (sauce#186), so the executed swap math
 * is the inner pool's genuine v3-core math over its reconstructed state while the callback PATH is
 * the real Algebra path. `dynFee` is the (uint16) dynamic fee the adapter reports for both
 * directions — pass the captured globalState fee so the lens prices at the fee the pool charged.
 * Returns the adapter address discovery surfaces via poolByPair(token0, token1).
 */
export async function wrapAlgebraAdapter(
  walletClient: WalletClient,
  publicClient: PublicClient,
  algebraFactory: Hex,
  inner: Hex,
  token0: Hex,
  token1: Hex,
  dynFee: number,
  minter?: Account,
): Promise<Hex> {
  const pool = await deployContract(walletClient, publicClient, {
    abi: algebraPoolArtifact.abi,
    bytecode: algebraPoolArtifact.bytecode,
  });
  await writeAndWait(walletClient, publicClient, {
    address: pool,
    abi: algebraPoolAbi as Abi,
    functionName: "initialize",
    args: [inner, dynFee, dynFee],
    account: minter,
  });
  await writeAndWait(walletClient, publicClient, {
    address: algebraFactory,
    abi: algebraFactoryAbi as Abi,
    functionName: "setPool",
    args: [token0, token1, pool],
    account: minter,
  });
  return pool;
}

/** Read the Algebra adapter's globalState (price/tick + dynamic fee per direction). */
export async function getAlgebraGlobalState(
  publicClient: PublicClient,
  pool: Hex,
): Promise<{ sqrtPriceX96: bigint; tick: number; feeZto: number; feeOtz: number }> {
  const r = (await publicClient.readContract({
    address: pool,
    abi: algebraPoolAbi as Abi,
    functionName: "globalState",
  })) as readonly [bigint, number, number, number, ...unknown[]];
  return { sqrtPriceX96: r[0], tick: Number(r[1]), feeZto: Number(r[2]), feeOtz: Number(r[3]) };
}

// ── Uniswap V4 (etched singletons) ───────────────────────────

export interface V4Singletons {
  poolManager: Hex;
  stateView: Hex;
}

/**
 * Etch the REAL Uniswap V4 PoolManager + StateView runtime (captured from Base)
 * at their CANONICAL addresses. StateView bakes the PoolManager address in as an
 * immutable, so both must sit at the real addresses for its extsload reads to
 * resolve to the etched manager.
 */
export async function etchV4Singletons(
  publicClient: PublicClient,
  testClient: { setCode: (a: { address: Hex; bytecode: Hex }) => Promise<void> },
): Promise<V4Singletons> {
  await testClient.setCode({ address: V4_BYTECODE.poolManager.address, bytecode: V4_BYTECODE.poolManager.runtime });
  await testClient.setCode({ address: V4_BYTECODE.stateView.address, bytecode: V4_BYTECODE.stateView.runtime });
  const pmCode = await publicClient.getCode({ address: V4_BYTECODE.poolManager.address });
  const svCode = await publicClient.getCode({ address: V4_BYTECODE.stateView.address });
  if (!pmCode || pmCode === "0x" || !svCode || svCode === "0x") {
    throw new Error("failed to etch V4 singletons");
  }
  if (V4_BYTECODE.poolManager.address.toLowerCase() !== UNISWAP_V4_POOL_MANAGER.toLowerCase()) {
    throw new Error("snapshot PoolManager address drifted from constants");
  }
  return { poolManager: UNISWAP_V4_POOL_MANAGER, stateView: UNISWAP_V4_STATE_VIEW };
}

/** Deploy the V4 liquidity helper bound to the (etched) PoolManager. */
export async function deployV4Helper(
  walletClient: WalletClient,
  publicClient: PublicClient,
  manager: Hex,
): Promise<Hex> {
  return deployContract(walletClient, publicClient, {
    abi: v4HelperArtifact.abi,
    bytecode: v4HelperArtifact.bytecode,
    args: [manager],
  });
}

/**
 * Initialise a V4 pool on the etched PoolManager and add a liquidity position via
 * the helper (which is funded with both tokens to pay the pool on settle).
 * Returns the poolId. token0/token1 must be sorted (currency0 < currency1).
 */
export async function setupV4Pool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  helper: Hex,
  token0: Hex,
  token1: Hex,
  fee: number,
  tickSpacing: number,
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  fundAmount: bigint,
): Promise<Hex> {
  const key = { currency0: token0, currency1: token1, fee, tickSpacing, hooks: ZERO_ADDR };
  await writeAndWait(walletClient, publicClient, {
    address: helper, abi: v4HelperAbi as Abi, functionName: "initialize", args: [key, sqrtPriceX96],
  });
  // Fund the helper so it can pay the pool when settling the liquidity add.
  await mint(walletClient, publicClient, token0, helper, fundAmount);
  await mint(walletClient, publicClient, token1, helper, fundAmount);
  await writeAndWait(walletClient, publicClient, {
    address: helper, abi: v4HelperAbi as Abi, functionName: "addLiquidity",
    args: [key, tickLower, tickUpper, liquidity],
  });
  return computeV4PoolId(token0, token1, fee, tickSpacing);
}

export async function getV4Slot0(
  publicClient: PublicClient,
  stateView: Hex,
  poolId: Hex,
): Promise<{ sqrtPriceX96: bigint; tick: number }> {
  const r = (await publicClient.readContract({
    address: stateView, abi: v4StateViewAbi as Abi, functionName: "getSlot0", args: [poolId],
  })) as readonly [bigint, number, number, number];
  return { sqrtPriceX96: r[0], tick: Number(r[1]) };
}

export async function getV4Liquidity(
  publicClient: PublicClient,
  stateView: Hex,
  poolId: Hex,
): Promise<bigint> {
  return publicClient.readContract({
    address: stateView, abi: v4StateViewAbi as Abi, functionName: "getLiquidity", args: [poolId],
  }) as Promise<bigint>;
}

export async function getLiquidity(publicClient: PublicClient, pool: Hex): Promise<bigint> {
  return publicClient.readContract({
    address: pool,
    abi: v3PoolAbi as Abi,
    functionName: "liquidity",
  }) as Promise<bigint>;
}

export async function getTickLiquidityNet(
  publicClient: PublicClient,
  pool: Hex,
  tick: number,
): Promise<{ liquidityGross: bigint; liquidityNet: bigint; initialized: boolean }> {
  const r = (await publicClient.readContract({
    address: pool,
    abi: v3PoolAbi as Abi,
    functionName: "ticks",
    args: [tick],
  })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint, number, boolean];
  return { liquidityGross: r[0], liquidityNet: r[1], initialized: r[7] };
}

// ── Maverick V2 (bin-based directional AMM) fixture ──────────────

export const maverickV2PoolAbi = parseAbi([
  "struct SwapParams { uint256 amount; bool tokenAIn; bool exactOutput; int32 tickLimit; }",
  "function tokenA() view returns (address)",
  "function tokenB() view returns (address)",
  "function fee(bool tokenAIn) view returns (uint256)",
  "function tickSpacing() view returns (uint256)",
  "function getState() view returns ((uint128 reserveA, uint128 reserveB, int64 lastTwaD8, int64 lastLogPriceD8, uint40 lastTimestamp, int32 activeTick, bool isLocked, uint32 binCounter, uint8 protocolFeeRatioD3) state)",
  "function getTick(int32 tick) view returns ((uint128 reserveA, uint128 reserveB, uint128 totalSupply, uint32[4] binIdsByTick) tickState)",
  "function setTick(int32 tick, uint128 reserveA, uint128 reserveB)",
  "function setActive(int32 activeTick, uint256 poolSqrtPrice)",
  "function tickSqrtPrice(int32 tick) view returns (uint256)",
  "function getTickL(uint256 reserveA, uint256 reserveB, uint256 sqrtLower, uint256 sqrtUpper) pure returns (uint256)",
  "function getSqrtPrice(uint256 reserveA, uint256 reserveB, uint256 sqrtLower, uint256 sqrtUpper, uint256 L) pure returns (uint256)",
  "function calculateSwap(uint128 amount, bool tokenAIn, bool exactOutput, int32 tickLimit) view returns (uint256 amountIn, uint256 amountOut, uint256 gasEstimate)",
  "function swap(address recipient, SwapParams params, bytes data) returns (uint256 amountIn, uint256 amountOut)",
]);

/** One seeded Maverick tick: tick index + both token-side reserves (native units). */
export interface MaverickTickSeed {
  tick: number;
  reserveA: bigint;
  reserveB: bigint;
}

/** Constructor + seed params for a Maverick V2 pool fixture (mirrors the off-chain MaverickPool). */
export interface MaverickDeployParams {
  /** Canonical tokenA (the pool's tokenA — NOT necessarily address-sorted). */
  tokenA: Hex;
  /** Canonical tokenB. */
  tokenB: Hex;
  tickSpacing: number;
  /** Directional fees (1e18-scaled). */
  feeAIn: bigint;
  feeBIn: bigint;
  protocolFeeRatioD3: number;
  /** Seeded ticks around the active tick. */
  ticks: MaverickTickSeed[];
  /** Live active tick. */
  activeTick: number;
  /** Live pool sqrt price (1e18) — the walk's starting price within the active tick. */
  poolSqrtPrice: bigint;
}

/**
 * Deploy a local Maverick V2 pool, seed its tick book + active state, and fund it with the reserves it
 * pays out. Mirrors the canonical Maverick V2 TickMath + SwapMath bit-for-bit (matching the off-chain
 * `maverick-math.ts` replay), so the engine `_swapMaverickV2` swap consumes/pays EXACTLY the off-chain
 * `getDy(pool, amountIn)` == the fixture's own `calculateSwap(amountIn)` view to the wei.
 *
 * Maverick is a CALLBACK pool: the engine calls `pool.swap(recipient, SwapParams, "")`, the pool
 * re-enters the engine's `maverickV2SwapCallback` to PULL the input, then transfers the output to the
 * recipient. So the pool must HOLD both sides' reserves — `minter` transfers each tick's reserveA of
 * tokenA + reserveB of tokenB into the pool.
 */
export async function deployMaverickV2Pool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  p: MaverickDeployParams,
  minter?: Account,
): Promise<Hex> {
  const pool = await deployContract(walletClient, publicClient, {
    abi: maverickV2PoolArtifact.abi,
    bytecode: maverickV2PoolArtifact.bytecode,
    args: [p.tokenA, p.tokenB, BigInt(p.tickSpacing), p.feeAIn, p.feeBIn, p.protocolFeeRatioD3],
  });
  const acct = (minter ?? walletClient.account) as Account;

  let totalA = 0n;
  let totalB = 0n;
  for (const t of p.ticks) {
    await writeAndWait(walletClient, publicClient, {
      address: pool, abi: maverickV2PoolAbi as Abi, functionName: "setTick",
      args: [t.tick, t.reserveA, t.reserveB], account: acct,
    });
    totalA += t.reserveA;
    totalB += t.reserveB;
  }
  await writeAndWait(walletClient, publicClient, {
    address: pool, abi: maverickV2PoolAbi as Abi, functionName: "setActive",
    args: [p.activeTick, p.poolSqrtPrice], account: acct,
  });
  // Fund the pool with the full book it pays out (both sides).
  if (totalA > 0n) {
    await writeAndWait(walletClient, publicClient, {
      address: p.tokenA, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, totalA], account: acct,
    });
  }
  if (totalB > 0n) {
    await writeAndWait(walletClient, publicClient, {
      address: p.tokenB, abi: erc20Abi as Abi, functionName: "transfer", args: [pool, totalB], account: acct,
    });
  }
  return pool;
}
