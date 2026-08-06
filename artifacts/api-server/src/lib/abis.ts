/**
 * Minimal ABI fragments for RocketFi contracts — only the events and
 * view functions the indexer needs.
 */

/** RocketFi.sol events */
export const ROCKETFI_ABI = [
  // Events
  "event CreatePool(address indexed mint, address indexed user)",
  "event Complete(address indexed user, address indexed mint, uint256 timestamp)",
  "event Trade(address indexed mint, uint256 ethAmount, uint256 tokenAmount, bool isBuy, address indexed user, uint256 timestamp, uint256 virtualEthReserves, uint256 virtualTokenReserves)",

  // View — used to hydrate token state on CreatePool when TokenLauncher isn't present
  "function getBondingCurve(address mint) external view returns (tuple(address tokenMint, uint256 virtualTokenReserves, uint256 virtualEthReserves, uint256 realTokenReserves, uint256 realEthReserves, uint256 tokenTotalSupply, uint256 mcapLimit, bool complete))",
] as const;

/** TokenLauncher.sol events */
export const TOKEN_LAUNCHER_ABI = [
  "event TokenLaunched(address indexed tokenAddress, address indexed creator, string name, string symbol)",
] as const;
