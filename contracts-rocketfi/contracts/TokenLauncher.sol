// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// RocketFi — TokenLauncher
// Deploys a new ERC-20 token and registers it on the RocketFi bonding curve
// in a single transaction.

import "./RocketToken.sol";

interface IRocketFi {
    function createPool(address token, uint256 amount) external payable;
    function getCreateFee() external view returns (uint256);
}

contract TokenLauncher {

    // ─── State ────────────────────────────────────────────────────────────────

    address public owner;
    address public rocketFiContract;

    uint256 public constant INITIAL_AMOUNT = 10 ** 27;
    uint256 public currentTokenIndex = 0;

    struct TokenRecord {
        address tokenAddress;
        string  tokenName;
        string  tokenSymbol;
        uint256 totalSupply;
        address creator;
    }

    TokenRecord[] public tokens;

    // ─── Events ───────────────────────────────────────────────────────────────

    event TokenLaunched(address indexed tokenAddress, address indexed creator, string name, string symbol);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PoolAddressUpdated(address indexed newAddress);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "TokenLauncher: Not Owner");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor() {
        // FIX: owner is now set at deploy time.
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ─── Core ─────────────────────────────────────────────────────────────────

    /// @notice Deploy a new RocketToken and register it on the RocketFi bonding curve.
    /// @param name   Human-readable token name (e.g. "Doge Killer").
    /// @param ticker Token symbol (e.g. "DGKL").
    function launchToken(string memory name, string memory ticker) external payable {
        require(rocketFiContract != address(0), "TokenLauncher: Pool not configured");

        uint256 creationFee = IRocketFi(rocketFiContract).getCreateFee();
        require(msg.value >= creationFee, "TokenLauncher: Insufficient fee");

        // Deploy token — minted to THIS contract so it can approve & create the pool
        RocketToken token = new RocketToken(name, ticker, INITIAL_AMOUNT);

        // Approve RocketFi to pull the entire supply
        token.approve(rocketFiContract, INITIAL_AMOUNT);

        // Register in storage before external call (CEI)
        tokens.push(TokenRecord({
            tokenAddress: address(token),
            tokenName:    name,
            tokenSymbol:  ticker,
            totalSupply:  INITIAL_AMOUNT,
            creator:      msg.sender
        }));
        currentTokenIndex++;

        emit TokenLaunched(address(token), msg.sender, name, ticker);

        // External call: create pool on RocketFi
        IRocketFi(rocketFiContract).createPool{value: creationFee}(address(token), INITIAL_AMOUNT);

        // Refund any excess ETH to the caller
        uint256 excess = msg.value - creationFee;
        if (excess > 0) {
            payable(msg.sender).transfer(excess);
        }
    }

    // ─── Owner Admin ──────────────────────────────────────────────────────────

    /// @notice Set the RocketFi bonding curve contract address.
    /// @dev FIX: was publicly callable by anyone in the original — now owner-only.
    function setPoolAddress(address newAddr) external onlyOwner {
        require(newAddr != address(0), "TokenLauncher: Zero address");
        rocketFiContract = newAddr;
        emit PoolAddressUpdated(newAddr);
    }

    function transferOwnership(address newAddr) external onlyOwner {
        require(newAddr != address(0), "TokenLauncher: Zero address");
        emit OwnershipTransferred(owner, newAddr);
        owner = newAddr;
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getTokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function getToken(uint256 index) external view returns (TokenRecord memory) {
        require(index < tokens.length, "TokenLauncher: Index out of range");
        return tokens[index];
    }
}
