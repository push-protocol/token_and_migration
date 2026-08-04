// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.8.29;

import "forge-std/Script.sol";
import "../../src/MigrationLocker.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

/**
 * @title DeployLocker
 * @dev Deployment script for MigrationLocker contract with transparent proxy pattern
 * This script handles:
 * 1. Deployment of the implementation contract
 * 2. Deployment of the ProxyAdmin for managing upgrades
 * 3. Deployment of the TransparentUpgradeableProxy pointing to the implementation
 * 4. Proper initialization of the contract
 */
contract DeployLockerScript is Script {
    function run() external {
        // Get private key from environment
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_OWNER");
        address deployerAddress = vm.addr(deployerPrivateKey);
        bool refundsEnabled = vm.envOr("REFUNDS_ENABLED", false);

        vm.startBroadcast(deployerPrivateKey);

        console.log("Deploying contracts with address:", deployerAddress);

        MigrationLocker implementation = new MigrationLocker();
        console.log("MigrationLocker implementation deployed at:", address(implementation));

        bytes memory initData = abi.encodeWithSelector(
            MigrationLocker.initialize.selector,
            deployerAddress, // Set deployer as initial owner
            refundsEnabled
        );

        TransparentUpgradeableProxy proxy =
            new TransparentUpgradeableProxy(address(implementation), deployerAddress, initData);

        address proxyAddress = address(proxy);
        console.log("MigrationLocker proxy deployed at:", proxyAddress);
        console.log("For verification, implementation address:", address(implementation));
        console.log("For interaction, use proxy address:", proxyAddress);

        vm.stopBroadcast();
    }
}
