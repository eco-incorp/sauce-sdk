// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The coin surface the CurveRegistryMock introspects on a registered pool — matches the
/// CurveStableSwap fixture (coins(k) + nCoins()).
interface ICurveCoinsView {
    function coins(uint256 k) external view returns (address);

    function nCoins() external view returns (uint256);
}

/// PAIR-AWARE Curve MetaRegistry mock — the discovery surface `discoverCurvePoolsTyped` reads
/// (find_pool_for_coins / get_coin_indices / get_n_coins), keyed by UNORDERED token pair so a
/// query for an UNREGISTERED pair returns address(0) (the real registry semantics). This is what
/// the etch-based constant-response shim (harness/etch-pool.ts buildCurveMetaRegistryShimRuntime)
/// cannot do: that shim answers every pair with the one captured pool, which is fine for a
/// single-pair prod-mirror but WRONG for a multi-edge route test (the same pool would surface on
/// every edge). get_coin_indices resolves i/j DIRECTIONALLY by scanning the pool's own coins(k)
/// — so one registered multi-coin pool (e.g. a 3-coin {A, X, B} fixture) yields the correct
/// per-edge orientation on every pair it is registered for (the leg-QL claims tests rely on
/// exactly that). `get_decimals` is deliberately ABSENT: the call reverts and discovery falls
/// back to per-coin decimals() reads (the fixture tokens are 18-dec MintableERC20s).
contract CurveRegistryMock {
    mapping(bytes32 => address) private _pools;

    function _key(address a, address b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// Register `pool` for the unordered (a, b) pair. One pool per pair (last write wins);
    /// register the SAME pool under several pairs to model a multi-coin pool's reachability.
    function register(address a, address b, address pool) external {
        _pools[_key(a, b)] = pool;
    }

    function find_pool_for_coins(address from, address to) external view returns (address) {
        return _pools[_key(from, to)];
    }

    function get_coin_indices(address pool, address from, address to)
        external
        view
        returns (int128 i, int128 j, bool underlying)
    {
        uint256 n = ICurveCoinsView(pool).nCoins();
        int128 fi = -1;
        int128 ti = -1;
        for (uint256 k = 0; k < n; k++) {
            address c = ICurveCoinsView(pool).coins(k);
            if (c == from) fi = int128(int256(k));
            if (c == to) ti = int128(int256(k));
        }
        require(fi >= 0 && ti >= 0, "coin not in pool");
        return (fi, ti, false);
    }

    function get_n_coins(address pool) external view returns (uint256) {
        return ICurveCoinsView(pool).nCoins();
    }
}

/// PAIR-AWARE Maverick V2 factory mock — the `lookup(tokenA, tokenB, startIndex, endIndex)`
/// pagination surface `discoverMaverickV2PoolsTyped` reads, keyed by UNORDERED pair (discovery
/// queries both orderings and dedupes). An unregistered pair returns an empty page — unlike the
/// etch-based constant shim (buildMaverickFactoryShimRuntime), which answers every pair with the
/// one captured pool and would surface it on every route edge.
contract MaverickFactoryMock {
    mapping(bytes32 => address[]) private _pools;

    function _key(address a, address b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function register(address tokenA, address tokenB, address pool) external {
        _pools[_key(tokenA, tokenB)].push(pool);
    }

    function lookup(address tokenA, address tokenB, uint256 startIndex, uint256 endIndex)
        external
        view
        returns (address[] memory pools)
    {
        address[] storage all = _pools[_key(tokenA, tokenB)];
        if (startIndex >= all.length || endIndex <= startIndex) return new address[](0);
        uint256 end = endIndex > all.length ? all.length : endIndex;
        pools = new address[](end - startIndex);
        for (uint256 k = startIndex; k < end; k++) {
            pools[k - startIndex] = all[k];
        }
    }
}
