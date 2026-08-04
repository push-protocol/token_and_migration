const fs = require("fs");
const path = require("path");
const { LOCKER_CONFIG, OUTPUT_CONFIG } = require("./config");

const PUSH_TOKEN_ADDRESS = "0xf418588522d5dd018b425E472991E52EBBeEEEEE";
const PUSH_TOKEN_ABI = [
  "function balanceOf(address account) view returns (uint256)"
];

function toBigInt(value) {
  return typeof value === "bigint" ? value : BigInt(value.toString());
}

function senderRecipientEpochKey(sender, recipient, epoch) {
  return `${sender.toLowerCase()}-${recipient.toLowerCase()}-${epoch}`;
}

function recipientEpochKey(recipient, epoch) {
  return `${recipient.toLowerCase()}-${epoch}`;
}

function addAmountByEpoch(totalsByEpoch, epoch, amount) {
  const key = epoch.toString();
  totalsByEpoch[key] = (totalsByEpoch[key] || 0n) + amount;
}

function buildNetClaims(lockedEntries, unlockedEntries = []) {
  const senderRecipientBalances = Object.create(null);
  const recipientEpochBalances = Object.create(null);
  const lockedTotalsByEpoch = Object.create(null);
  const unlockedTotalsByEpoch = Object.create(null);

  for (const entry of lockedEntries) {
    const amount = toBigInt(entry.amount);
    const epoch = entry.epoch.toString();
    const key = senderRecipientEpochKey(entry.sender, entry.recipient, epoch);
    const current = senderRecipientBalances[key];

    if (current) {
      current.amount += amount;
    } else {
      senderRecipientBalances[key] = {
        sender: entry.sender,
        recipient: entry.recipient,
        epoch,
        amount
      };
    }

    addAmountByEpoch(lockedTotalsByEpoch, epoch, amount);
  }

  for (const entry of unlockedEntries) {
    const amount = toBigInt(entry.amount);
    const epoch = entry.epoch.toString();
    const key = senderRecipientEpochKey(entry.sender, entry.recipient, epoch);
    const current = senderRecipientBalances[key];

    if (!current || current.amount < amount) {
      throw new Error(
        `Negative net amount for ${entry.sender} -> ${entry.recipient} in epoch ${epoch}`
      );
    }

    current.amount -= amount;
    addAmountByEpoch(unlockedTotalsByEpoch, epoch, amount);
  }

  for (const claimableBalance of Object.values(senderRecipientBalances)) {
    if (claimableBalance.amount === 0n) {
      continue;
    }

    const key = recipientEpochKey(claimableBalance.recipient, claimableBalance.epoch);
    const current = recipientEpochBalances[key];

    if (current) {
      current.amount += claimableBalance.amount;
    } else {
      recipientEpochBalances[key] = {
        address: claimableBalance.recipient,
        amount: claimableBalance.amount,
        epoch: claimableBalance.epoch
      };
    }
  }

  const claims = Object.values(recipientEpochBalances)
    .filter((claim) => claim.amount > 0n)
    .sort((a, b) => {
      if (a.epoch !== b.epoch) {
        return Number(a.epoch) - Number(b.epoch);
      }
      return a.address.toLowerCase().localeCompare(b.address.toLowerCase());
    })
    .map((claim) => ({
      address: claim.address,
      amount: claim.amount.toString(),
      epoch: claim.epoch
    }));

  return {
    claims,
    lockedTotalsByEpoch,
    unlockedTotalsByEpoch
  };
}

function normalizeLockedEvents(events) {
  return events.map((event) => ({
    sender: event.args.caller,
    recipient: event.args.recipient,
    amount: event.args.amount,
    epoch: Number(event.args.epoch)
  }));
}

function normalizeUnlockedEvents(events) {
  return events.map((event) => ({
    sender: event.args.sender,
    recipient: event.args.recipient,
    amount: event.args.amount,
    epoch: Number(event.args.epoch)
  }));
}

async function getEpochsToProcess(locker, filterEpochs) {
  const currentEpoch = Number(await locker.epoch());
  let epochsToProcess = [];

  if (filterEpochs && filterEpochs.length > 0) {
    epochsToProcess = filterEpochs.filter((epoch) => epoch <= currentEpoch);
  } else {
    for (let epoch = 1; epoch <= currentEpoch; epoch++) {
      epochsToProcess.push(epoch);
    }
  }

  return {
    currentEpoch,
    epochsToProcess
  };
}

async function getEpochWindow(locker, currentEpoch, epochsToProcess) {
  if (epochsToProcess.length === 0) {
    return null;
  }

  const firstEpoch = Math.min(...epochsToProcess);
  const lastEpoch = Math.max(...epochsToProcess);
  const startBlock = Number(await locker.epochStartBlock(firstEpoch));

  let endBlock = "latest";
  if (lastEpoch < currentEpoch) {
    const nextEpochStart = await locker.epochStartBlock(lastEpoch + 1);
    endBlock = Number(nextEpochStart) - 1;
  }

  return { startBlock, endBlock };
}

async function getOnChainEpochDelta(pushToken, locker, contractAddress, epoch, currentEpoch) {
  if (epoch === currentEpoch) {
    const currentBalance = toBigInt(await pushToken.balanceOf(contractAddress));
    const epochStart = Number(await locker.epochStartBlock(currentEpoch));
    const balanceBeforeEpoch = toBigInt(
      await pushToken.balanceOf(contractAddress, { blockTag: epochStart - 1 })
    );

    return currentBalance - balanceBeforeEpoch;
  }

  const epochStart = Number(await locker.epochStartBlock(epoch));
  const nextEpochStart = Number(await locker.epochStartBlock(epoch + 1));
  const endBalance = toBigInt(
    await pushToken.balanceOf(contractAddress, { blockTag: nextEpochStart - 1 })
  );
  const startBalance = toBigInt(
    await pushToken.balanceOf(contractAddress, { blockTag: epochStart - 1 })
  );

  return endBalance - startBalance;
}

async function validateSourceEpochTotals(source, sourceResult, pushToken, locker, currentEpoch, epochsToProcess) {
  console.log(`\n🔍 Validating ${source.NAME} against on-chain balances...`);

  for (const epoch of epochsToProcess) {
    const epochKey = epoch.toString();
    const lockedTotal = sourceResult.lockedTotalsByEpoch[epochKey] || 0n;
    const unlockedTotal = sourceResult.unlockedTotalsByEpoch[epochKey] || 0n;
    const offChainNet = lockedTotal - unlockedTotal;
    const onChainNet = await getOnChainEpochDelta(
      pushToken,
      locker,
      source.CONTRACT_ADDRESS,
      epoch,
      currentEpoch
    );

    if (offChainNet !== onChainNet) {
      console.error(`❌ Validation failed for ${source.NAME} epoch ${epoch}:`);
      console.error(`   Locked total: ${lockedTotal.toString()}`);
      console.error(`   Unlocked total: ${unlockedTotal.toString()}`);
      console.error(`   Off-chain net: ${offChainNet.toString()}`);
      console.error(`   On-chain net: ${onChainNet.toString()}`);
      throw new Error(`Funds mismatch for ${source.NAME} epoch ${epoch}`);
    }

    console.log(
      `✅ ${source.NAME} epoch ${epoch}: ${lockedTotal.toString()} locked, ${unlockedTotal.toString()} unlocked, ${offChainNet.toString()} net`
    );
  }
}

async function main() {
  const { ethers } = require("hardhat");

  const provider = ethers.provider;
  const pushToken = new ethers.Contract(PUSH_TOKEN_ADDRESS, PUSH_TOKEN_ABI, provider);
  const locker = new ethers.Contract(LOCKER_CONFIG.CONTRACT_ADDRESS, LOCKER_CONFIG.ABI, provider);
  const source = { NAME: "migration-locker", CONTRACT_ADDRESS: LOCKER_CONFIG.CONTRACT_ADDRESS };

  const { currentEpoch, epochsToProcess } = await getEpochsToProcess(locker, LOCKER_CONFIG.FILTER_EPOCHS);

  if (epochsToProcess.length === 0) {
    console.log(`⚠️  No epochs to process (current epoch: ${currentEpoch})`);
    return;
  }

  const epochWindow = await getEpochWindow(locker, currentEpoch, epochsToProcess);
  console.log(`\n📦 Processing locker: ${LOCKER_CONFIG.CONTRACT_ADDRESS}`);
  console.log(`   Current epoch: ${currentEpoch}`);
  console.log(`   Epochs: ${epochsToProcess.join(", ")}`);
  console.log(`   Blocks: ${epochWindow.startBlock} -> ${epochWindow.endBlock}`);

  const lockedEvents = await locker.queryFilter("Locked", epochWindow.startBlock, epochWindow.endBlock);
  const unlockedEvents = await locker.queryFilter("Unlocked", epochWindow.startBlock, epochWindow.endBlock);

  const filteredLockedEvents = normalizeLockedEvents(lockedEvents).filter((event) =>
    epochsToProcess.includes(event.epoch)
  );
  const filteredUnlockedEvents = normalizeUnlockedEvents(unlockedEvents).filter((event) =>
    epochsToProcess.includes(event.epoch)
  );

  const sourceResult = buildNetClaims(filteredLockedEvents, filteredUnlockedEvents);

  console.log(`   Locked events: ${filteredLockedEvents.length}`);
  console.log(`   Unlocked events: ${filteredUnlockedEvents.length}`);
  console.log(`   Net claims: ${sourceResult.claims.length}`);

  await validateSourceEpochTotals(source, sourceResult, pushToken, locker, currentEpoch, epochsToProcess);

  const outputPath = path.join(__dirname, OUTPUT_CONFIG.CLAIMS_PATH);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(sourceResult.claims, null, 2));

  console.log(`\n✅ Saved ${sourceResult.claims.length} net claims to ${outputPath}`);
}

module.exports = {
  buildNetClaims,
  main
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
