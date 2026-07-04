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
import { parseAbi, keccak256, encodeAbiParameters, encodeFunctionData } from "viem";
import {
  BASE_CHAIN_POOL_CONFIG,
  SwapPoolType,
  FactoryType,
  TRADER_JOE_BIN_STEPS,
  TRADER_JOE_BIN_WINDOW,
  TRADER_JOE_DEFAULT_BASE_FACTOR,
  SLIPSTREAM_TICK_SPACINGS,
  V2_DEFAULT_FEE_PPM,
  feeToTickSpacing,
  hasPriceLimit,
  type ChainPoolConfig,
  type FactoryConfig,
} from "./constants.js";
import type { PoolInfo } from "./types.js";
import { A_PRECISION_DEFAULT, QL_SEED_DIV, qlSliceHead, type CurvePool } from "./curve-math.js";
import { FEE_DENOMINATOR_CRYPTO, type CryptoSwapPool } from "./cryptoswap-math.js";
import type { BalancerStablePool } from "./balancer-stable-math.js";
import type { LbPool } from "./lb-math.js";
import { dodoFeeToPpm, RState, type DodoPool } from "./dodo-math.js";
import type { SolidlyStablePool } from "./solidly-stable-math.js";
import { WAD as WOMBAT_WAD, type WombatPool } from "./wombat-math.js";
import { WOO_FEE_SCALE, type WooFiPool } from "./woofi-math.js";
import { type FermiPool, fermiSampleInputs, FERMI_FEE_SCALE } from "./fermi-math.js";
import { type FluidVenue, FLUID_FEE_SCALE } from "./fluid-math.js";
import { type TesseraVenue, TESSERA_FEE_SCALE } from "./tessera-math.js";
import { type ElfomoVenue, ELFOMO_FEE_SCALE } from "./elfomo-math.js";
import {
  type MetricVenue,
  METRIC_FEE_SCALE,
  METRIC_INT128_MAX,
  METRIC_LIMIT_MAX_U128,
} from "./metric-math.js";
import { type MentoPool, mentoSampleInputs, MENTO_FEE_SCALE } from "./mento-math.js";
import {
  type BalancerV3Pool,
  balancerV3SampleInputs,
  balancerV3StableGetDy,
  BALANCER_V3_FEE_SCALE,
} from "./balancer-v3-math.js";
import { type EulerSwapPool, eulerFeeToPpm } from "./eulerswap-math.js";
import {
  getSqrtPrice as getMaverickSqrtPrice,
  getTickL,
  tickSqrtPrices,
  maverickFeeToPpm,
  type MaverickPool,
  type MaverickTick,
} from "./maverick-math.js";

// ── ABIs ──────────────────────────────────────────────────────

const v3FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
]);

const algebraFactoryAbi = parseAbi([
  "function poolByPair(address tokenA, address tokenB) external view returns (address pool)",
]);

// Slipstream-family CLFactory (Velodrome/Aerodrome Slipstream + Ramses-lineage Shadow CL). It keys
// pools by TICK SPACING, not fee — getPool(tokenA, tokenB, int24 tickSpacing) — so discovery
// enumerates a set of enabled tickSpacings (int24, signed). A Slipstream pool is otherwise the
// standard V3 view surface (slot0/liquidity via v3PoolAbi), except that fee is DECOUPLED from
// tickSpacing, so the per-pool fee is read from the pool's own fee() getter (below).
const slipstreamFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address pool)",
]);

// Slipstream / V3 pool fee() getter — Slipstream decouples fee from tickSpacing, so the per-pool fee
// must be READ, not assumed from a tickSpacing→fee map. (Uniswap V3 also has fee(); this reader is
// used for the Slipstream path where the fee tier is not the discovery key.)
const v3PoolFeeAbi = parseAbi([
  "function fee() external view returns (uint24)",
]);

const v2FactoryAbi = parseAbi([
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
]);

const solidlyFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool)",
  "function getFee(address pool, bool stable) external view returns (uint256)",
]);

// Solidly STABLE (sAMM) pool surface — the Velodrome/Aerodrome stable Pair: token0/getReserves for
// the off-chain replay, decimals0/decimals1 for the 1e18 normalisation, stable() to confirm the
// branch, and getAmountOut(amountIn, tokenIn) for the on-chain (and cross-check) exact view.
const solidlyStablePoolAbi = parseAbi([
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function stable() external view returns (bool)",
  "function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)",
  "function decimals0() external view returns (uint256)",
  "function decimals1() external view returns (uint256)",
  "function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256)",
]);

const erc20DecimalsAbi = parseAbi([
  "function decimals() external view returns (uint8)",
]);

/**
 * Default Solidly STABLE swap fee (ppm) when the factory `getFee` read is unavailable. The canonical
 * sAMM tier (Velodrome/Aerodrome stable) is 0.01% = 100 ppm. Velodrome `getFee` returns the fee in
 * bps×... fork-dependent — we treat a successful `getFee(pool,true)` as already ppm if it is large
 * enough, else as bps (×100). When the read fails entirely we fall back to this default.
 */
const SOLIDLY_STABLE_DEFAULT_FEE_PPM = 100;

// Canonical Uniswap V3 slot0 (7 words) — the typed PRIMARY decode. Slipstream-family forks
// (Velodrome/Aerodrome CL, Topaz) return a 6-word slot0 (no feeProtocol word); those fall back to
// the raw word-decode below (see "Shape-tolerant slot0 / globalState decode").
const v3PoolAbi = parseAbi([
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
]);

// Camelot / Algebra 1.9 globalState (8 words) — the typed PRIMARY decode. Algebra V1 (QuickSwap V3,
// THENA Fusion) returns 7 words and Algebra Integral (THENA V3,3, SwapX) 6; those fall back to the
// raw word-decode below. Fee-word taxonomy: `FactoryConfig.algebraFeeLayout` in shared/constants.ts.
const algebraPoolAbi = parseAbi([
  "function globalState() external view returns (uint160 price, int24 tick, uint16 feeZto, uint16 feeOtz, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
  "function liquidity() external view returns (uint128)",
]);

// ── Shape-tolerant slot0 / globalState decode ─────────────────
//
// The typed ABIs above pin ONE word layout per read — the 7-word Uniswap slot0 and the 8-word
// Camelot/Algebra-1.9 globalState. Live forks return SHORTER shapes for the same selectors:
//   slot0:       6 words on Slipstream-family pools (Velodrome CL on Celo/Ink/Unichain, Aerodrome
//                CL, Topaz on BSC — no feeProtocol word),
//   globalState: 7 words on Algebra V1 (QuickSwap V3, THENA Fusion), 6 words on Algebra Integral
//                (THENA V3,3, SwapX),
// and viem rejects the short returndata, which used to silently DROP those pools from the legacy
// aggregator (decode failure ⇒ pool skipped). The batched typed multicall stays the PRIMARY path
// (zero extra RPC for canonical pools); a pool whose typed decode fails is re-read with ONE raw
// eth_call and decoded by 32-byte word position, consuming ONLY the fields the aggregator needs —
// word 0 (sqrtPriceX96/price) and, for Algebra, the per-layout fee word (the layout taxonomy and
// the per-factory `algebraFeeLayout` config live in shared/constants.ts).

const SLOT0_CALLDATA = encodeFunctionData({ abi: v3PoolAbi, functionName: "slot0" });
const GLOBAL_STATE_CALLDATA = encodeFunctionData({ abi: algebraPoolAbi, functionName: "globalState" });

type AlgebraFeeLayout = NonNullable<FactoryConfig["algebraFeeLayout"]>;

/** Raw eth_call → returndata split into 32-byte words. undefined on revert/empty/ragged/short data. */
async function readReturnWords(
  client: PublicClient,
  to: Hex,
  data: Hex,
  minWords: number,
): Promise<bigint[] | undefined> {
  try {
    const { data: ret } = await client.call({ to, data });
    if (!ret) return undefined;
    const hex = ret.slice(2);
    if (hex.length === 0 || hex.length % 64 !== 0 || hex.length / 64 < minWords) return undefined;
    const words: bigint[] = [];
    for (let i = 0; i < hex.length / 64; i++) words.push(BigInt(`0x${hex.slice(i * 64, (i + 1) * 64)}`));
    return words;
  } catch {
    return undefined;
  }
}

/**
 * sqrtPriceX96 per pool from a typed slot0 multicall, with the shape-tolerant raw fallback. The raw
 * retry is only attempted when the pool's paired liquidity() read succeeded — a pool whose liquidity
 * read ALSO failed is a dead/non-V3 address, not a shape mismatch. Returns undefined where no shape
 * yields a price (the caller skips the pool, exactly as before).
 */
async function tolerantSqrtPrices(
  client: PublicClient,
  pools: readonly { address: Hex }[],
  slot0Results: readonly { status: "success" | "failure"; result?: unknown }[],
  liquidityResults: readonly { status: "success" | "failure" }[],
): Promise<(bigint | undefined)[]> {
  const prices: (bigint | undefined)[] = pools.map((_, i) => {
    const s = slot0Results[i];
    return s.status === "success" ? (s.result as unknown as [bigint, ...unknown[]])[0] : undefined;
  });
  await Promise.all(
    pools.map(async (p, i) => {
      if (prices[i] !== undefined || liquidityResults[i].status !== "success") return;
      const words = await readReturnWords(client, p.address, SLOT0_CALLDATA, 2); // ≥ (sqrtPriceX96, tick)
      if (words) prices[i] = words[0];
    }),
  );
  return prices;
}

/** globalState word count → fee layout, used ONLY when the factory config omits algebraFeeLayout. */
function guessAlgebraFeeLayout(wordCount: number): AlgebraFeeLayout {
  return wordCount >= 8 ? "camelot" : wordCount === 7 ? "algebra-v1" : "integral";
}

/**
 * The dynamic fee (ppm) at its per-layout globalState word (the algebraFeeLayout taxonomy in
 * shared/constants.ts): camelot is DIRECTIONAL — word 2 (feeZto) for zeroForOne, word 3 (feeOtz)
 * otherwise; algebra-v1 and integral carry a single fee ALWAYS at word 2 (their word 3 is the
 * timepointIndex / pluginConfig — NOT a fee). Masked to uint24 defensively.
 */
function algebraFeeAt(
  words: readonly (number | bigint)[],
  layout: AlgebraFeeLayout,
  zeroForOne: boolean,
): number {
  const w = (layout === "camelot" && !zeroForOne ? words[3] : words[2]) ?? 0;
  return Number(BigInt(w) & 0xffffffn);
}

const v2PairAbi = parseAbi([
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
]);

const v4StateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity)",
]);

// fee → tickSpacing lives in shared/constants.ts TICK_SPACING_BY_FEE (the single source —
// includes the non-standard Ramses CL 50→1 / 250→5 tiers a local copy here once missed).

/** V4 poolId = keccak256(abi.encode(PoolKey{currency0,currency1,fee,tickSpacing,hooks})). */
function computeV4PoolId(
  currency0: Hex,
  currency1: Hex,
  fee: number,
  tickSpacing: number,
  hooks: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, fee, tickSpacing, hooks],
    ),
  );
}

// ── New protocol ABIs ────────────────────────────────────────

const curveRegistryAbi = parseAbi([
  "function find_pool_for_coins(address from, address to) external view returns (address pool)",
  "function get_coin_indices(address pool, address from, address to) external view returns (int128 i, int128 j, bool underlying)",
  "function get_n_coins(address pool) external view returns (uint256)",
  "function get_decimals(address pool) external view returns (uint256[8] decimals)",
]);

const curvePoolAbi = parseAbi([
  "function balances(uint256 i) external view returns (uint256)",
  "function A() external view returns (uint256)",
  "function fee() external view returns (uint256)",
  "function coins(uint256 i) external view returns (address)",
  // StableSwap-NG only: the off-peg dynamic-fee multiplier (1e10-scaled). Absent on legacy pools.
  "function offpeg_fee_multiplier() external view returns (uint256)",
]);

// Curve CryptoSwap registry (crypto/tricrypto Metaregistry) + pool read surface. The crypto
// registry mirrors the StableSwap registry's find_pool_for_coins/get_coin_indices — but the coin
// indices are used as UINT256 (the crypto exchange(uint256,uint256,...) ABI). The pool exposes the
// A-gamma invariant state: A(), gamma(), balances(uint256), price_scale(), D(), coins(uint256),
// and the packed dynamic-fee params via mid_fee()/out_fee()/fee_gamma(). get_dy is the exact
// on-chain quote (the min_dy for exchange + the cross-check ground truth).
const curveCryptoRegistryAbi = parseAbi([
  "function find_pool_for_coins(address from, address to) external view returns (address pool)",
  "function get_coin_indices(address pool, address from, address to) external view returns (uint256 i, uint256 j)",
  "function get_n_coins(address pool) external view returns (uint256)",
  "function get_decimals(address pool) external view returns (uint256[8] decimals)",
]);

const cryptoPoolAbi = parseAbi([
  "function A() external view returns (uint256)",
  "function gamma() external view returns (uint256)",
  "function balances(uint256 i) external view returns (uint256)",
  "function price_scale() external view returns (uint256)",
  "function D() external view returns (uint256)",
  "function coins(uint256 i) external view returns (address)",
  "function mid_fee() external view returns (uint256)",
  "function out_fee() external view returns (uint256)",
  "function fee_gamma() external view returns (uint256)",
  "function get_dy(uint256 i, uint256 j, uint256 dx) external view returns (uint256)",
]);

const balancerPoolAbi = parseAbi([
  "function getPoolId() external view returns (bytes32)",
  "function totalSupply() external view returns (uint256)",
]);

// Balancer V2 ComposableStable pool + Vault read surface (the EcoSwap typed path). The pool exposes
// getPoolId (32-byte id; first 20 bytes == pool address), the amplification (A·AMP_PRECISION via
// getAmplificationParameter), the per-token scaling factors (decimals + rate-provider rates folded,
// all 1e18-WAD), the swap fee (1e18-WAD) and the BPT index (the pool token's own slot in the registered
// token list — excluded from StableMath). The Vault.getPoolTokens(poolId) returns the registered tokens
// + balances (INCLUDING the BPT). discoverBalancerStablePoolsTyped reads all of this so prepare's
// buildBalancerStableSegments replays the StableMath off-chain with NO further RPC.
const balancerStablePoolAbi = parseAbi([
  "function getPoolId() external view returns (bytes32)",
  "function getAmplificationParameter() external view returns (uint256 value, bool isUpdating, uint256 precision)",
  "function getScalingFactors() external view returns (uint256[] scalingFactors)",
  "function getSwapFeePercentage() external view returns (uint256)",
  "function getBptIndex() external view returns (uint256)",
]);

const balancerVaultAbi = parseAbi([
  "function getPoolTokens(bytes32 poolId) external view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)",
]);

// DODO V2 registry/factory getter. The wired FactoryType.DODOZoo address is a DVMFactory (verified
// on-chain: getDODOPool(base,quote) returns a flat address[] of PMM pools; the DODO V1 Zoo getter
// `getDODO` REVERTS on it — see the historical wrong-getter bug). The registry is base/quote-ORIENTED
// (a pair registered as base=X,quote=Y answers only that ordering), so discovery queries BOTH
// orderings and de-dupes on the returned pool address.
const dodoFactoryAbi = parseAbi([
  "function getDODOPool(address baseToken, address quoteToken) external view returns (address[] machines)",
]);

const dodoPoolAbi = parseAbi([
  "function _BASE_TOKEN_() external view returns (address)",
  "function _BASE_RESERVE_() external view returns (uint256)",
  "function _QUOTE_RESERVE_() external view returns (uint256)",
]);

// DODO V2 PMM state + fee readers (the EcoSwap typed path — distinct from the legacy
// reserve-only dodoPoolAbi). `getPMMStateForCall()` returns the full PMM curve state
// (i, K, B, Q, B0, Q0, R) so the off-chain closed-form replay needs NO further RPC; the
// LP/MT fee rates net the gross receive amount as querySell* does.
const dodoPmmAbi = parseAbi([
  "function getPMMStateForCall() external view returns (uint256 i, uint256 K, uint256 B, uint256 Q, uint256 B0, uint256 Q0, uint256 R)",
  "function _BASE_TOKEN_() external view returns (address)",
  "function _QUOTE_TOKEN_() external view returns (address)",
  "function _LP_FEE_RATE_() external view returns (uint256)",
  "function _MT_FEE_RATE_MODEL_() external view returns (address)",
]);

// The MT fee-rate model resolves the maintainer fee for a given trader; the per-trader
// `getFeeRate(trader)` is the canonical reader (a flat-rate model ignores the argument).
const dodoMtFeeModelAbi = parseAbi([
  "function getFeeRate(address trader) external view returns (uint256)",
  "function _FEE_RATE_() external view returns (uint256)",
]);

const traderJoeLBFactoryAbi = parseAbi([
  "function getLBPairInformation(address tokenX, address tokenY, uint256 binStep) external view returns (uint256 binStep2, address LBPair, bool createdByOwner, bool ignoredForRouting)",
]);

const traderJoeLBPairAbi = parseAbi([
  "function getReserves() external view returns (uint128 reserveX, uint128 reserveY)",
  "function getTokenX() external view returns (address)",
  "function getTokenY() external view returns (address)",
  "function getActiveId() external view returns (uint24 activeId)",
  "function getBinStep() external view returns (uint16 binStep)",
  "function getBin(uint24 id) external view returns (uint128 binReserveX, uint128 binReserveY)",
  "function getNextNonEmptyBin(bool swapForY, uint24 id) external view returns (uint24 nextId)",
  "function getStaticFeeParameters() external view returns (uint16 baseFactor, uint16 filterPeriod, uint16 decayPeriod, uint16 reductionFactor, uint24 variableFeeControl, uint16 protocolShare, uint24 maxVolatilityAccumulator)",
]);

const maverickFactoryAbi = parseAbi([
  "function lookup(address tokenA, address tokenB, uint256 startIndex, uint256 endIndex) external view returns (address[] pools)",
]);

const maverickPoolAbi = parseAbi([
  "function tokenA() external view returns (address)",
  "function getState() external view returns (int32 activeTick, uint8 status, uint256 binCounter, uint64 protocolFeeRatio, uint128 totalLiquidity)",
]);

const woofiAbi = parseAbi([
  "function query(address fromToken, address toToken, uint256 fromAmount) external view returns (uint256 toAmount)",
]);

// WooPPV2 sPMM read surface for the EcoSwap TYPED path (distinct from the legacy query-only woofiAbi).
// The pool exposes the quote-token numeraire, the WooracleV2 feed address, and per-base-token feeRate
// (1e5-scaled) inside the packed `tokenInfos(base)` struct (reserve, feeRate). WooracleV2.state(base)
// returns the sPMM inputs (price, spread, coeff, woFeasible) and decimals(base) the price scale (1e8).
const wooPPV2Abi = parseAbi([
  "function quoteToken() external view returns (address)",
  "function wooracle() external view returns (address)",
  "function tokenInfos(address token) external view returns (uint192 reserve, uint16 feeRate, uint128 maxGamma, uint128 maxNotionalSwap)",
  "function query(address fromToken, address toToken, uint256 fromAmount) external view returns (uint256 toAmount)",
]);

const wooracleV2Abi = parseAbi([
  "function state(address base) external view returns (uint128 price, uint64 spread, uint64 coeff, bool woFeasible)",
  "function decimals(address base) external view returns (uint8)",
]);

// Fermi / propAMM (gattaca-com/propamm FermiSwapper — Obric-style proactive AMM) read surface for the
// EcoSwap TYPED path — the REAL verified FermiSwapper ABI (0xb1076fe3ab5e28005c7c323bac5ac06a680d452e). The
// router exposes NO raw curve state (no tokenX/tokenY/K/base/feePpm getters) and NO getAmountOut view — only
// a SIGNED-amount quote (amountSpecified positive = exact tokenIn), a signed-amount swap, and pair listing /
// aliveness. Discovery reads `isActive` for the pair and SAMPLES the curve via `quoteAmounts` eth_calls.
const fermiPoolAbi = parseAbi([
  "function quoteAmounts(address tokenIn, address tokenOut, int256 amountSpecified) external view returns (uint256 amountIn, uint256 amountOut)",
  "function isActive(address baseAsset, address quoteAsset) external view returns (bool)",
]);

// Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — Liquidity-Layer-backed re-centering AMM) read
// surface for the EcoSwap TYPED path — the REAL VERIFIED interface (fluid-contracts-public
// poolT1/coreModule/core/main.sol + periphery/resolvers/dex/main.sol; FluidDexT1
// 0x6d83f60eEac0e50A1250760151E81Db2a278e03a). The DexT1 pool has NO standalone token0()/token1() getters
// (token0/token1 are immutables exposed ONLY inside constantsView()'s struct) — so the pair is oriented via
// the periphery resolver's `getDexTokens(dex) -> (address token0, address token1)`. Swapping is
// `swapIn(bool swap0to1, uint256 amountIn, uint256 amountOutMin, address to)` (approve-first: it pulls via
// safeTransferFrom). The pool has NO getAmountOut view — its own estimate is a REVERT (FluidDexSwapResult)
// — so the quote goes through the same resolver's
// `estimateSwapIn(address dex, bool swap0to1, uint256 amountIn, uint256 amountOutMin) -> uint256 amountOut`,
// which does the pool's revert-decode in Solidity and returns a plain uint256.
// estimateSwapIn is `payable` (non-view) on-chain: it wraps the pool's swapIn in a try/catch, and the REAL
// FluidDexT1 pool TOUCHES STATE on the ADDRESS_DEAD estimate path BEFORE it reverts with the result (verified
// by ecoswap.fluid.prodmirror.evm.test.ts: a STATICCALL to the real resolver returns 0 because the state
// write in the reverting sub-call is forbidden under STATICCALL — the mock fixture happens to revert with a
// pure result before any write, masking this). So the on-chain solver must emit a plain CALL (NOT a
// STATICCALL) — the recipe's IFluidDexResolver.json marks estimateSwapIn `nonpayable` for exactly this; the
// internal ADDRESS_DEAD revert rolls back any state, so the CALL is side-effect-free in effect. Here in
// DISCOVERY it is read off-chain via viem's `readContract`, whose eth_call is a top-level call (not the
// STATICCALL opcode) that permits — and discards — the sub-call's state write, so it reads cleanly; the
// `view` mutability below is only so viem's typed `readContract` accepts it. getDexTokens is a plain view.
const fluidResolverAbi = parseAbi([
  "function getDexTokens(address dex) external view returns (address token0, address token1)",
  "function estimateSwapIn(address dex, bool swap0to1, uint256 amountIn, uint256 amountOutMin) external view returns (uint256 amountOut)",
]);

// Tessera V (Wintermute TesseraSwap wrapper — treasury-funded proactive market maker) read surface for the
// EcoSwap TYPED path — the REAL VERIFIED wrapper ABI (TesseraSwap 0x55555522005BcAE1c2424D474BfD5ed477749E3e,
// Base blockscout verified; SAME address on BSC). The wrapper is a thin shell over a PRIVATE engine
// (swapAmountView/swapAmount) + a token treasury; it exposes NO pair enumeration and NO curve state — only
// the SIGNED-amount quote (amountSpecified positive = exact tokenIn, the propAMM taker convention) and the
// signed-amount swap. The view is REVERT-class (unsupported pair "T33", zero amount "T10" — probed live), so
// discovery's liveness probe is a caught quote; an oversized ask returns (in, 0) gracefully. See
// tessera-math.ts for the fork-measured priority-fee + gas-gate behavior.
const tesseraSwapAbi = parseAbi([
  "function tesseraSwapViewAmounts(address tokenIn, address tokenOut, int256 amountSpecified) external view returns (uint256 amountIn, uint256 amountOut)",
]);

// ElfomoFi (vault-funded PMM + on-chain pricing module) read surface for the EcoSwap TYPED path — the REAL
// VERIFIED wrapper ABI (ElfomoFi 0xf0f0F0F0FB0d738452EfD03A28e8be14C76d5f73, Base blockscout verified; SAME
// address on BSC). `getSupportedPairs()` enumerates the tradeable [tokenA, tokenB] pairs (a listed pair
// quotes in BOTH directions — verified live both ways); `getAmountOut` is the GRACEFUL single-return
// exact-in quote (0 on an unsupported pair / zero amount / stale oracle feed — probed live). The struct
// TokenPair mirrors IElfomoPricing.TokenPair (two addresses).
const elfomoFiAbi = parseAbi([
  "struct ElfomoTokenPair { address tokenA; address tokenB; }",
  "function getSupportedPairs() external view returns (ElfomoTokenPair[])",
  "function getAmountOut(address fromToken, address toToken, uint256 fromAmount) external view returns (uint256 toAmount)",
]);

// METRIC (metric.xyz oracle-anchored bin-curve OMM) read surface for the EcoSwap TYPED path — the REAL
// (UNVERIFIED-source, bytecode-probed + selector-resolved) interfaces; see metric-math.ts for the full
// probe record. `getImmutables()` word [1] = the pool's PriceProvider, [2] = token0, [3] = token1
// (word [0] = the protocol config contract; the real Base pool returns 14 words — the tail is curve
// parameters the recipe does not consume, and viem tolerates the extra trailing words, so ONLY the
// leading four are declared — robust across pool code variants). `getBidAndAskPrice()` is the
// maker-posted X64 anchor (STALENESS-REVERT class — 0x9a0423af past MAX_TIME_DELTA, so probes are
// caught). `quoteSwap` prices DIRECTLY off the caller-supplied (bid, ask) with a DIRECTIONAL price
// limit (0 for xToY, uint128.max for yToX; the wrong side quotes (0,0) gracefully) and returns SIGNED
// deltas (IN positive = consumed — an oversized ask partial-fills; OUT negative).
const metricPoolAbi = parseAbi([
  "function getImmutables() external view returns (address factory, address priceProvider, address token0, address token1)",
]);
const metricProviderAbi = parseAbi([
  "function getBidAndAskPrice() external view returns (uint128 bid, uint128 ask)",
]);
const metricRouterAbi = parseAbi([
  "function quoteSwap(address pool, bool xToY, int128 amountSpecified, uint128 priceLimit, uint128 bid, uint128 ask) external view returns (int256 amount0Delta, int256 amount1Delta)",
]);

// Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager stablecoin exchange) read surface for the
// EcoSwap TYPED path — the REAL VERIFIED interface (mento-core Broker.sol / IBroker.sol /
// IExchangeProvider.sol; Broker 0x777A8255cA72412f0d706dc03C9D1987306B4CaD, BiPoolManager
// 0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901). Discovery is a two-step enumeration:
//   Broker.getExchangeProviders() -> address[]        (the registered providers; BiPoolManager is one)
//   IExchangeProvider.getExchanges() -> Exchange[]     where Exchange { bytes32 exchangeId; address[] assets; }
// An exchange matches (tokenIn,tokenOut) when {tokenIn,tokenOut} == {assets[0],assets[1]} (unordered),
// yielding (exchangeProvider = the provider that returned it, exchangeId = Exchange.exchangeId). The Broker
// has a PLAIN getAmountOut VIEW (no revert-decode resolver, unlike Fluid):
//   getAmountOut(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut,
//                uint256 amountIn) view -> uint256 amountOut
// Discovery samples that view over [0, amountIn]. swapIn is the on-chain exec surface (approve the BROKER
// first — it pulls via transferFrom into the reserve). getExchanges returns a nested dynamic tuple array
// (assets is a dynamic address[]) — decoded by viem in TS discovery, NOT on-chain.
const mentoBrokerAbi = parseAbi([
  "function getExchangeProviders() external view returns (address[])",
  "function getAmountOut(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut)",
]);
const mentoExchangeProviderAbi = parseAbi([
  "struct Exchange { bytes32 exchangeId; address[] assets; }",
  "function getExchanges() external view returns (Exchange[])",
]);

// Balancer V3 (balancer-v3-monorepo — Vault singleton + per-chain Router) read surface for the EcoSwap
// TYPED path — the REAL VERIFIED interface (Vault 0xbA1333333333a1BA1108E8412f11850A5C319bA9 on every
// chain; Routers Base 0x3f17…DC10 / ETH 0xAE56…8Ea2 / Arb 0xEAed…CF2E / Sonic 0x93db…Dae5). Discovery is
// known-pool-address based (V3 has no pair→pool getter):
//   Vault.getPoolTokens(pool) view -> address[]  (the swappable tokens; V3 has NO BPT in the list, unlike V2)
//   Router.querySwapSingleTokenExactIn(pool, tokenIn, tokenOut, amountIn, sender, userData) -> uint256
//     — declared external (NOT view), eth_call-ONLY: it routes through the Vault's quote() (unlock()s in
//       QUERY mode + rolls back), which demands a static-call context, so it reverts both under a plain CALL
//       (NotStaticCall) and under a STATICCALL (its unlock() state write) — NOT callable on-chain in a cook.
//       INCLUDES rate providers + any dynamic StableSurge hook fee (the robust quote surface for plain AND
//       surge pools). Discovery samples it over [0, amountIn] via eth_call. The on-chain exec does NOT re-read
//       it: it Permit2-approves + swapSingleTokenExactIn with minAmountOut=0 (callback-free — the V3
//       reentrancy is contained inside Balancer's Router+Vault, never the cooking contract).
const balancerV3VaultAbi = parseAbi([
  "function getPoolTokens(address pool) external view returns (address[])",
  "function getCurrentLiveBalances(address pool) external view returns (uint256[])",
  "function getStaticSwapFeePercentage(address pool) external view returns (uint256)",
  "function getPoolTokenInfo(address pool) external view returns (address[] tokens, (uint8 tokenType, address rateProvider, bool paysYieldFees)[] tokenInfo, uint256[] balancesRaw, uint256[] lastBalancesLiveScaled18)",
]);
// The pool's amplification parameter (A·AMP_PRECISION) — read LIVE by the on-chain solver too.
const balancerV3PoolAbi = parseAbi([
  "function getAmplificationParameter() external view returns (uint256 value, bool isUpdating, uint256 precision)",
]);
// A WITH_RATE token's rate provider — getRate() is a plain uint256 SCALAR (v12-safe; the solver reads it live).
const balancerV3RateProviderAbi = parseAbi([
  "function getRate() external view returns (uint256)",
]);
// querySwapSingleTokenExactIn is declared `external` (NOT view) on-chain — it unlock()s the Vault in
// QUERY mode and rolls back — but is fully callable via eth_call. Declared `view` HERE so viem's
// `readContract` (an eth_call) can drive it for the off-chain sampling ladder (like Fluid's
// estimateSwapIn, marked view for the same reason); no state persists.
const balancerV3RouterAbi = parseAbi([
  "function querySwapSingleTokenExactIn(address pool, address tokenIn, address tokenOut, uint256 exactAmountIn, address sender, bytes userData) external view returns (uint256 amountOut)",
]);

// ── KyberSwap Classic / DMM ──────────────────────────────────
const kyberFactoryAbi = parseAbi([
  "function getPools(address token0, address token1) external view returns (address[] _pools)",
]);

const kyberPoolAbi = parseAbi([
  "function token0() external view returns (address)",
  "function getTradeInfo() external view returns (uint256 _reserve0, uint256 _reserve1, uint256 _vReserve0, uint256 _vReserve1, uint256 feeInPrecision)",
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
/** 1e18 WAD — default Balancer scaling factor (a missing factor falls back to no scale). */
const WAD_BAL = 10n ** 18n;

// ── V3 Standard discovery ───────────────────────────────────

async function discoverV3Pools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
  feeTiers: number[],
): Promise<PoolInfo[]> {
  // Each factory is queried across ITS OWN fee tiers (FactoryConfig.feeTiers),
  // falling back to the chain-level list. Lets forks with different tiers — e.g.
  // PancakeSwap V3's 2500 vs Uniswap's 3000 — both be discovered in one pass.
  const getPoolCalls = factories.flatMap((f) =>
    (f.feeTiers ?? feeTiers).map((fee) => ({
      address: f.address,
      abi: v3FactoryAbi,
      functionName: "getPool" as const,
      args: [tokenIn, tokenOut, fee] as const,
      factory: f,
      fee,
    })),
  );

  if (getPoolCalls.length === 0) return [];

  const poolAddresses = await client.multicall({
    contracts: getPoolCalls.map((c) => ({
      address: c.address,
      abi: c.abi,
      functionName: c.functionName,
      args: c.args,
    })),
    allowFailure: true,
  });

  const validPools: { address: Hex; factory: FactoryConfig; fee: number }[] = [];
  for (let i = 0; i < poolAddresses.length; i++) {
    const result = poolAddresses[i];
    if (
      result.status === "success" &&
      result.result &&
      result.result !== ZERO_ADDRESS
    ) {
      validPools.push({
        address: result.result as Hex,
        factory: getPoolCalls[i].factory,
        fee: getPoolCalls[i].fee,
      });
    }
  }

  if (validPools.length === 0) return [];

  // Read slot0 + liquidity
  const [slot0Results, liquidityResults] = await Promise.all([
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: v3PoolAbi,
        functionName: "slot0" as const,
      })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: v3PoolAbi,
        functionName: "liquidity" as const,
      })),
      allowFailure: true,
    }),
  ]);

  // Shape-tolerant slot0: the typed 7-word Uniswap decode above is the batched primary; a fork
  // returning the 6-word Slipstream-style slot0 falls back to one raw eth_call per pool.
  const sqrtPrices = await tolerantSqrtPrices(client, validPools, slot0Results, liquidityResults);

  const pools: PoolInfo[] = [];
  for (let i = 0; i < validPools.length; i++) {
    const sqrtPriceX96 = sqrtPrices[i];
    const liq = liquidityResults[i];
    if (sqrtPriceX96 === undefined || liq.status !== "success") continue;

    const liquidity = liq.result as bigint;
    if (sqrtPriceX96 === 0n || liquidity === 0n) continue;

    pools.push({
      address: validPools[i].address,
      tokenIn,
      tokenOut,
      fee: validPools[i].fee,
      poolType: validPools[i].factory.poolType,
      priceLimited: hasPriceLimit(validPools[i].factory.poolType),
      sqrtPriceX96,
      liquidity,
      source: validPools[i].factory.label,
    });
  }

  return pools;
}

// ── Slipstream CL discovery (tickSpacing-keyed V3) ────────────────────────────
//
// Velodrome/Aerodrome Slipstream (and the Ramses-lineage Shadow CL) pools are UniswapV3-compatible
// for pricing AND execution — the pool exposes the standard V3 view surface (slot0/liquidity/ticks/
// tickSpacing) and its swap() re-enters the caller via the EXACT uniswapV3SwapCallback selector the
// engine Router already implements (callbacks authenticated by the transient expectedPool, not a
// factory/CREATE2 check), so a Slipstream pool executes through the existing flat swapV3 path with
// NO engine change. The ONLY thing that differs is DISCOVERY: the CLFactory keys pools by TICK
// SPACING — getPool(tokenA, tokenB, int24 tickSpacing) — NOT getPool(a, b, uint24 fee), so a
// fee-tier-enumerating V3Standard pass finds nothing. This branch enumerates a per-factory set of
// enabled tickSpacings, and — because Slipstream DECOUPLES fee from tickSpacing — reads each
// surviving pool's OWN fee() getter to populate the same `fee` field the V3 path uses (NOT a
// tickSpacing→fee assumption). The resulting PoolInfo is byte-identical in shape to a
// V3Standard-discovered pool (mirrors discoverV3Pools), so the downstream bracket/lens/swapV3 path
// consumes it unchanged. See FactoryType.SlipstreamCL.

async function discoverSlipstreamCLPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  // Each Slipstream factory is queried across ITS OWN enabled tickSpacings
  // (FactoryConfig.slipstreamTickSpacings), defaulting to the Slipstream-common set. Over-querying
  // a spacing the factory doesn't enable is harmless — getPool(a,b,int24) returns address(0).
  const getPoolCalls = factories.flatMap((f) =>
    (f.slipstreamTickSpacings ?? [...SLIPSTREAM_TICK_SPACINGS]).map((tickSpacing) => ({
      address: f.address,
      abi: slipstreamFactoryAbi,
      functionName: "getPool" as const,
      // int24 tickSpacing — always positive for the enabled set, so the signed ABI encoding is
      // identical to the unsigned value; viem encodes the JS number as a signed int24 correctly.
      args: [tokenIn, tokenOut, tickSpacing] as const,
      factory: f,
      tickSpacing,
    })),
  );

  if (getPoolCalls.length === 0) return [];

  const poolAddresses = await client.multicall({
    contracts: getPoolCalls.map((c) => ({
      address: c.address,
      abi: c.abi,
      functionName: c.functionName,
      args: c.args,
    })),
    allowFailure: true,
  });

  const validPools: { address: Hex; factory: FactoryConfig; tickSpacing: number }[] = [];
  for (let i = 0; i < poolAddresses.length; i++) {
    const result = poolAddresses[i];
    if (
      result.status === "success" &&
      result.result &&
      result.result !== ZERO_ADDRESS
    ) {
      validPools.push({
        address: result.result as Hex,
        factory: getPoolCalls[i].factory,
        tickSpacing: getPoolCalls[i].tickSpacing,
      });
    }
  }

  if (validPools.length === 0) return [];

  // Read slot0 + liquidity (standard V3 surface) AND the pool's OWN fee() — Slipstream decouples
  // fee from tickSpacing, so the fee must be READ per pool, not derived from the tickSpacing key.
  const [slot0Results, liquidityResults, feeResults] = await Promise.all([
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: v3PoolAbi,
        functionName: "slot0" as const,
      })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: v3PoolAbi,
        functionName: "liquidity" as const,
      })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: v3PoolFeeAbi,
        functionName: "fee" as const,
      })),
      allowFailure: true,
    }),
  ]);

  // Shape-tolerant slot0: real Slipstream pools return a 6-WORD slot0 (no feeProtocol word), which
  // the typed 7-word Uniswap decode rejects — those pools (Velodrome CL on Celo/Ink/Unichain,
  // Aerodrome CL, Topaz on BSC) fall back to one raw eth_call per pool, consuming only word 0.
  const sqrtPrices = await tolerantSqrtPrices(client, validPools, slot0Results, liquidityResults);

  const pools: PoolInfo[] = [];
  for (let i = 0; i < validPools.length; i++) {
    const sqrtPriceX96 = sqrtPrices[i];
    const liq = liquidityResults[i];
    const feeRes = feeResults[i];
    if (sqrtPriceX96 === undefined || liq.status !== "success") continue;

    const liquidity = liq.result as bigint;
    if (sqrtPriceX96 === 0n || liquidity === 0n) continue;

    // The pool's OWN fee (ppm) from fee() — the byte-identical `fee` field a V3Standard pool
    // carries. A fee() read failure (non-standard fork) is not fatal: the pool is still a valid
    // V3-priced venue; fall back to 0 (dynamic/unknown), matching the Algebra convention.
    const fee = feeRes.status === "success" ? Number(feeRes.result as number) : 0;

    pools.push({
      address: validPools[i].address,
      tokenIn,
      tokenOut,
      fee,
      poolType: validPools[i].factory.poolType,
      priceLimited: hasPriceLimit(validPools[i].factory.poolType),
      sqrtPriceX96,
      liquidity,
      source: validPools[i].factory.label,
      // The discovery key. In real Slipstream getPool(a,b,ts) returns a pool whose tickSpacing()==ts
      // (only FEE is decoupled from the key), so this key IS the live grid — a meaningful value, unlike
      // discoverV3Pools which leaves it undefined for downstream fee→grid derivation. No current
      // consumer trusts it for a Slipstream row (the EcoSwap solver reads the LIVE tickSpacing() via the
      // on-chain lens; quoting.ts hardcodes tickSpacing:0 on the V3 quote path), so it is purely
      // informational here.
      tickSpacing: validPools[i].tickSpacing,
    });
  }

  return pools;
}

// ── Algebra V3 discovery (EXECUTABLE) ─────────────────────────────────────────
//
// Algebra forks (Camelot/QuickSwap V3, Ramses V2) are V3-shaped, so their state reads
// (globalState() → price/tick/dynamic-fee) map cleanly onto a UniV3 PoolInfo and PRICE
// wei-exact against the V3 oracle. The engine now EXECUTES an Algebra swap as well: the
// pool re-enters via algebraSwapCallback(int256,int256,bytes), and the Router implements
// that selector (a mirror of uniswapV3/pancakeV3 callbacks → _handleV3Callback) as of
// sauce#186. An Algebra pool's swap() is selector-identical to Uniswap V3, so _swapV3
// drives it and the new callback services the mid-swap input pull — so Algebra pools are
// INCLUDED in the executable set returned by discoverPools. See FactoryType.AlgebraV3 +
// LIQUIDITY_SOURCES_FEASIBILITY.md §3.

async function discoverAlgebraPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (factories.length === 0) return [];

  const poolAddresses = await client.multicall({
    contracts: factories.map((f) => ({
      address: f.address,
      abi: algebraFactoryAbi,
      functionName: "poolByPair" as const,
      args: [tokenIn, tokenOut] as const,
    })),
    allowFailure: true,
  });

  const validPools: { address: Hex; factory: FactoryConfig }[] = [];
  for (let i = 0; i < poolAddresses.length; i++) {
    const result = poolAddresses[i];
    if (
      result.status === "success" &&
      result.result &&
      result.result !== ZERO_ADDRESS
    ) {
      validPools.push({ address: result.result as Hex, factory: factories[i] });
    }
  }

  if (validPools.length === 0) return [];

  // Read globalState + liquidity
  const [stateResults, liquidityResults] = await Promise.all([
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: algebraPoolAbi,
        functionName: "globalState" as const,
      })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: algebraPoolAbi,
        functionName: "liquidity" as const,
      })),
      allowFailure: true,
    }),
  ]);

  // Shape-tolerant globalState: the typed 8-word Camelot decode above is the batched primary; the
  // 7-word Algebra V1 (QuickSwap V3, THENA Fusion) and 6-word Integral (THENA V3,3, SwapX) shapes
  // fall back to one raw eth_call per pool, decoded by word position. The DYNAMIC fee is read at its
  // per-layout word — resolved by `FactoryConfig.algebraFeeLayout` when the config carries it,
  // length-guessed from the returndata shape only when it does not.
  const zeroForOne = BigInt(tokenIn) < BigInt(tokenOut); // tokenIn is the pool's token0
  const states: ({ price: bigint; fee: number } | undefined)[] = validPools.map((p, i) => {
    const s = stateResults[i];
    if (s.status !== "success") return undefined;
    // Typed 8-word decode: [price, tick, feeZto, feeOtz, …]. An explicit non-camelot layout still
    // reads word 2 — both single-fee layouts carry the fee there.
    const r = s.result as unknown as readonly (number | bigint)[];
    const layout = p.factory.algebraFeeLayout ?? "camelot";
    return { price: r[0] as bigint, fee: algebraFeeAt(r, layout, zeroForOne) };
  });
  await Promise.all(
    validPools.map(async (p, i) => {
      if (states[i] !== undefined || liquidityResults[i].status !== "success") return;
      const words = await readReturnWords(client, p.address, GLOBAL_STATE_CALLDATA, 3); // ≥ (price, tick, fee)
      if (!words) return;
      const layout = p.factory.algebraFeeLayout ?? guessAlgebraFeeLayout(words.length);
      states[i] = { price: words[0], fee: algebraFeeAt(words, layout, zeroForOne) };
    }),
  );

  const pools: PoolInfo[] = [];
  for (let i = 0; i < validPools.length; i++) {
    const state = states[i];
    const liq = liquidityResults[i];
    if (state === undefined || liq.status !== "success") continue;

    const liquidity = liq.result as bigint;
    if (state.price === 0n || liquidity === 0n) continue;

    pools.push({
      address: validPools[i].address,
      tokenIn,
      tokenOut,
      // The DYNAMIC fee (ppm) read from globalState at its per-layout word (directional for
      // camelot). Previously hardcoded 0; downstream fee consumers (megaswap's fee-adjusted
      // price limit) now see the real Algebra fee, same as a fixed-tier V3 row.
      fee: state.fee,
      poolType: validPools[i].factory.poolType,
      priceLimited: hasPriceLimit(validPools[i].factory.poolType),
      sqrtPriceX96: state.price, // globalState.price is sqrtPriceX96-compatible
      liquidity,
      source: validPools[i].factory.label,
    });
  }

  return pools;
}

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
export async function discoverAlgebraPoolAddresses(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (factories.length === 0) return out;
  const results = await client.multicall({
    contracts: factories.map((f) => ({
      address: f.address,
      abi: algebraFactoryAbi,
      functionName: "poolByPair" as const,
      args: [tokenIn, tokenOut] as const,
    })),
    allowFailure: true,
  });
  for (const r of results) {
    if (r.status === "success" && r.result && r.result !== ZERO_ADDRESS) {
      out.add((r.result as string).toLowerCase());
    }
  }
  return out;
}

// ── V2 Standard discovery ───────────────────────────────────

async function discoverV2Pools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (factories.length === 0) return [];

  const pairAddresses = await client.multicall({
    contracts: factories.map((f) => ({
      address: f.address,
      abi: v2FactoryAbi,
      functionName: "getPair" as const,
      args: [tokenIn, tokenOut] as const,
    })),
    allowFailure: true,
  });

  const validPairs: { address: Hex; factory: FactoryConfig }[] = [];
  for (let i = 0; i < pairAddresses.length; i++) {
    const result = pairAddresses[i];
    if (
      result.status === "success" &&
      result.result &&
      result.result !== ZERO_ADDRESS
    ) {
      validPairs.push({ address: result.result as Hex, factory: factories[i] });
    }
  }

  if (validPairs.length === 0) return [];

  return readV2PoolState(tokenIn, tokenOut, client, validPairs);
}

// ── Solidly V2 discovery ────────────────────────────────────

async function discoverSolidlyV2Pools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (factories.length === 0) return [];

  // Query both volatile (stable=false) and stable (stable=true) pools
  const calls = factories.flatMap((f) => [
    {
      address: f.address,
      abi: solidlyFactoryAbi,
      functionName: "getPool" as const,
      args: [tokenIn, tokenOut, false] as const, // volatile
      factory: f,
      stable: false,
    },
    {
      address: f.address,
      abi: solidlyFactoryAbi,
      functionName: "getPool" as const,
      args: [tokenIn, tokenOut, true] as const, // stable
      factory: f,
      stable: true,
    },
  ]);

  const poolAddresses = await client.multicall({
    contracts: calls.map((c) => ({
      address: c.address,
      abi: c.abi,
      functionName: c.functionName,
      args: c.args,
    })),
    allowFailure: true,
  });

  const seen = new Set<string>();
  const validPairs: { address: Hex; factory: FactoryConfig }[] = [];
  for (let i = 0; i < poolAddresses.length; i++) {
    const result = poolAddresses[i];
    if (result.status === "success" && result.result && result.result !== ZERO_ADDRESS) {
      const addr = (result.result as string).toLowerCase();
      if (!seen.has(addr)) {
        seen.add(addr);
        const label = calls[i].stable ? `${calls[i].factory.label} (stable)` : calls[i].factory.label;
        validPairs.push({ address: result.result as Hex, factory: { ...calls[i].factory, label } });
      }
    }
  }

  if (validPairs.length === 0) return [];

  // The legacy aggregator models BOTH Solidly volatile AND stable pools as xy=k V2 — the pre-existing
  // behaviour the other recipes (megaswap/alphaswap/gigaswap/terraswap) were tuned against; left
  // untouched so adding the stable source does not silently shift their routing. EcoSwap does NOT use
  // this path for stable pools — it discovers them precisely as typed SolidlyStablePool descriptors via
  // discoverSolidlyStablePoolsTyped (x3y+y3x sampled segments), so stable-curve fidelity lives there.
  return readV2PoolState(tokenIn, tokenOut, client, validPairs);
}

/** Interpret a Solidly factory `getFee` result as ppm (heuristic: a small value is bps → ×100). */
function solidlyFeeToPpm(fee: bigint | undefined): number {
  if (fee === undefined) return SOLIDLY_STABLE_DEFAULT_FEE_PPM;
  const n = Number(fee);
  if (n === 0) return SOLIDLY_STABLE_DEFAULT_FEE_PPM;
  // Velodrome/Aerodrome `getFee` returns bps (e.g. 1 = 0.01%); a value < 1000 is bps → ppm = bps×100.
  // A larger value is already ppm.
  return n < 1000 ? n * 100 : n;
}

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
export async function discoverSolidlyStablePoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<SolidlyStablePool[]> {
  if (factories.length === 0) return [];

  const addrResults = await client.multicall({
    contracts: factories.map((f) => ({
      address: f.address,
      abi: solidlyFactoryAbi,
      functionName: "getPool" as const,
      args: [tokenIn, tokenOut, true] as const, // stable
    })),
    allowFailure: true,
  });

  const seen = new Set<string>();
  const valid: { address: Hex; factory: FactoryConfig }[] = [];
  for (let i = 0; i < addrResults.length; i++) {
    const r = addrResults[i];
    if (r.status !== "success" || !r.result || r.result === ZERO_ADDRESS) continue;
    const key = (r.result as string).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ address: r.result as Hex, factory: factories[i] });
  }
  if (valid.length === 0) return [];

  const [token0Results, reserveResults, feeResults] = await Promise.all([
    client.multicall({
      contracts: valid.map((p) => ({ address: p.address, abi: solidlyStablePoolAbi, functionName: "token0" as const })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: valid.map((p) => ({ address: p.address, abi: solidlyStablePoolAbi, functionName: "getReserves" as const })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: valid.map((p) => ({ address: p.factory.address, abi: solidlyFactoryAbi, functionName: "getFee" as const, args: [p.address, true] as const })),
      allowFailure: true,
    }),
  ]);

  // Decimals: read the two tokens once (tokenIn + tokenOut).
  const [decInRaw, decOutRaw] = await Promise.all([
    client.readContract({ address: tokenIn, abi: erc20DecimalsAbi, functionName: "decimals" }).then((d) => Number(d)).catch(() => 18),
    client.readContract({ address: tokenOut, abi: erc20DecimalsAbi, functionName: "decimals" }).then((d) => Number(d)).catch(() => 18),
  ]);
  const decIn = 10n ** BigInt(decInRaw);
  const decOut = 10n ** BigInt(decOutRaw);

  const pools: SolidlyStablePool[] = [];
  for (let i = 0; i < valid.length; i++) {
    const t0 = token0Results[i];
    const reserves = reserveResults[i];
    if (t0.status !== "success" || reserves.status !== "success") continue;
    const [reserve0, reserve1] = reserves.result as [bigint, bigint, bigint];
    if (reserve0 === 0n || reserve1 === 0n) continue;
    const token0 = (t0.result as Hex);
    const inIsToken0 = tokenIn.toLowerCase() === token0.toLowerCase();
    pools.push({
      address: valid[i].address,
      reserveIn: inIsToken0 ? reserve0 : reserve1,
      reserveOut: inIsToken0 ? reserve1 : reserve0,
      decIn,
      decOut,
      token0,
      inIsToken0,
      feePpm: solidlyFeeToPpm(feeResults[i].status === "success" ? (feeResults[i].result as bigint) : undefined),
      source: `${valid[i].factory.label} (Solidly stable)`,
    });
  }
  return pools;
}

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
export async function discoverSolidlyVolatilePoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<SolidlyVolatilePool[]> {
  if (factories.length === 0) return [];

  const addrResults = await client.multicall({
    contracts: factories.map((f) => ({
      address: f.address,
      abi: solidlyFactoryAbi,
      functionName: "getPool" as const,
      args: [tokenIn, tokenOut, false] as const, // volatile (vAMM)
    })),
    allowFailure: true,
  });

  const seen = new Set<string>();
  const valid: { address: Hex; factory: FactoryConfig }[] = [];
  for (let i = 0; i < addrResults.length; i++) {
    const r = addrResults[i];
    if (r.status !== "success" || !r.result || r.result === ZERO_ADDRESS) continue;
    const key = (r.result as string).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ address: r.result as Hex, factory: factories[i] });
  }
  if (valid.length === 0) return [];

  const [stableResults, token0Results, reserveResults, feeResults] = await Promise.all([
    client.multicall({
      contracts: valid.map((p) => ({ address: p.address, abi: solidlyStablePoolAbi, functionName: "stable" as const })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: valid.map((p) => ({ address: p.address, abi: solidlyStablePoolAbi, functionName: "token0" as const })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: valid.map((p) => ({ address: p.address, abi: solidlyStablePoolAbi, functionName: "getReserves" as const })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: valid.map((p) => ({ address: p.factory.address, abi: solidlyFactoryAbi, functionName: "getFee" as const, args: [p.address, false] as const })),
      allowFailure: true,
    }),
  ]);

  const pools: SolidlyVolatilePool[] = [];
  for (let i = 0; i < valid.length; i++) {
    const st = stableResults[i];
    const t0 = token0Results[i];
    const reserves = reserveResults[i];
    // A vAMM MUST be non-stable: filter out any pool that reports stable()==true (a stable-curve pool
    // must NOT be modeled as xy=k — it rides discoverSolidlyStablePoolsTyped's x3y+y3x QL path instead).
    if (st.status !== "success" || st.result === true) continue;
    if (t0.status !== "success" || reserves.status !== "success") continue;
    const [reserve0, reserve1] = reserves.result as [bigint, bigint, bigint];
    if (reserve0 === 0n || reserve1 === 0n) continue;
    const token0 = t0.result as Hex;
    const inIsToken0 = tokenIn.toLowerCase() === token0.toLowerCase();
    pools.push({
      address: valid[i].address,
      reserveIn: inIsToken0 ? reserve0 : reserve1,
      reserveOut: inIsToken0 ? reserve1 : reserve0,
      inIsToken0,
      // Real per-pool fee from the factory getFee(pool,false), normalised bps→ppm; on read failure
      // fall back to the canonical 0.30% vAMM tier (NOT the 0.01% stable default — a wrong fee here
      // would make the callback-free K-invariant revert on exec).
      feePpm: feeResults[i].status === "success"
        ? solidlyFeeToPpm(feeResults[i].result as bigint)
        : V2_DEFAULT_FEE_PPM,
      source: `${valid[i].factory.label} (Solidly volatile)`,
    });
  }
  return pools;
}

// ── Shared V2 pool state reader ─────────────────────────────

async function readV2PoolState(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  validPairs: { address: Hex; factory: FactoryConfig }[],
): Promise<PoolInfo[]> {
  // Read getReserves + token0
  const [reserveResults, token0Results] = await Promise.all([
    client.multicall({
      contracts: validPairs.map((p) => ({
        address: p.address,
        abi: v2PairAbi,
        functionName: "getReserves" as const,
      })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: validPairs.map((p) => ({
        address: p.address,
        abi: v2PairAbi,
        functionName: "token0" as const,
      })),
      allowFailure: true,
    }),
  ]);

  const pools: PoolInfo[] = [];
  for (let i = 0; i < validPairs.length; i++) {
    const reserves = reserveResults[i];
    const t0 = token0Results[i];
    if (reserves.status !== "success" || t0.status !== "success") continue;

    const [reserve0, reserve1] = reserves.result as [bigint, bigint, number];
    const token0 = (t0.result as string).toLowerCase();
    if (reserve0 === 0n || reserve1 === 0n) continue;

    // Determine reserves relative to tokenIn/tokenOut
    const isToken0In = tokenIn.toLowerCase() === token0;
    const reserveIn = isToken0In ? reserve0 : reserve1;
    const reserveOut = isToken0In ? reserve1 : reserve0;

    // Derive synthetic sqrtPriceX96 from reserves for comparable depth measurement
    const syntheticLiquidity = sqrt(reserveIn * reserveOut);

    // Synthetic sqrtPriceX96: sqrt(reserve1/reserve0) * 2^96
    const Q96 = 1n << 96n;
    const syntheticSqrtPrice = (sqrt(reserveOut * Q96 * Q96) * Q96) / (sqrt(reserveIn * Q96 * Q96));

    pools.push({
      address: validPairs[i].address,
      tokenIn,
      tokenOut,
      fee: 3000, // V2 standard fee is 0.3% = 3000 bps
      poolType: validPairs[i].factory.poolType,
      priceLimited: false,
      sqrtPriceX96: syntheticSqrtPrice > 0n ? syntheticSqrtPrice : 1n,
      liquidity: syntheticLiquidity,
      source: validPairs[i].factory.label,
    });
  }

  return pools;
}

// ── Curve discovery ─────────────────────────────────────────

async function discoverCurvePools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  registries: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (registries.length === 0) return [];

  const pools: PoolInfo[] = [];
  for (const registry of registries) {
    try {
      const poolAddr = await client.readContract({
        address: registry.address,
        abi: curveRegistryAbi,
        functionName: "find_pool_for_coins",
        args: [tokenIn, tokenOut],
      }) as string;

      if (!poolAddr || poolAddr === ZERO_ADDRESS) continue;

      // Read reserves (balances[0] and balances[1]) to verify liquidity
      const [bal0, bal1] = await Promise.all([
        client.readContract({ address: poolAddr as Hex, abi: curvePoolAbi, functionName: "balances", args: [0n] }).catch(() => 0n) as Promise<bigint>,
        client.readContract({ address: poolAddr as Hex, abi: curvePoolAbi, functionName: "balances", args: [1n] }).catch(() => 0n) as Promise<bigint>,
      ]);

      if (bal0 === 0n || bal1 === 0n) continue;

      const syntheticLiquidity = sqrt(bal0 * bal1);
      const Q96 = 1n << 96n;
      const syntheticSqrtPrice = bal0 > 0n ? (sqrt(bal1 * Q96 * Q96) * Q96) / sqrt(bal0 * Q96 * Q96) : 1n;

      pools.push({
        address: poolAddr as Hex,
        tokenIn,
        tokenOut,
        fee: 400, // Curve typical fee ~0.04% = 400 bps (varies by pool)
        poolType: SwapPoolType.Curve,
        priceLimited: false,
        sqrtPriceX96: syntheticSqrtPrice > 0n ? syntheticSqrtPrice : 1n,
        liquidity: syntheticLiquidity,
        source: registry.label,
      });
    } catch {
      // Registry call failed, skip
    }
  }

  return pools;
}

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
export async function discoverCurvePoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  registries: FactoryConfig[],
): Promise<CurvePool[]> {
  if (registries.length === 0) return [];

  const pools: CurvePool[] = [];
  for (const registry of registries) {
    try {
      const poolAddr = (await client.readContract({
        address: registry.address,
        abi: curveRegistryAbi,
        functionName: "find_pool_for_coins",
        args: [tokenIn, tokenOut],
      })) as Hex;
      if (!poolAddr || poolAddr === ZERO_ADDRESS) continue;

      // Coin indices + coin count + decimals from the registry (int128 i,j = engine ABI).
      const [indices, nCoinsRaw, decimalsRaw] = await Promise.all([
        client.readContract({
          address: registry.address,
          abi: curveRegistryAbi,
          functionName: "get_coin_indices",
          args: [poolAddr, tokenIn, tokenOut],
        }) as Promise<readonly [bigint, bigint, boolean]>,
        client.readContract({
          address: registry.address,
          abi: curveRegistryAbi,
          functionName: "get_n_coins",
          args: [poolAddr],
        }).catch(() => 2n) as Promise<bigint>,
        client.readContract({
          address: registry.address,
          abi: curveRegistryAbi,
          functionName: "get_decimals",
          args: [poolAddr],
        }).catch(() => null) as Promise<readonly bigint[] | null>,
      ]);

      const i = Number(indices[0]);
      const j = Number(indices[1]);
      const underlying = indices[2];
      // Underlying (meta-pool lending) coins need a different exchange path; plain only.
      if (underlying) continue;
      const N = Number(nCoinsRaw) || 2;
      if (i < 0 || j < 0 || i >= N || j >= N) continue;

      // Pool state: A, fee, the off-peg multiplier (NG only — absent on legacy pools ⇒ undefined),
      // and the full balances array.
      const [A, feeRaw, offpegRaw] = await Promise.all([
        client.readContract({ address: poolAddr, abi: curvePoolAbi, functionName: "A" }) as Promise<bigint>,
        client.readContract({ address: poolAddr, abi: curvePoolAbi, functionName: "fee" }) as Promise<bigint>,
        client
          .readContract({ address: poolAddr, abi: curvePoolAbi, functionName: "offpeg_fee_multiplier" })
          .then((v) => v as bigint)
          .catch(() => undefined) as Promise<bigint | undefined>,
      ]);
      const balances: bigint[] = await Promise.all(
        Array.from({ length: N }, (_, k) =>
          client.readContract({
            address: poolAddr,
            abi: curvePoolAbi,
            functionName: "balances",
            args: [BigInt(k)],
          }) as Promise<bigint>,
        ),
      );
      if (balances.some((b) => b <= 0n)) continue;

      // rates[k] = 1e18 * 10**(18 - decimals[k]) — scale each coin into the common 1e18 unit.
      // Registry get_decimals returns a uint256[8]; fall back to per-coin decimals() reads.
      let decimals: number[];
      if (decimalsRaw && decimalsRaw.length >= N) {
        decimals = Array.from({ length: N }, (_, k) => Number(decimalsRaw[k]));
      } else {
        const coinAddrs = await Promise.all(
          Array.from({ length: N }, (_, k) =>
            client.readContract({
              address: poolAddr,
              abi: curvePoolAbi,
              functionName: "coins",
              args: [BigInt(k)],
            }) as Promise<Hex>,
          ),
        );
        decimals = await Promise.all(
          coinAddrs.map((addr) =>
            client
              .readContract({
                address: addr,
                abi: parseAbi(["function decimals() view returns (uint8)"]),
                functionName: "decimals",
              })
              .then((d) => Number(d))
              .catch(() => 18),
          ),
        );
      }
      const rates = decimals.map((d) => 10n ** 18n * 10n ** BigInt(18 - d));

      pools.push({
        poolType: SwapPoolType.Curve,
        address: poolAddr,
        i,
        j,
        A,
        aPrecision: A_PRECISION_DEFAULT,
        balances,
        rates,
        feePpm10: feeRaw,
        // NG dynamic fee: makes the off-chain replay wei-exact against get_dy/exchange for an NG
        // pool. Legacy pools have no such getter ⇒ undefined ⇒ getDy falls back to the flat fee.
        offpegFeeMultiplier: offpegRaw,
        source: registry.label,
      });
    } catch {
      // Registry / pool read failed — skip this registry.
    }
  }

  return pools;
}

/** Round a Curve crypto mid_fee (1e10-scaled, e.g. 5e6 = 0.05%) to a ppm fee (the price coordinate). */
function cryptoFeeToPpm(midFee: bigint): number {
  return Number((midFee * 1_000_000n + FEE_DENOMINATOR_CRYPTO / 2n) / FEE_DENOMINATOR_CRYPTO);
}

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
export async function discoverCryptoSwapPoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  registries: FactoryConfig[],
): Promise<CryptoSwapPool[]> {
  if (registries.length === 0) return [];

  const pools: CryptoSwapPool[] = [];
  for (const registry of registries) {
    try {
      const poolAddr = (await client.readContract({
        address: registry.address,
        abi: curveCryptoRegistryAbi,
        functionName: "find_pool_for_coins",
        args: [tokenIn, tokenOut],
      })) as Hex;
      if (!poolAddr || poolAddr === ZERO_ADDRESS) continue;

      // uint256 coin indices + coin count + decimals from the registry.
      const [indices, nCoinsRaw, decimalsRaw] = await Promise.all([
        client.readContract({
          address: registry.address,
          abi: curveCryptoRegistryAbi,
          functionName: "get_coin_indices",
          args: [poolAddr, tokenIn, tokenOut],
        }) as Promise<readonly [bigint, bigint]>,
        client
          .readContract({ address: registry.address, abi: curveCryptoRegistryAbi, functionName: "get_n_coins", args: [poolAddr] })
          .catch(() => 2n) as Promise<bigint>,
        client
          .readContract({ address: registry.address, abi: curveCryptoRegistryAbi, functionName: "get_decimals", args: [poolAddr] })
          .catch(() => null) as Promise<readonly bigint[] | null>,
      ]);

      const i = Number(indices[0]);
      const j = Number(indices[1]);
      const N = Number(nCoinsRaw) || 2;
      // 2-coin scope: the price_scale/replay below assumes a 2-coin pool (coin0 numeraire, coin1
      // price-scaled). A non-2-coin (tricrypto) pool needs a per-pair price and is deferred.
      if (N !== 2) continue;
      if (i < 0 || j < 0 || i >= N || j >= N) continue;

      // Live A-gamma state. A() is ANN (already A_MULTIPLIER·N^N-scaled), used directly.
      const [A, gamma, priceScale, D, midFee, outFee, feeGamma] = await Promise.all([
        client.readContract({ address: poolAddr, abi: cryptoPoolAbi, functionName: "A" }) as Promise<bigint>,
        client.readContract({ address: poolAddr, abi: cryptoPoolAbi, functionName: "gamma" }) as Promise<bigint>,
        client.readContract({ address: poolAddr, abi: cryptoPoolAbi, functionName: "price_scale" }) as Promise<bigint>,
        client.readContract({ address: poolAddr, abi: cryptoPoolAbi, functionName: "D" }) as Promise<bigint>,
        client.readContract({ address: poolAddr, abi: cryptoPoolAbi, functionName: "mid_fee" }) as Promise<bigint>,
        client.readContract({ address: poolAddr, abi: cryptoPoolAbi, functionName: "out_fee" }) as Promise<bigint>,
        client.readContract({ address: poolAddr, abi: cryptoPoolAbi, functionName: "fee_gamma" }) as Promise<bigint>,
      ]);
      const balances: bigint[] = await Promise.all(
        Array.from({ length: N }, (_, k) =>
          client.readContract({ address: poolAddr, abi: cryptoPoolAbi, functionName: "balances", args: [BigInt(k)] }) as Promise<bigint>,
        ),
      );
      if (balances.some((b) => b <= 0n) || D <= 0n || priceScale <= 0n) continue;

      // precisions[k] = 10**(18 - decimals[k]) — the registry get_decimals returns uint256[8].
      let decimals: number[];
      if (decimalsRaw && decimalsRaw.length >= N) {
        decimals = Array.from({ length: N }, (_, k) => Number(decimalsRaw[k]));
      } else {
        const coinAddrs = await Promise.all(
          Array.from({ length: N }, (_, k) =>
            client.readContract({ address: poolAddr, abi: cryptoPoolAbi, functionName: "coins", args: [BigInt(k)] }) as Promise<Hex>,
          ),
        );
        decimals = await Promise.all(
          coinAddrs.map((addr) =>
            client
              .readContract({ address: addr, abi: erc20DecimalsAbi, functionName: "decimals" })
              .then((d) => Number(d))
              .catch(() => 18),
          ),
        );
      }
      const precisions = decimals.map((d) => 10n ** BigInt(18 - d));

      pools.push({
        address: poolAddr,
        i,
        j,
        A,
        gamma,
        priceScale,
        D,
        balances,
        precisions,
        midFee,
        outFee,
        feeGamma,
        feePpm: cryptoFeeToPpm(midFee),
        source: registry.label,
      });
    } catch {
      // Registry / pool read failed — skip this registry.
    }
  }

  return pools;
}

// ── Balancer V2 discovery ───────────────────────────────────

async function discoverBalancerV2Pools(
  tokenIn: Hex,
  tokenOut: Hex,
  _client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  // Balancer V2 has no simple pair→pool lookup.
  // Discovery requires known pool addresses or a subgraph query.
  // For now, return empty — Balancer pools will be discovered via
  // external tooling and passed as explicit pool addresses in config.
  // The Router handler is ready; this is the discovery gap.
  if (factories.length === 0) return [];

  // TODO: Integrate Balancer V2 subgraph or known-pool list
  // The Vault at factories[0].address supports the swap, but pool discovery
  // requires getPoolTokens() with known poolIds.
  return [];
}

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
export async function discoverBalancerStablePoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<BalancerStablePool[]> {
  if (factories.length === 0) return [];
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();

  const pools: BalancerStablePool[] = [];
  const seen = new Set<string>();
  for (const vault of factories) {
    const knownPools = vault.balancerStablePools ?? [];
    if (knownPools.length === 0) continue;
    for (const poolAddr of knownPools) {
      const key = poolAddr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        // Pool id + the live StableMath state. getBptIndex reverts on a non-composable (legacy
        // MetaStable) pool — caught below; such a pool has no BPT to exclude (handled as bptIndex = -1).
        const [poolId, ampRaw, scalingRaw, feeRaw] = await Promise.all([
          client.readContract({ address: poolAddr, abi: balancerStablePoolAbi, functionName: "getPoolId" }) as Promise<Hex>,
          client.readContract({ address: poolAddr, abi: balancerStablePoolAbi, functionName: "getAmplificationParameter" }) as Promise<readonly [bigint, boolean, bigint]>,
          client.readContract({ address: poolAddr, abi: balancerStablePoolAbi, functionName: "getScalingFactors" }) as Promise<readonly bigint[]>,
          client.readContract({ address: poolAddr, abi: balancerStablePoolAbi, functionName: "getSwapFeePercentage" }) as Promise<bigint>,
        ]);
        if (!poolId || poolId === ZERO_BYTES32) continue;
        let bptIndex = -1;
        try {
          bptIndex = Number(
            (await client.readContract({ address: poolAddr, abi: balancerStablePoolAbi, functionName: "getBptIndex" })) as bigint,
          );
        } catch {
          bptIndex = -1; // non-composable (no BPT in the token list)
        }

        // Registered tokens + balances (INCLUDING the BPT) from the Vault.
        const [tokens, balances] = (await client.readContract({
          address: vault.address,
          abi: balancerVaultAbi,
          functionName: "getPoolTokens",
          args: [poolId],
        })) as readonly [readonly Hex[], readonly bigint[], bigint];

        // Exclude the BPT from the StableMath token set; build the NON-BPT balances/scaling arrays and
        // map tokenIn/tokenOut to their NON-BPT indices. `regPos` records each non-BPT token's FULL registered
        // position (the getScalingFactors index the on-chain QL solver inline-reads for its live scaling factor).
        const tks: Hex[] = [];
        const bals: bigint[] = [];
        const scals: bigint[] = [];
        const regPos: number[] = [];
        for (let k = 0; k < tokens.length; k++) {
          if (k === bptIndex) continue;
          tks.push(tokens[k]);
          bals.push(balances[k]);
          // scalingFactors is aligned with the FULL registered token list (incl. BPT), so index it by k.
          scals.push(scalingRaw[k] ?? WAD_BAL);
          regPos.push(k);
        }
        const i = tks.findIndex((t) => t.toLowerCase() === inLower);
        const j = tks.findIndex((t) => t.toLowerCase() === outLower);
        if (i < 0 || j < 0) continue; // pool does not hold BOTH non-BPT tokens
        // Every non-BPT balance must be live: a zero balance divides-by-zero in the StableMath invariant, and
        // for n=3 a zero THIRD balance would ship n=3 to the oracle (crash) while the solver reads u2=0 as n=2.
        if (bals.some((b) => b <= 0n)) continue;
        // SCOPE: the on-chain QL solver's inlined StableMath (ecoswap.sauce.ts `stableOutV2`) + the 10-column
        // qlv descriptor (poolId + ONE third-token address + packed registered positions + n) cover 2- and
        // 3-NON-BPT-token pools (the small-n inlined form, spike-verified wei-exact vs the real Vault on both
        // engines). A pool with >3 non-BPT tokens is EXCLUDED (documented follow-up — it needs an n>3 inlined
        // form + a wider descriptor); ComposableStable pools are overwhelmingly 2- or 3-asset, so this covers
        // the deep production universe.
        if (tks.length > 3) continue;

        pools.push({
          poolType: SwapPoolType.BalancerV2,
          address: poolAddr,
          i,
          j,
          amp: ampRaw[0],
          balances: bals,
          scalingFactors: scals,
          swapFeeWad: feeRaw,
          source: `${vault.label} (Balancer ComposableStable)`,
          poolId,
          tokens: tks,
          regPos,
          vault: vault.address,
        });
      } catch {
        // Pool / Vault read failed (not a stable pool, paused, or unregistered) — skip.
      }
    }
  }
  return pools;
}

// ── DODO V2 discovery ───────────────────────────────────────

async function discoverDODOPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  zoos: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (zoos.length === 0) return [];

  const pools: PoolInfo[] = [];
  for (const zoo of zoos) {
    // DODO is base/quote-ORIENTED: query BOTH orderings and de-dupe. getDODOPool returns [] for a
    // pair it does not register (a clean "no pool"); a REVERT means the getter/ABI is wrong or the
    // factory is absent — surfaced as a warning below rather than silently swallowed as "no pools".
    let reverts = 0;
    for (const [base, quote] of [[tokenIn, tokenOut], [tokenOut, tokenIn]] as [Hex, Hex][]) {
      let addresses: string[];
      try {
        addresses = (await client.readContract({
          address: zoo.address,
          abi: dodoFactoryAbi,
          functionName: "getDODOPool",
          args: [base, quote],
        })) as string[];
      } catch {
        reverts++;
        continue;
      }

      for (const addr of addresses) {
        if (!addr || addr === ZERO_ADDRESS) continue;

        try {
          const [baseReserve, quoteReserve] = await Promise.all([
            client.readContract({ address: addr as Hex, abi: dodoPoolAbi, functionName: "_BASE_RESERVE_" }) as Promise<bigint>,
            client.readContract({ address: addr as Hex, abi: dodoPoolAbi, functionName: "_QUOTE_RESERVE_" }) as Promise<bigint>,
          ]);

          if (baseReserve === 0n || quoteReserve === 0n) continue;

          const syntheticLiquidity = sqrt(baseReserve * quoteReserve);
          const Q96 = 1n << 96n;
          const syntheticSqrtPrice = baseReserve > 0n
            ? (sqrt(quoteReserve * Q96 * Q96) * Q96) / sqrt(baseReserve * Q96 * Q96)
            : 1n;

          pools.push({
            address: addr as Hex,
            tokenIn,
            tokenOut,
            fee: 0, // DODO uses dynamic fees
            poolType: SwapPoolType.DODOV2,
            priceLimited: false,
            sqrtPriceX96: syntheticSqrtPrice > 0n ? syntheticSqrtPrice : 1n,
            liquidity: syntheticLiquidity,
            source: zoo.label,
          });
        } catch {
          // Pool state read failed
        }
      }
    }
    // Both orderings reverted (never a clean []): the getter is wrong or the factory has no code.
    // Loud (not silent) so a wrong-getter regression can't masquerade as "pair has no pool".
    if (reverts === 2) {
      console.warn(
        `[dodo] getDODOPool reverted on both orderings for ${zoo.label} @ ${zoo.address} ` +
          `(pair ${tokenIn}/${tokenOut}) — factory absent or ABI mismatch; no pools discovered.`,
      );
    }
  }

  // Deduplicate by address (both orderings may return the same pool)
  const seen = new Set<string>();
  return pools.filter((p) => {
    const key = p.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
export async function discoverDodoV2PoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  zoos: FactoryConfig[],
  caller: Hex = ZERO_ADDRESS,
): Promise<DodoPool[]> {
  if (zoos.length === 0) return [];

  const pools: DodoPool[] = [];
  const seen = new Set<string>();
  const inLower = tokenIn.toLowerCase();

  for (const zoo of zoos) {
    // DODO is base/quote-oriented — query BOTH orderings via getDODOPool (the real DVMFactory getter,
    // verified on-chain: returns a flat address[] of machines; the V1 Zoo `getDODO` reverts on it).
    // The pool's own _BASE_TOKEN_() is the authoritative orientation (sellBase = tokenIn is the base).
    // getDODOPool returns [] for an unregistered pair (clean "no pool"); a REVERT on BOTH orderings
    // means the getter/ABI is wrong or the factory is absent — surfaced (not silently swallowed).
    let reverts = 0;
    for (const [base, quote] of [
      [tokenIn, tokenOut],
      [tokenOut, tokenIn],
    ] as [Hex, Hex][]) {
      let addresses: string[];
      try {
        addresses = (await client.readContract({
          address: zoo.address,
          abi: dodoFactoryAbi,
          functionName: "getDODOPool",
          args: [base, quote],
        })) as string[];
      } catch {
        reverts++;
        continue;
      }

      for (const addr of addresses) {
        if (!addr || addr === ZERO_ADDRESS) continue;
        const key = addr.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        try {
          const pool = addr as Hex;
          const [stateRaw, baseTokenRaw, quoteTokenRaw, lpFeeRaw, mtModelRaw] = await Promise.all([
            client.readContract({
              address: pool,
              abi: dodoPmmAbi,
              functionName: "getPMMStateForCall",
            }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint]>,
            client.readContract({ address: pool, abi: dodoPmmAbi, functionName: "_BASE_TOKEN_" }) as Promise<Hex>,
            client.readContract({ address: pool, abi: dodoPmmAbi, functionName: "_QUOTE_TOKEN_" }) as Promise<Hex>,
            client
              .readContract({ address: pool, abi: dodoPmmAbi, functionName: "_LP_FEE_RATE_" })
              .catch(() => 0n) as Promise<bigint>,
            client
              .readContract({ address: pool, abi: dodoPmmAbi, functionName: "_MT_FEE_RATE_MODEL_" })
              .catch(() => ZERO_ADDRESS as Hex) as Promise<Hex>,
          ]);

          const [i, K, B, Q, B0, Q0, Rraw] = stateRaw;
          // i is the guide price; a zero guide price / empty curve cannot trade.
          if (i <= 0n) continue;

          // Resolve the MT (maintainer) fee for the caller from the fee-rate model (a flat-rate
          // model ignores the trader; getFeeRate is the canonical per-trader reader).
          let mtFeeRate = 0n;
          if (mtModelRaw && mtModelRaw !== ZERO_ADDRESS) {
            mtFeeRate = (await client
              .readContract({
                address: mtModelRaw,
                abi: dodoMtFeeModelAbi,
                functionName: "getFeeRate",
                args: [caller],
              })
              .catch(async () =>
                client
                  .readContract({ address: mtModelRaw, abi: dodoMtFeeModelAbi, functionName: "_FEE_RATE_" })
                  .catch(() => 0n),
              )) as bigint;
          }

          const baseToken = baseTokenRaw;
          const quoteToken = quoteTokenRaw;
          const sellBase = inLower === baseToken.toLowerCase();
          // tokenIn must be one of the pool's two tokens.
          if (!sellBase && inLower !== quoteToken.toLowerCase()) continue;
          // An empty pool on the side being sold has no depth.
          if (sellBase ? Q <= 0n : B <= 0n) continue;

          const R =
            Number(Rraw) === 1 ? RState.ABOVE_ONE : Number(Rraw) === 2 ? RState.BELOW_ONE : RState.ONE;

          pools.push({
            poolType: SwapPoolType.DODOV2,
            address: pool,
            baseToken,
            quoteToken,
            sellBase,
            i,
            K,
            B,
            Q,
            B0,
            Q0,
            R,
            lpFeeRate: lpFeeRaw,
            mtFeeRate,
            feePpm: dodoFeeToPpm(lpFeeRaw, mtFeeRate),
            source: zoo.label,
          });
        } catch {
          // Pool state read failed (non-PMM surface / partial pool) — skip.
        }
      }
    }
    // Both orderings reverted (never a clean []): the getter is wrong or the factory has no code.
    // Loud (not silent) so a wrong-getter regression can't masquerade as "pair has no pool".
    if (reverts === 2) {
      console.warn(
        `[dodo] getDODOPool reverted on both orderings for ${zoo.label} @ ${zoo.address} ` +
          `(pair ${tokenIn}/${tokenOut}) — factory absent or ABI mismatch; no pools discovered.`,
      );
    }
  }

  return pools;
}

// ── Trader Joe LB discovery ─────────────────────────────────

async function discoverTraderJoeLBPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (factories.length === 0) return [];

  const pools: PoolInfo[] = [];
  for (const factory of factories) {
    // Query each known bin step
    const calls = TRADER_JOE_BIN_STEPS.map((binStep) => ({
      address: factory.address,
      abi: traderJoeLBFactoryAbi,
      functionName: "getLBPairInformation" as const,
      args: [tokenIn, tokenOut, BigInt(binStep)] as const,
      binStep,
    }));

    const results = await client.multicall({
      contracts: calls.map((c) => ({
        address: c.address,
        abi: c.abi,
        functionName: c.functionName,
        args: c.args,
      })),
      allowFailure: true,
    });

    const validPairs: { address: Hex; binStep: number }[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status !== "success") continue;
      const [, pairAddr, , ignoredForRouting] = result.result as [bigint, string, boolean, boolean];
      if (pairAddr && pairAddr !== ZERO_ADDRESS && !ignoredForRouting) {
        validPairs.push({ address: pairAddr as Hex, binStep: calls[i].binStep });
      }
    }

    if (validPairs.length === 0) continue;

    // Read reserves and token0 for each pair
    const [reserveResults, tokenXResults] = await Promise.all([
      client.multicall({
        contracts: validPairs.map((p) => ({
          address: p.address,
          abi: traderJoeLBPairAbi,
          functionName: "getReserves" as const,
        })),
        allowFailure: true,
      }),
      client.multicall({
        contracts: validPairs.map((p) => ({
          address: p.address,
          abi: traderJoeLBPairAbi,
          functionName: "getTokenX" as const,
        })),
        allowFailure: true,
      }),
    ]);

    for (let i = 0; i < validPairs.length; i++) {
      const res = reserveResults[i];
      const txRes = tokenXResults[i];
      if (res.status !== "success" || txRes.status !== "success") continue;

      const [reserveX, reserveY] = res.result as [bigint, bigint];
      if (reserveX === 0n || reserveY === 0n) continue;

      const tokenX = (txRes.result as string).toLowerCase();
      const isTokenXIn = tokenIn.toLowerCase() === tokenX;
      const reserveIn = isTokenXIn ? reserveX : reserveY;
      const reserveOut = isTokenXIn ? reserveY : reserveX;

      const syntheticLiquidity = sqrt(reserveIn * reserveOut);
      const Q96 = 1n << 96n;
      const syntheticSqrtPrice = reserveIn > 0n
        ? (sqrt(reserveOut * Q96 * Q96) * Q96) / sqrt(reserveIn * Q96 * Q96)
        : 1n;

      pools.push({
        address: validPairs[i].address,
        tokenIn,
        tokenOut,
        fee: validPairs[i].binStep * 10, // bin step → approx fee in bps
        poolType: SwapPoolType.TraderJoeLB,
        priceLimited: false,
        sqrtPriceX96: syntheticSqrtPrice > 0n ? syntheticSqrtPrice : 1n,
        liquidity: syntheticLiquidity,
        source: `${factory.label} (bin ${validPairs[i].binStep})`,
      });
    }
  }

  return pools;
}

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
export async function discoverTraderJoeLBPoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<LbPool[]> {
  if (factories.length === 0) return [];

  const pools: LbPool[] = [];
  const inLower = tokenIn.toLowerCase();
  for (const factory of factories) {
    // Find the pair for each known bin step (both token orderings resolve the same pair —
    // getLBPairInformation is order-independent on (tokenX, tokenY) within a binStep).
    const infoCalls = TRADER_JOE_BIN_STEPS.map((binStep) => ({
      address: factory.address,
      abi: traderJoeLBFactoryAbi,
      functionName: "getLBPairInformation" as const,
      args: [tokenIn, tokenOut, BigInt(binStep)] as const,
    }));
    let infos;
    try {
      infos = await client.multicall({ contracts: infoCalls, allowFailure: true });
    } catch {
      continue;
    }

    const validPairs: { address: Hex; binStep: number }[] = [];
    for (let i = 0; i < infos.length; i++) {
      const r = infos[i];
      if (r.status !== "success") continue;
      const [, pairAddr, , ignoredForRouting] = r.result as [bigint, string, boolean, boolean];
      if (pairAddr && pairAddr !== ZERO_ADDRESS && !ignoredForRouting) {
        validPairs.push({ address: pairAddr as Hex, binStep: TRADER_JOE_BIN_STEPS[i] });
      }
    }
    if (validPairs.length === 0) continue;

    for (const vp of validPairs) {
      try {
        // Pair-level state: tokenX (direction), active id, bin step, base-fee factor.
        const [tokenXRaw, activeIdRaw, binStepRaw, feeParamsRaw] = await Promise.all([
          client.readContract({ address: vp.address, abi: traderJoeLBPairAbi, functionName: "getTokenX" }) as Promise<string>,
          client.readContract({ address: vp.address, abi: traderJoeLBPairAbi, functionName: "getActiveId" }) as Promise<number>,
          client.readContract({ address: vp.address, abi: traderJoeLBPairAbi, functionName: "getBinStep" }) as Promise<number>,
          client
            .readContract({ address: vp.address, abi: traderJoeLBPairAbi, functionName: "getStaticFeeParameters" })
            .catch(() => null) as Promise<readonly [number, number, number, number, number, number, number] | null>,
        ]);

        const tokenX = tokenXRaw.toLowerCase();
        const swapForY = inLower === tokenX;
        const activeId = Number(activeIdRaw);
        const binStep = Number(binStepRaw) || vp.binStep;
        const baseFactor = feeParamsRaw ? Number(feeParamsRaw[0]) : TRADER_JOE_DEFAULT_BASE_FACTOR;

        // Read bins over the window on BOTH sides of the active id (one getBin per id).
        // Only bins in the swap direction are ever consumed, but reading both sides lets a
        // re-orientation reuse the descriptor; empty bins are dropped below.
        const lo = activeId - TRADER_JOE_BIN_WINDOW;
        const hi = activeId + TRADER_JOE_BIN_WINDOW;
        const ids: number[] = [];
        for (let id = lo; id <= hi; id++) if (id >= 0) ids.push(id);

        const binResults = await client.multicall({
          contracts: ids.map((id) => ({
            address: vp.address,
            abi: traderJoeLBPairAbi,
            functionName: "getBin" as const,
            args: [id] as const,
          })),
          allowFailure: true,
        });

        const bins: { id: number; reserveX: bigint; reserveY: bigint }[] = [];
        for (let i = 0; i < ids.length; i++) {
          const r = binResults[i];
          if (r.status !== "success") continue;
          const [reserveX, reserveY] = r.result as [bigint, bigint];
          if (reserveX === 0n && reserveY === 0n) continue; // uninitialized / empty bin
          bins.push({ id: ids[i], reserveX, reserveY });
        }
        if (bins.length === 0) continue;

        pools.push({
          poolType: SwapPoolType.TraderJoeLB,
          address: vp.address,
          binStep,
          baseFactor,
          activeId,
          swapForY,
          bins,
          source: `${factory.label} (bin ${binStep})`,
        });
      } catch {
        // Pair read failed (non-LB-v2.1 surface) — skip.
      }
    }
  }

  return pools;
}

// ── Maverick V2 discovery ───────────────────────────────────

// Maverick factory lookup(tokenA,tokenB,startIndex,endIndex) enumeration bounds. The old code fetched a
// single [0,10) page, silently truncating pairs with >10 Maverick pools. Paginate in bounded pages up to a
// hard cap so deep pairs are fully enumerated while the walk stays bounded.
const MAVERICK_LOOKUP_PAGE = Number(process.env.ECO_MAVERICK_LOOKUP_PAGE ?? 50);
const MAVERICK_LOOKUP_MAX = Number(process.env.ECO_MAVERICK_LOOKUP_MAX ?? 100);

async function discoverMaverickV2Pools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (factories.length === 0) return [];

  const pools: PoolInfo[] = [];
  for (const factory of factories) {
    // Try both token orderings — Maverick's lookup is order-dependent
    for (const [tokenA, tokenB] of [[tokenIn, tokenOut], [tokenOut, tokenIn]] as [Hex, Hex][]) {
      try {
        // Paginate lookup(startIndex,endIndex) so pairs with >10 Maverick pools are not truncated.
        // Bounded: page of MAVERICK_LOOKUP_PAGE, stop early on a short page, hard-cap at MAVERICK_LOOKUP_MAX.
        const addresses: string[] = [];
        for (let start = 0; start < MAVERICK_LOOKUP_MAX; start += MAVERICK_LOOKUP_PAGE) {
          const end = Math.min(start + MAVERICK_LOOKUP_PAGE, MAVERICK_LOOKUP_MAX);
          const page = await client.readContract({
            address: factory.address,
            abi: maverickFactoryAbi,
            functionName: "lookup",
            args: [tokenA, tokenB, BigInt(start), BigInt(end)],
          }) as string[];
          addresses.push(...page);
          if (page.length < end - start) break; // short page → no more pools
        }

        for (const addr of addresses) {
          if (!addr || addr === ZERO_ADDRESS) continue;

          try {
            const state = await client.readContract({
              address: addr as Hex,
              abi: maverickPoolAbi,
              functionName: "getState",
            }) as [number, number, bigint, bigint, bigint];

            const totalLiquidity = state[4];
            if (totalLiquidity === 0n) continue;

            pools.push({
              address: addr as Hex,
              tokenIn,
              tokenOut,
              fee: 0, // Maverick uses dynamic fees
              poolType: SwapPoolType.MaverickV2,
              priceLimited: false,
              sqrtPriceX96: 1n, // No meaningful sqrt price for Maverick
              liquidity: totalLiquidity,
              source: factory.label,
            });
          } catch {
            // Pool state read failed
          }
        }
      } catch {
        // Factory lookup failed
      }
    }
  }

  // Deduplicate by address
  const seen = new Set<string>();
  return pools.filter((p) => {
    const key = p.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── WOOFi discovery ─────────────────────────────────────────

async function discoverWOOFiPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  woofiConfigs: FactoryConfig[],
): Promise<PoolInfo[]> {
  if (woofiConfigs.length === 0) return [];

  const pools: PoolInfo[] = [];
  for (const config of woofiConfigs) {
    try {
      // Verify the pool supports this pair by querying a small amount
      const testAmount = 10n ** 18n; // 1 token (approximate)
      const toAmount = await client.readContract({
        address: config.address,
        abi: woofiAbi,
        functionName: "query",
        args: [tokenIn, tokenOut, testAmount],
      }) as bigint;

      if (toAmount === 0n) continue;

      // Use the query result to derive synthetic liquidity
      // liquidity ≈ toAmount * testAmount (order of magnitude)
      const syntheticLiquidity = sqrt(testAmount * toAmount);

      pools.push({
        address: config.address,
        tokenIn,
        tokenOut,
        fee: 25, // WOOFi typical fee ~0.025% = 25 bps
        poolType: SwapPoolType.WOOFi,
        priceLimited: false,
        sqrtPriceX96: 1n, // No meaningful sqrt price
        liquidity: syntheticLiquidity,
        source: config.label,
      });
    } catch {
      // Pool doesn't support this pair
    }
  }

  return pools;
}

/** Round a WooPPV2 feeRate (1e5-scaled, e.g. 25 = 0.025%) to a ppm fee (the price-ordering coordinate). */
function wooFiFeeToPpm(feeRate: bigint): number {
  return Number((feeRate * 1_000_000n + WOO_FEE_SCALE / 2n) / WOO_FEE_SCALE);
}

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
export async function discoverWooFiPoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  woofiConfigs: FactoryConfig[],
): Promise<WooFiPool[]> {
  if (woofiConfigs.length === 0) return [];
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();

  const out: WooFiPool[] = [];
  const seen = new Set<string>();
  for (const cfg of woofiConfigs) {
    const key = cfg.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const [quoteToken, wooracle] = await Promise.all([
        client.readContract({ address: cfg.address, abi: wooPPV2Abi, functionName: "quoteToken" }) as Promise<Hex>,
        client.readContract({ address: cfg.address, abi: wooPPV2Abi, functionName: "wooracle" }) as Promise<Hex>,
      ]);
      if (!quoteToken || quoteToken === ZERO_ADDRESS) continue;
      const quoteLower = quoteToken.toLowerCase();

      // Exactly one side must be the quote (a base→base pair is two legs — out of scope).
      const inIsQuote = inLower === quoteLower;
      const outIsQuote = outLower === quoteLower;
      if (inIsQuote === outIsQuote) continue; // both-quote (impossible) or neither-quote (base→base)
      const sellBase = !inIsQuote; // tokenIn is the base ⇒ base→quote
      const base = sellBase ? tokenIn : tokenOut;

      // SNAPSHOT oracle state + the price scale for the base.
      const [state, priceDecRaw, feeInfo, decInRaw, decOutRaw, testOut] = await Promise.all([
        client.readContract({ address: wooracle, abi: wooracleV2Abi, functionName: "state", args: [base] }) as Promise<readonly [bigint, bigint, bigint, boolean]>,
        client.readContract({ address: wooracle, abi: wooracleV2Abi, functionName: "decimals", args: [base] }).then((d) => Number(d)).catch(() => 8),
        client.readContract({ address: cfg.address, abi: wooPPV2Abi, functionName: "tokenInfos", args: [base] }).catch(() => null) as Promise<readonly [bigint, bigint, bigint, bigint] | null>,
        client.readContract({ address: tokenIn, abi: erc20DecimalsAbi, functionName: "decimals" }).then((d) => Number(d)).catch(() => 18),
        client.readContract({ address: tokenOut, abi: erc20DecimalsAbi, functionName: "decimals" }).then((d) => Number(d)).catch(() => 18),
        client.readContract({ address: cfg.address, abi: wooPPV2Abi, functionName: "query", args: [tokenIn, tokenOut, 10n ** BigInt(6)] }).catch(() => 0n) as Promise<bigint>,
      ]);
      const [price, spread, coeff, woFeasible] = state;
      if (!woFeasible || price <= 0n) continue; // oracle not feasible — the pool would revert
      if (testOut === 0n) continue; // pair not supported / no reserve to pay out

      // tokenInfos.feeRate is a uint16, which viem decodes as a JS `number` (not bigint) — coerce to bigint
      // so the downstream WooFiPool.feeRate (bigint) + wooFiFeeToPpm(bigint) arithmetic never mixes types.
      const feeRate = feeInfo ? BigInt(feeInfo[1]) : 0n;
      // maxGamma / maxNotionalSwap (uint128) — WooPPV2's shared _calc* view path require()s bound BOTH
      // the swap and the query staticcall; buildWooFiSegments truncates the sampled ladder at them so the
      // exec never awards a share the on-chain query() would revert on. 0n ⇒ unknown/uncapped.
      const maxGamma = feeInfo ? BigInt(feeInfo[2]) : 0n;
      const maxNotionalSwap = feeInfo ? BigInt(feeInfo[3]) : 0n;
      const priceDec = 10n ** BigInt(priceDecRaw);
      const baseDec = 10n ** BigInt(sellBase ? decInRaw : decOutRaw);
      const quoteDec = 10n ** BigInt(sellBase ? decOutRaw : decInRaw);
      out.push({
        address: cfg.address,
        tokenIn,
        tokenOut,
        sellBase,
        price,
        spread,
        coeff,
        priceDec,
        quoteDec,
        baseDec,
        feeRate,
        maxNotionalSwap,
        maxGamma,
        feePpm: wooFiFeeToPpm(feeRate),
        source: `${cfg.label} (WooFi sPMM)`,
      });
    } catch {
      // Pool / oracle read failed (unsupported token, paused, or not a WooPPV2) — skip.
    }
  }
  return out;
}

// ── Fermi / propAMM discovery ────────────────────────────────

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
export async function discoverFermiPoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  fermiConfigs: FactoryConfig[],
  amountIn: bigint,
): Promise<FermiPool[]> {
  if (fermiConfigs.length === 0 || amountIn <= 0n) return [];

  const sampleIn = fermiSampleInputs(amountIn);
  if (sampleIn.length === 0) return [];

  const out: FermiPool[] = [];
  const seen = new Set<string>();
  for (const cfg of fermiConfigs) {
    const key = cfg.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      // Aliveness — the router reports whether the pair is tradeable (either orientation).
      const active = (await client
        .readContract({ address: cfg.address, abi: fermiPoolAbi, functionName: "isActive", args: [tokenIn, tokenOut] })
        .catch(() => false)) as boolean;
      const activeRev = active
        ? true
        : ((await client
            .readContract({ address: cfg.address, abi: fermiPoolAbi, functionName: "isActive", args: [tokenOut, tokenIn] })
            .catch(() => false)) as boolean);
      if (!activeRev) continue;

      // Sample the LIVE quote ladder: quoteAmounts(tokenIn, tokenOut, +cumIn)[1] is the exact-in out.
      const quotes = await Promise.all(
        sampleIn.map((amt) =>
          client
            .readContract({
              address: cfg.address,
              abi: fermiPoolAbi,
              functionName: "quoteAmounts",
              args: [tokenIn, tokenOut, amt],
            })
            .then((r) => (r as [bigint, bigint])[1])
            .catch(() => 0n),
        ),
      );

      // Keep only the strictly-positive, non-decreasing prefix of the ladder (a zero/failed quote = past the
      // tradeable range; a non-increasing out = degenerate).
      const cumIn: bigint[] = [];
      const cumOut: bigint[] = [];
      let prevOut = 0n;
      for (let i = 0; i < sampleIn.length; i++) {
        const o = quotes[i];
        if (o <= prevOut) break;
        cumIn.push(sampleIn[i]);
        cumOut.push(o);
        prevOut = o;
      }
      if (cumOut.length === 0 || cumOut[0] <= 0n) continue; // pair not tradeable / no out

      // Derive an effective fee (ppm) from the shallowest slice for price-ordering / diagnostics: the
      // near-par spot ratio's shortfall vs 1:1 is dominated by the fee (the router folds the fee into the
      // quote — there is no feePpm() getter). Best-effort; 0 when the ladder is too thin/coarse to infer.
      let feePpm = 0;
      const in0 = cumIn[0];
      const out0 = cumOut[0];
      if (in0 > 0n && out0 > 0n && out0 < in0) {
        const shortfall = ((in0 - out0) * FERMI_FEE_SCALE) / in0;
        if (shortfall > 0n && shortfall < FERMI_FEE_SCALE) feePpm = Number(shortfall);
      }

      out.push({
        address: cfg.address,
        tokenIn,
        tokenOut,
        cumIn,
        cumOut,
        feePpm,
        source: `${cfg.label} (Fermi propAMM)`,
      });
    } catch {
      // Router read failed (not a FermiSwapper, paused, or unsupported pair) — skip.
    }
  }
  return out;
}

// ── Fluid DEX discovery ──────────────────────────────────────

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
export async function discoverFluidPoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  fluidConfigs: FactoryConfig[],
  amountIn: bigint,
): Promise<(FluidVenue & { headOI: bigint })[]> {
  if (fluidConfigs.length === 0 || amountIn <= 0n) return [];

  // The FIRST QL slice size — the on-chain ladder's seed (curve-math QL_SEED_DIV), so the probe's head is
  // exactly the head the solver's first slice will carry when the state has not moved.
  let probeIn = amountIn / QL_SEED_DIV;
  if (probeIn <= 0n) probeIn = 1n;

  const out: (FluidVenue & { headOI: bigint })[] = [];
  const seen = new Set<string>();
  for (const cfg of fluidConfigs) {
    const resolver = cfg.fluidResolver;
    if (!resolver) continue;
    for (const pool of cfg.fluidPools ?? []) {
      const key = pool.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        // Orient the pair: token0/token1 fix swap0to1 (true ⇒ tokenIn is token0). Read via the resolver's
        // getDexTokens (the pool has NO token0()/token1() getters). Skip a pool that does not trade EXACTLY
        // this pair.
        const [t0, t1] = (await client
          .readContract({ address: resolver, abi: fluidResolverAbi, functionName: "getDexTokens", args: [pool] })
          .catch(() => [ZERO_ADDRESS, ZERO_ADDRESS])) as [Hex, Hex];
        const inIs0 = t0.toLowerCase() === tokenIn.toLowerCase() && t1.toLowerCase() === tokenOut.toLowerCase();
        const inIs1 = t1.toLowerCase() === tokenIn.toLowerCase() && t0.toLowerCase() === tokenOut.toLowerCase();
        if (!inIs0 && !inIs1) continue;
        const swap0to1 = inIs0; // tokenIn is token0 ⇒ swap0→1

        // ONE liveness probe via the resolver's estimateSwapIn (amountOutMin 0 ⇒ pure quote). 0 ⇒ the pair
        // is not tradeable at this size (paused / capped-out / dead) — drop.
        const probeOut = (await client
          .readContract({
            address: resolver,
            abi: fluidResolverAbi,
            functionName: "estimateSwapIn",
            args: [pool, swap0to1, probeIn, 0n],
          })
          .then((r) => r as bigint)
          .catch(() => 0n)) as bigint;
        if (probeOut <= 0n) continue;

        // The fold head: the first-slice post-fee out/in sqrt — identical to the on-chain ladder's first
        // head (qlSliceHead(sliceOut, capacity)) at an unchanged state.
        const headOI = qlSliceHead(probeOut, probeIn);

        // Derive an effective fee (ppm) from the probe for price-ordering / diagnostics: the near-par spot
        // ratio's shortfall vs 1:1 is dominated by the fee (the pool folds the fee into the resolver quote
        // — there is no fee getter on the path). Best-effort; 0 when the size is too coarse to infer.
        let feePpm = 0;
        if (probeOut < probeIn) {
          const shortfall = ((probeIn - probeOut) * FLUID_FEE_SCALE) / probeIn;
          if (shortfall > 0n && shortfall < FLUID_FEE_SCALE) feePpm = Number(shortfall);
        }

        out.push({
          address: pool,
          resolver,
          swap0to1,
          tokenIn,
          tokenOut,
          feePpm,
          source: `${cfg.label} (Fluid DEX)`,
          headOI,
        });
      } catch {
        // Pool/resolver read failed (not a FluidDexT1, paused, or unsupported pair) — skip.
      }
    }
  }
  return out;
}

// ── Tessera V discovery ──────────────────────────────────────

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
export async function discoverTesseraPoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  tesseraConfigs: FactoryConfig[],
  amountIn: bigint,
): Promise<(TesseraVenue & { headOI: bigint })[]> {
  if (tesseraConfigs.length === 0 || amountIn <= 0n) return [];

  // The FIRST QL slice size — the on-chain ladder's seed (curve-math QL_SEED_DIV), so the probe's head
  // is exactly the head the solver's first slice will carry when the state has not moved.
  let probeIn = amountIn / QL_SEED_DIV;
  if (probeIn <= 0n) probeIn = 1n;

  const out: (TesseraVenue & { headOI: bigint })[] = [];
  const seen = new Set<string>();
  for (const cfg of tesseraConfigs) {
    const key = cfg.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      // ONE liveness probe: the signed-amount quote for the pair (positive = exact-in). The view
      // REVERTS on an unsupported pair ("T33") — caught ⇒ 0 ⇒ drop; an oversized/unfillable ask
      // returns (in, 0) gracefully ⇒ also drop.
      const probeOut = (await client
        .readContract({
          address: cfg.address,
          abi: tesseraSwapAbi,
          functionName: "tesseraSwapViewAmounts",
          args: [tokenIn, tokenOut, probeIn],
        })
        .then((r) => (r as readonly [bigint, bigint])[1])
        .catch(() => 0n)) as bigint;
      if (probeOut <= 0n) continue;

      // The fold head: the first-slice post-fee out/in sqrt — identical to the on-chain ladder's first
      // head (qlSliceHead(sliceOut, capacity)) at an unchanged state.
      const headOI = qlSliceHead(probeOut, probeIn);

      // Derive an effective fee (ppm) from the probe for price-ordering / diagnostics: the near-par
      // spot ratio's shortfall vs 1:1 is dominated by the fee (the engine folds everything into the
      // quote — there is no fee getter). Best-effort; 0 when the pair is not near-par (e.g. WETH/USDC).
      let feePpm = 0;
      if (probeOut < probeIn) {
        const shortfall = ((probeIn - probeOut) * TESSERA_FEE_SCALE) / probeIn;
        if (shortfall > 0n && shortfall < TESSERA_FEE_SCALE) feePpm = Number(shortfall);
      }

      out.push({
        address: cfg.address,
        tokenIn,
        tokenOut,
        feePpm,
        source: `${cfg.label} (Tessera V)`,
        headOI,
      });
    } catch {
      // Wrapper read failed (not a TesseraSwap, paused, or unsupported pair) — skip.
    }
  }
  return out;
}

// ── ElfomoFi discovery ───────────────────────────────────────

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
export async function discoverElfomoPoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  elfomoConfigs: FactoryConfig[],
  amountIn: bigint,
): Promise<(ElfomoVenue & { headOI: bigint })[]> {
  if (elfomoConfigs.length === 0 || amountIn <= 0n) return [];

  let probeIn = amountIn / QL_SEED_DIV;
  if (probeIn <= 0n) probeIn = 1n;

  const inLc = tokenIn.toLowerCase();
  const outLc = tokenOut.toLowerCase();
  const out: (ElfomoVenue & { headOI: bigint })[] = [];
  const seen = new Set<string>();
  for (const cfg of elfomoConfigs) {
    const key = cfg.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      // Pair enumeration — the natural discovery surface. A pair entry supports BOTH directions, so
      // match the unordered set {tokenA, tokenB} == {tokenIn, tokenOut}.
      const pairs = (await client
        .readContract({ address: cfg.address, abi: elfomoFiAbi, functionName: "getSupportedPairs" })
        .catch(() => [])) as readonly { tokenA: Hex; tokenB: Hex }[];
      const listed = pairs.some((p) => {
        const a = p.tokenA.toLowerCase();
        const b = p.tokenB.toLowerCase();
        return (a === inLc && b === outLc) || (a === outLc && b === inLc);
      });
      if (!listed) continue;

      // ONE liveness probe — GRACEFUL: 0 ⇒ not tradeable at this size (stale feed / paused) — drop.
      const probeOut = (await client
        .readContract({
          address: cfg.address,
          abi: elfomoFiAbi,
          functionName: "getAmountOut",
          args: [tokenIn, tokenOut, probeIn],
        })
        .then((r) => r as bigint)
        .catch(() => 0n)) as bigint;
      if (probeOut <= 0n) continue;

      const headOI = qlSliceHead(probeOut, probeIn);

      // Derived diagnostic feePpm (near-par pairs only — the pricing module folds everything in).
      let feePpm = 0;
      if (probeOut < probeIn) {
        const shortfall = ((probeIn - probeOut) * ELFOMO_FEE_SCALE) / probeIn;
        if (shortfall > 0n && shortfall < ELFOMO_FEE_SCALE) feePpm = Number(shortfall);
      }

      out.push({
        address: cfg.address,
        tokenIn,
        tokenOut,
        feePpm,
        source: `${cfg.label} (ElfomoFi)`,
        headOI,
      });
    } catch {
      // Wrapper read failed (not an ElfomoFi, paused, or unsupported pair) — skip.
    }
  }
  return out;
}

// ── METRIC discovery ─────────────────────────────────────────

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
export async function discoverMetricPoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  metricConfigs: FactoryConfig[],
  amountIn: bigint,
): Promise<(MetricVenue & { headOI: bigint })[]> {
  if (metricConfigs.length === 0 || amountIn <= 0n) return [];

  // The FIRST QL slice size — the on-chain ladder's seed (curve-math QL_SEED_DIV), so the probe's head
  // is exactly the head the solver's first slice will carry when the state has not moved. Clamped at
  // the int128 encode bound (quoteSwap amountSpecified is int128).
  let probeIn = amountIn / QL_SEED_DIV;
  if (probeIn <= 0n) probeIn = 1n;
  if (probeIn > METRIC_INT128_MAX) probeIn = METRIC_INT128_MAX;

  const inLc = tokenIn.toLowerCase();
  const outLc = tokenOut.toLowerCase();
  const out: (MetricVenue & { headOI: bigint })[] = [];
  const seen = new Set<string>();
  for (const cfg of metricConfigs) {
    const router = cfg.metricRouter;
    if (!router) continue;
    for (const pool of cfg.metricPools ?? []) {
      const key = pool.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        // 1. Orient the pair + resolve the provider from the pool's own immutables.
        const imm = (await client
          .readContract({ address: pool, abi: metricPoolAbi, functionName: "getImmutables" })
          .catch(() => null)) as readonly [Hex, Hex, Hex, Hex] | null;
        if (!imm) continue;
        const [, provider, t0, t1] = imm;
        const inIs0 = t0.toLowerCase() === inLc && t1.toLowerCase() === outLc;
        const inIs1 = t1.toLowerCase() === inLc && t0.toLowerCase() === outLc;
        if (!inIs0 && !inIs1) continue;
        const xToY = inIs0;

        // 2. The maker anchor — PROBE-THEN-DECODE (staleness-revert class). A quiet maker drops here.
        const anchor = (await client
          .readContract({ address: provider, abi: metricProviderAbi, functionName: "getBidAndAskPrice" })
          .catch(() => null)) as readonly [bigint, bigint] | null;
        if (!anchor) continue;
        const [bid, ask] = anchor;
        if (bid <= 0n || ask < bid) continue;

        // 3. ONE liveness quote at the first QL slice size, DIRECTIONAL limit; |negative out-delta| > 0.
        const limit = xToY ? 0n : METRIC_LIMIT_MAX_U128;
        const deltas = (await client
          .readContract({
            address: router,
            abi: metricRouterAbi,
            functionName: "quoteSwap",
            args: [pool, xToY, probeIn, limit, bid, ask],
          })
          .catch(() => null)) as readonly [bigint, bigint] | null;
        if (!deltas) continue;
        const outDelta = xToY ? deltas[1] : deltas[0];
        const inDelta = xToY ? deltas[0] : deltas[1];
        if (outDelta >= 0n || inDelta <= 0n) continue; // empty pool / wrong-side (0,0) / nonsense
        const probeOut = -outDelta;
        // The probe may PARTIAL-FILL (inDelta < probeIn on a thin pool) — head over the CONSUMED input,
        // exactly what the on-chain ladder's first slice sees at an unchanged state.
        const consumed = inDelta < probeIn ? inDelta : probeIn;
        const headOI = qlSliceHead(probeOut, consumed);
        if (headOI <= 0n) continue;

        // Diagnostic feePpm: HALF the relative bid/ask spread (1e6-scaled) — pair-agnostic (the quote
        // folds the spread + any step fee in; there is no fee getter on the path).
        const mid = (bid + ask) / 2n;
        let feePpm = 0;
        if (mid > 0n && ask > bid) {
          const half = ((ask - bid) * METRIC_FEE_SCALE) / (2n * mid);
          if (half > 0n && half < METRIC_FEE_SCALE) feePpm = Number(half);
        }

        out.push({
          address: pool,
          provider,
          router,
          xToY,
          tokenIn,
          tokenOut,
          feePpm,
          source: `${cfg.label} (Metric)`,
          headOI,
        });
      } catch {
        // Pool/provider/router read failed (not a Metric pool, stale maker, or unsupported pair) — skip.
      }
    }
  }
  return out;
}

// ── Mento V2 discovery ───────────────────────────────────────

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
export async function discoverMentoPoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  mentoConfigs: FactoryConfig[],
  amountIn: bigint,
): Promise<MentoPool[]> {
  if (mentoConfigs.length === 0 || amountIn <= 0n) return [];

  const sampleIn = mentoSampleInputs(amountIn);
  if (sampleIn.length === 0) return [];

  const inLc = tokenIn.toLowerCase();
  const outLc = tokenOut.toLowerCase();
  const out: MentoPool[] = [];
  const seen = new Set<string>();
  for (const cfg of mentoConfigs) {
    const broker = cfg.address;
    try {
      // STEP 1 — the registered exchange providers. Use the config hint when present (deterministic /
      // local fixture); otherwise enumerate live (governance-mutable).
      let providers: Hex[];
      if (cfg.mentoExchangeProviders && cfg.mentoExchangeProviders.length > 0) {
        providers = cfg.mentoExchangeProviders;
      } else {
        providers = (await client
          .readContract({ address: broker, abi: mentoBrokerAbi, functionName: "getExchangeProviders" })
          .catch(() => [])) as Hex[];
      }

      for (const provider of providers) {
        // STEP 2 — this provider's exchanges (Exchange { bytes32 exchangeId; address[] assets; }).
        const exchanges = (await client
          .readContract({ address: provider, abi: mentoExchangeProviderAbi, functionName: "getExchanges" })
          .catch(() => [])) as readonly { exchangeId: Hex; assets: readonly Hex[] }[];

        for (const ex of exchanges) {
          const assets = ex.assets ?? [];
          if (assets.length < 2) continue;
          const a0 = assets[0].toLowerCase();
          const a1 = assets[1].toLowerCase();
          // Match {tokenIn,tokenOut} == {assets[0],assets[1]} UNORDERED.
          const matches = (a0 === inLc && a1 === outLc) || (a1 === inLc && a0 === outLc);
          if (!matches) continue;

          const key = `${provider.toLowerCase()}:${ex.exchangeId.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // Sample the LIVE quote ladder: getAmountOut(provider, exchangeId, tokenIn, tokenOut, +cumIn).
          const quotes = await Promise.all(
            sampleIn.map((amt) =>
              client
                .readContract({
                  address: broker,
                  abi: mentoBrokerAbi,
                  functionName: "getAmountOut",
                  args: [provider, ex.exchangeId, tokenIn, tokenOut, amt],
                })
                .then((r) => r as bigint)
                .catch(() => 0n),
            ),
          );

          // Keep only the strictly-positive, non-decreasing prefix of the ladder (a zero/failed quote =
          // past a trading limit; a non-increasing out = degenerate).
          const cumIn: bigint[] = [];
          const cumOut: bigint[] = [];
          let prevOut = 0n;
          for (let i = 0; i < sampleIn.length; i++) {
            const o = quotes[i];
            if (o <= prevOut) break;
            cumIn.push(sampleIn[i]);
            cumOut.push(o);
            prevOut = o;
          }
          if (cumOut.length === 0 || cumOut[0] <= 0n) continue; // pair not tradeable / no out

          // Derive an effective fee/spread (ppm) from the shallowest slice for DIAGNOSTICS ONLY — the real
          // merge price coordinate is `marginalOI`, computed from the ladder dy in buildMentoSegments (shared
          // by prepare + oracle) independent of this field. This is a PAR-PAIR heuristic: it reads the shortfall
          // vs 1:1 (near-par spot ratio's shortfall ≈ the exchange spread, folded into the quote — there is no
          // fee getter on the Broker path). For a non-par pair (oracle center price ≠ ~1:1, e.g. cUSD/cEUR, or
          // differing decimals) out0 may exceed or differ from in0 for reasons other than spread, so feePpm is
          // mis-derived or left 0 — do NOT trust it as an accurate fee for non-par pairs. Best-effort; 0 when
          // the ladder is too thin/coarse or the pair is not ~par.
          let feePpm = 0;
          const in0 = cumIn[0];
          const out0 = cumOut[0];
          if (in0 > 0n && out0 > 0n && out0 < in0) {
            const shortfall = ((in0 - out0) * MENTO_FEE_SCALE) / in0;
            if (shortfall > 0n && shortfall < MENTO_FEE_SCALE) feePpm = Number(shortfall);
          }

          out.push({
            broker,
            exchangeProvider: provider,
            exchangeId: ex.exchangeId,
            tokenIn,
            tokenOut,
            cumIn,
            cumOut,
            feePpm,
            source: `${cfg.label} (Mento V2)`,
          });
        }
      }
    } catch {
      // Broker/provider read failed (not a Mento Broker, or unsupported pair) — skip.
    }
  }
  return out;
}

// ── Balancer V3 discovery ────────────────────────────────────

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
export async function discoverBalancerV3PoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  balancerV3Configs: FactoryConfig[],
  amountIn: bigint,
): Promise<BalancerV3Pool[]> {
  if (balancerV3Configs.length === 0 || amountIn <= 0n) return [];

  const sampleIn = balancerV3SampleInputs(amountIn);
  if (sampleIn.length === 0) return [];

  const inLc = tokenIn.toLowerCase();
  const outLc = tokenOut.toLowerCase();
  const out: BalancerV3Pool[] = [];
  const seen = new Set<string>();
  for (const cfg of balancerV3Configs) {
    const vault = cfg.address;
    const router = cfg.balancerV3Router;
    if (!router) continue; // a BalancerV3 entry MUST carry the per-chain Router.
    for (const pool of cfg.balancerV3Pools ?? []) {
      const key = pool.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        // Keep only a pool trading BOTH tokenIn and tokenOut (V3 has no BPT in the swappable set). Orient the
        // in/out indices off the REGISTERED token order (getCurrentLiveBalances returns balances in this order).
        const tokens = (await client
          .readContract({ address: vault, abi: balancerV3VaultAbi, functionName: "getPoolTokens", args: [pool] })
          .catch(() => [])) as readonly Hex[];
        const lc = tokens.map((t) => t.toLowerCase());
        const inIdx = lc.indexOf(inLc);
        const outIdx = lc.indexOf(outLc);
        if (inIdx < 0 || outIdx < 0) continue;

        // Read the LIVE StableMath state the on-chain solver replays: scaled-18 balances, amp (A·AMP_PRECISION),
        // static swap fee, and each token's rate provider (from getPoolTokenInfo → getRate). These are ALSO what
        // the neutral oracle mirrors (buildBalancerV3QLLadder) at the SAME block ⇒ oracle == solver by construction.
        const [liveBalances, staticFeeWad, ampRes, tokenInfo] = await Promise.all([
          client.readContract({ address: vault, abi: balancerV3VaultAbi, functionName: "getCurrentLiveBalances", args: [pool] }).then((r) => r as bigint[]),
          client.readContract({ address: vault, abi: balancerV3VaultAbi, functionName: "getStaticSwapFeePercentage", args: [pool] }).then((r) => r as bigint),
          client.readContract({ address: pool, abi: balancerV3PoolAbi, functionName: "getAmplificationParameter" }).then((r) => r as readonly [bigint, boolean, bigint]),
          client.readContract({ address: vault, abi: balancerV3VaultAbi, functionName: "getPoolTokenInfo", args: [pool] }).then((r) => r as readonly [readonly Hex[], readonly { tokenType: number; rateProvider: Hex; paysYieldFees: boolean }[], readonly bigint[], readonly bigint[]]),
        ]);
        const amp = ampRes[0];
        const rpIn = tokenInfo[1][inIdx]?.rateProvider ?? (ZERO_ADDRESS as Hex);
        const rpOut = tokenInfo[1][outIdx]?.rateProvider ?? (ZERO_ADDRESS as Hex);
        if (rpIn === ZERO_ADDRESS || rpOut === ZERO_ADDRESS) continue; // no rate provider → the QL replay can't scale

        // Live per-token rates (SCALARS via each rate provider — the v12-safe read; getPoolTokenRates nests a
        // dyn array in a tuple which decodes to garbage on v12, so read the provider directly).
        const [rateIn, rateOut, decInRaw, decOutRaw] = await Promise.all([
          client.readContract({ address: rpIn, abi: balancerV3RateProviderAbi, functionName: "getRate" }).then((r) => r as bigint),
          client.readContract({ address: rpOut, abi: balancerV3RateProviderAbi, functionName: "getRate" }).then((r) => r as bigint),
          client.readContract({ address: tokenIn, abi: erc20DecimalsAbi, functionName: "decimals" }).then((r) => Number(r)),
          client.readContract({ address: tokenOut, abi: erc20DecimalsAbi, functionName: "decimals" }).then((r) => Number(r)),
        ]);
        // The scaled-18 QL replay needs a NON-NEGATIVE decimal exponent (10^(18−d)); a >18-decimal token
        // would be 10^(negative) → RangeError. Such stable-pool tokens are exotic — skip the pool explicitly
        // rather than relying on the surrounding try/catch to swallow the throw.
        if (decInRaw > 18 || decOutRaw > 18) continue;
        const decScaleIn = 10n ** BigInt(18 - decInRaw);
        const decScaleOut = 10n ** BigInt(18 - decOutRaw);

        const b3: BalancerV3Pool = {
          address: pool,
          router,
          tokenIn,
          tokenOut,
          feePpm: 0,
          source: `${cfg.label} (Balancer V3)`,
          vault,
          inIdx,
          outIdx,
          amp,
          staticFeeWad,
          liveBalances,
          rateIn,
          rateOut,
          decScaleIn,
          decScaleOut,
          rpIn,
          rpOut,
        };

        // SURGE-EXCLUSION cross-check. This landing quote-ladders the pool with the STATIC-fee StableMath, which
        // is wei-exact ONLY when the StableSurge hook is INACTIVE (the swap moves the pool toward balance → the
        // hook returns exactly the static fee). Sample the REAL Router querySwapSingleTokenExactIn ladder and
        // compare the StableMath replay at those points: if any point diverges beyond a tiny rounding tolerance,
        // the surge fee is ACTIVE for this direction/size — the static-fee replay can't reproduce it, so EXCLUDE
        // the pool (documented scope: surge-active pools are a follow-up lane). Same-block reads ⇒ an inactive
        // surge agrees to a few wei.
        const quotes = await Promise.all(
          sampleIn.map((amt) =>
            client
              .readContract({
                address: router,
                abi: balancerV3RouterAbi,
                functionName: "querySwapSingleTokenExactIn",
                args: [pool, tokenIn, tokenOut, amt, ZERO_ADDRESS as Hex, "0x" as Hex],
              })
              .then((r) => r as bigint)
              .catch(() => 0n),
          ),
        );
        const cumIn: bigint[] = [];
        const cumOut: bigint[] = [];
        let prevOut = 0n;
        let surgeActive = false;
        for (let i = 0; i < sampleIn.length; i++) {
          const truth = quotes[i];
          if (truth <= prevOut) break; // limit edge / degenerate — stop the ladder here
          const replay = balancerV3StableGetDy(b3, sampleIn[i]);
          // tolerance: max(2 wei, 1e-7 relative) — an INACTIVE surge agrees to rounding; an ACTIVE surge fee
          // diverges by basis points, far outside this.
          const diff = replay > truth ? replay - truth : truth - replay;
          const tol = 2n + truth / 10_000_000n;
          if (diff > tol) { surgeActive = true; break; }
          cumIn.push(sampleIn[i]);
          cumOut.push(truth);
          prevOut = truth;
        }
        if (surgeActive) continue; // surge-active pool — out of scope for the static-fee QL replay this landing
        if (cumOut.length === 0 || cumOut[0] <= 0n) continue; // pair not tradeable / no out

        // Derive an effective fee (ppm) from the shallowest slice for price-ordering / diagnostics only (a
        // surge-hooked pool has no single fee getter). PAR-PAIR heuristic — 0 when it can't be inferred. The
        // real merge coordinate is marginalOI from the QL ladder dy (shared by the solver + oracle).
        let feePpm = 0;
        const in0 = cumIn[0];
        const out0 = cumOut[0];
        if (in0 > 0n && out0 > 0n && out0 < in0) {
          const shortfall = ((in0 - out0) * BALANCER_V3_FEE_SCALE) / in0;
          if (shortfall > 0n && shortfall < BALANCER_V3_FEE_SCALE) feePpm = Number(shortfall);
        }
        b3.feePpm = feePpm;
        b3.cumIn = cumIn;
        b3.cumOut = cumOut;
        out.push(b3);
      } catch {
        // Pool/router read failed (not a live V3 pool, paused, or unsupported pair) — skip.
      }
    }
  }
  return out;
}

// ── KyberSwap Classic / DMM discovery ───────────────────────

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
export async function discoverKyberClassicPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<KyberClassicPool[]> {
  if (factories.length === 0) return [];

  // getPools is order-insensitive in the DMM factory, but query each factory once.
  const listResults = await client.multicall({
    contracts: factories.map((f) => ({
      address: f.address,
      abi: kyberFactoryAbi,
      functionName: "getPools" as const,
      args: [tokenIn, tokenOut] as const,
    })),
    allowFailure: true,
  });

  const validPools: { address: Hex; factory: FactoryConfig }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < listResults.length; i++) {
    const r = listResults[i];
    if (r.status !== "success" || !r.result) continue;
    for (const addr of r.result as readonly Hex[]) {
      if (!addr || addr === ZERO_ADDRESS) continue;
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      validPools.push({ address: addr, factory: factories[i] });
    }
  }
  if (validPools.length === 0) return [];

  const [tradeInfoResults, token0Results] = await Promise.all([
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: kyberPoolAbi,
        functionName: "getTradeInfo" as const,
      })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: validPools.map((p) => ({
        address: p.address,
        abi: kyberPoolAbi,
        functionName: "token0" as const,
      })),
      allowFailure: true,
    }),
  ]);

  const pools: KyberClassicPool[] = [];
  for (let i = 0; i < validPools.length; i++) {
    const ti = tradeInfoResults[i];
    const t0 = token0Results[i];
    if (ti.status !== "success" || t0.status !== "success") continue;

    const [reserve0, reserve1, vReserve0, vReserve1, feeInPrecision] =
      ti.result as readonly [bigint, bigint, bigint, bigint, bigint];
    if (vReserve0 === 0n || vReserve1 === 0n) continue;

    const inIsToken0 = tokenIn.toLowerCase() === (t0.result as string).toLowerCase();
    pools.push({
      address: validPools[i].address,
      tokenIn,
      tokenOut,
      reserveIn: inIsToken0 ? reserve0 : reserve1,
      reserveOut: inIsToken0 ? reserve1 : reserve0,
      vReserveIn: inIsToken0 ? vReserve0 : vReserve1,
      vReserveOut: inIsToken0 ? vReserve1 : vReserve0,
      feeInPrecision,
      inIsToken0,
      source: validPools[i].factory.label,
    });
  }
  return pools;
}

// ── Wombat Exchange (single-sided stableswap) discovery ─────────────────────

// Wombat Pool (multi-asset singleton) + Asset surface. The pool resolves each token's Asset via
// addressOfAsset(token); the asset exposes cash()/liability() in WAD (18.18 fixed point, regardless
// of the underlying token's decimals). ampFactor()/haircutRate() are pool-wide WAD getters. The
// underlying token's decimals come from erc20 decimals() (the WAD↔native scaling).
const wombatPoolAbi = parseAbi([
  "function addressOfAsset(address token) external view returns (address)",
  "function ampFactor() external view returns (uint256)",
  "function haircutRate() external view returns (uint256)",
  "function quotePotentialSwap(address fromToken, address toToken, int256 fromAmount) external view returns (uint256 potentialOutcome, uint256 haircut)",
]);

const wombatAssetAbi = parseAbi([
  "function cash() external view returns (uint120)",
  "function liability() external view returns (uint120)",
]);

/** Round a Wombat haircutRate (WAD, e.g. 1e14 = 0.01%) to a ppm fee (the price-ordering coordinate). */
function wombatHaircutToPpm(haircutRate: bigint): number {
  return Number((haircutRate * 1_000_000n + WOMBAT_WAD / 2n) / WOMBAT_WAD);
}

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
export async function discoverWombatPoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  pools: FactoryConfig[],
): Promise<WombatPool[]> {
  if (pools.length === 0) return [];

  // Resolve each pool's from/to Asset addresses (both must exist for the pair to trade).
  const assetCalls = pools.flatMap((p) => [
    { address: p.address, abi: wombatPoolAbi, functionName: "addressOfAsset" as const, args: [tokenIn] as const },
    { address: p.address, abi: wombatPoolAbi, functionName: "addressOfAsset" as const, args: [tokenOut] as const },
  ]);
  const assetResults = await client.multicall({ contracts: assetCalls, allowFailure: true });

  const valid: { pool: FactoryConfig; fromAsset: Hex; toAsset: Hex }[] = [];
  for (let i = 0; i < pools.length; i++) {
    const fr = assetResults[2 * i];
    const to = assetResults[2 * i + 1];
    if (fr.status !== "success" || to.status !== "success") continue;
    const fromAsset = fr.result as Hex;
    const toAsset = to.result as Hex;
    if (!fromAsset || fromAsset === ZERO_ADDRESS || !toAsset || toAsset === ZERO_ADDRESS) continue;
    valid.push({ pool: pools[i], fromAsset, toAsset });
  }
  if (valid.length === 0) return [];

  // Pool-wide amp + haircut, and per-asset cash/liability (WAD).
  const [ampResults, haircutResults, fromCashResults, fromLiabResults, toCashResults, toLiabResults] =
    await Promise.all([
      client.multicall({ contracts: valid.map((v) => ({ address: v.pool.address, abi: wombatPoolAbi, functionName: "ampFactor" as const })), allowFailure: true }),
      client.multicall({ contracts: valid.map((v) => ({ address: v.pool.address, abi: wombatPoolAbi, functionName: "haircutRate" as const })), allowFailure: true }),
      client.multicall({ contracts: valid.map((v) => ({ address: v.fromAsset, abi: wombatAssetAbi, functionName: "cash" as const })), allowFailure: true }),
      client.multicall({ contracts: valid.map((v) => ({ address: v.fromAsset, abi: wombatAssetAbi, functionName: "liability" as const })), allowFailure: true }),
      client.multicall({ contracts: valid.map((v) => ({ address: v.toAsset, abi: wombatAssetAbi, functionName: "cash" as const })), allowFailure: true }),
      client.multicall({ contracts: valid.map((v) => ({ address: v.toAsset, abi: wombatAssetAbi, functionName: "liability" as const })), allowFailure: true }),
    ]);

  // Decimals: read the two tokens once (tokenIn + tokenOut).
  const [decInRaw, decOutRaw] = await Promise.all([
    client.readContract({ address: tokenIn, abi: erc20DecimalsAbi, functionName: "decimals" }).then((d) => Number(d)).catch(() => 18),
    client.readContract({ address: tokenOut, abi: erc20DecimalsAbi, functionName: "decimals" }).then((d) => Number(d)).catch(() => 18),
  ]);
  const decIn = 10n ** BigInt(decInRaw);
  const decOut = 10n ** BigInt(decOutRaw);

  const out: WombatPool[] = [];
  for (let i = 0; i < valid.length; i++) {
    if (
      ampResults[i].status !== "success" || haircutResults[i].status !== "success" ||
      fromCashResults[i].status !== "success" || fromLiabResults[i].status !== "success" ||
      toCashResults[i].status !== "success" || toLiabResults[i].status !== "success"
    ) continue;
    const fromCash = fromCashResults[i].result as bigint;
    const fromLiability = fromLiabResults[i].result as bigint;
    const toCash = toCashResults[i].result as bigint;
    const toLiability = toLiabResults[i].result as bigint;
    // A pool with no from-cash to sell into or no to-cash to pay out cannot trade.
    if (fromLiability <= 0n || toLiability <= 0n || toCash <= 0n) continue;
    const haircutRate = haircutResults[i].result as bigint;
    out.push({
      address: valid[i].pool.address,
      fromCash,
      fromLiability,
      toCash,
      toLiability,
      ampFactor: ampResults[i].result as bigint,
      haircutRate,
      decIn,
      decOut,
      tokenIn,
      tokenOut,
      feePpm: wombatHaircutToPpm(haircutRate),
      source: `${valid[i].pool.label} (Wombat)`,
    });
  }
  return out;
}

// The REAL euler-xyz/euler-swap IEulerSwap surface. TWO on-chain shapes coexist (like Uni V2/V3/V4 in
// this recipe) — discovery detects the version via `curve()` (a bytes32 constant) and reads the matching
// curve-param getter:
//
//   · v1 (tag eulerswap-1.0, curve()=="EulerSwap v1"): the curve params are IMMUTABLE (packed in the
//     pool's MetaProxy trailing calldata) and read via getParams() — a 12-field STATIC struct
//     (vault0, vault1, eulerAccount, equilibriumReserve0/1 (uint112), priceX/priceY (uint256),
//     concentrationX/concentrationY (uint256), fee (uint256, SINGLE non-directional), protocolFee,
//     protocolFeeRecipient). There is NO getDynamicParams() (it REVERTS on v1). Verified live against the
//     real deployed v1 pool 0x3bBCC029f312ECe579a7dEb77B13CB8aE15F28A8 (USDC/USDT, mainnet).
//   · v2 (master, curve()=="EulerSwap v2"): the curve params live in a DynamicParams struct returned by
//     getDynamicParams() — equilibriumReserve0/1 (uint112), priceX/priceY (uint80),
//     concentrationX/concentrationY (uint64), DIRECTIONAL fee0/fee1 (uint64; fee0 charged when tokenIn is
//     asset0, fee1 when tokenIn is asset1), expiration, swapHookedOperations, swapHook.
//
// Common to both: getAssets() (assets — NO asset0()/asset1() getter), getReserves()
// (uint112,uint112,uint32 status — VIRTUAL curve-state reserves), getLimits(tokenIn,tokenOut) (bounds the
// sampler), curve() (the version discriminator). The curve MATH (CurveLib.f / fInverse) is IDENTICAL
// across v1 and v2, so ONE eulerswap-math replay serves both — a v1 pool's off-chain computeQuote
// reproduces the live pool's computeQuote view bit-for-bit (verified on 0x3bBCC029 across 9 vectors both
// directions). The EXEC surface (computeQuote/getAssets/swap) is likewise version-agnostic.
const eulerSwapPoolAbi = parseAbi([
  "function curve() external view returns (bytes32)",
  "function getAssets() external view returns (address asset0, address asset1)",
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 status)",
  "function getParams() external view returns ((address vault0, address vault1, address eulerAccount, uint112 equilibriumReserve0, uint112 equilibriumReserve1, uint256 priceX, uint256 priceY, uint256 concentrationX, uint256 concentrationY, uint256 fee, uint256 protocolFee, address protocolFeeRecipient) params)",
  "function getDynamicParams() external view returns ((uint112 equilibriumReserve0, uint112 equilibriumReserve1, uint112 minReserve0, uint112 minReserve1, uint80 priceX, uint80 priceY, uint64 concentrationX, uint64 concentrationY, uint64 fee0, uint64 fee1, uint40 expiration, uint8 swapHookedOperations, address swapHook) params)",
  "function getLimits(address tokenIn, address tokenOut) external view returns (uint256 inLimit, uint256 outLimit)",
]);

/** bytes32("EulerSwap v1") — the curve() constant that identifies a v1 pool (right-zero-padded ASCII). */
const EULER_CURVE_V1 = "0x45756c6572537761702076310000000000000000000000000000000000000000";

/** DynamicParams as decoded by viem from the v2 getDynamicParams() tuple. */
type EulerDynamicParams = {
  equilibriumReserve0: bigint;
  equilibriumReserve1: bigint;
  minReserve0: bigint;
  minReserve1: bigint;
  priceX: bigint;
  priceY: bigint;
  concentrationX: bigint;
  concentrationY: bigint;
  fee0: bigint;
  fee1: bigint;
  expiration: number;
  swapHookedOperations: number;
  swapHook: Hex;
};

/** Params as decoded by viem from the v1 getParams() tuple (12 fields, static/immutable). */
type EulerV1Params = {
  vault0: Hex;
  vault1: Hex;
  eulerAccount: Hex;
  equilibriumReserve0: bigint;
  equilibriumReserve1: bigint;
  priceX: bigint;
  priceY: bigint;
  concentrationX: bigint;
  concentrationY: bigint;
  fee: bigint;
  protocolFee: bigint;
  protocolFeeRecipient: Hex;
};

/**
 * Normalized curve-param bundle used by discovery to build the tokenIn-oriented EulerSwapPool descriptor,
 * unifying the v1 (getParams — single fee) and v2 (getDynamicParams — directional fee0/fee1) shapes. The
 * curve math is version-independent; only the SOURCE getter + the fee direction differ.
 */
type EulerCurveBundle = {
  /** equilibriumReserve0 (x0). */
  x0: bigint;
  /** equilibriumReserve1 (y0). */
  y0: bigint;
  /** priceX (px). */
  px: bigint;
  /** priceY (py). */
  py: bigint;
  /** concentrationX (cx). */
  cx: bigint;
  /** concentrationY (cy). */
  cy: bigint;
  /** Fee charged when tokenIn is asset0 (1e18-scaled). v1: the single fee; v2: fee0. */
  fee0: bigint;
  /** Fee charged when tokenIn is asset1 (1e18-scaled). v1: the single fee; v2: fee1. */
  fee1: bigint;
};

// eulerFeeToPpm (round-half-up) lives in eulerswap-math.ts — THE SINGLE SOURCE, shared by discovery, the
// prod-mirror descriptor, and the known-answer test descriptors so the ppm ordering coordinate matches
// bit-for-bit (imported at the top of this file alongside EulerSwapPool).

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
export async function discoverEulerSwapPoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<EulerSwapPool[]> {
  // Flatten every candidate pool address across the EulerSwap factory configs.
  const candidates: { address: Hex; label: string }[] = [];
  for (const f of factories) {
    for (const addr of f.eulerSwapPools ?? []) candidates.push({ address: addr, label: f.label });
  }
  if (candidates.length === 0) return [];

  // Read getAssets() (validate the pair + orient the swap) + curve() (v1/v2 discriminator) per candidate.
  const [idResults, curveResults] = await Promise.all([
    client.multicall({
      contracts: candidates.map((cp) => ({ address: cp.address, abi: eulerSwapPoolAbi, functionName: "getAssets" as const })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: candidates.map((cp) => ({ address: cp.address, abi: eulerSwapPoolAbi, functionName: "curve" as const })),
      allowFailure: true,
    }),
  ]);

  const valid: { cp: { address: Hex; label: string }; inIsToken0: boolean; isV1: boolean; curveOk: boolean }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const a = idResults[i];
    if (a.status !== "success") continue;
    const [rawA0, rawA1] = a.result as readonly [Hex, Hex];
    const asset0 = rawA0.toLowerCase();
    const asset1 = rawA1.toLowerCase();
    const ti = tokenIn.toLowerCase();
    const to = tokenOut.toLowerCase();
    // curve() == "EulerSwap v1" ⇒ v1 (read getParams()); a SUCCESSFUL non-v1 curve() ⇒ v2 (getDynamicParams()).
    // A FAILED curve() is ambiguous (rare — a static immutable read shares the getParams/getDynamicParams
    // multicall batch, so a curve()-only failure is transient): the true discriminator is then which
    // curve-param getter succeeds, resolved in the second loop below (`curveOk` records the ambiguity). We
    // provisionally tag such a pool v1 (getParams success is itself the v1 marker) so a valid v1 pool with a
    // transient curve() blip is not silently misclassified v2 → dropped on the reverting getDynamicParams().
    const curveOk = curveResults[i].status === "success";
    const isV1 = curveOk
      ? (curveResults[i].result as Hex).toLowerCase() === EULER_CURVE_V1
      : true; // ambiguous — provisional v1, reconciled against the getters below
    if (asset0 === ti && asset1 === to) valid.push({ cp: candidates[i], inIsToken0: true, isV1, curveOk });
    else if (asset0 === to && asset1 === ti) valid.push({ cp: candidates[i], inIsToken0: false, isV1, curveOk });
  }
  if (valid.length === 0) return [];

  // Per-pool live reserves (getReserves) + BOTH curve-param getters (v1 getParams + v2 getDynamicParams,
  // allowFailure — each pool responds to exactly one; we select by `isV1`) + the vault input cap
  // (getLimits). Reading both getters unconditionally keeps discovery a fixed 4-multicall shape regardless
  // of the version mix, and allowFailure makes the unused getter a harmless revert.
  const [resR, pR, dpR, limR] = await Promise.all([
    client.multicall({ contracts: valid.map((v) => ({ address: v.cp.address, abi: eulerSwapPoolAbi, functionName: "getReserves" as const })), allowFailure: true }),
    client.multicall({ contracts: valid.map((v) => ({ address: v.cp.address, abi: eulerSwapPoolAbi, functionName: "getParams" as const })), allowFailure: true }),
    client.multicall({ contracts: valid.map((v) => ({ address: v.cp.address, abi: eulerSwapPoolAbi, functionName: "getDynamicParams" as const })), allowFailure: true }),
    client.multicall({ contracts: valid.map((v) => ({ address: v.cp.address, abi: eulerSwapPoolAbi, functionName: "getLimits" as const, args: [tokenIn, tokenOut] as const })), allowFailure: true }),
  ]);

  const out: EulerSwapPool[] = [];
  for (let i = 0; i < valid.length; i++) {
    if (resR[i].status !== "success") continue;
    const { inIsToken0, curveOk } = valid[i];

    // Resolve the version. When curve() SUCCEEDED it is authoritative (valid[i].isV1). When it FAILED
    // (ambiguous — see the first loop), the true discriminator is which curve-param getter answered:
    // getParams() ⇒ v1, else getDynamicParams() ⇒ v2. getParams success is itself the v1 marker, so a valid
    // v1 pool with a transient curve() blip is classified v1 (not silently dropped on a reverting
    // getDynamicParams()). If curve() failed AND getParams() failed, fall through to v2 (both getters read;
    // if getDynamicParams() also fails the pool is dropped below — a genuinely broken pool).
    const isV1 = curveOk ? valid[i].isV1 : pR[i].status === "success";

    // Normalize the version-specific curve params into a common bundle (single vs directional fee folded).
    let bundle: EulerCurveBundle | null = null;
    if (isV1) {
      if (pR[i].status !== "success") continue; // v1 pool with an unreadable getParams() ⇒ drop
      const p = pR[i].result as EulerV1Params;
      // v1 fee is a SINGLE non-directional value (charged regardless of direction).
      bundle = {
        x0: p.equilibriumReserve0, y0: p.equilibriumReserve1,
        px: p.priceX, py: p.priceY, cx: p.concentrationX, cy: p.concentrationY,
        fee0: p.fee, fee1: p.fee,
      };
    } else {
      if (dpR[i].status !== "success") continue; // v2 pool with an unreadable getDynamicParams() ⇒ drop
      const dp = dpR[i].result as EulerDynamicParams;
      bundle = {
        x0: dp.equilibriumReserve0, y0: dp.equilibriumReserve1,
        px: dp.priceX, py: dp.priceY, cx: dp.concentrationX, cy: dp.concentrationY,
        fee0: dp.fee0, fee1: dp.fee1,
      };
    }

    const [reserve0, reserve1] = resR[i].result as readonly [bigint, bigint, number];
    const { x0, y0, px, py, cx, cy } = bundle;
    // Fee is DIRECTIONAL for the descriptor: fee0 when tokenIn is asset0, fee1 when tokenIn is asset1
    // (v1 collapses both to the single fee, so this is direction-invariant there).
    const feeWad = inIsToken0 ? bundle.fee0 : bundle.fee1;
    // The vault input cap (getLimits inLimit). 0 / failed read ⇒ uncapped (the sampler treats 0 as uncapped).
    let inLimit = 0n;
    if (limR[i].status === "success") {
      const lim = limR[i].result as readonly [bigint, bigint];
      inLimit = lim[0];
    }
    // Orient reserves + curve params by tokenIn (the math module is tokenIn-oriented).
    const reserveIn = inIsToken0 ? reserve0 : reserve1;
    const reserveOut = inIsToken0 ? reserve1 : reserve0;
    if (reserveOut <= 0n) continue; // nothing to pay out
    out.push({
      address: valid[i].cp.address,
      inIsToken0,
      reserveIn,
      reserveOut,
      equilIn: inIsToken0 ? x0 : y0,
      equilOut: inIsToken0 ? y0 : x0,
      priceIn: inIsToken0 ? px : py,
      priceOut: inIsToken0 ? py : px,
      concIn: inIsToken0 ? cx : cy,
      concOut: inIsToken0 ? cy : cx,
      feeWad,
      inLimit,
      feePpm: eulerFeeToPpm(feeWad),
      source: `${valid[i].cp.label} (EulerSwap ${isV1 ? "v1" : "v2"})`,
    });
  }
  return out;
}

// ── Maverick V2 discovery (typed) ───────────────────────────────────────────

// Maverick V2 pool read surface (the EcoSwap typed path — distinct from the legacy flat-tuple
// maverickPoolAbi above). getState() returns the State struct (activeTick / protocolFeeRatioD3 +
// the live reserves the walk seeds from); fee(bool tokenAIn) is the DIRECTIONAL 1e18-scaled swap
// fee; tickSpacing() is the bin-width exponent; getTick(int32) returns the per-tick reserves the
// off-chain bin swap-math replay walks; tokenA()/tokenB() orient the swap.
const maverickV2PoolAbi = parseAbi([
  "function tokenA() external view returns (address)",
  "function tokenB() external view returns (address)",
  "function tickSpacing() external view returns (uint256)",
  "function fee(bool tokenAIn) external view returns (uint256)",
  "function getState() external view returns ((uint128 reserveA, uint128 reserveB, int64 lastTwaD8, int64 lastLogPriceD8, uint40 lastTimestamp, int32 activeTick, bool isLocked, uint32 binCounter, uint8 protocolFeeRatioD3) state)",
  "function getTick(int32 tick) external view returns ((uint128 reserveA, uint128 reserveB, uint128 totalSupply, uint32[4] binIdsByTick) tickState)",
]);

/** getState() decoded tuple shape. */
type MaverickState = {
  reserveA: bigint;
  reserveB: bigint;
  lastTwaD8: bigint;
  lastLogPriceD8: bigint;
  lastTimestamp: number;
  activeTick: number;
  isLocked: boolean;
  binCounter: number;
  protocolFeeRatioD3: number;
};
/** getTick() decoded tuple shape. */
type MaverickTickState = {
  reserveA: bigint;
  reserveB: bigint;
  totalSupply: bigint;
  binIdsByTick: readonly number[];
};

/** How many ticks on each side of the active tick to read for the swap-math walk. */
const MAVERICK_TICK_WINDOW = Number(process.env.ECO_MAVERICK_TICK_WINDOW ?? 40);

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
export async function discoverMaverickV2PoolsTyped(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
): Promise<MaverickPool[]> {
  if (factories.length === 0) return [];
  const inLower = tokenIn.toLowerCase();

  // MIXED-DECIMAL SKIP GUARD. maverick-math operates in Maverick's internal 1e18-normalized (D18) units
  // and this discovery feeds RAW reserves + a RAW swap amount into it, so the replay is wei-exact ONLY for
  // an 18/18-decimal pair (the validated BSC USDT/USDC target). A non-18/18 pool (e.g. WETH/USDC) would
  // need its reserves AND the swap amount scaled to D18 (and the output de-scaled) — the Curve/Balancer/
  // Wombat normalization — with the EXACT Maverick scale rounding, which is a separate follow-up. Until that
  // lands, SKIP non-18/18 pairs here so a discovered mixed-decimal Maverick pool cannot inject a mis-scaled
  // (~1e-6-off) split marginal into production. The pair's two tokens ARE tokenIn/tokenOut, so their
  // decimals decide it for every pool this call surfaces.
  const [decIn, decOut] = await Promise.all([
    client.readContract({ address: tokenIn, abi: erc20DecimalsAbi, functionName: "decimals" }).then((d) => Number(d)).catch(() => 18),
    client.readContract({ address: tokenOut, abi: erc20DecimalsAbi, functionName: "decimals" }).then((d) => Number(d)).catch(() => 18),
  ]);
  if (decIn !== 18 || decOut !== 18) return [];

  const pools: MaverickPool[] = [];
  const seen = new Set<string>();
  for (const factory of factories) {
    for (const [tA, tB] of [
      [tokenIn, tokenOut],
      [tokenOut, tokenIn],
    ] as [Hex, Hex][]) {
      // Paginate lookup(startIndex,endIndex) so pairs with >10 Maverick pools are not truncated.
      // Bounded: page of MAVERICK_LOOKUP_PAGE, stop early on a short page, hard-cap at MAVERICK_LOOKUP_MAX.
      const addresses: string[] = [];
      try {
        for (let start = 0; start < MAVERICK_LOOKUP_MAX; start += MAVERICK_LOOKUP_PAGE) {
          const end = Math.min(start + MAVERICK_LOOKUP_PAGE, MAVERICK_LOOKUP_MAX);
          const page = (await client.readContract({
            address: factory.address,
            abi: maverickFactoryAbi,
            functionName: "lookup",
            args: [tA, tB, BigInt(start), BigInt(end)],
          })) as string[];
          addresses.push(...page);
          if (page.length < end - start) break; // short page → no more pools
        }
      } catch {
        continue;
      }

      for (const addr of addresses) {
        if (!addr || addr === ZERO_ADDRESS) continue;
        const key = addr.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const pool = addr as Hex;

        try {
          const [tokenARaw, stateRaw, tsRaw] = await Promise.all([
            client.readContract({ address: pool, abi: maverickV2PoolAbi, functionName: "tokenA" }) as Promise<Hex>,
            client.readContract({ address: pool, abi: maverickV2PoolAbi, functionName: "getState" }) as Promise<MaverickState>,
            client.readContract({ address: pool, abi: maverickV2PoolAbi, functionName: "tickSpacing" }) as Promise<bigint>,
          ]);

          const tokenAIn = inLower === (tokenARaw as string).toLowerCase();
          const activeTick = Number(stateRaw.activeTick);
          const tickSpacing = Number(tsRaw);
          if (tickSpacing <= 0) continue;

          // No active-tick side gate: the FIXED engine `_swapMaverickV2` (../sauce PR #193) passes a
          // per-direction FULL-RANGE tickLimit (type(int32).max/min), so a swap fills across the whole live
          // tick book regardless of which side of tick 0 the active tick sits on. Every discovered liquid
          // pool is executable — surface them all. (The OLD tickLimit=0 engine required a here-dropped gate.)

          // Directional fee for THIS swap direction.
          const feeWad = (await client.readContract({
            address: pool,
            abi: maverickV2PoolAbi,
            functionName: "fee",
            args: [tokenAIn],
          })) as bigint;

          // Read the tick window around the active tick, in ASCENDING tick order.
          const lo = activeTick - MAVERICK_TICK_WINDOW;
          const hi = activeTick + MAVERICK_TICK_WINDOW;
          const tickNums: number[] = [];
          for (let t = lo; t <= hi; t++) tickNums.push(t);
          const tickResults = await client.multicall({
            contracts: tickNums.map((t) => ({
              address: pool,
              abi: maverickV2PoolAbi,
              functionName: "getTick" as const,
              args: [t] as const,
            })),
            allowFailure: true,
          });

          // The reserves are pushed RAW. maverick-math operates in Maverick's internal 1e18-normalized
          // (D18) units, so this is wei-exact ONLY for an 18/18-decimal pair — which is ENFORCED by the
          // decimals==18/18 skip guard at the top of this function (a mixed-decimal pool is dropped before
          // this loop). D18 amount normalization for non-18/18 pairs (the Curve/Balancer/Wombat path, with
          // the exact Maverick scale rounding) is the follow-up that lifts that guard.
          const ticks: MaverickTick[] = [];
          for (let k = 0; k < tickNums.length; k++) {
            const r = tickResults[k];
            if (r.status !== "success") continue;
            const st = r.result as MaverickTickState;
            if (st.reserveA === 0n && st.reserveB === 0n) continue;
            ticks.push({ tick: tickNums[k], reserveA: st.reserveA, reserveB: st.reserveB });
          }
          if (ticks.length === 0) continue;

          // Seed the walk's starting price from the active tick's reserves (clamped to its bounds).
          const active = ticks.find((t) => t.tick === activeTick);
          if (!active) continue; // active tick must carry liquidity to seed the walk
          const { sqrtLowerPrice, sqrtUpperPrice } = tickSqrtPrices(tickSpacing, activeTick);
          const activeL = getTickL(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice);
          if (activeL === 0n) continue;
          const poolSqrtPrice = getMaverickSqrtPrice(
            active.reserveA,
            active.reserveB,
            sqrtLowerPrice,
            sqrtUpperPrice,
            activeL,
          );

          pools.push({
            poolType: SwapPoolType.MaverickV2,
            address: pool,
            tokenAIn,
            activeTick,
            poolSqrtPrice,
            tickSpacing,
            fee: feeWad,
            protocolFeeD3: BigInt(stateRaw.protocolFeeRatioD3),
            ticks,
            feePpm: maverickFeeToPpm(feeWad),
            source: factory.label,
          });
        } catch {
          // Pool state read failed (non-Maverick surface / partial pool) — skip.
        }
      }
    }
  }
  return pools;
}

/** Integer square root (babylonian method) */
function sqrt(x: bigint): bigint {
  if (x <= 0n) return 0n;
  let z = x;
  let y = (z + 1n) / 2n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

// ── Uniswap V4 discovery ────────────────────────────────────

const ZERO_HOOKS = "0x0000000000000000000000000000000000000000" as Hex;

/**
 * Discover Uniswap V4 pools for the pair across the configured fee tiers.
 *
 * V4 is a singleton: there is no per-pool contract. Each (currency0, currency1,
 * fee, tickSpacing, hooks) combination has a `poolId = keccak256(abi.encode(key))`;
 * state is read from the StateView lens. We probe hookless pools at each standard
 * fee tier (one batched multicall of getSlot0 + getLiquidity) and keep the ones
 * that are initialised (sqrtPriceX96 > 0) and carry liquidity.
 */
async function discoverV4Pools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  factories: FactoryConfig[],
  feeTiers: number[],
): Promise<PoolInfo[]> {
  if (factories.length === 0) return [];

  // V4 canonical ordering: currency0 < currency1 by address. Hookless pools only.
  const [currency0, currency1] =
    BigInt(tokenIn) < BigInt(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];

  type Candidate = { factory: FactoryConfig; fee: number; tickSpacing: number; poolId: Hex };
  const candidates: Candidate[] = [];
  for (const f of factories) {
    if (!f.stateView) continue;
    for (const fee of f.feeTiers ?? feeTiers) {
      const tickSpacing = feeToTickSpacing(fee);
      const poolId = computeV4PoolId(currency0, currency1, fee, tickSpacing, ZERO_HOOKS);
      candidates.push({ factory: f, fee, tickSpacing, poolId });
    }
  }
  if (candidates.length === 0) return [];

  const [slot0Results, liqResults] = await Promise.all([
    client.multicall({
      contracts: candidates.map((c) => ({
        address: c.factory.stateView as Hex,
        abi: v4StateViewAbi,
        functionName: "getSlot0" as const,
        args: [c.poolId] as const,
      })),
      allowFailure: true,
    }),
    client.multicall({
      contracts: candidates.map((c) => ({
        address: c.factory.stateView as Hex,
        abi: v4StateViewAbi,
        functionName: "getLiquidity" as const,
        args: [c.poolId] as const,
      })),
      allowFailure: true,
    }),
  ]);

  const pools: PoolInfo[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const s = slot0Results[i];
    const l = liqResults[i];
    if (s.status !== "success" || l.status !== "success") continue;
    const sqrtPriceX96 = (s.result as readonly [bigint, number, number, number])[0];
    const liquidity = l.result as bigint;
    if (sqrtPriceX96 === 0n || liquidity === 0n) continue;
    pools.push({
      address: c.factory.address, // PoolManager singleton
      tokenIn,
      tokenOut,
      fee: c.fee,
      poolType: c.factory.poolType, // UniV4
      priceLimited: true,
      sqrtPriceX96,
      liquidity,
      source: c.factory.label,
      poolId: c.poolId,
      stateView: c.factory.stateView,
      currency0,
      currency1,
      tickSpacing: c.tickSpacing,
      hooks: ZERO_HOOKS,
    });
  }
  return pools;
}

// ── Unified discovery ───────────────────────────────────────

/**
 * Discover all pools for a token pair across all protocols and factory types.
 *
 * @param poolConfig - Chain-specific factory/fee config. Defaults to Base.
 */
export async function discoverPools(
  tokenIn: Hex,
  tokenOut: Hex,
  client: PublicClient,
  poolConfig: ChainPoolConfig = BASE_CHAIN_POOL_CONFIG,
): Promise<PoolInfo[]> {
  const { factories, feeTiers } = poolConfig;

  // Group factories by type
  const v3Factories = factories.filter((f) => f.factoryType === FactoryType.V3Standard);
  const slipstreamFactories = factories.filter((f) => f.factoryType === FactoryType.SlipstreamCL);
  const v4Factories = factories.filter((f) => f.factoryType === FactoryType.UniswapV4);
  const algebraFactories = factories.filter((f) => f.factoryType === FactoryType.AlgebraV3);
  const v2Factories = factories.filter((f) => f.factoryType === FactoryType.V2Standard);
  const solidlyV2Factories = factories.filter((f) => f.factoryType === FactoryType.SolidlyV2);
  const curveRegistries = factories.filter((f) => f.factoryType === FactoryType.CurveRegistry);
  const balancerFactories = factories.filter((f) => f.factoryType === FactoryType.BalancerV2);
  const dodoZoos = factories.filter((f) => f.factoryType === FactoryType.DODOZoo);
  const traderJoeFactories = factories.filter((f) => f.factoryType === FactoryType.TraderJoeLB);
  const maverickFactories = factories.filter((f) => f.factoryType === FactoryType.MaverickV2Factory);
  const woofiConfigs = factories.filter((f) => f.factoryType === FactoryType.WOOFi);

  // Discover all in parallel
  const [v3Pools, slipstreamPools, v4Pools, algebraPools, v2Pools, solidlyV2Pools,
         curvePools, balancerPools, dodoPools, traderJoePools,
         maverickPools, woofiPools] = await Promise.all([
    discoverV3Pools(tokenIn, tokenOut, client, v3Factories, feeTiers),
    discoverSlipstreamCLPools(tokenIn, tokenOut, client, slipstreamFactories),
    discoverV4Pools(tokenIn, tokenOut, client, v4Factories, feeTiers),
    discoverAlgebraPools(tokenIn, tokenOut, client, algebraFactories),
    discoverV2Pools(tokenIn, tokenOut, client, v2Factories),
    discoverSolidlyV2Pools(tokenIn, tokenOut, client, solidlyV2Factories),
    discoverCurvePools(tokenIn, tokenOut, client, curveRegistries),
    discoverBalancerV2Pools(tokenIn, tokenOut, client, balancerFactories),
    discoverDODOPools(tokenIn, tokenOut, client, dodoZoos),
    discoverTraderJoeLBPools(tokenIn, tokenOut, client, traderJoeFactories),
    discoverMaverickV2Pools(tokenIn, tokenOut, client, maverickFactories),
    discoverWOOFiPools(tokenIn, tokenOut, client, woofiConfigs),
  ]);

  // Algebra pools are EXECUTABLE: the engine implements algebraSwapCallback (sauce#186), so
  // a pool surfaced as a UniV3 row is cooked via swapV3 and the mid-swap input pull is
  // serviced. They are INCLUDED in the executable set returned to the recipes. See
  // discoverAlgebraPools' header + FactoryType.AlgebraV3 + LIQUIDITY_SOURCES_FEASIBILITY.md §3.
  // Slipstream CL pools are V3-priced and V3-executable (swapV3 via uniswapV3SwapCallback), so they
  // sit alongside the V3 pools in the executable set — discovered by tickSpacing key with their own
  // fee() read. See discoverSlipstreamCLPools + FactoryType.SlipstreamCL.
  return [
    ...v3Pools, ...slipstreamPools, ...v4Pools, ...algebraPools, ...v2Pools, ...solidlyV2Pools,
    ...curvePools, ...balancerPools, ...dodoPools, ...traderJoePools,
    ...maverickPools, ...woofiPools,
  ];
}
