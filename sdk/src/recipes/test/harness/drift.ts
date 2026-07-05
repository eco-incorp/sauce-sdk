/**
 * Drift a pool's LIVE price between an EcoSwap prepare() and the real cook().
 *
 * The prod-mirror tests reconstruct a pool, prepare()+compile() the recipe (which
 * snapshots pool state off-chain), and normally cook() immediately — so the live
 * state at execution == the prepared state and Phase B's runtime re-anchoring is a
 * no-op. To exercise the re-anchoring, `driftPoolPrice` moves a pool's price with a
 * real swap routed through the engine (same paths the recipe uses → all V3/V4
 * callbacks + V2 transfers handled), AFTER prepare() but BEFORE the real cook().
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";

import { compileSauce, ECOSWAP_DIR } from "./compile";
import { cook } from "./cook";
import { approve, mint } from "./setup";
import type { HarnessClients } from "./clients";
import type { EcoPool } from "../../shared/types";
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO } from "../../shared/constants";

const HARNESS = dirname(fileURLToPath(import.meta.url));
const DRIFT_SRC = readFileSync(join(HARNESS, "drift.sauce.ts"), "utf-8");

/** Same 10-field tuple ecoswap/index.ts buildPoolTuple emits (kept in sync). */
function poolTuple(p: EcoPool): bigint[] {
  return [
    BigInt(p.poolType),
    BigInt(p.address),
    BigInt(p.fee),
    BigInt(p.tickSpacing),
    BigInt(p.hooks),
    BigInt(p.feePpm),
    p.isV2 ? 1n : 0n,
    p.inIsToken0 ? 1n : 0n,
    BigInt(p.stateView),
    BigInt(p.poolId),
  ];
}

/**
 * Move `pool`'s live price by routing a zeroForOne exact-input swap of `amountIn`
 * tokenIn through it via the engine. Mints+approves the caller for `amountIn`,
 * compiles+cooks the one-swap drift sauce, and throws if it reverts.
 *
 * Direction is always tokenIn→tokenOut (the recipe's swap direction), so it pushes
 * the pool's price DOWN — toward (or past) the solver's cut — which is the case
 * that meaningfully changes the recipe's runtime fill for that pool.
 *
 * `priceLimitOverride` pins the swap's sqrt price limit (else the direction extreme).
 * Pass the EXACT sqrtRatio at a tickSpacing-aligned target with a large `amountIn` to
 * land the pool PRECISELY on that tick boundary — the deterministic way to drift to a
 * ts-aligned live tick (so the up→dn handoff lands on the lattice, no per-segment seam).
 */
export async function driftPoolPrice(
  c: HarnessClients,
  sauceRouter: Hex,
  pool: EcoPool,
  tokenIn: Hex,
  tokenOut: Hex,
  zeroForOne: boolean,
  amountIn: bigint,
  caller: Hex,
  priceLimitOverride?: bigint,
  /** PancakeSwap Infinity Vault — REQUIRED for a pType-9 (Infinity CL) pool; ignored otherwise. */
  infinityVault?: Hex,
): Promise<void> {
  const priceLimit =
    priceLimitOverride ?? (zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n);
  await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
  await approve(c.walletClient, c.publicClient, tokenIn, sauceRouter, amountIn);

  const { bytecodes, warnings } = compileSauce(
    DRIFT_SRC,
    [
      BigInt(tokenIn),
      BigInt(tokenOut),
      amountIn,
      BigInt(caller),
      zeroForOne ? 1n : 0n,
      priceLimit,
      poolTuple(pool),
      infinityVault ? BigInt(infinityVault) : 0n,
    ],
    ECOSWAP_DIR,
  );
  if (warnings.length) {
    throw new Error("drift.sauce compiled with warnings: " + JSON.stringify(warnings));
  }

  const { receipt } = await cook(c.walletClient, c.publicClient, sauceRouter, bytecodes);
  if (receipt.status !== "success") throw new Error("drift swap reverted");
}
