/**
 * Reproduce a REAL Uniswap-V4 pool's tick state inside the ETCHED PoolManager —
 * NO fork. The V4 analog of reproduce-pool.ts: same baseline + disjoint-adjacent
 * slab reconstruction (deriveSegments), but liquidity is minted through the V4
 * helper (initialize + unlock/modifyLiquidity/settle) rather than a V3 pool's
 * mint(). Verification reads back via the StateView lens keyed by the LOCAL poolId.
 *
 * Token decimals are irrelevant to fidelity: V4 swap math operates on sqrtPrice +
 * L, so initialising at the snapshot's sqrtPriceX96 and minting the snapshot's L
 * at the snapshot's ticks reproduces the exact curve regardless of token decimals.
 */

import type { Hex, PublicClient, WalletClient } from "viem";

import { deriveSegments, parseBoundaries } from "./reproduce-pool";
import {
  deployV4Helper,
  setupV4Pool, // not used directly; kept for symmetry of exports
  mint,
  computeV4PoolId,
  getV4Slot0,
  getV4Liquidity,
  v4HelperAbi,
} from "./setup";
import { writeAndWait } from "./deploy";
import type { ProdV4Snapshot } from "./v4-snapshot";
import type { Abi, Account } from "viem";

void setupV4Pool;

const ZERO_HOOKS = "0x0000000000000000000000000000000000000000" as Hex;

export interface ReproducedV4Pool {
  poolId: Hex;
  helper: Hex;
  token0: Hex;
  token1: Hex;
  fee: number;
  tickSpacing: number;
  positions: [number, number, bigint][];
  baseline: bigint;
  baselineClamped: boolean;
}

/**
 * Reproduce `snap` on the (already-etched) V4 PoolManager. Deploys a fresh helper
 * bound to the manager, initialises the local pool at the snapshot price, funds the
 * helper, and mints the baseline slab + per-segment incremental slabs.
 *
 * `token0`/`token1` are pre-deployed local tokens sorted token0 < token1 (mapped to
 * the snapshot's currency0/currency1). `fundAmount` must cover all owed amounts.
 */
export async function reproduceV4Pool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  poolManager: Hex,
  token0: Hex,
  token1: Hex,
  snap: ProdV4Snapshot,
  fundAmount: bigint,
  minter?: Account,
): Promise<ReproducedV4Pool> {
  const fee = snap.fee;
  const ts = snap.tickSpacing;
  const helper = await deployV4Helper(walletClient, publicClient, poolManager);
  const key = { currency0: token0, currency1: token1, fee, tickSpacing: ts, hooks: ZERO_HOOKS };

  await writeAndWait(walletClient, publicClient, {
    address: helper, abi: v4HelperAbi as Abi, functionName: "initialize",
    args: [key, BigInt(snap.sqrtPriceX96)], account: minter,
  });

  // Fund the helper so it can settle every mint.
  await mint(walletClient, publicClient, token0, helper, fundAmount);
  await mint(walletClient, publicClient, token1, helper, fundAmount);

  const { segments, baseline, baselineClamped } = deriveSegments(snap);

  // Build the full position set, then add it all in BATCHED unlocks (one tx per
  // chunk) instead of one unlock tx per boundary.
  const positions: [number, number, bigint][] = [];

  // Baseline slab, placed one tickSpacing OUTSIDE the snapshot boundary set so its
  // own net contributions never collide with a snapshot boundary (see reproduce-pool).
  const bnds = parseBoundaries(snap);
  const lo0 = bnds[0].tick - ts;
  const hiN = bnds[bnds.length - 1].tick + ts;
  if (baseline > 0n) positions.push([lo0, hiN, baseline]);

  for (const seg of segments) {
    const incr = seg.level - baseline;
    if (incr > 0n) positions.push([seg.lo, seg.hi, incr]);
  }

  const CHUNK = 100;
  for (let i = 0; i < positions.length; i += CHUNK) {
    const chunk = positions.slice(i, i + CHUNK);
    await writeAndWait(walletClient, publicClient, {
      address: helper, abi: v4HelperAbi as Abi, functionName: "batchAddLiquidity",
      args: [key, chunk.map((p) => p[0]), chunk.map((p) => p[1]), chunk.map((p) => p[2])],
      account: minter,
    });
  }

  const poolId = computeV4PoolId(token0, token1, fee, ts);
  return { poolId, helper, token0, token1, fee, tickSpacing: ts, positions, baseline, baselineClamped };
}

export interface V4ReproductionDiff {
  sqrtPriceMatch: boolean;
  activeLiquidityMatch: boolean;
  activeSnapshot: bigint;
  activeOnchain: bigint;
  ok: boolean;
}

/** Assert the reproduced V4 pool's slot0 price + active liquidity match the snapshot. */
export async function verifyV4Reproduction(
  publicClient: PublicClient,
  stateView: Hex,
  repro: ReproducedV4Pool,
  snap: ProdV4Snapshot,
): Promise<V4ReproductionDiff> {
  const { sqrtPriceX96 } = await getV4Slot0(publicClient, stateView, repro.poolId);
  const activeOnchain = await getV4Liquidity(publicClient, stateView, repro.poolId);
  const sqrtPriceMatch = sqrtPriceX96 === BigInt(snap.sqrtPriceX96);
  const activeSnapshot = BigInt(snap.liquidity);
  const activeLiquidityMatch = activeOnchain === activeSnapshot;
  return {
    sqrtPriceMatch,
    activeLiquidityMatch,
    activeSnapshot,
    activeOnchain,
    ok: sqrtPriceMatch && (activeLiquidityMatch || repro.baselineClamped),
  };
}
