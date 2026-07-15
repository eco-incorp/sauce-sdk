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
// ── Tokens (Base chain) ──────────────────────────────────────
export const WETH = "0x4200000000000000000000000000000000000006";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const DAI = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
export const USDbC = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";
/** Base tokens used for multi-hop routing (Base chain default) */
export const BASE_TOKENS = [WETH, USDC, DAI, USDbC];
// ── Pool types ───────────────────────────────────────────────
// Must match Solidity: enum SwapPoolType in IRouter.sol
export var SwapPoolType;
(function (SwapPoolType) {
    SwapPoolType[SwapPoolType["UniV2"] = 0] = "UniV2";
    SwapPoolType[SwapPoolType["UniV3"] = 1] = "UniV3";
    SwapPoolType[SwapPoolType["UniV4"] = 2] = "UniV4";
    SwapPoolType[SwapPoolType["Curve"] = 3] = "Curve";
    SwapPoolType[SwapPoolType["BalancerV2"] = 4] = "BalancerV2";
    SwapPoolType[SwapPoolType["DODOV2"] = 5] = "DODOV2";
    SwapPoolType[SwapPoolType["TraderJoeLB"] = 6] = "TraderJoeLB";
    SwapPoolType[SwapPoolType["MaverickV2"] = 7] = "MaverickV2";
    SwapPoolType[SwapPoolType["WOOFi"] = 8] = "WOOFi";
    // PancakeSwap INFINITY (appended engine-side values 9/10 — ABI-safe). CL is a TICK-WALK
    // universe member (the V4-class sibling): virtual pools inside the CLPoolManager singleton,
    // funds inside the Vault, executed via the flat onlySelf `swapInfinityCL(vault, key, …)`
    // (the engine's lockAcquired services the Vault lock; the flat methods return
    // direction-NORMALIZED (−amountIn, +amountOut), NOT swapV4's raw currency deltas).
    SwapPoolType[SwapPoolType["PancakeInfinityCL"] = 9] = "PancakeInfinityCL";
    // Bin side (LB-class) — engine-supported (swapInfinityBin rides the same lockAcquired), SDK
    // family DEFERRED: Bin top-50 TVL ≈ $0.4M / vol7d ≈ $0.1M — CL-only ≈ full venue coverage.
    SwapPoolType[SwapPoolType["PancakeInfinityBin"] = 10] = "PancakeInfinityBin";
})(SwapPoolType || (SwapPoolType = {}));
// ── Factory discovery types ─────────────────────────────────
// Determines HOW to query pools from each factory
export var FactoryType;
(function (FactoryType) {
    /** Uniswap V3 style: getPool(tokenA, tokenB, fee) across fee tiers, slot0() for state */
    FactoryType["V3Standard"] = "v3";
    /** Uniswap V4 singleton: poolId = keccak256(PoolKey), StateView.getSlot0(poolId) for state */
    FactoryType["UniswapV4"] = "v4";
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
    FactoryType["AlgebraV3"] = "algebra";
    /** Uniswap V2 style: getPair(tokenA, tokenB), getReserves() for state */
    FactoryType["V2Standard"] = "v2";
    /** Solidly V2 style: getPool(tokenA, tokenB, stable) — queries both volatile and stable pools */
    FactoryType["SolidlyV2"] = "solidly-v2";
    /** Curve registry: find_pool_for_coins(from, to) */
    FactoryType["CurveRegistry"] = "curve-registry";
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
    FactoryType["CurveCryptoRegistry"] = "curve-crypto-registry";
    /** Balancer V2: pool address → getPoolId() → Vault.swap() */
    FactoryType["BalancerV2"] = "balancer-v2";
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
    FactoryType["BalancerV3"] = "balancer-v3";
    /** DODO V2 (DVMFactory): getDODOPool(base, quote) → address[] → sellBase/sellQuote */
    FactoryType["DODOZoo"] = "dodo-zoo";
    /** Trader Joe LB: getLBPairInformation(tokenX, tokenY, binStep) */
    FactoryType["TraderJoeLB"] = "trader-joe-lb";
    /** Maverick V2: lookup(tokenA, tokenB, idx) */
    FactoryType["MaverickV2Factory"] = "maverick-v2";
    /** WOOFi: single pool per chain, query() for verification */
    FactoryType["WOOFi"] = "woofi";
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
    FactoryType["Fermi"] = "fermi";
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
    FactoryType["KyberClassic"] = "kyber-classic";
    /**
     * Wombat Exchange (single-sided stableswap). Discovery: the FactoryConfig `address` is a Wombat
     * Pool (multi-asset singleton); both tokens must be assets of the pool (addressOfAsset(token) !=
     * 0). State: per-asset cash()/liability() (WAD) + pool-wide ampFactor()/haircutRate() (WAD). The
     * curve is the coverage-ratio closed-form quote (CoreV2._swapQuoteFunc); priced OFF-CHAIN into
     * sampled segments. Callback-free: executed in SauceScript (approve + pool.swap(fromToken,
     * toToken, amount, minToAmount, to, deadline); Wombat PULLS via transferFrom), so no engine
     * change. Distinct from a stable pool only in the per-asset state read + the quote formula.
     */
    FactoryType["Wombat"] = "wombat";
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
    FactoryType["EulerSwap"] = "eulerswap";
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
    FactoryType["Fluid"] = "fluid";
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
    FactoryType["Mento"] = "mento";
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
    FactoryType["SlipstreamCL"] = "slipstream-cl";
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
    FactoryType["Tessera"] = "tessera";
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
    FactoryType["Elfomo"] = "elfomo";
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
    FactoryType["Metric"] = "metric";
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
    FactoryType["LiquidCore"] = "liquidcore";
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
    FactoryType["IntegralSize"] = "integral-size";
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
    FactoryType["PancakeStableSwap"] = "pancake-stable";
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
    FactoryType["Ekubo"] = "ekubo";
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
    FactoryType["PancakeInfinityCL"] = "infinity-cl";
})(FactoryType || (FactoryType = {}));
/**
 * Slipstream-family CLFactory common enabled tickSpacings. Velodrome/Aerodrome Slipstream and the
 * Ramses-lineage Shadow CL forks enable this canonical set; a factory that enables a different set
 * overrides it per-config via `FactoryConfig.slipstreamTickSpacings`. Over-querying a spacing the
 * factory does not enable is harmless — `getPool(a,b,int24)` returns address(0) for it.
 */
export const SLIPSTREAM_TICK_SPACINGS = [1, 50, 100, 200, 2000];
/**
 * Backward-compatible alias for the Algebra dynamic-fee factory type. `FactoryType.Algebra`
 * and `FactoryType.AlgebraV3` are the SAME value (the globalState/poolByPair reader) — use
 * either. Exposed so callers can write the shorter `FactoryType.Algebra`.
 */
export const ALGEBRA_FACTORY_TYPE = FactoryType.AlgebraV3;
/** Canonical UniswapV2 constant-product fee (ppm): 0.30%. */
export const V2_DEFAULT_FEE_PPM = 3000;
/**
 * Canonical Uniswap Permit2 singleton — SAME address on every EVM chain (cast-verified via
 * Balancer V3 Router.getPermit2() on Base/ETH/Arbitrum/Sonic). The Balancer V3 exec path pulls its
 * input through Permit2: the cooking contract ERC20.approve(PERMIT2, share) then
 * Permit2.approve(tokenIn, ROUTER, uint160(share), expiration) before Router.swapSingleTokenExactIn.
 */
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/**
 * The CREATE2 Balancer V3 Vault singleton — the SAME address on every chain (cast-verified: code present
 * on Base/Ethereum/Arbitrum/Sonic). On a `FactoryType.BalancerV3` entry the FactoryConfig `address` is this
 * Vault (used only for `isPoolRegistered` / `getPoolTokens`); the per-chain Router (which drives the swap)
 * is `FactoryConfig.balancerV3Router`.
 */
export const BALANCER_V3_VAULT = "0xbA1333333333a1BA1108E8412f11850A5C319bA9";
/**
 * KyberSwap Classic / DMM fee precision: feeInPrecision (from getTradeInfo) is scaled by
 * 1e18 (PRECISION). The recipe rounds it to ppm — feePpm = round(feeInPrecision·1e6/1e18) —
 * and uses the SAME rounded ppm in the off-chain oracle/reference AND the on-chain merge, so
 * the split stays wei-exact-by-construction. (The realized swap output is computed on-chain
 * from the live feeInPrecision at full 1e18 precision; the ppm rounding only affects the
 * price-ordering coordinate, which both sides share.)
 */
export const KYBER_FEE_PRECISION = 10n ** 18n;
/** Round a Kyber feeInPrecision (1e18-scaled) to a ppm fee. */
export function kyberFeeToPpm(feeInPrecision) {
    return Number((feeInPrecision * 1000000n + KYBER_FEE_PRECISION / 2n) / KYBER_FEE_PRECISION);
}
/** Whether a pool type supports sqrtPriceLimitX96 */
export function hasPriceLimit(poolType) {
    return poolType === SwapPoolType.UniV3 || poolType === SwapPoolType.UniV4;
}
/**
 * PancakeSwap V3 fee tiers (ppm). Pancake's medium tier is 2500 (0.25%), NOT the
 * 3000 (0.30%) Uniswap uses — so a single global `feeTiers` list misses Pancake's
 * canonical pool. Attached per-factory via `FactoryConfig.feeTiers`.
 */
export const PANCAKE_V3_FEE_TIERS = [100, 500, 2500, 10000];
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
export const TICK_SPACING_BY_FEE = { 50: 1, 100: 1, 200: 4, 250: 5, 400: 8, 500: 10, 1000: 20, 1500: 30, 2500: 50, 3000: 60, 10000: 200 };
/** TICK_SPACING_BY_FEE lookup with the standard-V3 default of 60 for unknown tiers. */
export function feeToTickSpacing(fee) {
    return TICK_SPACING_BY_FEE[fee] ?? 60;
}
// ── Uniswap V4 (Base) ────────────────────────────────────────
// Declared above the chain configs so BASE_CHAIN_POOL_CONFIG can reference them.
export const UNISWAP_V4_POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
export const UNISWAP_V4_STATE_VIEW = "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71";
// ── Chain configs ────────────────────────────────────────────
/** Base chain pool config (default for single-chain recipes) */
export const BASE_CHAIN_POOL_CONFIG = {
    factories: [
        // V3 concentrated liquidity (has price limit)
        { address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3" },
        { address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "PancakeSwap V3", feeTiers: [...PANCAKE_V3_FEE_TIERS] },
        // Aerodrome CL (Velodrome Slipstream on Base) — tickSpacing-keyed getPool(a,b,int24). Verified
        // on-chain: getPool(WETH,USDC,int24) returns non-zero pools across tickSpacings {1,50,100,200,2000},
        // and fee() is DECOUPLED from tickSpacing (ts=100 pool → fee 50 ppm; ts=1 pool → fee 80 ppm), so the
        // per-pool fee is READ from fee(). V3-compatible for execution (swapV3 / uniswapV3SwapCallback).
        { address: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Aerodrome CL" },
        { address: "0x71524B4f93c58fcbF659783284E38825f0622859", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
        // KyberSwap Elastic REMOVED: Elastic is NOT V3-compatible (getPoolState()/its own swap, no slot0) — a queried-tier collision reverts the whole lens eth_call; needs its own FactoryType before re-adding.
        // Algebra dynamic-fee (V3-shaped; poolByPair + globalState). EXECUTABLE — the engine now
        // implements algebraSwapCallback (sauce#186), so an Algebra pool routes as UniV3 / swapV3 and
        // the mid-swap input pull is serviced (see FactoryType.AlgebraV3). PLACEHOLDER address — Base
        // had no canonical Algebra deployment at authoring; the TYPE + globalState reader are wired so
        // a real Base Algebra fork drops in by address alone (it will then be discovered, priced AND
        // executed). The arbitrum (Camelot V3, Ramses V2) and polygon (QuickSwap V3) configs below
        // carry REAL Algebra factories on this same type.
        { address: "0x0000000000000000000000000000000000000000", poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "Algebra (placeholder)" },
        // V4 singleton (PoolManager + StateView lens)
        { address: UNISWAP_V4_POOL_MANAGER, stateView: UNISWAP_V4_STATE_VIEW, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4" },
        // V2 constant-product (no price limit)
        { address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Uniswap V2" },
        { address: "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "PancakeSwap V2" },
        { address: "0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "BaseSwap V2" },
        // Solidly V2 (volatile + stable pools)
        { address: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Aerodrome V2" },
        // Maverick V2
        { address: "0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e", poolType: SwapPoolType.MaverickV2, factoryType: FactoryType.MaverickV2Factory, label: "Maverick V2" },
        // Curve (MetaRegistry — the resolved AddressProvider.get_address(7) address, hardcoded here; find_pool_for_coins).
        { address: "0x87DD13Dd25a1DBde0E1EdcF5B8Fa6cfff7eABCaD", poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
        // WOOFi (WooPPV2 sPMM — deterministic single-address deployment).
        { address: "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4", poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "WOOFi" },
        // Balancer V3 (Vault singleton 0xbA13…bA9 + per-chain Router; callback-free typed path via Permit2).
        // This is the Base V3 depth the config-audit flagged as MISSING under the V2-only Balancer wiring (the
        // Base V2 stable pools are dust). Known-pool-address discovery: `balancerV3Pools` = V3 pool addresses
        // (probed via Vault.getPoolTokens), `balancerV3Router` = the Base single-swap Router. On-chain verified
        // at block 48120153: isPoolRegistered=true, getPoolTokens = [waGHO 0x88b1…, waUSDC 0xC768…], staticFee
        // 5e13, StableSurge-hooked (0xb200…f007), and querySwapSingleTokenExactIn(pool, waUSDC, waGHO, 100e6) →
        // 107.79 waGHO (surge-fee-inclusive; reverse 100e18 waGHO → 92.65 waUSDC). The querySwap surface bakes in
        // the rate providers + dynamic surge fee, so the sampled ladder is robust for this SURGE pool (a static
        // StableMath replay could NOT price it). The swappable tokens are the ERC4626 WRAPPERS (waGHO/waUSDC),
        // NOT raw GHO/USDC — reachable only when the wrappers are among the discovery baseTokens/route hops.
        // poolType UniV2 is INERT for Balancer V3 (discovery keys off factoryType; V3 executes callback-free via
        // its own EcoBalancerV3 path, never a UniV2 router swap) — a placeholder, not a UniV2 claim.
        { address: "0xbA1333333333a1BA1108E8412f11850A5C319bA9", poolType: SwapPoolType.UniV2, factoryType: FactoryType.BalancerV3, label: "Balancer V3",
            balancerV3Router: "0x3f170631ed9821Ca51A59D996aB095162438DC10",
            balancerV3Pools: [
                "0x7ab124ec4029316c2a42f713828ddf2a192b36db",
            ] },
        // Tessera V (Wintermute TesseraSwap wrapper — treasury-funded prop-AMM; QL segKind 15). KNOWN-ADDRESS
        // discovery: the wrapper IS the venue (no pair enumeration — admission is one caught
        // tesseraSwapViewAmounts liveness probe). On-chain verified (2026-07-04): VERIFIED source on Base
        // blockscout; live probes — WETH→USDC 1e18 → ~1757.8e6 (and USDC→WETH both ways), unsupported pair
        // reverts "T33", zero amount reverts "T10", oversized returns (in, 0) graceful; same-tx quote+swap
        // executed wei-exact at 1/2/2+1wei/5/50 gwei legacy gas price (the engine's ~2-gwei
        // globalPrioFeeThresholddd1337 shifts the quote by <1bp above threshold, NEVER reverts the swap);
        // engine 0x31e99E05…0c17 (unverified), treasury 0x3dBE077e…0AaE (USDC ~549k + WETH ~322 inventory,
        // max allowance to the wrapper). GAS: the engine demands ~18.5M gas AVAILABLE at the call and burns
        // all forwarded gas when starved — cook with generous limits (see tessera-math.ts). poolType UniV2 is
        // INERT for Tessera (discovery keys off factoryType; Tessera executes callback-free via its own
        // EcoTessera path, never a UniV2 router swap) — a placeholder, not a UniV2 claim.
        { address: "0x55555522005BcAE1c2424D474BfD5ed477749E3e", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Tessera, label: "Tessera V" },
        // ElfomoFi (vault-funded PMM + on-chain pricing module; QL segKind 16). KNOWN-ADDRESS discovery with
        // in-wrapper pair ENUMERATION (getSupportedPairs). On-chain verified (2026-07-04): VERIFIED source on
        // Base blockscout; getSupportedPairs = [[WETH,USDC],[cbBTC,USDC],[0xfde4…9bb2,USDC]] (a listed pair
        // quotes BOTH directions — verified); getAmountOut GRACEFUL (0 on unsupported pair / zero / stale
        // feed; oversized quotes a real collapsing-marginal value); same-tx quote+swap executed wei-exact,
        // gas-price-insensitive (1 vs 5 gwei). Pricing proxy 0xFFFFffBB…d038 → impl 0x00E36cE2…FbD9, oracle
        // feed 0xf9b0c8Ee…8081 (hard staleness cutoff ~5–30 s — live chains never get there), vault
        // 0xBb1b19F1…0C99 (max allowance to the wrapper). poolType UniV2 is INERT for Elfomo (same placeholder
        // convention as Tessera/Fluid/BalancerV3).
        { address: "0xf0f0F0F0FB0d738452EfD03A28e8be14C76d5f73", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Elfomo, label: "ElfomoFi" },
        // METRIC (metric.xyz oracle-anchored bin-curve OMM; QL segKind 17). KNOWN-POOL-ADDRESS discovery
        // (no on-chain enumeration — probed; the pool list is the api.metric.xyz metadata). Base runs TWO
        // routers over DISJOINT pool sets ⇒ one FactoryConfig per router (metricRouter is per-config; the
        // descriptor carries it per venue). On-chain verified (2026-07-04, block ~48.19M):
        //  · WETH/USDC 0x770004fE… (~110 WETH + ~155k USDC inventory; provider 0x69454A23…): quoteSwap
        //    fwd 1e18 WETH → −1765.09e6 USDC @ limit 0; rev 1000e6 USDC → −0.5663e18 WETH @ limit
        //    uint128.max (the DIRECTIONAL limit convention — the wrong side quotes (0,0) gracefully);
        //    fork-executed swapExactInput from a random EOA BOTH directions, wei-exact vs the same-block
        //    quote; oversize 900 WETH partial-filled (+87.94 consumed) — quote == realized to the wei.
        //  · cbBTC/USDC 0x0fcBb3f9… (~1.34 cbBTC + ~64.5k USDC) + WETH/cbBTC 0xeF05E733… (~7.95 WETH +
        //    ~1.30 cbBTC) live on the same router; WETH/USDC 0x49657410… (~3.76 WETH + ~11.3k USDC) on
        //    the second router. Empty/dust same-pair pools (0x12939Ae3…, 0x37bd23Cc…, 0xa07938EA…, …)
        //    deliberately NOT wired (an empty pool quotes (0,0) and would only self-drop — RPC waste).
        // Provider staleness (getBidAndAskPrice REVERTS 0x9a0423af past MAX_TIME_DELTA = 10 s; measured
        // by fork time-warp) is handled by the probe-then-decode hoist — a quiet maker self-drops. All
        // Metric contracts are UNVERIFIED (bytecode-probed; selector-resolved via openchain) — the
        // prod-mirror etches the genuine runtime. poolType UniV2 is INERT for Metric (discovery keys off
        // factoryType; Metric executes callback-free via its own EcoMetric path — the ROUTER services the
        // pool's metricOmmSwapCallback itself) — a placeholder, not a UniV2 claim.
        { address: "0xA6A16C00B7E9DBE1D54acEd7d6FE264fc4732eaF", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Metric, label: "Metric",
            metricRouter: "0xA6A16C00B7E9DBE1D54acEd7d6FE264fc4732eaF",
            metricPools: [
                "0x770004fE4411E42eA51a7fcAca32b267d791f3D4", // WETH/USDC (deep; provider 0x69454A23…)
                "0x0fcBb3f9aecc556dE81EE756F01191d94a3D085E", // cbBTC/USDC (provider 0xaF291D47…)
                "0xeF05E733970c37b6A2f863DE0db9378eA49447cC",
            ] },
        { address: "0x50Ef014e95D23b970b6AF711d882d33ae9B559C0", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Metric, label: "Metric (router 2)",
            metricRouter: "0x50Ef014e95D23b970b6AF711d882d33ae9B559C0",
            metricPools: [
                "0x4965741dC7989506672dbEB040DF56230a6dF894",
            ] },
        // Balancer V2 / Fluid / EulerSwap / Fermi on Base: LEFT EMPTY + FLAGGED (verified, none is a deep
        // both-baseToken stable venue):
        //  · Balancer V2 — the deepest V2 stable pools holding baseTokens are dust: USDC/USDbC/axlUSDC
        //    0x0C65…86Db (~$1.4k) and DAI-USDbC 0x6FbF…83e9 (~$1.5k); not worth wiring.
        //  · Fluid DEX — the FluidDexT1 pools on Base pair USDC against non-baseToken stables (EURC, yoUSD,
        //    wstUSR, sUSDe, sUSDai, GHO, USDe); NONE pairs two Base baseTokens (USDC/DAI/USDbC), so nothing
        //    is routable via the stablecoin baseTokens.
        //  · EulerSwap — the Base factory 0xf0CFe22d…1262 pools trade WETH/USDC, cbBTC/USDC, EURC/USDC, etc.
        //    (no both-baseToken stable pair) AND expose a non-v2 surface (getDynamicParams reverts).
        //  · Fermi — no FermiSwapper deployment on Base (router 0xb1076fe3… is Ethereum-only).
    ],
    baseTokens: [
        WETH, USDC, DAI, USDbC,
        "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    ],
    feeTiers: [100, 500, 3000, 10000],
};
/** Per-chain pool configs for cross-chain recipes */
export const CHAIN_POOL_CONFIGS = {
    base: BASE_CHAIN_POOL_CONFIG,
    ethereum: {
        factories: [
            // V3 concentrated liquidity (has price limit)
            { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3" },
            { address: "0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
            { address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "PancakeSwap V3", feeTiers: [...PANCAKE_V3_FEE_TIERS] },
            // KyberSwap Elastic REMOVED: Elastic is NOT V3-compatible (getPoolState()/its own swap, no slot0) — a queried-tier collision reverts the whole lens eth_call; needs its own FactoryType before re-adding.
            // V4 singleton (PoolManager + StateView lens). Official Uniswap V4 mainnet deployment.
            { address: "0x000000000004444c5dc75cB358380D2e3dE08A90", stateView: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227", poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
            // V2 constant-product (no price limit)
            { address: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Uniswap V2" },
            { address: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "SushiSwap V2" },
            { address: "0x1097053Fd2ea711dad45caCcc45EfF7548fCB362", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "PancakeSwap V2" },
            // Curve
            { address: "0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5", poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
            // Curve CryptoSwap (the twocrypto-ng FACTORY is the CryptoSwap registry surface:
            // find_pool_for_coins / get_coin_indices → UINT256 i,j — the shape curveCryptoRegistryAbi expects;
            // the factory implements NEITHER registry get_n_coins NOR get_decimals, which the adapter's .catch
            // fallbacks cover via the pool's own coins()/ERC20 decimals()). On-chain verified 2026-07-03:
            // find_pool_for_coins(crvUSD,WETH) → 0x6e5492F8… (BOTH orderings — the prod-mirror pool, version
            // "v2.1.0d", the exact family cryptoswap-math.ts replays wei-exact; ~15.0M crvUSD / ~16.8k WETH),
            // get_coin_indices → (0,1), get_dy(0,1,1000e18) → 0.5645 WETH live. poolType Curve is INERT for
            // CryptoSwap (discovery keys off factoryType; crypto pools flow into the EcoCryptoSwap QL bucket,
            // executed CALLBACK-FREE via exchange(uint256,uint256,…) — never the engine _swapCurve int128 path).
            // NOTE (cryptoswap-math.ts LIMITATIONS): a pool of ANOTHER generation resolved by this registry
            // would be mismodeled in the off-chain liveness probe only — the QL ladder is built on-chain from
            // LIVE get_dy and min_dy is the pool's own get_dy, so mis-split-only, never mis-execute.
            { address: "0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F", poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveCryptoRegistry, label: "Curve CryptoSwap (twocrypto-ng)" },
            // Balancer V2 (Vault address — pool discovery via known ComposableStable pool addresses).
            // On-chain verified via Vault.getPoolTokens(getPoolId(pool)) — the two deepest V2 stable pools
            // holding baseTokens (the plain-stablecoin V2 pools have largely migrated to V3/boosted, so these
            // are the surviving raw-USDC/USDT/DAI venues):
            //   0x8353…Cb2aF  GHO/USDT/USDC ComposableStable  (USDC ≈32,521 · USDT ≈40,357 · GHO ≈47,353; ~$120k)
            //   0x06Df…1b42  USD Stable Pool DAI/USDC/USDT     (DAI ≈8,550 · USDC ≈8,526 · USDT ≈18,576; ~$35k)
            { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Balancer V2",
                balancerStablePools: [
                    "0x8353157092ED8Be69a9DF8F95af097bbF33Cb2aF", // GHO/USDT/USDC ComposableStable
                    "0x06Df3b2bbB68adc8B0e302443692037ED9f91b42",
                ] },
            // Balancer V3 (Vault singleton 0xbA13…bA9 + per-chain Router; callback-free typed path via Permit2).
            // Known-pool-address discovery: `balancerV3Pools` = V3 pool addresses (probed via Vault.getPoolTokens),
            // `balancerV3Router` = the Ethereum single-swap Router (querySwapSingleTokenExactIn quotes — INCLUDES
            // the rate providers + any StableSurge dynamic fee, the robust surface for the boosted/wrapped legs).
            // On-chain verified at block 25447676: isPoolRegistered=true, getPoolTokens = [waUSDT 0x7Bc3…, waGHO
            // 0xC71E…, waUSDC 0xD4fa…] (all WITH_RATE ERC4626 wrappers), and querySwapSingleTokenExactIn(pool,
            // waUSDC, waUSDT, 100e6) → 100.85 waUSDT. NOTE the pool's swappable tokens are the ERC4626 WRAPPERS
            // (waUSDC/waUSDT/waGHO), NOT the raw stablecoins — reachable only when the wrappers are among the
            // discovery baseTokens/route hops; the raw-USDC/USDT legs go through the wrapper's ERC4626
            // deposit/redeem, out of the direct-swap scope. poolType UniV2 is INERT for Balancer V3 (discovery keys
            // off factoryType; V3 executes callback-free via its own EcoBalancerV3 path, never a UniV2 router swap)
            // — a placeholder, not a UniV2 claim.
            { address: "0xbA1333333333a1BA1108E8412f11850A5C319bA9", poolType: SwapPoolType.UniV2, factoryType: FactoryType.BalancerV3, label: "Balancer V3",
                balancerV3Router: "0xAE563E3f8219521950555F5962419C8919758Ea2",
                balancerV3Pools: [
                    "0x85b2b559bc2d21104c4defdd6efca8a20343361d",
                ] },
            // Fluid DEX (Instadapp FluidDexT1 — Liquidity-Layer re-centering AMM; callback-free typed path).
            // Known-pool-address discovery: `fluidPools` = FluidDexT1 pool addresses, `fluidResolver` = the
            // periphery DexResolver (getDexTokens orients the pair; estimateSwapIn quotes — the pool has no
            // getAmountOut view). On-chain verified: DexFactory.getDexAddress(id) → getDexTokens (correct
            // resolver 0x11D80… returns token0/token1; the DexReservesResolver 0x05Bd… reverts getDexTokens, so
            // the DexResolver is the one wired) → both pools are USDC/USDT (both baseTokens). estimateSwapIn
            // depth: dexId2 0x6677…9F9B deep (1M USDC → 1.0006M USDT), dexId34 0xea73…15C0 thin (quotes small
            // sizes — 10k USDC → 10,003 USDT; truncates to 0 past ~few-tens-of-thousands-$).
            // poolType UniV2 is INERT for Fluid: discovery keys off factoryType (Fluid), and Fluid venues flow
            // into their own EcoFluid bucket executed via the callback-free typed path — never dispatched as a
            // UniV2 router swap. It is a placeholder, not a claim that Fluid is a UniV2 pool.
            { address: "0x91716C4EDA1Fb55e84Bf8b4c7085f84285c19085", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Fluid, label: "Fluid DEX",
                fluidResolver: "0x11D80CfF056Cef4F9E6d23da8672fE9873e5cC07",
                fluidPools: [
                    "0x667701e51B4D1Ca244F17C78F7aB8744B4C99F9B", // USDC/USDT (deep)
                    "0xea734B615888c669667038D11950f44b177F15C0",
                ] },
            // EulerSwap (Euler vault-backed AMM; callback-free typed path). Discovery is known-pool-address
            // based (the EulerSwap factory 0xb013be1D0D380C13B58e889f412895970A2Cf228 has NO pair→pool getter,
            // only `deployedPools` + PoolDeployed events), so `eulerSwapPools` carries the candidate pool
            // addresses. `discoverEulerSwapPoolsTyped` now handles BOTH versions side by side (like Uni V2/V3/V4):
            // each pool's curve() bytes32 discriminates v1 ("EulerSwap v1", getParams() — a static immutable
            // 12-field struct with a SINGLE non-directional fee) from v2 ("EulerSwap v2", getDynamicParams() —
            // directional fee0/fee1). The deployed mainnet pools are all v1. Wired: the deepest LIVE (EVC-operator-
            // authorized) stable-stable v1 pool — USDC/USDT 0x3bBCC029…F28A8 (getReserves ≈179 USDC / ≈1165 USDT
            // virtual; getLimits maxOut ≈1165 USDT, vault cash-backed; computeQuote 100 USDC→100.03 USDT verified
            // live at block 25445491). poolType UniV2 is INERT for EulerSwap (discovery keys off factoryType; the
            // asymmetric Euler curve is NOT xy=k, so it flows into the EcoEuler bucket executed callback-free —
            // never dispatched as a UniV2 router swap; it is a placeholder, not a claim it is a V2 pool). Several
            // other listed v1 pools (USDe/USDT 0x794138…, USDC/USDT 0x701f…) are operator-UNAUTHORIZED / dead
            // (getLimits 0/0, computeQuote reverts OperatorNotInstalled) — intentionally NOT wired.
            { address: "0xb013be1D0D380C13B58e889f412895970A2Cf228", poolType: SwapPoolType.UniV2, factoryType: FactoryType.EulerSwap, label: "EulerSwap",
                eulerSwapPools: [
                    "0x3bBCC029f312ECe579a7dEb77B13CB8aE15F28A8",
                ] },
            // METRIC (metric.xyz; QL segKind 17 — see the Base config + metric-math.ts for the full probed
            // surface). Known-pool-address discovery; ONE Ethereum router. On-chain verified (2026-07-04):
            // USDT/USDC 0x9C9fd348… LIVE — provider 0xb53ee9de… getBidAndAskPrice fresh; quoteSwap fwd
            // (USDT→USDC) 1e18 raw partial-filled gracefully at the ~322k-USDT inventory cap
            // (+3.221e11 in, −3.219e11 out) and rev capped likewise (the partial-fill class the ladder
            // self-truncates on). The Ethereum WETH/USDC + WETH/USDT + WBTC/USDC metadata pools were ALL
            // stale-provider AND zero-inventory at authoring (withdrawn makers — probed: getBidAndAskPrice
            // reverts 0x9a0423af, balances 0, quoteSwap (0,0) even with an injected anchor) — deliberately
            // NOT wired; they drop in by address alone when their makers return. poolType UniV2 is INERT
            // (discovery keys off factoryType).
            { address: "0xcB41C10c6414aCbea022c7662df4005dd8FBEF91", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Metric, label: "Metric",
                metricRouter: "0xcB41C10c6414aCbea022c7662df4005dd8FBEF91",
                metricPools: [
                    "0x9C9fd348505A7202Fd819D8cb5003248d920d279",
                ] },
            // INTEGRAL SIZE (integral.link TwapRelayer; QL segKind 19 — see size-math.ts for the full
            // probe record + the out-window design). `address` IS the relayer proxy (VERIFIED impl
            // 0xaf780de0…). On-chain re-verified 2026-07-04 (block ~25.46M + anvil-fork execution):
            // quoteSell USDC→WETH 6000e6 → 3.3526e18; USDT→WETH 6000e6 → 3.3509e18 (WETH/USDC + WETH/USDT
            // pairs live; WBTC/USDC TR17 no pair, USDC/USDT TR5A disabled). OUT-window (checkLimits on
            // tokenOut): getTokenLimitMin WETH 1.2e18 / USDC 5000e6 / USDT 5000e6, maxMultiplier 0.95e18
            // × relayer inventory (WETH→USDC 2e18 quoted ~3580 USDC < the 5000e6 USDC min → TR03 — the
            // min binds on the OUT side; 1e22 → TR3A). quoteBuy(USDC, WETH, 1.2e18) = 2148.02e6 — the
            // exact minIn conversion (quoteSell at it = 1.20000000077e18 ≥ min; −1e6 → TR03). Fork-sold
            // 6000 USDC from a random EOA: pulled EXACTLY 6000e6, received == same-block quoteSell
            // WEI-EXACT, allowance residue 0, TR03 enforced at exec on a sub-min sell, submitDeadline
            // uint32-max accepted. The TWAP source is the pair's configured Uniswap-V3 pool (observe).
            // poolType UniV2 is INERT (discovery keys off factoryType).
            { address: "0xd17b3c9784510E33cD5B87b490E79253BcD81e2E", poolType: SwapPoolType.UniV2, factoryType: FactoryType.IntegralSize, label: "Integral SIZE" },
            // DODO V2
            { address: "0x72d220cE168C4f361dD4deE5D826a01AD8598f6C", poolType: SwapPoolType.DODOV2, factoryType: FactoryType.DODOZoo, label: "DODO V2" },
            // DODO V2 DSP (DODOStablePool factory — the SAME getDODOPool(base,quote)→address[] surface as the
            // DVMFactory 0x72d220cE above; DSP pools are registered ONLY here, so the DVM-only entry cannot see
            // them; discovery iterates every DODOZoo entry, so the two zoos coexist). On-chain verified
            // 2026-07-03: getDODOPool(DAI,USDT) → [0x3058EF90… (the prod-mirror DAI/USDT DSP, ~5.4k DAI /
            // ~11.7k USDT reserves, querySellBase(1000e18 DAI) → 1000.55 USDT), 0xb6005C01… (thin)]; the
            // reverse ordering returns [] (clean — discovery queries BOTH orderings). Pool responds to the
            // full typed read surface: getPMMStateForCall / _BASE_TOKEN_ / _LP_FEE_RATE_ / _MT_FEE_RATE_MODEL_
            // (version "DSP 1.0.1"). Address per the DODO contract API (chainId 1, DSPFactory).
            { address: "0x6fdDB76c93299D985f4d3FC7ac468F9A168577A4", poolType: SwapPoolType.DODOV2, factoryType: FactoryType.DODOZoo, label: "DODO V2 DSP" },
            // Maverick V2
            { address: "0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e", poolType: SwapPoolType.MaverickV2, factoryType: FactoryType.MaverickV2Factory, label: "Maverick V2" },
            // KyberSwap Classic / DMM (amplified constant-product on virtual reserves; V2-shaped,
            // callback-free). Ethereum DMMFactory — getPools(a,b) → per-pool getTradeInfo().
            { address: "0x833e4083B7ae46CeA85695c4f7ed25CDAd8886dE", poolType: SwapPoolType.UniV2, factoryType: FactoryType.KyberClassic, label: "KyberSwap Classic" },
            // Fermi / propAMM: LEFT EMPTY + FLAGGED. The FermiSwapper router
            // 0xb1076fe3ab5e28005c7c323bac5ac06a680d452e has code ONLY on Ethereum (no code on
            // arbitrum/optimism/base/polygon/bsc). isActive(USDC,USDT)==true and getPairs() lists a USDC/USDT
            // pair, BUT quoteAmounts(USDC,USDT,+amt) REVERTS StaleUpdate() at every size — the oracle feed is
            // stale, so the pair cannot produce a quote at read time. `discoverFermiPoolsTyped` keeps only
            // strictly-positive sampled quotes, so every sample maps to 0 → the pool is dropped. No verifiable
            // quotable stable pair, so no Fermi FactoryConfig entry is wired (re-light when the feed is live).
            // EKUBO V3 (v3.1.1 singleton CL; QL segKind 21 — see FactoryType.Ekubo + ekubo-math.ts for the
            // full E0 freeze record). `address` = the Core singleton (all pools VIRTUAL inside it; the
            // poolState slot IS the poolId), `ekuboRouter` = the MEVCaptureRouter (quote 0x3bc52842 +
            // 7-arg swap 0xf196187f, both selector-checked in the DEPLOYED runtime). Preset-clone
            // discovery over EKUBO_DEFAULT_PRESETS — every menu entry attested by a live ETH pool in the
            // 2026-07-04 batch probe (ONE raw Core.sload over the candidate grid): USDe/USDC 0.003%/100
            // (id 0xc86d5ef1…, L≈3.55e21 — the venue's top pool, ~$0.9M/side, $4.19M/24h), USDe/sUSDe
            // 0.01%/100 (0xe5be1568…), USDe/USDT 0.003%/100 (0xdc4333ea…), ETH/USDC 0.05%+0.3%+0.5%/4988,
            // ETH/USDT 0.05%/4988, ETH/WBTC 0.1%/1000, USDC/USDT 0.5%/100 (initialized but a zero-L husk
            // at the review re-probe — harmless, drops at the quote probe) + 0.0005%/50 (id
            // 0x6fde3244…895d — the LIVE top USDT/USDC tier, ~$5.6M/24h; added on review),
            // EKUBO/USDC 1%/19802. Live
            // quote re-probed (+1000e18 USDe → −998.69e6 USDC) and the swap fork-EXECUTED wei-exact vs
            // the same-state quote (residue 0). Native-ETH pools (token0 == 0 — the ETH/* rows above)
            // are Phase-2: discovery keys on the ERC20 recipe tokens, so they cannot surface yet.
            // 30d ETH volume $619.3M (DefiLlama). poolType UniV2 is INERT (discovery keys off
            // factoryType; Ekubo executes callback-free through its own router, never a V2 swap).
            { address: "0x00000000000014aA86C5d3c41765bb24e11bd701", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Ekubo, label: "Ekubo V3",
                ekuboRouter: "0xd26f20001a72a18C002b00e6710000d68700ce00" },
        ],
        baseTokens: [
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
            "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
            "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
            "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
        ],
        feeTiers: [100, 500, 3000, 10000],
    },
    arbitrum: {
        factories: [
            // V3 concentrated liquidity (has price limit)
            { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3" },
            { address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "PancakeSwap V3", feeTiers: [...PANCAKE_V3_FEE_TIERS] },
            { address: "0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
            // KyberSwap Elastic REMOVED: Elastic is NOT V3-compatible (getPoolState()/its own swap, no slot0) — a queried-tier collision reverts the whole lens eth_call; needs its own FactoryType before re-adding.
            // Ramses CL — LIVE fee-keyed V3Standard factory. On-chain verified on Arbitrum mainnet:
            //   - The live Ramses CL NonfungiblePositionManager 0xAA277CB7914b7e5514946Da92cb9De332Ce610EF
            //     returns factory() = 0xAA2cd7477c451E703f3B9Ba5663334914763edF8 (4900-byte proxy → 15KB impl).
            //   - It is fee-keyed getPool(address,address,uint24): tickSpacing-keyed getPool(a,b,int24) REVERTS
            //     (bare 0x) → V3Standard, NOT SlipstreamCL. getPool(USDC,USDT,100) → 0x113DFF7d… (real live pool:
            //     token0=USDC, token1=USDT, fee=100, tickSpacing=1, liquidity≈4.77e10; factory() back-references).
            //   - Ramses uses NON-standard low fee tiers: getPool(WETH,USDC,·) returns live pools at 50/250/500/
            //     3000/10000, and getPool(USDC,USDT,·) at 50/100 — so feeTiers override [50,100,250,500,3000,10000]
            //     (the default [100,500,3000,10000] would miss the deep stable pools at fee=50 and fee=100).
            // (The prior wired 0x07E6…6b45 was Ramses's HyperEVM factory, dead on Arbitrum — 0 code — now replaced.)
            { address: "0xAA2cd7477c451E703f3B9Ba5663334914763edF8", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Ramses CL", feeTiers: [50, 100, 250, 500, 3000, 10000] },
            // Chronos CL — LEFT as V3Standard and FLAGGED: NOT re-tagged to SlipstreamCL because
            // getPool(a,b,int24) reverts (bare 0x) against this factory on Arbitrum mainnet, so it does NOT
            // respond as a tickSpacing-keyed CLFactory (nor did the fee-keyed getPool return a pool). Needs
            // address / interface re-verification before it can be discovered.
            { address: "0x4Db9D624F67E00dbF8ef7AE0e0e8eE54aF1dee49", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Chronos CL" },
            // Algebra (V3-compatible swap with dynamic fees, different factory query)
            { address: "0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B", poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "Camelot V3" },
            // (A "Ramses V2" AlgebraV3 entry at 0xAA2cd747…bc45A was REMOVED: the address has NO CODE on
            // Arbitrum — cast code returns 0x. The LIVE Ramses CL is the fee-keyed V3Standard entry above.)
            // V4 singleton (PoolManager + StateView lens). Official Uniswap V4 Arbitrum deployment.
            { address: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32", stateView: "0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990", poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
            // V2 constant-product (no price limit)
            { address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "SushiSwap V2" },
            { address: "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "PancakeSwap V2" },
            { address: "0x6EcCab422D763aC031210895C81787E87B43A652", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Camelot V2" },
            { address: "0xaC2ee06A14c52570Ef3B9812Ed240BCe359772e7", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Zyberswap V2" },
            // Solidly V2 (volatile + stable pools)
            { address: "0xd0a07E160511c40ccD5340e94660E9C9c01b0D27", poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Ramses V2 Legacy" },
            { address: "0xCe9240869391928253Ed9cc9Bcb8cb98CB5B0722", poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Chronos V1" },
            // Curve
            { address: "0x445FE580eF8d70FF569aB36e80c647af338db351", poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
            // Balancer V2 (Vault — known ComposableStable pool addresses). On-chain verified via
            // Vault.getPoolTokens(getPoolId(pool)):
            //   0x1533…2382  USDT-USDC.e-DAI StablePool  (DAI ≈32,208 · USDT ≈66,842 · USDC.e ≈31,071; ~$130k;
            //                                             DAI+USDT are baseTokens — USDC.e is bridged, not native)
            //   0x423A…4A5   Stable 4pool                 (nativeUSDC ≈770 · DAI ≈801 · USDT ≈3,084 · USDC.e ≈742;
            //                                             ~$5.4k; holds native USDC 0xaf88…)
            { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Balancer V2",
                balancerStablePools: [
                    "0x1533A3278f3F9141d5F820A184EA4B017fce2382", // USDT-USDC.e-DAI StablePool
                    "0x423A1323c871aBC9d89EB06855bF5347048Fc4A5",
                ] },
            // Balancer V3 (Vault singleton 0xbA13…bA9 + Arbitrum Router 0xEAed…CF2E; callback-free typed path via
            // Permit2). On-chain verified: the Vault singleton is present on Arbitrum and the Router's
            // getPermit2() = the canonical Permit2. The TYPE + Router are wired so a known deep Arbitrum V3 stable
            // pool drops in by address alone (populate `balancerV3Pools` from the Balancer V3 subgraph — LEFT
            // EMPTY here pending a verified deep both-baseToken-wrapper pool, same convention as the empty V2
            // Balancer entries). poolType UniV2 is INERT for Balancer V3 — a placeholder.
            { address: "0xbA1333333333a1BA1108E8412f11850A5C319bA9", poolType: SwapPoolType.UniV2, factoryType: FactoryType.BalancerV3, label: "Balancer V3",
                balancerV3Router: "0xEAedc32a51c510d35ebC11088fD5fF2b47aACF2E" },
            // Fluid DEX (FluidDexT1 typed path). On-chain verified: DexFactory.getDexAddress → getDexTokens (via
            // DexResolver 0x11D80…) → dexId3 0x3C04…CDa7 is USDC(0xaf88…, native)/USDT(0xFd08…) — both baseTokens;
            // estimateSwapIn deep (1M USDC → 1.0003M USDT).
            // poolType UniV2 is INERT for Fluid (discovery keys off factoryType; Fluid executes callback-free via
            // its own EcoFluid path, never dispatched as a UniV2 router swap) — a placeholder, not a UniV2 claim.
            { address: "0x91716C4EDA1Fb55e84Bf8b4c7085f84285c19085", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Fluid, label: "Fluid DEX",
                fluidResolver: "0x11D80CfF056Cef4F9E6d23da8672fE9873e5cC07",
                fluidPools: [
                    "0x3C0441B42195F4aD6aa9a0978E06096ea616CDa7",
                ] },
            // EulerSwap: LEFT EMPTY + FLAGGED (same reason as ethereum — the deployed pools expose the v1
            // getParams() surface and REVERT getDynamicParams() the recipe requires). Fermi: no FermiSwapper
            // deployment on Arbitrum (router 0xb1076fe3… is Ethereum-only). Both intentionally omitted.
            // DODO V2 — corrected to the LIVE Arbitrum DVMFactory (getDODOPool(base,quote)→address[]), matching the
            // eth 0x72d220cE entry. On-chain verified on Arbitrum: 0xDa4c4411… has code (4517 bytes),
            // getDODOPool(WETH,USDC) → 10 pools, getDODOPool(USDC,USDT) → 53 pools. The prior wired
            // 0x2A3CE1DebAf2F0F5A0A6dEB64DF95B11a2407d3C is dead on Arbitrum (0 code) — it is DODO's OPTIMISM
            // factory address mis-placed in the Arbitrum block. Canonical per-chain DVMFactory from the DODO
            // contract API (chainId 42161).
            { address: "0xDa4c4411c55B0785e501332354A036c04833B72b", poolType: SwapPoolType.DODOV2, factoryType: FactoryType.DODOZoo, label: "DODO V2" },
            // Trader Joe LB
            { address: "0x8e42f2F4101563bF679975178e880FD87d3eFd4e", poolType: SwapPoolType.TraderJoeLB, factoryType: FactoryType.TraderJoeLB, label: "Trader Joe LB" },
            // WOOFi (WooPPV2 sPMM — deterministic single-address deployment).
            { address: "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4", poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "WOOFi" },
            // METRIC (metric.xyz; QL segKind 17 — see the Base config + metric-math.ts). Known-pool-address
            // discovery; the LIVE Arbitrum router is 0x82A562fD… — NOTE the metadata also lists
            // 0x080b37C6… as a router for some Arbitrum pools, but that address has NO CODE on Arbitrum
            // (it is the HyperEVM router — a cross-chain metadata artifact), so only 0x82A562fD…-served
            // pools are wired. On-chain verified (2026-07-04): WETH/USDC 0xefb43216… LIVE (~27 WETH +
            // ~56.3k USDC; provider 0x3a1e540c… fresh) — quoteSwap fwd 1e18 WETH → −1768.96e6 USDC
            // @ limit 0; rev 1e18 raw USDC capped gracefully (+49.36e9 consumed, −27.89e18 WETH out
            // @ limit uint128.max). NOT wired: arb_wethusdc 0xDBE9a88C… (live provider, EMPTY inventory —
            // quotes (0,0)), USDT/USDC + WBTC pools (stale providers at authoring), cbBTC/USDC (cbBTC is
            // not an Arbitrum baseToken). poolType UniV2 is INERT (discovery keys off factoryType).
            { address: "0x82A562fD9F02d4346B95D3a2a501411979C8F920", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Metric, label: "Metric",
                metricRouter: "0x82A562fD9F02d4346B95D3a2a501411979C8F920",
                metricPools: [
                    "0xefb432160e8cfce36eb937975055641ba4c3747f",
                ] },
            // INTEGRAL SIZE (integral.link TwapRelayer; QL segKind 19 — see the Ethereum entry +
            // size-math.ts). The Arbitrum relayer proxy is 0x3c6951FD… (per the official deployment;
            // labeled "Integral: TWAP Relayer" on the explorer). On-chain re-verified 2026-07-04 (block
            // ~480.36M): quoteSell USDC→WETH 6000e6 → 3.35277e18 (native USDC), USDC.e→WETH → same,
            // USDT→WETH 6000e6 → 3.35009e18. OUT-window mins are SMALLER than Ethereum's:
            // getTokenLimitMin WETH 4e16, USDC/USDC.e/USDT 100e6 (maxMultiplier 0.95e18). WETH→USDC 4e18
            // → 7150.76e6 quotable; WETH→USDC.e and WETH→USDT reverted TR3A at 4e18 at probe (thin
            // relayer-side stable inventory — the cap binds; the live window hoist + ladder truncation
            // handle it per-cook). poolType UniV2 is INERT (discovery keys off factoryType).
            { address: "0x3c6951FDB433b5b8442e7aa126D50fBFB54b5f42", poolType: SwapPoolType.UniV2, factoryType: FactoryType.IntegralSize, label: "Integral SIZE" },
        ],
        baseTokens: [
            "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
            "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
            "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
            "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
            "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
        ],
        feeTiers: [100, 500, 3000, 10000],
    },
    optimism: {
        factories: [
            // V3 concentrated liquidity (has price limit)
            { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3" },
            // Velodrome CL (Slipstream on Optimism) — tickSpacing-keyed getPool(a,b,int24). Verified
            // on-chain: getPool(WETH,USDC,int24) returns non-zero pools at tickSpacings {1,100}. Per-pool
            // fee READ from fee() (decoupled from tickSpacing). V3-compatible for execution (swapV3).
            { address: "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F", poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Velodrome CL" },
            { address: "0x9c6522117e2ed1fE5bdb72bb0eD5E3f2bdE7DBe0", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
            // KyberSwap Elastic REMOVED: Elastic is NOT V3-compatible (getPoolState()/its own swap, no slot0) — a queried-tier collision reverts the whole lens eth_call; needs its own FactoryType before re-adding.
            // V4 singleton (PoolManager + StateView lens). Official Uniswap V4 Optimism deployment.
            { address: "0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3", stateView: "0xc18a3169788F4F75A170290584ECA6395C75Ecdb", poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
            // V2 constant-product (no price limit)
            { address: "0xFbc12984689e5f15626Bad03Ad60160Fe98B303C", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "SushiSwap V2" },
            // Solidly V2 (volatile + stable pools)
            { address: "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a", poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Velodrome V2" },
            // Curve (MetaRegistry — find_pool_for_coins across all Curve pools).
            { address: "0xc65CB3156225380BEda366610BaB18D5835A1647", poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
            // Balancer V2 — balancerStablePools LEFT EMPTY + FLAGGED. Balancer V2 on Optimism has drained: the
            // deepest all-stablecoin ComposableStable verified via Vault.getPoolTokens(getPoolId(pool)) is
            // 0x9da1…040d9 "Native Stable Beets" (USDC/USDC.e/USDT/DAI) at only ~$530 total, and 0x3736…4de
            // "Optimistic Steady Beets" at ~$45 — both genuinely all-stablecoin but far too shallow to wire (the
            // eth/base pools already wired are $35k–$120k). No V2-Vault stable pool worth wiring → left empty.
            { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Balancer V2" },
            // WOOFi (WooPPV2 sPMM — deterministic single-address deployment).
            { address: "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4", poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "WOOFi" },
        ],
        baseTokens: [
            "0x4200000000000000000000000000000000000006", // WETH
            "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // USDC
            "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
            "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", // USDT
            "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
        ],
        feeTiers: [100, 500, 3000, 10000],
    },
    polygon: {
        factories: [
            // V3 concentrated liquidity (has price limit)
            { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3" },
            // KyberSwap Elastic REMOVED: Elastic is NOT V3-compatible (getPoolState()/its own swap, no slot0) — a queried-tier collision reverts the whole lens eth_call; needs its own FactoryType before re-adding.
            { address: "0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "SushiSwap V3" },
            // QuickSwap V3 is Algebra V1 (SINGLE fee): raw globalState() returns 7 words — (price, tick, fee,
            // timepointIndex, communityFee0, communityFee1, unlocked) — verified 2026-07-03 on the live
            // WMATIC/USDC.e and WMATIC/USDC pools (word2 = 403/404 ppm dynamic fee; word3 = 45562/32434
            // timepointIndex, NOT a fee). The "camelot" DEFAULT (Camelot returns 8 words, feeZto/feeOtz at
            // words 2/3 — cross-checked on Arbitrum) would decode QuickSwap's timepointIndex as the oneForZero
            // fee (≈4.6%), poisoning the survivor filter + merge pricing — so the layout MUST be pinned (same
            // determination as THENA Fusion on bsc). tickSpacing 60 matches the default.
            { address: "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28", poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "QuickSwap V3", algebraFeeLayout: "algebra-v1" },
            // V4 singleton (PoolManager + StateView lens). Official Uniswap V4 Polygon deployment.
            { address: "0x67366782805870060151383F4BbFF9daB53e5cD6", stateView: "0x5eA1bD7974c8A611cBAB0bDCAFcB1D9CC9b3BA5a", poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
            // V2 constant-product (no price limit)
            { address: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "QuickSwap V2" },
            { address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "SushiSwap V2" },
            // Curve
            { address: "0x47bB542B9dE58b970bA50c9dae444DDB4c16751a", poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
            // Balancer V2 (Vault — known ComposableStable pool addresses). On-chain verified via
            // Vault.getPoolTokens(getPoolId(pool)):
            //   0x06Df…1b42  Polygon Stable Pool (USDC.e/DAI/miMATIC/USDT)  (USDC.e ≈20,497 · DAI ≈20,452 ·
            //                                     miMATIC ≈33,034 · USDT ≈21,485; ~$74k; DAI+USDT are baseTokens —
            //                                     USDC here is bridged USDC.e 0x2791…, not the native 0x3c49… baseToken)
            //   0x0d34…FD4f  TUSD Stablepool (USDC.e/TUSD/DAI/USDT)          (USDC.e ≈2,826 · TUSD ≈4,620 ·
            //                                     DAI ≈2,784 · USDT ≈3,965; ~$13k; DAI+USDT tradeable)
            // (Polygon has NO deep native-USDC 0x3c49… V2 stable pool — the deepest is ~$997, dust — so these
            // legacy USDC.e-anchored pools carry the DAI↔USDT stable depth.)
            { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Balancer V2",
                balancerStablePools: [
                    "0x06Df3b2bbB68adc8B0e302443692037ED9f91b42", // Polygon Stable Pool (USDC.e/DAI/miMATIC/USDT)
                    "0x0d34e5dD4D8f043557145598E4e2dC286B35FD4f",
                ] },
            // Fluid DEX (FluidDexT1 typed path). On-chain verified: DexFactory.getDexAddress → getDexTokens (via
            // DexResolver 0x11D80…) → dexId1 0x0B1a…C9e7 is native USDC(0x3c49…)/USDT(0xc213…) — both baseTokens;
            // estimateSwapIn shows a thin-but-real stable pool (quotes small sizes; truncates past ~few-thousand-$).
            // poolType UniV2 is INERT for Fluid (discovery keys off factoryType; Fluid executes callback-free via
            // its own EcoFluid path, never dispatched as a UniV2 router swap) — a placeholder, not a UniV2 claim.
            { address: "0x91716C4EDA1Fb55e84Bf8b4c7085f84285c19085", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Fluid, label: "Fluid DEX",
                fluidResolver: "0x11D80CfF056Cef4F9E6d23da8672fE9873e5cC07",
                fluidPools: [
                    "0x0B1a513ee24972DAEf112bC777a5610d4325C9e7",
                ] },
            // EulerSwap + Fermi: LEFT EMPTY + FLAGGED (no EulerSwap v2 stable pool; no FermiSwapper on Polygon).
            // DODO V2 — corrected to the LIVE Polygon DVMFactory (getDODOPool(base,quote)→address[]), matching the
            // eth 0x72d220cE entry. On-chain verified on Polygon: 0x7988…fE13 has code (4460 bytes),
            // getDODOPool(WMATIC,USDC.e) → 30 pools. The prior wired 0x79887f65f83bdf15Bcc8736b5e1Eed0C37B8571d is a
            // CORRUPTED address (right 0x79887f65… prefix, wrong tail) — dead on Polygon (0 code). Canonical
            // per-chain DVMFactory from the DODO contract API (chainId 137). NOTE: sampled Polygon DODO pools are
            // near-zero depth, so discovery finds them but the relative-depth filter drops them — correct-but-inert.
            { address: "0x79887f65f83bdf15Bcc8736b5e5BcDB48fb8fE13", poolType: SwapPoolType.DODOV2, factoryType: FactoryType.DODOZoo, label: "DODO V2" },
            // WOOFi (WooPPV2 sPMM — deterministic single-address deployment).
            { address: "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4", poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "WOOFi" },
            // METRIC (metric.xyz; QL segKind 17 — see the Base config + metric-math.ts). Known-pool-address
            // discovery; ONE Polygon router. On-chain verified (2026-07-04): WETH/USDC 0x65b670c5… LIVE
            // (provider 0x907abf81… fresh) — quoteSwap fwd 1e18 WETH → −1767.20e6 USDC @ limit 0; rev 1e18
            // raw USDC capped gracefully at the ~20.95-WETH inventory (+37.06e9 consumed) @ limit
            // uint128.max — both directions sane, the partial-fill class. The other Polygon metadata pools
            // (USDC.e/USDC pairs, WBTC/USDC) pair a non-baseToken or were not probed live — not wired.
            // poolType UniV2 is INERT (discovery keys off factoryType).
            { address: "0x976c26402E1EC10454c5Fe6D2C9857DD57aE78f3", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Metric, label: "Metric",
                metricRouter: "0x976c26402E1EC10454c5Fe6D2C9857DD57aE78f3",
                metricPools: [
                    "0x65b670c5cd5D7aBb229BE2e6Ac03F4666864342d",
                ] },
        ],
        baseTokens: [
            "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
            "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
            "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // USDC
            "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", // DAI
            "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
            "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
        ],
        feeTiers: [100, 500, 3000, 10000],
    },
    // BSC (chainId 56). Note: BSC USDC/USDT are 18 decimals (Binance-Peg), not 6.
    bsc: {
        factories: [
            // V3 concentrated liquidity. Pancake's medium tier is 2500 (0.25%) on BSC, not 3000.
            { address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "PancakeSwap V3", feeTiers: [...PANCAKE_V3_FEE_TIERS] },
            // Uniswap V3 (standard 0.30% tier — NOT Pancake's 2500).
            { address: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3" },
            // Topaz CL (Slipstream-family CLFactory, per Topaz docs). tickSpacing-keyed getPool(a,b,int24)
            // proven on-chain 2026-07-03 (fee-keyed uint24 selector reverts; WBNB/USDT live at ts=50 →
            // 0x767F1F4b…, L≈9.4e22); enabled tickSpacings() == the SLIPSTREAM_TICK_SPACINGS default
            // [1,50,100,200,2000], so no slipstreamTickSpacings override needed; per-pool fee READ from
            // fee() (dynamic, decoupled from spacing — the ts=50 pool carries fee()=53).
            { address: "0x73DC984D9490286E735548f61dfCCec67Af82ed9", poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Topaz CL (Slipstream)" },
            // THENA Fusion (Algebra V1 dynamic-fee CL; poolByPair + 7-word globalState). Executable — the
            // engine services algebraSwapCallback (sauce#186). Algebra v1 pools share a fixed tickSpacing of
            // 60. algebraFeeLayout MUST be "algebra-v1": the fee is ALWAYS word 2; word 3 is the
            // timepointIndex (observed 18284 on the live WBNB/USDT pool 0xD405b976…, 2026-07-03 — decoded as
            // a camelot feeOtz it would be a bogus 1.83% fee; Algebra's own partner docs classify Thena as
            // v1.0).
            { address: "0x306F06C147f064A010530292A1EB6737c3e378e4", poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, algebraTickSpacing: 60, algebraFeeLayout: "algebra-v1", label: "THENA Fusion" },
            // THENA Integral (Algebra Integral CL, 'THENA V3,3' — launched 2025-05; DISTINCT from THENA
            // Fusion's Algebra V1 factory 0x306F06C1… above). poolByPair + 6-word Integral globalState
            // (single fee at word 2, word 3 is pluginConfig — NOT a fee); pools verified 2026-07-03 at
            // tickSpacing 60 (poolByPair(WBNB,USDT) → 0x9EA0f51F…, L≈4.5e22, lastFee=987; the factory
            // address is derived ON-CHAIN — factory() on three live V3,3 pools all return it, since the
            // THENA gitbook publishes no addresses and Algebra's partner page is stale). Integral supports
            // additional custom pools per pair (poolByPair returns only the base pool), which the
            // one-pool-per-pair AlgebraV3 reader tolerates by design.
            { address: "0x30055F87716d3DFD0E5198C27024481099fB4A98", poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, algebraTickSpacing: 60, algebraFeeLayout: "integral", label: "THENA Integral (V3,3)" },
            // V4 singleton (PoolManager + StateView lens). Official Uniswap deployment (docs + explorer
            // label agree). On-chain verified 2026-07-03: StateView.poolManager() round-trips to this
            // PoolManager; keccak(PoolKey)-derived poolId for native-BNB/BTCB 100/1 matches the live
            // indexed pool (getSlot0 responds, lpFee=100; getLiquidity ≈4.7e20; USDT/USDC pool ≈2.5e26).
            { address: "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF", stateView: "0xd13Dd3D6E93f276FAfc9Db9E6BB47C1180aeE0c4", poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
            // Maverick V2
            { address: "0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e", poolType: SwapPoolType.MaverickV2, factoryType: FactoryType.MaverickV2Factory, label: "Maverick V2" },
            // V2 constant-product. Pancake V2 pairs ENFORCE 0.25% (2500 ppm — the pair's K check is
            // balanceAdjusted = balance*10000 - amountIn*25), not the 0.30% default. A lower modeled fee
            // (the pre-fix 2000) over-asks output and the pair K-reverts the whole cook.
            { address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "PancakeSwap V2", v2FeePpm: 2500 },
            // Solidly V2 (volatile + stable pools)
            { address: "0x27DfD2D7b85e0010542da35C6EBcD59E45fc949D", poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Thena (Solidly fork)" },
            // WOOFi (WooPPV2 sPMM — deterministic single-address deployment).
            { address: "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4", poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "WOOFi" },
            // PancakeSwap StableSwap (the legacy-Curve A-invariant Solidity port; QL segKind 20). The
            // TYPED FactoryType.PancakeStableSwap path — getPairInfo(tokenA,tokenB)-keyed discovery +
            // callback-free uint256-index exchange (the historical CurveRegistry-typed entry here was
            // INERT: the factory has NO find_pool_for_coins, and the pools' uint256 indices do not fit
            // the engine _swapCurve int128 dispatch). On-chain verified 2026-07-04: pairLength()=31;
            // getPairInfo(USDT,USDC) → pool 0x3EFebC41… (bal ≈162.9k USDT + 91.2k USDC, A=1000,
            // fee=1e6/1e10=0.01%, get_dy(0,1,1e18)=0.99923e18 — near-par live quoting, BOTH argument
            // orders return the same sorted struct); USDT/BUSD pool 0x169F653A… ≈ $1.96M combined,
            // lisUSD/USDT 0xb1Da7D2C… ≈ $13.8M; the int128 get_dy REVERTS while the uint256 get_dy
            // answers; exchange(uint256×4) selector 5b41b908 present in the deployed runtime; empty
            // pools (6 of 31) REVERT get_dy — dropped by the liveness probe. poolType Curve is INERT
            // (discovery keys off factoryType).
            { address: "0x25a55f9f2279A54951133D503490342b50E5cd15", poolType: SwapPoolType.Curve, factoryType: FactoryType.PancakeStableSwap, label: "PancakeSwap StableSwap" },
            // Wombat Exchange (single-sided stableswap, callback-free). Discovered via the TYPED
            // FactoryType.Wombat path (addressOfAsset + per-asset cash/liability + ampFactor/haircutRate),
            // so poolType is unused here — UniV2 is a benign placeholder. Address is the Wombat Main Pool.
            { address: "0x312Bc7eAAF93f1C60Dc5AfC115FcCDE161055fb0", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Wombat, label: "Wombat" },
            // Tessera V (Wintermute TesseraSwap — SAME address as Base; QL segKind 15). On-chain verified
            // (2026-07-04): live BSC probe WBNB→USDT 1e18 → ~571.77e18 (within ~1.5bp of the same-block
            // Elfomo quote). Same wrapper surface + engine semantics as the Base entry (see the Base config
            // + tessera-math.ts for the fork-measured prio-fee/gas-gate evidence). poolType UniV2 is INERT
            // (discovery keys off factoryType).
            { address: "0x55555522005BcAE1c2424D474BfD5ed477749E3e", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Tessera, label: "Tessera V" },
            // ElfomoFi (SAME address as Base; QL segKind 16). On-chain verified (2026-07-04): live BSC
            // getSupportedPairs = 6 pairs (WBNB/USDT, ETH/USDT, BTCB/USDT, + 3 more, all vs USDT);
            // getAmountOut WBNB→USDT 1e18 → ~571.73e18. Same wrapper surface + oracle-staleness semantics as
            // the Base entry (see elfomo-math.ts). poolType UniV2 is INERT (discovery keys off factoryType).
            { address: "0xf0f0F0F0FB0d738452EfD03A28e8be14C76d5f73", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Elfomo, label: "ElfomoFi" },
            // METRIC on BSC: DELIBERATELY NOT WIRED (2026-07-04). The metadata lists 8 BSC pools (router
            // 0xa9a63266…), but EVERY provider's getBidAndAskPrice() reverted 0x9a0423af (stale — no maker
            // posting) at authoring, so no live probe evidence exists for any BSC pool. The Metric
            // FactoryType + discovery are chain-agnostic — a BSC entry drops in by address alone once a
            // maker is live (probe first: see the Base entry's evidence shape + metric-math.ts).
            // DODO V2 on BSC (~$12.3M/30d — the family is integrated, BSC just lacked the entries). BOTH
            // zoos verified on-chain 2026-07-04 (block ~108.05M) with the SAME getDODOPool(base,quote) →
            // address[] surface the discovery iterates (both orderings, de-duped):
            //  · DVMFactory 0x790B4A80… — getDODOPool(WBNB,USDT) → 73 pools / (USDT,WBNB) → 15 /
            //    (USDC,USDT) → 23 / (WBNB,USDC) → 6; sampled live pools respond version "DVM 1.0.2" and
            //    quote querySellBase (e.g. USDC/USDT 0x4ab9Fb94… querySellBase(1e18) → 0.1201e18 —
            //    imbalanced but quoting; dead/killed pools in the list revert the probe and are dropped by
            //    the discovery's per-pool sampling, exactly as on the other chains).
            //  · DSPFactory 0x0fb98159… (DODOStablePool zoo — same getter surface, mirrors the Ethereum
            //    dual-zoo wiring) — getDODOPool(WBNB,USDT) → 5 / (USDT,USDC) → 7 / (BUSD,USDT) → 14;
            //    sampled pools respond version "DSP 1.0.0/1.0.1" and quote (e.g. USDT/USDC 0xD5F05644…
            //    baseInv ≈ 1006e18, querySellBase(1e18) → 0.99934e18 — a live near-par stable pool).
            // Addresses per the DODO contract API (chainId 56), cross-verified by the live getDODOPool
            // probes above. Per-pool depth is judged by the standard sampling + relative-depth filter.
            { address: "0x790B4A80Fb1094589A3c0eFC8740aA9b0C1733fB", poolType: SwapPoolType.DODOV2, factoryType: FactoryType.DODOZoo, label: "DODO V2" },
            { address: "0x0fb9815938Ad069Bf90E14FE6C596c514BEDe767", poolType: SwapPoolType.DODOV2, factoryType: FactoryType.DODOZoo, label: "DODO V2 DSP" },
            // PancakeSwap INFINITY CL (the V4-class singleton; tick-walk pType 9 — see
            // FactoryType.PancakeInfinityCL + infinity-math.ts). `address` = the CLPoolManager
            // (state + getters + part of the 6-field PoolKey); `infinityVault` = the singleton Vault
            // (lock/custody; the flat swapInfinityCL arg, solver cfg[13]); `infinityTickLens` = the
            // periphery CLTickLens (snapshot tooling). Preset-clone discovery over
            // INFINITY_DEFAULT_CL_PRESETS (the data-derived joint (fee, ts) menu). On-chain verified
            // (BSC block ~108,123,094, 2026-07-04, all cross-wired): Vault.isAppRegistered(CLPM) ==
            // true, CLPM.vault() == Vault; USDT/Beat 0xb2842060… (fee 67 static, ts 1, HOOKLESS —
            // the venue's #1 TVL pool, ~$64.1M top-50 TVL / ~$5.9B/30d CL run-rate) getSlot0 =
            // (4.718e28, −10368, protocolFee 131104 = 32|32 packed 12+12, lpFee 67), L = 7.67e23;
            // getPoolTickInfo(−10561) net at word [1]; poolId = keccak256(abi.encode(6-field key))
            // reproduced exactly (also BNB/CAKE + BNB/ASTER); poolIdToPoolKey probed live (returns
            // the full key — the Tier-B reverse-verification getter). HOOK POLICY: Tier A
            // hookless-static-fee only at launch; `infinityHookAllowlist` deliberately EMPTY
            // (default-off — 46/50 top-TVL pools are hooked launchpad classes, admitting a hook is a
            // product/risk call per config). Native-BNB pools (BNB/CAKE, BNB/ASTER, BNB/ETH) are
            // engine-supported but SDK-Phase-2 (discovery keys on ERC20 recipe tokens). Dynamic-fee
            // pools (BNB/CAKE, USDT/USDC — fee 0x800000, slot0 lpFee 0) are quoter-only, excluded.
            { address: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b", poolType: SwapPoolType.PancakeInfinityCL, factoryType: FactoryType.PancakeInfinityCL, label: "PancakeSwap Infinity CL",
                infinityVault: "0x238a358808379702088667322f80aC48bAd5e6c4",
                infinityTickLens: "0x8BcF30285413F25032fb983C2bF4deFe29a33f3a" },
        ],
        baseTokens: [
            "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
            "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // USDC (Binance-Peg, 18 dec)
            "0x55d398326f99059fF775485246999027B3197955",
        ],
        feeTiers: [100, 500, 3000, 10000],
    },
    // Sonic (chainId 146). wS (wrapped native) included as a routing hub, not a stablecoin.
    sonic: {
        factories: [
            // SwapX (Algebra Integral CL) — dynamic fee, poolByPair + globalState. INTEGRAL fee layout,
            // on-chain verified 2026-07-03: globalState() on the live wS/USDC pool 0x5C4B7d60… returns
            // exactly 6 words (price, tick, lastFee=2000, pluginConfig=197, communityFee, unlocked) — the
            // default "camelot" decode would read word 3 (pluginConfig=197) as the oneForZero fee,
            // mispricing the deep pool (~278k wS + ~20k USDC) ~10x.
            { address: "0x8121a3F8c4176E9765deEa0B95FA2BDfD3016794", poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, algebraFeeLayout: "integral", label: "SwapX (Algebra Integral CL)" },
            // Shadow Exchange CL (Ramses V3 / Slipstream-style) — tickSpacing-keyed getPool(a,b,int24), now
            // discoverable via FactoryType.SlipstreamCL. Verified on-chain: getPool(wS,USDC,int24) returns
            // non-zero pools at tickSpacings {1,50,100,200}. Per-pool fee READ from fee() (decoupled from
            // tickSpacing). V3-compatible for execution (swapV3 / uniswapV3SwapCallback).
            { address: "0xcD2d0637c94fe77C2896BbCBB174cefFb08DE6d7", poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Shadow Exchange CL (Ramses V3)" },
            // WAGMI V3 (Uniswap V3 fork). On-chain verified 2026-07-03: fee-keyed getPool; enabled tiers are
            // NON-STANDARD [500, 1500, 3000, 10000] (feeAmountTickSpacing: 500->10, 1500->30, 3000->60,
            // 10000->200; 100 and 2500 DISABLED). The deep wS/USDC pool is the 0.15%/1500 tier (~768k wS,
            // L≈1.8e17); fee=3000 thin, fee=500 exists but L=0. REQUIRES TICK_SPACING_BY_FEE's `1500: 30`
            // (added above) — the unknown-tier fallback of 60 would double the walk stride and poison the
            // lens relative-depth floor.
            { address: "0x56CFC796bC88C9c7e1b38C2b0aF9B7120B079aef", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "WAGMI V3", feeTiers: [500, 1500, 3000, 10000] },
            // Metropolis DLMM (Trader Joe LB v2.2 fork — native Liquidity Book on Sonic). On-chain verified
            // 2026-07-03: getNumberOfLBPairs()=522; getLBPairInformation(wS,USDC,·) live at binSteps
            // {1,4,10,20,25,50,100}, (USDC,USDT,1) live two-sided (~3.2k USDC + ~2.4k USDT); pairs answer
            // getReserves/getActiveId/getStaticFeeParameters (baseFactor read live — USDC/USDT bs=1 uses
            // 10000, not the 5000 default).
            // lbBinSteps: the FULL on-chain preset menu — getAllBinSteps() = [1,2,4,5,10,15,20,25,30,
            // 50,100,200] (probed 2026-07-04). The default TRADER_JOE_BIN_STEPS [1,5,10,15,20,25]
            // missed 2/4/30/50/100/200; the DEEPEST wS/USDC pair sits at binStep=4 (0x32c0D873…,
            // ~36.9k wS — pair-probed live via getLBPairInformation, ignoredForRouting=false) and was
            // INVISIBLE to discovery before this per-factory override. Absent steps return pair=0
            // (harmless over-query).
            { address: "0x39D966c1BaFe7D3F1F53dA4845805E15f7D6EE43", poolType: SwapPoolType.TraderJoeLB, factoryType: FactoryType.TraderJoeLB, label: "Metropolis DLMM (Joe LB)",
                lbBinSteps: [1, 2, 4, 5, 10, 15, 20, 25, 30, 50, 100, 200] },
            // SwapX Classic (Solidly ve(3,3), stable + volatile)
            { address: "0x05c1be79d3aC21Cc4B727eeD58C9B2fF757F5663", poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "SwapX Classic (Solidly)" },
            // Shadow Exchange Legacy (Solidly PairFactory, stable + volatile)
            { address: "0x2dA25E7446A70D7be65fd4c053948BEcAA6374c8", poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Shadow Exchange Legacy (Solidly)" },
            // Beets (Beethoven X) — canonical cross-chain Balancer V2 Vault. balancerStablePools LEFT EMPTY +
            // FLAGGED. Sonic Beets has huge stablecoin TVL, but it is NOT reachable through the V2 Vault this entry
            // wires: (1) the deep "STABLE" pools (0x3d71ad28… smsUSD/vgUSDC ~$247M, 0x0ae7fbbe… ~$1.53M, 0x790fd3e9…
            // ~$766k) are Balancer V3 pools — they REVERT on getPoolId() on-chain, so discoverBalancerStablePoolsTyped
            // (getPoolId → V2 Vault.getPoolTokens) cannot add them at all; (2) filtering the Balancer API to
            // protocolVersion=2, the deepest all-stablecoin V2 ComposableStable is 0xcd4d…1c0c (USDC.e/scUSD) at only
            // ~$3,217 total, and its scUSD is not a wired baseToken — every deeper V2 "stable" pool holds
            // yield-bearing wrapper tokens (smsUSD/vgUSDC/msUSD/ghUSDC…) that are not base tokens, so discovery's
            // tokenIn/tokenOut ∈ pool tokens filter never matches. No V2-Vault base-token stable pool with real
            // depth → left empty. (V3-Vault support would be needed to reach the deep pools — out of scope.)
            { address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", poolType: SwapPoolType.BalancerV2, factoryType: FactoryType.BalancerV2, label: "Beets (Balancer V2 Vault)" },
            // Beets Balancer V3 (Vault singleton 0xbA13…bA9 + Sonic Router 0x93db…Dae5; callback-free typed path
            // via Permit2). This wires the V3-Vault path the prior V2-only Beets entry documented it could NOT
            // reach — the deep Sonic Beets "STABLE" pools (0x3d71ad28…, 0x43026d48… "Boosted Stable Rings", …) are
            // Balancer V3 pools (they REVERT getPoolId(), so the V2 Vault.getPoolTokens path can't add them). On-
            // chain verified: isPoolRegistered(0x43026d…)=true, getPoolTokens = [0x7870…, 0xd3DC…] (boosted/wrapped
            // legs), Sonic Router.getPermit2() = the canonical Permit2. NOTE: like the Base/ETH V3 pools, the
            // swappable tokens are BOOSTED/WRAPPED wrappers (smsUSD/vgUSDC-class), NOT the wired baseTokens
            // (wS/USDC/USDT), so a base-token EcoSwap won't route through them until the wrappers are among the
            // discovery baseTokens/route hops — AND this specific "Boosted Stable Rings" pool needs its ERC4626
            // buffers initialized for the single-swap Router query (a plain querySwapSingleTokenExactIn against it
            // reverted with a buffer error at read time). The TYPE + Router are wired so a directly-queryable deep
            // Sonic V3 stable pool drops in by address alone. poolType UniV2 is INERT (discovery keys off
            // factoryType; V3 executes callback-free via its own EcoBalancerV3 path) — a placeholder.
            { address: "0xbA1333333333a1BA1108E8412f11850A5C319bA9", poolType: SwapPoolType.UniV2, factoryType: FactoryType.BalancerV3, label: "Beets (Balancer V3)",
                balancerV3Router: "0x93db4682A40721e7c698ea0a842389D10FA8Dae5",
                balancerV3Pools: [
                    "0x43026d483f42fb35efe03c20b251142d022783f2",
                ] },
        ],
        baseTokens: [
            "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38", // wS (wrapped Sonic, native)
            "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", // USDC.e / USDC (bridged, 6 dec; one address)
            "0x6047828dc181963ba44974801FF68e538dA5eaF9",
        ],
        feeTiers: [100, 500, 3000, 10000],
    },
    // Celo (chainId 42220). CELO (native ERC20, 18 dec) is the routing hub, not a tradeable stable.
    celo: {
        factories: [
            // V3 concentrated liquidity (has price limit). Standard Uniswap V3 fee tiers.
            { address: "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3", feeTiers: [100, 500, 3000, 10000] },
            // Ubeswap V3 (Uniswap V3 fork). On-chain verified 2026-07-03: fee-keyed getPool; CELO/cUSD live
            // at tiers {100, 3000, 10000} with the depth in the 0.01%/100 pool (~39.5k CELO + ~6k cUSD,
            // L≈2.6e23); pool factory() back-references this factory. No stable-stable pools (cUSD/USDC,
            // USDC/USDT all zero) — the CELO/cUSD leg is what this entry adds.
            { address: "0x67FEa58D5a5a4162cED847E13c2c81c73bf8aeC4", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Ubeswap V3", feeTiers: [100, 500, 3000, 10000] },
            // V4 singleton (PoolManager + StateView lens). V4 is dynamic-fee/tickSpacing-keyed.
            { address: "0x288dc841A52FCA2707c6947B3A777c5E56cd87BC", stateView: "0xbc21f8720BABf4b20d195eE5C6e99c52b76F2bfb", poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
            // Velodrome V2 (Solidly volatile + stable pools). Canonical Superchain Leaf PoolFactory.
            { address: "0x31832f2a97Fd20664D76Cc421207669b55CE4BC0", poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Velodrome V2" },
            // Velodrome CL (Slipstream on Celo) — tickSpacing-keyed getPool(a,b,int24), discovered via
            // FactoryType.SlipstreamCL. Verified on-chain: getPool(CELO,USDC,int24) returns a non-zero pool at
            // tickSpacing 100. Per-pool fee READ from fee() (decoupled from tickSpacing). V3-compatible for
            // execution (swapV3 / uniswapV3SwapCallback). (Previously omitted as a documented latent gap; the
            // tickSpacing-keyed discovery branch now lights it up.)
            { address: "0x04625B046C69577EfC40e6c0Bb83CDBAfab5a55F", poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Velodrome CL" },
            // Mento V2 (Celo stablecoin exchange). `address` is the Broker (BrokerProxy) — discovery enumerates
            // its exchange providers (BiPoolManager) + exchanges. poolType is a benign valid value (Mento is
            // CALLBACK-FREE with no engine SwapPoolType — the swap goes through the Broker in SauceScript). The
            // canonical BiPoolManager is pinned as a documented provider hint. Verified proxies on Celoscan.
            { address: "0x777A8255cA72412f0d706dc03C9D1987306B4CaD", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Mento, label: "Mento V2", mentoExchangeProviders: ["0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901"] },
        ],
        baseTokens: [
            "0x471EcE3750Da237f93B8E339c536989b8978a438", // CELO (native ERC20, routing hub, 18 dec)
            "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", // USDC (Circle native, 6 dec)
            "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", // USDT (Tether native)
            "0x765DE816845861e75A25fCA122bb6898B8B1282a", // cUSD (Mento Dollar)
            "0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189",
        ],
        feeTiers: [100, 500, 3000, 10000],
    },
    // Ink (OP-stack L2, chainId 57073). WETH (wrapped native) is the routing hub.
    ink: {
        factories: [
            // V3 concentrated liquidity (has price limit). Ink uses a distinct V3 factory deployer.
            { address: "0x640887A9ba3A9C53Ed27D0F7e8246A4F933f3424", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3", feeTiers: [100, 500, 3000, 10000] },
            // Velodrome V2 (Solidly volatile + stable pools).
            { address: "0x31832f2a97Fd20664D76Cc421207669b55CE4BC0", poolType: SwapPoolType.UniV2, factoryType: FactoryType.SolidlyV2, label: "Velodrome V2 (Solidly)" },
            // Velodrome Slipstream CL (Ink) — tickSpacing-keyed getPool(a,b,int24), discovered via
            // FactoryType.SlipstreamCL. Verified on-chain: the factory has code + 6 pools, getPool(a,b,int24)
            // round-trips exactly against an enumerated pool (e.g. USDT0/WETH ts=100 → 0x0eA741…), and the
            // pools carry fee DECOUPLED from tickSpacing (ts=100/fee=500, ts=1/fee=100), so the per-pool fee is
            // READ from fee(). Ink's liquid Slipstream pairs are USDT0-denominated (no WETH/USDC pool today),
            // and USDT0 IS in baseTokens below, so the WETH/USDT0 pool set is ACTIVELY discovered — not inert.
            // (Any future WETH/USDC pool drops in on the same tickSpacing-keyed type by address alone.)
            { address: "0x718E46d0962A66942E233760a8bd6038Ce54EdCD", poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Velodrome Slipstream CL" },
        ],
        baseTokens: [
            "0x4200000000000000000000000000000000000006", // WETH (OP-stack predeploy, routing hub)
            "0x2D270e6886d130D724215A266106e6832161EAEd", // USDC (canonical native, 6 dec)
            "0xF1815bd50389c46847f0Bda824eC8da914045D14", // USDC.e (Stargate bridged, 6 dec)
            "0x0200C29006150606B650577BBE7B6248F58470c1", // USDT0 (LayerZero OFT USDT, 6 dec)
            "0xe343167631d89B6Ffc58B88d6b7fB0228795491D", // USDG (Global Dollar, 6 dec)
            "0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189",
        ],
        feeTiers: [100, 500, 3000, 10000],
    },
    // Plasma (chainId 9745). WXPL (wrapped native) is the routing hub. No Uniswap V4 deployment.
    plasma: {
        factories: [
            // V3 concentrated liquidity (has price limit). Standard Uniswap V3 fee tiers.
            { address: "0xcb2436774C3e191c85056d248EF4260ce5f27A9D", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3", feeTiers: [100, 500, 3000, 10000] },
            // Curve — discovery via the Metaregistry (find_pool_for_coins / get_coin_indices / get_n_coins),
            // NOT the StableSwap Factory 0x8271e06E... (which implements a different interface the
            // CurveRegistry reader does not call). Stable-stable pools (USDT0/USDe verified).
            { address: "0xe6dA14500f0b5783E2325F9C5a7eE5d99DA0fB42", poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Curve" },
            // Fluid DEX (FluidDexT1 typed path). On-chain verified 2026-07-03: DexFactory (deterministic
            // 0x91716C…, has code on Plasma) getDexAddress → 6 dexes; dexId2 0x667701e5… is
            // USDe(0x5d3a…)/USDT0(0xB8CE…) — both baseTokens; resolver estimateSwapIn deep (100k USDe →
            // 99,908 USDT0, both directions). NOTE: Plasma's DexResolver is 0xAf572EfC… (per the official
            // Instadapp fluid-contracts-public deployments.md — the eth/arb/polygon 0x11D80C… address has
            // NO code on Plasma). poolType UniV2 is INERT for Fluid (discovery keys off factoryType; Fluid
            // executes callback-free via its own EcoFluid path) — a placeholder, not a UniV2 claim.
            { address: "0x91716C4EDA1Fb55e84Bf8b4c7085f84285c19085", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Fluid, label: "Fluid DEX",
                fluidResolver: "0xAf572EfC84d905926F7b05C1B7bE04e4E89542B0",
                fluidPools: [
                    "0x667701e51B4D1Ca244F17C78F7aB8744B4C99F9B",
                ] },
        ],
        baseTokens: [
            "0x6100E367285b01F48D07953803A2d8dCA5D19873", // WXPL (wrapped native, routing hub, 18 dec)
            "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", // USDT0 (primary stablecoin, 6 dec)
            "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
        ],
        feeTiers: [100, 500, 3000, 10000],
    },
    // HyperEVM (chainId 999). WHYPE (wrapped native) is the routing hub. No V4 / no verified Curve registry.
    hyperevm: {
        factories: [
            // HyperSwap V3 concentrated liquidity (has price limit). Standard Uniswap V3 fee tiers
            // (NOT Pancake's 2500 — feeAmountTickSpacing(2500)=0).
            { address: "0xB1c0fa0B789320044A6F623cFe5eBda9562602E3", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "HyperSwap V3", feeTiers: [100, 500, 3000, 10000] },
            // HyperSwap V2 constant-product (canonical 0.30% fee, UniswapV2 fork — no v2FeePpm override).
            { address: "0x724412C00059bf7d6ee7d4a1d0D5cd4de3ea1C48", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "HyperSwap V2" },
            // Project X CL — fee-keyed Uniswap V3 fork (getPool(a,b,uint24); the int24-keyed getPool
            // reverts, so V3Standard NOT SlipstreamCL). On-chain verified 2026-07-03: factory found via
            // pool.factory() backref on the live LHYPE/WHYPE pool + cross-checked as the Project X
            // SwapRouter's _factory constructor arg on the explorer; WHYPE/USDT0 pools live at
            // 100/400/500/3000/10000 (fee=500 L≈6.0e17; LHYPE/WHYPE fee=100 L≈8.1e22, ~$1.18M); pools
            // expose standard slot0/liquidity + the uniswapV3SwapCallback selector. NON-standard extra
            // tiers: feeAmountTickSpacing enables 200->4, 400->8 (the deep 0.04% WHYPE/USDT0
            // stable-adjacent tier) and 1000->20 on top of the canonical set (2500/7500 disabled) — the
            // default [100,500,3000,10000] would miss them; spacings added to TICK_SPACING_BY_FEE.
            { address: "0xFf7B3e8C00e57ea31477c32A5B52a58Eea47b072", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Project X CL", feeTiers: [100, 200, 400, 500, 1000, 3000, 10000] },
            // nest CLAMM — Algebra Integral (poolByPair; fee-keyed getPool(a,b,uint24) reverts).
            // globalState is the 6-word INTEGRAL layout (lastFee at word 2, pluginConfig at word 3 — NOT
            // the camelot directional default). Factory from the official docs contracts page
            // (docs.usenest.xyz), back-referenced by the live WHYPE/USDT0 pool. On-chain re-verified
            // 2026-07-04: poolByPair(WHYPE,USDT0) → 0x20e6E73C…623E, globalState() = 6 words
            // (lastFee=0x12c=300, pluginConfig=0xd7), liquidity ≈ 2.65e17; pool bytecode carries the
            // algebraSwapCallback selector. Integral tickSpacing is PER-POOL (the WHYPE/USDT0 hub pool
            // tickSpacing()=5 — probed live 2026-07-04; factory defaultTickspacing()=60): the lens reads
            // each pool's OWN tickSpacing() live + derives the step on-chain, so every spacing walks its
            // true grid — algebraTickSpacing:5 is only the fallback for a tickSpacing() revert.
            { address: "0xF77Bd082c627aA54591cF2f2EaA811fd1AB3b1F3", poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "nest CL", algebraFeeLayout: "integral", algebraTickSpacing: 5 },
            // Ramses CL (HyperRAM) — the factory formerly MIS-PLACED on Arbitrum (see the Arbitrum note).
            // On HyperEVM it is TICKSPACING-keyed (getPool(a,b,int24); fee-keyed getPool(a,b,uint24)
            // reverts for EVERY tier) => SlipstreamCL, NOT V3Standard (unlike Arbitrum Ramses CL, which is
            // fee-keyed) — wiring it V3Standard would make it inert (the Chronos-class dead-entry failure).
            // Enabled spacings via tickSpacingInitialFee: [1,5,10,50,100,200] (the default Slipstream set
            // would miss 5 and 10, where the deep stable-adjacent pools live). Fees are DYNAMIC per pool —
            // the reader's per-pool fee() read picks them up (WHYPE/USDT0 ts=10 fee()=1300 vs initial 500).
            // Standard uniswapV3SwapCallback. On-chain re-verified 2026-07-04: getPool(WHYPE,USDT0,10) →
            // 0xeE02e3A3…a067, slot0() responds, liquidity ≈ 2.50e17 (ts=1/5/50 pools exist with L=0 —
            // left to the relative-depth filter).
            { address: "0x07E60782535752be279929e2DFfDd136Db2e6b45", poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Ramses CL", slipstreamTickSpacings: [1, 5, 10, 50, 100, 200] },
            // Kittenswap CL — Algebra INTEGRAL (docs: "built with Algebra Integral"; globalState is the
            // 6-word integral layout: lastFee at word 2, pluginConfig at word 3 — wiring WITHOUT
            // algebraFeeLayout:"integral" would decode pluginConfig as a fee). Factory from the official
            // deployed-contracts docs, back-referenced by the live WHYPE/USDT0 pool. On-chain re-verified
            // 2026-07-04: poolByPair(WHYPE,USDT0) → 0x3c140333…b809, globalState() = 6 words
            // (lastFee=0x1f4=500, pluginConfig=0xc3), liquidity ≈ 2.86e17; WHYPE/USDe pool L ≈ 2.60e17.
            // Per-pool tickSpacing is HETEROGENEOUS — tickSpacing() probed live 2026-07-04:
            // WHYPE/USDT0=10, WHYPE/USDe (0xCCe0285f…)=60, WHYPE/KITTEN (0x71d1FDE7…, L≈5.7e23)=500;
            // factory defaultTickspacing()=60. The lens reads each pool's OWN tickSpacing() live +
            // derives the step on-chain, so every spacing walks its true grid — algebraTickSpacing:10
            // is only the fallback for a tickSpacing() revert.
            { address: "0x5f95E92c338e6453111Fc55ee66D4AafccE661A7", poolType: SwapPoolType.UniV3, factoryType: FactoryType.AlgebraV3, label: "Kittenswap CL", algebraFeeLayout: "integral", algebraTickSpacing: 10 },
            // Hybra V3 — plain fee-keyed Uniswap V3 fork (their CL "uses Uniswap V3 contracts without
            // modification"). NON-standard tier menu: feeAmountTickSpacing enables 200->4, 2500->50
            // (Pancake-style) and 7500->150 on top of 100/500/3000/10000 — the per-factory feeTiers
            // override is required or the 2500/7500 pools are missed. Verified via pool.factory() backref
            // (GeckoTerminal hbHYPE/WHYPE Hybra-V3 pool) + live WHYPE/USDT0 pools at 100/500/2500; pools
            // expose standard slot0/liquidity + the uniswapV3SwapCallback selector. On-chain re-verified
            // 2026-07-04: getPool(WHYPE,USDT0,500) → 0x3514cC7C…D2AD, slot0() responds (7-word standard
            // V3). WHYPE/USDT0 depth is modest (L ≈ 1.59e16 — most Hybra depth migrated to Hybra V4); the
            // relative-depth filter judges it per-trade, and other pairs (hbHYPE/WHYPE) are deep.
            { address: "0x2dC0Ec0F0db8bAF250eCccF268D7dFbF59346E5E", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Hybra V3", feeTiers: [100, 200, 500, 2500, 3000, 7500, 10000] },
            // Hybra V4 — "V4" branding but NOT a Uniswap-V4 singleton: per-address minimal-proxy pools
            // (impl 0xa421…52ab) with the STANDARD V3 swap + uniswapV3SwapCallback surface (no
            // algebra/pancake callback), discovered by TICKSPACING-keyed getPool(a,b,int24) (fee-keyed
            // getPool and poolByPair both revert) => SlipstreamCL (Ramses-V3 lineage, like Shadow).
            // Per-pool fee() is DYNAMIC (ts=50 WHYPE/USDT0 fee()=1800) — the reader's live fee() read
            // handles it. No tickSpacingInitialFee getter — the spacing menu was established empirically
            // from live pools: [5,10,50,100,200] (+1 harmless to over-query). On-chain re-verified
            // 2026-07-04: getPool(WHYPE,USDT0,50) → 0xC22FaD66…8D6b, slot0() responds; liquidity ≈ 1.72e18
            // — the deepest WHYPE/USDT0 CL depth probed on the chain (ts=5/10/100 pools exist with L=0).
            { address: "0x32b9dA73215255d50D84FeB51540B75acC1324c2", poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Hybra V4", slipstreamTickSpacings: [1, 5, 10, 50, 100, 200] },
            // METRIC (metric.xyz; QL segKind 17 — see the Base config + metric-math.ts). Known-pool-address
            // discovery; ONE HyperEVM router (0x080b37C6… — the SAME address the metadata mis-lists for some
            // Arbitrum pools, where it has no code; here it is live). On-chain verified via the public
            // HyperEVM RPC (2026-07-04): WHYPE/USDC 0x1C8EE7E9… LIVE (~2172 WHYPE + ~107.4k USDC; provider
            // 0xf0611c8e… fresh) — quoteSwap fwd 1e18 WHYPE → −70.80e6 USDC @ limit 0; rev 1e18 raw USDC
            // capped gracefully (+153.38e9 consumed, −2164.73e18 WHYPE out) @ limit uint128.max. NOT wired:
            // usdt0/usdc4 0x8769Adf6… (dust inventory 23197/2 — quotes (0,0)); the non-baseToken pairs
            // (ubtc/muon/spx/khype/…). poolType UniV2 is INERT (discovery keys off factoryType).
            { address: "0x080b37C6F65cBC231f66016460782158090Fe0F7", poolType: SwapPoolType.UniV2, factoryType: FactoryType.Metric, label: "Metric",
                metricRouter: "0x080b37C6F65cBC231f66016460782158090Fe0F7",
                metricPools: [
                    "0x1C8EE7E99e2aEcD1338E111716e4744e7D088098",
                ] },
            // LIQUIDCORE (Liquid Labs liquidcore.xyz; QL segKind 18 — see liquidcore-math.ts for the full
            // probe record). ROUTER-enumerated discovery: `address` IS the router — getPoolForPair(a,b) is
            // UNORDERED and returns the pair's SINGLE pool (1 RPC/pair); getPools() enumerates 20 live
            // per-pair proxies. On-chain re-verified 2026-07-04 (block ~39.57M, public RPC + anvil-fork
            // execution): WHYPE/USDT0 pool 0xA7478A5f… (~893 WHYPE + ~2.8k USDT0) estimateSwap 1e18 WHYPE
            // → 70.47 USDT0 (router quote == pool quote IDENTICAL); WHYPE/USDC pool 0xD3994A6C… (~1052
            // WHYPE + ~61.9k USDC) fork-swapped from a random EOA: pulled EXACTLY 1e18, received == quote
            // wei-exact, allowance residue 0; minOut enforced (0x8199f5f3 @ quote+1); zero-amount reverts
            // 0x1f2a2005; unsupported pair reverts 0xc1ab6dc1; DRAINED pool quotes 0 gracefully; OVERSIZE
            // 5000 WHYPE pulled in FULL against a capped 2154-USDT0 out (pull == approve ALWAYS — no
            // residue path). isPublic=false does NOT gate swaps (probed — it gates LP deposits). Pools
            // price off the HyperEVM BBO read precompile 0x…080e (WHYPE/USDT0 reads spot indexes 10107 +
            // 10166; local tests etch an input-keyed mock — see liquidcore-math.ts). Quotes drift with the
            // book/timestamp (adaptive imbalance fee) ⇒ quote == exec same-block only — the live-walk
            // in-tx pairing. poolType UniV2 is INERT (discovery keys off factoryType).
            { address: "0x625aC1D165c776121A52ff158e76e3544B4a0b8B", poolType: SwapPoolType.UniV2, factoryType: FactoryType.LiquidCore, label: "LiquidCore" },
        ],
        baseTokens: [
            "0x5555555555555555555555555555555555555555", // WHYPE (wrapped native, routing hub, 18 dec)
            "0xb88339CB7199b77E23DB6E890353E22632Ba630f", // USDC (Circle native, 6 dec)
            "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", // USDT0 (Tether OFT, 6 dec)
            "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
        ],
        feeTiers: [100, 500, 3000, 10000],
    },
    // Unichain (chainId 130). Uniswap-native OP-stack L2. WETH is the OP-stack predeploy
    // 0x4200...0006 (routing hub; Eco routes only stablecoins). Unichain uses the non-canonical
    // 0x1f9840000...0002/0003/0004 deterministic factory scheme (NOT the usual 0x1F98431c... V3
    // factory). Standard Uniswap fee tiers (100/500/3000/10000) — V3 feeAmountTickSpacing is the
    // canonical set, NOT Pancake's 2500. All addresses verified from the Uniswap official developer
    // docs (developers.uniswap.org/docs/unichain/technical-information/contract-addresses) + the V4
    // deployments page. Stablecoins verified: USDC native (Circle), USDT0 (Tether OFT, 6 dec),
    // oUSDT (OpenUSDT Superchain ERC20, 6 dec). DROPPED (could not verify on Unichain mainnet,
    // under-adding): USDT (no separate bridged USDT — USDT0 IS canonical Tether), USDG (Paxos docs
    // list only Ethereum/Solana/Ink/X Layer), USDC.e (Unichain USDC is native, no bridged variant),
    // USDbC (Base-specific).
    unichain: {
        factories: [
            // V3 concentrated liquidity (has price limit). Standard Uniswap V3 fee tiers.
            { address: "0x1F98400000000000000000000000000000000003", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3", feeTiers: [100, 500, 3000, 10000] },
            // V4 singleton (PoolManager + StateView lens).
            { address: "0x1F98400000000000000000000000000000000004", stateView: "0x86e8631A016F9068C3f085fAF484Ee3F5fDee8f2", poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
            // V2 constant-product (no price limit). Canonical 0.30% fee.
            { address: "0x1F98400000000000000000000000000000000002", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Uniswap V2" },
            // Velodrome Slipstream CL (Unichain) — tickSpacing-keyed getPool(a,b,int24), discovered via
            // FactoryType.SlipstreamCL. Canonical Superchain leaf CLFactory (same address as Celo/Ink).
            // Verified on-chain 2026-07-03: getPool(WETH,USDC,int24) non-zero at ts=100 (fee()=150 —
            // DECOUPLED from spacing; L≈1.9e15) and getPool(USDC,USDT0,1) non-zero (fee()=100, L≈1.2e15
            // at tick 7); the fee-keyed getPool finds nothing. V3-compatible for execution (swapV3 /
            // uniswapV3SwapCallback).
            { address: "0x04625B046C69577EfC40e6c0Bb83CDBAfab5a55F", poolType: SwapPoolType.UniV3, factoryType: FactoryType.SlipstreamCL, label: "Velodrome CL" },
        ],
        baseTokens: [
            "0x4200000000000000000000000000000000000006", // WETH (OP-stack predeploy, routing hub)
            "0x078D782b760474a361dDA0AF3839290b0EF57AD6", // USDC (Circle native, 6 dec)
            "0x9151434b16b9763660705744891fA906F660EcC5", // USDT0 (Tether OFT, 6 dec)
            "0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189",
        ],
        feeTiers: [100, 500, 3000, 10000],
    },
    // World Chain (OP-stack, chainId 480). WLD is the routing hub; USDC 0x79A0… is Circle-native
    // (the former bridged USDC.e was upgraded in place — symbol() now returns "USDC").
    worldchain: {
        factories: [
            // V3 concentrated liquidity (has price limit). Standard Uniswap V3 fee tiers. Official
            // Uniswap deployment (developers.uniswap.org WorldChain-deployments); on-chain verified
            // 2026-07-03: getPool(WLD,USDC,·) live at all 4 tiers, fee=3000 pool holds ~445k WLD +
            // ~200k USDC (slot0/liquidity respond, L≈5.2e17).
            { address: "0x7a5028BDa40e7B173C278C5342087826455ea25a", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Uniswap V3", feeTiers: [100, 500, 3000, 10000] },
            // V4 singleton (PoolManager + StateView lens). On-chain verified 2026-07-03:
            // StateView.getLiquidity on keccak(PoolKey) poolIds — ETH/WLD 3000 L≈1.24e21, WLD/USDC
            // 10000 L≈1.79e17 (addresses cross-checked: Uniswap V4 deployments docs + the explorer).
            { address: "0xb1860D529182ac3BC1F51Fa2ABd56662b7D13f33", stateView: "0x51D394718bc09297262e368c1A481217FdEB71eb", poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Uniswap V4", feeTiers: [100, 500, 3000, 10000] },
        ],
        baseTokens: [
            "0x2cFc85d8E48F8EAB294be644d9E25C3030863003", // WLD (routing hub, 18 dec)
            "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1", // USDC (Circle native — former USDC.e upgraded in place, 6 dec)
            "0x4200000000000000000000000000000000000006",
        ],
        feeTiers: [100, 500, 3000, 10000],
    },
    // Ronin (chainId 2020). Gaming chain — stablecoin depth is THIN. WRON (wrapped native) is the
    // routing hub, not a stablecoin. Katana is a Uniswap V2 + V3 fork (Katana V3 uses the standard
    // uniswapV3SwapCallback shape). Factories verified via the official ronin-chain/katana-operation-
    // contracts mainnet deploy script + live RPC. CRITICAL: Katana V3 enabled fee tiers are
    // NON-STANDARD = [100, 3000, 10000] (feeAmountTickSpacing: 100->1, 3000->60, 10000->200; the
    // 0.05%/500 tier is DISABLED) — per-factory feeTiers set on the V3 row, chain-level feeTiers
    // also omit 500. Only USDC is a verifiable stablecoin with DEX liquidity (a scan of all 665
    // Katana V2 pairs found ZERO USDT/USDT0/USDC.e/USDG/oUSDT/DAI/USDe pairs). DROPPED (under-add):
    // USDT (no canonical Ronin address confirmable), oUSDT (OpenUSDT docs list Ronin but OKLink shows
    // zero balance / no contract — likely not active), USDG/USDC.e/USDT0/USDbC (no authoritative
    // Ronin deployment found). baseTokens deliberately holds only WRON + USDC; add others later only
    // after confirming canonical Ronin addresses on the explorer.
    ronin: {
        factories: [
            // V2 constant-product (no price limit). Katana V2 — UniswapV2 fork, canonical 0.30% fee.
            { address: "0xB255D6A720BB7c39fee173cE22113397119cB930", poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Katana V2" },
            // V3 concentrated liquidity (has price limit). Katana V3 — NON-STANDARD enabled fee tiers
            // (0.05%/500 disabled); per-factory feeTiers required.
            { address: "0x1f0B70d9A137e3cAEF0ceAcD312BC5f81Da0cC0c", poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Katana V3", feeTiers: [100, 3000, 10000] },
        ],
        baseTokens: [
            "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4", // WRON (wrapped native, routing hub, 18 dec)
            "0x0B7007c13325C48911F73A2daD5FA5dCBf808aDc",
        ],
        feeTiers: [100, 3000, 10000],
    },
};
// ── Infrastructure ───────────────────────────────────────────
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
// ── Uniswap V3 price boundaries ─────────────────────────────
/** Minimum sqrt price ratio (from UniswapV3 TickMath) */
export const MIN_SQRT_RATIO = 4295128739n;
/** Maximum sqrt price ratio (from UniswapV3 TickMath) */
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
// ── Protocol-specific constants ─────────────────────────────
/** Balancer V2 Vault — same address on all EVM chains */
export const BALANCER_V2_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
/**
 * Trader Joe LB bin steps to query per factory — the DEFAULT enumeration when a factory's
 * `FactoryConfig.lbBinSteps` override is absent (canonical Joe menu; the Arbitrum Joe entry
 * relies on this default). Forks with a different preset menu (Metropolis on Sonic) set
 * `lbBinSteps` per factory — see the FactoryConfig field doc.
 */
export const TRADER_JOE_BIN_STEPS = [1, 5, 10, 15, 20, 25];
/**
 * Trader Joe LB default static base-fee factor (`getStaticFeeParameters().baseFactor`). LB v2.1
 * pools commonly use 5000 (→ baseFee = 0.5·binStep%); read live per-pair where available, falls
 * back to this. The base fee is the FIXED snapshot fee the segment math grosses by (the variable
 * volatility fee is transient and omitted — the same per-block snapshot assumption used for V3).
 */
export const TRADER_JOE_DEFAULT_BASE_FACTOR = 5000;
/**
 * Trader Joe LB bin-scan window (bins on EACH side of the active bin) the typed discovery reads
 * into the off-chain segment enumerator. LB walks bins outward from the active id one per step;
 * a window of N bins covers a price excursion of (1+binStep/1e4)^N — at binStep 10 (0.1%), 256
 * bins ≈ a 13× excursion, far past any realistic split. Bounds the per-pair getBin multicall.
 */
export const TRADER_JOE_BIN_WINDOW = Number(process.env.ECO_LB_BIN_WINDOW ?? 256);
//# sourceMappingURL=constants.js.map