/**
 * Reproduce a real Uniswap-V3 pool's tick state on a fresh local stack — NO
 * network. Given a captured `ProdPoolSnapshot` (see prod-snapshot.ts) and the
 * already-deployed harness primitives, it deploys two local tokens ordered to
 * match the snapshot, creates+initialises the pool at the snapshot price, and
 * rebuilds the liquidity profile by minting disjoint adjacent positions.
 *
 * RECONSTRUCTION ALGORITHM
 * ────────────────────────
 * A Uniswap-V3 pool's active liquidity as a function of tick is a staircase:
 * crossing an initialized boundary `b` left→right adds `liquidityNet(b)` to the
 * active level. So if the snapshot's initialized boundaries are sorted ascending
 *   b_0 < b_1 < ... < b_{n-1}   with nets  net_0, net_1, ...
 * then the active liquidity on the half-open segment to the RIGHT of b_j, i.e.
 * [b_j, b_{j+1}), is
 *   level(j) = baseline + Σ_{k=0..j} net_k
 * where `baseline` is the (unknown) active liquidity BELOW b_0. We pin `baseline`
 * so that the segment containing the snapshot's current tick has level ==
 * snapshot active `liquidity()`:
 *   let c = index of the segment holding `tick` (largest j with b_j <= tick;
 *           -1 if tick is below b_0 → the baseline segment itself).
 *   baseline = L_active − Σ_{k=0..c} net_k        (Σ over empty set = 0 when c=-1)
 *
 * We mint ONE position per adjacent boundary pair [b_j, b_{j+1}] carrying the
 * INCREMENT over the baseline, i.e. amount = level(j) − baseline = prefix[j]
 * (skipping any segment whose level ≤ 0), plus a single wide BASELINE slab. The
 * baseline slab is minted on [b_0 − tickSpacing, b_{n-1} + tickSpacing] — one
 * tickSpacing OUTSIDE the snapshot's boundary set — so its own net contributions
 * land on ticks that are NOT snapshot boundaries and never collide with them.
 * Because the per-segment slabs are DISJOINT and ADJACENT, on each segment the
 * summed on-chain active liquidity is baseline + prefix[j] = level(j), and:
 *   - at every INTERIOR snapshot boundary b_j (0 < j < n-1) the on-chain
 *     liquidityNet == prefix[j] − prefix[j-1] == net_j  (exact), and
 *   - at b_0 the on-chain net == prefix[0] == net_0     (exact; the baseline slab
 *     starts a tickSpacing below, not here).
 * The initialize() call sets sqrtPriceX96 exactly.
 *
 * FIDELITY BOUNDS / LIMITATIONS
 *   - The snapshot is a WINDOW (±N tickSpacings). `baseline` is the active
 *     liquidity at the window's left edge; liquidity below the window is folded
 *     into the wide baseline slab so the active level is correct THROUGHOUT the
 *     window even where the staircase dips. Verification asserts only WITHIN the
 *     window.
 *   - The RIGHT-edge boundary b_{n-1} is a truncation artifact: there is no
 *     segment beyond it locally, so its on-chain net == −prefix[n-2], which
 *     equals the snapshot net_{n-1} only if the window's cumulative net is zero
 *     at the edge (i.e. no liquidity opens beyond the window). verifyReproduction
 *     therefore checks every INTERIOR boundary + b_0 exactly, and reports the
 *     right-edge boundary separately as a (non-fatal) truncation diff.
 *   - If `baseline < 0` (window nets over-explain L_active — only with a
 *     truncated/inconsistent window) we clamp baseline to 0 and report the
 *     active-liquidity diff rather than asserting an exact match.
 *   - Segments with level ≤ 0 are skipped (V3 cannot hold negative liquidity).
 */

import type { Account, Hex, PublicClient, WalletClient } from "viem";

import {
  createAndInitPool,
  deployToken,
  batchMintPositions,
  getSlot0,
  getLiquidity,
  getTickLiquidityNet,
  v3FactoryAbi,
} from "./setup";
import { writeAndWait } from "./deploy";
import type { ProdPoolSnapshot } from "./prod-snapshot";
import type { Abi } from "viem";

export interface ReproducedPool {
  pool: Hex;
  token0: Hex;
  token1: Hex;
  fee: number;
  tickSpacing: number;
  /** Segments minted: [lo, hi, liquidity]. */
  positions: [number, number, bigint][];
  /** Baseline active liquidity below the lowest boundary (clamped ≥ 0). */
  baseline: bigint;
  /** True if baseline had to be clamped from a negative value (truncation). */
  baselineClamped: boolean;
}

export interface Segment {
  lo: number;
  hi: number;
  level: bigint;
}

/** Parse the snapshot's `ticks` into ascending {tick, net} with bigint nets. */
export function parseBoundaries(snap: ProdPoolSnapshot): { tick: number; net: bigint }[] {
  return snap.ticks
    .map(([t, net]) => ({ tick: t, net: BigInt(net) }))
    .sort((a, b) => a.tick - b.tick);
}

/**
 * Derive the per-segment target active-liquidity levels and the baseline.
 * Returns the segments (adjacent boundary pairs), the chosen baseline (clamped
 * ≥ 0), and whether clamping occurred.
 */
export function deriveSegments(snap: ProdPoolSnapshot): {
  segments: Segment[];
  baseline: bigint;
  baselineClamped: boolean;
} {
  const bnds = parseBoundaries(snap);
  if (bnds.length < 2) {
    throw new Error(`snapshot needs >=2 initialized boundaries to reconstruct (got ${bnds.length})`);
  }
  const L_active = BigInt(snap.liquidity);

  // prefix[j] = Σ_{k=0..j} net_k
  const prefix: bigint[] = [];
  let acc = 0n;
  for (const b of bnds) {
    acc += b.net;
    prefix.push(acc);
  }

  // c = largest j with b_j <= tick (segment holding the current tick); -1 if the
  // tick sits below the lowest boundary.
  let c = -1;
  for (let j = 0; j < bnds.length; j++) {
    if (bnds[j].tick <= snap.tick) c = j;
    else break;
  }
  const sumToC = c >= 0 ? prefix[c] : 0n;
  let baseline = L_active - sumToC;
  let baselineClamped = false;
  if (baseline < 0n) {
    baseline = 0n;
    baselineClamped = true;
  }

  // level(j) = baseline + prefix[j], for the segment [b_j, b_{j+1}).
  const segments: Segment[] = [];
  for (let j = 0; j < bnds.length - 1; j++) {
    const level = baseline + prefix[j];
    segments.push({ lo: bnds[j].tick, hi: bnds[j + 1].tick, level });
  }
  return { segments, baseline, baselineClamped };
}

/**
 * Reproduce `snap` on a fresh local stack. `factory`/`helper` come from
 * deployStack; `minter` funds + provides liquidity (defaults to the wallet's
 * own account). If the snapshot's fee tier isn't enabled on the factory by
 * default (only 500/3000/10000 are), it is enabled first as the factory owner
 * (the deployer == walletClient.account).
 *
 * `tokens` lets a caller supply a PRE-DEPLOYED, already-sorted (token0 < token1)
 * pair instead of deploying fresh ones — used by the combined V2+V3+V4 prod-mirror
 * test so all three reproduced pools share ONE token pair (decimals are irrelevant
 * to fidelity: V3 math is over sqrtPrice + L, which we install from the snapshot).
 */
export async function reproducePool(
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

  // Use the supplied sorted pair, or deploy two local tokens ordered so
  // token0 < token1 (matching the snapshot's canonical orientation).
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

  // Enable the fee tier if the factory doesn't already have a tickSpacing for it.
  const existingTs = (await publicClient.readContract({
    address: factory,
    abi: v3FactoryAbi as Abi,
    functionName: "feeAmountTickSpacing",
    args: [fee],
  })) as number;
  if (Number(existingTs) === 0) {
    await writeAndWait(walletClient, publicClient, {
      address: factory,
      abi: v3FactoryAbi as Abi,
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

  const { segments, baseline, baselineClamped } = deriveSegments(snap);

  // Build the full position set, then mint it in a few BATCHED txs (the helper pays
  // from its own funded balance). One tx per position would be ~N round-trips — for
  // a real pool's hundreds of boundaries that is the ~10-min reconstruction cost.
  const positions: [number, number, bigint][] = [];

  // Baseline slab: one wide position spanning the window, placed one tickSpacing
  // OUTSIDE the snapshot's boundary set so its own +baseline/−baseline net
  // contributions land on ticks that are NOT snapshot boundaries (keeping every
  // snapshot boundary's net clean). Covers liquidity below the window edge.
  const bnds = parseBoundaries(snap);
  const lo0 = bnds[0].tick - ts;
  const hiN = bnds[bnds.length - 1].tick + ts;
  if (baseline > 0n) positions.push([lo0, hiN, baseline]);

  // Per-segment incremental slabs. The disjoint-adjacent slab for [lo,hi] carries
  // (level − baseline) = prefix[j], i.e. only the part ABOVE the baseline slab,
  // so that the summed on-chain active level on the segment equals level(j).
  for (const seg of segments) {
    const incr = seg.level - baseline;
    if (incr > 0n) positions.push([seg.lo, seg.hi, incr]);
  }

  const who = (minter?.address ?? walletClient.account?.address) as Hex;
  await batchMintPositions(
    walletClient, publicClient, helper, pool, who, token0, token1, fundAmount, positions, 100, minter,
  );

  return { pool, token0, token1, fee, tickSpacing: ts, positions, baseline, baselineClamped };
}

// ── Verification ─────────────────────────────────────────────

export interface ReproductionDiff {
  /** slot0 sqrtPriceX96: snapshot vs on-chain (must be exact). */
  sqrtPriceMatch: boolean;
  sqrtSnapshot: bigint;
  sqrtOnchain: bigint;
  /** Active liquidity at the live tick: snapshot vs on-chain. */
  activeLiquidityMatch: boolean;
  activeSnapshot: bigint;
  activeOnchain: bigint;
  /** Interior + b_0 boundary liquidityNet diffs (only mismatches are listed). */
  netMismatches: { tick: number; snapshot: bigint; onchain: bigint }[];
  /**
   * Right-edge boundary diff, reported separately as a documented truncation
   * artifact (see header). Non-fatal. null if it happened to match exactly.
   */
  rightEdgeArtifact: { tick: number; snapshot: bigint; onchain: bigint } | null;
  /** Count of boundaries checked (interior + b_0). */
  boundariesChecked: number;
  /** Overall pass (sqrt exact + active exact within window + interior nets match). */
  ok: boolean;
}

/**
 * Assert the reproduced pool matches the snapshot. Reads slot0, active
 * liquidity, and every snapshot boundary's on-chain liquidityNet, returning a
 * structured diff. `sqrtPriceX96` and per-boundary `liquidityNet` must match
 * exactly; active liquidity must match exactly UNLESS the baseline was clamped
 * (truncated window) — in which case the active diff is reported but not fatal.
 */
export async function verifyReproduction(
  publicClient: PublicClient,
  pool: Hex,
  snap: ProdPoolSnapshot,
  opts: { baselineClamped?: boolean } = {},
): Promise<ReproductionDiff> {
  const { sqrtPriceX96: sqrtOnchain } = await getSlot0(publicClient, pool);
  const sqrtSnapshot = BigInt(snap.sqrtPriceX96);
  const sqrtPriceMatch = sqrtOnchain === sqrtSnapshot;

  const activeOnchain = await getLiquidity(publicClient, pool);
  const activeSnapshot = BigInt(snap.liquidity);
  const activeLiquidityMatch = activeOnchain === activeSnapshot;

  const bnds = parseBoundaries(snap);
  const lastIdx = bnds.length - 1;
  const netMismatches: { tick: number; snapshot: bigint; onchain: bigint }[] = [];
  let rightEdgeArtifact: { tick: number; snapshot: bigint; onchain: bigint } | null = null;
  let boundariesChecked = 0;
  for (let i = 0; i < bnds.length; i++) {
    const b = bnds[i];
    const onchain = await getTickLiquidityNet(publicClient, pool, b.tick);
    if (i === lastIdx) {
      // Right-edge boundary: a window truncation artifact (no segment beyond it
      // locally). Report it but do not treat a mismatch as failure.
      if (onchain.liquidityNet !== b.net) {
        rightEdgeArtifact = { tick: b.tick, snapshot: b.net, onchain: onchain.liquidityNet };
      }
      continue;
    }
    boundariesChecked++;
    if (onchain.liquidityNet !== b.net) {
      netMismatches.push({ tick: b.tick, snapshot: b.net, onchain: onchain.liquidityNet });
    }
  }

  const ok =
    sqrtPriceMatch &&
    (activeLiquidityMatch || !!opts.baselineClamped) &&
    netMismatches.length === 0;

  return {
    sqrtPriceMatch,
    sqrtSnapshot,
    sqrtOnchain,
    activeLiquidityMatch,
    activeSnapshot,
    activeOnchain,
    netMismatches,
    rightEdgeArtifact,
    boundariesChecked,
    ok,
  };
}
