/**
 * EKUBO V3 (EkuboProtocol/evm-contracts v3.1.1 — a bespoke till-based flash-accounting singleton CL
 * AMM: ONE Core holds every pool as a storage-keyed VIRTUAL pool; micro-ticks base 1.000001 with a
 * uint96 compact-float SqrtRatio) — QUOTE-LADDER (QL) model over the periphery Router's LIVE `quote`.
 *
 * THE SINGLE SOURCE for how an Ekubo venue is modeled off-chain. Ekubo is a QUOTE-LADDER family
 * (segKind 21): prepare ships ONLY a descriptor (router, token0, token1, config, isToken1, poolId)
 * — NO sampled segments AND NO port of Ekubo's bespoke math (micro-ticks, region-quantized
 * compact-float sqrt ratios, 0.64-fixed fee-on-input with ceil gross-ups — that port is exactly what
 * this design avoids) — and the on-chain solver builds each venue's price ladder in setup from LIVE
 * cook-time `Router.quote(...)` quote-differencing (the SAME curve-agnostic `buildQLLadder`
 * recurrence every other QL family runs). The quote EXECUTES THE REAL POOL MATH in simulation
 * (it performs the swap inside a lock and unwinds via an internal QuoteReturnValue revert), so the
 * ladder is ground truth at any input by construction. The neutral oracle (ecoswap.optimal.ts)
 * mirrors it via `buildEkuboQLLadder` below, driven by a caller-supplied `getDy` quote model (a
 * bit-exact fixture replay in the local tests; a prefetched real-router quote grid in the
 * prod-mirror), so solver == oracle — one recurrence, one grid.
 *
 * REAL ON-CHAIN SURFACE (v3.1.1 sources line-verified + re-probed live on ETH mainnet 2026-07-04;
 * selectors recomputed AND grepped present in the DEPLOYED MEVCaptureRouter runtime; the 7-arg swap
 * fork-EXECUTED wei-exact vs its own same-state quote — the E0 freeze record):
 *
 *   Router.quote(PoolKey poolKey, bool isToken1, int128 amount, SqrtRatio sqrtRatioLimit,
 *       uint256 skipAhead) returns (PoolBalanceUpdate balanceUpdate, PoolState stateAfter)
 *     — selector 0x3bc52842 (PoolKey ABI-encodes as (address token0, address token1, bytes32
 *       config); SqrtRatio is uint96; PoolBalanceUpdate/PoolState are bytes32). NOT view (the lock
 *       protocol TSTOREs) ⇒ the on-chain solver calls it with a PLAIN CALL (the recipe ABI marks it
 *       nonpayable — the Fluid-estimateSwapIn / Metric-quoteSwap class; a STATICCALL context breaks
 *       the lock). The inner lock unwinds via `revert QuoteReturnValue(...)` caught by
 *       `lockAndExpectRevert`, so the CALL is state-neutral on completion and safe to issue twice
 *       (the solver's PROBE-THEN-DECODE). amount > 0 = EXACT IN of the isToken1-denominated token
 *       (re-probed: +1000e18 USDe → delta0 +1000e18 / delta1 −998e6); sqrtRatioLimit 0 ⇒ the router
 *       substitutes the DIRECTION-CORRECT MIN/MAX bound (`withDefaultSqrtRatioLimit`, source-
 *       verified), so a 0 limit is never wrong-side. REVERT CLASSES (enumerated): an UNINITIALIZED
 *       pool (a preset candidate that was never created) reverts `PoolNotInitialized()` 0x486aa307
 *       (probed live); an OVERSIZE exact-in past the pool's whole initialized liquidity is GRACEFUL
 *       — a PARTIAL fill (probed: 300M USDe in → consumed ≈360k, stateAfter.liquidity = 0), so the
 *       differenced ladder flatlines and stops; `SqrtRatioLimitWrongDirection()` 0xa574a6b4 is
 *       unreachable from this recipe (limit is always 0).
 *
 *   PoolBalanceUpdate (ONE bytes32): delta0 int128 in the HIGH 128 bits, delta1 int128 in the LOW
 *       128 bits (source: types/poolBalanceUpdate.sol — signextend decode). POSITIVE = the pool
 *       RECEIVES (the consumed input); NEGATIVE = owed to the swapper (the output; two's complement
 *       IN ITS 128-BIT LANE — the solver decodes |out| = 2^128 − lane, NOT a 256-bit neg). For
 *       exact-in: isToken1=false ⇒ in = +delta0 (high), out = −delta1 (low); isToken1=true ⇒
 *       in = +delta1 (low), out = −delta0 (high). The IN delta returns the amount actually CONSUMED
 *       (< specified on a partial fill) — the EXEC swaps exactly that consumed amount.
 *
 *   Router.swap(PoolKey poolKey, bool isToken1, int128 amount, SqrtRatio sqrtRatioLimit,
 *       uint256 skipAhead, int256 calculatedAmountThreshold, address recipient)
 *     — selector 0xf196187f (present in the deployed runtime; fork-executed end-to-end). The
 *       EXEC-OPTION-A full-fill overload (E0 PINNED — `swapAllowPartialFill` was verified to carry
 *       NO threshold parameter: every partial-fill overload hardcodes type(int256).min, DISABLING
 *       the slippage check, so the QL-family minOut discipline needs THIS overload): reverts
 *       `PartialSwapsDisallowed()` when consumed != amount, `SlippageCheckFailed(int256,int256)`
 *       when the calculated output < threshold, `UseSwapAllowPartialFill()` when threshold ==
 *       type(int256).min. The recipe exec QUOTES FIRST (same tx ⇒ same state ⇒ deterministic),
 *       swaps `amount = the quoted CONSUMED` (so the full-fill check holds even when the award
 *       exceeds the pool's live capacity — the unconsumed remainder strands for the terminal
 *       refund) with `threshold = the quoted out` (never trips in-tx; fork-proven: received ==
 *       quote to the wei at threshold == quote). INPUT PULL: the router's `payFrom` does
 *       `token.transferFrom(swapper → Core)` of EXACTLY uint128(consumed) (source-verified;
 *       fork-proven allowance residue == 0) ⇒ approve(router, consumed) == pull, residue 0.
 *       Output is `withdraw`n from the Core till straight to `recipient`.
 *
 *   Core.sload (selector 0x380eb4e0) — the ExposedStorage RAW-key batch read: calldata is the
 *       selector ++ N×32-byte slot keys (NOT ABI-encoded — abi-encoding the key REVERTS, re-probed),
 *       returns N concatenated storage words. poolState slot == poolId; the word packs
 *       sqrtRatio u96 (high) | tick int32 | liquidity u128 (low) — sqrtRatio != 0 ⇔ initialized.
 *       Discovery liveness-probes EVERY preset candidate in ONE such call.
 *
 * DISCOVERY is the V4-PRESET-CLONE (pure RPC, no HTTP API): PoolKey = (token0, token1, config) with
 * tokens sorted ascending; poolId = keccak256(pad32(token0) ‖ pad32(token1) ‖ config) — re-derived
 * live against 5/5 API-verified pool ids (E0). Config (bytes32) packs
 * extension address (bits 255..96) | fee uint64 (95..32) | poolTypeConfig uint32 (31..0), where
 * bit 31 = 1 ⇒ CONCENTRATED with tickSpacing in bits 30..0 (bit 31 = 0 is the stableswap family —
 * not in the preset menu yet). The preset FEE WORD is round(pct × 2^64) — CONFIRMED live for every
 * attested tier (0.003% = 553402322211287 == the probed 0x1f75104d551d7, …, 1% =
 * 184467440737095516). The frozen menu below reproduced ALL live ETH pools probed 2026-07-04
 * (USDe/USDC 0.003%/100 id 0xc86d5ef1…, USDe/sUSDe 0.01%/100 id 0xe5be1568…, ETH/USDC 0.05%/4988 id
 * 0xde39735c…, ETH/USDT 0.05%/4988 id 0x77e86b8f…, ETH/WBTC 0.1%/1000 id 0x030e0b87…, plus the
 * 0.3%/0.5%/1% side tiers). Scope guards: extension == 0 BY CONSTRUCTION (the menu carries no
 * extension ⇒ MEVCapture-extension pools are excluded — their direct swap path adds a same-block
 * dynamic anti-MEV fee, quote-vs-cook drift; <$60k TVL today); native-ETH pools (token0 ==
 * address(0) — Ekubo's deepest ETH pairs) are PHASE-2 (the recipe's custody is ERC20 approve+swap;
 * a native leg needs the value-carrying `contract.call` + WETH unwrap/wrap — deferred, cannot arise
 * here since both recipe tokens are ERC20 contracts).
 *
 * VIRTUAL-POOL CLAIMS: every Ekubo pool lives inside the ONE Core and is executed through the ONE
 * router, so the pool-ADDRESS claim key is meaningless — the claim key is the POOLID
 * (`ekubo|<poolId>`, see prepare.ts qlVenueClaimKey), which admits each virtual pool's inventory
 * exactly once (direct XOR one route leg) while letting several same-pair fee tiers compete as
 * independent venues.
 *
 * INT128 CLAMP: quote/swap amounts are int128 — the ladder/exec clamp at EKUBO_INT128_MAX before
 * the call (the compiler encodes uint256 args into narrower ABI slots by low-byte truncation — the
 * Metric precedent). CHAIN GATE: Ekubo runtime uses the CLZ opcode (EIP-7939) — live on ETH
 * mainnet; the same create3 addresses exist on Base/Arbitrum/OP-stack chains but stay DORMANT until
 * each chain activates Osaka, so chain expansion is config-gated per chain (E6).
 *
 * Addresses (ETH mainnet, release v3.1.1, all cast-verified live 2026-07-04):
 *   Core (singleton)   0x00000000000014aA86C5d3c41765bb24e11bd701 (18797 B)
 *   MEVCaptureRouter   0xd26f20001a72a18C002b00e6710000d68700ce00 (11122 B; extends Router — the
 *                      extension==0 path is the base `CORE.swap`, source-verified identical)
 */
import { keccak256, encodeAbiParameters } from "viem";
import { buildQLLadder } from "./curve-math.js";
/** The int128 clamp bound for quote/swap amount args (2^127 − 1; see the header). */
export const EKUBO_INT128_MAX = (1n << 127n) - 1n;
/** Core.sload raw-key batch-read selector (ExposedStorage; selector ++ N×32-byte keys). */
export const EKUBO_SLOAD_SELECTOR = "0x380eb4e0";
/** fee u64 = round(num/den × 2^64) — the preset fee-word formula (confirmed vs every live tier). */
const feeWord = (num, den) => (num * (1n << 64n) + den / 2n) / den;
/**
 * The FROZEN canonical preset menu (E0 gate G1) — every (fee, tickSpacing) pair attested by a live
 * initialized ETH pool in the 2026-07-04 batch probe (ONE raw Core.sload over the fee×ts candidate
 * grid across the top pairs). Over-probing a dead combo is harmless (its poolState word reads 0 and
 * the candidate drops), so the menu leans inclusive; each entry costs one keccak + one word in the
 * single batched sload.
 */
export const EKUBO_DEFAULT_PRESETS = [
    { fee: feeWord(3n, 100000n), tickSpacing: 100 }, // 0.003%/100  — USDe/USDC + USDe/USDT (the top pool's tier)
    { fee: feeWord(1n, 10000n), tickSpacing: 100 }, //  0.01%/100  — USDe/sUSDe
    { fee: feeWord(1n, 10000n), tickSpacing: 200 }, //  0.01%/200  — ETH/wstETH
    { fee: feeWord(5n, 10000n), tickSpacing: 1000 }, // 0.05%/1000 — ETH/WBTC side tier
    { fee: feeWord(5n, 10000n), tickSpacing: 4988 }, // 0.05%/4988 — ETH/USDC + ETH/USDT (the volatile workhorse)
    { fee: feeWord(1n, 1000n), tickSpacing: 1000 }, //  0.1%/1000  — ETH/WBTC
    { fee: feeWord(3n, 1000n), tickSpacing: 4988 }, //  0.3%/4988  — ETH/USDC side tier
    { fee: feeWord(5n, 1000n), tickSpacing: 4988 }, //  0.5%/4988  — ETH/USDC side tier
    { fee: feeWord(5n, 1000n), tickSpacing: 100 }, //   0.5%/100   — USDC/USDT (initialized; a zero-L husk at the review re-probe — kept, dead candidates drop at the quote probe)
    { fee: feeWord(1n, 100n), tickSpacing: 19802 }, //   1%/19802   — EKUBO/USDC
    // APPEND-ONLY below (the [0] entry is index-referenced by ekubo-snapshot.ts + the prod-mirror).
    { fee: feeWord(5n, 1000000n), tickSpacing: 50 }, // 0.0005%/50 — USDT/USDC (the venue's TOP stable-stable tier: id 0x6fde3244…895d, ~$5.6M/24h, initialized + live L; review re-probe 2026-07-04)
];
/**
 * Pack a CONCENTRATED extension-0 pool config word: extension 0 (bits 255..96) | fee u64 (95..32) |
 * (1 << 31 | tickSpacing) (31..0). Mirrors src/types/poolConfig.sol bit-for-bit (E0-verified: the
 * packed word reproduces every probed live poolId).
 */
export function ekuboConcentratedConfig(fee, tickSpacing) {
    const word = (fee << 32n) | (1n << 31n) | BigInt(tickSpacing);
    return ("0x" + word.toString(16).padStart(64, "0"));
}
/**
 * poolId = keccak256(pad32(token0) ‖ pad32(token1) ‖ config) — src/types/poolKey.sol `toPoolId`
 * (keccak over the 96-byte ABI-encoded key). Re-derived live vs 5/5 API-verified ids (E0). ALSO the
 * pool's poolState storage slot in Core (CoreStorageLayout.poolStateSlot == the poolId verbatim).
 */
export function ekuboPoolId(token0, token1, config) {
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes32" }], [token0, token1, config]));
}
/** Diagnostic ppm from the u64 0.64-fixed fee word: round(fee × 1e6 / 2^64). */
export function ekuboFeePpm(fee) {
    return Number((fee * 1000000n + (1n << 63n)) / (1n << 64n));
}
/**
 * Decode one PoolBalanceUpdate word (bytes32 as bigint) into signed (delta0, delta1): delta0 =
 * int128 at the HIGH 128 bits, delta1 = int128 at the LOW 128 bits, each two's-complement IN ITS
 * LANE. Positive = the pool receives (consumed input); negative = owed (output). Mirrors
 * src/types/poolBalanceUpdate.sol; the on-chain solver decodes the same lanes with div/mod + the
 * 2^128-complement (never a 256-bit neg).
 */
export function decodeEkuboBalanceUpdate(word) {
    const HALF = 1n << 127n;
    const LANE = 1n << 128n;
    const hi = word >> 128n;
    const lo = word & (LANE - 1n);
    return {
        delta0: hi >= HALF ? hi - LANE : hi,
        delta1: lo >= HALF ? lo - LANE : lo,
    };
}
/**
 * The DETERMINISTIC cumulative-input grid the QL recurrence quotes at (== curve-math qlLadderInputs)
 * — the prod-mirror prefetches the REAL router's quotes at exactly these points, so the oracle's
 * lookup model covers every input the ladder build can ask for. Re-exported under the Ekubo name
 * for the prefetch contract's readability (the Fluid/Tessera/Metric convention).
 */
export { qlLadderInputs as ekuboQLGridInputs } from "./curve-math.js";
/**
 * Build one Ekubo venue's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the venue's `getDy` quote model, so the oracle stays wei-exact with the
 * on-chain solver by construction. The solver builds the IDENTICAL geometric ladder live from
 * `Router.quote(key, isToken1, +min(xNext, EKUBO_INT128_MAX), 0, 0)` (plain CALL, PROBE-THEN-DECODE
 * — a PoolNotInitialized/dead venue revert ⇒ a zero ladder; a flatlined partial-fill quote ⇒ the
 * differenced slice-out dies and the ladder stops). The quote is post-fee (fee-on-input inside the
 * swap math) so marginalOI IS the execution price. Emits the same {capacity, effOut, marginalOI}
 * slices the merged sampled-segment stream consumes.
 */
export function buildEkuboQLLadder(pool, amountIn) {
    return buildQLLadder((dx) => pool.getDy(dx), amountIn);
}
//# sourceMappingURL=ekubo-math.js.map