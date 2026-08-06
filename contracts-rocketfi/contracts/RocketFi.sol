// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ██████╗  ██████╗  ██████╗██╗  ██╗███████╗████████╗███████╗██╗
// ██╔══██╗██╔═══██╗██╔════╝██║ ██╔╝██╔════╝╚══██╔══╝██╔════╝██║
// ██████╔╝██║   ██║██║     █████╔╝ █████╗     ██║   █████╗  ██║
// ██╔══██╗██║   ██║██║     ██╔═██╗ ██╔══╝     ██║   ██╔══╝  ██║
// ██║  ██║╚██████╔╝╚██████╗██║  ██╗███████╗   ██║   ██║     ██║
// ╚═╝  ╚═╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝     ╚═╝
//
// RocketFi — EVM Token Launchpad with Bonding Curve
// https://rocketfi.io

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IUniswapV2Factory {
    function createPair(
        address tokenA,
        address tokenB
    ) external returns (address pair);
}

interface IUniswapV2Router02 {
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external;

    function factory() external pure returns (address);

    function WETH() external pure returns (address);

    function addLiquidityETH(
        address token,
        uint amountTokenDesired,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    )
        external
        payable
        returns (uint amountToken, uint amountETH, uint liquidity);
}

contract RocketFi is ReentrancyGuard {
    receive() external payable {}

    // ─── State ────────────────────────────────────────────────────────────────

    address private owner;
    address private feeRecipient;
    uint256 private initialVirtualTokenReserves;
    uint256 private initialVirtualEthReserves;

    uint256 private tokenTotalSupply;
    uint256 private mcapLimit;
    uint256 private feeBasisPoint;
    uint256 private createFee;

    IUniswapV2Router02 private uniswapV2Router;

    // ─── Data Structures ─────────────────────────────────────────────────────

    struct Profile {
        address user;
        Token[] tokens;
    }

    struct Token {
        address tokenMint;
        uint256 virtualTokenReserves;
        uint256 virtualEthReserves;
        uint256 realTokenReserves;
        uint256 realEthReserves;
        uint256 tokenTotalSupply;
        uint256 mcapLimit;
        bool complete;
    }

    mapping(address => Token) public bondingCurve;

    // ─── Events ───────────────────────────────────────────────────────────────

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event CreatePool(address indexed mint, address indexed user);
    event Complete(address indexed user, address indexed mint, uint256 timestamp);
    event Trade(
        address indexed mint,
        uint256 ethAmount,
        uint256 tokenAmount,
        bool isBuy,
        address indexed user,
        uint256 timestamp,
        uint256 virtualEthReserves,
        uint256 virtualTokenReserves
    );

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "RocketFi: Not Owner");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @notice Deploy RocketFi with fee configuration.
    /// @param feeAddr    Address that receives platform fees.
    /// @param feeAmt     Fixed ETH fee charged on each pool creation (wei).
    /// @param basisFee   Trade fee in basis points (e.g. 100 = 1%).
    constructor(
        address feeAddr,
        uint256 feeAmt,
        uint256 basisFee
    ) {
        require(feeAddr != address(0), "RocketFi: Zero fee address");
        require(basisFee < 10000, "RocketFi: Fee exceeds 100%");

        // FIX: owner was never initialised in the original contract.
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);

        feeRecipient = feeAddr;
        createFee = feeAmt;
        feeBasisPoint = basisFee;
        initialVirtualTokenReserves = 10 ** 27;
        initialVirtualEthReserves = 3 * 10 ** 21;
        tokenTotalSupply = 10 ** 27;
        mcapLimit = 10 ** 23;
    }

    // ─── Core Functions ───────────────────────────────────────────────────────

    /// @notice Register a token on the bonding curve.
    function createPool(
        address token,
        uint256 amount
    ) external payable nonReentrant {
        require(amount > 0, "RocketFi: Amount must be > 0");
        require(feeRecipient != address(0), "RocketFi: No fee recipient");
        require(msg.value >= createFee, "RocketFi: Insufficient creation fee");
        require(bondingCurve[token].tokenMint == address(0), "RocketFi: Pool already exists");

        IERC20(token).transferFrom(msg.sender, address(this), amount);

        // Effects before interaction
        bondingCurve[token] = Token({
            tokenMint: token,
            virtualTokenReserves: initialVirtualTokenReserves,
            virtualEthReserves: initialVirtualEthReserves,
            realTokenReserves: amount,
            realEthReserves: 0,
            tokenTotalSupply: tokenTotalSupply,
            mcapLimit: mcapLimit,
            complete: false
        });

        emit CreatePool(token, msg.sender);

        // Interaction last (CEI)
        payable(feeRecipient).transfer(createFee);

        // FIX: refund excess ETH sent with creation fee
        uint256 excess = msg.value - createFee;
        if (excess > 0) {
            payable(msg.sender).transfer(excess);
        }
    }

    /// @notice Buy tokens from the bonding curve.
    /// @param token      Token contract address.
    /// @param amount     Number of tokens to purchase.
    /// @param maxEthCost Maximum ETH the caller is willing to spend (slippage guard).
    function buy(
        address token,
        uint256 amount,
        uint256 maxEthCost
    ) external payable nonReentrant {
        Token storage tokenCurve = bondingCurve[token];
        require(amount > 0, "RocketFi: Amount must be > 0");
        require(!tokenCurve.complete, "RocketFi: Curve already graduated");
        require(tokenCurve.tokenMint != address(0), "RocketFi: Unknown token");
        require(amount <= tokenCurve.realTokenReserves, "RocketFi: Exceeds reserves");

        uint256 remainingAfter = tokenCurve.realTokenReserves - amount;
        uint256 remainingPct = remainingAfter * 100 / tokenCurve.tokenTotalSupply;
        require(remainingPct > 20, "RocketFi: Buy would exceed 80% limit");

        uint256 ethCost = calculateEthCost(tokenCurve, amount);
        require(ethCost <= maxEthCost, "RocketFi: Exceeds max ETH cost");
        require(msg.value >= ethCost, "RocketFi: Insufficient ETH sent");

        uint256 feeAmount = feeBasisPoint * ethCost / 10000;
        uint256 ethAfterFee = ethCost - feeAmount;

        // EFFECTS: update state before any external calls (CEI pattern)
        tokenCurve.realTokenReserves -= amount;
        tokenCurve.virtualTokenReserves -= amount;
        tokenCurve.virtualEthReserves += ethAfterFee;
        tokenCurve.realEthReserves += ethAfterFee;

        uint256 mcap = tokenCurve.virtualEthReserves * tokenCurve.tokenTotalSupply
            / tokenCurve.realTokenReserves;
        uint256 pct = tokenCurve.realTokenReserves * 100 / tokenCurve.tokenTotalSupply;

        if (mcap > tokenCurve.mcapLimit || pct < 20) {
            tokenCurve.complete = true;
            emit Complete(msg.sender, token, block.timestamp);
        }

        emit Trade(
            token, ethCost, amount, true, msg.sender,
            block.timestamp, tokenCurve.virtualEthReserves, tokenCurve.virtualTokenReserves
        );

        // INTERACTIONS: external calls last
        IERC20(token).transfer(msg.sender, amount);
        payable(feeRecipient).transfer(feeAmount);

        // FIX: refund any excess ETH the caller sent
        uint256 excess = msg.value - ethCost;
        if (excess > 0) {
            payable(msg.sender).transfer(excess);
        }
    }

    /// @notice Sell tokens back into the bonding curve.
    /// @param token        Token contract address.
    /// @param amount       Number of tokens to sell.
    /// @param minEthOutput Minimum ETH to receive (slippage guard).
    function sell(
        address token,
        uint256 amount,
        uint256 minEthOutput
    ) external nonReentrant {
        Token storage tokenCurve = bondingCurve[token];
        require(!tokenCurve.complete, "RocketFi: Curve already graduated");
        require(amount > 0, "RocketFi: Amount must be > 0");
        require(tokenCurve.tokenMint != address(0), "RocketFi: Unknown token");

        uint256 ethCost = calculateEthCost(tokenCurve, amount);
        if (tokenCurve.realEthReserves < ethCost) {
            ethCost = tokenCurve.realEthReserves;
        }
        require(ethCost >= minEthOutput, "RocketFi: Below min ETH output");

        uint256 feeAmount = feeBasisPoint * ethCost / 10000;
        uint256 ethToSeller = ethCost - feeAmount;

        // EFFECTS: update state before any external calls (CEI pattern)
        // FIX: original sent ETH *before* updating reserves — now effects come first.
        tokenCurve.realTokenReserves += amount;
        tokenCurve.virtualTokenReserves += amount;
        tokenCurve.virtualEthReserves -= ethCost;
        tokenCurve.realEthReserves -= ethCost;

        emit Trade(
            token, ethCost, amount, false, msg.sender,
            block.timestamp, tokenCurve.virtualEthReserves, tokenCurve.virtualTokenReserves
        );

        // INTERACTIONS: pull tokens then push ETH
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        payable(feeRecipient).transfer(feeAmount);
        payable(msg.sender).transfer(ethToSeller);
    }

    /// @notice Move graduated pool reserves to Uniswap (called by owner after curve completes).
    function withdraw(address token) external onlyOwner nonReentrant {
        Token storage tokenCurve = bondingCurve[token];
        require(tokenCurve.complete, "RocketFi: Curve not yet graduated");
        require(tokenCurve.realEthReserves > 0 || tokenCurve.realTokenReserves > 0, "RocketFi: Already withdrawn");

        uint256 ethToSend = tokenCurve.realEthReserves;
        uint256 tokensToSend = tokenCurve.realTokenReserves;

        // EFFECTS: zero out reserves before transfer to prevent double-withdraw
        tokenCurve.realEthReserves = 0;
        tokenCurve.realTokenReserves = 0;

        // INTERACTIONS
        if (ethToSend > 0) {
            payable(owner).transfer(ethToSend);
        }
        if (tokensToSend > 0) {
            IERC20(token).transfer(owner, tokensToSend);
        }
    }

    // ─── Pure Math ────────────────────────────────────────────────────────────

    /// @notice Constant-product AMM price calculation.
    /// @dev Returns ETH delta for a given token amount change.
    function calculateEthCost(
        Token memory token,
        uint256 tokenAmount
    ) public pure returns (uint256) {
        uint256 virtualTokenReserves = token.virtualTokenReserves;

        // FIX: guard against division by zero when tokenAmount == virtualTokenReserves
        require(tokenAmount < virtualTokenReserves, "RocketFi: Token amount too large");

        uint256 newTokenReserves = virtualTokenReserves - tokenAmount;
        uint256 totalLiquidity = token.virtualEthReserves * virtualTokenReserves;
        uint256 newEthReserves = totalLiquidity / newTokenReserves;
        uint256 ethCost = newEthReserves - token.virtualEthReserves;

        return ethCost;
    }

    // ─── Owner Admin ──────────────────────────────────────────────────────────

    function setFeeRecipient(address newAddr) external onlyOwner {
        require(newAddr != address(0), "RocketFi: Zero address");
        feeRecipient = newAddr;
    }

    function transferOwnership(address newAddr) external onlyOwner {
        require(newAddr != address(0), "RocketFi: Zero address");
        emit OwnershipTransferred(owner, newAddr);
        owner = newAddr;
    }

    function setInitialVirtualReserves(uint256 initToken, uint256 initEth) external onlyOwner {
        require(initEth > 0 && initToken > 0, "RocketFi: Must be > 0");
        initialVirtualTokenReserves = initToken;
        initialVirtualEthReserves = initEth;
    }

    function setTotalSupply(uint256 newSupply) external onlyOwner {
        require(newSupply > 0, "RocketFi: Must be > 0");
        tokenTotalSupply = newSupply;
    }

    function setMcapLimit(uint256 newLimit) external onlyOwner {
        require(newLimit > 0, "RocketFi: Must be > 0");
        mcapLimit = newLimit;
    }

    function setFeeAmount(uint256 newBasisPoint, uint256 newCreateFee) external onlyOwner {
        require(newBasisPoint > 0 && newCreateFee > 0, "RocketFi: Must be > 0");
        require(newBasisPoint < 10000, "RocketFi: Fee exceeds 100%");
        feeBasisPoint = newBasisPoint;
        createFee = newCreateFee;
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getOwner() external view returns (address) {
        return owner;
    }

    function getCreateFee() external view returns (uint256) {
        return createFee;
    }

    function getBondingCurve(address mint) external view returns (Token memory) {
        return bondingCurve[mint];
    }
}
