// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice INPUT-KEYED mock of the HyperEVM BBO READ PRECOMPILE
/// (0x000000000000000000000000000000000000080e) — the oracle surface LiquidCore pools price off
/// (traced live on HyperEVM 2026-07-04: a WHYPE/USDT0 estimateSwap STATICCALLs the precompile TWICE,
/// once per spot-pair index — 10107 for the HYPE book, 10166 for the USDT0 book — and reads back two
/// 32-byte words (bid, ask)).
///
/// WIRE BEHAVIOR MIRRORED EXACTLY: the real precompile takes a RAW 32-byte spot-index input (NO
/// function selector) and returns abi.encode(bid, ask). This mock serves that raw shape through its
/// fallback (spot indexes are tiny integers, so calldata[0:4] is 0x00000000 and never collides with
/// the setter selector). The tests `setCode` this contract's RUNTIME at the CANONICAL precompile
/// address — the pool fixture (and the etched REAL pool in the prod-mirror) then reads the mock
/// exactly as it reads the chain's native precompile — and drive prices via `setBbo` (per-index,
/// mirroring the real chain's per-pair books; values re-settable for the drift cells).
///
/// An UNSET index returns (0, 0) — the pool's math then quotes 0 (the graceful drained-class stop),
/// matching how a delisted/garbage book would starve the pricing.
contract HLBboPrecompileMock {
    mapping(uint256 => uint256) public bid;
    mapping(uint256 => uint256) public ask;

    function setBbo(uint256 index, uint256 bid_, uint256 ask_) external {
        bid[index] = bid_;
        ask[index] = ask_;
    }

    // The RAW precompile surface: 32-byte spot index in, (bid, ask) out.
    fallback(bytes calldata input) external returns (bytes memory) {
        require(input.length == 32, "BBO-len");
        uint256 index = abi.decode(input, (uint256));
        return abi.encode(bid[index], ask[index]);
    }
}
