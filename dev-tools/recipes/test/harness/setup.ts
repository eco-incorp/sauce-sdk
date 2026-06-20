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

import { loadArtifact } from "./artifacts";
import { deployContract, writeAndWait } from "./deploy";
import { MULTICALL3 } from "../../shared/constants";

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
export const v3FactoryArtifact = loadArtifact(
  join(UNISWAP, "UniswapV3Factory.sol", "UniswapV3Factory.json"),
);
export const v3PoolArtifact = loadArtifact(
  join(UNISWAP, "UniswapV3Pool.sol", "UniswapV3Pool.json"),
);

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
]);

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
