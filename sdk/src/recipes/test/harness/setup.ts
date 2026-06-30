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
export const helperArtifact = loadArtifact(
  join(FIXTURES, "V3LiquidityHelper.sol", "V3LiquidityHelper.json"),
);
export const v2FactoryArtifact = loadArtifact(
  join(FIXTURES, "V2Factory.sol", "V2Factory.json"),
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
/** Solidly STABLE (sAMM) pool — deployed normally (constructor sets tokens/decimals/fee). */
export const solidlyStablePoolArtifact = loadArtifact(
  join(FIXTURES, "SolidlyStablePool.sol", "SolidlyStablePool.json"),
);
/** Trader Joe LB pair — deployed normally (constructor sets tokens/binStep/baseFactor/activeId). */
export const traderJoeLBPairArtifact = loadArtifact(
  join(FIXTURES, "TraderJoeLBPair.sol", "TraderJoeLBPair.json"),
);
export const v4HelperArtifact = loadArtifact(
  join(FIXTURES, "V4LiquidityHelper.sol", "V4LiquidityHelper.json"),
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

export const dodoAbi = parseAbi([
  "function _BASE_TOKEN_() view returns (address)",
  "function _QUOTE_TOKEN_() view returns (address)",
  "function getPMMStateForCall() view returns (uint256 i, uint256 K, uint256 B, uint256 Q, uint256 B0, uint256 Q0, uint256 R)",
  "function querySellBase(uint256 payBase) view returns (uint256)",
  "function querySellQuote(uint256 payQuote) view returns (uint256)",
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

export const lbPairAbi = parseAbi([
  "function getTokenX() view returns (address)",
  "function getTokenY() view returns (address)",
  "function getActiveId() view returns (uint24)",
  "function getBinStep() view returns (uint16)",
  "function getBin(uint24 id) view returns (uint128 binReserveX, uint128 binReserveY)",
  "function getReserves() view returns (uint128 reserveX, uint128 reserveY)",
  "function getStaticFeeParameters() view returns (uint16 baseFactor, uint16 filterPeriod, uint16 decayPeriod, uint16 reductionFactor, uint24 variableFeeControl, uint16 protocolShare, uint24 maxVolatilityAccumulator)",
  "function getSwapOut(uint256 amountIn, bool swapForY) view returns (uint256)",
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
): Promise<{ pool: Hex; inner: Hex }> {
  const inner = await createAndInitPool(walletClient, publicClient, factory, token0, token1, innerFee, sqrtPriceX96);
  for (const [lo, hi, L] of positions) {
    await mintPosition(walletClient, publicClient, helper, inner, (minter ?? walletClient.account!).address as Hex, lo, hi, L, minter);
  }
  // Deploy the adapter and bind it to the inner pool.
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
