/**
 * Pool discovery for V3 DEXes on Base.
 *
 * Queries Uniswap V3 and PancakeSwap V3 factories across all fee tiers,
 * then reads slot0() and liquidity() for each discovered pool.
 */

import type { PublicClient, Hex } from "viem";
import { parseAbi } from "viem";
import {
  UNISWAP_V3_FACTORY,
  PANCAKESWAP_V3_FACTORY,
  FEE_TIERS,
  SwapPoolType,
} from "./constants.js";
import type { PoolInfo } from "./types.js";

const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
]);

const poolAbi = parseAbi([
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
]);

interface FactoryEntry {
  factory: Hex;
  poolType: SwapPoolType;
}

const FACTORIES: FactoryEntry[] = [
  { factory: UNISWAP_V3_FACTORY, poolType: SwapPoolType.UniV3 },
  { factory: PANCAKESWAP_V3_FACTORY, poolType: SwapPoolType.UniV3 },
];

/**
 * Discover all V3 pools for a token pair across protocols and fee tiers.
 * Reads slot0() and liquidity() for each discovered pool via multicall.
 */
export async function discoverPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
): Promise<PoolInfo[]> {
  // Step 1: Query all factories for all fee tiers
  const getPoolCalls = FACTORIES.flatMap((f) =>
    FEE_TIERS.map((fee) => ({
      address: f.factory,
      abi: factoryAbi,
      functionName: "getPool" as const,
      args: [tokenIn, tokenOut, fee] as const,
      factory: f,
      fee,
    })),
  );

  const poolAddresses = await client.multicall({
    contracts: getPoolCalls.map((c) => ({
      address: c.address,
      abi: c.abi,
      functionName: c.functionName,
      args: c.args,
    })),
    allowFailure: true,
  });

  // Collect non-zero pool addresses
  const validPools: { address: Hex; poolType: SwapPoolType; fee: number }[] = [];
  for (let i = 0; i < poolAddresses.length; i++) {
    const result = poolAddresses[i];
    if (
      result.status === "success" &&
      result.result &&
      result.result !== "0x0000000000000000000000000000000000000000"
    ) {
      validPools.push({
        address: result.result as Hex,
        poolType: getPoolCalls[i].factory.poolType,
        fee: getPoolCalls[i].fee,
      });
    }
  }

  if (validPools.length === 0) return [];

  // Step 2: Read slot0() and liquidity() for each pool
  const slot0Calls = validPools.map((p) => ({
    address: p.address,
    abi: poolAbi,
    functionName: "slot0" as const,
  }));

  const liquidityCalls = validPools.map((p) => ({
    address: p.address,
    abi: poolAbi,
    functionName: "liquidity" as const,
  }));

  const [slot0Results, liquidityResults] = await Promise.all([
    client.multicall({ contracts: slot0Calls, allowFailure: true }),
    client.multicall({ contracts: liquidityCalls, allowFailure: true }),
  ]);

  const pools: PoolInfo[] = [];
  for (let i = 0; i < validPools.length; i++) {
    const slot0 = slot0Results[i];
    const liq = liquidityResults[i];

    if (slot0.status !== "success" || liq.status !== "success") continue;

    const [sqrtPriceX96] = slot0.result as unknown as [bigint, ...unknown[]];
    const liquidity = liq.result as bigint;

    if (sqrtPriceX96 === 0n || liquidity === 0n) continue;

    pools.push({
      address: validPools[i].address,
      tokenIn,
      tokenOut,
      fee: validPools[i].fee,
      poolType: validPools[i].poolType,
      sqrtPriceX96,
      liquidity,
    });
  }

  return pools;
}
