/**
 * EcoSwap off-chain preparation.
 *
 * Builds the per-pool NET CACHE (the SWAP-drift-invariant tick depth the on-chain unified
 * walk reuses — liquidityNet survives any price move, but an LP mint/burn inside the scanned
 * window between prepare and cook goes stale: see EcoPool.windowTopShifted) for BOTH direct
 * pools and multi-hop route-leg pools. Every pool — direct
 * or leg — ships NO prepare-time sqrt edges: the on-chain solver walks each pool's single
 * frontier from its LIVE spot and computes all sqrt/price on the live grid, consulting the
 * cache only for the net at each scanned boundary (a staticcall avoided). The cache is a
 * pure gas optimization. A multi-hop route is a first-class live-walk venue: each leg is a
 * SET of leg pools (themselves full EcoPools with their own net caches) the leg splits
 * across; the on-chain solver composes the legs live, so prepare ships NO static route
 * segments (prepared.brackets is always []).
 *
 * Pipeline:
 *   1. Discover + read ALL direct pools via the on-chain LENS (ecoswap.lens.sauce.ts)
 *      in ONE read-only eth_call cook(): factory getPool/getPair discovery, live
 *      slot0/getReserves/StateView reads, and a windowed ticks()/getTickLiquidity
 *      scan — returned as raw words (see lens.ts). v1 covers V2Standard, V3Standard
 *      and hookless UniswapV4 only. The lens is the SINGLE SOURCE OF TRUTH for
 *      survivorship: it measures each pool's IN-RANGE capacity across the crossed
 *      ticks (not spot active-L), applies the relative-depth filter on-chain, and
 *      returns ONLY survivors (no absolute floor) — prepare never re-filters.
 *   2. Apply the top-N (deepest) cap — a calldata/loop bound, not a liquidity gate.
 *   3. Stamp each V3/V4 survivor's per-pool net cache from the lens reads
 *      (stampPoolCache): the stepRatio, the scanned-window bounds, the deepest
 *      initialized tick, and one [shiftedTick, rawNet] row per initialized tick.
 *      V2 needs no tick cache (the solver streams constant-L from live reserves).
 *   4. Routes: for each base token X (≠ in/out), one lens eth_call per edge —
 *      (in→X) and (X→out) — keeping ALL V3 survivor pools per leg (no best-pool
 *      reduce, no route cap). Each leg pool is stamped with its OWN net cache via
 *      stampPoolCache (using the LEG's hop direction zHop), so a leg pool is
 *      byte-identical on-chain to a direct pool and is walked LIVE by the solver.
 *      runLens is MEMOIZED per unordered token pair so shared edges read once.
 *
 * RPC efficiency: the entire direct-pool discovery + state + tick read is ONE
 * eth_call (the lens); multi-hop routes add at most one eth_call per distinct
 * (unordered) token-pair edge (memoized).
 */
import type { PublicClient, Hex } from "viem";
import { type ChainPoolConfig } from "../shared/constants.js";
import { type EcoSwapConfig, type EcoSwapPrepared } from "../shared/types.js";
/** Tuning knobs for off-chain preparation (overridable per call; mainly for tests). */
export interface EcoSwapPrepareOpts {
    /**
     * Drop pools whose IN-RANGE (windowed) capacity is below this many bps of the
     * Σ in-range capacity across alive pools (default DEFAULT_MIN_REL_BPS =
     * ECO_MIN_REL_BPS env or 100 = 1%). Set 0 to disable the filter and keep every
     * alive pool (used by cross-version split tests that intentionally mix
     * shallow-but-distinct AMM versions).
     */
    minRelBps?: number;
    /**
     * Override the lens HARD forward-tick gas ceiling (the clamp HI + outer loop bound;
     * default V3_TICK_STEPS = LENS_MAX_TICKS). Per-pool the lens scans effTicks =
     * clamp(bandTicks/max(1,ts), 96, maxTicks). Lets the adaptive EVM test deliberately
     * prepare a NARROW window so the prepared brackets under-fill amountIn — then the
     * always-on streaming walk resumes from the frontier seed to close the gap.
     */
    maxTicks?: number;
    /**
     * Override the target survivorship PRICE BAND in RAW ticks (default V3_BAND_TICKS =
     * LENS_BAND_TICKS). effTicks = clamp(bandTicks/max(1,ts), 96, maxTicks): a tight ts=1
     * (0.01% stable tier) pool gets many boundaries to cover the same % band a wide-ts pool
     * covers in a few, so its in-range-capacity survivorship metric + deactivation window is
     * a fixed price band. 0 ⇒ every pool floors at 96 (legacy fixed window).
     */
    bandTicks?: number;
    /**
     * Engine target for the on-chain LENS read (the discovery/state/tick eth_call cook).
     * DEFAULT "v12" — the production engine; the lens is now v12-native (its MEASURE-B
     * computation + return decode are verified on v12). The lens read is engine-agnostic in
     * VALUE (same survivors/header on either engine), so this only selects which engine the
     * read runs on; it MUST match the engine deployed at `lensCookEntry`. Set "v1" for the
     * legacy SauceRouter path.
     */
    lensTarget?: "v1" | "v12";
    /**
     * The account to simulate the read-only lens cook from. v1's SauceRouter.cook is open,
     * so the default sentinel works. On v12 the V12Pot.cook is owner-gated, so the read
     * MUST originate from the Pot owner — callers pass the cook caller here.
     */
    caller?: Hex;
    /**
     * Whole-trade slippage tolerance (bps) for the solver's INTERNAL amountOutMin floor
     * (defense-in-depth; the caller should still enforce its own min around cook()). The
     * floor is `minOut = expectedTotalOut * (10000 - slippageBps) / 10000`, where
     * expectedTotalOut is a CONSERVATIVE lower-bound estimate of the split's output — so it
     * NEVER false-reverts a legitimate wei-exact fill. Default DEFAULT_SLIPPAGE_BPS
     * (ECO_SLIPPAGE_BPS env or 50 = 0.5%). Set 0 to disable the internal floor (minOut 0 ⇒
     * byte-identical to the pre-floor solver behavior).
     */
    slippageBps?: number;
    /**
     * EXPLICIT whole-trade amountOutMin floor (wei of tokenOut) — when set, it OVERRIDES the
     * `slippageBps`-derived estimate entirely and is used as `minOut` verbatim. For a caller
     * that already computed its own minimum (e.g. from an external quote), or a test asserting
     * the floor fires. Unset ⇒ the estimate path (the normal defense-in-depth floor).
     */
    minOut?: bigint;
}
export declare function prepareEcoSwap(config: EcoSwapConfig, client: PublicClient, lensCookEntry: Hex, poolConfig?: ChainPoolConfig, opts?: EcoSwapPrepareOpts): Promise<EcoSwapPrepared>;
//# sourceMappingURL=prepare.d.ts.map