// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * EKUBO V3 local fixtures — the EXACT E0-frozen recipe surfaces of the v3.1.1 Core +
 * MEVCaptureRouter over a DETERMINISTIC curve, so the local EVM tests exercise the production
 * discovery → plain-CALL quote ladder → full-fill exec path with a bit-exact TS replay
 * (ecoswap.ekubo.evm.test.ts `fixtureGetDy`). NOT the genuine bytecode (the prod-mirror etches
 * that); what is FAITHFUL here is every surface the recipe touches:
 *
 *   Core (EkuboCoreFixture):
 *   - VIRTUAL pools keyed by poolId = keccak256(abi.encode(token0, token1, config)) — the REAL
 *     derivation, so production `discoverEkuboPoolsTyped` runs against the fixture unchanged.
 *   - the RAW-key `sload` batch surface (selector 0x380eb4e0 ++ N×32-byte keys, NOT ABI-encoded;
 *     dispatched in the fallback) returning a packed poolState word per key — sqrtRatio(u96 stub)
 *     | tick(i32, 0) | liquidity(u128) for a registered pool, ZERO for anything else (the
 *     uninitialized-candidate class discovery drops).
 *   - the TILL custody: the Core HOLDS every pool's inventory; the router pulls the input INTO
 *     Core (transferFrom) and pays the output OUT of Core (`pay`, router-only) — the real
 *     flash-accounting settlement shape without the transient debt ledger.
 *
 *   Router (EkuboRouterFixture):
 *   - quote((address,address,bytes32),bool,int128,uint96,uint256) → (bytes32,bytes32) — selector
 *     0x3bc52842 (signature-identical to the real router). NONPAYABLE and WRITES a probe nonce
 *     before computing, so a STATICCALL context breaks it exactly like the real lock protocol's
 *     TSTOREs — the recipe MUST plain-CALL it (the property the fixture pins). Reverts
 *     PoolNotInitialized() (0x486aa307) for an unregistered key. An OVERSIZE exact-in
 *     PARTIAL-FILLS gracefully (consumed = min(amount, maxIn remaining)) — the real
 *     liquidity-exhausted class. Returns the packed PoolBalanceUpdate (delta0 int128 HIGH |
 *     delta1 int128 LOW; positive = pool receives, negative = owed).
 *   - swap(...,int256 threshold, address recipient) → bytes32 — selector 0xf196187f. The REAL
 *     overload semantics verbatim: UseSwapAllowPartialFill() when threshold == type(int256).min,
 *     PartialSwapsDisallowed() when consumed != specified, SlippageCheckFailed(int256,int256)
 *     below threshold; pulls EXACTLY consumed via transferFrom(msg.sender → Core) and pays the
 *     out from Core to the recipient.
 *
 * THE DETERMINISTIC CURVE (replayed bit-exact off-chain): constant-product with the REAL Ekubo
 * fee semantics — fee is a u64 0.64-fixed fraction charged on the INPUT with a CEIL
 * (feeAmt = ceil(consumed·fee / 2^64), the src/math/fee.sol computeFee shape), the net moves the
 * curve: out = floor(net·rOut / (rIn + net)). Reserves track the NET input (fees accrue to the
 * till outside the curve — the feesPerLiquidity analogue). A per-side `maxIn` models the end of
 * initialized liquidity (consumed caps there; quote flatlines; the full-fill exec swaps only the
 * consumed amount).
 */

interface IERC20MinEk {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract EkuboCoreFixture {
    struct Pool {
        address token0;
        address token1;
        uint128 reserve0;
        uint128 reserve1;
        uint64 fee; // 0.64-fixed fee-on-input fraction (the real config fee word's semantics)
        uint128 maxIn0; // remaining fillable token0 input (the liquidity-exhaustion model)
        uint128 maxIn1; // remaining fillable token1 input
        bool initialized;
    }

    mapping(bytes32 => Pool) public pools;
    address public router;

    function setRouter(address r) external {
        router = r;
    }

    /** The REAL poolId derivation (types/poolKey.sol toPoolId): keccak over the 96-byte key. */
    function toPoolId(address token0, address token1, bytes32 config) public pure returns (bytes32) {
        return keccak256(abi.encode(token0, token1, config));
    }

    /** Register a virtual pool (test-only). The caller funds the Core with the inventory. */
    function registerPool(
        address token0,
        address token1,
        bytes32 config,
        uint128 reserve0,
        uint128 reserve1,
        uint64 fee,
        uint128 maxIn0,
        uint128 maxIn1
    ) external returns (bytes32 poolId) {
        require(token0 < token1, "sorted");
        poolId = toPoolId(token0, token1, config);
        pools[poolId] = Pool(token0, token1, reserve0, reserve1, fee, maxIn0, maxIn1, true);
    }

    /** Force a pool's reserves (the drift/drained cells). */
    function setReserves(bytes32 poolId, uint128 reserve0, uint128 reserve1) external {
        pools[poolId].reserve0 = reserve0;
        pools[poolId].reserve1 = reserve1;
    }

    /** Router-only till payout (the withdraw() analogue). */
    function pay(address token, address to, uint256 amount) external {
        require(msg.sender == router, "router");
        require(IERC20MinEk(token).transfer(to, amount), "pay");
    }

    /** Router-only curve state advance after a landed swap. */
    function applySwap(bytes32 poolId, bool isToken1, uint128 netIn, uint128 out, uint128 consumed) external {
        require(msg.sender == router, "router");
        Pool storage p = pools[poolId];
        if (isToken1) {
            p.reserve1 += netIn;
            p.reserve0 -= out;
            p.maxIn1 -= consumed;
        } else {
            p.reserve0 += netIn;
            p.reserve1 -= out;
            p.maxIn0 -= consumed;
        }
    }

    /**
     * The RAW-key batch `sload` surface (ExposedStorage): calldata = selector 0x380eb4e0 ++
     * N×32-byte slot keys (NOT ABI-encoded); returns N concatenated words. A registered pool's
     * poolState slot (== its poolId) packs sqrtRatio(u96 stub, the 1.0-region tag) | tick(0) |
     * liquidity(u128 = min(reserves)); every other key reads 0 — exactly the discovery contract.
     */
    fallback(bytes calldata data) external returns (bytes memory) {
        require(data.length >= 4 && bytes4(data[0:4]) == 0x380eb4e0, "selector");
        uint256 n = (data.length - 4) / 32;
        bytes memory out = new bytes(n * 32);
        for (uint256 k = 0; k < n; k++) {
            bytes32 key = bytes32(data[4 + k * 32:4 + k * 32 + 32]);
            Pool storage p = pools[key];
            uint256 word = 0;
            if (p.initialized) {
                uint256 liq = p.reserve0 < p.reserve1 ? p.reserve0 : p.reserve1;
                word = (uint256(0x400000000000000000000000) << 160) | uint256(uint128(liq));
            }
            assembly {
                mstore(add(add(out, 32), mul(k, 32)), word)
            }
        }
        return out;
    }
}

contract EkuboRouterFixture {
    // The REAL PoolKey ABI shape — (address token0, address token1, bytes32 config) — so quote's
    // selector is the genuine 0x3bc52842 and swap's the genuine 0xf196187f.
    struct PoolKey {
        address token0;
        address token1;
        bytes32 config;
    }

    // The REAL revert classes (E0-enumerated).
    error PoolNotInitialized(); // 0x486aa307 (Core class — surfaced through the router)
    error PartialSwapsDisallowed();
    error UseSwapAllowPartialFill();
    error SlippageCheckFailed(int256 expectedAmount, int256 calculatedAmount);

    EkuboCoreFixture public immutable CORE;
    /** Probe nonce — WRITTEN by quote so a STATICCALL context reverts (the real lock's TSTORE class). */
    uint256 public probeNonce;

    constructor(EkuboCoreFixture core) {
        CORE = core;
    }

    /** The deterministic curve: consumed = min(amount, maxIn); feeAmt = ceil(consumed·fee/2^64);
     *  out = floor(net·rOut/(rIn + net)). Mirrored bit-exact by the test-side TS replay. */
    function _compute(PoolKey memory key, bool isToken1, uint128 amount)
        internal
        view
        returns (bytes32 poolId, uint128 consumed, uint128 netIn, uint128 out)
    {
        poolId = CORE.toPoolId(key.token0, key.token1, key.config);
        (,, uint128 r0, uint128 r1, uint64 fee, uint128 maxIn0, uint128 maxIn1, bool init) = CORE.pools(poolId);
        if (!init) revert PoolNotInitialized();
        uint128 rIn = isToken1 ? r1 : r0;
        uint128 rOut = isToken1 ? r0 : r1;
        uint128 maxIn = isToken1 ? maxIn1 : maxIn0;
        consumed = amount <= maxIn ? amount : maxIn;
        uint256 feeAmt = (uint256(consumed) * fee + ((1 << 64) - 1)) >> 64; // ceil (computeFee)
        netIn = uint128(uint256(consumed) - feeAmt);
        if (rIn == 0 || rOut == 0 || netIn == 0) {
            out = 0;
        } else {
            out = uint128((uint256(netIn) * rOut) / (uint256(rIn) + netIn));
        }
    }

    function _pack(bool isToken1, uint128 consumed, uint128 out) internal pure returns (bytes32) {
        // PoolBalanceUpdate: delta0 int128 HIGH | delta1 int128 LOW; positive = the pool receives.
        int128 dIn = int128(consumed);
        int128 dOut = -int128(out);
        (int128 d0, int128 d1) = isToken1 ? (dOut, dIn) : (dIn, dOut);
        return bytes32((uint256(uint128(d0)) << 128) | uint256(uint128(d1)));
    }

    /**
     * quote — signature-identical to the real router (selector 0x3bc52842). NONPAYABLE + a state
     * write, so STATICCALL breaks it (the property the recipe's plain-CALL design rests on); the
     * write is a nonce, so back-to-back probe-then-decode CALLs return identical values (the real
     * quote is state-neutral via its internal revert-unwind). Exact-in only (the recipe never
     * quotes exact-out). sqrtRatioLimit/skipAhead accepted + ignored (the recipe always passes 0
     * — the real router substitutes the direction-correct unbounded limit for 0).
     */
    function quote(PoolKey memory poolKey, bool isToken1, int128 amount, uint96, uint256)
        external
        returns (bytes32 balanceUpdate, bytes32 stateAfter)
    {
        probeNonce++;
        require(amount > 0, "exact-in only");
        (bytes32 poolId, uint128 consumed,, uint128 out) = _compute(poolKey, isToken1, uint128(amount));
        balanceUpdate = _pack(isToken1, consumed, out);
        stateAfter = poolId; // informational (the recipe never reads it)
    }

    /**
     * swap — the REAL full-fill overload semantics verbatim (selector 0xf196187f): threshold ==
     * type(int256).min reverts UseSwapAllowPartialFill; consumed != specified reverts
     * PartialSwapsDisallowed; calculated < threshold reverts SlippageCheckFailed. Pulls EXACTLY
     * `consumed` via transferFrom(msg.sender → Core) and pays `out` from the Core till to the
     * recipient.
     */
    function swap(
        PoolKey memory poolKey,
        bool isToken1,
        int128 amount,
        uint96,
        uint256,
        int256 calculatedAmountThreshold,
        address recipient
    ) external payable returns (bytes32 balanceUpdate) {
        if (calculatedAmountThreshold == type(int256).min) revert UseSwapAllowPartialFill();
        require(amount > 0, "exact-in only");
        (bytes32 poolId, uint128 consumed, uint128 netIn, uint128 out) =
            _compute(poolKey, isToken1, uint128(amount));
        if (int128(consumed) != amount) revert PartialSwapsDisallowed();
        if (int256(uint256(out)) < calculatedAmountThreshold) {
            revert SlippageCheckFailed(calculatedAmountThreshold, int256(uint256(out)));
        }
        address tokenIn = isToken1 ? poolKey.token1 : poolKey.token0;
        address tokenOut = isToken1 ? poolKey.token0 : poolKey.token1;
        require(IERC20MinEk(tokenIn).transferFrom(msg.sender, address(CORE), consumed), "pull");
        CORE.applySwap(poolId, isToken1, netIn, out, consumed);
        if (out > 0) CORE.pay(tokenOut, recipient, out);
        balanceUpdate = _pack(isToken1, consumed, out);
    }
}
