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

import { loadArtifact, loadDeployedBytecode } from "./artifacts";
import { deployContract, writeAndWait } from "./deploy";
import {
  MULTICALL3,
  UNISWAP_V4_POOL_MANAGER,
  UNISWAP_V4_STATE_VIEW,
} from "../../shared/constants";
import { keccak256, encodeAbiParameters } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEV_TOOLS = join(__dirname, "..", "..", "..");
const ARTIFACTS = join(DEV_TOOLS, "artifacts");
const FIXTURES = join(DEV_TOOLS, "recipes", "test", "fixtures", "out");
const UNISWAP = join(
  DEV_TOOLS,
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
export const v4HelperArtifact = loadArtifact(
  join(FIXTURES, "V4LiquidityHelper.sol", "V4LiquidityHelper.json"),
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
  DEV_TOOLS, "node_modules", "@pancakeswap", "v3-core", "artifacts", "contracts",
);
export const pancakeDeployerArtifact = loadArtifact(
  join(FIXTURES, "PancakeV3Deployer.sol", "PancakeV3Deployer.json"),
);
/** Genuine PancakeV3Pool creation bytecode (ctor reads immutables from its deployer). */
export const pancakeV3PoolCreationCode = loadArtifact(
  join(PANCAKE, "PancakeV3Pool.sol", "PancakeV3Pool.json"),
).bytecode;

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
  "function sync()",
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
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
): Promise<Hex> {
  await testClient.setCode({ address: pairAddr, bytecode: v2PairRuntime });
  const code = await publicClient.getCode({ address: pairAddr });
  if (!code || code === "0x") throw new Error("failed to etch V2Pair runtime");

  await writeAndWait(walletClient, publicClient, {
    address: pairAddr,
    abi: v2PairAbi as Abi,
    functionName: "initialize",
    args: [token0, token1],
    account: minter,
  });
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
