/**
 * Configuration for event fetching and merkle proof generation.
 */

const LOCKER_CONFIG = {
  CONTRACT_ADDRESS: "",
  ABI: [
    "event Locked(address caller, address recipient, uint256 amount, uint256 epoch)",
    "event Unlocked(address sender, address recipient, uint256 amount, uint256 epoch)",
    "function epoch() view returns (uint256)",
    "function epochStartBlock(uint256) view returns (uint256)"
  ],
  FILTER_EPOCHS: []
};

const OUTPUT_CONFIG = {
  CLAIMS_PATH: "../../output/migration-list.json"
};

module.exports = {
  LOCKER_CONFIG,
  OUTPUT_CONFIG
};
