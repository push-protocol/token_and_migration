/**
 * Configuration for event fetching and merkle proof generation.
 */

const LOCKER_EVENT_ABI = [
  "event Locked(address caller, address recipient, uint256 amount, uint256 epoch)",
  "event Unlocked(address indexed sender, address indexed recipient, uint256 amount, uint256 epoch)",
  "function epoch() view returns (uint256)",
  "function epochStartBlock(uint256) view returns (uint256)"
];

const LOCKER_SOURCES = {
  preMigration: {
    CONTRACT_ADDRESS: "",
    FILTER_EPOCHS: [1]
  },
  migration: {
    CONTRACT_ADDRESS: "",
    FILTER_EPOCHS: []
  }
};

const OUTPUT_CONFIG = {
  CLAIMS_PATH: "../../output/migration-list.json"
};

module.exports = {
  LOCKER_EVENT_ABI,
  LOCKER_SOURCES,
  OUTPUT_CONFIG
};
