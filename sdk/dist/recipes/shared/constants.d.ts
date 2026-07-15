/**
 * Chain addresses, swap constants, and per-chain pool discovery configs.
 *
 * Covers all major liquidity sources across supported chains:
 * V3-style (Uniswap V3, PancakeSwap V3, SushiSwap V3, Aerodrome CL, Velodrome CL, Ramses V3/CL)
 * Algebra-style (Camelot V3, QuickSwap V3, Ramses V2)
 * V2-style (Uniswap V2, SushiSwap V2, PancakeSwap V2, BaseSwap, Camelot V2, Zyberswap)
 * Solidly V2-style (Aerodrome V2, Velodrome V2, Ramses V2 Legacy, Chronos V1)
 * Curve, Balancer V2, DODO V2, Trader Joe LB, Maverick V2, WOOFi
 */
import type { Hex } from "viem";
export declare const WETH: Hex;
export declare const USDC: Hex;
export declare const DAI: Hex;
export declare const USDbC: Hex;
/** Base tokens used for multi-hop routing (Base chain default) */
export declare const BASE_TOKENS: readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`];
export declare enum SwapPoolType {
    UniV2 = 0,// Constant product AMM (xy=k) — Uniswap V2, SushiSwap, Solidly forks
    UniV3 = 1,// Concentrated liquidity — Uniswap V3, PancakeSwap V3, Algebra
    UniV4 = 2,// V4 with hooks
    Curve = 3,// Curve stable/crypto pools — exchange(i, j, dx, min_dy)
    BalancerV2 = 4,// Balancer V2 — via Vault singleton
    DODOV2 = 5,// DODO V2 PMM — sellBase/sellQuote
    TraderJoeLB = 6,// Trader Joe Liquidity Book — bin-based AMM
    MaverickV2 = 7,// Maverick V2 — directional AMM
    WOOFi = 8,// WOOFi sPMM — synthetic proactive market making
    PancakeInfinityCL = 9,
    PancakeInfinityBin = 10
}
export declare enum FactoryType {
    /** Uniswap V3 style: getPool(tokenA, tokenB, fee) across fee tiers, slot0() for state */
    V3Standard = "v3",
    /** Uniswap V4 singleton: poolId = keccak256(PoolKey), StateView.getSlot0(poolId) for state */
    UniswapV4 = "v4",
    /**
     * Algebra dynamic-fee style (Camelot V3, QuickSwap V3, Ramses V2): ONE pool per pair
     * (no fee tiers) discovered via `poolByPair(tokenA, tokenB)`. State is read from
     * `globalState()` (NOT slot0()): `price` (= sqrtPriceX96), `tick`, and the DYNAMIC fee
     * (`feeZto` for a zeroForOne swap, `feeOtz` for oneForZero). Algebra pools are V3-shaped
     * concentrated liquidity, so for DISCOVERY + PRICING they map to `poolType = UniV3`: the
     * tick walk (`ticks()[1]` = liquidityDelta = liquidityNet), the v3Segments oracle and the
     * on-chain per-pool frontier all read identically to Uniswap V3. The only Algebra-specific
     * work on that side is the state read (globalState in place of slot0) and threading the
     * per-pool dynamic fee through to `feePpm`; the fee is read once at quote time and treated
     * as fixed over the trade (the SAME snapshot assumption the recipe makes for fixed V3 tiers),
     * so a PRICE/split computed against an Algebra pool is wei-exact vs the V3 oracle at that fee.
     * The on-chain LENS reads this family directly (see ecoswap.lens.sauce.ts `algebraFactories`).
     *
     * EXECUTION IS SUPPORTED. An Algebra pool's `swap()` has the Uniswap-V3 selector (same 5
     * params: recipient, zeroToOne, amountRequired, limitSqrtPrice, data), so the Router's
     * `v3Pool.swap(...)` call in `_swapV3` dispatches; mid-swap the pool re-enters the caller via
     * `algebraSwapCallback(int256,int256,bytes)`, and the engine NOW implements that selector — a
     * mirror of `uniswapV3SwapCallback`/`pancakeV3SwapCallback` that routes to `_handleV3Callback`
     * (sauce#186; the SDK engine pin was bumped to `feat/engine-algebra-swap-callback`). So an
     * Algebra pool routes as UniV3 / `swapV3` and the mid-swap input pull is serviced exactly like
     * a Uniswap-V3 swap. The discovery/lens layers INCLUDE Algebra pools in the executable set (see
     * `discoverAlgebraPools` and `runLens`'s `includeAlgebra`, default on).
     * See LIQUIDITY_SOURCES_FEASIBILITY.md §3.
     *
     * NOTE: `Algebra` is a backward-compatible alias of this value (`= AlgebraV3`); both refer
     * to the same dynamic-fee globalState reader.
     */
    AlgebraV3 = "algebra",
    /** Uniswap V2 style: getPair(tokenA, tokenB), getReserves() for state */
    V2Standard = "v2",
    /** Solidly V2 style: getPool(tokenA, tokenB, stable) — queries both volatile and stable pools */
    SolidlyV2 = "solidly-v2",
    /** Curve registry: find_pool_for_coins(from, to) */
    CurveRegistry = "curve-registry",
    /**
     * Curve CryptoSwap registry (crypto/tricrypto Metaregistry): find_pool_for_coins(from, to) →
     * get_coin_indices (UINT256 i,j). CryptoSwap pools (twocrypto-ng / tricrypto-ng volatile-asset)
     * trade on the A-gamma invariant with a DYNAMIC fee (NOT the StableSwap A-invariant, NOT xy=k) AND
     * use uint256 coin indices, so the engine `_swapCurve` (exchange(int128,int128,...)) does NOT match
     * them. State: A()=ANN, gamma(), price_scale(), D(), balances(uint256), mid_fee/out_fee/fee_gamma.
     * The curve is priced OFF-CHAIN (bounded-Newton A-gamma replay) into sampled segments; CALLBACK-FREE:
     * executed in SauceScript (get_dy staticcall for min_dy + approve + exchange(uint256 i, uint256 j, Σ,
     * min_dy); Curve exchange PULLS via transferFrom), so no engine change. LOW priority (volatile-asset).
     */
    CurveCryptoRegistry = "curve-crypto-registry",
    /** Balancer V2: pool address → getPoolId() → Vault.swap() */
    BalancerV2 = "balancer-v2",
    /**
     * Balancer V3 (balancer/balancer-v3-monorepo — the successor to V2; deep stable/surge depth on
     * Ethereum/Base/Arbitrum and Beets on Sonic). Discovery is KNOWN-POOL-ADDRESS based (like V2 / EulerSwap /
     * Fluid): the FactoryConfig `address` is the CREATE2 Vault singleton
     * (0xbA1333333333a1BA1108E8412f11850A5C319bA9, SAME on all chains) and the candidate pool addresses are
     * carried per-config in `balancerV3Pools`, with the per-chain single-swap Router in `balancerV3Router`.
     * `discoverBalancerV3PoolsTyped` reads `Vault.getPoolTokens(pool)` to keep pools trading BOTH tokenIn and
     * tokenOut (V3 has NO BPT in the swappable token list, unlike V2 ComposableStable) and SAMPLES a LIVE
     * ladder via the Router's `querySwapSingleTokenExactIn(pool, tokenIn, tokenOut, +amountIn, sender, "")`
     * (which bakes in the rate providers AND any dynamic StableSurge hook fee — the robust surface for both
     * plain and surge pools). The curve is priced OFF-CHAIN into sampled segments from that ladder.
     * CALLBACK-FREE: executed in SauceScript (a live query staticcall for minAmountOut + ERC20.approve(PERMIT2)
     * + Permit2.approve(ROUTER) + Router.swapSingleTokenExactIn). The V3 reentrancy is fully contained inside
     * Balancer's own Router + Vault (Vault.unlock re-enters the ROUTER, never the cooking contract — the input
     * is PULLED via Permit2.transferFrom, the output arrives via Vault.sendTo), so it is callback-free and
     * needs NO engine change (contrast V4's unlockCallback, which the engine MUST service). SNAPSHOTTED-QUOTE
     * class (rate providers accrue + surge fee moves as the pool re-balances — treat the query as a snapshot;
     * the exec re-reads the live query as minAmountOut). Verified: Vault 0xbA13…bA9 on all chains; Routers
     * Base 0x3f17…DC10, Ethereum 0xAE56…8Ea2, Arbitrum 0xEAed…CF2E, Sonic 0x93db…Dae5; Permit2
     * 0x0000…78BA3 (canonical, all chains). See balancer-v3-math.ts + LIQUIDITY_SOURCES_FEASIBILITY.md.
     */
    BalancerV3 = "balancer-v3",
    /** DODO V2 (DVMFactory): getDODOPool(base, quote) → address[] → sellBase/sellQuote */
    DODOZoo = "dodo-zoo",
    /** Trader Joe LB: getLBPairInformation(tokenX, tokenY, binStep) */
    TraderJoeLB = "trader-joe-lb",
    /** Maverick V2: lookup(tokenA, tokenB, idx) */
    MaverickV2Factory = "maverick-v2",
    /** WOOFi: single pool per chain, query() for verification */
    WOOFi = "woofi",
    /**
     * Fermi / propAMM (gattaca-com/propamm FermiSwapper — an OBRIC-style proactive AMM). Discovery is
     * ROUTER-ADDRESS based: the FactoryConfig `address` is a FermiSwapper router (verified surface at
     * 0xb1076fe3ab5e28005c7c323bac5ac06a680d452e). propAMM prices off its OWN on-chain state, NOT xy=k. The
     * router exposes NO raw curve-state getters and NO getAmountOut view — only a SIGNED-amount quote
     * `quoteAmounts(tokenIn, tokenOut, int256 amountSpecified) -> (amountIn, amountOut)` (positive = exact-in),
     * a signed-amount swap `fermiSwapWithAllowances(tokenIn, tokenOut, int256, amountCheck, recipient)`, and
     * `isActive`/`getPairs`. Discovery checks `isActive` and SAMPLES a LIVE `quoteAmounts` ladder; the curve is
     * priced OFF-CHAIN into sampled segments from that ladder. CALLBACK-FREE: executed in SauceScript (a live
     * quoteAmounts staticcall for amountCheck + approve + fermiSwapWithAllowances; propAMM PULLS via
     * transferFrom, like Wombat/Curve — NOT transfer-first like WOOFi), so no engine change. SNAPSHOTTED-QUOTE
     * class (the split is priced off the sampled quote snapshot; the exec re-reads the live quote as
     * amountCheck). See LIQUIDITY_SOURCES_FEASIBILITY.md.
     */
    Fermi = "fermi",
    /**
     * KyberSwap Classic / DMM: amplified constant-product on VIRTUAL reserves.
     * Discovery: getPools(tokenA, tokenB) → per-pool getTradeInfo()
     * (reserve0, reserve1, vReserve0, vReserve1, feeInPrecision). The curve geometry
     * (sqrt/L) is keyed off the VIRTUAL reserves — a Kyber pool is mathematically a V2
     * range with L = isqrt(vReserveIn·vReserveOut) — and the per-pool fee is read live
     * (feeInPrecision is 1e18-scaled; rounded to ppm). Callback-free: executed in
     * SauceScript (transfer + pool.swap(a0, a1, to, "")) with the output computed on the
     * virtual reserves, so no engine change. Distinct from V2Standard only in the live
     * read (getTradeInfo vs getReserves) and the per-virtual-reserve output formula.
     */
    KyberClassic = "kyber-classic",
    /**
     * Wombat Exchange (single-sided stableswap). Discovery: the FactoryConfig `address` is a Wombat
     * Pool (multi-asset singleton); both tokens must be assets of the pool (addressOfAsset(token) !=
     * 0). State: per-asset cash()/liability() (WAD) + pool-wide ampFactor()/haircutRate() (WAD). The
     * curve is the coverage-ratio closed-form quote (CoreV2._swapQuoteFunc); priced OFF-CHAIN into
     * sampled segments. Callback-free: executed in SauceScript (approve + pool.swap(fromToken,
     * toToken, amount, minToAmount, to, deadline); Wombat PULLS via transferFrom), so no engine
     * change. Distinct from a stable pool only in the per-asset state read + the quote formula.
     */
    Wombat = "wombat",
    /**
     * EulerSwap (Euler vault-backed AMM). Discovery is KNOWN-POOL-ADDRESS based (the EulerSwap factory
     * has no pool enumeration — only a `deployedPools` mapping + PoolDeployed events), so the candidate
     * pool addresses are carried per-config in `FactoryConfig.eulerSwapPools` (like Balancer's
     * balancerStablePools). BOTH VERSIONS coexist: `discoverEulerSwapPoolsTyped` reads each pool's curve()
     * bytes32 to pick the curve-param getter — v1 ("EulerSwap v1") uses getParams() (a static immutable
     * 12-field struct with a SINGLE non-directional fee; the surface every currently-deployed pool exposes),
     * v2 ("EulerSwap v2") uses getDynamicParams() (directional fee0/fee1). State: live reserve0/reserve1 +
     * the static curve params (equilibriumReserve0/1, priceX/priceY, concentrationX/concentrationY, fee) +
     * the vault input cap from getLimits. The curve is the asymmetric concentrated-liquidity f/fInverse
     * (whitepaper), IDENTICAL across v1/v2; priced OFF-CHAIN into sampled segments (BOUNDED by the vault
     * inLimit). Callback-free: executed in SauceScript (computeQuote + transfer + pool.swap(amount0Out,
     * amount1Out, to, ""); EulerSwap's swap is V2-shaped, empty data ⇒ no flash callback — the only re-entry
     * is internal to Euler, never the cooking contract), so no engine change. The exec surface
     * (computeQuote/getAssets/swap) is version-agnostic.
     */
    EulerSwap = "eulerswap",
    /**
     * Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — a Liquidity-Layer-backed re-centering AMM;
     * high-volume ETH/Arbitrum stable venue). Discovery is KNOWN-POOL-ADDRESS based (the DexT1 pools are
     * deployed by a factory with no simple pair→pool getter on the swap surface), so the candidate DexT1
     * pool addresses are carried per-config in `FactoryConfig.fluidPools` (like EulerSwap's eulerSwapPools /
     * Balancer's balancerStablePools) and the periphery DexReservesResolver address in
     * `FactoryConfig.fluidResolver`. The DexT1 pool prices off the Liquidity-Layer supply/borrow exchange
     * prices + a center price + utilization/borrow caps — ALL canonical on-chain state, NOT xy=k — and
     * exposes NO getAmountOut view (its own estimate is a REVERT, FluidDexSwapResult, which SauceScript
     * can't try/catch). So discovery SAMPLES a LIVE ladder via the RESOLVER's
     * `estimateSwapIn(dex, swap0to1, +amountIn, 0)` (which does the pool's revert-decode in Solidity and
     * returns a plain uint256); the curve is priced OFF-CHAIN into sampled segments from that ladder.
     * CALLBACK-FREE: executed in SauceScript (a live resolver estimateSwapIn staticcall for amountOutMin +
     * approve + pool.swapIn(swap0to1, amt, amountOutMin, to); Fluid PULLS via safeTransferFrom inside swapIn,
     * approve-first, like Fermi/Wombat/Curve — NOT transfer-first like WOOFi), so no engine change (DexT1
     * re-enters its OWN Liquidity layer via operate(), never the cooking contract). SNAPSHOTTED-QUOTE class:
     * the split is exact-on-grid vs the oracle on the shared sampled ladder; the exec re-reads the live
     * estimate as amountOutMin. Verified surface: FluidDexT1 0x6d83f60eEac0e50A1250760151E81Db2a278e03a;
     * fluid-contracts-public poolT1/coreModule/core/main.sol + periphery/resolvers/dex/main.sol.
     */
    Fluid = "fluid",
    /**
     * Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager stablecoin exchange). Discovery is
     * ENUMERABLE via the Broker: the FactoryConfig `address` is the Broker (BrokerProxy). Mento is a BiPool
     * oracle-priced exchange — the Broker routes to a registered exchange provider (BiPoolManager) that prices
     * off oracle rates + a spread over interval-updated pricing buckets, NOT xy=k. Discovery is a two-step
     * enumeration: `Broker.getExchangeProviders()` → for each provider `provider.getExchanges()` → an
     * Exchange { bytes32 exchangeId; address[] assets; } matches (tokenIn,tokenOut) when {tokenIn,tokenOut}
     * == {assets[0],assets[1]} (unordered), yielding (exchangeProvider, exchangeId). The Broker has a PLAIN
     * `getAmountOut(exchangeProvider, exchangeId, tokenIn, tokenOut, amountIn)` VIEW (no revert-decode
     * resolver), so discovery SAMPLES that view over [0, amountIn] and the curve is priced OFF-CHAIN into
     * sampled segments from that ladder. CALLBACK-FREE: executed in SauceScript (a live Broker getAmountOut
     * staticcall for amountOutMin + approve the BROKER + broker.swapIn(exchangeProvider, exchangeId, tokenIn,
     * tokenOut, amt, amountOutMin); Mento PULLS via transferFrom into the reserve inside swapIn, approve-first
     * like Fermi/Wombat/Curve/Fluid — NOT transfer-first like WOOFi), so no engine change (swapIn re-enters
     * only the Reserve / stable-asset mint-burn, never the cooking contract). SNAPSHOTTED-QUOTE class (buckets
     * refresh only on config.referenceRateResetFrequency, gated by oracle reports — treat getAmountOut as a
     * snapshot; also subject to TradingLimits + BreakerBox reverts). The provider set is governance-mutable —
     * discovery goes through getExchangeProviders(), not a hardcoded BiPoolManager. Verified: Broker
     * 0x777A8255cA72412f0d706dc03C9D1987306B4CaD, BiPoolManager 0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901
     * (both source-verified EIP-1967 proxies on Celoscan). See mento-math.ts.
     */
    Mento = "mento",
    /**
     * Slipstream-family concentrated liquidity (Velodrome/Aerodrome Slipstream CLFactory, and the
     * Ramses-lineage forks Shadow Exchange CL). These are UniswapV3-compatible for PRICING and
     * EXECUTION — the pool exposes the standard V3 view surface (slot0, ticks, liquidity,
     * tickSpacing) and its swap() re-enters the caller via the exact `uniswapV3SwapCallback` selector
     * the engine Router already implements (the engine authenticates V3 callbacks via the transient
     * `expectedPool`, NOT a factory/CREATE2 check, so a Slipstream pool is accepted with NO engine
     * change and executes through the existing flat `swapV3` path unchanged). The ONLY thing that
     * differs from Uniswap V3 is DISCOVERY: the CLFactory keys pools by TICK SPACING, not fee —
     * `getPool(address tokenA, address tokenB, int24 tickSpacing)` — so a fee-tier-enumerating
     * V3Standard discovery finds nothing (which is why these CL entries were previously INERT under
     * V3Standard). This type enumerates a per-factory-overridable set of enabled tickSpacings
     * (`FactoryConfig.slipstreamTickSpacings`, defaulting to the Slipstream-common
     * [1, 50, 100, 200, 2000]) via `getPool(a, b, int24 tickSpacing)`, and — because Slipstream
     * DECOUPLES fee from tickSpacing — reads each surviving pool's OWN `fee()` getter to populate the
     * same `fee` field the V3 path uses (NOT a tickSpacing→fee assumption). The resulting `PoolInfo`
     * is byte-identical in shape to a V3Standard-discovered pool, so the downstream bracket / lens /
     * swapV3 path consumes it unchanged. See discoverSlipstreamCLPools in pool-discovery.ts.
     */
    SlipstreamCL = "slipstream-cl",
    /**
     * Tessera V (Wintermute's TesseraSwap wrapper + private engine — a treasury-funded proactive market
     * maker). Discovery is KNOWN-ADDRESS based (the BalancerV3 known-pool pattern): the FactoryConfig
     * `address` IS the wrapper (0x55555522005BcAE1c2424D474BfD5ed477749E3e — VERIFIED source on Base
     * blockscout, SAME address on BSC), and the wrapper exposes NO pair enumeration, so a pair is admitted
     * by ONE caught liveness quote probe (`tesseraSwapViewAmounts(tokenIn, tokenOut, +probeIn)[1] > 0` —
     * the view REVERTS "T33" on an unsupported pair). A QUOTE-LADDER family (segKind 15): prepare ships
     * only the descriptor; the on-chain solver builds the ladder LIVE from the wrapper's signed-amount
     * view via PROBE-THEN-DECODE (revert-class, like Fermi). CALLBACK-FREE exec: an on-chain
     * tesseraSwapViewAmounts staticcall for amountCheck + approve + tesseraSwapWithAllowances(tokenIn,
     * tokenOut, +Σ, amountCheck, to, "") — Tessera PULLS tokenIn via transferFrom and pays tokenOut from
     * its TREASURY, so no engine change. FORK-MEASURED FLAGS (2026-07-04, see tessera-math.ts): the
     * engine's `globalPrioFeeThresholddd1337` (= 2 gwei) shifts the QUOTE by fractions of a bp above the
     * threshold but the swap NEVER reverts on gas price (same-tx quote+swap wei-exact at 1–50 gwei); the
     * engine requires ~18.5M gas AVAILABLE at the call and burns all forwarded gas when starved — cook
     * with generous gas limits when a Tessera venue is in the universe.
     */
    Tessera = "tessera",
    /**
     * ElfomoFi (a vault-funded PMM priced by an on-chain pricing module + oracle feed). Discovery is
     * KNOWN-ADDRESS based: the FactoryConfig `address` IS the wrapper
     * (0xf0f0F0F0FB0d738452EfD03A28e8be14C76d5f73 — VERIFIED source on Base blockscout, SAME address on
     * BSC), and the wrapper's `getSupportedPairs()` enumerates the tradeable pairs (the natural discovery
     * surface; a listed pair quotes BOTH directions — verified live), then ONE graceful liveness probe
     * (`getAmountOut(tokenIn, tokenOut, probeIn) > 0`) gates admission. A QUOTE-LADDER family (segKind
     * 16): prepare ships only the descriptor; the on-chain solver builds the ladder LIVE from
     * `getAmountOut` — a GRACEFUL single-return staticcall (0 on an unsupported pair / STALE oracle feed ⇒
     * the ladder self-truncates; the WOOFi-tryQuery class, no probe-then-decode). CALLBACK-FREE exec: an
     * on-chain getAmountOut staticcall for limitAmount + approve + swap(tokenIn, tokenOut, +Σ,
     * limitAmount, to, 0) — Elfomo PULLS tokenIn via transferFrom and pays tokenOut from its VAULT, so no
     * engine change. FORK-MEASURED (2026-07-04, see elfomo-math.ts): same-tx quote+swap wei-exact,
     * gas-price-insensitive; the pricing hard-zeroes quotes once its feed goes ~5–30 s stale (live chains
     * never get there; the graceful 0 self-drops the venue, never a cook DoS).
     */
    Elfomo = "elfomo",
    /**
     * METRIC (metric.xyz — an oracle-anchored bin-curve OMM; per-pair pools priced off a maker-posted
     * PriceProvider anchor). Discovery is KNOWN-POOL-ADDRESS based (the BalancerV3/Fluid pattern):
     * `FactoryConfig.metricPools` carries the candidate per-pair pool addresses and
     * `FactoryConfig.metricRouter` the router serving them (PER-CONFIG, not chain-wide — Base runs TWO
     * routers over disjoint pool sets; the `address` field is the router too, an INERT placeholder for
     * the dedup key). NO on-chain enumeration exists (probed: getImmutables()[0] is a config/fee
     * contract whose poolDeployer() exposes only deploy+parameters — no count/index/pair getter; the
     * pool list is the token-gated api.metric.xyz metadata). A pool is admitted by reading its
     * getImmutables() (provider [1] / token0 [2] / token1 [3]), matching the pair, then ONE
     * probe-then-decode provider getBidAndAskPrice() (REVERTS 0x9a0423af when the maker's post is
     * older than MAX_TIME_DELTA ~10 s — a stale maker self-drops) + ONE router.quoteSwap liveness
     * probe at the first QL slice size (an empty pool quotes (0,0) gracefully — also drops). A
     * QUOTE-LADDER family (segKind 17): prepare ships only the descriptor (pool + provider + router +
     * xToY); the on-chain solver hoists the anchor once per venue and builds the ladder LIVE from
     * quoteSwap at the frozen (bid, ask) — the TWO-STEP quote (see metric-math.ts for the full probed
     * surface: the DIRECTIONAL price limit resolving the reverse direction, the signed-delta partial
     * fill, the int128 clamp, the staleness classes). CALLBACK-FREE exec from the cooking contract's
     * perspective: approve ROUTER + swapExactInput(pool, self, xToY, +Σ, limit, minAmountOut,
     * deadline) — the pool pays out first and re-enters metricOmmSwapCallback ON THE ROUTER (the
     * router implements it itself — fork-proven permissionless + wei-exact both directions), so no
     * engine change. All Metric contracts are UNVERIFIED (bytecode-probed only) — the prod-mirror
     * etches the genuine runtime.
     */
    Metric = "metric",
    /**
     * LIQUIDCORE (Liquid Labs liquidcore.xyz — HyperEVM-only oracle-priced RFQ pools, 100%
     * protocol-owned liquidity, priced off the Hyperliquid L1 spot book via the BBO READ PRECOMPILE
     * 0x…080e). Discovery is ROUTER-ENUMERATED (unlike Metric's known-pool-list): the config's
     * `address` is the ROUTER and `discoverLiquidCorePoolsTyped` calls its UNORDERED
     * `getPoolForPair(tokenIn, tokenOut)` (probed: both argument orders return the same pool; ONE
     * pool per pair) — 1 RPC per pair — then runs ONE `pool.estimateSwap` liveness probe at the first
     * QL slice size (probe-then-decode: zero/unsupported REVERT 0x1f2a2005/0xc1ab6dc1, a DRAINED pool
     * quotes 0 gracefully — either drops the pool). A QUOTE-LADDER family (segKind 18): prepare ships
     * only the descriptor (pool + tokens); the on-chain solver builds the ladder LIVE from
     * pool.estimateSwap and executes CALLBACK-FREE (approve POOL + pool.swap(tokenIn, tokenOut, Σ,
     * minOut) — permissionless, pull == approve always; fork-proven wei-exact same-block). See
     * liquidcore-math.ts for the full probe record (incl. the precompile-mock requirement for local
     * tests).
     */
    LiquidCore = "liquidcore",
    /**
     * INTEGRAL SIZE (integral.link TwapRelayer — instant swaps from relayer-held inventory at the
     * Uniswap-V3-TWAP price; VERIFIED source). Discovery is SINGLE-CONTRACT (the config's `address`
     * IS the chain's TwapRelayer proxy): `discoverSizePoolsTyped` probes `quoteBuy(tokenIn, tokenOut,
     * getTokenLimitMin(tokenOut))` (⇒ the lowest quotable input `minIn`; a TR3A revert means even the
     * min exceeds the live inventory cap — the venue drops) and ONE `quoteSell` liveness probe at
     * max(first-QL-slice, minIn) (probe-then-decode: TR03 below the OUT-window min, TR3A above the
     * inventory cap, TR5A disabled pair, TR17 no pair — the [min, cap] window is on the OUT amount).
     * A QUOTE-LADDER family (segKind 19): the on-chain solver RE-HOISTS the window LIVE per venue and
     * raises the ladder seed to minIn (the buildQLLadder seedFloor — see size-math.ts), builds the
     * ladder LIVE from quoteSell, and executes CALLBACK-FREE (approve RELAYER +
     * sell(SellParams{…, to: self, submitDeadline: 2^32−1}) — permissionless, pull == approve always;
     * fork-proven wei-exact same-block; a sub-min award soft-skips into the terminal refund).
     */
    IntegralSize = "integral-size",
    /**
     * PANCAKESWAP STABLESWAP (pancake-smart-contracts/projects/stable-swap — the BSC Solidity port
     * of the LEGACY Curve StableSwap 2-pool; VERIFIED source). Discovery is FACTORY-PAIR-KEYED: the
     * config's `address` is the PancakeStableSwapFactory and `discoverPancakeStablePoolsTyped` calls
     * its ORDER-INDEPENDENT `getPairInfo(tokenA, tokenB)` (sortTokens internally — probed both
     * orders; a non-existent pair returns the ZERO struct, no revert) → (swapContract, token0,
     * token1, LP), with token0/token1 the SORTED pair == the pool's coins order ⇒ the uint256 i/j
     * stamp per edge for free. NOT the Curve registry surface (`find_pool_for_coins` is absent —
     * the historical CurveRegistry-typed entry enumerated NOTHING), and NOT the engine `_swapCurve`
     * dispatch (the pools use UINT256 coin indices; the int128 get_dy REVERTS on probe). A
     * QUOTE-LADDER family (segKind 20, the CryptoSwap segKind-9 class): prepare ships only the
     * descriptor (pool + i/j + fee); the on-chain solver builds the ladder LIVE from
     * get_dy(uint256,uint256,uint256) (PROBE-THEN-DECODE — an EMPTY pool's get_D divides by zero ⇒
     * revert ⇒ self-drop; zero/oversize quote gracefully) and executes CALLBACK-FREE (coins(0)
     * orient + live get_dy as min_dy + approve POOL + exchange(uint256 i, uint256 j, Σ, min_dy) —
     * exchange pulls EXACTLY dx via safeTransferFrom, VERIFIED source ⇒ pull == approve, residue 0).
     * ONE liveness get_dy probe per pair at the first QL slice size drops dead/killed pools. See
     * pancakestable-math.ts for the full 2026-07-04 probe record (31 pools, USDT/USDC + USDT/BUSD +
     * lisUSD/USDT live depth) + the A_PRECISION=1 legacy replay.
     */
    PancakeStableSwap = "pancake-stable",
    /**
     * EKUBO V3 (EkuboProtocol/evm-contracts v3.1.1 — a till-based flash-accounting SINGLETON CL AMM:
     * ONE Core holds every pool as a storage-keyed VIRTUAL pool; micro-ticks base 1.000001, uint96
     * compact-float sqrt ratios; requires EIP-7939 CLZ — live on ETH mainnet). Discovery is the
     * V4-PRESET-CLONE, pure RPC: the config's `address` is the Core singleton
     * (0x00000000000014aA86C5d3c41765bb24e11bd701) and `discoverEkuboPoolsTyped` derives candidate
     * poolIds = keccak256(pad32(token0) ‖ pad32(token1) ‖ config) from the FROZEN (fee, tickSpacing)
     * preset menu (`ekuboPresets`, default EKUBO_DEFAULT_PRESETS — every entry attested by a live ETH
     * pool; fee word = round(pct × 2^64), live-confirmed per tier), then liveness-probes ALL
     * candidates in ONE raw `Core.sload` batch call (selector 0x380eb4e0 ++ N raw 32-byte keys — NOT
     * ABI-encoded; the poolState slot IS the poolId; sqrtRatio != 0 ⇔ initialized) + ONE
     * `Router.quote` eth_call per survivor at the first QL slice size. Extension pools are excluded
     * BY CONSTRUCTION (the menu packs extension 0 — MEVCapture pools add a same-block dynamic
     * anti-MEV fee); native-ETH pools (token0 == address(0)) are Phase-2 (ERC20 custody only). A
     * QUOTE-LADDER family (segKind 21): prepare ships only the descriptor (router + token0/token1/
     * config/poolId); the on-chain solver builds the ladder LIVE from
     * `MEVCaptureRouter.quote(key, isToken1, +xNext, 0, 0)` — a PLAIN CALL (the lock TSTOREs ⇒
     * staticcall-illegal; state-neutral on completion), PROBE-THEN-DECODE (PoolNotInitialized
     * 0x486aa307 ⇒ self-drop; oversize ⇒ a graceful PARTIAL fill that flatlines the ladder) — and
     * executes CALLBACK-FREE via the E0-pinned Option-A full-fill
     * `swap(key, isToken1, +consumed, 0, 0, threshold = quoted out, self)`: the exec re-quotes the
     * award in-tx, swaps exactly the quoted CONSUMED input (partial-fill-safe), and the router pulls
     * EXACTLY that via transferFrom(swapper → Core) — pull == approve, residue 0, fork-EXECUTED
     * wei-exact vs the same-state quote. CLAIMS are by POOLID (`ekubo|<poolId>` — the pools are
     * virtual inside ONE Core behind ONE router, so the address key would collide; see
     * qlVenueClaimKey). See ekubo-math.ts for the full E0 freeze record (selectors, revert classes,
     * the preset probe transcript).
     */
    Ekubo = "ekubo",
    /**
     * PANCAKESWAP INFINITY CL (pancakeswap/infinity-core — the V4-class singleton CL venue on
     * BSC/Base, same addresses via create3; ~$5.9B/30d CL run-rate on BSC). There is NO factory:
     * pools are VIRTUAL inside the CLPoolManager (state) with funds inside the Vault (accounting),
     * identified by `PoolId = keccak256(abi.encode(6-field PoolKey))` — key =
     * {currency0, currency1, hooks, poolManager, fee, parameters} where `parameters` packs the CL
     * tickSpacing at bits [16..39] and the hook-callback bitmap in the low 16 bits. Discovery is
     * the V4-PRESET CLONE: the config `address` IS the CLPoolManager and
     * `discoverInfinityCLPoolsTyped` derives candidate poolIds from the DATA-DERIVED joint
     * (fee, tickSpacing) preset menu (`infinityPresets`, default INFINITY_DEFAULT_CL_PRESETS —
     * from the full BSC Initialize-event scan; see infinity-math.ts), then batch-probes
     * getSlot0 + getLiquidity liveness directly on the CLPoolManager (no StateView needed — the
     * managers expose concrete getters; getSlot0 shares the V4-StateView selector/shape).
     *
     * A TICK-WALK universe member (pType 9 — the V4 sibling): micro-structure is
     * Uniswap-V4-identical (Q96 sqrt ratios, int24 ticks, drift-invariant `liquidityNet` at
     * getPoolTickInfo word [1]), so the bracket/frontier/oracle math is reused byte-identically.
     * TWO Infinity-specific deltas: (a) the boundary net read is `getPoolTickInfo(id, tick)[1]`
     * (vs StateView.getTickLiquidity); (b) the fee is combined LIVE ON-CHAIN per direction from
     * slot0 words [2]/[3] — `swapFee = prot + lp − prot·lp/1e6`, protocolFee packed 12+12 bits
     * per direction (nonzero on EVERY probed pool: 32/32 static, 300/300 dynamic) — the Algebra
     * live-fee pattern; the pool tuple's feePpm is the DIAGNOSTIC. EXECUTION goes through the
     * engine (every swap needs the Vault lock + `lockAcquired` serviced by compiled router code —
     * the V4-unlockCallback class): the recipe calls the flat onlySelf
     * `swapInfinityCL(vault, key, zeroForOne, −amt, limit, self, self)`, which returns
     * direction-NORMALIZED (−amountIn, +amountOut). The chain-wide Vault rides `infinityVault`
     * (solver cfg[13]).
     *
     * HOOK POLICY (tiered; 46/50 top-TVL CL pools are hooked, but 91.8% of the universe is
     * hookless): Tier A (LAUNCH) = hookless static-fee only — hooks == 0 AND parameters&0xFFFF
     * == 0 AND fee != 0x800000 (the preset menu enumerates exactly these). Tier B (config-gated,
     * SHIPS EMPTY/default-off) = hooked static-fee pools with NO returns-delta bitmap bits,
     * admitted ONLY when `infinityHookedPools` lists the poolId AND the on-chain-recovered key's
     * hook (`poolIdToPoolKey(bytes32)` — a PUBLIC CLPoolManager getter, probed live) is in
     * `infinityHookAllowlist` — amounts are deterministic (a static-fee hook cannot override the
     * fee — CLHooks source-verified) but a hook can revert/gate (anti-bot), so admission is a
     * config decision. Tier C (dynamic-fee, `fee == 0x800000`, slot0 lpFee=0) is quoter-only —
     * NOT walkable, excluded. Discovery hygiene: honeypot fee cap (INFINITY_MAX_FEE_PPM — the
     * permissionless 0..100% fee space carries thousands of ~99%-fee pools). Native-BNB pools
     * (currency0 == address(0) — 3 of the top-5) are engine-supported but SDK-Phase-2: discovery
     * keys on the recipe's ERC20 tokens. On-chain verified (BSC ~108.12M, 2026-07-04): Vault
     * 0x238a3588…, CLPoolManager 0xa0FfB9c1…, CLTickLens 0x8BcF3028…; USDT/Beat (fee 67, ts 1,
     * HOOKLESS — the venue's #1 TVL pool) slot0 (4.718e28, −10368, 131104, 67), L=7.67e23;
     * poolId keccak-reproduced 3/3. See infinity-math.ts + the IPancakeInfinity.sol header in
     * the engine repo (selector records).
     */
    PancakeInfinityCL = "infinity-cl"
}
/**
 * Slipstream-family CLFactory common enabled tickSpacings. Velodrome/Aerodrome Slipstream and the
 * Ramses-lineage Shadow CL forks enable this canonical set; a factory that enables a different set
 * overrides it per-config via `FactoryConfig.slipstreamTickSpacings`. Over-querying a spacing the
 * factory does not enable is harmless — `getPool(a,b,int24)` returns address(0) for it.
 */
export declare const SLIPSTREAM_TICK_SPACINGS: readonly [1, 50, 100, 200, 2000];
/**
 * Backward-compatible alias for the Algebra dynamic-fee factory type. `FactoryType.Algebra`
 * and `FactoryType.AlgebraV3` are the SAME value (the globalState/poolByPair reader) — use
 * either. Exposed so callers can write the shorter `FactoryType.Algebra`.
 */
export declare const ALGEBRA_FACTORY_TYPE = FactoryType.AlgebraV3;
export interface FactoryConfig {
    /** Factory address — or, for Uniswap V4, the PoolManager singleton address. */
    address: Hex;
    /** How the SauceRouter dispatches the swap (V2/V3/V4) */
    poolType: SwapPoolType;
    /** How to query pools from this factory */
    factoryType: FactoryType;
    /** Human-readable label for logging */
    label: string;
    /** Uniswap V4 only: the StateView lens used to read pool state by poolId. */
    stateView?: Hex;
    /**
     * Per-factory fee tiers (ppm). Overrides the chain's global `feeTiers` for THIS
     * factory only — needed because forks don't share tiers: PancakeSwap V3 uses
     * 2500 (0.25%) where Uniswap V3 uses 3000 (0.30%). When omitted, discovery falls
     * back to the chain-level `feeTiers`.
     */
    feeTiers?: number[];
    /**
     * V2-class only: the pool's constant-product swap fee in ppm (e.g. 3000 = 0.30%,
     * 500 = 0.05%). UniswapV2-clones at the canonical 0.30% omit this (defaults to
     * V2_DEFAULT_FEE_PPM = 3000). Set it for a fork whose V2-class pools charge a
     * different fee (Solidly volatile, some Sushi tiers) so the lens, the off-chain
     * oracle and the on-chain execution all use the SAME per-pool fee (wei-exact).
     *
     * The engine `_swapV2` hardcodes 0.30% (997/1000), so a pool with v2FeePpm != 3000
     * is executed via the callback-free SauceScript path (transfer + pool.swap) instead
     * of the unified router swap — no engine change. 3000-fee pools keep the router path.
     */
    v2FeePpm?: number;
    /**
     * Algebra (AlgebraV3) only: the FALLBACK per-pool `tickSpacing`. The lens reads every Algebra
     * pool's OWN `tickSpacing()` LIVE (shared selector with Uniswap V3) and derives its step ratio
     * ON-CHAIN (exact TickMath mirror — see the lens `stepRatioTs` helper), because Algebra spacing
     * is a PER-POOL property, not a factory constant: Integral pools are heterogeneous (nest hub 5
     * vs factory default 60; Kittenswap 10/60/500), and even Algebra 1.9/V1 pools drift from the 60
     * default (Camelot WETH/USDC = 10, SwapX wS/USDC = 5 — both probed on-chain 2026-07-04, as were
     * QuickSwap V3 / THENA Fusion / THENA Integral, ALL of which expose the getter). This config
     * value (default 60 when omitted) is used ONLY when a pool's `tickSpacing()` staticcall REVERTS
     * (no such lineage probed — a defensive graceful class). Ignored for non-Algebra factories.
     */
    algebraTickSpacing?: number;
    /**
     * Algebra (AlgebraV3) only: how this fork lays out the DYNAMIC fee in `globalState()`. Algebra forks
     * DIFFER in word 3, so the lens must decode the fee per-fork or a non-fee word (a timepointIndex up to
     * 65535 = 6.55%, or a pluginConfig) would poison the survivor filter + merge pricing:
     *   - `"camelot"` (DEFAULT): Camelot V3 / Ramses V2 (Algebra 1.9) — DIRECTIONAL fees. globalState() =
     *     (price, tick, feeZto, feeOtz, timepointIndex, …); the fee is word 2 for zeroForOne, word 3 for
     *     oneForZero. This is the pre-existing behavior (unchanged for existing Camelot/Ramses configs).
     *   - `"algebra-v1"`: Algebra V1 base (QuickSwap V3, THENA Fusion) — a SINGLE fee. globalState() =
     *     (price, tick, fee, timepointIndex, communityFee0, communityFee1, unlocked); the fee is ALWAYS
     *     word 2 (word 3 is the timepointIndex — NOT a fee).
     *   - `"integral"`: Algebra Integral / V2 (SwapX) — a SINGLE fee. globalState() = (price, tick, lastFee,
     *     pluginConfig, communityFee, unlocked); the fee is ALWAYS word 2 (word 3 is pluginConfig — NOT a fee).
     * `"algebra-v1"` and `"integral"` are equivalent to the lens (both single-fee at word 2); the distinct
     * names document the source layout. Ignored for non-Algebra factories.
     */
    algebraFeeLayout?: "camelot" | "algebra-v1" | "integral";
    /**
     * Slipstream CL (SlipstreamCL factory type) only: the tickSpacings this CLFactory enables. The
     * Slipstream CLFactory keys pools by tickSpacing — `getPool(tokenA, tokenB, int24 tickSpacing)` —
     * so discovery enumerates this list (defaulting to the Slipstream-common `SLIPSTREAM_TICK_SPACINGS`
     * = [1, 50, 100, 200, 2000] when omitted). Over-querying a spacing the factory does not enable is
     * harmless (getPool returns address(0)); set it to trim the enumerated set for a fork with a
     * narrower spacing menu. Ignored for non-Slipstream factories.
     */
    slipstreamTickSpacings?: number[];
    /**
     * Trader Joe LB (TraderJoeLB factory type) only: the binSteps this LBFactory enables. LB keys
     * pairs by binStep — `getLBPairInformation(tokenX, tokenY, binStep)` — so discovery enumerates
     * this list (defaulting to the Joe-common `TRADER_JOE_BIN_STEPS` = [1, 5, 10, 15, 20, 25] when
     * omitted). Over-querying a binStep the factory does not enable is harmless (the pair slot
     * returns address(0)); set it for a fork whose preset menu differs — Metropolis on Sonic
     * enables {2, 4, 30, 50, 100, 200} beyond the default set (its deepest wS/USDC pair sits at
     * binStep 4, INVISIBLE to the default enumeration). Verify a fork's menu on-chain via
     * `LBFactory.getAllBinSteps()` (v2.1+ presets list). Ignored for non-LB factories.
     */
    lbBinSteps?: number[];
    /**
     * Balancer V2 (BalancerV2 factory type) only: a KNOWN list of ComposableStable pool addresses to
     * probe for the pair. Balancer has NO pair→pool getter (the `address` here is the Vault, shared on
     * all chains), so discovery is known-pool-address based — `discoverBalancerStablePoolsTyped` reads
     * each pool's getPoolId / Vault.getPoolTokens / getAmplificationParameter / getScalingFactors /
     * getSwapFeePercentage / bptIndex and keeps the pools containing BOTH tokenIn and tokenOut (non-BPT).
     * PRODUCTION needs this populated from a known-poolId list / the Balancer subgraph (the standard
     * Balancer integration); the EVM test injects the locally-deployed fixture pool address here. Omitted
     * / empty ⇒ no Balancer pools surfaced (the prior behavior — the discovery gap is filled by config,
     * no engine change).
     */
    balancerStablePools?: Hex[];
    /**
     * Balancer V3 (BalancerV3 factory type) only: a KNOWN list of Balancer V3 pool addresses to probe for the
     * pair. Balancer V3 has NO pair→pool getter (the `address` on a BalancerV3 entry is the CREATE2 Vault
     * singleton 0xbA13…bA9, shared on all chains), so discovery is known-pool-address based —
     * `discoverBalancerV3PoolsTyped` reads `Vault.getPoolTokens(pool)`, keeps the pools trading BOTH tokenIn
     * and tokenOut (V3 has NO BPT in the swappable set, unlike V2), and SAMPLES a LIVE ladder via the Router's
     * `querySwapSingleTokenExactIn` (which bakes in rate providers + any dynamic surge-hook fee). PRODUCTION
     * populates this from the Balancer V3 pool index / subgraph; the EVM test injects the locally-deployed
     * fixture pool address directly. Omitted/empty ⇒ no Balancer V3 pools surfaced (the discovery gap is
     * filled by config, no engine change). Requires `balancerV3Router` to be set.
     */
    balancerV3Pools?: Hex[];
    /**
     * Balancer V3 (BalancerV3 factory type) only: the per-chain single-swap Router (RouterCommon-based, with
     * swapSingleTokenExactIn / querySwapSingleTokenExactIn). UNLIKE the Vault (a CREATE2 singleton, the same
     * on every chain), the Router address DIFFERS per chain — Base 0x3f17…DC10, Ethereum 0xAE56…8Ea2, Arbitrum
     * 0xEAed…CF2E, Sonic 0x93db…Dae5 — so it MUST be per-chain config. Both the off-chain discovery sampling
     * quote and the on-chain per-slice exec quote/swap go through this Router; one Router serves every V3 pool
     * on the chain (threaded chain-wide via the solver cfg). Required when `balancerV3Pools` is non-empty.
     */
    balancerV3Router?: Hex;
    /**
     * EulerSwap (EulerSwap factory type) only: a KNOWN list of EulerSwap pool addresses to probe for the
     * pair. The EulerSwap factory has NO pair→pool getter and no enumeration (only `deployedPools` +
     * PoolDeployed events), so discovery is known-pool-address based — `discoverEulerSwapPoolsTyped` reads
     * each pool's getAssets / getReserves / getDynamicParams (the static curve params + directional fee0/fee1)
     * / getLimits and keeps the pools trading BOTH tokenIn and tokenOut. PRODUCTION needs this populated from
     * the PoolDeployed-event index
     * (the standard EulerSwap integration); the EVM test injects the locally-deployed fixture pool address
     * directly (the test builds the prepared args without discovery). Omitted/empty ⇒ no EulerSwap pools
     * surfaced (the discovery gap is filled by config, no engine change).
     */
    eulerSwapPools?: Hex[];
    /**
     * Fluid DEX (Fluid factory type) only: a KNOWN list of FluidDexT1 pool addresses to probe for the pair.
     * The DexT1 pools have no simple pair→pool getter on the swap surface, so discovery is known-pool-address
     * based — `discoverFluidPoolsTyped` reads the resolver's getDexTokens(dex) to orient the pair (swap0to1;
     * the pool has NO token0()/token1() getters — they live only inside constantsView()'s struct) and
     * SAMPLES the resolver `estimateSwapIn` ladder, keeping the pools trading BOTH tokenIn and tokenOut with a
     * strictly-positive quote. PRODUCTION populates this from the Fluid pool index / subgraph; the EVM test
     * injects the locally-deployed fixture pool address directly. Omitted/empty ⇒ no Fluid pools surfaced (the
     * discovery gap is filled by config, no engine change).
     */
    fluidPools?: Hex[];
    /**
     * Fluid DEX (Fluid factory type) only: the periphery DexReservesResolver address. The DexT1 pool's own
     * estimate is a REVERT (FluidDexSwapResult) that SauceScript can't try/catch, so BOTH discovery sampling
     * and the on-chain per-slice exec quote go through the RESOLVER's
     * `estimateSwapIn(dex, swap0to1, amountIn, 0)` (it does the try/catch in Solidity and returns a plain
     * uint256). Required when `fluidPools` is non-empty. Verified: fluid-contracts-public
     * periphery/resolvers/dex/main.sol.
     */
    fluidResolver?: Hex;
    /**
     * Mento V2 (Mento factory type) only: an OPTIONAL hint of the exchange-provider addresses (BiPoolManager
     * etc.) to enumerate. Discovery is ENUMERABLE and self-describing — `discoverMentoPoolsTyped` calls
     * `Broker.getExchangeProviders()` (the FactoryConfig `address` is the Broker) to obtain the providers,
     * then `provider.getExchanges()` on each — so this field is NOT required (the provider set is
     * governance-mutable and discovered live). When present it RESTRICTS enumeration to these providers
     * (skipping getExchangeProviders); the canonical BiPoolManager is verified here for documentation /
     * a deterministic local-fixture path. Verified: BiPoolManager 0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901.
     */
    mentoExchangeProviders?: Hex[];
    /**
     * METRIC (Metric factory type) only: a KNOWN list of Metric per-pair pool addresses to probe for the
     * pair. Metric has NO on-chain enumeration (probed — see FactoryType.Metric), so discovery is
     * known-pool-address based: `discoverMetricPoolsTyped` reads each pool's `getImmutables()`
     * (provider [1] / token0 [2] / token1 [3]), keeps the pools trading BOTH tokenIn and tokenOut,
     * probe-then-decodes the provider anchor (a stale maker self-drops) and runs ONE router.quoteSwap
     * liveness probe (an empty pool quotes (0,0) — drops). PRODUCTION populates this from the
     * api.metric.xyz metadata (token-gated); the EVM test injects the locally-deployed fixture pool.
     * Omitted/empty ⇒ no Metric pools surfaced.
     */
    metricPools?: Hex[];
    /**
     * METRIC (Metric factory type) only: the Router serving THIS config's pools — the
     * quoteSwap/swapExactInput/approve target, and the contract implementing the pools'
     * metricOmmSwapCallback. PER-CONFIG (not chain-wide): Base runs TWO routers over disjoint pool
     * sets (0xA6A16C00… and 0x50Ef014e…), so a chain wires one Metric FactoryConfig per router. The
     * descriptor carries it per venue (qlv qd[7]). Required when `metricPools` is non-empty.
     */
    metricRouter?: Hex;
    /**
     * EKUBO (Ekubo factory type) only: the periphery MEVCaptureRouter — the quote/swap/approve target
     * (its extension==0 path is the base Router `CORE.swap`, source-verified identical; it also
     * transparently `forward`s MEVCapture-extension pools, which this recipe does not enumerate).
     * The descriptor carries it per venue (qlv qd[0]). PER-CONFIG (the create3 deployment reuses one
     * address across chains, but each chain's entry pins its own). Required when the entry's
     * factoryType is Ekubo.
     */
    ekuboRouter?: Hex;
    /**
     * EKUBO (Ekubo factory type) only: the FROZEN (fee u64, tickSpacing) preset menu the V4-clone
     * discovery derives candidate pool configs from (extension 0, concentrated bit set — see
     * ekubo-math.ts ekuboConcentratedConfig). Defaults to EKUBO_DEFAULT_PRESETS (every entry attested
     * by a live initialized ETH pool, 2026-07-04 batch probe). Over-probing a dead combo is harmless
     * (its poolState word reads 0 in the ONE batched sload); set this to extend/trim the menu per
     * chain without code.
     */
    ekuboPresets?: {
        fee: bigint;
        tickSpacing: number;
    }[];
    /**
     * PANCAKESWAP INFINITY CL (PancakeInfinityCL factory type) only: the chain's singleton Vault
     * (the flat `swapInfinityCL(vault, …)` arg + the engine's lock target; funds custody). The
     * `address` field on an Infinity entry is the CLPoolManager (state + getters + part of the
     * PoolKey). Chain-wide — threaded to the solver as cfg[13]. Required for an Infinity entry.
     */
    infinityVault?: Hex;
    /**
     * PANCAKESWAP INFINITY CL only: the periphery CLTickLens
     * (`getPopulatedTicksInWord(PoolId, int16)` — one call replaces bitmap-parse + N tick reads).
     * NOT used by the recipe runtime path (the on-chain lens walks getPoolTickInfo directly and
     * prepare consumes its emitted rows); carried for the snapshot/capture tooling
     * (harness/infinity-snapshot.ts) + future bulk net-cache fills. Optional.
     */
    infinityTickLens?: Hex;
    /**
     * PANCAKESWAP INFINITY CL only: the Tier-A (fee, tickSpacing) preset menu the V4-clone
     * discovery derives hookless candidate poolIds from. Defaults to INFINITY_DEFAULT_CL_PRESETS
     * (the DATA-DERIVED top joint pairs of the BSC hookless static-fee Initialize scan — see
     * infinity-math.ts; NOT a fee×ts cross-product). Over-probing a dead combo is harmless (its
     * getSlot0 reads sqrtPrice 0); each combo costs one discovery multicall row + one lens
     * candidate. Set per chain to extend/trim without code.
     */
    infinityPresets?: {
        fee: number;
        tickSpacing: number;
    }[];
    /**
     * PANCAKESWAP INFINITY CL only, Tier B (default-off): KNOWN hooked-pool candidate poolIds.
     * Discovery recovers each id's FULL 6-field key on-chain via the CLPoolManager's public
     * `poolIdToPoolKey(bytes32)` getter and admits the pool ONLY IF the recovered (not
     * config-trusted) key passes: hook ∈ `infinityHookAllowlist` AND fee != 0x800000 (static)
     * AND fee <= INFINITY_MAX_FEE_PPM AND parameters has NO returns-delta bits (amounts stay
     * deterministic — the launchpad 0x0045-class). Empty/omitted ⇒ Tier A only (the LAUNCH
     * shape). Tier-B pools join the walk via typed discovery (zero-cache: every boundary
     * staticcalls getPoolTickInfo — the 1-RPC-quote-path mechanics), not the lens.
     */
    infinityHookedPools?: Hex[];
    /**
     * PANCAKESWAP INFINITY CL only, Tier B (default-off): the hook-address ALLOWLIST gating
     * `infinityHookedPools` admission. SHIPS EMPTY — a hooked pool's hook can revert/gate the
     * sender mid-swap (anti-bot), so admitting a hook class is a product/risk call made per
     * config, never a code default.
     */
    infinityHookAllowlist?: Hex[];
}
/** Canonical UniswapV2 constant-product fee (ppm): 0.30%. */
export declare const V2_DEFAULT_FEE_PPM = 3000;
/**
 * Canonical Uniswap Permit2 singleton — SAME address on every EVM chain (cast-verified via
 * Balancer V3 Router.getPermit2() on Base/ETH/Arbitrum/Sonic). The Balancer V3 exec path pulls its
 * input through Permit2: the cooking contract ERC20.approve(PERMIT2, share) then
 * Permit2.approve(tokenIn, ROUTER, uint160(share), expiration) before Router.swapSingleTokenExactIn.
 */
export declare const PERMIT2: Hex;
/**
 * The CREATE2 Balancer V3 Vault singleton — the SAME address on every chain (cast-verified: code present
 * on Base/Ethereum/Arbitrum/Sonic). On a `FactoryType.BalancerV3` entry the FactoryConfig `address` is this
 * Vault (used only for `isPoolRegistered` / `getPoolTokens`); the per-chain Router (which drives the swap)
 * is `FactoryConfig.balancerV3Router`.
 */
export declare const BALANCER_V3_VAULT: Hex;
/**
 * KyberSwap Classic / DMM fee precision: feeInPrecision (from getTradeInfo) is scaled by
 * 1e18 (PRECISION). The recipe rounds it to ppm — feePpm = round(feeInPrecision·1e6/1e18) —
 * and uses the SAME rounded ppm in the off-chain oracle/reference AND the on-chain merge, so
 * the split stays wei-exact-by-construction. (The realized swap output is computed on-chain
 * from the live feeInPrecision at full 1e18 precision; the ppm rounding only affects the
 * price-ordering coordinate, which both sides share.)
 */
export declare const KYBER_FEE_PRECISION: bigint;
/** Round a Kyber feeInPrecision (1e18-scaled) to a ppm fee. */
export declare function kyberFeeToPpm(feeInPrecision: bigint): number;
export interface ChainPoolConfig {
    factories: FactoryConfig[];
    baseTokens: Hex[];
    feeTiers: number[];
}
/** Whether a pool type supports sqrtPriceLimitX96 */
export declare function hasPriceLimit(poolType: SwapPoolType): boolean;
/**
 * PancakeSwap V3 fee tiers (ppm). Pancake's medium tier is 2500 (0.25%), NOT the
 * 3000 (0.30%) Uniswap uses — so a single global `feeTiers` list misses Pancake's
 * canonical pool. Attached per-factory via `FactoryConfig.feeTiers`.
 */
export declare const PANCAKE_V3_FEE_TIERS: readonly [100, 500, 2500, 10000];
/**
 * Fee (ppm) → tickSpacing for the discovered fee-keyed V3 forks: the Uniswap standard tiers
 * (100/500/3000/10000 → 1/10/60/200), Pancake's 2500 → 50, Ramses CL's non-standard low
 * tiers 50 → 1 and 250 → 5 (on-chain verified on Arbitrum: getPool(USDC,USDT,50) → a pool with
 * tickSpacing() == 1), Project X's (HyperEVM) extra tiers 200 → 4, 400 → 8 and 1000 → 20, and
 * WAGMI's (Sonic) 1500 → 30 (both sets on-chain verified via each factory's
 * feeAmountTickSpacing(fee), 2026-07-03). Unknown tiers fall back to 60 — beware: on a fork
 * whose real spacing is finer, the 60-stride walk overstates per-step capacity ~(60/ts)× and
 * poisons the lens's relative-depth floor, so REAL tiers must be listed here. THE SINGLE SOURCE
 * for the recipe: lens.ts is the sole recipe consumer (prepare.ts keeps no copy — tickSpacing
 * flows to it from the lens rows); keep any duplicate map elsewhere in sync.
 */
export declare const TICK_SPACING_BY_FEE: Record<number, number>;
/** TICK_SPACING_BY_FEE lookup with the standard-V3 default of 60 for unknown tiers. */
export declare function feeToTickSpacing(fee: number): number;
export declare const UNISWAP_V4_POOL_MANAGER: Hex;
export declare const UNISWAP_V4_STATE_VIEW: Hex;
/** Base chain pool config (default for single-chain recipes) */
export declare const BASE_CHAIN_POOL_CONFIG: ChainPoolConfig;
/** Per-chain pool configs for cross-chain recipes */
export declare const CHAIN_POOL_CONFIGS: Record<string, ChainPoolConfig>;
export declare const MULTICALL3: Hex;
/** Minimum sqrt price ratio (from UniswapV3 TickMath) */
export declare const MIN_SQRT_RATIO = 4295128739n;
/** Maximum sqrt price ratio (from UniswapV3 TickMath) */
export declare const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
/** Balancer V2 Vault — same address on all EVM chains */
export declare const BALANCER_V2_VAULT: Hex;
/**
 * Trader Joe LB bin steps to query per factory — the DEFAULT enumeration when a factory's
 * `FactoryConfig.lbBinSteps` override is absent (canonical Joe menu; the Arbitrum Joe entry
 * relies on this default). Forks with a different preset menu (Metropolis on Sonic) set
 * `lbBinSteps` per factory — see the FactoryConfig field doc.
 */
export declare const TRADER_JOE_BIN_STEPS: readonly [1, 5, 10, 15, 20, 25];
/**
 * Trader Joe LB default static base-fee factor (`getStaticFeeParameters().baseFactor`). LB v2.1
 * pools commonly use 5000 (→ baseFee = 0.5·binStep%); read live per-pair where available, falls
 * back to this. The base fee is the FIXED snapshot fee the segment math grosses by (the variable
 * volatility fee is transient and omitted — the same per-block snapshot assumption used for V3).
 */
export declare const TRADER_JOE_DEFAULT_BASE_FACTOR = 5000;
/**
 * Trader Joe LB bin-scan window (bins on EACH side of the active bin) the typed discovery reads
 * into the off-chain segment enumerator. LB walks bins outward from the active id one per step;
 * a window of N bins covers a price excursion of (1+binStep/1e4)^N — at binStep 10 (0.1%), 256
 * bins ≈ a 13× excursion, far past any realistic split. Bounds the per-pair getBin multicall.
 */
export declare const TRADER_JOE_BIN_WINDOW: number;
//# sourceMappingURL=constants.d.ts.map