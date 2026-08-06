# 🚀 RocketFi — EVM Token Launchpad

> A security-hardened EVM bonding-curve launchpad inspired by pump.fun.
> Launch meme tokens on any EVM chain with a fair price discovery mechanism.

---

## What is RocketFi?

RocketFi lets anyone launch an ERC-20 token in a single transaction. Prices are set automatically by an on-chain bonding curve (constant-product AMM). When a token "graduates" (hits its market-cap target), the liquidity can be migrated to Uniswap.

**Core features:**
- 🪙 One-click token launch via `TokenLauncher`
- 📈 Constant-product bonding curve in `RocketFi`
- 💸 Configurable platform fees (basis points)
- 🔐 Owner-controlled admin functions
- ✅ OpenZeppelin ReentrancyGuard on all state-changing functions

---

## Security Fixes vs. Original

| # | Issue | Severity | Fix Applied |
|---|-------|----------|-------------|
| 1 | `owner` never initialised in constructor — all admin locked forever | 🔴 Critical | `owner = msg.sender` added to constructor |
| 2 | `setPoolAddress()` had no access control — anyone could redirect funds | 🔴 Critical | `onlyOwner` modifier added |
| 3 | Hardcoded third-party `taxAddress` receiving all fees | 🔴 Critical | Removed; fee address passed as constructor arg |
| 4 | `buy()` and `sell()` missing `nonReentrant` despite importing ReentrancyGuard | 🟠 High | `nonReentrant` added to both |
| 5 | `sell()` sent ETH before updating state (CEI violation) | 🟠 High | State updated before all external calls |
| 6 | Excess ETH not refunded on `buy()` / `createPool()` | 🟠 High | Excess refunded at end of each function |
| 7 | `calculateEthCost()` could divide by zero | 🟡 Medium | `require(tokenAmount < virtualTokenReserves)` guard added |
| 8 | `withdraw()` didn't zero reserves — double-withdraw possible | 🟡 Medium | Reserves zeroed before transfer |
| 9 | No guard against creating a pool for the same token twice | 🟡 Medium | `require(bondingCurve[token].tokenMint == address(0))` added |

---

## Contracts

| Contract | Description |
|---|---|
| `RocketFi.sol` | Core bonding curve: `createPool`, `buy`, `sell`, `withdraw` |
| `TokenLauncher.sol` | Factory: deploy ERC-20 + register pool in one tx |
| `RocketToken.sol` | Minimal ERC-20 (standard OpenZeppelin) |

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Compile

```bash
npx hardhat compile
```

### 3. Run tests

```bash
npx hardhat test
```

### 4. Check coverage

```bash
npx hardhat coverage
```

---

## Deployment

### Local node

```bash
npx hardhat node
npx hardhat ignition deploy ignition/modules/RocketFi.ts --network localhost
```

### Testnet / Mainnet

1. Copy `.env.example` → `.env` and fill in your values:

```env
PRIVATE_KEY=your_deployer_private_key
FEE_RECIPIENT=0xYourFeeWallet
CREATE_FEE=0.001
BASIS_FEE=100
SEPOLIA_RPC_URL=https://...
```

2. Add your network to `hardhat.config.ts` (examples already commented in).

3. Deploy:

```bash
npx hardhat ignition deploy ignition/modules/RocketFi.ts --network sepolia
```

---

## Architecture

```
User
 │
 ├─ launchToken(name, ticker) ──▶ TokenLauncher
 │                                     │ deploys RocketToken
 │                                     │ calls createPool ──▶ RocketFi
 │
 ├─ buy(token, amount, maxEthCost) ──▶ RocketFi (bonding curve buy)
 │
 └─ sell(token, amount, minEthOutput) ─▶ RocketFi (bonding curve sell)


Graduation: when mcap > limit or remaining supply < 20%
 └─ owner calls withdraw() → moves ETH + tokens for Uniswap migration
```

---

## Fee Structure

| Fee | Default | Controlled by |
|-----|---------|--------------|
| Creation fee | 0.001 ETH (flat) | `setFeeAmount()` (owner) |
| Trade fee | 1% (100 bps) | `setFeeAmount()` (owner) |
| Fee recipient | Set at deploy | `setFeeRecipient()` (owner) |

---

## License

MIT
