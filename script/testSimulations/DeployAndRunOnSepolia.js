const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

async function main() {
  const TOKEN_ADDRESS = "0x37c779a1564DCc0e3914aB130e0e787d93e21804"; // PUSH Token
  const refundsEnabled = process.env.REFUNDS_ENABLED === "true";
  const amountToMint = ethers.parseUnits("1000", 18); // amount each user gets
  const amountToLock = ethers.parseUnits("100", 18);  // amount each user locks
  const amountToLock2 = ethers.parseUnits("250", 18);  // amount each user locks
  const amountToLock3 = ethers.parseUnits("180", 18);  // amount each user locks
  const usersCount = 10;

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // Load PUSH Token contract with mint function
  const pushToken = await ethers.getContractAt("IPUSH", TOKEN_ADDRESS);

  // Deploy MigrationLocker
  const MigrationLocker = await ethers.getContractFactory("MigrationLocker");
  console.log("Deploying MigrationLocker with transparent proxy...");
  // const locker = MigrationLocker.attach("0x5f4A632526a907003879dAd557dBdcf624EBe992");
  const locker = await upgrades.deployProxy(
    MigrationLocker,
    [deployer.address, refundsEnabled],
    { kind: "transparent", initializer: "initialize" }
  );
  await locker.waitForDeployment();
  console.log("MigrationLocker deployed at:", await locker.getAddress());

  // Generate 10 wallets and fund them with ETH
  const users = [];
  for (let i = 0; i < usersCount; i++) {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    users.push(wallet);

    // Send Sepolia ETH
    const tx = await deployer.sendTransaction({
      to: wallet.address,
      value: ethers.parseEther("0.01"),
    });
    await tx.wait();
    console.log(`💰 Sent 0.01 ETH to ${wallet.address}`);
  }

  // Each user mints PUSH, approves, and locks tokens
  for (const user of users) {
    console.log(`🔑 User ${user.address} is minting and locking tokens`);
    const userPush = pushToken.connect(user);
    const userLocker = locker.connect(user);

    // Mint tokens by calling mint from the user wallet
    const mintTx = await userPush.mint(amountToMint);
    await mintTx.wait();
    console.log(`💰 User ${user.address} minted ${amountToMint} PUSH`);

    const approveTx = await userPush.approve(await locker.getAddress(), amountToLock + amountToLock2 + amountToLock3);
    await approveTx.wait();
    console.log(`💰 User ${user.address} approved ${amountToLock + amountToLock2 + amountToLock3} PUSH`);

    const lockTx = await userLocker.lock(amountToLock, user.address);
    await lockTx.wait();
    console.log(`💰 User ${user.address} locked ${amountToLock} PUSH`);

    const lockTx2 = await userLocker.lock(amountToLock2, user.address);
    await lockTx2.wait();
    console.log(`💰 User ${user.address} locked ${amountToLock2} PUSH`);

    const epochTx = await locker.connect(deployer).initiateNewEpoch();
    await epochTx.wait();
    console.log("✅ Moved to next epoch");

    const lockTx3 = await userLocker.lock(amountToLock3, user.address);
    await lockTx3.wait();
    console.log(`💰 User ${user.address} locked ${amountToLock3} PUSH`);
  }

  console.log("✅ All users minted and locked tokens. You can now run the fetch script.");
}

main().catch((err) => {
  console.error("Error in deploy script:", err);
  process.exit(1);
});
