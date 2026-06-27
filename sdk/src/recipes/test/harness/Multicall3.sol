// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Multicall3
/// @notice Canonical Multicall3 (subset) — aggregate3 is what viem's
///         client.multicall uses. Compiled locally and etched at the canonical
///         address (0xcA11...CA11) for the no-fork harness, since this anvil
///         build does not pre-deploy it.
/// @dev Faithful reimplementation of the public Multicall3 interface used by
///      viem: aggregate3((address,bool,bytes)[]) returns ((bool,bytes)[]).
contract Multicall3 {
    struct Call {
        address target;
        bytes callData;
    }

    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Call3Value {
        address target;
        bool allowFailure;
        uint256 value;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate(Call[] calldata calls)
        public
        payable
        returns (uint256 blockNumber, bytes[] memory returnData)
    {
        blockNumber = block.number;
        uint256 length = calls.length;
        returnData = new bytes[](length);
        Call calldata call;
        for (uint256 i = 0; i < length;) {
            bool success;
            call = calls[i];
            (success, returnData[i]) = call.target.call(call.callData);
            require(success, "Multicall3: call failed");
            unchecked { ++i; }
        }
    }

    function aggregate3(Call3[] calldata calls)
        public
        payable
        returns (Result[] memory returnData)
    {
        uint256 length = calls.length;
        returnData = new Result[](length);
        Call3 calldata calli;
        for (uint256 i = 0; i < length;) {
            Result memory result = returnData[i];
            calli = calls[i];
            (result.success, result.returnData) = calli.target.call(calli.callData);
            assembly {
                if iszero(or(calldataload(add(calli, 0x20)), mload(result))) {
                    mstore(0x00, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(0x04, 0x0000000000000000000000000000000000000000000000000000000000000020)
                    mstore(0x24, 0x0000000000000000000000000000000000000000000000000000000000000017)
                    mstore(0x44, 0x4d756c746963616c6c333a2063616c6c206661696c656400000000000000)
                    revert(0x00, 0x64)
                }
            }
            unchecked { ++i; }
        }
    }

    function aggregate3Value(Call3Value[] calldata calls)
        public
        payable
        returns (Result[] memory returnData)
    {
        uint256 valAccumulator;
        uint256 length = calls.length;
        returnData = new Result[](length);
        Call3Value calldata calli;
        for (uint256 i = 0; i < length;) {
            Result memory result = returnData[i];
            calli = calls[i];
            uint256 val = calli.value;
            unchecked { valAccumulator += val; }
            (result.success, result.returnData) = calli.target.call{value: val}(calli.callData);
            assembly {
                if iszero(or(calldataload(add(calli, 0x40)), mload(result))) {
                    mstore(0x00, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(0x04, 0x0000000000000000000000000000000000000000000000000000000000000020)
                    mstore(0x24, 0x0000000000000000000000000000000000000000000000000000000000000017)
                    mstore(0x44, 0x4d756c746963616c6c333a2063616c6c206661696c656400000000000000)
                    revert(0x00, 0x64)
                }
            }
            unchecked { ++i; }
        }
        require(msg.value == valAccumulator, "Multicall3: value mismatch");
    }

    function getBlockNumber() public view returns (uint256 blockNumber) {
        blockNumber = block.number;
    }

    function getChainId() public view returns (uint256 chainid) {
        chainid = block.chainid;
    }
}
