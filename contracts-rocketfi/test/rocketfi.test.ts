import {
    loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
// Helper: off-chain bonding curve calculation (mirrors RocketFi.calculateEthCost)
// ─────────────────────────────────────────────────────────────────────────────

/** How many tokens are received for a given ETH input */
const tokensForEth = (ethIn: bigint, curve: any): bigint => {
    const totalLiquidity = curve.virtualEthReserves * curve.virtualTokenReserves;
    const newEthReserve = curve.virtualEthReserves + ethIn;
    const newTokenReserve = totalLiquidity / newEthReserve;
    const tokensBought = curve.virtualTokenReserves - newTokenReserve;
    return tokensBought < 0n ? 0n : tokensBought;
};

/** How much ETH is received for selling a token amount */
const ethForTokens = (tokenIn: bigint, curve: any): bigint => {
    const totalLiquidity = curve.virtualEthReserves * curve.virtualTokenReserves;
    const newTokenReserve = curve.virtualTokenReserves + tokenIn;
    const newEthReserve = totalLiquidity / newTokenReserve;
    const ethOut = curve.virtualEthReserves - newEthReserve;
    return ethOut < 0n ? 0n : ethOut;
};

// ─────────────────────────────────────────────────────────────────────────────
// Test config (uses the deployer address as fee recipient — no external wallet)
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
    tokenName:    "Rocket Token",
    tokenSymbol:  "RKT",
    feeAmount:    1_000_000_000_000_000n, // 0.001 ETH
    feeBasisPoint: 100n,                  // 1%
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────

async function deployFixture() {
    const [deployer, user1, user2, feeWallet] = await hre.ethers.getSigners();

    const RocketFi = await hre.ethers.getContractFactory("RocketFi");
    const rocketFi = await RocketFi.deploy(
        feeWallet.address,
        CONFIG.feeAmount,
        CONFIG.feeBasisPoint,
    );

    const TokenLauncher = await hre.ethers.getContractFactory("TokenLauncher");
    const launcher = await TokenLauncher.deploy();

    await launcher.waitForDeployment();
    await rocketFi.waitForDeployment();

    return { rocketFi, launcher, deployer, user1, user2, feeWallet };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("RocketFi", function () {

    // ── Deployment ────────────────────────────────────────────────────────────

    describe("Deployment", function () {
        it("should set deployer as owner", async function () {
            const { rocketFi, deployer } = await loadFixture(deployFixture);
            expect(await rocketFi.getOwner()).to.equal(deployer.address);
        });

        it("should set createFee correctly", async function () {
            const { rocketFi } = await loadFixture(deployFixture);
            expect(await rocketFi.getCreateFee()).to.equal(CONFIG.feeAmount);
        });

        it("should revert if fee address is zero", async function () {
            const RocketFi = await hre.ethers.getContractFactory("RocketFi");
            await expect(
                RocketFi.deploy(hre.ethers.ZeroAddress, CONFIG.feeAmount, CONFIG.feeBasisPoint)
            ).to.be.revertedWith("RocketFi: Zero fee address");
        });

        it("should revert if basis fee >= 10000 (>= 100%)", async function () {
            const [, , , feeWallet] = await hre.ethers.getSigners();
            const RocketFi = await hre.ethers.getContractFactory("RocketFi");
            await expect(
                RocketFi.deploy(feeWallet.address, CONFIG.feeAmount, 10000n)
            ).to.be.revertedWith("RocketFi: Fee exceeds 100%");
        });
    });

    // ── TokenLauncher ownership ───────────────────────────────────────────────

    describe("TokenLauncher Access Control", function () {
        it("should set deployer as owner", async function () {
            const { launcher, deployer } = await loadFixture(deployFixture);
            expect(await launcher.owner()).to.equal(deployer.address);
        });

        it("should allow owner to set pool address", async function () {
            const { launcher, rocketFi, deployer } = await loadFixture(deployFixture);
            await expect(
                launcher.connect(deployer).setPoolAddress(await rocketFi.getAddress())
            ).to.emit(launcher, "PoolAddressUpdated");
            expect(await launcher.rocketFiContract()).to.equal(await rocketFi.getAddress());
        });

        it("should REJECT non-owner from setting pool address", async function () {
            const { launcher, rocketFi, user1 } = await loadFixture(deployFixture);
            await expect(
                launcher.connect(user1).setPoolAddress(await rocketFi.getAddress())
            ).to.be.revertedWith("TokenLauncher: Not Owner");
        });

        it("should reject zero address for pool", async function () {
            const { launcher, deployer } = await loadFixture(deployFixture);
            await expect(
                launcher.connect(deployer).setPoolAddress(hre.ethers.ZeroAddress)
            ).to.be.revertedWith("TokenLauncher: Zero address");
        });
    });

    // ── Token Launch + Pool Creation ─────────────────────────────────────────

    describe("Token Launch", function () {
        async function launchedFixture() {
            const base = await loadFixture(deployFixture);
            const { launcher, rocketFi, deployer } = base;

            await launcher.connect(deployer).setPoolAddress(await rocketFi.getAddress());

            const tx = await launcher.launchToken(
                CONFIG.tokenName,
                CONFIG.tokenSymbol,
                { value: CONFIG.feeAmount }
            );
            await tx.wait();

            const record = await launcher.getToken(0);
            const tokenAddr = record.tokenAddress;
            const token = await hre.ethers.getContractAt("IERC20", tokenAddr);
            const curve = await rocketFi.getBondingCurve(tokenAddr);

            return { ...base, tokenAddr, token, curve };
        }

        it("should create bonding curve with correct initial reserves", async function () {
            const { curve, tokenAddr } = await launchedFixture();
            const SUPPLY = 10n ** 27n;
            expect(curve.tokenMint).to.equal(tokenAddr);
            expect(curve.virtualTokenReserves).to.equal(SUPPLY);
            expect(curve.realTokenReserves).to.equal(SUPPLY);
            expect(curve.realEthReserves).to.equal(0n);
            expect(curve.complete).to.equal(false);
        });

        it("should record token in launcher", async function () {
            const { launcher } = await launchedFixture();
            expect(await launcher.getTokenCount()).to.equal(1n);
        });

        it("should refund excess ETH sent to launchToken", async function () {
            const { launcher, rocketFi, user1 } = await loadFixture(deployFixture);
            const [deployer] = await hre.ethers.getSigners();
            await launcher.connect(deployer).setPoolAddress(await rocketFi.getAddress());

            const excess = hre.ethers.parseEther("0.05");
            const balBefore = await hre.ethers.provider.getBalance(user1.address);
            const tx = await launcher.connect(user1).launchToken("Excess Test", "EXT", {
                value: CONFIG.feeAmount + excess,
            });
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
            const balAfter = await hre.ethers.provider.getBalance(user1.address);

            // user should have lost only fee + gas
            const lost = balBefore - balAfter;
            expect(lost).to.be.closeTo(CONFIG.feeAmount + gasUsed, hre.ethers.parseEther("0.001"));
        });
    });

    // ── Buy ───────────────────────────────────────────────────────────────────

    describe("Buy", function () {
        async function buyFixture() {
            const base = await loadFixture(deployFixture);
            const { launcher, rocketFi, deployer, user1 } = base;
            await launcher.connect(deployer).setPoolAddress(await rocketFi.getAddress());
            await launcher.launchToken(CONFIG.tokenName, CONFIG.tokenSymbol, { value: CONFIG.feeAmount });

            const record = await launcher.getToken(0);
            const tokenAddr = record.tokenAddress;
            const token = await hre.ethers.getContractAt("IERC20", tokenAddr);

            return { ...base, tokenAddr, token };
        }

        it("should transfer tokens to buyer", async function () {
            const { rocketFi, tokenAddr, token, user1 } = await buyFixture();
            const curve = await rocketFi.getBondingCurve(tokenAddr);
            const buyAmount = tokensForEth(hre.ethers.parseEther("0.1"), curve);

            const balBefore = await token.balanceOf(user1.address);
            const ethCost = await rocketFi.calculateEthCost(curve, buyAmount);
            await rocketFi.connect(user1).buy(tokenAddr, buyAmount, ethCost * 120n / 100n, {
                value: ethCost * 120n / 100n,
            });
            const balAfter = await token.balanceOf(user1.address);
            expect(balAfter - balBefore).to.equal(buyAmount);
        });

        it("should refund excess ETH to buyer", async function () {
            const { rocketFi, tokenAddr, user1 } = await buyFixture();
            const curve = await rocketFi.getBondingCurve(tokenAddr);
            const buyAmount = tokensForEth(hre.ethers.parseEther("0.1"), curve);
            const ethCost = await rocketFi.calculateEthCost(curve, buyAmount);
            const sentValue = ethCost * 2n; // send 2× the cost

            const balBefore = await hre.ethers.provider.getBalance(user1.address);
            const tx = await rocketFi.connect(user1).buy(tokenAddr, buyAmount, sentValue, { value: sentValue });
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
            const balAfter = await hre.ethers.provider.getBalance(user1.address);

            const spent = balBefore - balAfter;
            expect(spent).to.be.closeTo(ethCost + gasUsed, hre.ethers.parseEther("0.001"));
        });

        it("should reject buy exceeding maxEthCost", async function () {
            const { rocketFi, tokenAddr, user1 } = await buyFixture();
            const curve = await rocketFi.getBondingCurve(tokenAddr);
            const buyAmount = tokensForEth(hre.ethers.parseEther("1"), curve);
            const ethCost = await rocketFi.calculateEthCost(curve, buyAmount);
            // Set maxEthCost lower than actual cost
            await expect(
                rocketFi.connect(user1).buy(tokenAddr, buyAmount, ethCost / 2n, { value: ethCost })
            ).to.be.revertedWith("RocketFi: Exceeds max ETH cost");
        });
    });

    // ── Sell ──────────────────────────────────────────────────────────────────

    describe("Sell", function () {
        async function sellFixture() {
            const base = await loadFixture(deployFixture);
            const { launcher, rocketFi, deployer, user1 } = base;
            await launcher.connect(deployer).setPoolAddress(await rocketFi.getAddress());
            await launcher.launchToken(CONFIG.tokenName, CONFIG.tokenSymbol, { value: CONFIG.feeAmount });

            const record = await launcher.getToken(0);
            const tokenAddr = record.tokenAddress;
            const token = await hre.ethers.getContractAt("IERC20", tokenAddr);

            // Buy first so user1 has tokens
            const curve = await rocketFi.getBondingCurve(tokenAddr);
            const buyAmount = tokensForEth(hre.ethers.parseEther("0.1"), curve);
            const ethCost = await rocketFi.calculateEthCost(curve, buyAmount);
            await rocketFi.connect(user1).buy(tokenAddr, buyAmount, ethCost * 120n / 100n, {
                value: ethCost * 120n / 100n,
            });

            return { ...base, tokenAddr, token };
        }

        it("should return ETH to seller", async function () {
            const { rocketFi, tokenAddr, token, user1 } = await sellFixture();
            const sellAmount = await token.balanceOf(user1.address);
            const curve = await rocketFi.getBondingCurve(tokenAddr);
            const ethOut = await rocketFi.calculateEthCost(curve, sellAmount);
            const minEth = ethOut * 80n / 100n;

            await token.connect(user1).approve(await rocketFi.getAddress(), sellAmount);
            const balBefore = await hre.ethers.provider.getBalance(user1.address);
            const tx = await rocketFi.connect(user1).sell(tokenAddr, sellAmount, minEth);
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
            const balAfter = await hre.ethers.provider.getBalance(user1.address);

            // Seller received ETH minus fees minus gas
            expect(balAfter + gasUsed).to.be.gt(balBefore);
        });

        it("should reject sell below minEthOutput", async function () {
            const { rocketFi, tokenAddr, token, user1 } = await sellFixture();
            const sellAmount = await token.balanceOf(user1.address);
            const curve = await rocketFi.getBondingCurve(tokenAddr);
            const ethOut = await rocketFi.calculateEthCost(curve, sellAmount);

            await token.connect(user1).approve(await rocketFi.getAddress(), sellAmount);
            await expect(
                rocketFi.connect(user1).sell(tokenAddr, sellAmount, ethOut * 200n)
            ).to.be.revertedWith("RocketFi: Below min ETH output");
        });
    });

    // ── Owner functions ───────────────────────────────────────────────────────

    describe("Owner Admin", function () {
        it("non-owner cannot call setFeeRecipient", async function () {
            const { rocketFi, user1, feeWallet } = await loadFixture(deployFixture);
            await expect(
                rocketFi.connect(user1).setFeeRecipient(feeWallet.address)
            ).to.be.revertedWith("RocketFi: Not Owner");
        });

        it("owner can transfer ownership", async function () {
            const { rocketFi, deployer, user1 } = await loadFixture(deployFixture);
            await rocketFi.connect(deployer).transferOwnership(user1.address);
            expect(await rocketFi.getOwner()).to.equal(user1.address);
        });
    });
});
