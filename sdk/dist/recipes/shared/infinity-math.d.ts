/**
 * PancakeSwap INFINITY CL — pure descriptor/key helpers (NO curve math on purpose).
 *
 * Infinity CL is a TICK-WALK universe member (the V4-class sibling): pools are VIRTUAL inside
 * the CLPoolManager singleton (funds inside the Vault), identified by
 * `PoolId = keccak256(abi.encode(PoolKey))` over the 6-field key
 * `{currency0, currency1, hooks, poolManager, fee, parameters}`. The micro-structure is
 * Uniswap-V4-identical (Q96 sqrt ratios, int24 ticks, drift-invariant liquidityNet), so the
 * entire bracket / frontier / oracle math is REUSED byte-identically — this module holds ONLY
 * what differs: the 6-field poolId derivation, the `parameters` bytes32 packing (CL tickSpacing
 * at bits [16..39], hook-callback bitmap in the low 16 bits), and the LIVE fee combine
 * (`swapFee = protocolFee + lpFee − protocolFee·lpFee/1e6`, protocolFee packed 12+12 bits per
 * direction — NONZERO on every probed BSC pool, so it MUST enter the pricing).
 *
 * All shapes verified on-chain against the BSC deployment (block ~108,123,094, 2026-07-04):
 * poolId reproduced exactly for USDT/Beat + BNB/CAKE + BNB/ASTER; getSlot0 = (sqrtPriceX96,
 * tick, protocolFee, lpFee) with protocolFee 131104 = 32|32 packed 12+12; getPoolTickInfo net
 * at word [1]; `poolIdToPoolKey(bytes32)` is a PUBLIC getter on the CLPoolManager (probed live —
 * discovery's reverse verification for hooked candidates). See the FactoryType.PancakeInfinityCL
 * doc in shared/constants.ts for the address book + integration notes.
 */
import { type Hex } from "viem";
/** `fee == 0x800000` ⇒ DYNAMIC LP fee (slot0 lpFee is hook-controlled; NOT readable from state —
 *  quoter-only, OUT of the tick walk / Tier C). */
export declare const INFINITY_DYNAMIC_FEE_FLAG = 8388608;
/** Low 16 bits of `parameters` = the hooks-callback registration bitmap (0 ⇔ hookless). */
export declare const INFINITY_HOOK_BITMAP_MASK = 65535n;
/**
 * `parameters` bitmap bits whose registration lets a hook ALTER swap/liquidity amounts
 * (beforeSwapReturnsDelta=10, afterSwapReturnsDelta=11, afterAddLiquidityReturnsDelta=12,
 * afterRemoveLiquidityReturnsDelta=13 — offsets per infinity-core ICLHooks.sol). A static-fee
 * hooked pool WITHOUT these bits is amount-deterministic (CLHooks.beforeSwap parses an lpFee
 * override ONLY for dynamic-fee pools — source-verified), i.e. tick-walkable; a pool WITH any
 * of them is not.
 */
export declare const INFINITY_RETURNS_DELTA_MASK = 15360n;
/**
 * Discovery fee sanity cap (ppm): the CL fee space is permissionless 0..100% and the BSC scan
 * carries thousands of ~99%-fee honeypot pools (979919 ×3.3k, 990000 ×1.9k, …) — any recovered
 * (Tier-B) key whose fee exceeds this is rejected. 10% — the Bin-side TEN_PERCENT_FEE cap,
 * comfortably above every legitimate observed CL tier (max legit observed 17068 ≈ 1.7%).
 */
export declare const INFINITY_MAX_FEE_PPM = 100000;
/**
 * The Tier-A (hookless, static-fee) CL preset menu — the DATA-DERIVED top JOINT
 * (fee, tickSpacing) pairs from the full BSC Initialize-event scan (86,622 CL pools, blocks
 * 48.0M→108.12M, cached init-logs-CL.json), restricted to hookless (hooks==0 &&
 * parameters&0xFFFF==0), static-fee (fee != 0x800000), sanity-capped (fee <= 2%) pools —
 * 15,268 of them. NOT a fee×ts cross-product: the venue's workhorse tiers are the
 * Binance-Alpha-lineage fees {67, 670, 335, 6722, …} at ts=1, which no derived-from-fee menu
 * would guess, while the Uniswap-canonical 500/10 (6 pools) and Pancake-V3 2500/50 (5 pools)
 * are essentially UNUSED here and are deliberately absent. Counts per pair (scan):
 *   (100,1)×5027 (67,1)×1874 (670,1)×1683 (335,1)×1195 (6722,1)×480 (16064,1)×240
 *   (1676,1)×219 (2011,1)×198 (0,1)×104 (3000,60)×89 (10000,200)×69
 * — 73% of the hookless fee-capped pool count in 11 probes, and 100% of the probed top-TVL
 * hookless pools (USDT/Beat 67/1, BNB/ASTER 67/1, USDT/JCT 67/1, USDT/RAVE 670/1).
 * Over-probing a dead combo is harmless (its getSlot0 reads sqrtPrice 0); each combo costs one
 * candidate row in discovery + the lens. Override per chain via `FactoryConfig.infinityPresets`.
 */
export declare const INFINITY_DEFAULT_CL_PRESETS: readonly {
    fee: number;
    tickSpacing: number;
}[];
/**
 * Pack a HOOKLESS CL `parameters` bytes32: tickSpacing (int24) at bits [16..39], hook bitmap
 * (low 16 bits) = 0, all higher bits 0 (the CLPoolManager's checkUnusedBitsAllZero requires it).
 * tickSpacing 1..32767 (int16-positive range — every real preset), so no sign handling needed.
 */
export declare function encodeInfinityCLParameters(tickSpacing: number): Hex;
/** CL tickSpacing from a `parameters` bytes32 — int24 at bits [16..39], sign-extended. */
export declare function decodeInfinityCLTickSpacing(parameters: Hex): number;
/** Hook-callback bitmap from a `parameters` bytes32 (low 16 bits; 0 ⇔ hookless). */
export declare function decodeInfinityHookBitmap(parameters: Hex): number;
/**
 * `PoolId = keccak256(abi.encode(PoolKey))` over the 6-field Infinity key (plain head-encode;
 * order matters). Reproduced on-chain 3/3 vs the BSC Initialize events (USDT/Beat
 * 0xb28420…92be, BNB/CAKE, BNB/ASTER).
 */
export declare function computeInfinityPoolId(currency0: Hex, currency1: Hex, hooks: Hex, poolManager: Hex, fee: number, parameters: Hex): Hex;
/**
 * The LIVE combined swap fee (ppm / hundredths-of-a-bip): the exact
 * ProtocolFeeLibrary.calculateSwapFee — `prot + lpFee − floor(prot·lpFee/1e6)` where `prot` is
 * the DIRECTION slice of the packed 12+12 protocolFee (`zeroForOne = pf & 0xfff`,
 * `oneForZero = pf >> 12`; the protocol fee is taken from the input FIRST, then the LP fee from
 * the remainder). Both words come from `getSlot0(id)` ([2] protocolFee, [3] lpFee). The on-chain
 * solver + lens compute this identically in SauceScript — this is the off-chain mirror
 * (discovery liveness stamps + the oracle's fee input).
 */
export declare function combineInfinityFee(protocolFee: number, lpFee: number, zeroForOne: boolean): number;
//# sourceMappingURL=infinity-math.d.ts.map