import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { parseEther } from "ethers";

/**
 * RocketFi Ignition Deployment Module
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/RocketFi.ts \
 *     --network <network>
 *
 * Required env vars:
 *   FEE_RECIPIENT  – address that will receive platform fees
 *   CREATE_FEE     – ETH amount (in ether string, e.g. "0.001") charged per launch
 *   BASIS_FEE      – trade fee in basis points (e.g. 100 = 1%)
 */

const FEE_RECIPIENT  = process.env.FEE_RECIPIENT  ?? "0x0000000000000000000000000000000000000001";
const CREATE_FEE_ETH = process.env.CREATE_FEE     ?? "0.001";
const BASIS_FEE      = BigInt(process.env.BASIS_FEE ?? "100");

const RocketFiModule = buildModule("RocketFiModule", (m) => {
    const feeRecipient = m.getParameter("feeRecipient", FEE_RECIPIENT);
    const createFee    = m.getParameter("createFee",    parseEther(CREATE_FEE_ETH));
    const basisFee     = m.getParameter("basisFee",     BASIS_FEE);

    const rocketFi = m.contract("RocketFi", [feeRecipient, createFee, basisFee]);
    const launcher  = m.contract("TokenLauncher", []);

    // Wire launcher → rocketFi (owner-gated call)
    m.call(launcher, "setPoolAddress", [rocketFi]);

    return { rocketFi, launcher };
});

export default RocketFiModule;
