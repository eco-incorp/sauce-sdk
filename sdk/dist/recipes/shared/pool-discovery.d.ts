/**
 * Multi-protocol pool discovery.
 *
 * Supports four factory types:
 * - V3Standard:  Uniswap V3-style getPool(tokenA, tokenB, fee) across fee tiers
 * - AlgebraV3:   Algebra-style poolByPair(tokenA, tokenB) — single pool, dynamic fees
 * - V2Standard:  Uniswap V2-style getPair(tokenA, tokenB) — single pool, xy=k
 * - SolidlyV2:   Solidly-style getPool(tokenA, tokenB, stable) — volatile + stable pools
 *
 * All discovered pools include `priceLimited` flag for downstream routing.
 */
import type { PublicClient, Hex } from "viem";
import { type ChainPoolConfig, type FactoryConfig } from "./constants.js";
import type { PoolInfo } from "./types.js";
import { type CurvePool } from "./curve-math.js";
import { type CryptoSwapPool } from "./cryptoswap-math.js";
import type { BalancerStablePool } from "./balancer-stable-math.js";
import type { LbPool } from "./lb-math.js";
import { type DodoPool } from "./dodo-math.js";
import type { SolidlyStablePool } from "./solidly-stable-math.js";
import { type WombatPool } from "./wombat-math.js";
import { type WooFiPool } from "./woofi-math.js";
import { type FermiPool } from "./fermi-math.js";
import { type FluidVenue } from "./fluid-math.js";
import { type TesseraVenue } from "./tessera-math.js";
import { type ElfomoVenue } from "./elfomo-math.js";
import { type MetricVenue } from "./metric-math.js";
import type { LiquidCoreVenue } from "./liquidcore-math.js";
import { type SizeVenue } from "./size-math.js";
import { type PancakeStableVenue } from "./pancakestable-math.js";
import { type EkuboVenue } from "./ekubo-math.js";
import { type MentoPool } from "./mento-math.js";
import { type BalancerV3Pool } from "./balancer-v3-math.js";
import { type EulerSwapPool } from "./eulerswap-math.js";
import { type MaverickPool } from "./maverick-math.js";
/**
 * LIGHT Algebra pool-address resolver — poolByPair(tokenA, tokenB) per Algebra factory, returning the
 * set of Algebra pool addresses (lowercased) for the pair. NO state reads (a single multicall).
 *
 * EcoSwap's on-chain LENS surfaces an Algebra pool as a `poolType=UniV3` row, indistinguishable from a
 * real Uniswap-V3 pool downstream — so prepare can't tell which survivors are Algebra from the lens
 * output alone. Prepare uses THIS set to stamp `EcoPool.isAlgebra` on the matching survivors, so the
 * on-chain solver reads globalState() (not slot0()) for their spot in SETUP. Cheap: chains carry 0-2
 * Algebra factories, so this is one small multicall (the same poolByPair the lens already resolves).
 */
export declare function discoverAlgebraPoolAddresses(tokenIn: Hex, tokenOut: Hex, client: PublicClient, factories: FactoryConfig[]): Promise<Set<string>>;
/**
 * Discover Solidly STABLE (sAMM) pools for the pair AS TYPED `SolidlyStablePool` descriptors (the
 * EcoSwap path — distinct from the V2-tagged PoolInfo aggregator). Solidly stable pools (Aerodrome/
 * Velodrome/Thena/Ramses sAMM) trade on the x3y+y3x invariant, NOT xy=k, so they must NOT be priced
 * through the V2 synthetic-sqrt path. This reads token0/decimals/reserves + the per-pool fee so
 * prepare's `buildSolidlyStableSegments` can replay the curve with NO further RPC, and the on-chain
 * solver consumes the sampled segments statically + executes CALLBACK-FREE (getAmountOut staticcall +
 * transfer + pool.swap — NO engine SwapPoolType).
 *
 * Mirrors `discoverCurvePoolsTyped` / `discoverDodoV2PoolsTyped`: off-chain discovery + state reads,
 * returning the venue descriptor EcoSwap prepare consumes directly (the on-chain lens does not
 * understand Solidly stable pools). Factory path: getPool(tokenA, tokenB, true) per SolidlyV2 factory.
 * Decimals are read via erc20 `decimals()` (the normalisation factor); the fee via the factory
 * `getFee(pool, true)` (fork-default 0.01% on failure).
 */
export declare function discoverSolidlyStablePoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, factories: FactoryConfig[]): Promise<SolidlyStablePool[]>;
/** One discovered Solidly VOLATILE (vAMM) pool — a plain xy=k V2 curve with a PER-POOL fee. */
export interface SolidlyVolatilePool {
    address: Hex;
    /** LIVE reserve of tokenIn / tokenOut (oriented by inIsToken0). */
    reserveIn: bigint;
    reserveOut: bigint;
    /** tokenIn is the pool's token0. */
    inIsToken0: boolean;
    /** Per-pool swap fee (ppm) — read from the factory getFee(pool,false); the merge/oracle/exec gross by it. */
    feePpm: number;
    source: string;
}
/**
 * Discover Solidly VOLATILE (vAMM) pools for the pair — the deepest constant-product venues on Solidly
 * chains (Aerodrome/Velodrome/Thena/Ramses/SwapX/Shadow), which the on-chain LENS structurally EXCLUDES
 * (Solidly factories expose getPool(a,b,bool), not the getPair(a,b) the lens's V2 path calls — feeding a
 * Solidly factory into the lens would revert the whole eth_call). So they are discovered OFF-CHAIN here
 * (like KyberSwap Classic) and appended to the DIRECT V2-family set in prepare, seeded from LIVE
 * getReserves (L = √(rIn·rOut), spot out/in = √(rOut/rIn)) and executed via the callback-free V2 path
 * with the pool's per-pool fee — a vAMM is xy=k, so it live-walks EXACTLY like a UniswapV2 pool.
 *
 * Path: getPool(tokenA, tokenB, false) per SolidlyV2 factory → keep pools with `stable()==false`
 * (defensive: a factory/shim that returns a STABLE pool for the volatile query is filtered out — a vAMM
 * MUST be non-stable) and reserves > 0. The per-pool fee is read via the factory `getFee(pool, false)`
 * (normalised bps→ppm by `solidlyFeeToPpm`); on failure it falls back to the canonical 0.30% vAMM tier.
 */
export declare function discoverSolidlyVolatilePoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, factories: FactoryConfig[]): Promise<SolidlyVolatilePool[]>;
/**
 * Discover a Curve StableSwap plain pool for the pair AS A TYPED `CurvePool` descriptor
 * (the EcoSwap path — distinct from the legacy `discoverCurvePools` PoolInfo aggregator,
 * which mis-models a stable pool as a synthetic V2 sqrt). The curve math is OFF-CHAIN ONLY:
 * this reads the live invariant state (A, balances[], decimals→rates[], fee, coin indices)
 * so prepare's `buildCurveSegments` can replay get_dy with NO further RPC, and the on-chain
 * solver consumes the sampled segments statically + executes via swap(SwapParams{poolType:3}).
 *
 * Mirrors `discoverKyberClassicPools`: off-chain discovery + state reads, returns the venue
 * descriptor the EcoSwap prepare consumes directly (the on-chain lens does not understand
 * Curve). Registry path: find_pool_for_coins → get_coin_indices (int128 i,j) → get_n_coins /
 * get_decimals; pool path: A(), fee(), balances(k). rates[k] = 1e18 * 10**(18 - decimals[k]).
 *
 * SCOPE: StableSwap plain pools (int128 indices = the engine ABI). CryptoSwap / uint256-index
 * pools are OUT of scope (deferred). `aPrecision` defaults to the modern/NG A_PRECISION=100;
 * a legacy pre-A_PRECISION pool needs `aPrecision: 1n` (configured per registry if needed).
 */
export declare function discoverCurvePoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, registries: FactoryConfig[]): Promise<CurvePool[]>;
/**
 * Discover a Curve CryptoSwap pool (twocrypto-ng / tricrypto-ng volatile-asset pool) for the pair AS
 * A TYPED `CryptoSwapPool` descriptor (the EcoSwap CALLBACK-FREE path). CryptoSwap pools trade on the
 * A-gamma invariant with a DYNAMIC fee (NOT the StableSwap A-invariant, NOT xy=k) AND use uint256
 * coin indices (exchange(uint256 i, uint256 j, dx, min_dy)), so the engine `_swapCurve` — which calls
 * exchange(int128,int128,...) — does NOT match them. The curve math is OFF-CHAIN ONLY: this reads the
 * live A-gamma state (A=ANN, gamma, price_scale, D, balances[], decimals→precisions[], mid/out/fee_gamma)
 * so prepare's `buildCryptoSwapSegments` can replay get_dy with NO further RPC, and the on-chain solver
 * consumes the sampled segments statically + executes CALLBACK-FREE (get_dy staticcall for min_dy +
 * approve + exchange(uint256 i, uint256 j, Σ, min_dy) — Curve exchange PULLS via transferFrom).
 *
 * Mirrors `discoverCurvePoolsTyped` (the StableSwap sibling): registry find_pool_for_coins →
 * get_coin_indices (uint256 i,j) → get_n_coins/get_decimals; pool A()/gamma()/price_scale()/D()/
 * balances(k)/mid_fee()/out_fee()/fee_gamma(). SCOPE: 2-coin crypto pools (a tokenIn→tokenOut swap
 * reads exactly two coins). A pool with n_coins != 2 for the pair is skipped (a tricrypto swap would
 * need the price_scale of the specific pair's coin against coin0 — a 2-coin descriptor is what the
 * off-chain replay + the callback-free exchange consume). The crypto registry `A()` already reports
 * the A_MULTIPLIER·N^N-scaled ANN the invariant uses, so `A` is stored as ANN directly.
 */
export declare function discoverCryptoSwapPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, registries: FactoryConfig[]): Promise<CryptoSwapPool[]>;
/**
 * Discover Balancer V2 ComposableStable pools for the pair AS TYPED `BalancerStablePool` descriptors
 * (the EcoSwap path — distinct from the legacy `discoverBalancerV2Pools` stub, which never surfaced a
 * pool). Balancer stable pools (bb-a-USD class — USDC/USDT/DAI depth on Ethereum/Arbitrum/Polygon)
 * trade on the StableMath A-invariant (NOT xy=k), so they must NOT be priced through the V2 synthetic-
 * sqrt path. The stable math is OFF-CHAIN ONLY: this reads the live invariant state (amp, the NON-BPT
 * balances + scaling factors, fee, token indices) so prepare's `buildBalancerStableSegments` can replay
 * StableMath getDy with NO further RPC, and the on-chain solver consumes the sampled segments statically
 * + executes via the EXISTING engine BalancerV2 dispatch swap(SwapParams{poolType:4, pool}) →
 * _swapBalancerV2 (it derives poolId via pool.getPoolId() and calls Vault.swap(GIVEN_IN) — NO engine
 * change).
 *
 * DISCOVERY IS KNOWN-POOL-ADDRESS BASED — Balancer has NO pair→pool getter. The `FactoryConfig.address`
 * for a BalancerV2 entry is the VAULT (shared on all EVM chains); the per-config `balancerStablePools`
 * carries the candidate ComposableStable pool addresses. For each known pool: read getPoolId →
 * Vault.getPoolTokens(poolId) → getAmplificationParameter / getScalingFactors / getSwapFeePercentage /
 * getBptIndex; EXCLUDE the BPT (the pool's own token at bptIndex) from the StableMath balances/scaling/
 * indices; keep the pool when BOTH tokenIn and tokenOut are non-BPT registered tokens. PRODUCTION needs
 * a known-poolId list / the Balancer subgraph to populate `balancerStablePools` (the standard Balancer
 * integration); the EVM test injects the locally-deployed fixture pool address.
 *
 * Mirrors `discoverCurvePoolsTyped`: off-chain discovery + state reads, returning the venue descriptor
 * EcoSwap prepare consumes directly (the on-chain lens does not understand Balancer). `amp` is the raw
 * getAmplificationParameter()[0] (= A·AMP_PRECISION — the StableMath replay uses it directly). The
 * scaling factors fold decimals + rate-provider rates (all 1e18-WAD), so a rate-bearing stable pool
 * (e.g. bb-a-USD with aToken rates) is priced exactly.
 */
export declare function discoverBalancerStablePoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, factories: FactoryConfig[]): Promise<BalancerStablePool[]>;
/**
 * Discover DODO V2 PMM pools for the pair AS TYPED `DodoPool` descriptors (the EcoSwap path —
 * distinct from the legacy `discoverDODOPools` PoolInfo aggregator, which mis-models a PMM pool
 * as ONE synthetic V2 sqrt from raw reserves). DODO V2 is a Proactive Market Maker: the curve is a
 * closed-form integral parameterised by a GUIDE PRICE `i` (1e18-scaled), a slippage coefficient
 * `K`, the live reserves B/Q, the target reserves B0/Q0 and the R-state — ALL of which are POOL
 * STATE read live from `getPMMStateForCall()` (the guide price is NOT an exogenous oracle feed,
 * unlike WOOFi/Fermi — so DODO is wei-exact-on-grid under the charter). The curve math is OFF-CHAIN
 * ONLY: this reads the live PMM state so prepare's `buildDodoSegments` can replay querySell* with NO
 * further RPC, and the on-chain solver consumes the sampled segments statically + executes the
 * awarded Σ share via swap(SwapParams{poolType:5}) → live _swapDODOV2 (it resolves base/quote
 * orientation on-chain from `_BASE_TOKEN_()`).
 *
 * Mirrors `discoverCurvePoolsTyped`: off-chain discovery + state reads, returning the venue
 * descriptor EcoSwap prepare consumes directly (the on-chain lens does not understand DODO). Zoo
 * path: getDODOPool(base, quote) over BOTH orderings (DODO pools are base/quote-oriented, so the pair
 * may be registered either way); pool path: getPMMStateForCall() + _BASE_TOKEN_()/_QUOTE_TOKEN_() +
 * _LP_FEE_RATE_() + the MT fee-rate model getFeeRate(caller). The DODO registry/factory address is
 * the `DODOZoo` FactoryConfig entry (documented placeholders per chain in constants.ts).
 *
 * SCOPE: DVM/DSP/DPP pools exposing getPMMStateForCall (the standard V2 PMM surface). The caller's
 * MT fee rate is read once at quote time and treated as fixed over the trade (the snapshot
 * assumption the recipe makes for V3 tiers / Curve fee / LB base fee).
 */
export declare function discoverDodoV2PoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, zoos: FactoryConfig[], caller?: Hex): Promise<DodoPool[]>;
/**
 * Discover Trader Joe LB pairs for the swap AS TYPED `LbPool` descriptors (the EcoSwap path —
 * distinct from the legacy `discoverTraderJoeLBPools` PoolInfo aggregator, which mis-models an
 * LB pair as ONE synthetic V2 sqrt). LB is a DISCRETE-BIN constant-sum AMM: this reads the live
 * per-bin reserves around the active bin so prepare's `buildLbSegments` can emit ONE EXACT flat
 * segment per bin with NO sampling, and the on-chain solver consumes the segments statically +
 * executes the awarded Σ share via swap(SwapParams{poolType:6}) → live _swapTraderJoeLB (one
 * atomic `pool.swap(swapForY, to)`; the engine resolves swapForY on-chain from getTokenX()).
 *
 * Mirrors `discoverCurvePoolsTyped`: off-chain discovery + state reads, returning the venue
 * descriptor EcoSwap prepare consumes directly (the on-chain lens does not understand LB).
 * Factory path: getLBPairInformation(tokenX, tokenY, binStep) per known bin step → pair; pair
 * path: getActiveId / getBinStep / getStaticFeeParameters().baseFactor + getBin(id) over a
 * window of `TRADER_JOE_BIN_WINDOW` bins on each side of the active id (the swap walks outward
 * from active, so only bins in the swap direction matter — both sides are read so either swap
 * direction is covered without re-discovery).
 *
 * SCOPE: LB v2.1/v2.2 pairs (the getActiveId/getBin/getStaticFeeParameters surface). The base
 * fee (baseFactor·binStep) is the snapshot fee; the transient variable/volatility fee is omitted.
 */
export declare function discoverTraderJoeLBPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, factories: FactoryConfig[]): Promise<LbPool[]>;
/**
 * Discover WOOFi (WooPPV2 sPMM) pools for the pair AS TYPED `WooFiPool` descriptors (the EcoSwap path —
 * distinct from the legacy `discoverWOOFiPools` PoolInfo aggregator, which only verified the pair). WOOFi
 * is an ORACLE-PRICED synthetic proactive market maker: each FactoryConfig.address is ONE WooPPV2 pool
 * (one per chain), a base/quote model where `quoteToken` is the numeraire (usually USDC) and every other
 * supported token is a `baseToken` priced by WooracleV2. A (tokenIn,tokenOut) swap is a DIRECT leg iff
 * ONE side is the quote and the OTHER is a supported base (sell base or sell quote) — a base→base pair is
 * two chained sPMM legs and is OUT of scope for this single-oracle replay.
 *
 * The sPMM math is OFF-CHAIN ONLY: this reads the pool's quoteToken + wooracle + the base token's SNAPSHOT
 * oracle state (price/spread/coeff/woFeasible from wooracle.state(base)) + the price scale
 * (wooracle.decimals(base)) + the token decimals + the base's feeRate (tokenInfos(base)), so prepare's
 * `buildWooFiSegments` can replay `query` with NO further RPC, and the on-chain solver consumes the sampled
 * segments statically + executes CALLBACK-FREE (query staticcall for minToAmount + transfer + pool.swap —
 * NO engine SwapPoolType, since WOOFi is NOT xy=k and the swap is transfer-first callback-free).
 *
 * Mirrors `discoverWombatPoolsTyped` / `discoverSolidlyStablePoolsTyped`: off-chain discovery + state
 * reads, returning the venue descriptor EcoSwap prepare consumes directly (the on-chain lens does not
 * understand WOOFi). A pool is kept only when the base is oracle-FEASIBLE (woFeasible && price > 0) and a
 * small `query` verifies the pair trades. `sellBase` is true when tokenIn is the base (base→quote).
 */
export declare function discoverWooFiPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, woofiConfigs: FactoryConfig[]): Promise<WooFiPool[]>;
/**
 * Discover Fermi / propAMM (gattaca-com/propamm FermiSwapper) pools for the pair AS TYPED `FermiPool`
 * descriptors (the EcoSwap callback-free path). propAMM is an OBRIC-style proactive market maker (NOT xy=k),
 * so it must NOT be priced through the V2 synthetic-sqrt path. Each FactoryConfig.address is a FermiSwapper
 * ROUTER; a pair is kept only when `isActive(tokenIn, tokenOut)` (either orientation) reports it live.
 *
 * The FermiSwapper exposes NO raw curve state (no tokenX/tokenY/K/base getters, no getAmountOut view), so the
 * split cannot be priced from a closed-form snapshot. Instead this SAMPLES the pool via a small ladder of
 * `quoteAmounts(tokenIn, tokenOut, +cumIn)` eth_calls (positive amountSpecified = exact-in per the propAMM
 * taker) over [0, amountIn] and stores the (cumIn, cumOut) points on the descriptor. `buildFermiSegments`
 * then differences that ladder into segments with NO further RPC (so the oracle shares them). Execution is
 * CALLBACK-FREE (approve + fermiSwapWithAllowances — propAMM PULLS via transferFrom, approve-first like
 * Wombat/Curve). A pool is kept only when the pair is active AND the ladder shows a strictly positive out.
 *
 * `amountIn` sizes the ladder range. Mirrors `discoverWooFiPoolsTyped` — off-chain discovery + state reads,
 * returning the venue descriptor EcoSwap prepare consumes directly (the on-chain lens does not understand
 * Fermi).
 */
export declare function discoverFermiPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, fermiConfigs: FactoryConfig[], amountIn: bigint): Promise<FermiPool[]>;
/**
 * Discover Fluid DEX (Instadapp fluid-contracts-public FluidDexT1) pools for the pair AS TYPED
 * DESCRIPTOR-ONLY `FluidVenue`s + a liveness-probe head (the EcoSwap QUOTE-LADDER path). Fluid DEX is a
 * Liquidity-Layer-backed re-centering AMM (NOT xy=k), so it must NOT be priced through the V2
 * synthetic-sqrt path. Discovery is KNOWN-POOL-ADDRESS based (the candidate DexT1 pool addresses are in
 * `FactoryConfig.fluidPools`; the periphery resolver in `FactoryConfig.fluidResolver`). A pool is kept
 * only when it trades BOTH tokenIn and tokenOut (its token0/token1 match the pair) AND ONE liveness probe
 * quotes strictly positive.
 *
 * NO SAMPLING (the QL family contract): the on-chain solver builds each venue's price ladder LIVE at cook
 * from `resolver.estimateSwapIn(dex, swap0to1, xNext, 0)` quote-differencing, so discovery ships only the
 * descriptor. The ONE probe here quotes the FIRST QL slice size (`amountIn / QL_SEED_DIV`, the ladder's
 * seed) — it gates liveness, yields the fold head (`headOI` = the first-slice post-fee out/in sqrt, the
 * same head the on-chain ladder's first slice carries at this size) and derives the diagnostic feePpm.
 * That is 2 RPCs per candidate pool (getDexTokens + one estimateSwapIn) — down from getDexTokens +
 * FLUID_SAMPLES(24) estimateSwapIn calls in the deleted static-sampling path. Execution is CALLBACK-FREE
 * (approve + pool.swapIn — Fluid PULLS via safeTransferFrom, approve-first like Fermi/Wombat/Curve). The
 * utilization/borrow CAP needs no probe: estimateSwapIn quotes 0 past the tradeable cap, so the on-chain
 * ladder self-truncates at the LIVE cap (like EulerSwap's inLimit).
 *
 * `amountIn` sizes the probe. Mirrors `discoverFermiPoolsTyped` / `discoverEulerSwapPoolsTyped` —
 * off-chain discovery + a liveness read, returning the venue descriptor EcoSwap prepare consumes directly
 * (the on-chain lens does not understand Fluid).
 */
export declare function discoverFluidPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, fluidConfigs: FactoryConfig[], amountIn: bigint): Promise<(FluidVenue & {
    headOI: bigint;
})[]>;
/**
 * Discover Tessera V (Wintermute TesseraSwap wrapper) venues for the pair AS TYPED DESCRIPTOR-ONLY
 * `TesseraVenue`s + a liveness-probe head (the EcoSwap QUOTE-LADDER path). Tessera is a treasury-funded
 * proactive market maker (NOT xy=k), so it must NOT be priced through the V2 synthetic-sqrt path.
 * Discovery is KNOWN-ADDRESS based (the FactoryConfig `address` IS the wrapper — the BalancerV3
 * known-pool pattern): the wrapper exposes NO pair enumeration, so a pair is kept only when ONE liveness
 * quote probe (`tesseraSwapViewAmounts(tokenIn, tokenOut, +probeIn)[1]`, caught — the view REVERTS on an
 * unsupported pair) returns strictly positive.
 *
 * NO SAMPLING (the QL family contract): the on-chain solver builds each venue's price ladder LIVE at
 * cook from `tesseraSwapViewAmounts` quote-differencing (PROBE-THEN-DECODE — the view is revert-class),
 * so discovery ships only the descriptor. The ONE probe here quotes the FIRST QL slice size
 * (`amountIn / QL_SEED_DIV`, the ladder's seed) — it gates liveness, yields the fold head (`headOI` =
 * the first-slice post-fee out/in sqrt) and derives the diagnostic feePpm. That is 1 RPC per candidate
 * wrapper. Execution is CALLBACK-FREE (approve + tesseraSwapWithAllowances(..., "") — Tessera PULLS via
 * transferFrom, approve-first like Fermi/Wombat/Curve). The engine's ~2-gwei priority-fee knob needs no
 * discovery guard: the swap never reverts on gas price and quote+exec read the same tx.gasprice (fork-
 * proven; see tessera-math.ts).
 *
 * `amountIn` sizes the probe. Mirrors `discoverFluidPoolsTyped` — off-chain discovery + one liveness
 * read, returning the venue descriptor EcoSwap prepare consumes directly (the on-chain lens does not
 * understand Tessera).
 */
export declare function discoverTesseraPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, tesseraConfigs: FactoryConfig[], amountIn: bigint): Promise<(TesseraVenue & {
    headOI: bigint;
})[]>;
/**
 * Discover ElfomoFi (vault-funded PMM + on-chain pricing module) venues for the pair AS TYPED
 * DESCRIPTOR-ONLY `ElfomoVenue`s + a liveness-probe head (the EcoSwap QUOTE-LADDER path). Elfomo is an
 * oracle-priced PMM (NOT xy=k), so it must NOT be priced through the V2 synthetic-sqrt path. Discovery
 * is KNOWN-ADDRESS based (the FactoryConfig `address` IS the wrapper) but ENUMERABLE within it:
 * `getSupportedPairs()` lists the tradeable [tokenA, tokenB] pairs (a listed pair quotes in BOTH
 * directions — verified live both ways), so the pair filter is an exact unordered-set match, then ONE
 * liveness quote probe (`getAmountOut(tokenIn, tokenOut, probeIn)` — GRACEFUL, 0 ⇒ dead/stale) gates
 * admission.
 *
 * NO SAMPLING (the QL family contract): the on-chain solver builds each venue's price ladder LIVE at
 * cook from `getAmountOut` quote-differencing (a plain single-return staticcall, 0 ⇒ stop — the
 * WOOFi-tryQuery class), so discovery ships only the descriptor. The ONE probe here quotes the FIRST QL
 * slice size (`amountIn / QL_SEED_DIV`) — it gates liveness, yields the fold head and derives the
 * diagnostic feePpm. That is 2 RPCs per candidate wrapper (getSupportedPairs + one getAmountOut).
 * Execution is CALLBACK-FREE (approve + swap(..., partnerId 0) — Elfomo PULLS via transferFrom,
 * approve-first like Fermi/Tessera/Wombat).
 *
 * `amountIn` sizes the probe. Mirrors `discoverTesseraPoolsTyped` / `discoverFluidPoolsTyped` —
 * off-chain discovery + a liveness read, returning the venue descriptor EcoSwap prepare consumes
 * directly (the on-chain lens does not understand Elfomo).
 */
export declare function discoverElfomoPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, elfomoConfigs: FactoryConfig[], amountIn: bigint): Promise<(ElfomoVenue & {
    headOI: bigint;
})[]>;
/**
 * Discover METRIC (metric.xyz oracle-anchored bin-curve OMM) venues for the pair AS TYPED
 * DESCRIPTOR-ONLY `MetricVenue`s + a liveness-probe head (the EcoSwap QUOTE-LADDER path). A Metric pool
 * is a per-pair inventory contract priced off a maker-posted PriceProvider anchor (NOT xy=k), so it must
 * NOT be priced through the V2 synthetic-sqrt path. Discovery is KNOWN-POOL-ADDRESS based (the
 * BalancerV3/Fluid pattern — NO on-chain enumeration exists; see metric-math.ts): the FactoryConfig
 * carries `metricPools` + the per-config `metricRouter` (Base runs TWO routers over disjoint pool sets).
 *
 * Per candidate pool (3 RPCs):
 *   1. `pool.getImmutables()` — provider [1] / token0 [2] / token1 [3]; skip a pool not trading EXACTLY
 *      this pair; orient `xToY` = (tokenIn == token0).
 *   2. `provider.getBidAndAskPrice()` — PROBE-THEN-DECODE (the provider REVERTS 0x9a0423af when the
 *      maker's off-chain post is older than MAX_TIME_DELTA (~10 s) or under its Chainlink
 *      deviation/sequencer guards): a stale/quiet maker drops here. Derives the diagnostic feePpm as
 *      HALF the relative bid/ask spread (works for any pair — no near-par assumption).
 *   3. `router.quoteSwap(pool, xToY, +probeIn, limit, bid, ask)` at the FIRST QL slice size with the
 *      DIRECTIONAL limit (0 for xToY, uint128.max for yToX): the |negative out-delta| must be strictly
 *      positive (an EMPTY pool quotes (0,0) gracefully — drops; garbage anchors would revert — caught).
 *
 * NO SAMPLING (the QL family contract): the on-chain solver hoists the SAME provider anchor once per
 * venue in setup and builds the ladder LIVE from quoteSwap quote-differencing at the frozen (bid, ask),
 * so discovery ships only the descriptor. Execution is CALLBACK-FREE from the cooking contract's
 * perspective (approve ROUTER + swapExactInput — the pool pays out first and re-enters
 * metricOmmSwapCallback ON THE ROUTER, which implements it itself; fork-proven permissionless +
 * wei-exact both directions).
 *
 * `amountIn` sizes the probe (clamped at the int128 bound — see METRIC_INT128_MAX). Mirrors
 * `discoverFluidPoolsTyped` / `discoverTesseraPoolsTyped` — off-chain discovery + liveness reads,
 * returning the venue descriptor EcoSwap prepare consumes directly (the on-chain lens does not
 * understand Metric).
 */
export declare function discoverMetricPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, metricConfigs: FactoryConfig[], amountIn: bigint): Promise<(MetricVenue & {
    headOI: bigint;
})[]>;
/**
 * Discover LIQUIDCORE (Liquid Labs, HyperEVM) venues for the pair AS TYPED DESCRIPTOR-ONLY
 * `LiquidCoreVenue`s + a liveness-probe head (the EcoSwap QUOTE-LADDER path). A LiquidCore pool is a
 * per-pair proxy priced off the Hyperliquid BBO read precompile (NOT xy=k), so it must NOT be priced
 * through the V2 synthetic-sqrt path. Discovery is ROUTER-ENUMERATED (the config `address` is the
 * router):
 *
 *   1. `router.getPoolForPair(tokenIn, tokenOut)` — UNORDERED (probed: both orders return the same
 *      pool), ONE pool per pair; the zero address ⇒ no pool, skip. (1 RPC.)
 *   2. `pool.estimateSwap(tokenIn, tokenOut, probeIn)` at the FIRST QL slice size — PROBE-THEN-
 *      DECODE (zero/unsupported REVERT; a DRAINED pool returns 0 gracefully — either drops). The
 *      probe out is the liveness head. (1 RPC.)
 *
 * NO SAMPLING (the QL family contract): the on-chain solver builds the ladder LIVE from the SAME
 * estimateSwap view at cook. Execution is CALLBACK-FREE (approve POOL + pool.swap — permissionless,
 * pull == approve always; fork-proven wei-exact same-block — see liquidcore-math.ts). The
 * diagnostic feePpm derives from the probe's realized price vs the pool's getSpotPrices mid when
 * that view answers (it REVERTS on a zero reserve — probe-then-decode, 0 fallback).
 */
export declare function discoverLiquidCorePoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, liquidCoreConfigs: FactoryConfig[], amountIn: bigint): Promise<(LiquidCoreVenue & {
    headOI: bigint;
})[]>;
/**
 * Discover INTEGRAL SIZE (TwapRelayer) venues for the pair AS TYPED DESCRIPTOR-ONLY `SizeVenue`s +
 * a liveness-probe head (the EcoSwap QUOTE-LADDER path). The relayer executes instantly from ITS
 * OWN inventory at the Uniswap-V3-TWAP price inside an OUT-amount [min, cap] WINDOW (see
 * size-math.ts) — the descriptor is the single per-chain relayer (the config `address`).
 *
 * Per config (4-5 RPCs):
 *   1. `getTokenLimitMin(tokenOut)` — the out-window low end (a pure config read).
 *   2. `quoteBuy(tokenIn, tokenOut, minOut)` — the EXACT lowest quotable input `minIn`
 *      (quoteBuy CEIL-rounds, so quoteSell(minIn) >= minOut always). PROBE-THEN-DECODE: a TR3A
 *      revert here means even the minimum out exceeds the live inventory cap ⇒ the venue is dead;
 *      TR17/TR5A ⇒ no enabled pair — drop.
 *   3. ONE liveness `quoteSell(tokenIn, tokenOut, max(firstSlice, minIn))` — the grid's actual
 *      first point (the ladder seed is FLOORED at minIn on-chain), probe-then-decode.
 *   4. `factory()` → `getPair` → `swapFee(pair)` for the diagnostic feePpm (1e18 PRECISION → ppm).
 *
 * The descriptor carries the DISCOVERY-time `minOut`/`minIn` for diagnostics + test plumbing ONLY —
 * the on-chain solver RE-HOISTS the window LIVE per venue at cook (the live-walk charter: a
 * prepare-time min is a stale cache the cook must not trust).
 */
export declare function discoverSizePoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, sizeConfigs: FactoryConfig[], amountIn: bigint): Promise<(SizeVenue & {
    headOI: bigint;
})[]>;
/**
 * Discover PANCAKESWAP STABLESWAP (BSC — the Solidity port of the LEGACY Curve StableSwap 2-pool)
 * venues for the pair AS TYPED DESCRIPTOR-ONLY `PancakeStableVenue`s + a liveness-probe head (the
 * EcoSwap QUOTE-LADDER path, segKind 20). Pancake stable pools trade on the StableSwap A-invariant
 * (NOT xy=k) AND use UINT256 coin indices — the engine `_swapCurve` int128 dispatch does NOT match
 * them (the int128 get_dy REVERTS on probe), so execution is CALLBACK-FREE (the CryptoSwap class).
 * Discovery is FACTORY-PAIR-KEYED (the config `address` is the PancakeStableSwapFactory):
 *
 *   1. `factory.getPairInfo(tokenIn, tokenOut)` — ORDER-INDEPENDENT (sortTokens internally;
 *      probed both orders return the same struct); a non-existent pair returns the ZERO struct
 *      (no revert) ⇒ skip. token0/token1 in the returned struct are the SORTED pair == the pool's
 *      coins(0)/coins(1) (createSwapPair deploys sorted — VERIFIED source), so the descriptor's
 *      i/j orient per edge with no extra reads: i = (tokenIn == token0 ? 0 : 1), j = 1 − i. (1 RPC.)
 *   2. `pool.get_dy(i, j, probeIn)` at the FIRST QL slice size — PROBE-THEN-DECODE (an EMPTY
 *      pool's get_D divides by zero ⇒ REVERT; a killed pool reverts too; a zero quote means no
 *      output depth — either drops). The probe out is the liveness head. (1 RPC.)
 *   3. `pool.fee()` — the 1e10-scaled swap fee → diagnostic feePpm (= fee/1e4; best-effort).
 *
 * NO SAMPLING (the QL family contract): the on-chain solver builds the ladder LIVE from the SAME
 * get_dy view at cook. Execution is CALLBACK-FREE (approve POOL + exchange(uint256 i, uint256 j,
 * Σ, min_dy) — exchange PULLS EXACTLY dx via safeTransferFrom, VERIFIED source ⇒ pull == approve,
 * residue 0). Only the 2-pool surface is discovered — getThreePoolPairInfo returned the ZERO
 * struct for every probed pair (NO 3-pools registered on BSC; see pancakestable-math.ts).
 */
export declare function discoverPancakeStablePoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, pancakeStableConfigs: FactoryConfig[], amountIn: bigint): Promise<(PancakeStableVenue & {
    headOI: bigint;
})[]>;
/**
 * Discover EKUBO V3 (the till-based flash-accounting singleton CL — every pool VIRTUAL inside ONE
 * Core) venues for the pair AS TYPED DESCRIPTOR-ONLY `EkuboVenue`s + a liveness-probe head (the
 * EcoSwap QUOTE-LADDER path, segKind 21). Discovery is the V4-PRESET-CLONE, pure RPC:
 *
 *   1. Sort the pair ascending → (token0, token1); isToken1 = tokenIn == token1. Both recipe
 *      tokens are ERC20 contracts, so the native-ETH keys (token0 == address(0) — Phase-2) cannot
 *      arise here.
 *   2. Candidate configs from the FROZEN preset menu (`cfg.ekuboPresets` ??
 *      EKUBO_DEFAULT_PRESETS — extension 0, concentrated bit set) → poolId = keccak256(pad32(t0) ‖
 *      pad32(t1) ‖ config) (E0: re-derived vs 5/5 API-verified live ids).
 *   3. ONE raw `Core.sload` batch call — selector 0x380eb4e0 ++ ALL candidate poolIds as RAW
 *      32-byte keys (NOT ABI-encoded; the poolState slot IS the poolId) → N packed poolState words
 *      (sqrtRatio u96 | tick i32 | liquidity u128). sqrtRatio != 0 ⇔ initialized; dead candidates
 *      read 0 and drop. (1 RPC for the WHOLE menu.)
 *   4. Per initialized candidate, ONE `Router.quote(key, isToken1, +probeIn, 0, 0)` eth_call at
 *      the first QL slice size (PROBE-THEN-DECODE: PoolNotInitialized/garbage ⇒ drop; decode the
 *      |negative out lane| of the PoolBalanceUpdate — a zero out has no depth ⇒ drop). The probe
 *      out is the liveness head. (1 RPC per initialized pool — typically ≤ 2 per pair.)
 *
 * NO SAMPLING (the QL family contract): the on-chain solver builds the ladder LIVE from the SAME
 * router quote at cook. Execution is CALLBACK-FREE (in-tx re-quote → approve ROUTER for the quoted
 * CONSUMED input → the full-fill `swap(key, isToken1, +consumed, 0, 0, quoted out, self)` — the
 * router pulls EXACTLY consumed via transferFrom(swapper → Core); fork-executed wei-exact,
 * residue 0). The descriptor's claim key is the POOLID (`ekubo|<poolId>` — virtual pools share the
 * router/Core addresses; several same-pair fee tiers compete as independent venues).
 */
export declare function discoverEkuboPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, ekuboConfigs: FactoryConfig[], amountIn: bigint): Promise<(EkuboVenue & {
    headOI: bigint;
})[]>;
/**
 * Discover Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager) venues for the pair AS TYPED
 * `MentoPool` descriptors (the EcoSwap callback-free path). Mento is a BiPool oracle-priced stablecoin
 * exchange (NOT xy=k), so it must NOT be priced through the V2 synthetic-sqrt path. Discovery is ENUMERABLE
 * and self-describing (unlike Fluid's known-pool-address list): the FactoryConfig `address` is the Broker.
 *
 * Two-step enumeration (VERIFIED against mento-core, do NOT skip step 1):
 *   1. `Broker.getExchangeProviders()` → the registered exchange-provider addresses (BiPoolManager is one).
 *      When `FactoryConfig.mentoExchangeProviders` is set it RESTRICTS to those (skips the enumeration —
 *      used by the local fixture); otherwise the live provider set is queried (governance-mutable).
 *   2. `provider.getExchanges()` → Exchange[] { bytes32 exchangeId; address[] assets; }. An exchange matches
 *      (tokenIn,tokenOut) when {tokenIn,tokenOut} == {assets[0],assets[1]} (UNORDERED), yielding
 *      (exchangeProvider = the provider, exchangeId = Exchange.exchangeId).
 *
 * The Broker has a PLAIN `getAmountOut(exchangeProvider, exchangeId, tokenIn, tokenOut, amountIn)` VIEW
 * (deterministic at the current bucket state; no revert-decode resolver needed — simpler than Fluid), so
 * this SAMPLES a small ladder of `getAmountOut` eth_calls over [0, amountIn] and stores the (cumIn, cumOut)
 * points on the descriptor. `buildMentoSegments` then differences that ladder into segments with NO further
 * RPC (so the oracle shares them). Execution is CALLBACK-FREE (approve the BROKER + broker.swapIn — Mento
 * PULLS via transferFrom into the reserve, approve-first like Fermi/Wombat/Curve/Fluid). A venue is kept
 * only when its exchange trades BOTH tokenIn and tokenOut AND the ladder shows a strictly-positive out (a
 * zero/failed quote past a trading limit truncates the ladder, like EulerSwap's inLimit).
 *
 * `amountIn` sizes the ladder range. Mirrors `discoverFluidPoolsTyped` / `discoverFermiPoolsTyped` —
 * off-chain discovery + state reads, returning the venue descriptor EcoSwap prepare consumes directly (the
 * on-chain lens does not understand Mento).
 */
export declare function discoverMentoPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, mentoConfigs: FactoryConfig[], amountIn: bigint): Promise<MentoPool[]>;
/**
 * Discover Balancer V3 (balancer-v3-monorepo — Vault singleton + per-chain Router) pools for the pair AS
 * TYPED `BalancerV3Pool` descriptors (the EcoSwap callback-free path). Balancer V3 pools price off the Vault
 * balances + rate providers + a possibly-dynamic StableSurge hook fee (NOT xy=k), so they must NOT be priced
 * through the V2 synthetic-sqrt path. Discovery is KNOWN-POOL-ADDRESS based (V3 has no pair→pool getter): the
 * `FactoryConfig.address` for a BalancerV3 entry is the CREATE2 Vault (shared on all chains), the candidate
 * pool addresses are in `FactoryConfig.balancerV3Pools`, and the per-chain single-swap Router is
 * `FactoryConfig.balancerV3Router`.
 *
 * A pool is kept only when it trades BOTH tokenIn and tokenOut — read via `Vault.getPoolTokens(pool)` (V3 has
 * NO BPT in the swappable token list, unlike V2 ComposableStable). The deep production pools are surge-hooked
 * + rate-scaled, so the curve cannot be replayed from a static fee; instead this SAMPLES a LIVE ladder via
 * the Router's `querySwapSingleTokenExactIn(pool, tokenIn, tokenOut, +amountIn, sender, "")` via eth_call
 * (which bakes in the rate providers + dynamic hook fee — the robust surface; the query is eth_call-ONLY, not
 * callable on-chain). `buildBalancerV3Segments` then differences that ladder into segments (shared with the
 * oracle). Execution is CALLBACK-FREE: the solver Permit2-approves (ERC20.approve(PERMIT2) +
 * Permit2.approve(ROUTER)), then calls `Router.swapSingleTokenExactIn` with minAmountOut=0 (the query is NOT
 * re-read on-chain) — the V3 reentrancy is contained inside Balancer's Router+Vault (never the cooking
 * contract), so no engine change.
 *
 * `amountIn` sizes the ladder range. Mirrors `discoverFluidPoolsTyped` / `discoverMentoPoolsTyped` —
 * off-chain discovery + state reads, returning the venue descriptor EcoSwap prepare consumes directly (the
 * on-chain lens does not understand Balancer V3).
 */
export declare function discoverBalancerV3PoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, balancerV3Configs: FactoryConfig[], amountIn: bigint): Promise<BalancerV3Pool[]>;
/**
 * One discovered KyberSwap Classic / DMM pool. Kyber is an amplified constant-product
 * AMM trading on VIRTUAL reserves: the curve geometry (sqrt/L) is keyed off vReserve*,
 * NOT the real reserves. A Kyber pool is mathematically a V2 range with
 * L = isqrt(vReserveIn·vReserveOut). The fee is per-pool and live (feeInPrecision, 1e18-scaled).
 * Execution is callback-free (transfer + pool.swap(a0, a1, to, "")), so no engine change.
 */
export interface KyberClassicPool {
    address: Hex;
    tokenIn: Hex;
    tokenOut: Hex;
    /** Real tokenIn-side reserve (used by execution's balance check, not the curve). */
    reserveIn: bigint;
    /** Real tokenOut-side reserve. */
    reserveOut: bigint;
    /** VIRTUAL tokenIn-side reserve — seeds the constant-L curve geometry. */
    vReserveIn: bigint;
    /** VIRTUAL tokenOut-side reserve. */
    vReserveOut: bigint;
    /** Live per-pool fee, scaled by 1e18 (PRECISION). */
    feeInPrecision: bigint;
    /** Is tokenIn the pool's token0 (orientation for getTradeInfo / swap output slot)? */
    inIsToken0: boolean;
    source: string;
}
/**
 * Discover KyberSwap Classic / DMM pools for the pair. getPools(token0, token1) returns
 * EVERY DMM pool for the unordered pair (one per amplification factor); per-pool
 * getTradeInfo() yields (reserve0, reserve1, vReserve0, vReserve1, feeInPrecision). The
 * virtual reserves seed the V2-shaped curve; the real reserves + fee are carried for
 * the callback-free execution.
 */
export declare function discoverKyberClassicPools(tokenIn: Hex, tokenOut: Hex, client: PublicClient, factories: FactoryConfig[]): Promise<KyberClassicPool[]>;
/**
 * Discover Wombat pools for the pair AS TYPED `WombatPool` descriptors (the EcoSwap path). Wombat is
 * a single-sided MULTI-ASSET stableswap singleton: each FactoryConfig.address is ONE Wombat Pool, and
 * a (tokenIn,tokenOut) swap is valid iff BOTH tokens are assets of that pool (addressOfAsset(token) !=
 * 0). The curve math is OFF-CHAIN ONLY: this reads the live from/to asset (cash, liability) — both
 * WAD — plus the pool-wide ampFactor + haircutRate (WAD) and the two tokens' native decimals, so
 * prepare's `buildWombatSegments` can replay quotePotentialSwap with NO further RPC, and the on-chain
 * solver consumes the sampled segments statically + executes CALLBACK-FREE (quotePotentialSwap
 * staticcall + approve + pool.swap — NO engine SwapPoolType, since Wombat is NOT xy=k).
 *
 * Mirrors `discoverSolidlyStablePoolsTyped` / `discoverCurvePoolsTyped`: off-chain discovery + state
 * reads, returning the venue descriptor EcoSwap prepare consumes directly (the on-chain lens does not
 * understand Wombat). Pool path: addressOfAsset(tokenIn)/addressOfAsset(tokenOut) (both must be
 * non-zero) → per-asset cash()/liability() + pool ampFactor()/haircutRate(). Decimals are read via
 * erc20 `decimals()` (cash/liability are already WAD, so decimals only scale the swap amount in/out).
 */
export declare function discoverWombatPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, pools: FactoryConfig[]): Promise<WombatPool[]>;
/**
 * Discover EulerSwap pools for the pair AS TYPED `EulerSwapPool` descriptors (the EcoSwap path). The
 * EulerSwap factory has NO pool enumeration (only a `deployedPools` mapping + PoolDeployed events), so
 * discovery is KNOWN-POOL-ADDRESS based: each FactoryConfig.eulerSwapPools entry is a candidate pool, and
 * a (tokenIn,tokenOut) swap is valid iff the pool's {asset0, asset1} (getAssets) == {tokenIn, tokenOut}.
 *
 * BOTH EulerSwap VERSIONS COEXIST (like Uni V2/V3/V4 in this recipe). Each candidate's `curve()` bytes32
 * discriminates v1 ("EulerSwap v1") from v2 ("EulerSwap v2"), and discovery reads the matching curve-param
 * getter:
 *   · v1: getParams() — a STATIC 12-field struct (IMMUTABLE, packed in the MetaProxy trailing calldata):
 *     equilibriumReserve0/1, priceX/priceY, concentrationX/concentrationY, a SINGLE non-directional fee.
 *     There is NO getDynamicParams() on v1 (it REVERTS). This is the surface every currently-deployed pool
 *     exposes (mainnet factory 0xb013be1D…, Base factory 0xf0CFe22d…).
 *   · v2: getDynamicParams() — the mutable curve bundle with DIRECTIONAL fee0/fee1.
 * The curve MATH is identical (CurveLib.f/fInverse), so both versions normalize into the SAME
 * tokenIn-oriented `EulerSwapPool` descriptor and share prepare's `buildEulerSwapSegments` replay + the
 * version-agnostic on-chain exec (computeQuote/getAssets/swap). A v1 pool's off-chain computeQuote
 * reproduces the live pool's computeQuote view bit-for-bit (verified on 0x3bBCC029, 9 vectors both dirs).
 *
 * The curve math is OFF-CHAIN ONLY: this reads the live reserves (getReserves) + the static curve params
 * (getParams / getDynamicParams) + the vault `inLimit` (from getLimits), all oriented by tokenIn, so
 * prepare's `buildEulerSwapSegments` can replay computeQuote with NO further RPC (BOUNDED by the vault
 * cap), and the on-chain solver consumes the sampled segments statically + executes CALLBACK-FREE
 * (computeQuote staticcall + transfer + pool.swap(...,"") — NO engine SwapPoolType, since the asymmetric
 * Euler curve is NOT xy=k).
 *
 * Mirrors `discoverBalancerStablePoolsTyped` (known-pool-address, no factory getter): the FactoryConfig
 * carries the candidate pools in `eulerSwapPools`. Returns the venue descriptor EcoSwap prepare consumes
 * directly (the on-chain lens does not understand EulerSwap).
 */
export declare function discoverEulerSwapPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, factories: FactoryConfig[]): Promise<EulerSwapPool[]>;
/**
 * Discover Maverick V2 pools for the pair AS TYPED `MaverickPool` descriptors (the EcoSwap path —
 * distinct from the legacy `discoverMaverickV2Pools` PoolInfo aggregator, which mis-models a bin pool
 * as ONE synthetic sqrt). Maverick V2 is a BIN-based directional AMM: the curve is a per-tick
 * concentrated-liquidity walk (L re-derived per tick from (reserveA,reserveB)), NOT xy=k and NOT the
 * drift-invariant liquidityNet tick walk — so it is a SAMPLED-SEGMENT source. The bin math is OFF-CHAIN
 * ONLY: this reads getState (activeTick / protocolFeeRatioD3), tokenA/tokenB (orientation), the
 * DIRECTIONAL fee(tokenAIn), tickSpacing, and getTick over a window around the active tick, so prepare's
 * `buildMaverickSegments` can replay the bin swap-math with NO further RPC; the on-chain solver consumes
 * the sampled segments statically + EXECUTES the awarded Σ share via swap(SwapParams{poolType:7}) → live
 * _swapMaverickV2 (Maverick is a CALLBACK pool → the engine services maverickV2SwapCallback).
 *
 * Mirrors `discoverDodoV2PoolsTyped`: off-chain discovery + state reads, returning the venue descriptor
 * EcoSwap prepare consumes directly (the on-chain lens does not understand Maverick). Factory path:
 * lookup(tokenA, tokenB, 0, N) over BOTH token orderings (Maverick's lookup is order-dependent).
 *
 * ENGINE tickLimit — FULL RANGE. The FIXED engine `_swapMaverickV2` (../sauce PR #193) passes a
 * per-direction FULL-RANGE tickLimit (`tokenAIn ? type(int32).max : type(int32).min`), so a swap fills
 * across the WHOLE live tick book bounded only by liquidity — for ANY active-tick side (the fill may cross
 * tick 0 freely). Discovery therefore surfaces EVERY discovered liquid Maverick pool regardless of which
 * side of tick 0 its active tick sits on; there is NO active-tick side gate. (The OLD engine hardcoded
 * `tickLimit: 0` and needed a discovery-side gate to drop far-side pools — both vestiges were removed.)
 * The off-chain bin-walk in maverick-math.ts mirrors the same full-range bound (`engineTickLimit`).
 */
export declare function discoverMaverickV2PoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, factories: FactoryConfig[]): Promise<MaverickPool[]>;
/**
 * Public typed wrapper (the per-family discovery surface the tests/prepare drive directly).
 */
export declare function discoverInfinityCLPoolsTyped(tokenIn: Hex, tokenOut: Hex, client: PublicClient, factories: FactoryConfig[]): Promise<PoolInfo[]>;
/**
 * Discover all pools for a token pair across all protocols and factory types.
 *
 * @param poolConfig - Chain-specific factory/fee config. Defaults to Base.
 */
export declare function discoverPools(tokenIn: Hex, tokenOut: Hex, client: PublicClient, poolConfig?: ChainPoolConfig): Promise<PoolInfo[]>;
//# sourceMappingURL=pool-discovery.d.ts.map