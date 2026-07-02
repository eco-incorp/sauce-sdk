// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Minimal dependency-free ERC20 with an unrestricted `mint` AND the burn surface a Mento stable
/// asset exposes to the Broker (`burn(uint256)` burns the caller's balance; `burn(address,uint256)` burns
/// from an account). Used to REPOINT a Mento STABLE token (e.g. cUSD) offline: Mento's Broker transferIn for
/// a stable tokenIn does `transferFrom(sender, broker, amount)` then `IBurnableERC20(token).burn(amount)`
/// (burns the broker's own balance) — a plain MintableERC20 has no `burn` so swapIn reverts. This fixture
/// carries EXACTLY the transferFrom + burn surface that path calls, so the REAL Broker bytecode can move the
/// repointed token wei-exactly (the token ERC20 semantics are NOT part of Mento's bucket/oracle pricing).
contract MintableBurnableERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    /// @notice Unrestricted mint (test helper). Mints `amount` to `to`.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burn `amount` from the caller (the Mento Broker's `IBurnableERC20.burn(uint256)` on a stable
    /// tokenIn, after it has transferFrom'd the input to itself).
    function burn(uint256 amount) external returns (bool) {
        _burn(msg.sender, amount);
        return true;
    }

    /// @notice Burn `amount` from `from` (the alternate stable-burn surface some Mento versions call).
    function burn(address from, uint256 amount) external returns (bool) {
        _burn(from, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ERC20: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "ERC20: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        require(balanceOf[from] >= amount, "ERC20: insufficient balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }
}
