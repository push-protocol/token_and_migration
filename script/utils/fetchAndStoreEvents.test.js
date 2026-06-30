const test = require("node:test");
const assert = require("node:assert/strict");

const { buildNetClaims } = require("./fetchAndStoreEvents");

const alice = "0x00000000000000000000000000000000000000a1";
const bob = "0x00000000000000000000000000000000000000b2";
const carol = "0x00000000000000000000000000000000000000c3";

test("buildNetClaims handles locked entries", () => {
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

test("buildNetClaims drops fully refunded entries", () => {
  const result = buildNetClaims(
    [{ sender: alice, recipient: bob, amount: 100n, epoch: 1 }],
    [{ sender: alice, recipient: bob, amount: 100n, epoch: 1 }]
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
