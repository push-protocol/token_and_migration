const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const { LOCKER_EVENT_ABI, LOCKER_SOURCES } = require("./config");
const { buildNetClaims, mergeClaims, reconcileEpochTotals, resolveLockerSources } = require("./fetchAndStoreEvents");

const alice = "0x00000000000000000000000000000000000000a1";
const bob = "0x00000000000000000000000000000000000000b2";
const carol = "0x00000000000000000000000000000000000000c3";
const originalPreMigrationAddress = LOCKER_SOURCES.preMigration.CONTRACT_ADDRESS;
const originalPreMigrationEpochs = [...LOCKER_SOURCES.preMigration.FILTER_EPOCHS];
const originalMigrationAddress = LOCKER_SOURCES.migration.CONTRACT_ADDRESS;
const originalMigrationEpochs = [...LOCKER_SOURCES.migration.FILTER_EPOCHS];

afterEach(() => {
  LOCKER_SOURCES.preMigration.CONTRACT_ADDRESS = originalPreMigrationAddress;
  LOCKER_SOURCES.preMigration.FILTER_EPOCHS = [...originalPreMigrationEpochs];
  LOCKER_SOURCES.migration.CONTRACT_ADDRESS = originalMigrationAddress;
  LOCKER_SOURCES.migration.FILTER_EPOCHS = [...originalMigrationEpochs];
});

test("resolveLockerSources rejects missing contract addresses", () => {
  LOCKER_SOURCES.preMigration.CONTRACT_ADDRESS = "";
  LOCKER_SOURCES.migration.CONTRACT_ADDRESS = "";

  assert.throws(
    () => resolveLockerSources(),
    /Both preMigration and migration contract addresses must be configured/
  );
});

test("resolveLockerSources rejects identical pre and migration addresses", () => {
  LOCKER_SOURCES.preMigration.CONTRACT_ADDRESS = "0x00000000000000000000000000000000000000aa";
  LOCKER_SOURCES.migration.CONTRACT_ADDRESS = "0x00000000000000000000000000000000000000AA";

  assert.throws(
    () => resolveLockerSources(),
    /preMigration and migration must be different contract addresses/
  );
});

test("resolveLockerSources builds the fixed two-source topology", () => {
  LOCKER_SOURCES.preMigration.CONTRACT_ADDRESS = "0x00000000000000000000000000000000000000aa";
  LOCKER_SOURCES.preMigration.FILTER_EPOCHS = [1];
  LOCKER_SOURCES.migration.CONTRACT_ADDRESS = "0x00000000000000000000000000000000000000bb";
  LOCKER_SOURCES.migration.FILTER_EPOCHS = [];

  assert.deepEqual(resolveLockerSources(), [
    {
      NAME: "pre-migration",
      CONTRACT_ADDRESS: "0x00000000000000000000000000000000000000aa",
      ABI: [
        "event Locked(address caller, address recipient, uint256 amount, uint256 epoch)",
        "event Unlocked(address indexed sender, address indexed recipient, uint256 amount, uint256 epoch)",
        "function epoch() view returns (uint256)",
        "function epochStartBlock(uint256) view returns (uint256)"
      ],
      FILTER_EPOCHS: [1],
      INCLUDE_UNLOCKED: true
    },
    {
      NAME: "migration",
      CONTRACT_ADDRESS: "0x00000000000000000000000000000000000000bb",
      ABI: [
        "event Locked(address caller, address recipient, uint256 amount, uint256 epoch)",
        "event Unlocked(address indexed sender, address indexed recipient, uint256 amount, uint256 epoch)",
        "function epoch() view returns (uint256)",
        "function epochStartBlock(uint256) view returns (uint256)"
      ],
      FILTER_EPOCHS: [],
      INCLUDE_UNLOCKED: false
    }
  ]);
});

test("LOCKER_EVENT_ABI decodes indexed Unlocked logs", () => {
  const eventAbi = [
    "event Unlocked(address indexed sender, address indexed recipient, uint256 amount, uint256 epoch)"
  ];
  const actualInterface = new ethers.Interface(eventAbi);
  const builderInterface = new ethers.Interface(LOCKER_EVENT_ABI);
  const encoded = actualInterface.encodeEventLog(actualInterface.getEvent("Unlocked"), [alice, bob, 100n, 1n]);
  const decoded = builderInterface.decodeEventLog("Unlocked", encoded.data, encoded.topics);

  assert.equal(decoded.sender.toLowerCase(), alice);
  assert.equal(decoded.recipient.toLowerCase(), bob);
  assert.equal(decoded.amount, 100n);
  assert.equal(decoded.epoch, 1n);
});

test("buildNetClaims handles pre-migration locked entries", () => {
  const result = buildNetClaims([
    { sender: alice, recipient: bob, amount: 100n, epoch: 1 }
  ]);

  assert.deepEqual(result.claims, [
    { address: bob, amount: "100", epoch: "1" }
  ]);
  assert.equal(result.lockedTotalsByEpoch["1"], 100n);
  assert.equal(result.unlockedTotalsByEpoch["1"] || 0n, 0n);
});

test("buildNetClaims subtracts unlocked entries from the correct sender-recipient-epoch bucket", () => {
  const result = buildNetClaims(
    [
      { sender: alice, recipient: bob, amount: 100n, epoch: 1 },
      { sender: carol, recipient: bob, amount: 50n, epoch: 1 }
    ],
    [
      { sender: alice, recipient: bob, amount: 30n, epoch: 1 }
    ]
  );

  assert.deepEqual(result.claims, [
    { address: bob, amount: "120", epoch: "1" }
  ]);
  assert.equal(result.lockedTotalsByEpoch["1"], 150n);
  assert.equal(result.unlockedTotalsByEpoch["1"], 30n);
});

test("buildNetClaims drops fully refunded pre-migration entries", () => {
  const result = buildNetClaims(
    [
      { sender: alice, recipient: bob, amount: 100n, epoch: 1 }
    ],
    [
      { sender: alice, recipient: bob, amount: 100n, epoch: 1 }
    ]
  );

  assert.deepEqual(result.claims, []);
});

test("buildNetClaims rejects negative net amounts", () => {
  assert.throws(
    () =>
      buildNetClaims(
        [{ sender: alice, recipient: bob, amount: 10n, epoch: 1 }],
        [{ sender: alice, recipient: bob, amount: 11n, epoch: 1 }]
      ),
    /Negative net amount/
  );
});

test("reconcileEpochTotals accepts exact reconciliation", () => {
  assert.doesNotThrow(() => reconcileEpochTotals("migration", 1, 100n, 10n, 90n, 90n));
});

test("reconcileEpochTotals accepts unexplained PUSH surplus", () => {
  assert.doesNotThrow(() => reconcileEpochTotals("migration", 1, 100n, 10n, 90n, 91n));
});

test("reconcileEpochTotals rejects on-chain deficits", () => {
  assert.throws(
    () => reconcileEpochTotals("migration", 1, 100n, 10n, 90n, 89n),
    /Funds deficit/
  );
});

test("mergeClaims merges pre and main epoch 1 into a single recipient+epoch claim", () => {
  const preClaims = buildNetClaims([
    { sender: alice, recipient: bob, amount: 100n, epoch: 1 }
  ]).claims;
  const mainClaims = buildNetClaims([
    { sender: carol, recipient: bob, amount: 50n, epoch: 1 }
  ]).claims;

  const merged = mergeClaims([preClaims, mainClaims]);

  assert.deepEqual(merged, [
    { address: bob, amount: "150", epoch: "1" }
  ]);
});

test("mergeClaims keeps later main-migration epochs separate while rebuilding cumulatively", () => {
  const preClaims = buildNetClaims([
    { sender: alice, recipient: bob, amount: 100n, epoch: 1 }
  ]).claims;
  const mainEpochOneClaims = buildNetClaims([
    { sender: carol, recipient: bob, amount: 50n, epoch: 1 }
  ]).claims;
  const mainEpochTwoClaims = buildNetClaims([
    { sender: alice, recipient: bob, amount: 25n, epoch: 2 }
  ]).claims;

  const merged = mergeClaims([preClaims, mainEpochOneClaims, mainEpochTwoClaims]);

  assert.deepEqual(merged, [
    { address: bob, amount: "150", epoch: "1" },
    { address: bob, amount: "25", epoch: "2" }
  ]);
});
