/**
 * EcoSwap on-chain prepare LENS — off-chain caller + decoder.
 *
 * Compiles ecoswap.lens.sauce.ts, invokes it through the engine via ONE read-only
 * eth_call `cook(bytes[])` (viem simulateContract — the pattern in
 * dev-tools/test/e2e.test.ts:147-164), and decodes the returned raw reads.
 *
 * The lens collapses what used to be ~100 discovery/state/tick RPCs into ONE
 * eth_call. It returns ONLY raw reads; bracket build + sort + water-fill + trim +
 * route composition stay in prepare.ts.
 *
 * Return shape (must mirror ecoswap.lens.sauce.ts EXACTLY):
 *   abi.encode(poolBlob: bytes, tickBlob: bytes)
 *   poolBlob = a 4-word HEADER [discoveredCount, survivorCount, totalCap, capFloor]
 *              followed by survivorCount × 13-word pool rows
 *              [type,addr,fee,tickSpacing,hooks,sqrtP,liq,tickRaw,inIsToken0,stateView,poolId,scannedForward,scannedReverse]
 *   tickBlob = 3 words/row:   [poolIdx, tickIndexRaw, liquidityNetRaw]
 * The lens is the SINGLE SOURCE OF TRUTH for survivorship: it only emits pool rows
 * whose IN-RANGE (windowed) capacity clears the relative-depth floor — measured
 * across the crossed ticks, not spot active-L — so the consumer never re-filters.
 * Signed words (tickRaw int24, tickIndexRaw int24, liquidityNetRaw int128) are
 * ZERO-extended on return; reinterpreted here via BigInt.asIntN.
 *
 * v2 (LAZY): the lens reads ONLY the ticks the trade can cross, not a fixed 96
 * window. Each survivor's poolBlob carries `scannedForward` AND `scannedReverse`
 * — the number of tick boundaries the lens actually walked in the swap direction
 * and on the opposite (drift) side of spot. buildV3Brackets walks EXACTLY these
 * counts (never past the lens's data, so it never fabricates phantom brackets):
 * `scannedForward` forward brackets (the swap path) plus `scannedReverse` reverse
 * brackets ABOVE spot (capacity-0; consumed only by Phase B when the live price
 * has drifted against the swap between prepare and execution).
 */
import { type PublicClient, type Hex } from "viem";
import { SwapPoolType, type ChainPoolConfig } from "../shared/constants.js";
/**
 * Legacy per-pool forward-tick window (the clamp LO). A wide-ts pool (ts>=10 → every
 * standard tier except the 0.01%/ts=1 stable tier) floors here, so it is byte-identical
 * to the prior fixed 96-tick window — no regression, wei-exact preserved for those tiers
 * by construction. Exported so callers/tests can reference the floor.
 */
export declare const LENS_WINDOW_LO = 96;
/**
 * HARD per-pool gas ceiling on forward tick reads (the clamp HI + the lens outer loop
 * bound). A ts=1 pool can walk up to this many boundaries to cover the target price band.
 * 256 raw ticks at ts=1 ≈ a 2.6% band (1.0001^256 ≈ 1.0259); the lens's per-pool staticcall
 * cost is bounded by this even for the tightest tier. Chosen so the whole read stays under a
 * live RPC's eth_call gas cap (measured ≈503M gas on v1 — the heavier engine — on the heavy
 * 10-pool prod-mirror universe with 2 ts=1 pools, vs ≈234M at the legacy fixed-96 window;
 * production runs on v12 whose Huff-runtime lens read is far cheaper; both under Alchemy's
 * ~550M cap. See harness/lens-gas-probe.ts.) Override via opts.maxTicks / the
 * LensCallParams.maxTicks (a live RPC with a lower cap can lower it; a wider band never helps
 * — the in-range-capacity Σ CONVERGES by ≈192 ticks on the real Base WETH/USDC universe).
 */
export declare const LENS_MAX_TICKS = 256;
/**
 * Target survivorship PRICE BAND in RAW ticks. effTicks(ts) = clamp(bandTicks/max(1,ts),
 * LO, HI). 256 raw ticks ≈ a 2.6% price band: a ts=1 (0.01% stable tier) pool gets
 * clamp(256,96,256)=256 ticks, a ts=10 pool gets clamp(25,96,256)=96 (== legacy), every
 * wider tier floors at 96. So a deep tight-ts stable pool is measured across the SAME % band
 * as the volatile tiers and is no longer under-measured/dropped for an arbitrary tick-count
 * reason. Verified on the real Base WETH/USDC universe: the Pancake 0.01% (ts=1) pool's true
 * in-range capacity — ≈1.0% of Σ at the old 96 window, so a v1/v12-engine knife-edge — is
 * FULLY captured by ≈192 ticks (its Σ share stops growing), lifting it to a clean survivor on
 * BOTH engines. 256 leaves margin above that convergence point while staying gas-bounded.
 */
export declare const LENS_BAND_TICKS = 256;
/** One discovered direct pool, decoded from the lens poolBlob. */
export interface LensPool {
    poolType: SwapPoolType;
    address: Hex;
    fee: number;
    tickSpacing: number;
    hooks: Hex;
    sqrtPriceX96: bigint;
    liquidity: bigint;
    /** Signed current tick (asIntN(24)). 0 for V2. */
    tick: number;
    /** V2 only: tokenIn is pool.token0. */
    inIsToken0: boolean;
    /** V4 only. */
    stateView: Hex;
    poolId: Hex;
    /** liquidityNet keyed by tick boundary (signed), for the scanned window. V3/V4 only. */
    net: Map<number, bigint>;
    /**
     * Number of FORWARD tick boundaries the lens actually walked (lazy). The off-
     * chain bracket build must STOP at this — never walk past the lens's data.
     * 0 for V2 and for dust pools the lens chose not to scan.
     */
    scannedForward: number;
    /**
     * Number of REVERSE-drift tick boundaries the lens walked on the OPPOSITE side
     * of spot (= driftTicks for survivors, 0 for V2/dust). buildV3Brackets walks
     * exactly this many reverse boundaries to extend the curve above spot for
     * runtime price drift against the swap — never past the lens's data.
     */
    scannedReverse: number;
    /**
     * EVERY tick index the lens emitted a row for (forward walk + reverse drift),
     * including uninitialized (net 0) ticks the `net` map omits. Lets callers see
     * the full scanned span (e.g. that reads straddle spot for drift coverage).
     */
    scannedTickIndices: number[];
}
/** Decoded lens output: every SURVIVOR pool with live state + tick window. */
export interface LensResult {
    /** Survivor pools (already past the in-range-capacity floor on-chain). */
    pools: LensPool[];
    /** Total alive pools the lens discovered (survivors + dropped). */
    discoveredCount: number;
    /** Pool rows actually returned (= pools.length). */
    survivorCount: number;
    /** Σ IN-RANGE (windowed) capacity over alive pools, in gross tokenIn (diagnostics). */
    totalInRangeCapacity: bigint;
    /** The in-range-capacity survivor threshold the lens applied (gross tokenIn). */
    capacityFloor: bigint;
}
export interface LensCallParams {
    tokenIn: Hex;
    tokenOut: Hex;
    zeroForOne: boolean;
    /** Gross tokenIn — sizes the lazy walk (the trade can't cross past what this buys). */
    amountIn: bigint;
    /** Extra tick boundaries scanned past the stop, on EACH side (default 2). */
    driftTicks?: number;
    /**
     * Survivor floor in bps of Σ IN-RANGE capacity — the SOLE survivor gate (no
     * absolute floor). Pools whose windowed capacity (gross tokenIn absorbed across
     * the crossed ticks) is below this fraction of the total are not emitted. 0
     * disables (every alive pool survives).
     */
    minRelBps?: number;
    /**
     * HARD gas ceiling on forward tick reads per pool (the clamp HI; also the lens's outer
     * loop bound). Per-pool the walk stops EARLIER at effTicks = clamp(bandTicks/max(1,ts),
     * 96, maxTicks). Default LENS_MAX_TICKS.
     */
    maxTicks?: number;
    /**
     * Target survivorship PRICE BAND in RAW ticks. The per-pool tick budget is
     * clamp(bandTicks/max(1,tickSpacing), 96, maxTicks) — a tight ts=1 (0.01% stable
     * tier) pool gets MANY boundaries to cover the same % band a wide-ts pool covers in a
     * few, so its IN-RANGE-capacity survivorship metric + deactivation window is a fixed
     * price band, not a fixed tick count. Wide-ts pools floor at 96 (the legacy fixed
     * window → no regression). Default LENS_BAND_TICKS. 0 ⇒ every pool floors at 96 (legacy).
     */
    bandTicks?: number;
    /**
     * Bytecode target for the lens program: "v1" (prefix, Solidity SauceRouter) or
     * "v12" (postfix, Huff runtime behind a V12Pot). DEFAULT "v12" — the production
     * engine. The lens read is engine-agnostic in VALUE (same survivors/header on both
     * engines, verified); the target selects which engine bytecode is cooked, which MUST
     * match the `cookEntry` deployed in the chain being read (a v12 lens program only runs
     * on the V12Pot, never on a v1 SauceRouter). The cook RETURN is decoded per-engine (v1
     * wraps the program output in the ABI `bytes` envelope; the v12 Pot returns it raw).
     */
    target?: "v1" | "v12";
    /**
     * The account to simulate the read-only cook() from. v1's SauceRouter.cook is
     * open, so the default sentinel (0x…0001) works. The V12Pot's cook is OWNER-GATED
     * (reverts NotOwner unless msg.sender == owner|self), so a v12 lens read MUST be
     * simulated from the Pot's owner — callers pass the cook caller here.
     */
    account?: Hex;
    /**
     * Whether to feed Algebra factories into the lens. DEFAULT true — Algebra is EXECUTABLE.
     * The lens emits an Algebra pool as a `poolType=UniV3` row, indistinguishable downstream
     * from a real Uniswap-V3 pool, and prepare puts every UniV3 survivor into the EXECUTABLE
     * direct-pool set (cooked via swapV3). The engine now services the Algebra swap: the pool
     * re-enters via algebraSwapCallback, and the Router implements that selector (a mirror of
     * uniswapV3SwapCallback/pancakeV3SwapCallback → _handleV3Callback) as of sauce#186. An
     * Algebra pool's swap() is selector-identical to Uniswap V3, so _swapV3 drives it. Set false
     * only to suppress Algebra (e.g. a chain whose Algebra fork you don't want routed). The
     * lens's Algebra globalState reader is pinned by ecoswap.algebra.test.ts. See
     * FactoryType.AlgebraV3 + LIQUIDITY_SOURCES_FEASIBILITY.md §3.
     */
    includeAlgebra?: boolean;
}
/**
 * Compile the lens program to `params.target` bytecode for the given poolConfig +
 * call params (the shared front half of runLens). Returns the cook ingredient
 * bytecodes + the resolved account/target. Extracted so both the read-and-decode
 * path (runLens) and a gas probe (measureLensGas) share ONE compile.
 */
export declare function buildLensCook(poolConfig: ChainPoolConfig, params: LensCallParams): {
    bytecodes: Hex[];
    account: Hex;
    target: "v1" | "v12";
};
/**
 * Compile + invoke the lens via ONE eth_call cook() and decode the raw reads.
 *
 * `cookEntry` is the engine cook entrypoint to run the lens read against: the
 * SauceRouter on v1, the owner's V12Pot on v12 (mirrors harness/engine.ts's
 * cookTarget). It must match `params.target` — a v12 lens program only runs on the
 * Pot. Discovery config is derived from poolConfig: V3Standard factories (each with
 * its own feeTiers), V2Standard factories, and UniswapV4 factories (with stateView).
 * V4 poolIds are precomputed off-chain (keccak of the sorted PoolKey) and passed in.
 */
export declare function runLens(client: PublicClient, cookEntry: Hex, poolConfig: ChainPoolConfig, params: LensCallParams): Promise<LensResult>;
/**
 * Estimate the on-chain gas of ONE lens cook() for the given params (diagnostics only —
 * the lens is a read-only eth_call, never mined). Used to bound the gas cost of the
 * per-pool price-band tick window. Same compile path as runLens.
 */
export declare function measureLensGas(client: PublicClient, cookEntry: Hex, poolConfig: ChainPoolConfig, params: LensCallParams): Promise<bigint>;
/** Decode the lens poolBlob/tickBlob into LensPool[] with reconstructed net maps. */
export declare function decodeLens(poolBlob: Hex, tickBlob: Hex): LensResult;
//# sourceMappingURL=lens.d.ts.map