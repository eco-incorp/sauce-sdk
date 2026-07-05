/**
 * Reproduce a REAL PancakeSwap Infinity CL pool's tick state inside the ETCHED genuine
 * Vault + CLPoolManager — NO fork. The Infinity analog of reproduce-v4-pool.ts: the same
 * baseline + disjoint-adjacent slab reconstruction (deriveSegments), with liquidity minted
 * through the InfinityLiquidityHelper (lock → lockAcquired → modifyLiquidity → sync/settle)
 * and the REAL packed 12+12 protocol fee reproduced through the genuine setProtocolFee path
 * (controller-slot poke). Verification reads back via the CLPoolManager's own getters keyed
 * by the LOCAL poolId.
 *
 * Token decimals are irrelevant to fidelity: CL swap math operates on sqrtPrice + L, so
 * initializing at the snapshot's sqrtPriceX96 and minting the snapshot's L at the snapshot's
 * ticks reproduces the exact curve regardless of token decimals.
 */

import type { Abi, Hex, PublicClient, WalletClient } from "viem";

import { deriveSegments, parseBoundaries } from "./reproduce-pool";
import {
  deployInfinityHelper,
  setInfinityProtocolFee,
  computeInfinityPoolIdLocal,
  encodeInfinityParams,
  getInfinitySlot0,
  getInfinityLiquidity,
  infinityHelperAbi,
  mint,
} from "./setup";
import { writeAndWait } from "./deploy";
import type { ProdInfinitySnapshot } from "./infinity-snapshot";

const ZERO_HOOKS = "0x0000000000000000000000000000000000000000" as Hex;

export interface ReproducedInfinityPool {
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
 * Reproduce `snap` on the (already-etched) Infinity singletons. Deploys a fresh helper bound
 * to the Vault + CLPoolManager, initializes the local hookless pool at the snapshot price,
 * reproduces the snapshot's packed protocol fee through the REAL setProtocolFee (controller
 * poke via `feeSetter`), funds the helper, and mints the baseline slab + per-segment
 * incremental slabs in batched locks.
 *
 * `token0`/`token1` are pre-deployed local tokens sorted token0 < token1 (mapped to the
 * snapshot's currency0/currency1). `fundAmount` must cover all owed amounts.
 */
export async function reproduceInfinityPool(
  walletClient: WalletClient,
  publicClient: PublicClient,
  testClient: { setStorageAt: (a: { address: Hex; index: Hex; value: Hex }) => Promise<void> },
  vault: Hex,
  clPoolManager: Hex,
  token0: Hex,
  token1: Hex,
  snap: ProdInfinitySnapshot,
  fundAmount: bigint,
  feeSetter: Hex,
): Promise<ReproducedInfinityPool> {
  const fee = snap.fee;
  const ts = snap.tickSpacing;
  const helper = await deployInfinityHelper(walletClient, publicClient, vault, clPoolManager);
  const key = {
    currency0: token0,
    currency1: token1,
    hooks: ZERO_HOOKS,
    poolManager: clPoolManager,
    fee,
    parameters: encodeInfinityParams(ts),
  };

  await writeAndWait(walletClient, publicClient, {
    address: helper, abi: infinityHelperAbi as Abi, functionName: "initialize",
    args: [key, BigInt(snap.sqrtPriceX96)],
  });

  // Reproduce the LIVE packed protocol fee through the genuine code path (nonzero on every
  // probed BSC pool — the solver/lens combine it live, so parity needs the real value).
  if (snap.protocolFee > 0) {
    await setInfinityProtocolFee(
      walletClient, publicClient, testClient, key, snap.protocolFee, feeSetter,
    );
  }

  // Fund the helper so it can settle every mint.
  await mint(walletClient, publicClient, token0, helper, fundAmount);
  await mint(walletClient, publicClient, token1, helper, fundAmount);

  const { segments, baseline, baselineClamped } = deriveSegments(snap);

  const positions: [number, number, bigint][] = [];
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
      address: helper, abi: infinityHelperAbi as Abi, functionName: "batchAddLiquidity",
      args: [key, chunk.map((p) => p[0]), chunk.map((p) => p[1]), chunk.map((p) => p[2])],
    });
  }

  const poolId = computeInfinityPoolIdLocal(token0, token1, fee, ts);
  return { poolId, helper, token0, token1, fee, tickSpacing: ts, positions, baseline, baselineClamped };
}

export interface InfinityReproductionDiff {
  sqrtPriceMatch: boolean;
  activeLiquidityMatch: boolean;
  protocolFeeMatch: boolean;
  lpFeeMatch: boolean;
  activeSnapshot: bigint;
  activeOnchain: bigint;
  ok: boolean;
}

/** Assert the reproduced pool's slot0 (price + fee words) + active liquidity match the snapshot. */
export async function verifyInfinityReproduction(
  publicClient: PublicClient,
  clPoolManager: Hex,
  repro: ReproducedInfinityPool,
  snap: ProdInfinitySnapshot,
): Promise<InfinityReproductionDiff> {
  const s = await getInfinitySlot0(publicClient, clPoolManager, repro.poolId);
  const activeOnchain = await getInfinityLiquidity(publicClient, clPoolManager, repro.poolId);
  const sqrtPriceMatch = s.sqrtPriceX96 === BigInt(snap.sqrtPriceX96);
  const activeSnapshot = BigInt(snap.liquidity);
  const activeLiquidityMatch = activeOnchain === activeSnapshot;
  const protocolFeeMatch = s.protocolFee === snap.protocolFee;
  const lpFeeMatch = s.lpFee === snap.lpFee;
  return {
    sqrtPriceMatch,
    activeLiquidityMatch,
    protocolFeeMatch,
    lpFeeMatch,
    activeSnapshot,
    activeOnchain,
    ok: sqrtPriceMatch && protocolFeeMatch && lpFeeMatch &&
      (activeLiquidityMatch || repro.baselineClamped),
  };
}
