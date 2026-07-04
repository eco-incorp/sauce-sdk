// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20MinPS {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful PANCAKESWAP STABLESWAP 2-pool for the local EVM tests of the EcoSwap
/// segKind-20 quote-ladder path — mirrors pancake-smart-contracts/projects/stable-swap
/// (the BSC Solidity port of the LEGACY Curve StableSwap; VERIFIED source) on EVERY surface the
/// recipe touches, bit-for-bit with the off-chain `pancakestable-math.ts` replay:
///
///   - UINT256 coin indices: `get_dy(uint256,uint256,uint256)` and
///     `exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy)` — NOT the engine `_swapCurve`
///     int128 surface (the real pools revert the int128 selector; this fixture simply lacks it).
///   - LEGACY A precision: `Ann = A · N_COINS` (NO A_PRECISION multiply) in get_D/get_y — the
///     variant the real deployment compiles (verified in source), == curve-math getD/getY at
///     aPrecision = 1.
///   - RATES normalization: RATES[k] = PRECISION · 10^(MAX_DECIMAL − decimals[k]) folds mixed
///     decimals into the common 1e18 xp unit (the ctor takes rates directly, like the real
///     initialize() derives them).
///   - The TWO dy ROUNDING FORMS of the real source (they differ ±1 wei on mixed-decimal pools):
///     get_dy SCALES the raw dy first then takes the fee; exchange takes the fee on the RAW dy
///     then scales — reproduced exactly (the recipe's `min_dy = get_dy(Σ) − 1` exists for this).
///   - EMPTY-POOL REVERT class: a zero balance makes get_D's `D_P·D/(xp[k]·N)` divide by zero ⇒
///     get_dy REVERTS (the probe-then-decode liveness class the discovery + ladder rely on).
///   - `exchange` requires `!is_killed`, pulls EXACTLY dx via transferFrom (pull == approve ⇒
///     residue == 0 — asserted by the tests), takes the ADMIN fee out of the pool's booked
///     balance (balances[j] -= dy + dy_admin_fee, exactly the real bookkeeping), and pays the
///     post-fee dy to msg.sender.
///
/// The pool is pre-funded by the deployer with both coins' balances (it transfers coin j out on
/// exchange). `setKilled` is the one test hook (mirrors the real kill_me switch).
contract PancakeStableSwapPool {
    uint256 public constant N_COINS = 2;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant FEE_DENOMINATOR = 1e10;

    address[N_COINS] public coins;
    uint256[N_COINS] public balances;
    uint256[N_COINS] public RATES; // RATES[k] = 1e18 * 10**(18 - decimals[k])
    uint256 public fee; // 1e10-scaled swap fee
    uint256 public admin_fee; // 1e10-scaled share of the fee booked to admin
    bool public is_killed;

    uint256 private immutable _A; // RAW amplification (legacy: Ann = A * N_COINS)

    constructor(
        address[N_COINS] memory coins_,
        uint256[N_COINS] memory balances_,
        uint256[N_COINS] memory rates_,
        uint256 a_,
        uint256 fee_,
        uint256 adminFee_
    ) {
        coins = coins_;
        balances = balances_;
        RATES = rates_;
        _A = a_;
        fee = fee_;
        admin_fee = adminFee_;
    }

    /// @notice Raw amplification (no ramp modeled — the tests read a constant A, like a pool
    /// whose future_A_time has passed).
    function A() external view returns (uint256) {
        return _A;
    }

    /// @notice Test hook mirroring the real kill_me switch (a killed pool reverts exchange; the
    /// real get_dy still answers but the recipe's probe-then-decode covers the exchange class).
    function setKilled(bool killed) external {
        is_killed = killed;
    }

    // ── StableSwap math (LEGACY A_PRECISION = 1 — mirrors the real TwoPool + curve-math @ 1) ──

    function _xp() internal view returns (uint256[N_COINS] memory xp) {
        for (uint256 k = 0; k < N_COINS; k++) {
            xp[k] = (balances[k] * RATES[k]) / PRECISION;
        }
    }

    function get_D(uint256[N_COINS] memory xp, uint256 amp) internal pure returns (uint256) {
        uint256 S;
        for (uint256 k = 0; k < N_COINS; k++) {
            S += xp[k];
        }
        if (S == 0) return 0;

        uint256 Dprev;
        uint256 D = S;
        uint256 Ann = amp * N_COINS;
        for (uint256 it = 0; it < 255; it++) {
            uint256 D_P = D;
            for (uint256 k = 0; k < N_COINS; k++) {
                // If a balance is 0 this divides by zero and REVERTS — the real empty-pool class.
                D_P = (D_P * D) / (xp[k] * N_COINS);
            }
            Dprev = D;
            D = ((Ann * S + D_P * N_COINS) * D) / ((Ann - 1) * D + (N_COINS + 1) * D_P);
            if (D > Dprev) {
                if (D - Dprev <= 1) break;
            } else {
                if (Dprev - D <= 1) break;
            }
        }
        return D;
    }

    function get_y(uint256 i, uint256 j, uint256 x, uint256[N_COINS] memory xp_)
        internal
        view
        returns (uint256)
    {
        require((i != j) && (i < N_COINS) && (j < N_COINS), "Illegal parameter");
        uint256 amp = _A;
        uint256 D = get_D(xp_, amp);
        uint256 c = D;
        uint256 S_;
        uint256 Ann = amp * N_COINS;

        uint256 _x;
        for (uint256 k = 0; k < N_COINS; k++) {
            if (k == i) {
                _x = x;
            } else if (k != j) {
                _x = xp_[k];
            } else {
                continue;
            }
            S_ += _x;
            c = (c * D) / (_x * N_COINS);
        }
        c = (c * D) / (Ann * N_COINS);
        uint256 b = S_ + D / Ann;
        uint256 yPrev;
        uint256 y = D;

        for (uint256 it = 0; it < 255; it++) {
            yPrev = y;
            y = (y * y + c) / (2 * y + b - D);
            if (y > yPrev) {
                if (y - yPrev <= 1) break;
            } else {
                if (yPrev - y <= 1) break;
            }
        }
        return y;
    }

    /// @notice The VIEW form — SCALE the raw dy first, then net the fee (the real get_dy).
    function get_dy(uint256 i, uint256 j, uint256 dx) public view returns (uint256) {
        uint256[N_COINS] memory rates = RATES;
        uint256[N_COINS] memory xp = _xp();

        uint256 x = xp[i] + ((dx * rates[i]) / PRECISION);
        uint256 y = get_y(i, j, x, xp);
        if (xp[j] <= y + 1) return 0;
        uint256 dy = ((xp[j] - y - 1) * PRECISION) / rates[j];
        uint256 _fee = (fee * dy) / FEE_DENOMINATOR;
        return dy - _fee;
    }

    /// @notice The EXCHANGE form — fee on the RAW dy, then scale; admin fee out of the booked
    /// balance; pulls EXACTLY dx via transferFrom (pull == approve). Mirrors the real exchange
    /// verbatim (minus the BNB branch — no BSC stable pool the recipe targets holds native BNB).
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external {
        require(!is_killed, "Killed");
        uint256[N_COINS] memory old_balances = balances;
        uint256[N_COINS] memory xp = _xp();

        uint256 x = xp[i] + (dx * RATES[i]) / PRECISION;
        uint256 y = get_y(i, j, x, xp);

        uint256 dy = xp[j] - y - 1; // -1 just in case there were some rounding errors
        uint256 dy_fee = (dy * fee) / FEE_DENOMINATOR;

        // Convert all to real units
        dy = ((dy - dy_fee) * PRECISION) / RATES[j];
        require(dy >= min_dy, "Exchange resulted in fewer coins than expected");

        uint256 dy_admin_fee = (dy_fee * admin_fee) / FEE_DENOMINATOR;
        dy_admin_fee = (dy_admin_fee * PRECISION) / RATES[j];

        // Change balances exactly in same way as we change actual ERC20 coin amounts
        balances[i] = old_balances[i] + dx;
        // When rounding errors happen, we undercharge admin fee in favor of LP
        balances[j] = old_balances[j] - dy - dy_admin_fee;

        require(IERC20MinPS(coins[i]).transferFrom(msg.sender, address(this), dx), "in");
        require(IERC20MinPS(coins[j]).transfer(msg.sender, dy), "out");
    }
}

/// @notice Faithful PancakeStableSwapFactory registry for the discovery tests — the REAL
/// getPairInfo surface (VERIFIED source): sortTokens internally (ORDER-INDEPENDENT; identical
/// addresses revert), the ZERO struct for an unknown pair (no revert), token0/token1 the SORTED
/// pair (== the pool's coins order), plus the pairLength/swapPairContract enumeration.
contract PancakeStableSwapFactoryMock {
    struct StableSwapPairInfo {
        address swapContract;
        address token0;
        address token1;
        address LPContract;
    }

    mapping(address => mapping(address => StableSwapPairInfo)) private pairInfo;
    mapping(uint256 => address) public swapPairContract;
    uint256 public pairLength;

    function sortTokens(address tokenA, address tokenB)
        internal
        pure
        returns (address token0, address token1)
    {
        require(tokenA != tokenB, "IDENTICAL_ADDRESSES");
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    /// @notice Register a deployed pool under its (sorted) pair — mirrors addPairInfoInternal.
    function addPair(address pool, address tokenA, address tokenB, address lp) external {
        (address t0, address t1) = sortTokens(tokenA, tokenB);
        StableSwapPairInfo storage info = pairInfo[t0][t1];
        info.swapContract = pool;
        info.token0 = t0;
        info.token1 = t1;
        info.LPContract = lp;
        swapPairContract[pairLength] = pool;
        pairLength += 1;
    }

    function getPairInfo(address tokenA, address tokenB)
        external
        view
        returns (StableSwapPairInfo memory info)
    {
        (address t0, address t1) = sortTokens(tokenA, tokenB);
        info = pairInfo[t0][t1];
    }
}
