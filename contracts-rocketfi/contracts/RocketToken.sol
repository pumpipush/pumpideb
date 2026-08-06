// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// RocketFi — RocketToken
// Minimal ERC-20 deployed by TokenLauncher for each new launch.

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RocketToken is ERC20 {
    constructor(
        string memory tokenName_,
        string memory tokenSymbol_,
        uint256 initialSupply
    ) ERC20(tokenName_, tokenSymbol_) {
        _mint(msg.sender, initialSupply);
    }
}
