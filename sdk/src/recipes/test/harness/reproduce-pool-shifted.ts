/**
 * SHIFTED slab-stack pool reconstruction — a sibling of reproduce-pool.ts for
 * snapshots whose liquidityNet PREFIX SUM dips NEGATIVE inside the window.
 *
 * reproducePool (the original) mints one wide baseline slab plus, per segment
 * [b_j, b_{j+1}), an incremental slab of prefix[j] — which is only representable
 * when prefix[j] >= 0 for every j (positions cannot carry negative liquidity; a
 * negative prefix segment silently DROPS its slab, mis-reproducing up to a handful
 * of boundary nets). Real profiles usually satisfy that ("onion" LP books), and
 * every pre-existing prod-mirror snapshot does — but the BSC THENA Integral
 * WBNB/USDT pool does NOT (its prefix dips to −2.79e20 mid-window: positions open
 * below the window bottom and close inside it), which showed up as 5 mismatched
 * boundary nets under the original scheme.
 *
 * THE SHIFTED SCHEME (exact for any profile with baseline >= shift):
 *   shift = max(0, −min_j prefix[j])
 *   1. wide slab   [b_0 − ts, b_N + ts]  at (baseline − shift)
 *   2. left-corrector [b_0 − ts, b_0]    at shift
 *   3. per segment [b_j, b_{j+1}]        at (prefix[j] + shift)   (all >= 0 now)
 * Every interior boundary's net is (prefix[j]+shift) − (prefix[j−1]+shift) = net_j
 * EXACTLY; the left-corrector's −shift at b_0 cancels the +shift the first segment
 * slab adds there, so b_0 is EXACT too (the corrector's +shift start lands on the
 * non-boundary window edge b_0 − ts, where it merely restores the below-window
 * level to `baseline` — MORE faithful than the original scheme's baseline−0).
 * Active liquidity on every in-window segment is (baseline−shift) + (prefix[j]+shift)
 * = baseline + prefix[j] — exact, including at the live tick. The right-edge
 * boundary b_N keeps the SAME documented truncation artifact as the original
 * (verifyReproduction already tolerates it).
 *
 * With shift = 0 this degenerates to EXACTLY the original construction (the
 * corrector vanishes), so it is safe for any snapshot; it lives in its own module
 * (not folded into reproduce-pool.ts) so the checked-in anvil-state blobs of the
 * pre-existing prod-mirror lanes are untouched.
 *
 * `baseline < shift` (a window so truncated that the below-window level cannot
 * absorb the dip) clamps the wide slab to 0 and flags `baselineClamped`, exactly
 * like the original's negative-baseline clamp.
 */

import { parseAbi, type Abi, type Account, type Hex, type PublicClient, type WalletClient } from "viem";

import {
  deployToken,
  createAndInitPool,
  batchMintPositions,
} from "./setup";
import { writeAndWait } from "./deploy";
import { parseBoundaries, type ReproducedPool } from "./reproduce-pool";
import type { ProdPoolSnapshot } from "./prod-snapshot";

const v3FactoryFeeAbi = parseAbi([
  "function feeAmountTickSpacing(uint24 fee) view returns (int24)",
  "function enableFeeAmount(uint24 fee, int24 tickSpacing)",
]);

/**
 * Reproduce `snap` on a fresh local stack with the SHIFTED slab-stack (see header).
 * Same signature + return shape as reproducePool, so verifyReproduction and the
 * prod-mirror manifests consume the result unchanged.
 */
export async function reproducePoolShifted(
  walletClient: WalletClient,
  publicClient: PublicClient,
  factory: Hex,
  helper: Hex,
  snap: ProdPoolSnapshot,
  fundAmount: bigint,
  minter?: Account,
  tokens?: { token0: Hex; token1: Hex },
): Promise<ReproducedPool> {
  const ts = snap.tickSpacing;
  const fee = snap.fee;

  // Sorted local pair (or the caller's pre-deployed one), as in reproducePool.
  let token0: Hex;
  let token1: Hex;
  if (tokens) {
    token0 = tokens.token0;
    token1 = tokens.token1;
  } else {
    const a = await deployToken(walletClient, publicClient, snap.symbol0, snap.symbol0, snap.decimals0);
    const b = await deployToken(walletClient, publicClient, snap.symbol1, snap.symbol1, snap.decimals1);
    [token0, token1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  }

  // Enable the snapshot's (possibly non-standard, e.g. a live Algebra dynamic) fee
  // tier if the factory doesn't carry it yet.
  const existingTs = (await publicClient.readContract({
    address: factory,
    abi: v3FactoryFeeAbi as Abi,
    functionName: "feeAmountTickSpacing",
    args: [fee],
  })) as number;
  if (Number(existingTs) === 0) {
    await writeAndWait(walletClient, publicClient, {
      address: factory,
      abi: v3FactoryFeeAbi as Abi,
      functionName: "enableFeeAmount",
      args: [fee, ts],
      account: minter,
    });
  }

  const pool = await createAndInitPool(
    walletClient,
    publicClient,
    factory,
    token0,
    token1,
    fee,
    BigInt(snap.sqrtPriceX96),
  );

  // ── Shifted slab derivation ────────────────────────────────
  const bnds = parseBoundaries(snap);
  if (bnds.length < 2) {
    throw new Error(`snapshot needs >=2 initialized boundaries to reconstruct (got ${bnds.length})`);
  }
  const L_active = BigInt(snap.liquidity);

  const prefix: bigint[] = [];
  let acc = 0n;
  for (const b of bnds) {
    acc += b.net;
    prefix.push(acc);
  }

  let c = -1;
  for (let j = 0; j < bnds.length; j++) {
    if (bnds[j].tick <= snap.tick) c = j;
    else break;
  }
  const baseline = L_active - (c >= 0 ? prefix[c] : 0n);

  let minPrefix = 0n;
  for (const p of prefix) if (p < minPrefix) minPrefix = p;
  const shift = -minPrefix; // >= 0

  // Clamp exactly like the original: a wide slab cannot be negative.
  let wide = baseline - shift;
  let baselineClamped = false;
  if (wide < 0n) {
    wide = 0n;
    baselineClamped = true;
  }

  const lo0 = bnds[0].tick - ts;
  const hiN = bnds[bnds.length - 1].tick + ts;
  const positions: [number, number, bigint][] = [];
  if (wide > 0n) positions.push([lo0, hiN, wide]);
  // Left-corrector: cancels the +shift the first segment slab adds at b_0 (and
  // restores the below-window level to `baseline`). Vanishes when shift == 0.
  if (shift > 0n) positions.push([lo0, bnds[0].tick, shift]);
  for (let j = 0; j < bnds.length - 1; j++) {
    const incr = prefix[j] + shift;
    if (incr > 0n) positions.push([bnds[j].tick, bnds[j + 1].tick, incr]);
  }

  const who = (minter?.address ?? walletClient.account?.address) as Hex;
  await batchMintPositions(
    walletClient, publicClient, helper, pool, who, token0, token1, fundAmount, positions, 100, minter,
  );

  return { pool, token0, token1, fee, tickSpacing: ts, positions, baseline, baselineClamped };
}
